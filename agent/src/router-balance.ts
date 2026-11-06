/** Read-only 0G Router account balance. This is a shared account, not an agent's allocation. */
import { getAddress } from "viem";

export interface RouterBalance {
  address: string;
  currency: "usd" | "0g";
  /** micro-USD or wei, respectively. Excludes the shared on-chain payment vault. */
  conservativeLedgerBalance: bigint;
  unsettledChargeReported: boolean;
  observedAtMs: number;
}

export async function readRouterBalance(options: { baseUrl: string; managementKey: string; expectedAddress: string; send?: typeof fetch }): Promise<RouterBalance> {
  if (!options.managementKey.startsWith("mk-")) throw new Error("A 0G Router management key with account:read is required");
  const expected = getAddress(options.expectedAddress);
  const base = new URL(options.baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("Invalid 0G Router endpoint");
  const response = await (options.send ?? fetch)(`${base.toString().replace(/\/$/, "")}/account/balance`, { headers: { authorization: `Bearer ${options.managementKey}` }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`0G Router balance request failed (HTTP ${response.status})`);
  const value: any = await response.json();
  if (getAddress(value.address) !== expected) throw new Error("0G Router management key belongs to a different account");
  if (value.currency !== "usd" && value.currency !== "0g") throw new Error("Unknown Router settlement currency");
  const parse = (v: unknown) => { if (typeof v !== "string" || !/^\d+$/.test(v)) throw new Error("Invalid Router balance response"); return BigInt(v); };
  const total = parse(value.total_balance), pending = parse(value.pending_charge), unsettled = value.unsettled_charge === undefined ? 0n : parse(value.unsettled_charge);
  const net = total - pending - unsettled;
  return { address: expected, currency: value.currency, conservativeLedgerBalance: net > 0n ? net : 0n, unsettledChargeReported: value.unsettled_charge !== undefined, observedAtMs: Date.now() };
}

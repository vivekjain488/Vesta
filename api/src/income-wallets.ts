/**
 * Agent income wallets on Privy (server wallets, app-controlled): fully automated, no user approval.
 *
 *   buyer pays (x402 / local settlement) -> agent's Privy income wallet
 *   sweeper (every minute): USDC in the income wallet -> approve + PerpetuaVault.recordIncome("data_sales")
 *   RiskGate.poke (each paid cycle): vault.harvest -> HarvestRouter -> 0G ComputeTreasury (the agent's compute)
 *
 * Transactions are signed by Privy (eth_signTransaction) and broadcast here, so the same code works on any EVM
 * chain, including the local Anvil chain. Gas: topped up automatically on local Anvil; on a public chain fund
 * the income wallets with a little ETH (or enable Privy gas sponsorship).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { erc20Abi, encodeFunctionData, getAddress, parseEther, stringToHex, type Address, type Hex } from "viem";
import { perpetuaVaultAbi } from "@perpetua/core";
import type { Platform } from "./platform";

const PRIVY = "https://api.privy.io/v1";
const MIN_SWEEP = 10_000n; // 0.01 USDC
const LOCAL_GAS_FLOOR = parseEther("0.01");

export interface IncomeWallet { agentId: string; walletId: string; address: Address; createdAt: number; swept: string; sweeps: { at: number; amount: string; approveTx: Hex; incomeTx: Hex }[]; sales: number; salesUsd: number; lastError?: string }
interface Store { version: 1; wallets: Record<string, IncomeWallet> }

function privyAuth() {
  const id = process.env.PRIVY_APP_ID, secret = process.env.PRIVY_APP_SECRET;
  if (!id || !secret) return null;
  return { id, headers: { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "privy-app-id": id, "content-type": "application/json" } };
}
export const privyConfigured = () => Boolean(privyAuth());

async function privy(path: string, body: unknown) {
  const auth = privyAuth();
  if (!auth) throw new Error("PRIVY_APP_ID / PRIVY_APP_SECRET are not set");
  const r = await fetch(`${PRIVY}${path}`, { method: "POST", headers: auth.headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(`Privy ${path.split("/").slice(0, 3).join("/")}: ${String(data.error ?? data.message ?? r.status).slice(0, 160)}`);
  return data;
}

const hex = (n: bigint) => `0x${n.toString(16)}`;

export class IncomeWallets {
  private readonly file: string;
  private store: Store;
  private sweeping = false;
  constructor(private readonly platform: Platform) {
    this.file = resolve(platform.state, "income-wallets.json");
    this.store = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : { version: 1, wallets: {} };
  }
  private save() { mkdirSync(dirname(this.file), { recursive: true }); const tmp = `${this.file}.tmp`; writeFileSync(tmp, JSON.stringify(this.store, null, 2), { mode: 0o600 }); renameSync(tmp, this.file); }

  get(agentId: string): IncomeWallet | null { return this.store.wallets[agentId] ?? null; }
  all() { return Object.values(this.store.wallets); }

  /** One app-controlled Privy server wallet per agent; created once and reused. */
  async ensure(agentId: string): Promise<IncomeWallet> {
    const existing = this.store.wallets[agentId];
    if (existing) return existing;
    const created = await privy("/wallets", { chain_type: "ethereum" });
    const wallet: IncomeWallet = { agentId, walletId: created.id, address: getAddress(created.address), createdAt: Date.now(), swept: "0", sweeps: [], sales: 0, salesUsd: 0 };
    this.store.wallets[agentId] = wallet;
    this.save();
    console.log(`[income] created Privy income wallet ${wallet.address} for agent ${agentId}`);
    return wallet;
  }

  /** Create wallets for every deployed platform agent that lacks one (startup migration). */
  async ensureAll() {
    if (!privyConfigured()) return;
    for (const a of this.platform.agents()) {
      if (this.store.wallets[a.id]) continue;
      try { await this.ensure(a.id); } catch (e) { console.warn(`[income] wallet for ${a.id}: ${(e as Error).message}`); }
    }
  }

  recordSale(agentId: string, usd: number) {
    const w = this.store.wallets[agentId];
    if (!w) return;
    w.sales++; w.salesUsd = Math.round((w.salesUsd + usd) * 1e6) / 1e6;
    this.save();
  }

  private async send(w: IncomeWallet, to: Address, data: Hex): Promise<Hex> {
    const pub = this.platform.pub;
    const chainId = await pub.getChainId();
    const [nonce, fees, gas] = await Promise.all([
      pub.getTransactionCount({ address: w.address, blockTag: "pending" }),
      pub.estimateFeesPerGas(),
      pub.estimateGas({ account: w.address, to, data }),
    ]);
    const signed = await privy(`/wallets/${w.walletId}/rpc`, {
      method: "eth_signTransaction",
      params: { transaction: { to, data, value: "0x0", chain_id: chainId, nonce, gas_limit: hex((gas * 12n) / 10n), max_fee_per_gas: hex(fees.maxFeePerGas!), max_priority_fee_per_gas: hex(fees.maxPriorityFeePerGas!), type: 2 } },
    });
    const hash = await pub.sendRawTransaction({ serializedTransaction: signed.data.signed_transaction as Hex });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
    return hash;
  }

  /** Move every income wallet's USDC into its agent's vault as recorded income. Idempotent; runs on a timer. */
  async sweep() {
    if (this.sweeping || !privyConfigured()) return [];
    this.sweeping = true;
    const done: { agentId: string; amount: bigint; incomeTx: Hex }[] = [];
    try {
      const pub = this.platform.pub;
      const dep = this.platform.deployment();
      const local = (await pub.getChainId()) === 31337;
      for (const w of this.all()) {
        let agent;
        try { agent = this.platform.agent(w.agentId); } catch { continue; }
        try {
          const balance = await pub.readContract({ address: dep.usdc, abi: erc20Abi, functionName: "balanceOf", args: [w.address] });
          if (balance < MIN_SWEEP) continue;
          const eth = await pub.getBalance({ address: w.address });
          if (eth < LOCAL_GAS_FLOOR) {
            if (!local) throw new Error(`income wallet ${w.address} needs ETH for gas on this chain`);
            await pub.request({ method: "anvil_setBalance" as any, params: [w.address, hex(parseEther("1"))] as any });
          }
          const approveTx = await this.send(w, dep.usdc, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [agent.vault, balance] }));
          const incomeTx = await this.send(w, agent.vault, encodeFunctionData({ abi: perpetuaVaultAbi, functionName: "recordIncome", args: [stringToHex("data_sales", { size: 32 }), balance] }));
          w.swept = (BigInt(w.swept) + balance).toString();
          w.sweeps = [...w.sweeps, { at: Date.now(), amount: balance.toString(), approveTx, incomeTx }].slice(-50);
          w.lastError = undefined;
          done.push({ agentId: w.agentId, amount: balance, incomeTx });
          console.log(`[income] swept ${Number(balance) / 1e6} USDC from ${w.address} into vault ${agent.vault} (${incomeTx})`);
        } catch (e) {
          w.lastError = (e as Error).message.slice(0, 200);
        }
      }
      this.save();
    } finally { this.sweeping = false; }
    return done;
  }

  start(intervalMs = Number(process.env.INCOME_SWEEP_INTERVAL_MS ?? 60_000)) {
    const timer = setInterval(() => void this.sweep().catch((e) => console.error("[income] sweep failed", (e as Error).message)), intervalMs);
    timer.unref();
    return timer;
  }
}

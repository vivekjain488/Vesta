import { and, desc, eq } from "@arkiv-network/sdk/query";
import { addr, bytes, defineSchema, str, u64 } from "@arkiv-network/sdk/schema";
import { arkivPublic, arkivWallet } from "./client";
import { ExpirationTime } from "@arkiv-network/sdk";
import { jsonBytes } from "./schemas";
import { hexToBytes, type Address, type Hex } from "viem";

/** Append-only application events. Wallet ownership identifies the publisher, owner_wallet identifies the user. */
export const RuntimeEvent = defineSchema("perpetua.runtime-event.v1", {
  uid: str().indexed(), owner_wallet: addr().indexed(), agent_id: str().indexed(), portfolio_id: str().indexed(),
  run_id: str().indexed(), revision: u64().indexed(), sequence: u64().indexed(), kind: str().indexed(),
  at_ms: u64().indexed(), payload: bytes(),
});
export interface PublicRuntimeEvent {
  id: string; owner: string; agentId: string; portfolioId: string; runId: string; revision: number;
  sequence: number; kind: string; atMs: number; payload: unknown;
}
const value = (v: any) => v?.value ?? v;
export async function runtimeHistory(owner: string, agentId: string, writer: Address, limit = 50): Promise<{ entityKey: string; event: PublicRuntimeEvent }[]> {
  const result = await (arkivPublic() as any).select().from(RuntimeEvent)
    .where(and(eq("owner_wallet", owner.toLowerCase()), eq("agent_id", agentId)))
    .ownedBy(writer).orderBy(desc("at_ms")).limit(Math.max(1, Math.min(limit, 100))).fetch();
  return result.entities.map((row: any) => { const raw = value(row.payload); return { entityKey: row.$key, event: JSON.parse(Buffer.from(typeof raw === "string" && raw.startsWith("0x") ? hexToBytes(raw as Hex) : raw).toString("utf8")) as PublicRuntimeEvent }; });
}
export class RuntimeArkivPort {
  readonly owner: Address;
  private readonly client: ReturnType<typeof arkivWallet>["client"];
  constructor(privateKey: Hex, private readonly retentionDays = 180) {
    const { client, account } = arkivWallet(privateKey); this.client = client; this.owner = account.address;
  }
  async find(id: string): Promise<string | undefined> {
    const result = await (arkivPublic() as any).select({ $key: true }).from(RuntimeEvent).where(eq("uid", id)).ownedBy(this.owner).limit(2).fetch();
    if (result.entities.length > 1) throw new Error("Duplicate runtime event; refusing ambiguous publication");
    return result.entities[0]?.$key;
  }
  async send(event: PublicRuntimeEvent): Promise<string> {
    const payload = jsonBytes(event); if (payload.length > 100000) throw new Error("Runtime audit event exceeds publication size limit");
    const result = await this.client.createEntity(RuntimeEvent, {
      uid: event.id, owner_wallet: addr(event.owner as Address), agent_id: event.agentId, portfolio_id: event.portfolioId,
      run_id: event.runId, revision: u64(event.revision), sequence: u64(event.sequence), kind: event.kind, at_ms: u64(event.atMs), payload,
    }, { expiration: ExpirationTime.fromDays(this.retentionDays), flags: { readonly: true } });
    return result.txHash;
  }
  async sendBatch(events: PublicRuntimeEvent[]): Promise<string> {
    const creates = events.map((event) => ({ schema: RuntimeEvent, values: {
      uid: event.id, owner_wallet: addr(event.owner as Address), agent_id: event.agentId, portfolio_id: event.portfolioId,
      run_id: event.runId, revision: u64(event.revision), sequence: u64(event.sequence), kind: event.kind, at_ms: u64(event.atMs), payload: jsonBytes(event),
    }, expiration: ExpirationTime.fromDays(this.retentionDays), flags: { readonly: true } }));
    const result = await this.client.executeBatch({ creates }); return result.txHash;
  }
  async confirm(hash: string): Promise<void> {
    const receipt = await (arkivPublic() as any).waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("Arkiv runtime publication reverted");
  }
}

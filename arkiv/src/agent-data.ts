import { and, desc, eq } from "@arkiv-network/sdk/query";
import type { Address } from "viem";
import { arkivPublic } from "./client";
import { DecisionLog, SignalEntity, TradeEntity } from "./schemas";

export const AGENT_DATA_KINDS = { decisions: DecisionLog, signals: SignalEntity, trades: TradeEntity } as const;
export type AgentDataKind = keyof typeof AGENT_DATA_KINDS;

/** One agent's latest records of a kind, written by `writer` (Arkiv caps a page at 100). */
export async function agentRecords(kind: AgentDataKind, agentId: string, writer: Address, limit = 50): Promise<any[]> {
  const result = await (arkivPublic() as any).select().from(AGENT_DATA_KINDS[kind]).where(and(eq("agent_id", agentId))).createdBy(writer).orderBy(desc("created_at")).limit(Math.max(1, Math.min(100, limit))).fetch();
  return result.entities;
}

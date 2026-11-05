/**
 * Recompute the leaderboard from scratch from Arkiv rows (never a cached badge) and write one
 * LeaderboardSnapshot row per agent per cycle, so rank history is itself a queryable time series.
 * Run by the keeper after each poke() cycle:  tsx src/leaderboard-snapshot.ts
 */
import "dotenv/config";
import { rankAgents, type AgentHistory, type RiskTier } from "@perpetua/core";
import type { Address } from "viem";
import { eq } from "@arkiv-network/sdk/query";
import { arkivPublic } from "./client";
import { AgentEntity, DecisionLog, LeaderboardSnapshot, LedgerEntity, SignalEntity, EXPIRY_DAYS, addr, bool, dec, i32, jsonBytes, u64 } from "./schemas";
import { ArkivWriter } from "./writer";

const DAY = 86400;

export async function buildHistories(): Promise<AgentHistory[]> {
  const pub = arkivPublic() as any;
  const agents = (await pub.select().from(AgentEntity).limit(100).fetch()).entities;
  const out: AgentHistory[] = [];
  for (const a of agents) {
    const agent = a.agent.value as Address;
    const ledger = (await pub.select({ engine: true, hour: true, amount_usd: true }).from(LedgerEntity).where(eq("agent", agent)).ownedBy(agent).limit(100).fetch()).entities;
    const signals = (await pub.select({ confidence: true, outcome: true, status: true }).from(SignalEntity).where(eq("agent", agent)).ownedBy(agent).limit(100).fetch()).entities;
    const decisions = (await pub.select({ tee_verified: true }).from(DecisionLog).where(eq("agent", agent)).ownedBy(agent).limit(100).fetch()).entities;
    const equity = Number(a.floor.value) + Number(a.cushion.value) || 1;
    const byDay = new Map<number, number>();
    let lastTrade = 0;
    for (const r of ledger) {
      if (r.engine.value === "deposit") continue;
      const day = Math.floor((Number(r.hour.value) * 3600) / DAY) * DAY;
      byDay.set(day, (byDay.get(day) ?? 0) + Number(r.amount_usd.value));
      if (r.engine.value === "trading") lastTrade = Math.max(lastTrade, Number(r.hour.value) * 3600);
    }
    out.push({
      agent,
      tier: (a.risk_tier.value as RiskTier) ?? "balanced",
      returns: [...byDay.entries()].sort(([x], [y]) => x - y).map(([t, usd]) => ({ t, r: usd / equity })),
      outcomes: signals
        .filter((s: any) => s.status.value === "closed" && s.outcome?.value)
        .map((s: any) => ({ p: Number(s.confidence.value), o: s.outcome.value === "win" ? 1 : 0 })),
      decisions: decisions.length,
      verifiedDecisions: decisions.filter((d: any) => d.tee_verified.value).length,
      firstSeen: Number(a.created_at.value),
      lastSettledTrade: lastTrade || Number(a.last_heartbeat.value),
    });
  }
  return out;
}

export async function writeSnapshot(cycle: number) {
  const now = Math.floor(Date.now() / 1000);
  const ranked = rankAgents(await buildHistories(), now);
  const writer = new ArkivWriter("leaderboard");
  ranked.crossTier.forEach((s, i) => {
    writer.enqueue({
      uid: `${s.agent}:${cycle}`,
      schema: LeaderboardSnapshot,
      expiresInDays: EXPIRY_DAYS.leaderboard,
      values: {
        agent: addr(s.agent as Address),
        cycle: u64(cycle),
        risk_tier: s.tier,
        rank: i32(i + 1),
        score: dec(s.score.toFixed(8)),
        sortino: dec(s.sortino.toFixed(6)),
        accuracy: dec(s.accuracy.toFixed(6)),
        risk_penalty: dec(s.riskPenalty.toFixed(6)),
        transparency: dec(s.transparency.toFixed(6)),
        track_days: dec(s.trackDays.toFixed(2)),
        unverified: bool(s.unverified),
        created_at: u64(now),
        payload: jsonBytes(s),
      },
    });
  });
  await writer.flush();
  return ranked;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cycle = Number(process.argv[2] ?? Math.floor(Date.now() / 1000 / (4 * 3600)));
  writeSnapshot(cycle)
    .then((r) => console.table(r.crossTier.map((s) => ({ agent: s.agent, tier: s.tier, score: s.score.toFixed(4), unverified: s.unverified }))))
    .catch((e) => (console.error(e), process.exit(1)));
}

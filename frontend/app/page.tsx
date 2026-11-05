"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { rankAgents, type AgentHistory, type RiskTier } from "@perpetua/core";
import { CppiGauge } from "@/components/CppiGauge";
import { Feed } from "@/components/Feed";
import { RunwayBar } from "@/components/RunwayBar";
import { runwayDays, useAgents, type AgentView } from "@/components/useAgents";
import { fmt } from "@/lib/data";

export default function Arena() {
  const { agents, online } = useAgents();
  return (
    <>
      <section className="pt-14 pb-10 sm:pt-20">
        <p className="num text-[11px] uppercase tracking-[0.25em] text-dim">ETHGlobal Mumbai · Definitive Flash · 0G · Arkiv · Chainlink CCIP</p>
        <h1 className="mt-4 max-w-3xl font-display text-5xl leading-[1.02] sm:text-6xl">
          Agents that earn their next thought. <span className="text-cushion">Income funds compute,</span> with trading risk bounded on-chain.
        </h1>
        <p className="mt-5 max-w-2xl text-paper/75">
          Each agent manages an on-chain principal-protected note (Endowment-CPPI). It may only risk the cushion above its floor. An on-chain RiskGate approves every order, and the agent buys its own 0G inference from income it earns.
        </p>
        {online === false && (
          <p className="mt-6 rounded-sm border border-exposure/40 bg-exposure/10 px-3 py-2 text-sm text-exposure">
            API offline. Start it with <code className="num">pnpm api</code> (and <code className="num">anvil</code> + <code className="num">pnpm deploy:local</code> for the local chain).
          </p>
        )}
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {agents.map((a) => (
          <AgentCard key={a.name} a={a} />
        ))}
      </section>

      <section className="mt-14 grid gap-10 lg:grid-cols-[1.4fr_1fr]">
        <Leaderboard agents={agents} />
        <div>
          <h2 className="font-display text-3xl">Live feed</h2>
          <p className="mb-3 text-sm text-dim">Trades, hunger alerts and tier changes, each linked to its tx hash and 0G request ID.</p>
          <Feed />
        </div>
      </section>
    </>
  );
}

function AgentCard({ a }: { a: AgentView }) {
  const c = a.chain;
  const tier = a.runtime?.tier ?? "thrive";
  const pnl = c ? c.V - c.principal : 0;
  return (
    <Link href={`/agent/${a.name}`} className="group block rounded-sm border border-line bg-panel/80 p-5 transition-colors hover:border-dim">
      <div className="flex items-baseline justify-between">
        <h3 className="font-display text-3xl">{a.name}</h3>
        <span className="num text-[11px] uppercase tracking-wider text-dim">{a.riskTier}</span>
      </div>
      <p className="mt-1 min-h-10 text-sm text-paper/70">{a.strategy}</p>
      <div className="mt-5">
        <RunwayBar name={a.name} days={runwayDays(a)} tier={tier} />
      </div>
      <div className="mt-5">{c ? <CppiGauge V={c.V} F={c.F} C={c.C} E={c.E} compact /> : <p className="text-sm text-dim">Waiting for chain…</p>}</div>
      <div className="mt-4 flex items-center justify-between border-t border-line pt-3 text-xs">
        <span className="text-dim">
          NAV vs principal <span className={`num ${pnl >= 0 ? "text-alive" : "text-exposure"}`}>{pnl >= 0 ? "+" : ""}${fmt(pnl)}</span>
        </span>
        <span className="text-dim group-hover:text-paper">Profile →</span>
      </div>
      {c?.hibernating && <p className="mt-2 text-xs text-dim">RiskGate: hibernating (stale price on a held asset)</p>}
      {c?.tradingOff && <p className="mt-2 text-xs text-exposure">Drawdown breaker: services only</p>}
    </Link>
  );
}

const TIERS: (RiskTier | "all")[] = ["all", "conservative", "balanced", "aggressive"];

function Leaderboard({ agents }: { agents: AgentView[] }) {
  const [tab, setTab] = useState<(typeof TIERS)[number]>("all");
  const rows = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    const histories: AgentHistory[] = agents.map((a) => {
      const closed = (a.runtime?.trades ?? []).filter((t: any) => t.status === "closed");
      const byDay = new Map<number, number>();
      for (const t of closed) {
        const d = Math.floor(t.openedAt / 86400) * 86400;
        byDay.set(d, (byDay.get(d) ?? 0) + (Number(t.pnlUsd ?? 0) || 0) / Math.max(1, a.chain?.V ?? 1000));
      }
      if (a.chain && byDay.size === 0) byDay.set(Math.floor(now / 86400) * 86400, (a.chain.V - a.chain.principal) / Math.max(1, a.chain.principal));
      const revealed = (a.runtime?.signals ?? []).filter((s: any) => s.signal);
      return {
        agent: a.name,
        tier: a.riskTier as RiskTier,
        returns: [...byDay.entries()].map(([t, r]) => ({ t, r })),
        outcomes: revealed.filter((s: any) => s.outcome).map((s: any) => ({ p: s.signal.confidence, o: s.outcome === "win" ? 1 : 0 })),
        decisions: Math.max(1, a.runtime?.liveTrades ?? 0),
        verifiedDecisions: a.runtime?.liveTrades ?? 0,
        firstSeen: a.runtime?.createdAt ?? now,
        lastSettledTrade: now,
      };
    });
    const ranked = rankAgents(histories, now);
    return tab === "all" ? ranked.crossTier : ranked.byTier[tab];
  }, [agents, tab]);

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-display text-3xl">Leaderboard</h2>
        <div className="flex gap-1 text-xs" role="tablist">
          {TIERS.map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`rounded-sm px-2.5 py-1 capitalize ${tab === t ? "bg-paper text-ink" : "text-dim hover:text-paper"}`}>
              {t}
            </button>
          ))}
        </div>
      </div>
      <p className="mb-3 mt-1 text-sm text-dim">
        Score = Sortino<sup>α</sup> · Accuracy<sup>β</sup> · RiskPenalty<sup>γ</sup> · Transparency<sup>δ</sup> · √(min(days,180)/90). It is recomputed every cycle, and each snapshot is written to Arkiv.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead className="text-left text-[11px] uppercase tracking-wider text-dim">
            <tr className="border-b border-line">
              <th className="py-2 font-normal">#</th>
              <th className="font-normal">Agent</th>
              <th className="font-normal">Tier</th>
              <th className="text-right font-normal">Score</th>
              <th className="text-right font-normal">Days alive</th>
              <th className="text-right font-normal">Floor breaches</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const a = agents.find((x) => x.name === r.agent);
              const breach = a?.chain && a.chain.V < a.chain.F ? 1 : 0;
              return (
                <tr key={r.agent} className="border-b border-line/60">
                  <td className="num py-2.5 text-dim">{i + 1}</td>
                  <td>
                    <Link href={`/agent/${r.agent}`} className="hover:underline">
                      {r.agent}
                    </Link>
                    {r.unverified && <span className="ml-2 rounded-sm border border-line px-1.5 py-0.5 text-[10px] uppercase text-dim">unverified</span>}
                  </td>
                  <td className="capitalize text-dim">{r.tier}</td>
                  <td className="num text-right">{r.score.toFixed(4)}</td>
                  <td className="num text-right">{r.trackDays.toFixed(1)}</td>
                  <td className={`num text-right ${breach ? "text-exposure" : "text-alive"}`}>{breach}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

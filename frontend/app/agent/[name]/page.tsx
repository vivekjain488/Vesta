"use client";
import { use } from "react";
import Link from "next/link";
import { CopyPanel } from "@/components/CopyPanel";
import { CppiGauge } from "@/components/CppiGauge";
import { Feed } from "@/components/Feed";
import { RunwayBar } from "@/components/RunwayBar";
import { runwayDays, useAgents } from "@/components/useAgents";
import { fmt } from "@/lib/data";

export default function AgentPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  const { agents } = useAgents(5000);
  const a = agents.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!a) return <p className="pt-16 text-dim">Unknown agent. <Link href="/" className="underline">Back to the Arena</Link></p>;
  const c = a.chain;
  const trades = (a.runtime?.trades ?? []) as any[];
  const signals = (a.runtime?.signals ?? []) as any[];

  return (
    <div className="pt-12">
      <Link href="/" className="text-sm text-dim hover:text-paper">← Arena</Link>
      <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-6xl">{a.name}</h1>
          <p className="mt-2 max-w-xl text-paper/75">{a.strategy}</p>
        </div>
        <span className="num rounded-sm border border-line px-2 py-1 text-xs uppercase tracking-wider text-dim">risk tier · {a.riskTier} · locked on-chain</span>
      </div>

      <div className="mt-10 grid gap-8 lg:grid-cols-[1.5fr_1fr]">
        <div className="space-y-8">
          <section className="rounded-sm border border-line bg-panel/80 p-5">
            <h2 className="text-sm uppercase tracking-wider text-dim">Capital protection (read from RiskGate)</h2>
            <div className="mt-4">{c ? <CppiGauge V={c.V} F={c.F} C={c.C} E={c.E} /> : <p className="text-dim">Waiting for chain…</p>}</div>
            {c && (
              <p className="mt-4 text-sm text-paper/70">
                F = π·P + R = {(c.piBps / 100).toFixed(0)}% × ${fmt(c.principal)} + ${fmt(c.reserve)}. Only the ${fmt(c.C)} cushion can be traded, and the trading wallet never holds more than E = ${fmt(c.E)}.
                Mandate epoch <span className="num">{c.epoch}</span>, valid until <span className="num">{new Date(c.validUntil * 1000).toLocaleTimeString()}</span>.
              </p>
            )}
          </section>

          <section className="rounded-sm border border-line bg-panel/80 p-5">
            <h2 className="text-sm uppercase tracking-wider text-dim">Metabolism</h2>
            <div className="mt-4">
              <RunwayBar name={a.name} days={runwayDays(a)} tier={a.runtime?.tier ?? "thrive"} />
            </div>
            <dl className="mt-5 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
              <Kv k="0G ledger" v={`${fmt(a.runtime?.lastLedgerOg ?? 0, 3)} 0G`} />
              <Kv k="Burn / hour" v={`${fmt(a.runtime?.burnOgPerHour ?? 0, 4)} 0G`} />
              <Kv k="Harvested to 0G" v={`$${fmt(c?.harvested ?? 0)}`} />
              <Kv k="Harvestable now" v={`$${fmt(c?.harvestable ?? 0)}`} />
            </dl>
          </section>

          <section>
            <h2 className="font-display text-3xl">Track record</h2>
            <p className="mb-3 text-sm text-dim">Every trade, losses included. Signals are commit-reveal on Arkiv, so a confidence score can&apos;t be revised after the fact.</p>
            {trades.length === 0 ? (
              <p className="text-sm text-dim">No trades yet. The agent only trades when several independent signals agree.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead className="text-left text-[11px] uppercase tracking-wider text-dim">
                    <tr className="border-b border-line">
                      <th className="py-2 font-normal">Opened</th>
                      <th className="font-normal">Asset</th>
                      <th className="text-right font-normal">Size</th>
                      <th className="text-right font-normal">Entry</th>
                      <th className="text-right font-normal">Stop / Target</th>
                      <th className="font-normal">Status</th>
                      <th className="font-normal">Proof</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map((t) => (
                      <tr key={t.uid} className="border-b border-line/60">
                        <td className="num py-2.5 text-dim">{new Date(t.openedAt * 1000).toLocaleString()}</td>
                        <td>{t.asset}</td>
                        <td className="num text-right">${fmt(t.sizeUsd)}</td>
                        <td className="num text-right">{t.embargoed ? "embargo" : `$${fmt(t.entry, 3)}`}</td>
                        <td className="num text-right">{t.embargoed ? "15 min delay" : `$${fmt(t.stop, 3)} / $${fmt(t.target, 3)}`}</td>
                        <td className={t.status === "open" ? "text-cushion" : "text-dim"}>{t.status}</td>
                        <td className="num text-[11px] text-dim" title={`RiskGate approval ${t.approvalTx}\nFlash order ${t.flashOrderId}`}>
                          {String(t.approvalTx).slice(0, 10)}…
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <h2 className="font-display text-3xl">Signals</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {signals.length === 0 && <li className="text-dim">None yet.</li>}
              {signals.map((s) => (
                <li key={s.uid} className="rounded-sm border border-line px-3 py-2">
                  <div className="flex justify-between">
                    <span>{s.asset}</span>
                    <span className="num text-[11px] text-dim">commit {String(s.commitHash).slice(0, 14)}…</span>
                  </div>
                  {s.signal ? (
                    <p className="mt-1 text-paper/75">
                      {s.signal.direction} · confidence <span className="num">{s.signal.confidence.toFixed(2)}</span> · {s.signal.regime} · 0G chat <span className="num">{s.chatId}</span>
                    </p>
                  ) : (
                    <p className="mt-1 text-dim">Committed. Paying agents already have it; it&apos;s revealed here at {new Date(s.revealAt * 1000).toLocaleTimeString()}.</p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </div>

        <aside className="space-y-8">
          <CopyPanel agent={a.name} hasOpenTrade={trades.some((t) => t.status === "open")} />
          <section>
            <h2 className="font-display text-3xl">Posts</h2>
            <Feed agent={a.name} />
          </section>
        </aside>
      </div>
    </div>
  );
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs text-dim">{k}</dt>
      <dd className="num mt-0.5">{v}</dd>
    </div>
  );
}

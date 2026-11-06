"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { replayLimits, type ArkivRow, type PaperLimit } from "@/lib/arkiv-limit-replay";

type Decision = { id: string; status: string; decision?: { decision: string; rationaleSummary: string }; latencyMs?: number };
type PaperAgent = { name: string; decisions?: Decision[]; fills?: { runId: string; side: string; usd?: number; price: number; fee: number; at?: string }[] };
type Paper = { rows?: PaperAgent[]; source?: string; warning?: string; historicalStart?: string; historicalEnd?: string };
type Report = { orders: PaperLimit[]; snapshots: number; writer: string; historicalStart: number; historicalEnd: number; paper?: Paper; agent?: PaperAgent };
const money = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const when = (at: number) => new Date(at).toLocaleString();


function Evidence({ source, next, previous, current }: { source: string; next: string; previous: number; current: number }) {
  const [copied, setCopied] = useState("");
  const short = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`;
  async function copy(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); setCopied(label); }
    catch { setCopied("Copy unavailable"); }
  }
  return <div className="min-w-48 rounded-xl border border-trade/15 bg-trade-soft/50 px-3 py-2.5 text-xs">
    <div className="mb-2 flex items-center gap-1.5 font-medium text-trade-deep"><span className="size-1.5 rounded-full bg-trade" /> Arkiv snapshots</div>
    {[["Decision", source], ["Next", next]].map(([label, value]) => <div key={label} className="flex items-center justify-between gap-3 py-0.5"><span className="text-muted-foreground">{label}</span><button type="button" title={`Copy ${label.toLowerCase()} entity key: ${value}`} aria-label={`Copy ${label.toLowerCase()} entity key`} className="font-mono text-foreground underline decoration-foreground/25 underline-offset-2 hover:text-trade-deep" onClick={() => void copy(value, label)}>{short(value)}</button></div>)}
    <div className="mt-2 border-t border-trade/10 pt-2 text-muted-foreground">Midpoint <span className="font-medium text-foreground">${money(previous)} → ${money(current)}</span></div>
    <span role="status" className="sr-only">{copied ? `${copied} ${copied === "Copy unavailable" ? "" : "key copied"}` : ""}</span>
  </div>;
}

export function AgentTradeHistory({ agents, paper }: { agents: string[]; paper: Paper | null }) {
  const [selected, setSelected] = useState(""); const [report, setReport] = useState<Report | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const opened = useRef<string | null>(null);
  useEffect(() => { const requested = new URLSearchParams(window.location.search).get("agent"); if (requested && agents.includes(requested) && paper && opened.current !== requested) { opened.current = requested; setSelected(requested); void review(requested); } }, [agents, paper]);
  async function review(agentName = selected) {
    setBusy(true); setError(""); setReport(null);
    try {
      const response = await apiFetch("/v1/market/BTCUSDT/history?limit=100"); const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Arkiv market history is unavailable");
      if (!Array.isArray(data.rows)) throw new Error("Arkiv returned invalid market history");
      const snapshots = data.rows as ArkivRow[];
      const orders = replayLimits(snapshots);
      const times = snapshots.map(r => r.publishedAtMs).filter(n => Number.isFinite(n));
      setReport({ orders, snapshots: snapshots.length, writer: data.writer, historicalStart: Math.min(...times), historicalEnd: Math.max(...times), paper: paper ?? undefined, agent: paper?.rows?.find(row => row.name === agentName) });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <section className="rounded-[28px] border bg-card p-6 space-y-4">
    <div><h2 className="font-display text-3xl">Review trade history</h2><p className="mt-2 text-sm text-muted-foreground">Choose an agent to review recorded model decisions and a virtual limit-order replay based on Arkiv market data.</p></div>
    <div className="flex flex-wrap items-end gap-3"><label className="text-sm flex-1 min-w-48">Agent<select className="mt-1 h-10 w-full rounded-md border bg-background px-3" value={selected} onChange={e => { setSelected(e.target.value); setReport(null); setError(""); }}><option value="">Choose an agent</option>{agents.map(name => <option key={name} value={name}>{name}</option>)}</select></label><Button variant="trade" onClick={() => void review()} disabled={!selected || busy}>{busy ? "Reading Arkiv…" : "Review trade history"}</Button></div>
    {error && <p role="alert" className="rounded-xl bg-trade-soft p-3 text-sm">Could not load Arkiv history: {error}</p>}
    {report && <div className="space-y-5">
      <p className="text-sm text-muted-foreground">Historical replay using virtual funds and Arkiv BTC/USDT futures data; these are not agent trades or Flash orders.</p>
      <p className="text-sm text-muted-foreground">{report.snapshots} Arkiv snapshots{Number.isFinite(report.historicalStart) ? ` · ${when(report.historicalStart)} – ${when(report.historicalEnd)}` : ""}. Writer: <span className="font-mono break-all">{report.writer}</span>. Each $1,000–$5,000 virtual limit uses the current bid or ask; a virtual fill occurs only when the next published snapshot crosses the limit. Unfilled orders expire at that next snapshot. A 0.1% fee and an initial virtual $50,000 USDT / $50,000 BTC balance are assumed; liquidity, gas and slippage are not modeled.</p>
      <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm"><thead><tr className="border-b text-muted-foreground"><th className="py-2">Decision time</th><th>Side</th><th>Size</th><th>Limit</th><th>Outcome</th><th>Next observation</th><th>Arkiv evidence</th></tr></thead><tbody>{report.orders.slice(0, 50).map(o => <tr className="border-b" key={o.id}><td className="py-3">{when(o.at)}</td><td className="uppercase">{o.side}</td><td>${money(o.notional)}</td><td>${money(o.limit)}</td><td>{o.status === "paper fill" ? "Fill" : o.status}{o.fillPrice !== undefined ? ` · $${money(o.fillPrice)}` : ""}</td><td>{when(o.resultAt)}</td><td className="py-3 pl-3"><Evidence source={o.sourceKey} next={o.resultKey} previous={o.previousMid} current={o.observedMid} /></td></tr>)}</tbody></table></div>
      {!report.orders.length && <p className="text-sm text-muted-foreground">There are not enough distinct valid Arkiv observations to produce an example order.</p>}
      <div><h3 className="font-display text-2xl">Recorded model decisions</h3><p className="mt-1 text-sm text-muted-foreground">These are the saved decisions from the earlier Arkiv-backed model diagnostic, separate from the replay above. No new inference was run.</p>{report.paper?.warning && <p className="mt-2 text-xs text-muted-foreground">{report.paper.warning.replace(/paper/gi, "virtual")}</p>}{report.agent?.decisions?.length ? <ul className="mt-3 space-y-2">{report.agent.decisions.map(d => { const fill = report.agent?.fills?.find(f => f.runId === d.id); return <li key={d.id} className="rounded-xl bg-muted p-3 text-sm"><strong className="uppercase">{d.decision?.decision ?? d.status}</strong> · {d.decision?.rationaleSummary ?? "No explanation recorded"}{fill && <span> · Historical virtual fill {fill.side} ${money(fill.usd ?? 0)} at ${money(fill.price)}</span>}</li>; })}</ul> : <p className="mt-3 text-sm text-muted-foreground">No saved model decisions are available for this agent.</p>}</div>
      <p className="text-xs text-muted-foreground">Inspect source data using the entity keys above in the <a href="https://rabdi.explorer.arkiv.network/entity-explorer" target="_blank" rel="noreferrer" className="underline">Arkiv explorer</a>.</p>
    </div>}
  </section>;
}

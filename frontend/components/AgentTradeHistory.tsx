"use client";
import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Info, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorNote, Micro } from "@/components/ui-perpetua";
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
  return <div className="max-w-sm rounded-2xl bg-card px-4 py-3 text-xs shadow-[0_0_0_1px_rgba(17,17,17,0.05)]">
    <div className="mb-2 flex items-center gap-1.5 font-medium"><span className="size-1.5 rounded-full bg-trade" /> Arkiv snapshots</div>
    {[["Decision", source], ["Next", next]].map(([label, value]) => <div key={label} className="flex items-center justify-between gap-3 py-0.5"><span className="text-muted-foreground">{label}</span><button type="button" title={`Copy ${label.toLowerCase()} entity key: ${value}`} aria-label={`Copy ${label.toLowerCase()} entity key`} className="font-mono text-foreground underline decoration-foreground/25 underline-offset-2 hover:text-brand-hover" onClick={() => void copy(value, label)}>{short(value)}</button></div>)}
    <div className="mt-2 border-t border-border/70 pt-2 text-muted-foreground">Midpoint <span className="font-medium text-foreground">${money(previous)} → ${money(current)}</span></div>
    <span role="status" className="sr-only">{copied ? `${copied} ${copied === "Copy unavailable" ? "" : "key copied"}` : ""}</span>
  </div>;
}

const PAGE = 15;

function SummaryTile({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-2xl bg-muted px-4 py-3">
      <Micro>{label}</Micro>
      <p className="num mt-1 text-xl leading-tight font-semibold">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function AgentTradeHistory({ agents, paper }: { agents: string[]; paper: Paper | null }) {
  const [selected, setSelected] = useState(""); const [report, setReport] = useState<Report | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [shown, setShown] = useState(PAGE); const [open, setOpen] = useState<string | null>(null);
  const opened = useRef<string | null>(null);
  useEffect(() => { const requested = new URLSearchParams(window.location.search).get("agent"); if (requested && agents.includes(requested) && paper && opened.current !== requested) { opened.current = requested; setSelected(requested); void review(requested); } }, [agents, paper]);
  async function review(agentName = selected) {
    setBusy(true); setError(""); setReport(null); setShown(PAGE); setOpen(null);
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
  const fills = report ? report.orders.filter(o => o.status === "paper fill").length : 0;
  const expired = report ? report.orders.length - fills : 0;
  const visible = report ? report.orders.slice(0, 50) : [];
  return <Card className="gap-0 py-0" aria-labelledby="history-title">
    <div className="flex flex-wrap items-end justify-between gap-4 px-6 pt-6">
      <div className="max-w-xl space-y-2">
        <Badge variant="muted" size="micro">Virtual replay · Arkiv data</Badge>
        <h2 id="history-title" className="font-display text-3xl leading-tight tracking-tight">Review trade history</h2>
        <p className="text-sm text-muted-foreground">Choose an agent to review recorded model decisions and a virtual limit-order replay based on Arkiv market data.</p>
      </div>
      <div className="flex w-full flex-wrap items-end gap-2 sm:w-auto">
        <div className="min-w-0 flex-1 space-y-1.5 sm:w-56 sm:flex-none">
          <Label htmlFor="history-agent">Agent</Label>
          <NativeSelect id="history-agent" value={selected} onChange={e => { setSelected(e.target.value); setReport(null); setError(""); }}>
            <option value="">Choose an agent</option>{agents.map(name => <option key={name} value={name}>{name}</option>)}
          </NativeSelect>
        </div>
        <Button variant="trade" size="lg" onClick={() => void review()} disabled={!selected || busy}>{busy ? "Reading Arkiv…" : "Review trade history"}</Button>
      </div>
    </div>
    {error && <div className="px-6 pt-4"><ErrorNote>Could not load Arkiv history: {error}</ErrorNote></div>}
    {!report && !error && <p className="px-6 pt-4 pb-6 text-sm text-muted-foreground">{busy ? "Reading the latest Arkiv snapshots…" : "Select an agent, then review to load the replay."}</p>}
    {report && <div className="space-y-5 px-6 pt-5 pb-6">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <SummaryTile label="Snapshots" value={report.snapshots} hint="Arkiv BTC/USDT futures" />
        <SummaryTile label="Virtual fills" value={fills} hint={`${report.orders.length ? Math.round(fills / report.orders.length * 100) : 0}% of limits`} />
        <SummaryTile label="Expired unfilled" value={expired} hint="crossed no limit" />
        <SummaryTile label="Window" value={Number.isFinite(report.historicalStart) ? new Date(report.historicalStart).toLocaleDateString() : "—"} hint={Number.isFinite(report.historicalStart) ? `${new Date(report.historicalStart).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} – ${new Date(report.historicalEnd).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : undefined} />
      </div>

      <div className="rounded-2xl bg-muted px-4 py-3 text-sm">
        <p className="flex items-start gap-2"><Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />Historical replay using virtual funds and Arkiv BTC/USDT futures data; these are not agent trades or Flash orders.</p>
        <Collapsible>
          <CollapsibleTrigger className="group mt-2 flex items-center gap-1 pl-6 text-xs text-muted-foreground hover:text-foreground">Assumptions and source <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" /></CollapsibleTrigger>
          <CollapsibleContent className="pt-2 pl-6 text-xs leading-relaxed text-muted-foreground">{report.snapshots} Arkiv snapshots{Number.isFinite(report.historicalStart) ? ` · ${when(report.historicalStart)} – ${when(report.historicalEnd)}` : ""}. Writer: <span className="font-mono break-all">{report.writer}</span>. Each $1,000–$5,000 virtual limit uses the current bid or ask; a virtual fill occurs only when the next published snapshot crosses the limit. Unfilled orders expire at that next snapshot. A 0.1% fee and an initial virtual $50,000 USDT / $50,000 BTC balance are assumed; liquidity, gas and slippage are not modeled.</CollapsibleContent>
        </Collapsible>
      </div>

      {report.orders.length > 0 && <div>
        <Table>
          <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Decision time</TableHead><TableHead>Side</TableHead><TableHead className="text-right">Size</TableHead><TableHead className="text-right">Limit</TableHead><TableHead>Outcome</TableHead><TableHead>Next observation</TableHead><TableHead className="text-right"><span className="sr-only">Arkiv evidence</span></TableHead></TableRow></TableHeader>
          <TableBody>{visible.slice(0, shown).map(o => { const isOpen = open === o.id; return <React.Fragment key={o.id}>
            <TableRow>
              <TableCell className="num whitespace-nowrap text-muted-foreground">{when(o.at)}</TableCell>
              <TableCell><Badge variant={o.side === "buy" ? "profit" : "loss"} size="micro">{o.side}</Badge></TableCell>
              <TableCell className="num text-right">${money(o.notional)}</TableCell>
              <TableCell className="num text-right">${money(o.limit)}</TableCell>
              <TableCell className="whitespace-nowrap">{o.status === "paper fill" ? <Badge variant="ink" size="micro">Fill</Badge> : <Badge variant="muted" size="micro">Expired unfilled</Badge>}{o.fillPrice !== undefined && <span className="num ml-2 text-xs text-muted-foreground">${money(o.fillPrice)}</span>}</TableCell>
              <TableCell className="num whitespace-nowrap text-muted-foreground">{when(o.resultAt)}</TableCell>
              <TableCell className="text-right"><Button variant="ghost" size="xs" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : o.id)}>Evidence {isOpen ? <ChevronDown /> : <ChevronRight />}</Button></TableCell>
            </TableRow>
            {isOpen && <TableRow className="hover:bg-transparent"><TableCell colSpan={7} className="bg-muted/50"><Evidence source={o.sourceKey} next={o.resultKey} previous={o.previousMid} current={o.observedMid} /></TableCell></TableRow>}
          </React.Fragment>; })}</TableBody>
        </Table>
        <div className="flex flex-wrap items-center justify-between gap-2 pt-3">
          <Micro>Showing {Math.min(shown, visible.length)} of {visible.length} replayed limits</Micro>
          {shown < visible.length && <Button variant="soft" size="sm" onClick={() => setShown(n => n + PAGE)}>Show {Math.min(PAGE, visible.length - shown)} more</Button>}
        </div>
      </div>}
      {!report.orders.length && <p className="text-sm text-muted-foreground">There are not enough distinct valid Arkiv observations to produce an example order.</p>}

      <div className="border-t border-border/70 pt-5">
        <h3 className="font-display text-2xl leading-tight">Recorded model decisions</h3>
        <p className="mt-1 text-sm text-muted-foreground">These are the saved decisions from the earlier Arkiv-backed model diagnostic, separate from the replay above. No new inference was run.</p>
        {report.paper?.warning && <p className="mt-2 text-xs text-muted-foreground">{report.paper.warning.replace(/paper/gi, "virtual")}</p>}
        {report.agent?.decisions?.length
          ? <ul className="mt-3 space-y-2">{report.agent.decisions.map(d => { const fill = report.agent?.fills?.find(f => f.runId === d.id); return <li key={d.id} className="flex flex-wrap items-start gap-3 rounded-2xl bg-muted p-4 text-sm"><Badge variant="ink" size="micro" className="mt-0.5">{d.decision?.decision ?? d.status}</Badge><span className="min-w-0 flex-1">{d.decision?.rationaleSummary ?? "No explanation recorded"}{fill && <span className="num mt-1 block text-xs text-muted-foreground">Historical virtual fill {fill.side} ${money(fill.usd ?? 0)} at ${money(fill.price)}</span>}</span></li>; })}</ul>
          : <p className="mt-3 text-sm text-muted-foreground">No saved model decisions are available for this agent.</p>}
      </div>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><ShieldCheck className="size-3.5" /> Inspect source data using the entity keys above in the <a href="https://rabdi.explorer.arkiv.network/entity-explorer" target="_blank" rel="noreferrer" className="underline underline-offset-2">Arkiv explorer</a>.</p>
    </div>}
  </Card>;
}

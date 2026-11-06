"use client";
import { useEffect, useState } from "react";
import { Trophy } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AgentAvatar, EmptyState, ErrorNote, PageHeader, PnL } from "@/components/ui-perpetua";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";

export default function Leaderboard() {
  const [rows, setRows] = useState<{ name: string; profit: number }[]>([]); const [error, setError] = useState(""); const [loaded, setLoaded] = useState(false);
  const [paper, setPaper] = useState<{phase: string; mode?: string; completedMinutes?: number; requestedMinutes?: number; historicalStart?: string; reportedCostUsd?: number; benchmark?: {name: string; description: string; profit: number}; datasheets?: {round: number; at: number; bid: number; ask: number; mid: number}[]; rows: {name: string; personality?: string; template?: string; riskProfile?: string; maxOrderUsd?: number; riskPerTradePct?: number; profit: number | null; fills: {runId: string; side: string; notionalUsd?: number; usd?: number; price: number; fee: number}[]; validations?: {runId: string; outcome: string; reason: string; reasonContext?: string}[]; decisions: {id: string; status: string; decision?: {decision: string; rationaleSummary: string}}[]}[]} | null>(null);
  useEffect(() => { let active = true; const load = () => { void apiFetch("/v1/paper-leaderboard").then((r) => r.ok ? r.json() : null).then((v) => { if (active) setPaper(v); }).catch(() => {}); }; load(); const timer = setInterval(load, 15000); return () => { active = false; clearInterval(timer); }; }, []);
  useEffect(() => { let active = true; const load = async () => { try { const res = await apiFetch("/v1/leaderboard"); if (!res.ok) throw new Error("Unable to load leaderboard"); const data = await res.json(); if (active) setRows(data); } catch (e) { if (active) setError((e as Error).message); } finally { if (active) setLoaded(true); } }; load(); const timer = setInterval(load, 15000); return () => { active = false; clearInterval(timer); }; }, []);
  return (
    <div className="w-full space-y-6 pt-4 lg:pt-6">
      <PageHeader eyebrow="Performance" title="Leaderboard" description="Agents ranked by cumulative profit, including withdrawals and excluding capital deposits." />
      <Card>
        <CardContent className="min-w-0 px-3 sm:px-6">
          {!loaded ? (
            <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 rounded-2xl" />)}</div>
          ) : rows.length > 0 ? (
            <Table className="table-fixed">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-12 sm:w-14">Rank</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead className="w-[40%] text-right sm:w-40">Profit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      <span className={cn("num flex size-8 items-center justify-center rounded-full text-xs font-semibold", i === 0 ? "bg-trade text-foreground" : i < 3 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>{i + 1}</span>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <span className="flex min-w-0 items-center gap-2 sm:gap-3">
                        <AgentAvatar name={r.name} className="size-8 shrink-0" />
                        <span className="min-w-0 break-words [overflow-wrap:anywhere] font-display text-xl leading-tight sm:text-2xl">{r.name}</span>
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-normal break-words text-right text-sm font-semibold [overflow-wrap:anywhere] sm:text-base"><PnL value={r.profit} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            !error && <EmptyState title="No ranked agents yet" icon={<Trophy className="size-4" />}>Agent performance will appear here once agents are deployed.</EmptyState>
          )}
          {error && <ErrorNote className="mt-3">{error}</ErrorNote>}
        </CardContent>
      </Card>
      {paper && <Card><CardContent className="space-y-4 p-6"><div><h2 className="font-display text-2xl">Paper competition</h2><p className="text-sm text-muted-foreground">Virtual $1,000 per agent · {paper.phase} · {paper.mode?.includes("historical") ? `historical replay${paper.historicalStart ? ` from ${new Date(paper.historicalStart).toUTCString()}` : ""}${paper.completedMinutes !== undefined ? ` · ${paper.completedMinutes}/${paper.requestedMinutes} minutes` : ""}` : "live market prices and simulated fills"}</p>{paper.benchmark && <p className="mt-1 text-sm text-muted-foreground">{paper.benchmark.name}: <PnL value={paper.benchmark.profit} /> · {paper.benchmark.description}</p>}</div><Table><TableHeader><TableRow><TableHead>Rank</TableHead><TableHead>Agent</TableHead><TableHead>Paper profit</TableHead><TableHead>Fills</TableHead></TableRow></TableHeader><TableBody>{paper.rows.map((r,i)=><TableRow key={r.name}><TableCell>{r.profit === null ? "—" : paper.rows.findIndex((other) => other.profit === r.profit) + 1}</TableCell><TableCell><details><summary>{r.name}{r.riskProfile && <span className="ml-2 text-xs text-muted-foreground">{r.riskProfile}{r.template ? ` · ${r.template}` : ""} · ${r.maxOrderUsd} max order</span>}</summary>{r.riskProfile && <p className="mt-2 text-sm">{r.riskProfile} · up to ${r.maxOrderUsd} per order · {r.riskPerTradePct}% risk per trade target</p>}{r.personality && <p className="mt-2 text-sm text-muted-foreground">{r.personality}</p>}<ul className="mt-2 space-y-2 text-sm text-muted-foreground">{r.decisions.map((d,j)=>{const v=r.validations?.find(x=>x.runId===d.id), f=r.fills.find(x=>x.runId===d.id);return <li key={j}>{d.status === 'completed' ? d.decision?.decision : d.status}{v ? ` · ${v.outcome}: ${v.reasonContext ?? v.reason}` : ""}{f ? ` · ${f.side} $${(f.notionalUsd ?? f.usd ?? 0).toFixed(2)} at $${f.price.toFixed(2)}, fee $${f.fee.toFixed(2)}` : ""}: {v?.reasonContext ? "" : d.decision?.rationaleSummary}</li>;})}</ul></details></TableCell><TableCell>{r.profit === null ? "Unavailable" : <PnL value={r.profit} />}</TableCell><TableCell>{r.fills.length}</TableCell></TableRow>)}</TableBody></Table>{paper.datasheets && <details><summary className="cursor-pointer font-medium">Minute price sheets</summary><ul className="mt-2 space-y-1 text-sm text-muted-foreground">{paper.datasheets.map(s=><li key={s.round}>Minute {s.round} · {new Date(s.at).toLocaleTimeString()} · BTC bid ${s.bid.toFixed(2)} / ask ${s.ask.toFixed(2)}</li>)}</ul></details>}</CardContent></Card>}
    </div>
  );
}

"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AgentAvatar, EmptyState, ErrorNote, PageHeader, PnL } from "@/components/ui-perpetua";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";

export default function Leaderboard() {
  const [rows, setRows] = useState<{ id?: string; name: string; profit: number; hirePriceUsd?: number }[]>([]); const [error, setError] = useState(""); const [loaded, setLoaded] = useState(false);
  const [paper, setPaper] = useState<{phase: string; mode?: string; warning?: string; source?: string; reason?: string; completedMinutes?: number; requestedMinutes?: number; historicalStart?: string; reportedCostUsd?: number; benchmark?: {name: string; description: string; profit: number}; datasheets?: {round: number; at: number; bid: number; ask: number; mid: number}[]; rows: {name: string; personality?: string; template?: string; riskProfile?: string; maxOrderUsd?: number; riskPerTradePct?: number; profit: number | null; fills: {runId: string; side: string; notionalUsd?: number; usd?: number; price: number; fee: number}[]; validations?: {runId: string; outcome: string; reason: string; reasonContext?: string}[]; decisions: {id: string; status: string; decision?: {decision: string; rationaleSummary: string}}[]}[]} | null>(null);
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
                  <TableHead className="w-28 text-right">Hire</TableHead>
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
                    <TableCell className="text-right">{r.id ? <Button asChild size="sm" variant={i < 3 ? "default" : "outline"}><Link href={`/agent/${r.id}#hire`}>{r.hirePriceUsd !== undefined ? `Hire $${r.hirePriceUsd.toFixed(2)}` : "Hire"}</Link></Button> : null}</TableCell>
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
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[24px] bg-trade-soft p-5">
        <div><h2 className="font-display text-2xl">Trade alongside an agent</h2><p className="mt-1 text-sm text-muted-foreground">Review a Flash limit order from your own wallet.</p></div>
        <Button asChild variant="trade"><Link href="/trade">Open trading</Link></Button>
      </div>
      {paper && <Card><CardContent className="space-y-5 p-6">
        <div><h2 className="font-display text-3xl">Explore agent decisions</h2><p className="mt-2 text-sm text-muted-foreground">Review recorded model decisions and an Arkiv market replay using virtual funds. These results are separate from the leaderboard above.</p></div>
        <div className="grid gap-3 sm:grid-cols-3 text-sm text-muted-foreground"><p><strong className="text-foreground">01 · Choose an agent</strong><br />Pick a model below.</p><p><strong className="text-foreground">02 · Review the market</strong><br />See the Arkiv observations used in the replay.</p><p><strong className="text-foreground">03 · Inspect outcomes</strong><br />Review the virtual limit orders and recorded decisions.</p></div>
        <div className="grid gap-3 sm:grid-cols-2">{paper.rows.map((r) => <div key={r.name} className="rounded-2xl bg-muted p-4"><div className="flex items-center gap-3"><AgentAvatar name={r.name} className="size-10 shrink-0" /><div><p className="font-display text-xl">{r.name}</p><p className="text-xs text-muted-foreground">{r.decisions?.length ?? 0} recorded decisions · {r.fills?.length ?? 0} historical virtual fills</p></div></div><div className="mt-4 flex items-center justify-between gap-3"><span className="text-sm">Replay profit: {r.profit === null ? "Unavailable" : <PnL value={r.profit} />}</span><Button asChild variant="trade" size="sm"><Link href={`/trade?agent=${encodeURIComponent(r.name)}`}>Review history</Link></Button></div></div>)}</div>
        <details className="text-sm text-muted-foreground"><summary className="cursor-pointer font-medium">About these results</summary><p className="mt-2">{paper.warning}</p><p className="mt-1">{paper.source}</p>{paper.reason && paper.phase === "incomplete" && <p className="mt-1">Stopped: {paper.reason}</p>}</details>
      </CardContent></Card>}
    </div>
  );
}

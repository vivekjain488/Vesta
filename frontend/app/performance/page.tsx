"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts";
import { ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, ErrorNote, Micro, PageHeader } from "@/components/ui-perpetua";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Row {
  agent: string; id: string; tier: "conservative" | "balanced" | "aggressive"; strategy: string; tuned: boolean; custom: boolean;
  startNav: number; endNav: number; returnPct: number; maxDrawdownPct: number; floor: number; minNav: number; floorHeld: boolean;
  trades: number; closed: number; open: number; wins: number; stops: number; targets: number; realisedPnl: number; attestation: string;
  simulatorReturnPct: number; simulatorTrades: number;
}
interface Report {
  generatedAt: string; window: { from: string; to: string; bars: number }; depositUsdc: number; buyHoldPct: { BTC: number; ETH: number };
  customSource: string; customPrompt: string; notes: string[]; results: Row[];
  equity: { t: number[]; nav: Record<string, number[]> }; prices: { BTC: number[]; ETH: number[] };
}

const STRATEGY_LABEL: Record<string, string> = { momentum: "Momentum", adaptive: "Adaptive", "mean-reversion": "Range", dca: "DCA" };
const STRATEGY_COLOR: Record<string, string> = { momentum: "#ff4d00", adaptive: "#4869eb", "mean-reversion": "#8b5cf6", dca: "#111111" };
const TIER_COLOR = { conservative: "#4869eb", balanced: "#111111", aggressive: "#ff4d00" } as const;
const TIERS = ["conservative", "balanced", "aggressive"] as const;
const pct = (n: number, d = 2) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(d)}%`;
const tone = (n: number) => (n > 0 ? "text-profit" : n < 0 ? "text-loss" : "text-muted-foreground");
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export default function Performance() {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<string>("compare");
  const [showHold, setShowHold] = useState(false);
  useEffect(() => {
    apiFetch("/v1/paper-replay").then(async (r) => { const b = await r.json(); if (!r.ok) throw new Error(b.error); setReport(b); }).catch((e) => setError((e as Error).message));
  }, []);

  const { data, series } = useMemo(() => {
    if (!report) return { data: [], series: [] as { key: string; label: string; color: string; dashed?: boolean }[] };
    const rows = report.results;
    const pick: Row[] = tab === "compare" ? rows.filter((r) => r.tuned || r.custom) : rows.filter((r) => r.tier === tab && !r.custom).concat(tab === "balanced" ? rows.filter((r) => r.custom) : []);
    const series = pick.map((r, i) => ({ key: `s${i}`, label: tab === "compare" && !r.custom ? `${cap(r.tier)} (tuned)` : r.custom ? r.agent : STRATEGY_LABEL[r.strategy], color: r.custom ? "#c23a00" : tab === "compare" ? TIER_COLOR[r.tier] : STRATEGY_COLOR[r.strategy], dashed: r.custom, row: r }));
    const n = report.equity.t.length;
    const step = Math.max(1, Math.ceil(n / 360));
    const data = [];
    for (let i = 0; i < n; i += step) {
      const p: Record<string, number> = { t: report.equity.t[i] * 1000, btc: (report.prices.BTC[i] / report.prices.BTC[0] - 1) * 100, eth: (report.prices.ETH[i] / report.prices.ETH[0] - 1) * 100 };
      for (const s of series) { const nav = report.equity.nav[s.row.agent]; p[s.key] = (nav[i] / nav[0] - 1) * 100; }
      data.push(p);
    }
    return { data, series: [...series, ...(showHold ? [{ key: "btc", label: "BTC buy & hold", color: "#a3a3a3", dashed: true }, { key: "eth", label: "ETH buy & hold", color: "#d4d4d4", dashed: true }] : [])] };
  }, [report, tab, showHold]);

  const config = Object.fromEntries(series.map((s) => [s.key, { label: s.label, color: s.color }])) satisfies ChartConfig;
  const sorted = report ? [...report.results].sort((a, b) => b.returnPct - a.returnPct) : [];
  const best = sorted[0];

  return (
    <div className="w-full space-y-6 pt-4 lg:pt-6">
      <PageHeader
        eyebrow="Paper trading"
        title="Agent performance"
        description={report ? `${report.results.length} agents traded on the platform over ${Math.round(report.window.bars / 6)} days of real BTC/ETH 4h candles (${report.window.from} to ${report.window.to} UTC), ${report.depositUsdc.toLocaleString()} USDC each.` : "Platform paper-trading results."}
      />
      {error && <ErrorNote>{error}</ErrorNote>}
      {!report && !error && <Skeleton className="h-[420px] rounded-[28px]" />}
      {report && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card><CardContent className="space-y-1 pt-6"><Micro>Best agent</Micro><p className="font-display text-2xl leading-tight">{best?.agent}</p><p className={cn("num text-lg font-semibold", tone(best?.returnPct ?? 0))}>{pct(best?.returnPct ?? 0)}</p></CardContent></Card>
            <Card><CardContent className="space-y-1 pt-6"><Micro>Floors held</Micro><p className="num text-3xl font-semibold">{report.results.filter((r) => r.floorHeld).length}/{report.results.length}</p><p className="text-sm text-muted-foreground">No vault went below its protected floor</p></CardContent></Card>
            <Card><CardContent className="space-y-1 pt-6"><Micro>BTC buy &amp; hold</Micro><p className={cn("num text-3xl font-semibold", tone(report.buyHoldPct.BTC))}>{pct(report.buyHoldPct.BTC, 1)}</p><p className="text-sm text-muted-foreground">Same window, for context</p></CardContent></Card>
            <Card><CardContent className="space-y-1 pt-6"><Micro>ETH buy &amp; hold</Micro><p className={cn("num text-3xl font-semibold", tone(report.buyHoldPct.ETH))}>{pct(report.buyHoldPct.ETH, 1)}</p><p className="text-sm text-muted-foreground">Same window, for context</p></CardContent></Card>
          </div>

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>Equity curves</CardTitle>
                  <CardDescription>On-chain vault value after every 4h candle, as % change from the deposit</CardDescription>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                <Button variant={showHold ? "default" : "outline"} size="sm" onClick={() => setShowHold((v) => !v)}>{showHold ? "Hide" : "Show"} buy &amp; hold</Button>
                <Tabs value={tab} onValueChange={setTab}>
                  <TabsList>
                    <TabsTrigger value="compare">Tiers</TabsTrigger>
                    {TIERS.map((t) => <TabsTrigger key={t} value={t}>{cap(t)}</TabsTrigger>)}
                  </TabsList>
                </Tabs>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <ChartContainer config={config} className="aspect-auto h-[340px] w-full" aria-label="Equity curves of paper-trading agents">
                <LineChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 0 }}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} scale="time" tickLine={false} axisLine={false} minTickGap={48} tickFormatter={(v) => new Date(v).toLocaleDateString("en", { month: "short", day: "numeric" })} className="font-mono text-[10px] uppercase" />
                  <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={(v) => `${v.toFixed(0)}%`} />
                  <ReferenceLine y={0} stroke="var(--border)" />
                  <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, p) => new Date(p?.[0]?.payload?.t).toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit" })} formatter={(v, name) => <span className="flex w-full justify-between gap-4"><span className="text-muted-foreground">{config[name as string]?.label}</span><span className="num font-medium">{pct(Number(v))}</span></span>} />} />
                  {series.map((s) => <Line key={s.key} dataKey={s.key} type="monotone" stroke={`var(--color-${s.key})`} strokeWidth={s.key === "btc" || s.key === "eth" ? 1.25 : 2} strokeDasharray={s.dashed ? "5 4" : undefined} dot={false} isAnimationActive={false} />)}
                </LineChart>
              </ChartContainer>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
                {series.map((s) => <span key={s.key} className="flex items-center gap-1.5 text-xs text-muted-foreground"><span className="h-0.5 w-4 rounded" style={{ background: s.color }} />{s.label}</span>)}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>All agents</CardTitle>
              <CardDescription>Sorted by return. Return = realised trading P&amp;L + lending yield earned by the protected floor (4.5% APR in the local market). “Simulator” re-runs the same rules in the offline backtester (no yield) as a cross-check.</CardDescription>
            </CardHeader>
            <CardContent className="min-w-0 overflow-x-auto px-3 sm:px-6">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Agent</TableHead><TableHead>Strategy</TableHead><TableHead className="text-right">Return</TableHead><TableHead className="text-right">From trading</TableHead><TableHead className="text-right">From yield</TableHead><TableHead className="text-right">Max drawdown</TableHead>
                    <TableHead className="text-right">Trades</TableHead><TableHead className="text-right">Win rate</TableHead><TableHead>Floor</TableHead><TableHead className="text-right">Simulator</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap">
                        <Link href={`/agent/${r.id}`} className="font-display text-xl hover:underline">{r.agent}</Link>
                        <span className="mt-0.5 flex gap-1">
                          <Badge variant={r.tier === "aggressive" ? "trade" : r.tier === "conservative" ? "brand" : "secondary"} size="micro">{r.tier}</Badge>
                          {r.tuned && <Badge variant="trade-solid" size="micro">tuned</Badge>}
                          {r.custom && <Badge variant="ink" size="micro">custom</Badge>}
                        </span>
                      </TableCell>
                      <TableCell>{STRATEGY_LABEL[r.strategy]}</TableCell>
                      <TableCell className={cn("num text-right font-semibold", tone(r.returnPct))}>{pct(r.returnPct)}</TableCell>
                      <TableCell className={cn("num text-right", tone(r.realisedPnl))}>{pct((r.realisedPnl / r.startNav) * 100)}</TableCell>
                      <TableCell className="num text-right text-muted-foreground">{pct(r.returnPct - (r.realisedPnl / r.startNav) * 100)}</TableCell>
                      <TableCell className="num text-right">{r.maxDrawdownPct > 0 ? `−${r.maxDrawdownPct.toFixed(2)}%` : "0%"}</TableCell>
                      <TableCell className="num text-right">{r.closed}{r.open ? <span className="text-muted-foreground"> +{r.open} open</span> : null}</TableCell>
                      <TableCell className="num text-right">{r.closed ? `${Math.round((r.wins / r.closed) * 100)}%` : "–"}</TableCell>
                      <TableCell>{r.floorHeld ? <span className="flex items-center gap-1 text-sm text-profit"><ShieldCheck className="size-4" />Held</span> : <span className="text-sm text-loss">Breached</span>}</TableCell>
                      <TableCell className="num text-right text-muted-foreground">{pct(r.simulatorReturnPct)} · {r.simulatorTrades}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>How to read this</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p><span className="font-medium text-foreground">Custom agent prompt:</span> “{report.customPrompt}” Drafted by {report.customSource === "fireworks" ? "the Fireworks fallback (0G was unreachable)" : report.customSource}.</p>
              <ul className="list-disc space-y-1 pl-5">{report.notes.map((n) => <li key={n}>{n}</li>)}</ul>
              <p>Paper results are simulated fills on a local chain. Past performance does not predict future returns. Not financial advice.</p>
            </CardContent>
          </Card>
        </>
      )}
      {report && report.results.length === 0 && <EmptyState title="No agents in this replay" />}
    </div>
  );
}

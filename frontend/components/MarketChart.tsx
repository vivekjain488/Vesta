"use client";
import { useEffect, useMemo, useState } from "react";
import { Bar as RBar, ComposedChart, Line, ReferenceLine, XAxis, YAxis } from "recharts";
import { donchian, ema, sma } from "@perpetua/core";
import { CandlestickChart } from "lucide-react";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { EmptyState, Micro } from "@/components/ui-perpetua";
import { fmt } from "@/lib/data";
import { fetchCandles4h, supportedSymbol, type MarketSeries } from "@/lib/market";
import { cn } from "@/lib/utils";

export interface TradeLevels {
  entry?: number | null;
  stop?: number | null;
  target?: number | null;
}

const config = {
  ema: { label: "EMA 20", color: "var(--brand)" },
  sma: { label: "MA 50", color: "var(--trade)" },
} satisfies ChartConfig;

const RANGES = { "5D": 30, "10D": 60, "15D": 90 } as const;
const priceDigits = (p: number) => (p >= 1000 ? 0 : p >= 100 ? 1 : p >= 1 ? 2 : 4);

/** Candles drawn inside the [low, high] range bar recharts hands us. */
function Candle(props: any) {
  const { x, y, width, height, payload } = props;
  if (!payload || !Number.isFinite(height)) return null;
  const { o, c, h, l } = payload;
  const span = h - l || 1;
  const ppu = height / span;
  const up = c >= o;
  const bodyTop = y + (h - Math.max(o, c)) * ppu;
  const bodyH = Math.max(1, Math.abs(o - c) * ppu);
  const cx = x + width / 2;
  const w = Math.max(2, Math.min(width * 0.62, 9));
  const color = up ? "#111111" : "#C9C9C6";
  return (
    <g>
      <line x1={cx} x2={cx} y1={y} y2={y + height} stroke={color} strokeWidth={1.25} />
      <rect x={cx - w / 2} y={bodyTop} width={w} height={bodyH} rx={1.5} fill={color} />
    </g>
  );
}

/** End-of-line pill, like the reference's "9.190" and "STOP LOSS 8.10". */
function LevelPill({ viewBox, text, fill, color = "#fff" }: { viewBox?: any; text: string; fill: string; color?: string }) {
  if (!viewBox) return null;
  const w = text.length * 6.6 + 18;
  const x = viewBox.x + viewBox.width - w - 4;
  const y = viewBox.y - 11;
  return (
    <g>
      <rect x={x} y={y} width={w} height={22} rx={11} fill={fill} />
      <text x={x + w / 2} y={y + 14.5} textAnchor="middle" fontSize={10.5} letterSpacing="0.06em" fill={color} style={{ fontFamily: "var(--font-mono)" }}>
        {text}
      </text>
    </g>
  );
}

function CandleTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const b = payload[0].payload;
  const d = priceDigits(b.c);
  return (
    <div className="rounded-2xl bg-card px-3 py-2 text-xs shadow-[0_8px_24px_-12px_rgba(17,17,17,0.3),0_0_0_1px_rgba(17,17,17,0.05)]">
      <p className="micro text-muted-foreground">{new Date(b.t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</p>
      <div className="num mt-1 grid grid-cols-4 gap-x-3">
        {(["o", "h", "l", "c"] as const).map((k) => (
          <span key={k}>
            <span className="text-faint uppercase">{k} </span>
            {fmt(b[k], d)}
          </span>
        ))}
      </div>
    </div>
  );
}

export function MarketChart({ symbols, levels, agentName, className }: { symbols: string[]; levels?: TradeLevels | null; agentName?: string; className?: string }) {
  const available = useMemo(() => {
    const list = [...new Set(symbols.map((s) => s.toUpperCase()))].filter(supportedSymbol);
    return list.length ? list : ["LINK"];
  }, [symbols]);
  const [symbol, setSymbol] = useState(available[0]);
  const [range, setRange] = useState<keyof typeof RANGES>("10D");
  const [series, setSeries] = useState<MarketSeries | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!available.includes(symbol)) setSymbol(available[0]);
  }, [available, symbol]);

  useEffect(() => {
    const ctrl = new AbortController();
    const load = () =>
      fetchCandles4h(symbol, 90 + 50, ctrl.signal)
        .then((s) => {
          setSeries(s);
          setError(null);
        })
        .catch((e) => {
          if ((e as Error).name !== "AbortError") setError("Market data unavailable");
        });
    setSeries(null);
    load();
    const t = setInterval(load, 5 * 60_000);
    return () => {
      ctrl.abort();
      clearInterval(t);
    };
  }, [symbol]);

  const view = useMemo(() => {
    if (!series) return null;
    const closes = series.bars.map((b) => b.c);
    const e20 = ema(closes, 20);
    const s50 = sma(closes, 50);
    const dc = donchian(series.bars, 20);
    const rows = series.bars.map((b, i) => ({ ...b, range: [b.l, b.h] as [number, number], ema: Number.isFinite(e20[i]) ? e20[i] : null, sma: Number.isFinite(s50[i]) ? s50[i] : null }));
    const shown = rows.slice(-RANGES[range]);
    const last = series.bars[series.bars.length - 1];
    const dayAgo = series.bars[series.bars.length - 7];
    const change = dayAgo ? (last.c - dayAgo.c) / dayAgo.c : 0;
    const lowest = Math.min(...shown.map((r) => r.l));
    const highest = Math.max(...shown.map((r) => r.h));
    // Only draw trade levels that are plausible against this live market; otherwise they would squash the candles.
    const plausible = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v >= lowest * 0.6 && v <= highest * 1.4;
    const drawn = { entry: plausible(levels?.entry) ? levels!.entry : null, stop: plausible(levels?.stop) ? levels!.stop : null, target: plausible(levels?.target) ? levels!.target : null };
    const hidden = [levels?.entry, levels?.stop, levels?.target].some((v) => typeof v === "number" && Number.isFinite(v) && !plausible(v));
    const lvl = [drawn.entry, drawn.stop, drawn.target].filter((v): v is number => v !== null);
    const lo = Math.min(lowest, ...lvl);
    const hi = Math.max(highest, ...lvl);
    const pad = (hi - lo) * 0.08;
    const maxV = Math.max(...shown.map((r) => r.v));
    return { shown, last, change, drawn, hidden, domain: [lo - pad, hi + pad] as [number, number], maxV, rangeLo: dc.lower[dc.lower.length - 1], rangeHi: dc.upper[dc.upper.length - 1] };
  }, [series, range, levels]);

  const d = view ? priceDigits(view.last.c) : 2;

  return (
    <Card className={cn("gap-0 py-0", className)} aria-label={`${symbol} 4-hour price chart`}>
      <div className="flex flex-wrap items-center gap-2 px-5 pt-5 sm:px-6">
        <span className="flex items-center gap-2 rounded-full bg-primary py-1 pr-3.5 pl-1 text-primary-foreground">
          <span className="flex size-6 items-center justify-center rounded-full bg-white/15">
            <CandlestickChart className="size-3.5" />
          </span>
          <span className="text-sm font-medium">{symbol}/USD</span>
          <span className="text-xs text-white/50">| 4H</span>
        </span>
        {view && (
          <span className="num text-sm">
            <span className="text-brand-hover">{fmt(view.last.c, d)}</span>
            <span className={cn("ml-1", view.change < 0 ? "text-loss" : "text-profit")}>
              {view.change >= 0 ? "+" : "−"}
              {(Math.abs(view.change) * 100).toFixed(1)}% 24h
            </span>
          </span>
        )}
        {available.length > 1 && (
          <ToggleGroup type="single" size="sm" spacing={1} value={symbol} onValueChange={(v) => v && setSymbol(v)} className="ml-auto rounded-full bg-muted p-1" aria-label="Asset">
            {available.map((s) => (
              <ToggleGroupItem key={s} value={s} className="micro">{s}</ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 px-5 pt-3 sm:px-6">
        <span className="flex h-7 items-center gap-1.5 rounded-full bg-muted px-3 text-xs"><span className="size-1.5 rounded-full bg-brand" />EMA 20</span>
        <span className="flex h-7 items-center gap-1.5 rounded-full bg-muted px-3 text-xs"><span className="size-1.5 rounded-full bg-trade" />MA 50</span>
        {view && Number.isFinite(view.rangeLo) && <span className="num flex h-7 items-center rounded-full bg-muted px-3 text-xs">Range {fmt(view.rangeLo, d)}–{fmt(view.rangeHi, d)}</span>}
        <ToggleGroup type="single" size="sm" spacing={1} value={range} onValueChange={(v) => v && setRange(v as keyof typeof RANGES)} className="ml-auto rounded-full bg-muted p-1" aria-label="Time range">
          {Object.keys(RANGES).map((r) => (
            <ToggleGroupItem key={r} value={r} className="micro">{r}</ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <div className="px-2 pt-2 pb-3 sm:px-3">
        {error ? (
          <EmptyState className="mx-3 my-4 min-h-[260px]" title="Market data unavailable" icon={<CandlestickChart className="size-4" />}>
            Public 4h candles for {symbol} could not be loaded. Nothing is shown rather than estimated prices.
          </EmptyState>
        ) : !view ? (
          <Skeleton className="mx-3 my-4 h-[280px] rounded-3xl" />
        ) : (
          <ChartContainer config={config} className="aspect-auto h-[300px] w-full">
            <ComposedChart data={view.shown} margin={{ top: 16, right: 8, bottom: 0, left: 8 }} barCategoryGap="22%">
              <XAxis
                dataKey="t"
                tickLine={false}
                axisLine={false}
                minTickGap={48}
                tickMargin={10}
                tick={{ fontSize: 10, fontFamily: "var(--font-mono)", fill: "var(--muted-foreground)", letterSpacing: "0.08em" }}
                tickFormatter={(t) => new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "2-digit" }).toUpperCase()}
              />
              {/* Separate hidden x-axis so volume and candles overlap instead of being grouped side by side. */}
              <XAxis xAxisId="vol" dataKey="t" hide />
              <YAxis yAxisId="price" domain={view.domain} hide />
              <YAxis yAxisId="vol" domain={[0, view.maxV * 3.5]} hide />
              <ChartTooltip cursor={{ stroke: "var(--border)", strokeWidth: 1 }} content={<CandleTooltip />} />
              <RBar xAxisId="vol" yAxisId="vol" dataKey="v" fill="#E6E6E3" radius={[2, 2, 0, 0]} isAnimationActive={false} />
              <RBar yAxisId="price" dataKey="range" shape={<Candle />} isAnimationActive={false} />
              <Line yAxisId="price" dataKey="ema" type="monotone" stroke="var(--color-ema)" strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />
              <Line yAxisId="price" dataKey="sma" type="monotone" stroke="var(--color-sma)" strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />
              <ReferenceLine yAxisId="price" y={view.last.c} stroke="var(--brand)" strokeDasharray="3 4" strokeOpacity={0.6} label={<LevelPill text={fmt(view.last.c, d)} fill="var(--brand)" />} />
              {view.drawn.entry != null && <ReferenceLine yAxisId="price" y={view.drawn.entry} stroke="#A3A3A3" strokeDasharray="3 4" label={<LevelPill text={`ENTRY ${fmt(view.drawn.entry, d)}`} fill="#E8E8E6" color="#111" />} />}
              {view.drawn.target != null && <ReferenceLine yAxisId="price" y={view.drawn.target} stroke="var(--trade)" strokeDasharray="3 4" label={<LevelPill text={`TARGET ${fmt(view.drawn.target, d)}`} fill="var(--trade)" color="#111" />} />}
              {view.drawn.stop != null && <ReferenceLine yAxisId="price" y={view.drawn.stop} stroke="#111" strokeDasharray="3 4" label={<LevelPill text={`STOP LOSS ${fmt(view.drawn.stop, d)}`} fill="#111" />} />}
            </ComposedChart>
          </ChartContainer>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 px-5 py-3 sm:px-6">
        <Micro>{series ? `${series.source} · closed 4h candles · ${new Date(series.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Public market data"}</Micro>
        <Micro>
          {view?.hidden
            ? "Open trade levels are outside the live price range and not drawn"
            : levels
              ? `${agentName ?? "Agent"} open trade levels shown`
              : agentName
                ? `No open ${agentName} trade`
                : ""}
        </Micro>
      </div>
    </Card>
  );
}

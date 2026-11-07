"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Bar as RBar, ComposedChart, Line, ReferenceLine, XAxis, YAxis } from "recharts";
import { ema, sma } from "@perpetua/core";
import { CandlestickChart } from "lucide-react";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui-perpetua";
import { fmt } from "@/lib/data";
import { reducedMotion } from "@/lib/gsap";
import { fetchKlines, type KlineInterval, type MarketSeries } from "@/lib/market";

/** Ranges and the candle size that keeps each one readable. `bars` is what is shown; 50 extra warm up the MA 50. */
export const HISTORY_RANGES = {
  "1D": { interval: "15m", bars: 96, label: "15m candles" },
  "1W": { interval: "1h", bars: 168, label: "1h candles" },
  "1M": { interval: "4h", bars: 180, label: "4h candles" },
  "3M": { interval: "1d", bars: 90, label: "daily candles" },
  "1Y": { interval: "1d", bars: 365, label: "daily candles" },
} as const satisfies Record<string, { interval: KlineInterval; bars: number; label: string }>;
export type HistoryRange = keyof typeof HISTORY_RANGES;

const config = {
  ema: { label: "EMA 20", color: "var(--brand)" },
  sma: { label: "MA 50", color: "var(--trade)" },
} satisfies ChartConfig;

export interface Levels { entry?: number | null; stop?: number | null; target?: number | null }

function Candle(props: any) {
  const { x, y, width, height, payload } = props;
  if (!payload || !Number.isFinite(height)) return null;
  const { o, c, h, l } = payload;
  const ppu = height / (h - l || 1);
  const up = c >= o;
  const bodyTop = y + (h - Math.max(o, c)) * ppu;
  const bodyH = Math.max(1, Math.abs(o - c) * ppu);
  const cx = x + width / 2;
  const w = Math.max(1.5, Math.min(width * 0.62, 9));
  const color = up ? "#111111" : "#C9C9C6";
  return (
    <g>
      <line x1={cx} x2={cx} y1={y} y2={y + height} stroke={color} strokeWidth={1.1} />
      <rect x={cx - w / 2} y={bodyTop} width={w} height={bodyH} rx={1.2} fill={color} />
    </g>
  );
}

function LevelPill({ viewBox, text, fill, color = "#fff" }: { viewBox?: any; text: string; fill: string; color?: string }) {
  if (!viewBox) return null;
  const w = text.length * 6.6 + 18;
  const x = viewBox.x + viewBox.width - w - 4;
  const y = viewBox.y - 11;
  return (
    <g>
      <rect x={x} y={y} width={w} height={22} rx={11} fill={fill} />
      <text x={x + w / 2} y={y + 14.5} textAnchor="middle" fontSize={10.5} letterSpacing="0.06em" fill={color} style={{ fontFamily: "var(--font-mono)" }}>{text}</text>
    </g>
  );
}

function CandleTooltip({ active, payload, digits, daily }: any) {
  if (!active || !payload?.length) return null;
  const b = payload[0].payload;
  return (
    <div className="rounded-2xl bg-card px-3 py-2 text-xs shadow-[0_8px_24px_-12px_rgba(17,17,17,0.3),0_0_0_1px_rgba(17,17,17,0.05)]">
      <p className="micro text-muted-foreground">{new Date(b.t * 1000).toLocaleString(undefined, daily ? { year: "numeric", month: "short", day: "numeric" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</p>
      <div className="num mt-1 grid grid-cols-4 gap-x-3">
        {(["o", "h", "l", "c"] as const).map((k) => <span key={k}><span className="text-faint uppercase">{k} </span>{fmt(b[k], digits)}</span>)}
      </div>
      {(b.ema || b.sma) && <p className="num mt-1 text-muted-foreground">EMA 20 {b.ema ? fmt(b.ema, digits) : "—"} · MA 50 {b.sma ? fmt(b.sma, digits) : "—"}</p>}
    </div>
  );
}

/** Past prices: candles with EMA 20 / MA 50 lines and volume. Loads once per range; afterwards only the last candle updates. */
export function HistoryChart({ symbol, range, levels, digits, onSource }: { symbol: string; range: HistoryRange; levels?: Levels | null; digits: number; onSource?: (s: { source: string; fetchedAt: number } | null) => void }) {
  const spec = HISTORY_RANGES[range];
  const [series, setSeries] = useState<MarketSeries | null>(null);
  const [error, setError] = useState(false);
  // Animate the lines only on the first draw of a range; refreshes then swap data silently.
  const animate = useRef(true);
  const [motion] = useState(() => !reducedMotion());
  const sourceCb = useRef(onSource);
  sourceCb.current = onSource;

  useEffect(() => {
    const ctrl = new AbortController();
    animate.current = true;
    setSeries(null); setError(false); sourceCb.current?.(null);
    const load = async (first: boolean) => {
      try {
        const s = await fetchKlines(symbol, spec.interval, spec.bars + 50, ctrl.signal);
        if (!first) animate.current = false;
        setSeries(s); setError(false); sourceCb.current?.({ source: s.source, fetchedAt: s.fetchedAt });
      } catch (e) {
        if ((e as Error).name !== "AbortError" && first) setError(true);
      }
    };
    void load(true);
    const t = setInterval(() => void load(false), 60_000);
    return () => { ctrl.abort(); clearInterval(t); };
  }, [symbol, spec.interval, spec.bars]);

  // The dashboard hands us a fresh levels object on every poll; key on the values so the chart does not redraw.
  const levelsKey = JSON.stringify([levels?.entry ?? null, levels?.stop ?? null, levels?.target ?? null]);
  const view = useMemo(() => {
    if (!series) return null;
    const [entry, stop, target] = JSON.parse(levelsKey) as (number | null)[];
    const closes = series.bars.map((b) => b.c);
    const e20 = ema(closes, 20), s50 = sma(closes, 50);
    const rows = series.bars.map((b, i) => ({ ...b, range: [b.l, b.h] as [number, number], ema: Number.isFinite(e20[i]) ? e20[i] : null, sma: Number.isFinite(s50[i]) ? s50[i] : null })).slice(-spec.bars);
    const lo = Math.min(...rows.map((r) => r.l)), hi = Math.max(...rows.map((r) => r.h));
    const plausible = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v >= lo * 0.85 && v <= hi * 1.15;
    const drawn = { entry: plausible(entry) ? entry : null, stop: plausible(stop) ? stop : null, target: plausible(target) ? target : null };
    const lv = Object.values(drawn).filter((v): v is number => v !== null);
    const min = Math.min(lo, ...lv), max = Math.max(hi, ...lv), pad = (max - min) * 0.06;
    return { rows, last: rows[rows.length - 1], drawn, domain: [min - pad, max + pad] as [number, number], maxV: Math.max(...rows.map((r) => r.v)) };
  }, [series, spec.bars, levelsKey]);
  // After the first draw has animated, later renders and refreshes swap data without replaying anything.
  useEffect(() => {
    if (!view || !animate.current) return;
    const t = setTimeout(() => { animate.current = false; }, 1500);
    return () => clearTimeout(t);
  }, [view]);

  if (error && !view) {
    return (
      <EmptyState className="mx-2 my-4 min-h-[260px]" title="Price history unavailable" icon={<CandlestickChart className="size-4" />}>
        Past {symbol} candles could not be loaded. Nothing is shown rather than estimated prices.
      </EmptyState>
    );
  }
  if (!view) return <Skeleton className="mx-2 my-2 h-[296px] rounded-3xl" />;

  const daily = spec.interval === "1d";
  const anim = motion && animate.current;
  const tickFormat = (t: number) => {
    const d = new Date(t * 1000);
    if (range === "1D") return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    if (range === "1Y") return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" }).toUpperCase();
    return d.toLocaleDateString("en-US", { month: "short", day: "2-digit" }).toUpperCase();
  };

  return (
    <ChartContainer config={config} className="aspect-auto h-[300px] w-full">
      <ComposedChart data={view.rows} margin={{ top: 16, right: 8, bottom: 0, left: 8 }} barCategoryGap="22%">
        <XAxis dataKey="t" tickLine={false} axisLine={false} minTickGap={56} tickMargin={10} tick={{ fontSize: 10, fontFamily: "var(--font-mono)", fill: "var(--muted-foreground)", letterSpacing: "0.08em" }} tickFormatter={tickFormat} />
        <XAxis xAxisId="vol" dataKey="t" hide />
        <YAxis yAxisId="price" domain={view.domain} hide />
        <YAxis yAxisId="vol" domain={[0, view.maxV * 3.5]} hide />
        <ChartTooltip cursor={{ stroke: "var(--border)", strokeWidth: 1 }} content={<CandleTooltip digits={digits} daily={daily} />} />
        <RBar xAxisId="vol" yAxisId="vol" dataKey="v" fill="#E6E6E3" radius={[2, 2, 0, 0]} isAnimationActive={anim} animationDuration={700} />
        <RBar yAxisId="price" dataKey="range" shape={<Candle />} isAnimationActive={false} />
        <Line yAxisId="price" dataKey="ema" type="monotone" stroke="var(--color-ema)" strokeWidth={1.5} dot={false} connectNulls isAnimationActive={anim} animationDuration={1100} />
        <Line yAxisId="price" dataKey="sma" type="monotone" stroke="var(--color-sma)" strokeWidth={1.5} dot={false} connectNulls isAnimationActive={anim} animationBegin={150} animationDuration={1100} />
        <ReferenceLine yAxisId="price" y={view.last.c} stroke="var(--brand)" strokeDasharray="3 4" strokeOpacity={0.6} label={<LevelPill text={fmt(view.last.c, digits)} fill="var(--brand)" />} />
        {view.drawn.entry != null && <ReferenceLine yAxisId="price" y={view.drawn.entry} stroke="#A3A3A3" strokeDasharray="3 4" label={<LevelPill text={`ENTRY ${fmt(view.drawn.entry, digits)}`} fill="#E8E8E6" color="#111" />} />}
        {view.drawn.target != null && <ReferenceLine yAxisId="price" y={view.drawn.target} stroke="var(--trade)" strokeDasharray="3 4" label={<LevelPill text={`TARGET ${fmt(view.drawn.target, digits)}`} fill="var(--trade)" color="#111" />} />}
        {view.drawn.stop != null && <ReferenceLine yAxisId="price" y={view.drawn.stop} stroke="#111" strokeDasharray="3 4" label={<LevelPill text={`STOP LOSS ${fmt(view.drawn.stop, digits)}`} fill="#111" />} />}
      </ComposedChart>
    </ChartContainer>
  );
}

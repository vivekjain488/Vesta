"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { HISTORY_RANGES, HistoryChart, type HistoryRange } from "@/components/HistoryChart";
import { Liveline, type LivelinePoint } from "liveline";
import { donchian, ema, sma } from "@perpetua/core";
import { CandlestickChart } from "lucide-react";
import { Card } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { EmptyState, Micro } from "@/components/ui-perpetua";
import { fmt } from "@/lib/data";
import { binanceLiveUrl, fetchCandles4h, fetchKrakenPrice, fetchMinuteCandles, supportedSymbol, type MinuteCandle } from "@/lib/market";
import { cn } from "@/lib/utils";

export interface TradeLevels {
  entry?: number | null;
  stop?: number | null;
  target?: number | null;
}

const WINDOWS = [
  { label: "1m", secs: 60 },
  { label: "5m", secs: 300 },
  { label: "15m", secs: 900 },
  { label: "1h", secs: 3600 },
];
const MAX_POINTS = 6000;
const FLUSH_MS = 400; // batch trades so React renders a few times a second; Liveline interpolates in between
const priceDigits = (p: number) => (p >= 1000 ? 1 : p >= 100 ? 2 : p >= 1 ? 3 : 4);

type Status = "loading" | "live" | "polling" | "error";
interface Indicators { ema20: number; ma50: number; rangeLo: number; rangeHi: number }

/** Live price for the agent's asset: one continuous Liveline fed by the exchange trade stream (no re-mounting). */
export function MarketChart({ symbols, levels, agentName, className }: { symbols: string[]; levels?: TradeLevels | null; agentName?: string; className?: string }) {
  const available = useMemo(() => {
    const list = [...new Set(symbols.map((s) => s.toUpperCase()))].filter(supportedSymbol);
    return list.length ? list : ["LINK"];
  }, [symbols]);
  const [symbol, setSymbol] = useState(available[0]);
  const [mode, setMode] = useState<"line" | "candle">("line");
  const [range, setRange] = useState<"LIVE" | HistoryRange>("1M");
  const [history, setHistory] = useState<{ source: string; fetchedAt: number } | null>(null);
  const [windowSecs, setWindowSecs] = useState(300);
  const [points, setPoints] = useState<LivelinePoint[]>([]);
  const [value, setValue] = useState(0);
  const [candles, setCandles] = useState<MinuteCandle[]>([]);
  const [liveCandle, setLiveCandle] = useState<MinuteCandle | undefined>();
  const [change, setChange] = useState<number | null>(null);
  const [source, setSource] = useState<"Binance" | "Kraken" | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [indicators, setIndicators] = useState<Indicators | null>(null);
  const pending = useRef<LivelinePoint | null>(null);

  useEffect(() => {
    if (!available.includes(symbol)) setSymbol(available[0]);
  }, [available, symbol]);

  // Live feed: seed with recent 1m candles, then stream trades. Falls back to polling Kraken if Binance is unreachable.
  useEffect(() => {
    const ctrl = new AbortController();
    let socket: WebSocket | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let lastMessage = Date.now();
    let disposed = false;
    setPoints([]); setCandles([]); setLiveCandle(undefined); setChange(null); setSource(null); setStatus("loading");
    pending.current = null;

    const push = (p: LivelinePoint) => { pending.current = p; };
    const startPolling = () => {
      if (poll || disposed) return;
      setStatus("polling");
      const tick = async () => {
        try { push({ time: Date.now() / 1000, value: await fetchKrakenPrice(symbol, ctrl.signal) }); } catch { /* keep the last price */ }
      };
      void tick(); poll = setInterval(tick, 3000);
    };
    const connect = () => {
      const url = binanceLiveUrl(symbol);
      if (!url || disposed) return startPolling();
      const ws = new WebSocket(url);
      socket = ws;
      ws.onmessage = (event) => {
        try {
          const { stream, data } = JSON.parse(event.data);
          lastMessage = Date.now();
          if (stream.endsWith("@aggTrade")) {
            const p = Number(data.p);
            if (Number.isFinite(p)) push({ time: Number(data.T) / 1000, value: p });
          } else if (stream.endsWith("@kline_1m")) {
            const k = data.k;
            const c = { time: Math.floor(Number(k.t) / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c };
            if (k.x) setCandles((prev) => [...prev.filter((x) => x.time !== c.time), c].slice(-240));
            else setLiveCandle(c);
          } else if (stream.endsWith("@miniTicker")) {
            const o = Number(data.o), c = Number(data.c);
            if (o > 0 && Number.isFinite(c)) setChange((c - o) / o);
          }
          setStatus("live");
        } catch { /* ignore malformed exchange messages */ }
      };
      ws.onerror = () => ws.close();
      ws.onclose = () => { if (socket === ws) socket = null; };
    };

    (async () => {
      try {
        const seed = await fetchMinuteCandles(symbol, 120, ctrl.signal);
        if (disposed) return;
        const now = Date.now() / 1000;
        const closed = seed.candles.slice(0, -1);
        const forming = seed.candles[seed.candles.length - 1];
        setCandles(closed);
        setLiveCandle(forming);
        setPoints(seed.candles.map((c) => ({ time: Math.min(c.time + 59, now), value: c.close })));
        setValue(forming.close);
        setSource(seed.source);
        if (seed.source === "Binance") connect(); else startPolling();
      } catch (e) {
        if (!disposed && (e as Error).name !== "AbortError") setStatus("error");
      }
    })();

    const flush = setInterval(() => {
      const p = pending.current;
      if (p) {
        pending.current = null;
        setPoints((prev) => (prev.length && p.time <= prev[prev.length - 1].time ? prev : [...prev.slice(-MAX_POINTS), p]));
        setValue(p.value);
      }
      // Stream went quiet: drop to polling so the line keeps moving.
      if (socket && Date.now() - lastMessage > 20_000) { socket.close(); socket = null; startPolling(); }
    }, FLUSH_MS);

    return () => { disposed = true; ctrl.abort(); clearInterval(flush); if (poll) clearInterval(poll); socket?.close(); };
  }, [symbol]);

  // 4h context (EMA 20, MA 50, 20-bar range), refreshed every 5 minutes; shown as figures, not redrawn lines.
  useEffect(() => {
    const ctrl = new AbortController();
    setIndicators(null);
    const load = async () => {
      try {
        const s = await fetchCandles4h(symbol, 90, ctrl.signal);
        const closes = s.bars.map((b) => b.c);
        const dc = donchian(s.bars, 20);
        setIndicators({ ema20: ema(closes, 20).at(-1)!, ma50: sma(closes, 50).at(-1)!, rangeLo: dc.lower.at(-1)!, rangeHi: dc.upper.at(-1)! });
      } catch { /* the pills simply stay hidden */ }
    };
    void load();
    const t = setInterval(load, 300_000);
    return () => { ctrl.abort(); clearInterval(t); };
  }, [symbol]);

  const d = priceDigits(value || 1);
  // Only draw the entry if it is plausible against the live price; otherwise it would flatten the line.
  const entry = levels?.entry && value && Math.abs(levels.entry / value - 1) < 0.25 ? levels.entry : null;
  const extraLevels = [levels?.stop != null && ["Stop", levels.stop], levels?.target != null && ["Target", levels.target]].filter(Boolean) as [string, number][];
  // The history chart is memoised on values, so live ticks (several per second) never re-render or re-animate it.
  const levelsKey = JSON.stringify([levels?.entry ?? null, levels?.stop ?? null, levels?.target ?? null]);
  const historyChart = useMemo(() => {
    if (range === "LIVE") return null;
    const [e, st, t] = JSON.parse(levelsKey) as (number | null)[];
    return <HistoryChart symbol={symbol} range={range} levels={{ entry: e, stop: st, target: t }} digits={d} onSource={setHistory} />;
  }, [symbol, range, levelsKey, d]);
  const live = range === "LIVE";

  return (
    <Card className={cn("gap-0 py-0", className)} aria-label={`${symbol} live price chart`}>
      <div className="flex flex-wrap items-center gap-2 px-5 pt-5 sm:px-6">
        <span className="flex items-center gap-2 rounded-full bg-primary py-1 pr-3.5 pl-1 text-primary-foreground">
          <span className="flex size-6 items-center justify-center rounded-full bg-white/15">
            <CandlestickChart className="size-3.5" />
          </span>
          <span className="text-sm font-medium">{symbol}/{source === "Kraken" ? "USD" : "USDT"}</span>
          <span className="flex items-center gap-1 text-xs text-white/60">
            <span className={cn("size-1.5 rounded-full", status === "live" ? "bg-profit" : status === "polling" ? "bg-trade" : "bg-white/40")} aria-hidden />
            {status === "live" ? "Live" : status === "polling" ? "Polling" : status === "error" ? "Offline" : "Connecting"}
          </span>
        </span>
        {value > 0 && (
          <span className="num text-sm">
            <span className="text-brand-hover">{fmt(value, d)}</span>
            {change !== null && (
              <span className={cn("ml-1", change < 0 ? "text-loss" : "text-profit")}>
                {change >= 0 ? "+" : "−"}{(Math.abs(change) * 100).toFixed(2)}% 24h
              </span>
            )}
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
        <ToggleGroup type="single" size="sm" spacing={1} value={range} onValueChange={(v) => v && setRange(v as "LIVE" | HistoryRange)} className="rounded-full bg-muted p-1" aria-label="Time range">
          <ToggleGroupItem value="LIVE" className="micro gap-1.5"><span className={cn("size-1.5 rounded-full", status === "live" ? "bg-profit" : "bg-faint")} aria-hidden />Live</ToggleGroupItem>
          {(Object.keys(HISTORY_RANGES) as HistoryRange[]).map((r) => (
            <ToggleGroupItem key={r} value={r} className="micro">{r}</ToggleGroupItem>
          ))}
        </ToggleGroup>
        {live ? (
          <>
            <ToggleGroup type="single" size="sm" spacing={1} value={String(windowSecs)} onValueChange={(v) => v && setWindowSecs(Number(v))} className="ml-auto rounded-full bg-muted p-1" aria-label="Live window">
              {WINDOWS.map((w) => (
                <ToggleGroupItem key={w.secs} value={String(w.secs)} className="micro normal-case">{w.label}</ToggleGroupItem>
              ))}
            </ToggleGroup>
            <ToggleGroup type="single" size="sm" spacing={1} value={mode} onValueChange={(v) => { if (!v) return; setMode(v as "line" | "candle"); if (v === "candle" && windowSecs < 900) setWindowSecs(900); }} className="rounded-full bg-muted p-1" aria-label="Chart type">
              <ToggleGroupItem value="line" className="micro">Line</ToggleGroupItem>
              <ToggleGroupItem value="candle" className="micro">Candles</ToggleGroupItem>
            </ToggleGroup>
          </>
        ) : (
          <span className="ml-auto flex items-center gap-2">
            <span className="flex h-7 items-center gap-1.5 rounded-full bg-muted px-3 text-xs"><span className="size-1.5 rounded-full bg-brand" />EMA 20</span>
            <span className="flex h-7 items-center gap-1.5 rounded-full bg-muted px-3 text-xs"><span className="size-1.5 rounded-full bg-trade" />MA 50</span>
          </span>
        )}
      </div>
      {live && indicators && (
        <div className="flex flex-wrap items-center gap-2 px-5 pt-2 sm:px-6">
          <span className="num flex h-7 items-center gap-1.5 rounded-full bg-muted px-3 text-xs"><span className="size-1.5 rounded-full bg-brand" />EMA 20 (4h) {fmt(indicators.ema20, d)}</span>
          <span className="num flex h-7 items-center gap-1.5 rounded-full bg-muted px-3 text-xs"><span className="size-1.5 rounded-full bg-trade" />MA 50 (4h) {fmt(indicators.ma50, d)}</span>
          <span className="num flex h-7 items-center rounded-full bg-muted px-3 text-xs">4h range {fmt(indicators.rangeLo, d)}–{fmt(indicators.rangeHi, d)}</span>
        </div>
      )}

      <div className="px-3 pt-3 pb-3 sm:px-4">
        {!live ? (
          historyChart
        ) : status === "error" ? (
          <EmptyState className="mx-2 my-4 min-h-[260px]" title="Market data unavailable" icon={<CandlestickChart className="size-4" />}>
            Live prices for {symbol} could not be loaded. Nothing is shown rather than estimated prices.
          </EmptyState>
        ) : (
          <div className="h-[300px]">
            <Liveline
              data={points}
              value={value}
              theme="light"
              color="#5B7CFA"
              loading={status === "loading"}
              mode={mode}
              candles={candles}
              liveCandle={liveCandle}
              candleWidth={60}
              window={windowSecs}
              referenceLine={entry ? { value: entry, label: "Entry" } : undefined}
              formatValue={(v) => fmt(v, d)}
              lineWidth={2}
              badgeVariant="minimal"
            />
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 px-5 py-3 sm:px-6">
        <Micro>
          {!live
            ? history ? `${history.source} · ${HISTORY_RANGES[range].label} · updated ${new Date(history.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Loading price history"
            : source ? `${source} · ${status === "live" ? "live trades" : status === "polling" ? "polling every 3s" : "connecting"} · 1m candles` : "Public market data"}
        </Micro>
        <Micro>
          {levels && (entry || extraLevels.length)
            ? `${agentName ?? "Agent"} open trade${extraLevels.map(([k, v]) => ` · ${k} ${fmt(v, d)}`).join("")}`
            : agentName
              ? `No open ${agentName} trade`
              : ""}
        </Micro>
      </div>
    </Card>
  );
}

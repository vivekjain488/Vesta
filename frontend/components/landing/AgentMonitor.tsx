"use client";
/** One agent decision as a compact live card. A looping example run: values are illustrative, not live data. */
import { useEffect, useRef, useState } from "react";
import { Brain, CandlestickChart, Check, Database, Loader2, Pause, Play, RotateCcw, ShieldCheck, Sigma, Zap } from "lucide-react";
import { AnimatedShinyText } from "@/components/ui/animated-shiny-text";
import { reducedMotion } from "@/lib/gsap";
import { ZeroGIcon, ZeroGText } from "../ZeroG";
import { cn } from "@/lib/utils";

const STEPS = [
  { label: "Read closed 4h candles", done: "Read 120 closed 4h candles", tool: "Kraken", icon: CandlestickChart, ms: 1100 },
  { label: "Scoring five factors", done: "Scored 4 of 5 factors agreeing", tool: "Rules", icon: Sigma, ms: 1200 },
  { label: "Reasoning on 0G", done: "Reasoned on 0G (TEE signed)", tool: "0G", icon: ZeroGIcon as unknown as typeof Brain, ms: 1900 },
  { label: "Waiting for RiskGate", done: "RiskGate approved the digest", tool: "RiskGate", icon: ShieldCheck, ms: 2300 },
  { label: "Placing bracket order", done: "Placed LINK bracket, stop −8%", tool: "Flash", icon: Zap, ms: 1200 },
  { label: "Committing to Arkiv", done: "Committed the signal hash", tool: "Arkiv", icon: Database, ms: 900 },
] as const;
const TOTAL = STEPS.reduce((s, x) => s + x.ms, 0);
const fmtS = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const clock = (ms: number) => `0:${String(Math.floor(ms / 1000)).padStart(2, "0")}`;

export function AgentMonitor({ className }: { className?: string }) {
  const [t, setT] = useState(0);
  const [paused, setPaused] = useState(false);
  const clockRef = useRef({ last: 0, t: 0, hold: 0 });

  useEffect(() => {
    if (reducedMotion()) {
      setT(TOTAL);
      return;
    }
    let raf = 0;
    const tick = (now: number) => {
      const c = clockRef.current;
      const dt = c.last ? Math.min(now - c.last, 64) : 0;
      c.last = now;
      if (!paused) {
        if (c.t < TOTAL) c.t = Math.min(TOTAL, c.t + dt);
        else if ((c.hold += dt) > 3600) { c.t = 0; c.hold = 0; } // linger on the result, then loop
        setT(c.t);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); clockRef.current.last = 0; };
  }, [paused]);

  let acc = 0;
  const spans = STEPS.map((s) => ({ start: acc, end: (acc += s.ms) }));
  const idx = spans.findIndex((sp) => t < sp.end);
  const finished = idx === -1;
  const cur = finished ? STEPS.length - 1 : idx;
  const prog = finished ? 1 : (t - spans[cur].start) / STEPS[cur].ms;
  const gate = !finished && cur === 3;
  const approved = gate && prog > 0.6;
  const cost = (Math.max(0, Math.min(t, spans[2].end) - spans[2].start) / STEPS[2].ms) * 0.0021;
  const state = finished ? "Finished" : paused ? "Paused" : gate && !approved ? "Checking" : "Running";
  const Icon = STEPS[cur].icon;
  const doneRows = STEPS.map((s, i) => ({ ...s, i })).filter((s) => s.i < cur || finished).reverse();

  return (
    <div className={cn("rounded-[30px] bg-white/45 p-2.5 shadow-[0_30px_60px_-30px_rgba(17,17,17,0.35)] ring-1 ring-black/5 backdrop-blur", className)}>
      <div className="rounded-[22px] bg-card p-3.5 shadow-[0_0_0_1px_rgba(17,17,17,0.05)]">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-brand font-display text-base text-white">A</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm leading-tight font-medium">Atlas</p>
            <p className="truncate text-[11px] text-muted-foreground"><ZeroGText text="Momentum · LINK · qwen3.7 on 0G" /></p>
          </div>
          <span className="num text-xs font-medium">
            {finished || paused ? <ZeroGText text={`${cost.toFixed(4)} 0G`} /> : <AnimatedShinyText className="mx-0 inline max-w-none text-foreground/70"><ZeroGText text={`${cost.toFixed(4)} 0G`} /></AnimatedShinyText>}
          </span>
          <span className={cn("flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium", finished ? "bg-profit/10 text-profit" : state === "Checking" ? "bg-trade-soft text-trade-deep" : state === "Paused" ? "bg-muted text-muted-foreground" : "bg-brand-soft text-brand-hover")}>
            <span className={cn("size-1.5 rounded-full bg-current", state === "Running" && "pulse-soft")} /> {state}
          </span>
        </div>

        <div className="relative mt-3 overflow-hidden rounded-xl bg-muted px-3 py-2.5">
          {!finished && <div className="absolute inset-y-0 left-0 bg-brand/10" style={{ width: `${prog * 100}%` }} />}
          <div className="relative flex items-center gap-2.5 text-[13px]">
            <span className="flex size-6 items-center justify-center rounded-md bg-card ring-1 ring-border">
              {finished ? <Check className="size-3.5 text-profit" /> : <Icon className="size-3.5" strokeWidth={1.75} />}
            </span>
            <span key={finished ? "done" : cur} className="pop-in flex-1 truncate font-medium">{finished ? "Order live, signal committed" : <ZeroGText text={STEPS[cur].label} />}</span>
            <span className="num text-xs text-muted-foreground">{clock(finished ? TOTAL : t)}</span>
          </div>
        </div>

        <div className={cn("grid transition-[grid-template-rows,opacity,margin] duration-300 ease-out", gate ? "mt-2.5 grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
          <div className="overflow-hidden">
            <div className="rounded-xl border border-border px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[13px] font-medium">{approved ? "Approved on-chain" : "RiskGate is checking"}</p>
                {approved ? <Check className="pop-in size-4 text-profit" /> : <Loader2 className="size-4 animate-spin text-trade-deep" />}
              </div>
              <code className="mt-1.5 block truncate rounded-md bg-brand-soft px-2 py-1 font-mono text-[11px] text-brand-hover">approveOrder(LINK, $50, stop −8%)</code>
              <p className="mt-1.5 text-[11px] text-muted-foreground">{approved ? "Inside the $120 exposure budget" : "Deterministic: no human key can override"}</p>
            </div>
          </div>
        </div>

        <div className="mt-3 flex h-1 gap-1" aria-hidden>
          {STEPS.map((s, i) => (
            <div key={s.label} className="relative overflow-hidden rounded-full bg-muted" style={{ flexGrow: s.ms }}>
              <div className={cn("absolute inset-y-0 left-0 rounded-full", i === 3 ? "bg-trade" : "bg-brand")} style={{ width: `${i < cur || finished ? 100 : i === cur ? prog * 100 : 0}%` }} />
            </div>
          ))}
        </div>

        <ol className="mt-2 h-[84px] space-y-0.5 overflow-hidden" aria-label="Finished steps">
          {doneRows.slice(0, 3).map((s) => {
            const I = s.icon;
            return (
              <li key={s.label} className="pop-in flex items-center gap-2.5 rounded-lg px-1.5 py-1 text-[12.5px]">
                <span className="flex size-5 items-center justify-center rounded-md bg-muted"><I className="size-3" strokeWidth={1.75} /></span>
                <span className="flex-1 truncate"><ZeroGText text={s.done} /></span>
                <span className="num text-[11px] text-muted-foreground">{fmtS(s.ms)}</span>
              </li>
            );
          })}
          {doneRows.length === 0 && <li className="px-1.5 py-1 text-[12.5px] text-faint">No steps finished yet</li>}
        </ol>

        <div className="mt-2 flex items-center gap-1.5 border-t border-border/70 pt-2.5">
          <button onClick={() => setPaused((p) => !p)} disabled={finished} className="flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-[11px] font-medium transition-colors hover:bg-hover disabled:opacity-40">
            {paused ? <Play className="size-3" /> : <Pause className="size-3" />} {paused ? "Resume" : "Pause"}
          </button>
          <button onClick={() => { clockRef.current.t = 0; clockRef.current.hold = 0; setT(0); setPaused(false); }} className="flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-[11px] font-medium transition-colors hover:bg-hover">
            <RotateCcw className="size-3" /> Replay
          </button>
          <span className="num ml-auto text-[11px] text-muted-foreground">{finished ? STEPS.length : cur}/{STEPS.length}</span>
          <span className="micro text-faint">Example</span>
        </div>
      </div>
    </div>
  );
}

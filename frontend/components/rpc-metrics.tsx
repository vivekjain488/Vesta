"use client";
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SHADE, hourBars, latencyShade, niceMax, type HourBar, type RpcSample } from "@/lib/rpc-metrics";
import { cn } from "@/lib/utils";

/** A coloured figure with a hover explanation. `plain` drops the dotted underline (for pills). */
export function ShadeTip({ color, tip, children, plain }: { color?: string; tip: string; children: ReactNode; plain?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("cursor-help", !plain && "underline decoration-dotted decoration-current/40 underline-offset-4")} style={color ? { color } : undefined}>{children}</span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[240px] items-start text-left leading-snug">{tip}</TooltipContent>
    </Tooltip>
  );
}

function barTitle(bar: HourBar) {
  const when = new Date(bar.start).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" });
  if (!bar.count) return `${when}: no probes`;
  if (bar.successes === bar.count) return `${when}: all ${bar.count} probes passed`;
  if (bar.successes === 0) return `${when}: all ${bar.count} probes failed`;
  return `${when}: ${bar.successes}/${bar.count} probes passed`;
}

/** One slim bar per hour: green all passed, amber some failed, red all failed, gray not probed. */
export function UptimeStrip({ samples, now, hours = 24, className = "" }: { samples: RpcSample[]; now: number; hours?: number; className?: string }) {
  const bars = hourBars(samples, now, hours);
  return (
    <div className={cn("flex h-3 items-stretch gap-[2px]", className)} role="img" aria-label={`${hours} hour uptime, empty slots have no probes`}>
      {bars.map((bar) => <span key={bar.start} title={barTitle(bar)} className="min-w-0 flex-1 rounded-[2px] transition-opacity duration-150 hover:opacity-70" style={{ background: bar.color }} />)}
    </div>
  );
}

const gapLimit = (windowMs: number) => (windowMs <= 3600_000 ? 10 * 60_000 : 2 * 3600_000 + 60_000);

/** Compact latency trend for a table row. */
export function RpcMetrics({ samples, now, windowMs }: { samples: RpcSample[]; now: number; windowMs: number }) {
  const W = 128, H = 34, padX = 4, padY = 6, start = now - windowMs;
  const visible = samples.filter((s) => s.at >= start && s.at <= now);
  const ok = visible.filter((s) => s.ok);
  const failed = visible.filter((s) => !s.ok);
  if (!visible.length) return <div className="flex h-[34px] w-32 items-center" aria-label="No samples"><span className="h-px flex-1 border-t border-dashed border-border" /></div>;
  const max = niceMax(Math.max(100, ...ok.map((s) => s.latencyMs)));
  const x = (at: number) => padX + ((at - start) / windowMs) * (W - 2 * padX);
  const y = (ms: number) => H - padY - Math.min(1, ms / max) * (H - 2 * padY);
  const last = ok.at(-1);
  const lastColor = last ? latencyShade(last.latencyMs, true).color : SHADE.none;
  return (
    <svg role="img" aria-label={`Latency over the past ${windowMs <= 3600_000 ? "30 minutes" : "24 hours"}, ${ok.length} successful samples, ${failed.length} failed`} viewBox={`0 0 ${W} ${H}`} className="h-[34px] w-32 overflow-visible">
      <line x1={padX} x2={W - padX} y1={H - padY} y2={H - padY} stroke="currentColor" opacity="0.1" />
      {ok.map((s, i) => i && s.at - ok[i - 1].at <= gapLimit(windowMs)
        ? <line key={`l${s.at}`} x1={x(ok[i - 1].at)} y1={y(ok[i - 1].latencyMs)} x2={x(s.at)} y2={y(s.latencyMs)} stroke={latencyShade(s.latencyMs, true).color} strokeWidth="1.6" strokeLinecap="round" opacity="0.85" />
        : null)}
      {ok.map((s) => <circle key={`d${s.at}`} cx={x(s.at)} cy={y(s.latencyMs)} r={s === last ? 3 : 1.8} fill={latencyShade(s.latencyMs, true).color}><title>{new Date(s.at).toLocaleString()}: {s.latencyMs} ms</title></circle>)}
      {failed.map((s) => <circle key={`f${s.at}`} cx={x(s.at)} cy={padY} r="2.4" fill="none" stroke={SHADE.bad} strokeWidth="1.4"><title>{new Date(s.at).toLocaleString()}: failed ({s.outcome?.replaceAll("_", " ") ?? "no answer"})</title></circle>)}
      {last && <circle cx={x(last.at)} cy={y(last.latencyMs)} r="6" fill={lastColor} opacity="0.18" className="pulse-soft" />}
    </svg>
  );
}

/** Larger latency chart for the detail panel: threshold guides, coloured points, hover titles. */
export function LatencyChart({ samples, now, hours = 24 }: { samples: RpcSample[]; now: number; hours?: number }) {
  const W = 400, H = 132, left = 40, right = 8, top = 10, bottom = 20, windowMs = hours * 3600_000, start = now - windowMs;
  const visible = samples.filter((s) => s.at >= start && s.at <= now);
  const ok = visible.filter((s) => s.ok);
  const failed = visible.filter((s) => !s.ok);
  if (!visible.length) return <div className="flex h-[132px] items-center justify-center rounded-2xl bg-muted/60 text-xs text-muted-foreground">No samples yet</div>;
  const max = niceMax(Math.max(100, ...ok.map((s) => s.latencyMs)));
  const x = (at: number) => left + ((at - start) / windowMs) * (W - left - right);
  const y = (ms: number) => H - bottom - Math.min(1, ms / max) * (H - top - bottom);
  const guides = [{ ms: 100, color: SHADE.good }, { ms: 300, color: SHADE.warn }, { ms: 1000, color: SHADE.bad }].filter((g) => g.ms < max);
  return (
    <svg role="img" aria-label={`Latency over the past ${hours} hours`} viewBox={`0 0 ${W} ${H}`} className="w-full overflow-visible">
      {[0, max / 2, max].map((v) => (
        <g key={v}>
          <line x1={left} x2={W - right} y1={y(v)} y2={y(v)} stroke="currentColor" opacity={v === 0 ? 0.18 : 0.07} />
          <text x={left - 6} y={y(v) + 3} textAnchor="end" className="fill-muted-foreground" style={{ fontSize: 9 }}>{v >= 1000 ? `${v / 1000}s` : `${Math.round(v)}`}</text>
        </g>
      ))}
      {guides.map((g) => <line key={g.ms} x1={left} x2={W - right} y1={y(g.ms)} y2={y(g.ms)} stroke={g.color} strokeDasharray="3 4" opacity="0.35" />)}
      {ok.map((s, i) => i && s.at - ok[i - 1].at <= gapLimit(windowMs)
        ? <line key={`l${s.at}`} x1={x(ok[i - 1].at)} y1={y(ok[i - 1].latencyMs)} x2={x(s.at)} y2={y(s.latencyMs)} stroke={latencyShade(s.latencyMs, true).color} strokeWidth="1.8" strokeLinecap="round" opacity="0.8" />
        : null)}
      {ok.map((s) => <circle key={`d${s.at}`} cx={x(s.at)} cy={y(s.latencyMs)} r="3" fill={latencyShade(s.latencyMs, true).color} className="transition-[r] duration-150 hover:[r:5px]"><title>{new Date(s.at).toLocaleString()}: {s.latencyMs} ms</title></circle>)}
      {failed.map((s) => <circle key={`f${s.at}`} cx={x(s.at)} cy={top} r="3.2" fill="none" stroke={SHADE.bad} strokeWidth="1.6"><title>{new Date(s.at).toLocaleString()}: failed ({s.outcome?.replaceAll("_", " ") ?? "no answer"})</title></circle>)}
      <text x={left} y={H - 4} className="fill-muted-foreground" style={{ fontSize: 9 }}>{hours}h ago</text>
      <text x={W - right} y={H - 4} textAnchor="end" className="fill-muted-foreground" style={{ fontSize: 9 }}>now</text>
    </svg>
  );
}

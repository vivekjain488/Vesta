"use client";
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { availabilityShade, hourBars, latencyShade, rollingAvailability, type HourBar, type RpcSample } from "@/lib/rpc-metrics";

type Point = { at: number; value: number; count?: number; color?: string };

function MiniGraph({ title, points, now, max, unit, count, windowMs }: { title: string; points: Point[]; now: number; max: number; unit: string; count: number; windowMs: number }) {
  const width = 200, height = 56, left = 4, right = 4, top = 5, bottom = 5, start = now - windowMs;
  const x = (at: number) => left + Math.max(0, Math.min(1, (at - start) / (now - start))) * (width - left - right);
  const y = (value: number) => height - bottom - Math.max(0, Math.min(1, value / max)) * (height - top - bottom);
  return <div className="min-w-[200px] max-w-[220px]">
    <div className="flex justify-between gap-2 text-[10px] text-muted-foreground"><span>{title}</span><span>{count} {count === 1 ? "sample" : "samples"} · 0–{max}{unit}</span></div>
    {points.length ? <svg role="img" aria-label={`${title} over the past ${windowMs === 1800000 ? "30 minutes" : "24 hours"}, ${count} samples`} viewBox={`0 0 ${width} ${height}`} className="mt-1 h-14 w-full overflow-visible rounded-lg bg-muted/50">
      <line x1={left} x2={width - right} y1={y(0)} y2={y(0)} stroke="currentColor" opacity="0.15" />
      {points.map((point, i) => i && point.at - points[i - 1].at <= 2 * 3600_000 ? <line key={`l${point.at}`} x1={x(points[i - 1].at)} y1={y(points[i - 1].value)} x2={x(point.at)} y2={y(point.value)} stroke={point.color ?? "currentColor"} opacity="0.8" strokeWidth="1.5" className="transition-all duration-700 motion-reduce:transition-none" /> : null)}
      {points.map((point, i) => <circle key={`${point.at}-${i}`} cx={x(point.at)} cy={y(point.value)} r="2.8" fill={point.color ?? "currentColor"} className="transition-all duration-700 motion-reduce:transition-none"><title>{new Date(point.at).toLocaleString()}: {point.value}{unit}{point.count ? ` (${point.count} checks)` : ""}</title></circle>)}
    </svg> : <div className="mt-1 flex h-14 items-center justify-center rounded-lg bg-muted/50 text-[10px] text-muted-foreground">No {title.toLowerCase()} samples yet</div>}
    <div className="mt-1 flex justify-between text-[10px] text-faint"><span>{windowMs === 1800000 ? "30m ago" : "24h ago"}</span><span>now</span></div>
  </div>;
}

export function ShadeTip({ color, tip, children }: { color?: string; tip: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help underline decoration-dotted decoration-current/40 underline-offset-4" style={color ? { color } : undefined}>{children}</span>
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

export function UptimeStrip({ samples, now, hours = 24, className = "" }: { samples: RpcSample[]; now: number; hours?: number; className?: string }) {
  const bars = hourBars(samples, now, hours);
  return (
    <div className={`flex h-3 items-stretch gap-px ${className}`} role="img" aria-label={`${hours} hour uptime, empty slots have no probes`}>
      {bars.map((bar) => <span key={bar.start} title={barTitle(bar)} className="min-w-0 flex-1 rounded-[1px]" style={{ background: bar.color }} />)}
    </div>
  );
}

export function RpcMetrics({ samples, now, windowMs }: { samples: RpcSample[]; now: number; windowMs: number }) {
  const visible = samples.filter((s) => s.at >= now - windowMs);
  const latency = visible.filter((s) => s.ok).map((s) => ({ at: s.at, value: s.latencyMs, color: latencyShade(s.latencyMs, true).color }));
  const availability = rollingAvailability(samples).filter((s) => s.at >= now - windowMs).map((point) => ({ ...point, color: availabilityShade(point.value).color }));
  return <div className="flex gap-4 text-foreground"><MiniGraph title="Latency (ms)" points={latency} now={now} max={Math.max(100, ...latency.map((p) => p.value))} unit=" ms" count={latency.length} windowMs={windowMs} /><MiniGraph title="Availability · 1h (%)" points={availability} now={now} max={100} unit="%" count={visible.length} windowMs={windowMs} /></div>;
}

"use client";
import { rollingAvailability, type RpcSample } from "@/lib/rpc-metrics";

type Point = { at: number; value: number; count?: number };
function MiniGraph({ title, points, now, max, unit, count, windowMs }: { title: string; points: Point[]; now: number; max: number; unit: string; count: number; windowMs: number }) {
  const width = 200, height = 56, left = 4, right = 4, top = 5, bottom = 5, start = now - windowMs;
  const x = (at: number) => left + Math.max(0, Math.min(1, (at - start) / (now - start))) * (width - left - right);
  const y = (value: number) => height - bottom - Math.max(0, Math.min(1, value / max)) * (height - top - bottom);
  return <div className="min-w-[200px] max-w-[220px]">
    <div className="flex justify-between gap-2 text-[10px] text-muted-foreground"><span>{title}</span><span>{count} {count === 1 ? "sample" : "samples"} · 0–{max}{unit}</span></div>
    {points.length ? <svg role="img" aria-label={`${title} over the past ${windowMs === 1800000 ? "30 minutes" : "24 hours"}, ${count} samples`} viewBox={`0 0 ${width} ${height}`} className="mt-1 h-14 w-full overflow-visible rounded-lg bg-muted/50">
      <line x1={left} x2={width-right} y1={y(0)} y2={y(0)} stroke="currentColor" opacity="0.15" />
      {points.map((point, i) => i && point.at - points[i-1].at <= 2 * 3600_000 ? <line key={`l${point.at}`} x1={x(points[i-1].at)} y1={y(points[i-1].value)} x2={x(point.at)} y2={y(point.value)} stroke="currentColor" opacity="0.65" strokeWidth="1.5" className="transition-all duration-700 motion-reduce:transition-none" /> : null)}
      {points.map((point, i) => <circle key={`${point.at}-${i}`} cx={x(point.at)} cy={y(point.value)} r="2.8" fill="currentColor" className="transition-all duration-700 motion-reduce:transition-none"><title>{new Date(point.at).toLocaleString()}: {point.value}{unit}{point.count ? ` (${point.count} checks)` : ""}</title></circle>)}
    </svg> : <div className="mt-1 flex h-14 items-center justify-center rounded-lg bg-muted/50 text-[10px] text-muted-foreground">No {title.toLowerCase()} samples yet</div>}
    <div className="mt-1 flex justify-between text-[10px] text-faint"><span>{windowMs === 1800000 ? "30m ago" : "24h ago"}</span><span>now</span></div>
  </div>;
}
export function RpcMetrics({ samples, now, windowMs }: { samples: RpcSample[]; now: number; windowMs: number }) {
  const visible = samples.filter((s) => s.at >= now - windowMs);
  const latency = visible.filter((s) => s.ok).map((s) => ({ at: s.at, value: s.latencyMs }));
  const availability = rollingAvailability(samples).filter((s) => s.at >= now - windowMs);
  return <div className="flex gap-4 text-foreground"><MiniGraph title="Latency (ms)" points={latency} now={now} max={Math.max(100, ...latency.map((p) => p.value))} unit=" ms" count={latency.length} windowMs={windowMs} /><MiniGraph title="Availability · 1h (%)" points={availability} now={now} max={100} unit="%" count={visible.length} windowMs={windowMs} /></div>;
}

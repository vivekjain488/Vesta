export type RpcSample = { at: number; ok: boolean; latencyMs: number; outcome?: string; httpStatus?: number };
export type Band = "good" | "warn" | "bad" | "none";
export type Shade = { color: string; label: string; band: Band };

export const SHADE = {
  goodDeep: "#0e7a4e",
  good: "#16a36a",
  warn: "#d4a017",
  warnDeep: "#e07a2f",
  bad: "#e35d5b",
  none: "#b5b5b2",
  empty: "#e4e4e2",
} as const;

export function samplesForDisplay(history: RpcSample[] | undefined, latest?: RpcSample, now = Date.now()): RpcSample[] {
  const byTime = new Map<number, RpcSample>();
  for (const sample of [...(history ?? []), ...(latest ? [latest] : [])]) {
    if (Number.isFinite(sample.at) && sample.at >= now - 24 * 3600_000 && sample.at <= now && Number.isFinite(sample.latencyMs) && sample.latencyMs >= 0 && typeof sample.ok === "boolean") {
      byTime.set(sample.at, { at: sample.at, ok: sample.ok, latencyMs: sample.latencyMs, outcome: sample.outcome, httpStatus: sample.httpStatus });
    }
  }
  return [...byTime.values()].sort((a, b) => a.at - b.at);
}
/** Success ratio in each UTC hour with actual probes; missing hours remain absent, not 0%. */
export function hourlyAvailability(samples: RpcSample[]) {
  const buckets = new Map<number, { successes: number; count: number; lastAt: number }>();
  for (const sample of samples) { const hour = Math.floor(sample.at / 3600_000) * 3600_000; const b = buckets.get(hour) ?? { successes: 0, count: 0, lastAt: sample.at }; b.lastAt = Math.max(b.lastAt, sample.at); b.count++; if (sample.ok) b.successes++; buckets.set(hour, b); }
  return [...buckets].sort(([a], [b]) => a - b).map(([at, b]) => ({ at: b.lastAt, value: Math.round(b.successes * 10000 / b.count) / 100, count: b.count }));
}

/** A one-hour rolling success ratio, evaluated only at actual observations. */
export function rollingAvailability(samples: RpcSample[], windowMs = 3600_000) {
  let first = 0, successes = 0;
  return samples.map((sample, index) => {
    if (sample.ok) successes++;
    while (first < index && samples[first].at < sample.at - windowMs) { if (samples[first].ok) successes--; first++; }
    const count = index - first + 1;
    return { at: sample.at, value: Math.round(successes * 10000 / count) / 100, count };
  });
}

export function latencyShade(ms: number | null | undefined, ok = true): Shade {
  if (ms == null || !Number.isFinite(ms)) return { color: SHADE.none, label: "No sample", band: "none" };
  if (!ok) return { color: SHADE.bad, label: "Failed", band: "bad" };
  if (ms < 100) return { color: SHADE.goodDeep, label: "Fast", band: "good" };
  if (ms < 300) return { color: SHADE.good, label: "Good", band: "good" };
  if (ms < 1000) return { color: SHADE.warn, label: "Slow", band: "warn" };
  return { color: SHADE.bad, label: "Very slow", band: "bad" };
}

export function availabilityShade(percent: number | null | undefined): Shade {
  if (percent == null || !Number.isFinite(percent)) return { color: SHADE.none, label: "No samples", band: "none" };
  if (percent >= 99.5) return { color: SHADE.goodDeep, label: "Strong", band: "good" };
  if (percent >= 99) return { color: SHADE.good, label: "Good", band: "good" };
  if (percent >= 97) return { color: SHADE.warn, label: "Mixed", band: "warn" };
  if (percent >= 95) return { color: SHADE.warnDeep, label: "Degraded", band: "warn" };
  return { color: SHADE.bad, label: "Weak", band: "bad" };
}

export function httpShade(status: number | null | undefined): Shade {
  if (status == null) return { color: SHADE.none, label: "No response", band: "none" };
  if (status >= 200 && status < 300) return { color: SHADE.good, label: "OK", band: "good" };
  if (status === 429) return { color: SHADE.warn, label: "Rate limited", band: "warn" };
  return { color: SHADE.bad, label: "HTTP error", band: "bad" };
}

export function lagShade(blocks: number | null | undefined): Shade {
  if (blocks == null || !Number.isFinite(blocks)) return { color: SHADE.none, label: "No peer sample", band: "none" };
  if (blocks <= 2) return { color: SHADE.good, label: "Synced", band: "good" };
  if (blocks <= 10) return { color: SHADE.warn, label: "Behind", band: "warn" };
  return { color: SHADE.bad, label: "Stuck", band: "bad" };
}

export function headShade(ageSec: number | null | undefined): Shade {
  if (ageSec == null || !Number.isFinite(ageSec)) return { color: SHADE.none, label: "Unknown", band: "none" };
  if (ageSec <= 30) return { color: SHADE.good, label: "Fresh", band: "good" };
  if (ageSec <= 120) return { color: SHADE.warn, label: "Aging", band: "warn" };
  return { color: SHADE.bad, label: "Stale", band: "bad" };
}

export function percentile(values: number[], p: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function windowStats(samples: RpcSample[], windowMs: number, now = Date.now()) {
  const windowed = samples.filter((sample) => sample.at <= now && sample.at >= now - windowMs);
  const successes = windowed.filter((sample) => sample.ok);
  const latencies = successes.map((sample) => sample.latencyMs);
  return {
    sampleCount: windowed.length,
    successfulSamples: successes.length,
    availability: windowed.length ? Math.round(successes.length * 10000 / windowed.length) / 100 : null,
    medianLatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
  };
}

export type HourBar = { start: number; successes: number; count: number; color: string };

/** One slot per hour. Hours with no probes stay empty rather than counting as downtime. */
export function hourBars(samples: RpcSample[], now = Date.now(), hours = 24): HourBar[] {
  const hour = 3600_000;
  const end = Math.floor(now / hour) * hour;
  const bars: HourBar[] = [];
  for (let i = hours - 1; i >= 0; i--) {
    const start = end - i * hour;
    const inHour = samples.filter((sample) => sample.at >= start && sample.at < start + hour);
    const successes = inHour.filter((sample) => sample.ok).length;
    const count = inHour.length;
    const ratio = count ? successes / count : null;
    const color = ratio === null ? SHADE.empty : ratio === 1 ? SHADE.good : ratio === 0 ? SHADE.bad : ratio >= 0.5 ? SHADE.warn : SHADE.warnDeep;
    bars.push({ start, successes, count, color });
  }
  return bars;
}

export function errorBreakdown(samples: RpcSample[]) {
  const buckets = new Map<string, number>();
  for (const sample of samples) {
    if (sample.ok) continue;
    const key = sample.outcome ?? (sample.httpStatus ? `http_${sample.httpStatus}` : "failed");
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  const failed = [...buckets.values()].reduce((sum, count) => sum + count, 0);
  return { failed, total: samples.length, rows: [...buckets.entries()].sort((a, b) => b[1] - a[1]).map(([outcome, count]) => ({ outcome, count })) };
}

export function rateLimitHint(samples: RpcSample[]): { level: "low" | "medium" | "high" | "unknown"; limited: number; total: number } {
  if (!samples.length) return { level: "unknown", limited: 0, total: 0 };
  const limited = samples.filter((sample) => sample.outcome === "rate_limited" || sample.httpStatus === 429).length;
  const ratio = limited / samples.length;
  return { level: limited === 0 ? "low" : ratio < 0.1 ? "medium" : "high", limited, total: samples.length };
}

export const LATENCY_TIP = "Under 100 ms is fast, under 300 ms is good, under 1 second is slow, and slower than that is a poor answer time. Failed probes stay red.";
export const AVAILABILITY_TIP = "99% and above is strong, 95% to 99% is mixed, and below 95% is weak. This is successful probes divided by probes we actually made, not a promise of continuous uptime.";

/** "12s ago", "4m ago", "3h ago", "2d ago". */
export function timeAgo(at: number, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Round a latency axis maximum up to a readable value. */
export function niceMax(ms: number) {
  for (const step of [100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000]) if (ms <= step) return step;
  return Math.ceil(ms / 5000) * 5000;
}

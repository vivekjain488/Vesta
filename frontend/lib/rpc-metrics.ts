export type RpcSample = { at: number; ok: boolean; latencyMs: number };
export function samplesForDisplay(history: RpcSample[] | undefined, latest?: RpcSample, now = Date.now()): RpcSample[] {
  const byTime = new Map<number, RpcSample>();
  for (const sample of [...(history ?? []), ...(latest ? [latest] : [])]) {
    if (Number.isFinite(sample.at) && sample.at >= now - 24 * 3600_000 && sample.at <= now && Number.isFinite(sample.latencyMs) && sample.latencyMs >= 0 && typeof sample.ok === "boolean") byTime.set(sample.at, sample);
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

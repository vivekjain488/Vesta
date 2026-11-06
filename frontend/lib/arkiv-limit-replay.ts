/** A deterministic, isolated demonstration; it never submits to Flash or invokes a model. */
export type ArkivRow = { entityKey: string; publishedAtMs: number; data: { symbol: string; book: { bids: [string, string][]; asks: [string, string][] } } };
export type PaperLimit = { id: string; at: number; resultAt: number; side: "buy" | "sell"; limit: number; observedMid: number; previousMid: number; status: "paper fill" | "expired unfilled"; fillPrice?: number; fee?: number; notional: number; sourceKey: string; resultKey: string };

export function replayLimits(input: ArkivRow[]): PaperLimit[] {
  const rows = input.map((r) => ({ ...r, bid: Number(r.data?.book?.bids?.[0]?.[0]), ask: Number(r.data?.book?.asks?.[0]?.[0]) }))
    .filter((r) => r.entityKey && Number.isFinite(r.publishedAtMs) && r.publishedAtMs > 0 && r.bid > 0 && r.ask >= r.bid)
    .sort((a, b) => a.publishedAtMs - b.publishedAtMs)
    .filter((r, i, sorted) => i === 0 || r.publishedAtMs > sorted[i - 1].publishedAtMs);
  if (rows.length < 3) return [];
  let cash = 50000; let btc = 50000 / ((rows[0].bid + rows[0].ask) / 2);
  const result: PaperLimit[] = [];
  for (let i = 1; i < rows.length - 1; i++) {
    const prev = (rows[i - 1].bid + rows[i - 1].ask) / 2;
    const current = (rows[i].bid + rows[i].ask) / 2;
    if (current === prev) continue;
    const side = current > prev ? "buy" : "sell";
    const limit = side === "buy" ? rows[i].ask : rows[i].bid;
    // Stable per observation, so the same Arkiv data always gives the same replay.
    let hash = 2166136261;
    for (const c of rows[i].entityKey) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
    const notional = 1000 + (hash >>> 0) % 4001;
    if ((side === "buy" && cash < notional * 1.001) || (side === "sell" && btc * limit < notional)) continue;
    const next = rows[i + 1];
    const price = side === "buy" ? next.ask : next.bid;
    const fills = side === "buy" ? price <= limit : price >= limit;
    const fee = notional * 0.001;
    if (fills) {
      if (side === "buy") { cash -= notional + fee; btc += notional / price; }
      else { btc -= notional / price; cash += notional - fee; }
    }
    result.push({ id: `${rows[i].entityKey}-${side}`, at: rows[i].publishedAtMs, resultAt: next.publishedAtMs, side, limit, observedMid: current, previousMid: prev, status: fills ? "paper fill" : "expired unfilled", ...(fills ? { fillPrice: price, fee } : {}), notional, sourceKey: rows[i].entityKey, resultKey: next.entityKey });
  }
  return result.reverse();
}

type Snapshot = { publishedAtMs: number; data: { observedAtMs: number; sourceAtMs: number; book: { bids: string[][]; asks: string[][] } } };
/** Select only observations already visible on Arkiv, spaced far enough for delayed fills. */
export function selectReplaySnapshots<T extends Snapshot>(rows: T[], count = 4): T[] {
  const valid = rows.filter(r => Number.isFinite(r.publishedAtMs) && r.publishedAtMs >= r.data.observedAtMs && r.data.sourceAtMs <= r.data.observedAtMs && r.publishedAtMs - r.data.sourceAtMs <= 120000 && Number(r.data.book.bids[0]?.[0]) > 0 && Number(r.data.book.asks[0]?.[0]) >= Number(r.data.book.bids[0]?.[0])).sort((a,b) => b.publishedAtMs - a.publishedAtMs);
  const selected: T[] = [];
  for (const row of valid) if (!selected.length || selected.at(-1)!.publishedAtMs - row.publishedAtMs >= 30000) selected.push(row);
  return selected.slice(0, count).reverse();
}
export function paperFill(side: 'buy' | 'sell' | 'hold', requested: number, cash: number, qty: number, nextBid: number, nextAsk: number) {
  if (side === 'hold') return null;
  const price = side === 'buy' ? nextAsk : nextBid;
  const amount = Math.min(requested, side === 'buy' ? cash / 1.001 : qty * price);
  if (amount < 1) return null;
  const fee = amount * .001;
  return { price, amount, fee, cash: side === 'buy' ? cash - amount - fee : cash + amount - fee, qty: side === 'buy' ? qty + amount / price : qty - amount / price };
}

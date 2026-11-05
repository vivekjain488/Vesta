/** Free public market data: 4h OHLCV (Kraken, Binance fallback), perp funding (Binance), headlines (RSS). */
import type { Bar } from "@perpetua/core";

export async function fetchBars4h(opts: { krakenPair: string; binanceSymbol: string; source?: "kraken" | "binance" | "synthetic"; limit?: number }): Promise<Bar[]> {
  const limit = opts.limit ?? 400;
  // deterministic: the same series (and last price) whatever `limit` the caller asks for
  if (opts.source === "synthetic") return syntheticBars(Math.max(limit, 400)).slice(-limit);
  if (opts.source !== "binance") {
    try {
      const r = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${opts.krakenPair}&interval=240`);
      const j: any = await r.json();
      const key = Object.keys(j.result ?? {}).find((k) => k !== "last");
      if (key) {
        return (j.result[key] as any[]).slice(-limit).map((x) => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[6] }));
      }
    } catch {
      /* fall through */
    }
  }
  const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${opts.binanceSymbol}&interval=4h&limit=${Math.min(limit, 1000)}`);
  const j: any[] = await r.json();
  return j.map((x) => ({ t: Math.floor(x[0] / 1000), o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] }));
}

/** Paged history for backtests (Binance klines, up to `bars` 4h candles). */
export async function fetchHistory4h(binanceSymbol: string, bars = 2190): Promise<Bar[]> {
  const out: Bar[] = [];
  let end = Date.now();
  while (out.length < bars) {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=4h&limit=1000&endTime=${end}`);
    const j: any[] = await r.json();
    if (!Array.isArray(j) || j.length === 0) break;
    out.unshift(...j.map((x) => ({ t: Math.floor(x[0] / 1000), o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] })));
    end = j[0][0] - 1;
  }
  return out.slice(-bars);
}

export async function fundingRate8h(binanceSymbol: string): Promise<number | undefined> {
  try {
    const r = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${binanceSymbol}`);
    const j: any = await r.json();
    return j.lastFundingRate ? Number(j.lastFundingRate) : undefined;
  } catch {
    return undefined;
  }
}

export async function headlines(asset: string, max = 12): Promise<string[]> {
  const feeds = ["https://www.coindesk.com/arc/outboundfeeds/rss/", "https://cointelegraph.com/rss"];
  const titles: string[] = [];
  for (const f of feeds) {
    try {
      const xml = await (await fetch(f)).text();
      for (const m of xml.matchAll(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/g)) titles.push(m[1]);
    } catch {
      /* ignore a dead feed */
    }
  }
  const names = { LINK: ["chainlink", "link"], ETH: ["ethereum", "eth"], cbBTC: ["bitcoin", "btc"] }[asset] ?? [asset.toLowerCase()];
  const relevant = titles.filter((t) => names.some((n) => t.toLowerCase().includes(n)));
  return (relevant.length ? relevant : titles.slice(1)).slice(0, max);
}

/** Deterministic random walk for offline demos and tests. */
export function syntheticBars(n: number, start = 15, drift = 0.0015, seed = 7): Bar[] {
  let x = seed;
  const rand = () => ((x = (x * 16807) % 2147483647) / 2147483647) - 0.5;
  const now = 1_790_000_000; // fixed anchor so every process sees the same synthetic market
  let p = start;
  return Array.from({ length: n }, (_, i) => {
    const o = p;
    p = p * (1 + drift + rand() * 0.03);
    return { t: now - (n - i) * 14400, o, h: Math.max(o, p) * 1.006, l: Math.min(o, p) * 0.994, c: p, v: 5000 + rand() * 1000 };
  });
}

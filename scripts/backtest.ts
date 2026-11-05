/**
 * Honest backtest of the deterministic rules (no LLM: sentiment factor = 0, which can only make entries rarer).
 * A year of 4h bars, bracket exits (SL 2xATR, TP 4xATR), after costs. If a bar touches both stop and target,
 * the STOP is assumed to fill first (conservative). Reports win rate, average R, max drawdown, Sharpe.
 *
 *   pnpm backtest                  # LINK + ETH, 2190 bars (1y), momentum
 *   pnpm backtest -- --kind=mean-reversion --bars=4380 --cost=0.004
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { generateSignal, type Bar, type StrategyKind } from "@perpetua/core";
import { fetchHistory4h, syntheticBars } from "../agent/src/market";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const kind = arg("kind", "momentum") as StrategyKind;
const nBars = Number(arg("bars", "2190"));
const cost = Number(arg("cost", "0.004")); // round trip: Flash 10bps x2 + slippage + gas, decimal
const WINDOW = 400;

interface Trade {
  asset: string;
  entryT: number;
  exitT: number;
  entry: number;
  exit: number;
  r: number;
  ret: number;
  reason: "stop" | "target" | "timeout";
}

function run(asset: string, bars: Bar[], btc?: Bar[], eth?: Bar[]): Trade[] {
  const trades: Trade[] = [];
  let i = 220;
  while (i < bars.length - 1) {
    const hist = bars.slice(Math.max(0, i + 1 - WINDOW), i + 1);
    const align = (o?: Bar[]) => (o && o.length === bars.length ? o.slice(Math.max(0, i + 1 - WINDOW), i + 1) : undefined);
    const s = generateSignal({ asset, bars: hist, btcBars: align(btc), ethBars: align(eth), sentiment: null }, { kind, roundTripCostPct: cost });
    if (s.direction !== "long") {
      i++;
      continue;
    }
    const entry = bars[i + 1].o; // fill at next bar open
    const risk = s.entry - s.stop;
    const stop = entry - risk;
    const target = entry + 2 * risk;
    let j = i + 1;
    let exit = 0;
    let reason: Trade["reason"] = "timeout";
    for (; j < Math.min(bars.length, i + 1 + 90); j++) {
      const b = bars[j];
      if (b.l <= stop) {
        exit = Math.min(stop, b.o); // gap-through fills at the open
        reason = "stop";
        break;
      }
      if (b.h >= target) {
        exit = target;
        reason = "target";
        break;
      }
    }
    if (!exit) exit = bars[Math.min(j, bars.length - 1)].c;
    const ret = exit / entry - 1 - cost;
    trades.push({ asset, entryT: bars[i + 1].t, exitT: bars[Math.min(j, bars.length - 1)].t, entry, exit, r: (exit - entry - cost * entry) / risk, ret, reason });
    i = j + 1;
  }
  return trades;
}

function stats(trades: Trade[]) {
  const n = trades.length;
  const wins = trades.filter((t) => t.ret > 0).length;
  const avgR = n ? trades.reduce((s, t) => s + t.r, 0) / n : 0;
  // equity: risk 10% of a cushion per trade => fixed fractional on R
  let eq = 1;
  let peak = 1;
  let mdd = 0;
  const perTrade: number[] = [];
  for (const t of trades) {
    const r = 0.1 * t.r * 0.1; // 10% of cushion at risk, cushion ~10% of NAV => 1% NAV per R
    perTrade.push(r);
    eq *= 1 + r;
    peak = Math.max(peak, eq);
    mdd = Math.max(mdd, (peak - eq) / peak);
  }
  const mean = perTrade.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const sd = Math.sqrt(perTrade.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const years = n ? (trades[n - 1].exitT - trades[0].entryT) / (365 * 86400) : 1;
  // Sharpe is meaningless on a handful of trades: report null below 5.
  const sharpe = n >= 5 && sd > 0 ? (mean / sd) * Math.sqrt(n / Math.max(years, 1e-9)) : null;
  return { trades: n, winRate: n ? wins / n : 0, avgR, totalReturnNav: eq - 1, maxDrawdownNav: mdd, sharpe, stops: trades.filter((t) => t.reason === "stop").length, targets: trades.filter((t) => t.reason === "target").length };
}

const live = !process.argv.includes("--synthetic");
const load = async (sym: string) => (live ? fetchHistory4h(sym, nBars) : syntheticBars(nBars));
const [link, eth, btc] = await Promise.all([load("LINKUSDT"), load("ETHUSDT"), load("BTCUSDT")]).catch(async (e) => {
  console.warn(`market data unavailable (${(e as Error).message}); using synthetic bars`);
  return [syntheticBars(nBars, 15), syntheticBars(nBars, 3000, 0.001, 11), syntheticBars(nBars, 60000, 0.001, 13)];
});

const tLink = run("LINK", link, btc, eth);
const tEth = run("ETH", eth, btc, undefined);
const all = [...tLink, ...tEth].sort((a, b) => a.entryT - b.entryT);
const report = {
  kind,
  bars: nBars,
  costRoundTrip: cost,
  period: link.length ? `${new Date(link[0].t * 1000).toISOString().slice(0, 10)} -> ${new Date(link[link.length - 1].t * 1000).toISOString().slice(0, 10)}` : "",
  LINK: stats(tLink),
  ETH: stats(tEth),
  combined: stats(all),
  note: "Rules only (sentiment factor 0). Stop assumed first when a bar spans both levels. Modest and honest beats a hockey stick.",
};
mkdirSync(".perpetua", { recursive: true });
writeFileSync(".perpetua/backtest.json", JSON.stringify(report, null, 2));
console.table({ LINK: report.LINK, ETH: report.ETH, combined: report.combined });
console.log(`period ${report.period}, kind=${kind}, cost=${cost}`);

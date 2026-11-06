/**
 * Backtest one strategy on real BTC/ETH 4h candles with the shared portfolio simulator (packages/core/src/backtest.ts):
 * the live decision function, next-open fills, stop-first brackets, CPPI sizing and costs. Rules only (sentiment 0).
 *
 *   pnpm backtest                                   # balanced preset, 1 year
 *   pnpm backtest -- --tier=aggressive --bars=4380  # another tier, 2 years
 *   pnpm backtest -- --kind=mean-reversion          # override the preset's strategy kind
 * For tuned presets and honest out-of-sample numbers use `pnpm optimize:presets`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { agentPreset, alignBars, computeFeatureSeries, simulate, TIER_PROFILES, type RiskTierId, type StrategyKind } from "@perpetua/core";
import { fetchHistory4h, syntheticBars } from "../agent/src/market";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const tier = arg("tier", "balanced") as RiskTierId;
const preset = agentPreset(tier);
const kind = arg("kind", preset.kind) as StrategyKind;
const nBars = Number(arg("bars", "2190")) + 220;
const cost = Number(arg("cost", "0.004"));

const live = !process.argv.includes("--synthetic");
const now = Math.floor(Date.now() / 1000);
const load = async (sym: string) => (live ? (await fetchHistory4h(sym, nBars + 2)).filter((b) => b.t + 14_400 <= now).slice(-nBars) : syntheticBars(nBars));
const [btcRaw, ethRaw] = await Promise.all([load("BTCUSDT"), load("ETHUSDT")]).catch((e) => {
  console.warn(`market data unavailable (${(e as Error).message}); using synthetic bars`);
  return [syntheticBars(nBars, 60000, 0.001, 13), syntheticBars(nBars, 3000, 0.001, 11)];
});
const [btc, eth] = alignBars(btcRaw, ethRaw);
const q = preset.config.parameters;
const series = [computeFeatureSeries("BTC", btc, { btc, eth }, [q.breakoutBars]), computeFeatureSeries("ETH", eth, { btc, eth }, [q.breakoutBars])];
const p = TIER_PROFILES[tier];
const r = simulate(series, () => ({ kind, signal: q, piBps: p.piBps, multiplier: p.multiplier, riskPerTradePct: p.riskPerTradePct, maxMarginPct: p.maxMarginPct, roundTripCostPct: cost }), 0, btc.length);
const report = { tier, kind, parameters: q, costRoundTrip: cost, data: live ? "Binance spot 4h" : "synthetic", stats: r.stats, note: "Rules only (sentiment 0). Parameters were fitted on recent data, so a backtest over that window is in-sample." };
mkdirSync(".perpetua", { recursive: true });
writeFileSync(".perpetua/backtest.json", JSON.stringify({ ...report, trades: r.trades }, null, 2));
console.table({ [tier]: r.stats });
console.log(`${kind} ${JSON.stringify(q)} cost=${cost}`);

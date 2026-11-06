/**
 * Decision-model research: can an LLM improve the rule engine's trades, and does memory of past outcomes help?
 *
 * Task (the job a decision model would really do): the deterministic rules propose a bracketed long; the model
 * estimates P(target before stop) and takes or vetoes it.
 *  - Cases: rule candidates on real BTC/ETH 4h candles (5y), labelled by the actual bracket outcome
 *    (next-open fill, stop-first, 0.4% cost). Spaced >= 1 day apart per asset.
 *  - Test: the most recent 12 months. Memory: only cases RESOLVED before the test case's decision time.
 *  - Look-ahead control: asset names and dates are hidden; features are numeric only.
 *  - Conditions: zero-shot vs retrieval memory (8 most similar resolved past cases with outcomes).
 *  - Baselines: take-all, and a non-LLM k-nearest-neighbour vote on the same memory.
 * Metrics: Brier score, AUC, expectancy (avg R) of taken trades vs all, take rate, JSON validity, latency.
 *
 *   pnpm benchmark:decision -- --cases=150 --models=a,b
 */
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { alignBars, atr, decideSignal, ema, signalFeatures, tierFor, type Bar } from "@perpetua/core";
import { FireworksBrain } from "../agent/src/fallback-brain";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const N_TEST = Number(arg("cases", "150"));
const MODELS = arg("models", [
  "accounts/fireworks/routers/deepseek-v4p1-flash-1017-ultrafast", "accounts/fireworks/models/deepseek-v4p1-flash-1017", "accounts/fireworks/routers/glm-5p3-fast",
  "accounts/fireworks/models/glm-5p3", "accounts/fireworks/routers/kimi-k3-fast", "accounts/fireworks/models/kimi-k3", "accounts/fireworks/models/nemotron-3-ultra-nvfp4",
  "accounts/fireworks/models/gpt-oss-120b", "accounts/fireworks/models/minimax-m3", "accounts/fireworks/models/qwen3p8-max",
].join(",")).split(",");
const STOP_ATR = 1.5, TARGET_ATR = 6, COST = 0.004, R = TARGET_ATR / STOP_ATR;
const BREAKEVEN = (1 + COST * 10) / (R + 1); // rough: p*R - (1-p) > cost in R units

const key = process.env.FIREWORKS_API_KEY;
if (!key) throw new Error("FIREWORKS_API_KEY missing");
const load = (s: string): Bar[] => JSON.parse(readFileSync(`.perpetua/history/${s}-4h.json`, "utf8"));
if (!existsSync(".perpetua/history/BTCUSDT-4h.json")) throw new Error("run pnpm optimize:presets first (caches candle history)");
const [btc, eth] = alignBars(load("BTCUSDT"), load("ETHUSDT"));

// ------------------------------------------------------------------ cases
interface Case { asset: string; t: number; resolvedT: number; win: boolean; r: number; f: Record<string, number | string | boolean> }
function cases(asset: string, bars: Bar[]): Case[] {
  const out: Case[] = [];
  let last = -Infinity;
  const closes = bars.map((b) => b.c);
  const e50 = ema(closes, 50), e200 = ema(closes, 200), a14 = atr(bars, 14);
  for (let i = 400; i < bars.length - 2; i++) {
    if (i - last < 6) continue;
    const window = bars.slice(i - 399, i + 1);
    const x = signalFeatures({ asset, bars: window, btcBars: btc.slice(i - 399, i + 1), ethBars: eth.slice(i - 399, i + 1), sentiment: null }, 20);
    const s = decideSignal(x, { kind: "dca", stopAtr: STOP_ATR, targetAtr: TARGET_ATR, minRewardRisk: 2, m: 3 });
    if (s.direction !== "long") continue;
    // resolve the bracket on later candles
    const entry = bars[i + 1].o, stop = s.stop, target = s.target;
    if (entry <= stop || entry >= target) continue;
    let j = i + 1, exit = 0, win = false;
    for (; j < bars.length; j++) {
      const b = bars[j];
      if (b.l <= stop) { exit = Math.min(stop, b.o); break; }
      if (b.h >= target) { exit = Math.max(target, b.o); win = true; break; }
    }
    if (!exit) continue; // unresolved at the end of data
    last = i;
    const ret = (k: number) => (closes[i] / closes[i - k] - 1) * 100;
    const vol30 = Math.sqrt(window.slice(-180).reduce((acc, b, k, arr) => (k ? acc + Math.log(b.c / arr[k - 1].c) ** 2 : acc), 0) / 179) * Math.sqrt(6) * 100;
    out.push({
      asset, t: bars[i].t + 14_400, resolvedT: bars[j].t + 14_400, win, r: (exit / entry - 1 - COST) / ((entry - stop) / entry),
      f: {
        regime: x.regime, highVol: x.highVol, trend: +x.factors.trend.toFixed(2), momentum: +x.factors.momentum.toFixed(2), relStrength: +x.factors.relativeStrength.toFixed(2),
        positioning: +x.factors.positioning.toFixed(2), rsi: +x.rsi.toFixed(1), atrPct: +((a14[i] / closes[i]) * 100).toFixed(2), vsEma50Pct: +((closes[i] / e50[i] - 1) * 100).toFixed(2),
        vsEma200Pct: +((closes[i] / e200[i] - 1) * 100).toFixed(2), ret1dPct: +ret(6).toFixed(2), ret7dPct: +ret(42).toFixed(2), ret30dPct: +ret(180).toFixed(2), dailyVol30Pct: +vol30.toFixed(2),
        stopPct: +(((entry - stop) / entry) * 100).toFixed(2), targetPct: +(((target - entry) / entry) * 100).toFixed(2),
      },
    });
  }
  return out;
}
const all = [...cases("BTC", btc), ...cases("ETH", eth)].sort((a, b) => a.t - b.t);
const cutoff = btc[btc.length - 1].t - 365 * 86_400;
const testPool = all.filter((c) => c.t >= cutoff);
const step = Math.max(1, testPool.length / N_TEST);
const test = Array.from({ length: Math.min(N_TEST, testPool.length) }, (_, k) => testPool[Math.floor(k * step)]);
const NUM = ["trend", "momentum", "relStrength", "positioning", "rsi", "atrPct", "vsEma50Pct", "vsEma200Pct", "ret1dPct", "ret7dPct", "ret30dPct", "dailyVol30Pct"];
const pre = all.filter((c) => c.t < cutoff);
const mu = NUM.map((k) => pre.reduce((s, c) => s + (c.f[k] as number), 0) / pre.length);
const sd = NUM.map((k, i) => Math.sqrt(pre.reduce((s, c) => s + ((c.f[k] as number) - mu[i]) ** 2, 0) / pre.length) || 1);
const z = (c: Case) => NUM.map((k, i) => ((c.f[k] as number) - mu[i]) / sd[i]);
const dist = (a: Case, b: Case) => { const x = z(a), y = z(b); return Math.sqrt(x.reduce((s, v, i) => s + (v - y[i]) ** 2, 0)) + (a.f.regime === b.f.regime ? 0 : 1.5); };
const memoryFor = (c: Case, k: number) => all.filter((m) => m.resolvedT <= c.t).map((m) => ({ m, d: dist(c, m) })).sort((a, b) => a.d - b.d).slice(0, k).map((x) => x.m);
const baseRate = pre.filter((c) => c.win).length / pre.length;
console.log(`cases: ${all.length} total, ${pre.length} before test window (win rate ${(baseRate * 100).toFixed(1)}%), test ${test.length} (win rate ${((test.filter((c) => c.win).length / test.length) * 100).toFixed(1)}%), R = ${R}, breakeven p ~ ${BREAKEVEN.toFixed(2)}`);

// ------------------------------------------------------------------ prompts
const SYSTEM = `You are the risk analyst of a long-only crypto trading agent. A deterministic rule engine proposes a bracketed long entry. Estimate the probability that the TAKE-PROFIT is hit before the STOP-LOSS, then decide whether to take the trade.
Reward:risk is ${R}:1 after costs, so a trade is worth taking only if p_win > ${BREAKEVEN.toFixed(2)}. Calibrate: across many such proposals roughly ${(baseRate * 100).toFixed(0)}% historically won.
Features: regime (EMA50/200), factor scores in [-1,1], RSI(14), ATR % of price, distance from EMA50/EMA200 %, past returns %, 30-day daily volatility %, stop/target distance %.
Reply with JSON only: {"p_win": number in [0,1], "take": boolean, "reason": string (max 20 words)}`;
const row = (c: Case) => Object.entries(c.f).map(([k, v]) => `${k}=${v}`).join(", ");
const zeroShot = (c: Case) => [{ role: "system" as const, content: SYSTEM }, { role: "user" as const, content: `Proposed trade (asset and date hidden): ${row(c)}` }];
const withMemory = (c: Case) => [
  { role: "system" as const, content: SYSTEM + "\nYou also get the most similar past proposals from this agent's own history, with their real outcomes. Use them as evidence, not as a rule." },
  { role: "user" as const, content: `Similar past proposals (resolved before now):\n${memoryFor(c, 8).map((m, i) => `${i + 1}. ${row(m)} -> ${m.win ? "WIN" : "LOSS"} (${m.r.toFixed(2)}R)`).join("\n")}\n\nProposed trade (asset and date hidden): ${row(c)}` },
];

// ------------------------------------------------------------------ metrics
function auc(ps: number[], ys: boolean[]) {
  const pos = ps.filter((_, i) => ys[i]), neg = ps.filter((_, i) => !ys[i]);
  let s = 0; for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0;
  return pos.length && neg.length ? s / (pos.length * neg.length) : NaN;
}
function score(name: string, ps: (number | null)[], takes: (boolean | null)[], ms: number[] = []) {
  const ok = ps.map((p, i) => (p === null ? null : i)).filter((i): i is number => i !== null);
  const y = ok.map((i) => test[i].win), p = ok.map((i) => ps[i]!);
  const taken = ok.filter((i) => takes[i]);
  const avgR = (ix: number[]) => (ix.length ? ix.reduce((s, i) => s + test[i].r, 0) / ix.length : NaN);
  return {
    model: name, valid: `${ok.length}/${test.length}`, brier: +(p.reduce((s, v, k) => s + (v - (y[k] ? 1 : 0)) ** 2, 0) / Math.max(1, p.length)).toFixed(4),
    auc: +auc(p, y).toFixed(3), takeRate: +(taken.length / Math.max(1, ok.length)).toFixed(2), takenWinRate: +(taken.filter((i) => test[i].win).length / Math.max(1, taken.length)).toFixed(2),
    takenAvgR: +avgR(taken).toFixed(3), allAvgR: +avgR(ok).toFixed(3), totalR: +taken.reduce((s, i) => s + test[i].r, 0).toFixed(1),
    medianMs: ms.length ? ms.slice().sort((a, b) => a - b)[Math.floor(ms.length / 2)] : 0,
  };
}

const results: ReturnType<typeof score>[] = [];
results.push(score("baseline: take every proposal", test.map(() => baseRate), test.map(() => true)));
const knn = test.map((c) => { const mem = memoryFor(c, 25); return (mem.filter((m) => m.win).length + baseRate * 4) / (mem.length + 4); });
results.push(score("baseline: kNN-25 on memory (no LLM)", knn, knn.map((p) => p > BREAKEVEN)));

const parse = (s: string) => { const m = s.match(/\{[\s\S]*\}/); if (!m) return null; try { const j = JSON.parse(m[0]); const p = Number(j.p_win); return Number.isFinite(p) ? { p: Math.max(0, Math.min(1, p)), take: j.take === true } : null; } catch { return null; } };
const policy = { ...tierFor(72), maxPromptTokens: 8000 };
async function runModel(model: string, build: (c: Case) => { role: "system" | "user"; content: string }[], label: string) {
  const failures: string[] = [];
  const ps: (number | null)[] = new Array(test.length).fill(null), takes: (boolean | null)[] = new Array(test.length).fill(null), ms: number[] = [];
  const queue = test.map((_, i) => i);
  await Promise.all(Array.from({ length: 3 }, async () => {
    for (let i = queue.shift(); i !== undefined; i = queue.shift()) {
      const t = Date.now();
      for (let attempt = 0; attempt < 5; attempt++) {
        const b = new FireworksBrain({ apiKey: key!, model, maxTokensPerHour: 1e8, maxTokensPerDay: 1e9, timeoutMs: 90_000 });
        try {
          const r = await b.think(policy, build(test[i]), 2048);
          const p = r ? parse(r.content) : null;
          if (p) { ps[i] = p.p; takes[i] = p.take; ms.push(Date.now() - t); break; }
          failures.push(r ? `unparseable: ${r.content.slice(0, 120)}` : "no result");
        } catch (e) {
          const msg = (e as Error).message;
          if (/rate limit/i.test(msg)) { await new Promise((w) => setTimeout(w, 5_000 * (attempt + 1))); continue; }
          failures.push(msg.slice(0, 120));
        }
        if (attempt >= 1) break; // non-rate-limit failures get one retry
      }
    }
  }));
  const s = score(`${model.split("/").pop()} · ${label}`, ps, takes, ms);
  if (failures.length) console.log(`  ${model.split("/").pop()} ${label} failures: ${[...new Set(failures)].slice(0, 3).join(" | ")}`);
  console.log(`  ${s.model}: brier ${s.brier} auc ${s.auc} takenAvgR ${s.takenAvgR} (all ${s.allAvgR}) take ${s.takeRate} valid ${s.valid}`);
  return s;
}
for (const model of MODELS) {
  results.push(await runModel(model, zeroShot, "zero-shot"));
  results.push(await runModel(model, withMemory, "memory"));
}
console.table(results);
mkdirSync(".perpetua", { recursive: true });
writeFileSync(".perpetua/decision-benchmark.json", JSON.stringify({ at: new Date().toISOString(), setup: { R, cost: COST, breakeven: BREAKEVEN, baseRate, testWindowFrom: new Date(cutoff * 1000).toISOString().slice(0, 10), nTest: test.length, testWinRate: test.filter((c) => c.win).length / test.length }, results }, null, 2));

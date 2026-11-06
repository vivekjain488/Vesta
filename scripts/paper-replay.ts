/**
 * Accelerated paper trading ON THE PLATFORM (local anvil, FLASH_MODE=sim).
 *
 * Creates agents exactly as Studio does (owner-signed definition -> deployLocalAgent -> deposit), then replays real
 * BTC/ETH 4h candles one closed bar at a time. Every step: the chain clock advances 4h, RiskGate is re-poked with
 * the bar's closing prices (refreshLocalRisk), and each agent runs its normal tick(): signal -> sizing -> rules
 * attestation -> RiskGate.approveOrder -> EIP-1271 -> sim fill; open positions' brackets execute on later candles.
 * Vault NAV is read on-chain after every poke. Nothing is simulated outside the platform code path except the fill
 * venue (FlashSim: 10 bps fee in, 10 bps fee + 20 bps slippage out) and historical news (none: rules only).
 *
 *   (stop the API first: its runtime would tick the same agents on live candles)
 *   pnpm paper:replay -- --days=90
 */
process.env.CANDLE_SOURCE = "replay";
process.env.FLASH_MODE = "sim";

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createWalletClient, http, parseUnits, erc20Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  agentPreset, alignBars, computeFeatureSeries, mockERC20Abi, perpetuaVaultAbi, presetPrompt, simulate, templateKind, tierProfile, validateStrategyConfig,
  type AgentDefinition, type Bar, type RiskTierId, type StrategyConfig,
} from "@perpetua/core";
import { loadConfig } from "../agent/src/config";
import { PerpetuaAgent } from "../agent/src/agent";
import { fetchHistory4h, loadReplayHistory, setReplayClock } from "../agent/src/market";
import { clients } from "../agent/src/chain";
import { FireworksBrain } from "../agent/src/fallback-brain";
import { compileStrategy } from "../agent/src/strategy-compiler";
import { AgentDefinitions } from "../api/src/agent-definitions";
import { Platform } from "../api/src/platform";
import { deployLocalAgent } from "../api/src/local-agents";
import { refreshLocalRisk } from "../api/src/local-withdrawals";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const DAYS = Number(arg("days", "90"));
const DEPOSIT = Number(arg("deposit", "1000"));
const root = resolve(new URL("..", import.meta.url).pathname);
const STATE = resolve(process.env.PERPETUA_STATE_DIR ?? resolve(root, ".perpetua"));
const OUT = resolve(STATE, "paper-replay");
mkdirSync(OUT, { recursive: true });

if (await fetch(`http://localhost:${process.env.API_PORT ?? 8787}/health`).then(() => true, () => false)) {
  console.error("The API is running: its hosted runtime would tick these agents on live candles. Stop it, run the replay, then restart it.");
  process.exit(1);
}

// ---------------------------------------------------------------- market history (real, closed candles only)
async function history(symbol: string): Promise<Bar[]> {
  const file = resolve(STATE, "history", `${symbol}-4h.json`);
  const now = Math.floor(Date.now() / 1000);
  let bars: Bar[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  if (!bars.length || bars[bars.length - 1].t + 14_400 * 2 < now) {
    const fresh = (await fetchHistory4h(symbol, 3000)).filter((b) => b.t + 14_400 <= now);
    const seen = new Set(fresh.map((b) => b.t));
    bars = [...bars.filter((b) => !seen.has(b.t)), ...fresh].sort((a, b) => a.t - b.t);
    mkdirSync(resolve(STATE, "history"), { recursive: true });
    writeFileSync(file, JSON.stringify(bars));
  }
  return bars.filter((b) => b.t + 14_400 <= now);
}
const [btc, eth] = alignBars(await history("BTCUSDT"), await history("ETHUSDT"));
loadReplayHistory("BTCUSDT", btc);
loadReplayHistory("ETHUSDT", eth);
const steps = DAYS * 6;
const first = btc.length - steps;
if (first < 400) throw new Error("not enough history for the warm-up window");
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
console.log(`replay ${steps} bars: ${day(btc[first].t + 14_400)} -> ${day(btc[btc.length - 1].t + 14_400)} UTC`);

// ---------------------------------------------------------------- platform objects (same as the API)
const platform = new Platform(STATE);
const definitions = new AgentDefinitions(STATE, process.env.CONFIG_AUTH_AUDIENCE ?? `http://localhost:${process.env.API_PORT ?? 8787}`);
const ownerKey = (process.env.PAPER_OWNER_PRIVATE_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") as Hex; // anvil #0 (public test key)
const owner = privateKeyToAccount(ownerKey);
const ownerClient = clients(process.env.VAULT_RPC_URL ?? "http://127.0.0.1:8545", 31337, ownerKey);
const admin = clients(process.env.VAULT_RPC_URL ?? "http://127.0.0.1:8545", 31337, process.env.FLASH_SPENDER_PRIVATE_KEY as Hex);
if ((await admin.pub.getChainId()) !== 31337) throw new Error("paper replay runs on the local anvil chain only");

async function createAgent(name: string, config: StrategyConfig, preset: RiskTierId, prompt: string): Promise<AgentDefinition> {
  const payload = { name, config: validateStrategyConfig(config), status: "draft", preset, prompt };
  const c = definitions.challenge(owner.address, "create", payload);
  await definitions.authorize(owner.address, "create", payload, c.nonce, await owner.signMessage({ message: c.message }));
  const d = definitions.save(owner.address, payload);
  await deployLocalAgent(platform, d);
  return definitions.save(d.owner, { name: d.name, config: d.config, status: "paper", revision: d.revision, preset, prompt }, d.id);
}

// ---------------------------------------------------------------- the agents: 3 risk tiers x 4 strategies + 1 custom
const KINDS: { template: StrategyConfig["template"]; label: string }[] = [
  { template: "spot-momentum", label: "Momentum" },
  { template: "spot-adaptive", label: "Adaptive" },
  { template: "spot-range", label: "Range" },
  { template: "spot-dca", label: "DCA" },
];
const run = new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "");
const specs: { name: string; tier: RiskTierId; config: StrategyConfig; prompt: string; tuned: boolean; custom?: boolean }[] = [];
for (const tier of ["conservative", "balanced", "aggressive"] as const) {
  const preset = agentPreset(tier);
  for (const k of KINDS) {
    const tuned = k.template === preset.config.template;
    specs.push({ name: `${preset.profile.label} ${k.label}`, tier, tuned, config: { ...preset.config, template: k.template, execution: { ...preset.config.execution } }, prompt: tuned ? preset.prompt : `${presetPrompt(tier)} Strategy variant: ${k.label}.` });
  }
}
// The customised agent: a preset edited in plain English through the real compile path (0G down -> Fireworks).
const customPrompt = "Balanced risk, but only trade bitcoin. Use the adaptive regime-switching strategy with stops 2 ATR away and targets 8 ATR away, and risk at most 0.4% of the vault per trade.";
let customConfig: StrategyConfig;
let customSource = "fireworks";
try {
  const draft = await compileStrategy(new FireworksBrain({ apiKey: process.env.FIREWORKS_API_KEY ?? "", maxTokensPerHour: 50_000, maxTokensPerDay: 100_000 }), customPrompt, agentPreset("balanced").config);
  customConfig = draft.config;
  console.log(`custom agent drafted by ${draft.proof.model}: ${draft.config.template} ${draft.config.symbols} stop ${draft.config.parameters.stopAtr} target ${draft.config.parameters.targetAtr} risk ${draft.config.risk.riskPerTradePct}%`);
} catch (e) {
  customSource = `manual (compile failed: ${(e as Error).message})`;
  const b = agentPreset("balanced").config;
  customConfig = { ...b, template: "spot-adaptive", symbols: ["BTC"], parameters: { ...b.parameters, stopAtr: 2, targetAtr: 8 }, risk: { ...b.risk, riskPerTradePct: 0.4 } };
}
specs.push({ name: "Custom BTC Adaptive", tier: "balanced", tuned: false, custom: true, config: customConfig, prompt: customPrompt });

console.log(`creating ${specs.length} agents (owner ${owner.address}, ${DEPOSIT} USDC each)…`);
const dep = platform.deployment();
const agents: { spec: (typeof specs)[number]; def: AgentDefinition; agent: PerpetuaAgent; deployed: any; nav: number[]; floor: number }[] = [];
for (const spec of specs) {
  const def = await createAgent(spec.name, spec.config, spec.tier, spec.prompt);
  const deployed = platform.agent(def.id);
  const amount = parseUnits(String(DEPOSIT), 6);
  await admin.pub.waitForTransactionReceipt({ hash: await admin.wallet.writeContract({ address: dep.usdc, abi: mockERC20Abi, functionName: "mint", args: [owner.address, amount], account: admin.account, chain: admin.chain }) });
  await ownerClient.pub.waitForTransactionReceipt({ hash: await ownerClient.wallet.writeContract({ address: dep.usdc, abi: erc20Abi, functionName: "approve", args: [deployed.vault, amount], account: ownerClient.account, chain: ownerClient.chain }) });
  await ownerClient.pub.waitForTransactionReceipt({ hash: await ownerClient.wallet.writeContract({ address: deployed.vault, abi: perpetuaVaultAbi, functionName: "deposit", args: [amount, owner.address], account: ownerClient.account, chain: ownerClient.chain }) });
  const base = loadConfig();
  const agent = await PerpetuaAgent.create({ ...base, agentName: def.id, agentId: deployed.agentId, vault: deployed.vault, wallet: deployed.wallet, riskGate: deployed.riskGate, assets: deployed.assets, strategy: templateKind(def.config.template), strategyConfig: def.config, mandatePrompt: def.prompt, configHash: def.configHash, tickSeconds: 14_400 });
  agent.writer.start();
  const floor = Number(await admin.pub.readContract({ address: deployed.vault, abi: perpetuaVaultAbi, functionName: "floorValue" })) / 1e6;
  agents.push({ spec, def, agent, deployed, nav: [], floor });
  console.log(`  ${spec.name.padEnd(24)} ${def.id}  floor ${floor.toFixed(0)} USDC`);
}

// ---------------------------------------------------------------- replay
const rpc = (method: string, params: unknown[]) => admin.pub.request({ method: method as any, params: params as any });
const t0 = Date.now();
const times: number[] = [];
for (let i = first; i < btc.length; i++) {
  const closeT = btc[i].t + 14_400;
  setReplayClock(closeT);
  await rpc("evm_increaseTime", [14_400]);
  await rpc("evm_mine", []);
  times.push(closeT);
  for (const a of agents) {
    await refreshLocalRisk(platform, a.def.id); // poke at this bar's closing prices
    a.nav.push(Number(await admin.pub.readContract({ address: a.deployed.vault, abi: perpetuaVaultAbi, functionName: "totalAssets" })) / 1e6);
    try { await a.agent.tick(); } catch (e) { console.warn(`[${a.spec.name}] tick failed: ${(e as Error).message}`); }
  }
  const k = i - first + 1;
  if (k % 12 === 0 || k === steps) {
    const eta = ((Date.now() - t0) / k) * (steps - k) / 60_000;
    const line = `step ${k}/${steps} ${day(closeT)}  ` + agents.map((a) => `${a.spec.name.split(" ").map((w) => w[0]).join("")}:${a.nav.at(-1)!.toFixed(0)}`).join(" ");
    appendFileSync(resolve(OUT, "progress.log"), `${new Date().toISOString().slice(11, 19)} ${line}\n`);
    console.log(`step ${k}/${steps} ${day(closeT)}  ` + agents.map((a) => `${a.spec.name.split(" ").map((w) => w[0]).join("")}:${a.nav.at(-1)!.toFixed(0)}`).join(" ") + `  eta ${eta.toFixed(1)}m`);
  }
}
for (const a of agents) a.agent.writer.stop();
setReplayClock(null);

// ---------------------------------------------------------------- results (on-chain NAV + agent trade records)
const series = [computeFeatureSeries("BTC", btc, { btc, eth }, [20, 55]), computeFeatureSeries("ETH", eth, { btc, eth }, [20, 55])];
const btcOnly = [computeFeatureSeries("BTC", btc, { btc, eth }, [20, 55])];
const bh = (bars: Bar[]) => (bars[bars.length - 1].c / bars[first].c - 1) * 100;
const results = agents.map((a) => {
  const state = platform.stateOf(a.def.id) ?? { trades: {} };
  const trades = Object.values(state.trades ?? {}) as any[];
  const closed = trades.filter((t) => t.status === "closed");
  let peak = a.nav[0], mdd = 0;
  for (const v of a.nav) { peak = Math.max(peak, v); mdd = Math.max(mdd, (peak - v) / peak); }
  const start = a.nav[0], end = a.nav[a.nav.length - 1];
  const p = tierProfile(a.def.config.riskTier);
  const sim = simulate(a.def.config.symbols.length === 1 ? btcOnly : series, () => ({ kind: templateKind(a.def.config.template), signal: a.def.config.parameters, piBps: p.piBps, multiplier: p.multiplier, riskPerTradePct: a.def.config.risk.riskPerTradePct, maxMarginPct: a.def.config.risk.maxMarginPct, roundTripCostPct: 0.004 }), first, btc.length).stats;
  return {
    agent: a.spec.name, id: a.def.id, tier: a.spec.tier, strategy: templateKind(a.def.config.template), tuned: a.spec.tuned, custom: !!a.spec.custom,
    startNav: Number(start.toFixed(2)), endNav: Number(end.toFixed(2)), returnPct: Number(((end / start - 1) * 100).toFixed(2)), maxDrawdownPct: Number((mdd * 100).toFixed(2)),
    floor: a.floor, minNav: Number(Math.min(...a.nav).toFixed(2)), floorHeld: Math.min(...a.nav) >= a.floor,
    trades: trades.length, closed: closed.length, open: trades.length - closed.length, wins: closed.filter((t) => (t.pnlUsd ?? 0) > 0).length,
    stops: closed.filter((t) => t.exitReason === "stop").length, targets: closed.filter((t) => t.exitReason === "target").length,
    realisedPnl: Number(closed.reduce((s, t) => s + (t.pnlUsd ?? 0), 0).toFixed(2)),
    attestation: [...new Set(trades.map((t) => t.attestation))].join("/"),
    simulatorReturnPct: sim.totalReturnPct, simulatorTrades: sim.trades,
  };
});
const report = {
  generatedAt: new Date().toISOString(), window: { from: day(btc[first].t + 14_400), to: day(btc[btc.length - 1].t + 14_400), bars: steps },
  depositUsdc: DEPOSIT, buyHoldPct: { BTC: Number(bh(btc).toFixed(2)), ETH: Number(bh(eth).toFixed(2)) }, customSource, customPrompt,
  wallClockMinutes: Number(((Date.now() - t0) / 60_000).toFixed(1)),
  notes: [
    "Paper trading on the local platform: real contracts, RiskGate, rules attestation and vault accounting; fills by FlashSim.",
    "Historical replay has no archived news, so sentiment is 0 and every order is rules-attested.",
    "Preset parameters were tuned on data that includes this window: treat tuned agents' results as in-sample.",
    "NAV includes the safe-leg lending yield accrued on the protected floor.",
  ],
  results,
  equity: { t: times, nav: Object.fromEntries(agents.map((a) => [a.spec.name, a.nav.map((v) => Number(v.toFixed(2)))])) },
  prices: { BTC: btc.slice(first).map((b) => b.c), ETH: eth.slice(first).map((b) => b.c) },
};
writeFileSync(resolve(OUT, `report-${run}.json`), JSON.stringify(report, null, 2));
writeFileSync(resolve(OUT, "latest.json"), JSON.stringify(report, null, 2));
console.table(results.map(({ id, tuned, custom, startNav, floor, minNav, ...r }) => r));
console.log(`BTC buy & hold ${report.buyHoldPct.BTC}%, ETH ${report.buyHoldPct.ETH}% · wrote ${resolve(OUT, `report-${run}.json`)}`);
process.exit(0);

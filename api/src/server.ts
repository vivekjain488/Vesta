/**
 * Perpetua paid services + free read proxies.
 *
 *   POST /v1/signal       $0.02  over x402   fresh analysis + Arkiv commitment + 0G chat ID
 *   POST /v1/risk-check   $0.005 over x402   deterministic RiskGate-logic verdict (no LLM) + Atlas decode
 *   GET  /v1/agents | /v1/signals | /v1/atlas/:selector | /v1/feed | /v1/evidence   free
 *   POST /v1/copy/quote | /v1/copy/order   one-tap copy: builds the follower's own Flash order (their wallet
 *                                           signs; funds never touch the agent's vault) with the integrator fee
 *                                           routed to the agent.
 *
 * Integrity: the agent places its own order BEFORE a signal goes on sale (signals file only lists signals with
 * ownOrderPlacedAt), free readers get it 15 minutes later, and team wallets never buy (buyer addresses are
 * logged to .perpetua/x402-buyers.jsonl for judges to check).
 */
import "dotenv/config";
import express from "express";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkEntry, riskGateAbi, STRATEGY_TEMPLATES, templateConfig, type RiskCheckRequest } from "@perpetua/core";
import { AgentDefinitions, type ConfigAction } from "./agent-definitions";
import { compileStrategy } from "../../agent/src/strategy-compiler";
import { ZeroGServiceError } from "../../agent/src/zerog-router";
import { createStrategyCompiler, inferenceBackend, InferenceServiceError, type InferenceProvider } from "../../agent/src/inference";
import { FlashHttp } from "../../agent/src/flash";
import { investments, saveExitRequest } from "./investments";
import { WalletSessions, SESSION_COOKIE } from "./sessions";
import { Platform } from "./platform";
import { chainOperation, localPriceUsd, prepareLocalWithdrawal, refreshLocalRisk } from "./local-withdrawals";
import { deployLocalAgent, localFaucet } from "./local-agents";
import { pendingWithdrawals, finishWithdrawals, startLocalRuntime } from "./local-runtime";
import { registryRouter } from "./registry";
import { runtimeRouter } from "./runtime";
import { latestMarket, marketCandles, marketHistory, safeMarketError, ArkivWriter, RiskCheckEntity, EXPIRY_DAYS, addr, jsonBytes, str128, u64, lookupSelector } from "@perpetua/arkiv";
import { createPublicClient, erc20Abi, hexToString, http, keccak256, toBytes, parseUnits, formatUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const PORT = Number(process.env.API_PORT ?? 8787);
const INFERENCE_BACKEND = inferenceBackend();
const STATE = resolve(process.env.PERPETUA_STATE_DIR ?? resolve(new URL("../..", import.meta.url).pathname, ".perpetua"));
const PAY_TO = process.env.X402_PAY_TO as Address | undefined; // agent income wallet (forwarded into the vault via recordIncome)
const NETWORK = process.env.X402_NETWORK ?? "eip155:84532"; // Base Sepolia; "eip155:8453" for Base mainnet
const FACILITATOR = process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator";
const FLASH_BASE = process.env.FLASH_BASE_URL ?? "https://flash.definitive.fi/v1";
const FLASH_KEY = process.env.FLASH_API_KEY ?? "";
const CHECKER = process.env.PROPOSER_PRIVATE_KEY ? privateKeyToAccount(process.env.PROPOSER_PRIVATE_KEY as Hex).address : ("0x0000000000000000000000000000000000000000" as Address);
const REVEAL_S = 15 * 60;

mkdirSync(STATE, { recursive: true });
const writer = new ArkivWriter("api", { intervalMs: 60_000 });
writer.start();

const app = express();
const appOrigin = process.env.APP_ORIGIN ?? "http://localhost:3000";
const sessions = new WalletSessions(appOrigin);
const sessionOwner = (req: express.Request) => sessions.read(req.headers.cookie)?.address as Address;
app.use(express.json({ limit: "64kb" }));
app.use("/registry", registryRouter());
app.use((req, res, next) => {
  const origin = req.header("origin");
  if (origin && origin !== appOrigin) return void res.status(403).json({ error: "Origin not allowed" });
  if (origin) res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-allow-credentials", "true");
  res.setHeader("vary", "Origin");
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, x-payment, payment-signature");
  res.setHeader("access-control-expose-headers", "x-payment-response, payment-response, x-perpetua-chain-degraded");
  next();
});
app.options(/.*/, (_, res) => void res.sendStatus(204));
app.post("/auth/challenge", (req, res) => {
  try { res.json(sessions.challenge(req.body.address, req.body.chainId)); } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
app.post("/auth/verify", async (req, res) => {
  try { const s = await sessions.verify(req.body.nonce, req.body.signature); res.setHeader("set-cookie", sessions.cookie(s.token)); res.json({ address: s.address, expires: s.expires }); }
  catch (e) { res.status(401).json({ error: (e as Error).message }); }
});
app.get("/auth/session", (req, res) => { const session = sessions.read(req.headers.cookie); res.setHeader("cache-control", "no-store"); if (!session) return void res.status(401).json({ error: "Sign in with MetaMask" }); res.json(session); });
app.post("/auth/logout", (req, res) => { sessions.logout(req.headers.cookie); res.setHeader("set-cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`); res.json({ ok: true }); });
app.use("/v1", (req, res, next) => {
  res.setHeader("cache-control", "no-store");
  if (!sessions.read(req.headers.cookie)) return void res.status(401).json({ error: "Sign in with MetaMask" });
  next();
});

// Owner configuration is independent of operator keys and on-chain deployment. These are drafts/paper only.
const definitions = new AgentDefinitions(STATE, process.env.CONFIG_AUTH_AUDIENCE ?? `http://localhost:${PORT}`);
const platform = new Platform(STATE);
const requireAgentOwner = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  try { if (!await platform.owns(String(req.params.agent ?? req.params.name), sessionOwner(req))) return void res.status(403).json({ error: "Agent belongs to another wallet" }); next(); }
  catch (e) { res.status(404).json({ error: (e as Error).message }); }
};
app.get("/v1/dashboard", async (req, res) => {
  try {
    const rows = await Promise.all(platform.agents().map((a) => platform.summary(a).catch(() => null)));
    if (rows.some((a) => a === null)) res.setHeader("x-perpetua-chain-degraded", "true");
    const owned = rows.filter((a): a is NonNullable<typeof a> => a !== null).filter((a) => a.owner.toLowerCase() === sessionOwner(req).toLowerCase()).map((a) => ({ ...a, status: pendingWithdrawals(platform, a.id).length ? "withdrawing" : a.status }));
    const bound = new Set(owned.map((a) => a.id));
    const drafts = definitions.list(sessionOwner(req)).filter((a) => !bound.has(a.id)).map((a) => ({ id: a.id, name: a.name, status: a.status, strategy: a.config.template, riskTier: "balanced", chain: null, runtime: null, profit: 0 }));
    res.json([...owned, ...drafts]);
  } catch (e) { res.status(503).json({ error: (e as Error).message }); }
});
app.get("/v1/leaderboard", async (_, res) => {
  try { const rows = await Promise.all(platform.agents().filter((a) => a.platformAgent).map((a) => platform.summary(a))); res.json(rows.sort((a, b) => b.profit - a.profit).map((a) => ({ name: a.name, profit: a.profit }))); }
  catch (e) { res.status(503).json({ error: (e as Error).message }); }
});
app.get("/v1/paper-leaderboard", (_, res) => {
  const file = `${STATE}/paper-leaderboard.json`;
  try { if (!existsSync(file)) return void res.json(null); res.json(JSON.parse(readFileSync(file, "utf8"))); }
  catch { res.status(503).json({ error: "Paper competition results are unavailable" }); }
});
app.get("/v1/history/:agent", requireAgentOwner, async (req, res) => {
  try { res.json(await platform.history(String(req.params.agent))); } catch (e) { res.status(503).json({ error: (e as Error).message }); }
});
app.get("/v1/agents/:agent/compute-funding", requireAgentOwner, (req, res) => {
  try { res.json(platform.computeFundingOf(String(req.params.agent))); }
  catch { res.status(503).json({ error: "Compute funding status is unavailable" }); }
});
app.post("/v1/agents/:agent/prepare-withdrawal", requireAgentOwner, async (req, res) => {
  try { const payload = req.body.payload; if (payload?.agent !== req.params.agent) throw new Error("Agent mismatch"); const owner = await requireConfigAuth(req, "withdraw", payload); res.json(await prepareLocalWithdrawal(platform, owner, payload)); }
  catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
app.post("/v1/agents/:agent/refresh", requireAgentOwner, async (req, res) => {
  try { const id = String(req.params.agent); if (req.body?.resume === true) finishWithdrawals(platform, id, "cancelled"); res.json({ transactionHash: await chainOperation(() => refreshLocalRisk(platform, id)) }); } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
app.post("/v1/agents/:agent/withdrawal-complete", requireAgentOwner, async (req, res) => {
  try {
    const id = String(req.params.agent); const a = platform.agent(id); const hash = req.body.transactionHash as Hex;
    const receipt = await platform.pub.getTransactionReceipt({ hash });
    const events = await platform.pub.getContractEvents({ address: a.vault, abi: (await import("@perpetua/core")).perpetuaVaultAbi, eventName: "Withdraw", fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber });
    if (receipt.status !== "success" || !events.some((e) => e.transactionHash === hash && e.args.owner?.toLowerCase() === sessionOwner(req).toLowerCase() && (e.args.assets ?? 0n) > 0n)) throw new Error("No confirmed owner withdrawal found");
    for (const request of pendingWithdrawals(platform, id)) {
      if (!request.settledAtBlock || receipt.blockNumber <= BigInt(request.settledAtBlock)) throw new Error("Use the withdrawal transaction confirmed after this position exit settled");
      if (request.scope === "all" && await platform.pub.readContract({ address: a.vault, abi: (await import("@perpetua/core")).perpetuaVaultAbi, functionName: "balanceOf", args: [sessionOwner(req)] }) !== 0n) throw new Error("Withdraw all has not redeemed all owner shares");
    }
    finishWithdrawals(platform, id, "completed", hash); res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
app.post("/v1/agent-definitions/:id/deploy", async (req, res) => {
  try {
    const d = definitions.get(String(req.params.id)); if (d.owner.toLowerCase() !== sessionOwner(req).toLowerCase()) return void res.status(403).json({ error: "Agent belongs to another wallet" });
    const result = await deployLocalAgent(platform, d); if (d.status !== "paper") definitions.save(d.owner, { name: d.name, config: d.config, status: "paper", revision: d.revision }, d.id); res.json(result);
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
app.get("/v1/network", async (req, res) => {
  try { const dep = platform.deployment(); const chainId = await platform.pub.getChainId(); const balance = await platform.pub.readContract({ address: dep.usdc, abi: erc20Abi, functionName: "balanceOf", args: [sessionOwner(req)] }); res.json({ chainId, rpc: process.env.PUBLIC_VAULT_RPC_URL ?? process.env.VAULT_RPC_URL ?? "http://127.0.0.1:8545", usdc: dep.usdc, local: chainId === 31337 && process.env.FLASH_MODE === "sim", executionMode: process.env.FLASH_MODE ?? "sim", aiMode: INFERENCE_BACKEND === "openrouter" ? "openrouter" : process.env.ZG_MODE ?? "sim", candleSource: process.env.CANDLE_SOURCE ?? "kraken", balanceUsdc: formatUnits(balance, 6) }); }
  catch (e) { res.status(503).json({ error: (e as Error).message }); }
});
app.post("/v1/local-faucet", async (req, res) => { try { res.json(await localFaucet(platform, sessionOwner(req))); } catch (e) { res.status(400).json({ error: (e as Error).message }); } });
let compiler: InferenceProvider | undefined;
let compiling = false;
const requireConfigAuth = async (req: express.Request, action: ConfigAction, payload: unknown) => {
  const { owner, nonce, signature } = req.body ?? {};
  if (String(owner).toLowerCase() !== sessionOwner(req).toLowerCase()) throw new Error("Session wallet does not match owner");
  return definitions.authorize(owner, action, payload, nonce, signature);
};
app.get("/v1/strategy-templates", (_, res) => res.json(STRATEGY_TEMPLATES.map((t) => ({ ...t, config: templateConfig(t.id), liveSupported: false }))));
app.get("/v1/agent-definitions", (req, res) => {
  try { res.json(definitions.list(sessionOwner(req))); } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
app.post("/v1/config/challenge", (req, res) => {
  try { if (String(req.body.owner).toLowerCase() !== sessionOwner(req).toLowerCase()) throw new Error("Session wallet does not match owner"); res.json(definitions.challenge(req.body.owner, req.body.action, req.body.payload)); } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
app.post("/v1/agent-definitions", async (req, res) => {
  try {
    const owner = await requireConfigAuth(req, "create", req.body.payload);
    res.status(201).json(definitions.save(owner, req.body.payload));
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
app.put("/v1/agent-definitions/:id", async (req, res) => {
  try {
    const id = String(req.params.id);
    const owner = await requireConfigAuth(req, "update", { ...req.body.payload, id });
    if (platform.agents().some((a) => a.id === id)) {
      const current = definitions.get(id);
      if (JSON.stringify(current.config) !== JSON.stringify(req.body.payload.config) || current.name !== req.body.payload.name) throw new Error("This deployed agent's strategy is fixed. Create another agent to use different settings.");
    }
    res.json(definitions.save(owner, req.body.payload, id));
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
app.post("/v1/strategy/compile", async (req, res) => {
  try {
    await requireConfigAuth(req, "compile", req.body.payload);
    if (process.env.CONFIG_COMPILER_ENABLED !== "true") return void res.status(503).json({ error: "Strategy compiler is not enabled. Select and edit a template." });
    if (compiling) return void res.status(429).json({ error: "Compiler busy; retry later" });
    compiling = true;
    try {
      if (!compiler) {
        compiler = createStrategyCompiler({ maxTokensPerHour: 20000, maxTokensPerDay: 50000, stateFile: resolve(STATE, "openrouter-compiler-budget.json") });
      }
      res.json(await compileStrategy(compiler, req.body.payload?.prompt, req.body.payload?.profile));
    } finally { compiling = false; }
  } catch (e) { if (e instanceof ZeroGServiceError || e instanceof InferenceServiceError) res.status(e.status).json({ error: e.message, code: e.code, requestId: e.requestId }); else res.status(400).json({ error: (e as Error).message }); }
});

app.use("/v1/runtime", runtimeRouter(platform, definitions, sessionOwner, requireConfigAuth));

// Shared market observations are read back from the configured, owner-filtered Arkiv mirror.
app.get("/v1/market/status", (_, res) => {
  const path = resolve(STATE, "market-service-status.json");
  if (!existsSync(path)) return void res.status(503).json({ running: false, error: "Market mirror has not started" });
  const status = JSON.parse(readFileSync(path, "utf8"));
  res.json({ ...status, running: !status.stoppedAtMs && Date.now() - status.updatedAtMs < 60000, statusAgeMs: Date.now() - status.updatedAtMs });
});
app.get("/v1/market/:symbol/history", async (req, res) => {
  try { res.json(await marketHistory(String(req.params.symbol), Number(req.query.beforeMs ?? Date.now() + 1), Number(req.query.limit ?? 50))); }
  catch (e) { res.status(503).json({ error: safeMarketError(e) }); }
});
app.get("/v1/market/:symbol/candles", async (req, res) => {
  try { res.json(await marketCandles(String(req.params.symbol), Number(req.query.limit ?? 400))); }
  catch (e) { res.status(503).json({ error: safeMarketError(e) }); }
});
app.get("/v1/market/:symbol", async (req, res) => {
  try { res.json(await latestMarket(String(req.params.symbol))); }
  catch (e) { res.status(503).json({ error: safeMarketError(e) }); }
});

// ------------------------------------------------------------------------------------------- x402
if (PAY_TO) {
  const { paymentMiddleware, x402ResourceServer } = await import("@x402/express");
  const { HTTPFacilitatorClient } = await import("@x402/core/server");
  const { ExactEvmScheme } = await import("@x402/evm/exact/server");
  const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR })).register(NETWORK as any, new ExactEvmScheme());
  app.use(
    paymentMiddleware(
      {
        "POST /v1/signal": { accepts: [{ scheme: "exact", price: process.env.SIGNAL_PRICE ?? "$0.02", network: NETWORK as any, payTo: PAY_TO, maxTimeoutSeconds: 60 }], description: "Perpetua signal: asset, direction, confidence, entry/stop/target, 0G TEE chat ID" },
        "POST /v1/risk-check": { accepts: [{ scheme: "exact", price: process.env.RISK_CHECK_PRICE ?? "$0.005", network: NETWORK as any, payTo: PAY_TO, maxTimeoutSeconds: 60 }], description: "Deterministic CPPI/RiskGate check (no LLM), signed receipt on Arkiv" },
      } as any,
      server,
    ),
  );
  console.log(`[x402] paid routes on ${NETWORK} -> ${PAY_TO} via ${FACILITATOR}`);
} else {
  console.warn("[x402] X402_PAY_TO not set: paid routes run UNPAID in dev mode (responses carry x-perpetua-unpaid: dev)");
  app.use(["/v1/signal", "/v1/risk-check"], (_, res, next) => (res.setHeader("x-perpetua-unpaid", "dev"), next()));
}

const revenueFile = `${STATE}/x402-revenue.json`;
function recordRevenue(engine: "signals" | "risk_checks", usd: number, req: express.Request) {
  const rev = existsSync(revenueFile) ? JSON.parse(readFileSync(revenueFile, "utf8")) : { signals: 0, risk_checks: 0, forwarded: { signals: 0, risk_checks: 0 } };
  rev[engine] += usd;
  writeFileSync(revenueFile, JSON.stringify(rev, null, 2));
  const payment = req.header("payment-signature") ?? req.header("x-payment");
  appendFileSync(`${STATE}/x402-buyers.jsonl`, JSON.stringify({ at: Date.now(), engine, usd, payer: payerFrom(payment), unpaidDev: !PAY_TO }) + "\n");
}
function payerFrom(header?: string): string | null {
  if (!header) return null;
  try {
    const j = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    return j?.payload?.authorization?.from ?? j?.payload?.from ?? null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------- helpers
const readJson = (f: string, d: any) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : d);
const agentsOnDisk = () => readdirSync(STATE).filter((f) => f.startsWith("agent-") && f.endsWith(".json")).map((f) => f.slice(6, -5));
const signalsOf = (agent: string) => readJson(`${STATE}/signals-${agent}.json`, []) as any[];
const bigintJson = (o: unknown) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

async function currentInvestments(name: string) {
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(name)) throw new Error("Invalid agent name");
  const file = process.env.DEPLOYMENT_FILE ?? resolve(STATE, "../contracts/deployments/local-31337.json");
  const dep = readJson(file, null);
  if (!dep || !Object.hasOwn(dep, name)) throw new Error("Agent has no verified deployment");
  const a = typeof dep[name] === "string" ? JSON.parse(dep[name]) : dep[name];
  if (!a?.vault || !a?.riskGate || !a?.wallet) throw new Error("Agent has no verified deployment");
  const pub = createPublicClient({ transport: http(process.env.VAULT_RPC_URL ?? "http://127.0.0.1:8545") });
  const block = await pub.getBlock();
  const read = (address: Address, abi: any, functionName: string, args: any[] = []) => pub.readContract({ address, abi, functionName, args, blockNumber: block.number });
  const state = readJson(`${STATE}/agent-${name}.json`, { trades: {} });
  const flash = process.env.FLASH_MODE === "live" && FLASH_KEY ? new FlashHttp(FLASH_BASE, FLASH_KEY) : null;
  const local = process.env.FLASH_MODE === "sim" && await pub.getChainId() === 31337;
  const result = await investments(read, dep, a, Object.values(state.trades ?? {}), local ? async (token, amount) => Number(amount) * localPriceUsd(String(await pub.readContract({ address: token, abi: (await import("viem")).erc20Abi, functionName: "symbol" }))) : flash ? async (token, amount) => {
    const q = await flash.quote({ targetChain: process.env.FLASH_CHAIN ?? "base", contraChain: process.env.FLASH_CHAIN ?? "base", targetAsset: token, contraAsset: dep.usdc, side: "sell", qty: amount, orderType: "market", funderAddress: a.wallet, maxSlippage: "0.005" });
    if (!q.to || q.to.asset !== "contra") throw new Error("No USDC exit quote");
    return Number(q.to.amount);
  } : undefined);
  return { ...result, withdrawalPending: pendingWithdrawals(platform, name).length > 0, exitExecutionAvailable: local, chainId: await pub.getChainId(), blockNumber: block.number.toString(), observedAt: Number(block.timestamp) };
}
app.get("/v1/investments/:agent", requireAgentOwner, async (req, res) => {
  try { res.json(await currentInvestments(String(req.params.agent))); }
  catch (e) { res.status(503).json({ error: (e as Error).message }); }
});
app.post("/v1/investment-exit-requests", async (req, res) => {
  try {
    const payload = req.body.payload;
    const owner = await requireConfigAuth(req, "request-exit", payload);
    const current = await currentInvestments(payload?.agent);
    if (current.owner !== owner) throw new Error("This wallet does not own the agent");
    const position = current.investments.find((p) => p.kind === "spot" && p.token.toLowerCase() === String(payload.token).toLowerCase());
    if (!position || typeof payload.amount !== "string" || !/^\d{1,78}$/.test(payload.amount) || BigInt(payload.amount) > parseUnits(position.amount, position.decimals)) throw new Error("Exit amount exceeds current position");
    res.status(202).json(saveExitRequest(resolve(STATE, "withdrawal-requests"), owner, payload));
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

// ------------------------------------------------------------------------------------------- paid
app.post("/v1/signal", (req, res) => {
  const agent = String(req.body?.agent ?? req.query.agent ?? "Atlas");
  const asset = req.body?.asset as string | undefined;
  const list = signalsOf(agent).filter((s) => !asset || s.asset === asset).sort((a, b) => b.createdAt - a.createdAt);
  const s = list[0];
  if (!s) return void res.status(404).json({ error: "no signal on sale yet (the agent trades first, then sells)" });
  const keys = readJson(`${STATE}/arkiv-keys-${agent}.json`, {});
  recordRevenue("signals", 0.02, req);
  res.json({ ...s, arkivCommitmentKey: keys[`perpetua.signal.v1:${s.uid}`] ?? null, embargoUntilForFreeReaders: s.revealAt, proof: { "0gChatId": s.chatId, commitHash: s.commitHash } });
});

app.post("/v1/risk-check", async (req, res) => {
  const b = req.body ?? {};
  try {
    const big = (x: any) => BigInt(x ?? 0);
    const r: RiskCheckRequest = {
      mandate: { F: big(b.mandate?.F), C: big(b.mandate?.C), E: big(b.mandate?.E), validUntil: Number(b.mandate?.validUntil ?? 0), hibernating: !!b.mandate?.hibernating, halted: !!b.mandate?.halted, tradingOff: !!b.mandate?.tradingOff },
      m: big(b.m ?? 3),
      openExposure: big(b.openExposure),
      halfSize: !!b.halfSize,
      order: { amountIn: big(b.order?.amountIn), minAmountOut: big(b.order?.minAmountOut), assetDecimals: Number(b.order?.assetDecimals ?? 18), stopPriceE8: big(b.order?.stopPriceE8), takeProfitPriceE8: big(b.order?.takeProfitPriceE8), deadline: Number(b.order?.deadline ?? 0), recipient: String(b.order?.recipient ?? ""), expectedRecipient: String(b.order?.expectedRecipient ?? b.order?.recipient ?? ""), assetAllowed: b.order?.assetAllowed !== false },
      price: { priceE8: big(b.price?.priceE8), timestamp: Number(b.price?.timestamp ?? 0) },
      dailyVolBps: big(b.dailyVolBps ?? 500),
      now: Number(b.now ?? Math.floor(Date.now() / 1000)),
    };
    const verdict = checkEntry(r);

    // Optional: replay against a live RiskGate with eth_call (same logic, on-chain).
    let onchain: string | null = null;
    if (b.onchain?.riskGate && b.onchain?.rpc && b.onchain?.intent && b.onchain?.price) {
      const pub = createPublicClient({ transport: http(b.onchain.rpc) });
      const out = (await pub.readContract({ address: b.onchain.riskGate, abi: riskGateAbi, functionName: "checkOrder", args: [b.onchain.intent, b.onchain.price] })) as Hex;
      onchain = hexToString(out, { size: 32 }).replace(/\0/g, "");
    }

    // Counterparty calldata: resolve the selector through the Signature Atlas (discovery, not blind trust).
    let decoded: unknown = null;
    if (typeof b.calldata === "string" && b.calldata.length >= 10) {
      const sel = b.calldata.slice(0, 10).toLowerCase();
      decoded = await lookupSelector(sel, (process.env.ATLAS_IMPORTER_ADDRESS ?? CHECKER) as Address).catch((e) => ({ error: (e as Error).message }));
    }

    const requestHash = keccak256(toBytes(JSON.stringify(b)));
    const uid = `${requestHash.slice(0, 18)}:${Date.now()}`;
    const now = Math.floor(Date.now() / 1000);
    writer.enqueue({
      uid,
      schema: RiskCheckEntity,
      expiresInDays: EXPIRY_DAYS.riskCheck,
      values: {
        uid,
        checker: addr(CHECKER),
        requester: str128(payerFrom(req.header("payment-signature") ?? req.header("x-payment")) ?? String(b.requester ?? "anonymous")),
        asset: str128(String(b.asset ?? "unknown")),
        chain_id: u64(Number(b.chainId ?? 8453)),
        verdict: verdict === "OK" ? "pass" : "fail",
        reason_code: verdict,
        request_hash: requestHash,
        checked_at: u64(now),
        created_at: u64(now),
        payload: jsonBytes({ notional: b.order?.amountIn, cushion: b.mandate?.C, feedStalenessS: r.now - r.price.timestamp, onchain }),
      },
    });
    recordRevenue("risk_checks", 0.005, req);
    res.json({ verdict: verdict === "OK" ? "pass" : "fail", reason: verdict, onchainReplay: onchain, decodedCalldata: decoded, receipt: { uid, requestHash, checker: CHECKER, arkivSchema: "perpetua.risk-check.v1" } });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ------------------------------------------------------------------------------------------- free reads
app.get("/v1/agents", (_, res) => {
  const out = agentsOnDisk().map((name) => {
    const st = readJson(`${STATE}/agent-${name}.json`, {});
    const trades = Object.values(st.trades ?? {}) as any[];
    return { name, tier: st.tier, createdAt: st.createdAt, burnOgPerHour: st.burnOgPerHour, liveTrades: st.liveTrades, wins: st.wins, openTrades: trades.filter((t) => t.status === "open").length };
  });
  res.json(bigintJson(out));
});

/** Free tier: only signals whose 15-minute embargo has passed. */
app.get("/v1/signals", (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const agents = req.query.agent ? [String(req.query.agent)] : agentsOnDisk();
  const out = agents.flatMap((a) => signalsOf(a).filter((s) => now >= s.revealAt));
  res.json(out);
});

app.get("/v1/atlas/:selector", async (req, res) => {
  try {
    res.json(await lookupSelector(req.params.selector, (process.env.ATLAS_IMPORTER_ADDRESS ?? CHECKER) as Address));
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

app.get("/v1/feed", (_, res) => {
  const f = `${STATE}/posts.jsonl`;
  const lines = existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).slice(-50).map((l) => JSON.parse(l)) : [];
  res.json(lines.reverse());
});

/** Contract addresses + RPC for the Arena's direct on-chain reads (RiskGate mandates, vault NAV). */
app.get("/v1/deployment", (_, res) => {
  const file = process.env.DEPLOYMENT_FILE ?? resolve(STATE, "../contracts/deployments/local-31337.json");
  const dep = readJson(file, null);
  if (!dep) return void res.status(404).json({ error: "no deployment" });
  for (const k of ["Atlas", "Halcyon", "Ember"]) if (typeof dep[k] === "string") dep[k] = JSON.parse(dep[k]);
  res.json({ ...dep, rpc: process.env.PUBLIC_VAULT_RPC_URL ?? process.env.VAULT_RPC_URL ?? "http://127.0.0.1:8545", chainId: Number(process.env.VAULT_CHAIN_ID ?? 31337) });
});

/** Agent runtime state (trades, tier, burn) as published by the agent itself. Mirrors what it writes to Arkiv. */
app.get("/v1/state/:agent", requireAgentOwner, (req, res) => {
  const st = readJson(`${STATE}/agent-${req.params.agent}.json`, null);
  if (!st) return void res.status(404).json({ error: "unknown agent" });
  const now = Math.floor(Date.now() / 1000);
  // never leak an unrevealed signal's direction/prices through the free endpoint
  const signals = Object.values(st.signals ?? {}).map((s: any) => (now >= s.revealAt ? s : { uid: s.uid, asset: s.asset, createdAt: s.createdAt, commitHash: s.commitHash, revealAt: s.revealAt, status: "committed" }));
  const hidden = new Set(Object.values(st.signals ?? {}).filter((s: any) => now < s.revealAt).map((s: any) => s.uid));
  const trades = Object.values(st.trades ?? {}).map((t: any) => (hidden.has(t.signalUid) ? { ...t, entry: null, stop: null, target: null, embargoed: true } : t));
  res.json({ ...st, signals, trades });
});

app.get("/v1/evidence", (_, res) => res.json(readJson(`${STATE}/evidence.json`, { note: "run `pnpm demo` to generate" })));

app.get("/v1/outbox", (_, res) => {
  const f = `${STATE}/arkiv-outbox.jsonl`;
  const lines = existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).slice(-500).map((l) => JSON.parse(l)) : [];
  res.json(lines);
});

// ------------------------------------------------------------------------------------------- copy trading
/**
 * Follower copy: the app builds the SAME order type for the follower, scaled to their cap, with the integrator
 * fee pointing at the agent's Flash portfolio. Followers keep custody: they sign with their own wallet (or a
 * scoped EIP-1271 session key) and the order is funded from THEIR address.
 */
app.post("/v1/copy/quote", async (req, res) => {
  const { agent = "Atlas", follower, capUsd, targetAsset, contraAsset } = req.body ?? {};
  if (!follower || !capUsd) return void res.status(400).json({ error: "follower and capUsd required" });
  const cap = Math.min(Number(capUsd), Number(process.env.COPY_MAX_USD ?? 100)); // follower safety cap
  const st = readJson(`${STATE}/agent-${agent}.json`, { trades: {} });
  const t = (Object.values(st.trades) as any[]).filter((x) => x.status === "open").sort((a, b) => b.openedAt - a.openedAt)[0];
  if (!t) return void res.status(404).json({ error: "agent has no open trade to copy" });
  const body = {
    targetChain: process.env.FLASH_CHAIN ?? "base",
    contraChain: process.env.FLASH_CHAIN ?? "base",
    targetAsset: targetAsset ?? process.env.COPY_TARGET_ASSET,
    contraAsset: contraAsset ?? process.env.COPY_CONTRA_ASSET ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    side: "buy",
    qty: Math.min(cap, t.sizeUsd).toFixed(2),
    orderType: "market",
    funderAddress: follower,
    maxSlippage: "0.01",
    attachedBracket: { takeProfit: { notionalPrice: Number(t.target).toFixed(6) }, stopLoss: { notionalPrice: Number(t.stop).toFixed(6) } },
    flashIntegratorFeeBps: process.env.FLASH_INTEGRATOR_FEE_BPS ?? "20",
  };
  if (!FLASH_KEY) return void res.json({ simulated: true, request: body, note: "set FLASH_API_KEY for a live Flash quote" });
  const r = await fetch(`${FLASH_BASE}/quote`, { method: "POST", headers: { "x-definitive-api-key": FLASH_KEY, "content-type": "application/json" }, body: JSON.stringify(body) });
  res.status(r.status).json({ request: body, quote: await r.json() });
});

app.post("/v1/copy/order", async (req, res) => {
  const { order, agent = "Atlas" } = req.body ?? {};
  if (!order?.userSignature) return void res.status(400).json({ error: "signed order required" });
  order.flashIntegratorFeeBps = process.env.FLASH_INTEGRATOR_FEE_BPS ?? "20"; // must equal the quote's
  appendFileSync(`${STATE}/copy-orders.jsonl`, JSON.stringify({ at: Date.now(), agent, follower: order.funderAddress, qty: order.qty }) + "\n");
  if (!FLASH_KEY) return void res.json({ simulated: true, orderId: crypto.randomUUID() });
  const r = await fetch(`${FLASH_BASE}/order`, { method: "POST", headers: { "x-definitive-api-key": FLASH_KEY, "content-type": "application/json" }, body: JSON.stringify(order) });
  res.status(r.status).json(await r.json());
});

app.get("/health", (_, res) => void res.json({ ok: true, paid: !!PAY_TO, network: NETWORK, inference: { backend: INFERENCE_BACKEND, testingOnly: INFERENCE_BACKEND === "openrouter" } }));

app.listen(PORT, () => console.log(`[api] http://localhost:${PORT}  (state ${STATE})`));
startLocalRuntime(platform, definitions);

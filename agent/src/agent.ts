/**
 * The Perpetua agent loop. Money path first, AI last:
 *
 *   read runway -> pick tier (metabolism) -> feed (treasury -> 0G ledger) -> cheap wake filter
 *   -> [LLM on 0G only if woken AND the tier allows it] -> deterministic signal + sizing
 *   -> Flash quote -> RiskGate.approveOrder (TEE proof attached) -> EIP-1271 sign -> Flash /order
 *   -> Arkiv records + X post -> signal goes on sale only after our own order is placed.
 *
 * The LLM proposes; RiskGate disposes. Nothing here can move vault funds: the proposer key can only propose.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ArkivWriter } from "@perpetua/arkiv";
import {
  OrderKind,
  costPlusMgmtFee,
  flashDigest,
  generateSignal,
  last,
  perpetuaVaultAbi,
  pickModel,
  capitalModelPolicy,
  rollingDailyVol,
  runwayHours,
  shouldWake,
  sizePosition,
  tierFor,
  type Bar,
  type MandateView,
  type OrderIntent,
  type PriceAttestation,
  type Signal,
  type TierPolicy,
} from "@perpetua/core";
import { erc20Abi, keccak256, parseUnits, toBytes, toHex, zeroHash, type Address, type Hex } from "viem";
import { clients, type Clients } from "./chain";
import type { AssetCfg, Config } from "./config";
import { FlashHttp, FlashSim, approvalSpender, type FlashBackend, type QuoteResponse } from "./flash";
import { fetchBars4h, fundingRate8h, headlines, syntheticBars } from "./market";
import { PriceAttestor } from "./prices";
import { Records } from "./records";
import { Gate, Treasury } from "./riskgate";
import { SimSettlement } from "./simSettlement";
import { XPoster } from "./social";
import { SimBrain, ZeroGBrain, type Brain, type BrainResult } from "./zerog";
import { ZeroGRouterBrain, routerCapitalPolicy } from "./zerog-router";
import { createComputeFundingController, type ComputeFundingController } from "./compute-funding";

const REVEAL_DELAY_S = 15 * 60;
const stateDir = () => process.env.PERPETUA_STATE_DIR ?? ".perpetua";

interface SignalRecord {
  uid: string;
  asset: string;
  createdAt: number;
  commitHash: Hex;
  salt: Hex;
  revealAt: number;
  revealed: boolean;
  ownOrderPlacedAt?: number;
  signal: Signal;
  hidden: Record<string, unknown>;
  chatId?: string;
}

interface TradeRecord {
  uid: string;
  signalUid: string;
  asset: string;
  status: "open" | "closed";
  openedAt: number;
  sizeUsd: number;
  entry: number;
  stop: number;
  target: number;
  qty: bigint | string;
  flashOrderId: string;
  approvalTx: Hex;
}

interface AgentState {
  createdAt: number;
  tier: string;
  lastThought: number;
  lastBarT: Record<string, number>;
  lastEpoch: string;
  burnOgPerHour: number;
  liveTrades: number;
  wins: number;
  consecutiveLosses: number;
  lastIncomeBlock: string;
  signals: Record<string, SignalRecord>;
  trades: Record<string, TradeRecord>;
  lastLedgerOg?: number;
  lastRunwayH?: number | null;
  sleeping?: boolean;
  computeSpend?: { day: string; og: number; unsettled: boolean };
  computeFunding?: { action: string; reason: string; updatedAtMs: number; allowNewTrades: boolean };
}

export class PerpetuaAgent {
  readonly vc: Clients; // vault chain, proposer key
  readonly gate: Gate;
  readonly flash: FlashBackend;
  readonly attestor: PriceAttestor;
  readonly brain: Brain;
  readonly treasury: Treasury;
  readonly writer: ArkivWriter;
  readonly records: Records;
  readonly x: XPoster;
  readonly sim?: SimSettlement;
  private state: AgentState;
  private bars = new Map<string, Bar[]>();
  private priceCache = new Map<string, number>();
  private readonly stateFile: string;
  private computeFunding?: ComputeFundingController;

  constructor(
    readonly cfg: Config,
    brain: Brain,
  ) {
    this.vc = clients(cfg.vaultRpc, cfg.vaultChainId, cfg.proposerKey);
    this.gate = new Gate(this.vc, cfg.riskGate, cfg.vault, cfg.wallet);
    this.flash =
      cfg.flash.mode === "live"
        ? new FlashHttp(cfg.flash.baseUrl, cfg.flash.apiKey)
        : new FlashSim((asset) => this.priceCache.get(asset.toLowerCase()) ?? 15, cfg.vaultChainId);
    this.attestor = new PriceAttestor(cfg.priceSignerKey, cfg.vaultChainId, cfg.riskGate, this.flash, cfg.flash.chain, cfg.usdc);
    this.brain = brain;
    const tc = clients(cfg.treasuryRpc, cfg.treasuryChainId, cfg.zeroG.privateKey);
    this.treasury = new Treasury(tc, cfg.computeTreasury, cfg.agentId);
    this.writer = new ArkivWriter(cfg.agentName, { privateKey: process.env.ARKIV_PRIVATE_KEY as Hex | undefined });
    this.records = new Records(this.writer, this.vc.account.address, cfg.agentName);
    this.x = new XPoster(cfg.agentName, cfg.x.userToken);
    if (cfg.flash.mode === "sim" && process.env.FLASH_SPENDER_PRIVATE_KEY) {
      this.sim = new SimSettlement(clients(cfg.vaultRpc, cfg.vaultChainId, process.env.FLASH_SPENDER_PRIVATE_KEY as Hex));
    }
    mkdirSync(stateDir(), { recursive: true });
    this.stateFile = `${stateDir()}/agent-${cfg.agentName}.json`;
    this.state = existsSync(this.stateFile)
      ? JSON.parse(readFileSync(this.stateFile, "utf8"))
      : { createdAt: Math.floor(Date.now() / 1000), tier: "thrive", lastThought: 0, lastBarT: {}, lastEpoch: "0", burnOgPerHour: 0.02, liveTrades: 0, wins: 0, consecutiveLosses: 0, lastIncomeBlock: "0", signals: {}, trades: {} };
  }

  static async create(cfg: Config) {
    const brain: Brain =
      cfg.zeroG.mode === "router"
        ? new ZeroGRouterBrain({ ...cfg.zeroG, stateFile: `${stateDir()}/0g-router-${cfg.agentName}-budget.json`, providerSort: process.env.ZG_PROVIDER_SORT, maxPromptUsdPerMillion: process.env.ZG_MAX_PROMPT_USD_PER_MILLION, maxCompletionUsdPerMillion: process.env.ZG_MAX_COMPLETION_USD_PER_MILLION, disable0gmThinking: process.env.ZG_0GM_DISABLE_THINKING === "true" })
        : cfg.zeroG.mode === "live"
        ? await new ZeroGBrain({ ...cfg.zeroG, initializeLedger: false }).init()
        : new SimBrain({
            startOg: cfg.zeroG.simStartOg,
            costOg: { large: cfg.zeroG.costPerCallUsd.large / cfg.zeroG.ogPriceUsd, small: cfg.zeroG.costPerCallUsd.small / cfg.zeroG.ogPriceUsd },
            maxTokensPerHour: cfg.zeroG.maxTokensPerHour,
            maxTokensPerDay: cfg.zeroG.maxTokensPerDay,
          });
    const agent = new PerpetuaAgent(cfg, brain);
    if (brain.mode === "live") agent.computeFunding = await createComputeFundingController(cfg);
    return agent;
  }

  private save() {
    writeFileSync(this.stateFile, JSON.stringify(this.state, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    // Signals that are on sale (own order placed first) for the x402 API to serve.
    const forSale = Object.values(this.state.signals)
      .filter((s) => s.ownOrderPlacedAt)
      .map((s) => ({ uid: s.uid, agent: this.vc.account.address, agentName: this.cfg.agentName, asset: s.asset, createdAt: s.createdAt, revealAt: s.revealAt, commitHash: s.commitHash, chatId: s.chatId, ...s.hidden }));
    writeFileSync(`${stateDir()}/signals-${this.cfg.agentName}.json`, JSON.stringify(forSale, null, 2));
  }

  private async blockTime(): Promise<bigint> {
    return (await this.vc.pub.getBlock()).timestamp;
  }

  // ======================================================================= metabolism

  async runway(): Promise<{ hours: number; ledgerOg: number; policy: TierPolicy }> {
    if (this.brain.fundingMode === "router") {
      const capital = Number((await this.gate.vaultState()).totalAssets) / 1e6;
      const config = this.cfg.strategyConfig;
      return { hours: NaN, ledgerOg: NaN, policy: config ? routerCapitalPolicy(config, capital) : { ...tierFor(72) } };
    }
    const ledgerOg = await this.brain.ledgerOg();
    const burn = Math.max(this.state.burnOgPerHour, 1e-6) * this.cfg.zeroG.burnAcceleration;
    const spendable = runwayHours({ ledgerBalanceOg: ledgerOg, reserveOg: this.cfg.zeroG.reserveOg, burnOgPerHour: burn });
    // R may only be spent below Frugal: if spendable runway already says starving, count the reserve.
    let hours = spendable;
    if (tierFor(spendable).tier === "starving" || tierFor(spendable).tier === "hibernate") {
      hours = runwayHours({ ledgerBalanceOg: ledgerOg, reserveOg: this.cfg.zeroG.reserveOg, burnOgPerHour: burn, includeReserve: true });
    }
    return { hours, ledgerOg, policy: tierFor(hours) };
  }

  private recordSpend(og: number, hoursElapsed: number) {
    // EWMA of OG burned per hour (real inference spend + baseline), the denominator of runway.
    const rate = hoursElapsed > 0 ? og / hoursElapsed : og;
    this.state.burnOgPerHour = 0.8 * this.state.burnOgPerHour + 0.2 * Math.max(rate, 0.005);
  }

  /** Feeding: CCIP-delivered 0G sits in ComputeTreasury; pull it (within the daily cap) and fund the ledger. */
  async feed(): Promise<number> {
    // Live funding belongs to the durable controller; never drain a treasury outside its reservation.
    if (this.brain.mode === "live") return 0;
    if (this.brain.fundingMode === "router") return 0; // Direct-ledger funds cannot be deposited into Router.
    let bal: bigint;
    try {
      bal = await this.treasury.balance();
    } catch {
      return 0;
    }
    if (bal === 0n) return 0;
    const { hash } = await this.treasury.withdrawForLedger(bal);
    const og = Number(bal) / 1e18;
    const dep = await this.brain.depositOg(og);
    console.log(`[feed] +${og.toFixed(4)} 0G  treasury tx ${hash}  ledger ${dep}`);
    this.records.ledger("compute_topup", Math.floor(Date.now() / 3_600_000), og * this.cfg.zeroG.ogPriceUsd, { treasuryTx: hash, ledgerDeposit: dep, og });
    return og;
  }

  // ======================================================================= market

  private async loadBars(a: AssetCfg): Promise<Bar[]> {
    let bars: Bar[];
    try {
      bars = this.cfg.candleSource === "synthetic" ? syntheticBars(400, a.symbol === "BTC" ? 65000 : a.symbol === "ETH" ? 2500 : 15) : await fetchBars4h({ ...a, source: this.cfg.candleSource, limit: 400 });
    } catch (e) {
      if (this.cfg.flash.mode === "live" || this.cfg.candleSource === "arkiv") throw e;
      bars = syntheticBars(400);
    }
    this.bars.set(a.symbol, bars);
    this.priceCache.set(a.address.toLowerCase(), last(bars).c);
    return bars;
  }

  async attestAll(held?: boolean): Promise<PriceAttestation[]> {
    const now = await this.blockTime();
    const out: PriceAttestation[] = [];
    for (const a of this.cfg.assets) {
      if (held) {
        const bal = await this.vc.pub.readContract({ address: a.address, abi: erc20Abi, functionName: "balanceOf", args: [this.cfg.wallet] });
        if (bal === 0n) continue;
      }
      if (!this.priceCache.has(a.address.toLowerCase())) await this.loadBars(a);
      const p = this.cfg.flash.mode === "live" ? undefined : this.priceCache.get(a.address.toLowerCase());
      const { priceUsd, ...att } = await this.attestor.attest(a, p, now);
      out.push(att);
    }
    return out;
  }

  // ======================================================================= the tick

  async tick(opts: { forceThink?: boolean } = {}) {
    const flags = await this.gate.flags();
    this.state.sleeping = flags.withdrawalPaused;
    if (flags.withdrawalPaused) {
      // User sleep is independent of financial runway: do not top up compute, burn or ask a model.
      this.state.tier = "hibernate";
      this.save();
      return { tier: "hibernate", runwayH: this.state.lastRunwayH ?? 0, ledgerOg: this.state.lastLedgerOg ?? 0, woke: { wake: false, reason: "owner withdrawal sleep" }, mandate: await this.gate.mandate() };
    }
    const t0 = Math.floor(Date.now() / 1000);
    const hoursSince = (t0 - (this.state.lastThought || t0)) / 3600;

    // 1. metabolism
    if (this.brain.mode === "live") {
      this.state.computeFunding = this.computeFunding ? await this.computeFunding.tick() : {
        action: "wait", reason: "compute_funding_adapter_required", updatedAtMs: Date.now(), allowNewTrades: false,
      };
      this.save();
    }
    await this.feed();
    if (this.brain instanceof SimBrain) this.brain.burn(this.state.burnOgPerHour * this.cfg.zeroG.burnAcceleration * (this.cfg.tickSeconds / 3600));
    const rw = await this.runway();
    if (rw.policy.tier !== this.state.tier) await this.onTierChange(this.state.tier, rw.policy.tier, rw.hours);
    this.state.lastLedgerOg = rw.ledgerOg;
    this.state.lastRunwayH = Number.isFinite(rw.hours) ? rw.hours : null;

    // 2. risk picture (on-chain, never the agent's own number)
    const mandate = await this.gate.mandate();
    const mandateChanged = mandate.epoch.toString() !== this.state.lastEpoch;
    if (mandateChanged) {
      this.state.lastEpoch = mandate.epoch.toString();
      this.records.mandate(this.cfg.riskGate, mandate);
    }

    // 3. reveal signals whose embargo ended; keep stops alive
    await this.revealDue();
    await this.ensureStops(rw.policy);

    // 4. cheap wake filter
    let wake = { wake: false, reason: "no configured asset needs evaluation" };
    if (rw.policy.closesRiskyPositions) await this.closeRiskyPositions();
    else for (const a of this.cfg.assets) {
      const prevBarT = this.state.lastBarT[a.symbol] ?? 0;
      const bars = await this.loadBars(a);
      const newBar = last(bars).t !== prevBarT;
      this.state.lastBarT[a.symbol] = last(bars).t;
      const vol = rollingDailyVol(bars.map((b) => b.c), 180);
      const volSpike = last(vol) > 1.5 * (vol.slice(-60).reduce((s, x) => s + (x || 0), 0) / 60);
      const assetWake = opts.forceThink ? { wake: true, reason: "forced" } : shouldWake({ newBarClosed: newBar, volSpike, crossedLevel: false, mandateChanged, hoursSinceLastThought: hoursSince });
      if (assetWake.wake) wake = assetWake;
      if (volSpike && !flags.halfSize) await this.gate.setRuntimeFlags(flags.halfSize, true).catch(() => {});
      // Refresh the mandate between assets so each entry uses the remaining shared exposure budget.
      if (assetWake.wake && !rw.policy.managesPositionsOnly && (this.brain.mode === "sim" || this.state.computeFunding?.allowNewTrades === true)) await this.think(a, bars, rw.policy, await this.gate.mandate(), await this.gate.flags());
    }

    // 5. income rollup + heartbeat
    await this.indexIncome();
    const closed = Object.values(this.state.trades).filter((t) => t.status === "closed").length;
    this.records.heartbeat({
      name: this.cfg.agentName,
      strategy: this.cfg.strategy,
      status: "alive",
      tier: rw.policy.tier,
      riskTier: ["conservative", "balanced", "aggressive"][flags.riskTier],
      runwayH: rw.hours,
      mandate,
      followers: Number(process.env.FOLLOWERS ?? 0),
      winRate: closed ? this.state.wins / closed : 0,
      brier: 0.25,
      createdAt: this.state.createdAt,
      meta: { vault: this.cfg.vault, riskGate: this.cfg.riskGate, wallet: this.cfg.wallet, chain: this.cfg.vaultChainId, ledgerOg: rw.ledgerOg, burnOgPerHour: this.state.burnOgPerHour, hibernating: flags.hibernating, caps: this.brain.caps(), fundingMode: this.brain.fundingMode ?? "ledger", runwayKnown: Number.isFinite(rw.hours) },
    });
    this.save();
    return { tier: rw.policy.tier, runwayH: rw.hours, ledgerOg: rw.ledgerOg, woke: wake, mandate };
  }

  private async onTierChange(from: string, to: string, hours: number) {
    this.state.tier = to;
    const days = (hours / 24).toFixed(1);
    const msg =
      this.brain.fundingMode === "router" ? `Router compute policy: ${to}. Account balance and runway are unavailable to this inference key.` :
      to === "starving"
        ? `I'm hungry. Runway ${days} days. Switching to rules-only and managing open positions. Feed me: copy a trade or buy a signal.`
        : to === "hibernate"
          ? `Hibernating. Everything back to the safe leg; stops stay live on-chain. I wake when income lands.`
          : `Tier ${from} -> ${to}. ${this.cfg.agentName} has ${days} days of thinking left.`;
    await this.x.post(msg, { arena: `${this.cfg.x.arenaUrl}/agent/${this.cfg.agentName}` });
    this.records.decision({ uid: `tier:${Date.now()}`, decision: "tier_change", model: "rules", tier: to, input: from, output: to, chatId: "", teeVerified: false, costOg: 0, meta: { hours } });
  }

  // ======================================================================= thinking + proposing

  private async sentiment(a: AssetCfg, policy: TierPolicy, exposureUsd: number): Promise<{ result: BrainResult | null; score: number; reasons: string[] }> {
    if (this.cfg.strategyConfig) {
      const capital = Number((await this.gate.vaultState()).totalAssets) / 1e6;
      const selected = this.brain.fundingMode === "router" ? routerCapitalPolicy(this.cfg.strategyConfig, capital) : capitalModelPolicy(this.cfg.strategyConfig, capital, await this.brain.ledgerOg());
      policy = { ...policy, model: !policy.model ? null : policy.model === "small" && selected.model === "large" ? "small" : selected.model };
    }
    const day = new Date().toISOString().slice(0, 10);
    if (this.state.computeSpend?.day !== day) this.state.computeSpend = { day, og: 0, unsettled: false };
    if (this.cfg.strategyConfig && (this.state.computeSpend.unsettled || this.state.computeSpend.og >= this.cfg.strategyConfig.compute.maxDailySpendOg)) return { result: null, score: 0, reasons: ["daily compute budget exhausted or settlement unknown"] };
    const models = [
      { id: "small", tier: "small" as const, estCostUsdPerCall: this.cfg.zeroG.costPerCallUsd.small },
      { id: "large", tier: "large" as const, estCostUsdPerCall: this.cfg.zeroG.costPerCallUsd.large },
    ];
    const pick = pickModel({ decision: "trade_proposal", exposureUsd, policy, models, multiple: 20 });
    if (!pick) return { result: null, score: 0, reasons: ["router: decision not worth an LLM call"] };
    const hl = this.cfg.candleSource === "synthetic" ? [] : await headlines(a.symbol, policy.tier === "thrive" ? 12 : 5).catch(() => []);
    const pol = { ...policy, model: pick.tier === "large" ? ("large" as const) : ("small" as const) };
    const t0 = Date.now();
    const result = await this.brain.think(
      pol,
      [
        { role: "system", content: "You are a crypto market sentiment scorer. Reply with JSON only: {\"sentiment\": number in [-1,1], \"reasons\": string[] (max 3)}. Never recommend trade sizes." },
        { role: "user", content: `Asset: ${a.symbol}. Headlines:\n${hl.map((h) => `- ${h}`).join("\n") || "(none)"}` },
      ],
      policy.tier === "thrive" ? 300 : 120,
    ).catch((e) => {
      console.warn("[0g] think failed:", (e as Error).message);
      return null;
    });
    if (!result) return { result: null, score: 0, reasons: ["no LLM result (cap/tier/provider)"] };
    this.state.computeSpend!.og += Number.isFinite(result.costOg) && result.costOg > 0 ? result.costOg : 0;
    this.state.computeSpend!.unsettled ||= !Number.isFinite(result.costOg) || result.costOg <= 0;
    this.save();
    if (Number.isFinite(result.costOg) && result.costOg > 0) this.recordSpend(result.costOg, Math.max((Date.now() - t0) / 3.6e6, this.cfg.tickSeconds / 3600));
    let score = 0;
    let reasons: string[] = [];
    try {
      const j = JSON.parse(result.content.replace(/```json|```/g, "").trim());
      score = Math.max(-1, Math.min(1, Number(j.sentiment) || 0));
      reasons = Array.isArray(j.reasons) ? j.reasons.slice(0, 3).map(String) : [];
    } catch {
      reasons = ["unparseable model output: sentiment treated as 0"];
    }
    this.records.decision({
      uid: `dec:${result.chatId}`,
      decision: "trade_proposal",
      model: result.model,
      tier: policy.tier,
      input: hl.join("\n"),
      output: result.content,
      chatId: result.chatId,
      teeVerified: result.verified === true,
      costOg: result.costOg,
      meta: { provider: result.provider, tokens: result.tokens, teeSigner: result.tee?.signer },
    });
    return { result, score, reasons };
  }

  private async think(a: AssetCfg, bars: Bar[], policy: TierPolicy, mandate: MandateView, flags: Awaited<ReturnType<Gate["flags"]>>) {
    this.state.lastThought = Math.floor(Date.now() / 1000);
    const C = Number(mandate.C) / 1e6;
    const E = Number(mandate.E) / 1e6;
    const open = Number(mandate.riskyValue) / 1e6;
    const options = { kind: this.cfg.strategy, m: flags.multiplier, ...this.cfg.strategyConfig?.parameters };
    const prelim = generateSignal({ asset: a.symbol, bars }, options);
    const stopPct = (prelim.entry - prelim.stop) / prelim.entry;
    const prelimSize = sizePosition({ cushionUsd: C, exposureBudgetUsd: E, openExposureUsd: open, stopDistancePct: stopPct, sizeMultiplier: Math.max(prelim.sizeMultiplier, 0.5), liveTrades: this.state.liveTrades, halfSize: flags.halfSize || this.state.consecutiveLosses >= 3 });

    const s = await this.sentiment(a, policy, prelimSize);
    const [btc, eth] = await Promise.all([
      fetchBars4h({ krakenPair: "XBTUSD", binanceSymbol: "BTCUSDT", source: this.cfg.candleSource }).catch(() => undefined),
      fetchBars4h({ krakenPair: "ETHUSD", binanceSymbol: "ETHUSDT", source: this.cfg.candleSource }).catch(() => undefined),
    ]);
    const signal = generateSignal(
      { asset: a.symbol, bars, btcBars: btc, ethBars: eth, fundingRate8h: this.cfg.candleSource === "synthetic" ? undefined : await fundingRate8h(a.binanceSymbol), sentiment: s.result ? { score: s.score, reasons: s.reasons } : null },
      options,
    );
    console.log(`[signal] ${a.symbol} ${signal.direction} score=${signal.score.toFixed(3)} conf=${signal.confidence.toFixed(2)} ${signal.rejectedBy ?? ""}`);
    if (signal.direction !== "long" || !s.result?.tee) {
      if (signal.direction === "long" && s.result && this.brain.fundingMode === "router") console.log("[0g] Router analysis recorded; a raw signer-bound TEE proof is required before RiskGate can authorize an order");
      return;
    }

    let size = sizePosition({ cushionUsd: C, exposureBudgetUsd: E, openExposureUsd: open, stopDistancePct: (signal.entry - signal.stop) / signal.entry, sizeMultiplier: signal.sizeMultiplier, liveTrades: this.state.liveTrades, halfSize: flags.halfSize || this.state.consecutiveLosses >= 3 });
    if (this.cfg.strategyConfig) {
      const r = this.cfg.strategyConfig.risk;
      size = Math.min(size, Math.max(0, r.maxNotionalUsd - open), Number(mandate.V) / 1e6 * r.maxMarginPct / 100, Number(mandate.V) / 1e6 * r.riskPerTradePct / 100 / Math.max(1e-9, (signal.entry - signal.stop) / signal.entry));
    }
    if (size < 1) return void console.log(`[size] ${size.toFixed(2)} USDC below minimum: no trade`);
    await this.proposeEntry(a, signal, size, s.result);
  }

  async proposeEntry(a: AssetCfg, signal: Signal, sizeUsd: number, brain: BrainResult) {
    const uid = `${this.cfg.agentName}:${a.symbol}:${Date.now()}`;
    const q = await this.flash.quote({
      targetChain: this.cfg.flash.chain,
      contraChain: this.cfg.flash.chain,
      targetAsset: a.address,
      contraAsset: this.cfg.usdc,
      side: "buy",
      qty: sizeUsd.toFixed(2),
      orderType: signal.orderType,
      funderAddress: this.cfg.wallet,
      maxSlippage: "0.005",
      ...(signal.orderType === "limit" ? { limitNotionalPrice: signal.entry.toFixed(6) } : {}),
      attachedBracket: { takeProfit: { notionalPrice: signal.target.toFixed(6) }, stopLoss: { notionalPrice: signal.stop.toFixed(6) } },
      // The agent never charges itself the integrator fee; followers' mirrored orders carry it.
    });
    const result = await this.gateAndSubmit(a, q, signal, sizeUsd, brain, uid);
    if (!result.ok) return result;

    // Trade first, sell after: only now does the signal go on sale (paying agents now, free Arena +15 min).
    const hidden = { direction: signal.direction, confidence: signal.confidence, regime: signal.regime, entry: signal.entry, stop: signal.stop, target: signal.target, reasons: signal.reasons, flashOrderId: result.orderId, chatId: brain.chatId };
    const { commitHash, salt } = this.records.commitSignal(uid, signal, this.cfg.vaultChainId, hidden);
    const now = Math.floor(Date.now() / 1000);
    this.state.signals[uid] = { uid, asset: a.symbol, createdAt: now, commitHash, salt, revealAt: now + REVEAL_DELAY_S, revealed: false, ownOrderPlacedAt: now, signal, hidden, chatId: brain.chatId };
    this.state.liveTrades++;
    const cushionX = (sizeUsd / Math.max(1, Number((await this.gate.mandate()).C) / 1e6)).toFixed(1);
    const rw = await this.runway();
    await this.x.post(
      `Opened ${a.symbol} long, ${cushionX}x cushion, stop at -${(((signal.entry - signal.stop) / signal.entry) * 100).toFixed(1)}%. Runway ${(rw.hours / 24).toFixed(1)} days. Copy me: ${this.cfg.x.arenaUrl}/agent/${this.cfg.agentName}`,
      { tx: result.approvalTx, flash: result.orderId, "0g": brain.chatId },
    );
    this.save();
    return result;
  }

  /** Quote -> intent -> RiskGate.approveOrder -> EIP-1271 signature -> Flash /order. */
  async gateAndSubmit(a: AssetCfg, q: QuoteResponse, signal: Signal, sizeUsd: number, brain: BrainResult, uid: string, opts: { unsafe?: boolean } = {}) {
    if (!q.evm?.orderTypedData) throw new Error("quote has no EVM typed data");
    const digest = flashDigest(q.evm.orderTypedData);
    const bracketTd = q.attachedBracket?.evm?.orderTypedData;
    const bracketDigest = bracketTd ? flashDigest(bracketTd) : zeroHash;
    const spender = approvalSpender(q);
    if (spender) console.log(`[flash] quote asks to approve ${spender} (AgentWallet.flashSpender must match: day-one check)`);

    const priceUsd = sizeUsd / Number(q.to?.amount ?? 1);
    const now = await this.blockTime();
    const { priceUsd: _p, ...px } = await this.attestor.attest(a, this.cfg.flash.mode === "live" ? Number(q.to!.notional) / Number(q.to!.amount) : this.priceCache.get(a.address.toLowerCase()), now);
    const mandate = await this.gate.mandate();
    const minOut = parseUnits((Number(q.to!.amount) * 0.995).toFixed(a.decimals > 8 ? 8 : a.decimals), a.decimals);
    const intent: OrderIntent = {
      flashDigest: digest,
      bracketDigest,
      kind: OrderKind.Entry,
      tokenIn: this.cfg.usdc,
      tokenOut: a.address,
      amountIn: parseUnits(sizeUsd.toFixed(6), 6),
      minAmountOut: minOut,
      stopPriceE8: BigInt(Math.round(signal.stop * 1e8)),
      takeProfitPriceE8: BigInt(Math.round(signal.target * 1e8)),
      deadline: BigInt(Math.min(Number(now) + 3600, Number(mandate.validUntil))),
      recipient: this.cfg.wallet,
    };
    const proof = { chatIdHash: keccak256(toBytes(brain.chatId)), response: toHex(toBytes(brain.tee!.text)), signature: brain.tee!.signature };

    let approvalTx: Hex | undefined;
    if (opts.unsafe) {
      const r = await this.gate.approveOrderUnsafe(intent, px, proof);
      console.log(`[gate] reckless proposal tx ${r.hash} status=${r.receipt.status}`);
      return { ok: false as const, reason: r.receipt.status === "reverted" ? "REVERTED_ON_CHAIN" : "UNEXPECTED_SUCCESS", txHash: r.hash };
    }
    const g = await this.gate.approveOrder(intent, px, proof);
    if (!g.ok) {
      console.log(`[gate] RiskGate rejected: ${g.reason}`);
      this.records.decision({ uid: `rej:${uid}`, decision: "order_rejected", model: brain.model, tier: this.state.tier, input: JSON.stringify(intent, (_, v) => (typeof v === "bigint" ? v.toString() : v)), output: g.reason, chatId: brain.chatId, teeVerified: brain.verified === true, costOg: 0, meta: { digest } });
      return { ok: false as const, reason: g.reason };
    }
    approvalTx = g.txHash;

    // EIP-1271: the wallet's "signature" is the proposer's ECDSA over the digest; Flash calls
    // AgentWallet.isValidSignature(digest, sig), which only passes because RiskGate approved the digest.
    const userSignature = await this.vc.account.sign!({ hash: digest });
    const bracketSignature = bracketTd ? await this.vc.account.sign!({ hash: bracketDigest }) : undefined;
    const ok1271 = await this.gate.isValidSignature(digest, userSignature);
    if (ok1271 !== "0x1626ba7e") throw new Error("AgentWallet refused to sign an approved digest (unexpected)");

    const sub = await this.flash.order({
      targetChain: this.cfg.flash.chain,
      contraChain: this.cfg.flash.chain,
      targetAsset: a.address,
      contraAsset: this.cfg.usdc,
      side: "buy",
      qty: sizeUsd.toFixed(2),
      orderType: signal.orderType,
      ...(signal.orderType === "limit" ? { limitNotionalPrice: signal.entry.toFixed(6) } : {}),
      maxSlippage: "0.005",
      funderAddress: this.cfg.wallet,
      quoteId: q.quoteId,
      userSignature,
      evmOrderTypedData: q.evm.orderTypedData,
      ...(this.cfg.flash.attributionCode ? { erc8021AttributionCode: this.cfg.flash.attributionCode } : {}),
      ...(bracketTd
        ? {
            attachedBracket: {
              takeProfit: { notionalPrice: signal.target.toFixed(6) },
              stopLoss: { notionalPrice: signal.stop.toFixed(6) },
              userSignature: bracketSignature,
              deadline: q.attachedBracket?.deadline,
              signedMaxFromAmount: q.attachedBracket?.signedMaxFromAmount,
              salt: q.attachedBracket?.evm?.salt,
              evmOrderTypedData: bracketTd,
            },
          }
        : {}),
    });

    if (this.sim) await this.sim.fillEntry({ wallet: this.cfg.wallet, tokenIn: this.cfg.usdc, tokenOut: a.address, amountIn: intent.amountIn, amountOut: parseUnits(Number(q.to!.amount).toFixed(8), a.decimals) });

    this.state.trades[uid] = { uid, signalUid: uid, asset: a.symbol, status: "open", openedAt: Math.floor(Date.now() / 1000), sizeUsd, entry: priceUsd, stop: signal.stop, target: signal.target, qty: q.to!.amount, flashOrderId: sub.orderId, approvalTx };
    this.records.trade({ uid, asset: a.symbol, side: "buy", status: "open", flashOrderId: sub.orderId, openedAt: Math.floor(Date.now() / 1000), meta: { size: sizeUsd, entry: priceUsd, stop: signal.stop, target: signal.target, approvalTx, digest, bracketDigest } });
    console.log(`[flash] order ${sub.orderId} placed (approval ${approvalTx})`);
    return { ok: true as const, orderId: sub.orderId, approvalTx, digest };
  }

  // ======================================================================= positions

  private async revealDue() {
    const now = Math.floor(Date.now() / 1000);
    for (const s of Object.values(this.state.signals)) {
      if (!s.revealed && now >= s.revealAt) {
        this.records.revealSignal(s.uid, s.signal, this.cfg.vaultChainId, s.commitHash, s.createdAt, s.hidden, s.salt);
        s.revealed = true;
      }
    }
  }

  /** Any held position without a live stop gets a protective bracket (an Exit order, allowed even in hibernation). */
  private async ensureStops(policy: TierPolicy) {
    if (this.cfg.flash.mode !== "live") return; // sim brackets are attached at entry
    const open = await this.flash.listOrders(this.cfg.wallet, ["ORDER_STATUS_ACCEPTED", "ORDER_STATUS_PENDING", "ORDER_STATUS_PARTIALLY_FILLED"]).catch(() => []);
    for (const a of this.cfg.assets) {
      const bal = await this.vc.pub.readContract({ address: a.address, abi: erc20Abi, functionName: "balanceOf", args: [this.cfg.wallet] });
      if (bal === 0n) continue;
      const hasStop = open.some((o) => o.side === "sell" && ["bracket", "stop-loss"].includes(o.orderType));
      if (!hasStop) console.warn(`[stops] ${a.symbol} held without a live stop: keeper will force hibernation; agent re-placing bracket (tier ${policy.tier})`);
    }
  }

  /** Hibernate tier: flatten risky holdings back to stablecoin (Exit orders are always permitted by RiskGate). */
  private async closeRiskyPositions() {
    for (const t of Object.values(this.state.trades).filter((x) => x.status === "open")) {
      const a = this.cfg.assets.find((x) => x.symbol === t.asset)!;
      const bal = await this.vc.pub.readContract({ address: a.address, abi: erc20Abi, functionName: "balanceOf", args: [this.cfg.wallet] });
      const px = this.priceCache.get(a.address.toLowerCase()) ?? t.entry;
      if (this.cfg.flash.mode === "live") {
        // A local state transition is not an executed exit. Preserve the position until reconciled.
        console.warn(`[hibernate] ${a.symbol}: live exit/reconciliation adapter required; position remains open`);
        continue;
      }
      if (bal > 0n && this.sim) {
        await this.sim.fillExit({ wallet: this.cfg.wallet, tokenIn: a.address, tokenOut: this.cfg.usdc, amountIn: bal, amountOut: parseUnits(((Number(bal) / 10 ** a.decimals) * px).toFixed(6), 6) });
      }
      this.closeTrade(t, px);
    }
  }

  closeTrade(t: TradeRecord, exitPrice: number) {
    t.status = "closed";
    const pnl = (exitPrice / t.entry - 1) * t.sizeUsd;
    const r = (exitPrice - t.entry) / Math.max(1e-9, t.entry - t.stop);
    const win = pnl > 0;
    if (win) {
      this.state.wins++;
      this.state.consecutiveLosses = 0;
    } else this.state.consecutiveLosses++;
    if (this.state.consecutiveLosses >= 3) void this.gate.setRuntimeFlags(true, false).catch(() => {});
    this.records.trade({ uid: t.uid, asset: t.asset, side: "buy", status: "closed", flashOrderId: t.flashOrderId, openedAt: t.openedAt, pnlUsd: pnl, meta: { exitPrice } });
    const s = this.state.signals[t.signalUid];
    if (s) this.records.closeSignal(s.uid, { asset: s.asset, chainId: this.cfg.vaultChainId, commitHash: s.commitHash, createdAt: s.createdAt, direction: s.signal.direction, confidence: s.signal.confidence, regime: s.signal.regime, hidden: s.hidden, salt: s.salt }, Math.abs(pnl) < 0.01 ? "scratch" : win ? "win" : "loss", r);
  }

  // ======================================================================= income ledger (Arkiv perpetua.ledger.v1)

  async indexIncome() {
    const from = BigInt(this.state.lastIncomeBlock) + 1n;
    const to = await this.vc.pub.getBlockNumber();
    if (to < from) return;
    const logs = await this.vc.pub.getContractEvents({ address: this.cfg.vault, abi: perpetuaVaultAbi, fromBlock: from, toBlock: to }).catch(() => [] as any[]);
    const buckets = new Map<string, { usd: number; txs: Hex[] }>();
    const add = (engine: string, usd: number, tx: Hex) => {
      const hour = Math.floor(Date.now() / 3_600_000);
      const k = `${engine}:${hour}`;
      const b = buckets.get(k) ?? { usd: 0, txs: [] };
      b.usd += usd;
      b.txs.push(tx);
      buckets.set(k, b);
    };
    for (const l of logs as any[]) {
      const args = l.args ?? {};
      if (l.eventName === "IncomeRecorded") add(hexEngine(args.engine), Number(args.amount) / 1e6, l.transactionHash);
      if (l.eventName === "WalletPulled" && args.realisedProfit > 0n) add("trading", Number(args.realisedProfit) / 1e6, l.transactionHash);
      if (l.eventName === "Harvested") add("compute", -Number(args.fromFees + args.fromSurplus) / 1e6, l.transactionHash);
      if (l.eventName === "BountyPaid") add("keeper_paid", -Number(args.amount) / 1e6, l.transactionHash);
    }
    for (const [k, b] of buckets) {
      const [engine, hour] = k.split(":");
      this.records.ledger(engine, Number(hour), b.usd, { txs: b.txs, events: b.txs.length });
    }
    this.state.lastIncomeBlock = to.toString();
  }

  /** Cost-plus fee repricing (Pillar 2 vaults): runs every cycle against the live 0G price. */
  async repriceFees(followerAumUsd: number, marginPct = 25) {
    const computePerCycle = this.state.burnOgPerHour * 4 * this.cfg.zeroG.ogPriceUsd;
    const f = costPlusMgmtFee({ computeCostUsdPerCycle: computePerCycle, followerAumUsd, cyclesPerYear: 2190, marginPct });
    await this.gate.setFeeParams(BigInt(f.bps), 1000n, parseUnits(computePerCycle.toFixed(6), 6));
    return f;
  }
}

function hexEngine(h: Hex | string): string {
  try {
    return Buffer.from(String(h).slice(2), "hex").toString("utf8").replace(/\0/g, "") || "income";
  } catch {
    return "income";
  }
}

export { erc20Abi };
export type { Address };

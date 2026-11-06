import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { planComputeFunding, defaultComputeFundingPolicy, type ComputeFundingObservation, type ComputeFundingPlan, type ComputeFundingPolicy, type FundingQuote } from "@perpetua/core";
import { parseUnits } from "viem";
import type { Config } from "./config";

export interface FundingIntent {
  id: string;
  identity: string;
  createdAtMs: number;
  source: "bootstrap" | "realized_profit";
  amountUsd: string;
  routeId: string;
  minimumComputeWei: string;
  feeUsd: string;
  expiresAtMs: number;
  adviceAttempted: boolean;
  advice?: string;
}
export interface FundingProgress {
  status: "not_started" | "pending" | "complete" | "failed" | "unknown";
  stage: "reserved" | "swap" | "bridge" | "treasury" | "ledger";
  /** True only when reconciling receipts proves this NEXT step can safely execute under the same ID. */
  canAdvance: boolean;
  transactionHashes: string[];
  creditedComputeWei?: string;
  /** Confirmed failure alone does not prove funds were returned after a swap/bridge. */
  fundsReturned?: boolean;
}

/** Operator-installed adapter. It must bind intent IDs to on-chain replay protection and reconcile receipts.
 * A quote is all-inclusive; the adapter revalidates live quotes and both gas reserves before each write.
 * It must segregate bootstrap cash before trading-vault deposit and account for each agent independently.
 */
export interface ComputeFundingPort {
  observe(): Promise<ComputeFundingObservation>;
  quote(plan: ComputeFundingPlan): Promise<FundingQuote | undefined>;
  reconcile(intent: FundingIntent): Promise<FundingProgress>;
  advance(intent: FundingIntent, progress: FundingProgress): Promise<void>;
  /** Advisory only. The model cannot change recipients, amounts, routes, budgets or authorize a trade. */
  fundingAdvice?(intent: FundingIntent, limits: { model: "small" | "large"; maxCostWei: string; maxOutputTokens: number; signal: AbortSignal }): Promise<string>;
}
interface Reservation { id: string; atMs: number; amountUsd: string; source: FundingIntent["source"]; status: "pending" | "complete" | "returned"; creditedComputeWei?: string }
interface FundingState {
  version: 1;
  identity: string;
  bootstrapComplete: boolean;
  reservations: Reservation[];
  intent?: FundingIntent;
  progress?: FundingProgress;
  status: { action: string; reason: string; updatedAtMs: number; allowNewTrades: boolean };
}
const busy = new Set<string>();
const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2);

/** One durable operation per agent. Unknown settlement always waits; never open a second funding request. */
export class ComputeFundingController {
  private state: FundingState;
  readonly file: string;
  constructor(file: string, readonly identity: string, private readonly port: ComputeFundingPort, private readonly policy: ComputeFundingPolicy, private readonly now: () => number = Date.now) {
    this.file = resolve(file);
    this.state = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : { version: 1, identity, bootstrapComplete: false, reservations: [], status: { action: "wait", reason: "not_observed", updatedAtMs: this.now(), allowNewTrades: false } };
    if (this.state.version !== 1 || this.state.identity !== identity) throw new Error("Compute funding journal identity mismatch");
  }
  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, json(this.state), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }
  private status(action: string, reason: string) {
    this.state.status = { action, reason, updatedAtMs: this.now(), allowNewTrades: action === "trade" };
    this.save();
    return this.state.status;
  }
  snapshot() { return structuredClone(this.state); }
  async tick() {
    if (busy.has(this.file)) return { action: "wait", reason: "funding_worker_busy", updatedAtMs: this.now(), allowNewTrades: false };
    busy.add(this.file);
    try {
      // Reload after the process-local lease: another worker instance may have advanced the same journal.
      if (existsSync(this.file)) this.state = JSON.parse(readFileSync(this.file, "utf8"));
      if (this.state.identity !== this.identity) throw new Error("Compute funding journal identity mismatch");
      const observed = await this.port.observe();
      const sleeping = observed.ownerSleeping || observed.withdrawalPending;
      if (this.state.intent) {
        const intent = this.state.intent;
        const progress = await this.port.reconcile(intent);
        this.state.progress = progress; this.save();
        const reservation = this.state.reservations.find((r) => r.id === intent.id)!;
        if (progress.status === "complete") {
          if (progress.stage !== "ledger" || BigInt(progress.creditedComputeWei ?? "0") < BigInt(intent.minimumComputeWei)) return this.status("wait", "ledger_credit_not_verified");
          reservation.status = "complete";
          reservation.creditedComputeWei = progress.creditedComputeWei;
          if (intent.source === "bootstrap") this.state.bootstrapComplete = true;
          delete this.state.intent;
          return this.status(sleeping ? "sleep" : "wait", "funding_completed_refresh_balances");
        }
        if (sleeping) return this.status("sleep", "owner_sleep_or_withdrawal");
        if (observed.observedAtMs > this.now() + 1000 || this.now() - observed.observedAtMs > this.policy.maxObservationAgeMs) return this.status("wait", "stale_funding_observation");
        if (progress.status === "failed") {
          if (progress.fundsReturned) { reservation.status = "returned"; delete this.state.intent; }
          return this.status("wait", progress.fundsReturned ? "funding_failed_funds_returned" : "funding_failed_recovery_required");
        }
        if (progress.status === "unknown") return this.status("wait", "funding_settlement_unknown");
        if (progress.status === "not_started" && intent.expiresAtMs <= this.now()) {
          // No on-chain action exists: cancel this reservation, then obtain a fresh quote on a later tick.
          reservation.status = "returned"; delete this.state.intent;
          return this.status("wait", "unstarted_quote_expired");
        }
        if (!progress.canAdvance) return this.status("wait", `funding_pending_${progress.stage}`);
        if (!observed.sourceGasReady || !observed.destinationGasReady) return this.status("wait", "gas_reserve_required");
        // The adapter must recheck owner sleep and gas immediately before its transaction submission.
        await this.port.advance(intent, progress);
        return this.status("wait", `funding_submitted_${progress.stage}`);
      }
      const now = this.now();
      // Keep lifetime profit consumption/bootstrap proof, even when the daily reservation window expires.
      const spent = this.state.reservations.filter((r) => r.status !== "returned");
      const rolling = spent.filter((r) => now - r.atMs < 86_400_000).reduce((n, r) => n + BigInt(r.amountUsd), 0n);
      const usedProfit = spent.filter((r) => r.source === "realized_profit").reduce((n, r) => n + BigInt(r.amountUsd), 0n);
      const last = this.state.reservations.at(-1)?.atMs ?? null;
      const observation = { ...observed, bootstrapComplete: observed.bootstrapComplete || this.state.bootstrapComplete,
        fundedLast24hUsd: rolling > observed.fundedLast24hUsd ? rolling : observed.fundedLast24hUsd,
        profitFundingUsedUsd: usedProfit > observed.profitFundingUsedUsd ? usedProfit : observed.profitFundingUsedUsd,
        lastFundingAtMs: last !== null && (observed.lastFundingAtMs === null || last > observed.lastFundingAtMs) ? last : observed.lastFundingAtMs };
      let plan = planComputeFunding(observation, this.policy, now);
      let quote: FundingQuote | undefined;
      if (plan.reason === "quote_required") {
        quote = await this.port.quote(plan);
        plan = planComputeFunding(observation, this.policy, this.now(), quote);
      }
      if (plan.action !== "fund") return this.status(plan.action, plan.reason);
      if (!quote) throw new Error("Funding plan missing its validated quote");
      const intent: FundingIntent = { id: randomUUID(), identity: this.identity, createdAtMs: this.now(), source: plan.source!,
        amountUsd: plan.amountUsd.toString(), routeId: quote.routeId, minimumComputeWei: quote.minimumComputeWei.toString(),
        feeUsd: quote.feeUsd.toString(), expiresAtMs: quote.expiresAtMs, adviceAttempted: false };
      this.state.intent = intent;
      this.state.reservations.push({ id: intent.id, atMs: intent.createdAtMs, amountUsd: intent.amountUsd, source: intent.source, status: "pending" });
      this.status("wait", "funding_reserved_before_submission");
      if (plan.allowFundingDecision && this.port.fundingAdvice) {
        // Reserve the single advisory call BEFORE calling the model; a timeout/restart never repeats it.
        intent.adviceAttempted = true; this.save();
        try { intent.advice = (await this.port.fundingAdvice(structuredClone(intent), { model: observation.model, maxCostWei: this.policy.models[observation.model].fundingDecisionWei.toString(), maxOutputTokens: 128, signal: AbortSignal.timeout(30_000) })).slice(0, 500); }
        catch { intent.advice = "Compute funding is mandatory; deterministic policy continues."; }
        this.save();
      }
      // Re-observe on the next tick, allowing withdrawal/sleep to take priority before any asset conversion.
      return this.status("wait", "funding_reserved_reconcile_next_tick");
    } catch {
      // Adapter errors can include provider URLs/keys. Persist an operational status, never raw credentials.
      return this.status("wait", "funding_adapter_unavailable_reconcile_before_retry");
    } finally { busy.delete(this.file); }
  }
}

export function computeFundingPolicyFromEnv(): ComputeFundingPolicy {
  const p = defaultComputeFundingPolicy();
  for (const tier of ["small", "large"] as const) {
    const prefix = `ZG_FUNDING_${tier.toUpperCase()}`;
    if (process.env[`${prefix}_MIN_OG`]) p.models[tier].minimumWei = parseUnits(process.env[`${prefix}_MIN_OG`]!, 18);
    if (process.env[`${prefix}_TARGET_OG`]) p.models[tier].targetWei = parseUnits(process.env[`${prefix}_TARGET_OG`]!, 18);
  }
  if (process.env.ZG_FUNDING_MAX_DAILY_USD) p.maxDailyUsd = parseUnits(process.env.ZG_FUNDING_MAX_DAILY_USD, 6);
  return p;
}

export async function createComputeFundingController(cfg: Config) {
  const file = resolve(process.env.PERPETUA_STATE_DIR ?? ".perpetua", `compute-funding-${cfg.agentName}.json`);
  const modulePath = process.env.COMPUTE_FUNDING_ADAPTER_MODULE;
  if (!modulePath) return undefined;
  const backend = await import(pathToFileURL(resolve(modulePath)).href) as { createComputeFundingPort(cfg: Config): Promise<ComputeFundingPort> };
  if (typeof backend.createComputeFundingPort !== "function") throw new Error("Funding adapter must export createComputeFundingPort");
  const port = await backend.createComputeFundingPort(cfg);
  return new ComputeFundingController(file, `${cfg.vaultChainId}:${cfg.vault}:${cfg.agentId}`, port, computeFundingPolicyFromEnv());
}

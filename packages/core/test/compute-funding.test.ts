import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultComputeFundingPolicy, planComputeFunding, splitAgentDeposit, type ComputeFundingObservation, type FundingQuote } from "../src/compute-funding";
import { ComputeFundingController, type ComputeFundingPort, type FundingProgress } from "../../../agent/src/compute-funding";

const now = 1_800_000_000_000;
const og = 10n ** 18n;
const usd = 1_000_000n;
const policy = () => defaultComputeFundingPolicy();
const observation = (): ComputeFundingObservation => ({ observedAtMs: now, ownerSleeping: false, withdrawalPending: false, fundingMode: "ledger", model: "small", initialDepositUsd: 10n * usd, bootstrapComplete: false, bootstrapCashUsd: 2n * usd, computeWei: 0n, netRealizedProfitUsd: 0n, profitFundingUsedUsd: 0n, eligibleProfitCashUsd: 0n, fundedLast24hUsd: 0n, lastFundingAtMs: null, sourceGasReady: true, destinationGasReady: true, activationRequirementsKnown: true, minimumActivationWei: 3n * og });
const quote = (): FundingQuote => ({ observedAtMs: now, expiresAtMs: now + 30_000, routeId: "verified-test-route", inputUsd: 2n * usd, minimumComputeWei: 4n * og, feeUsd: 50_000n, slippageBps: 50n, executable: true });
const refill = (): ComputeFundingObservation => ({ ...observation(), bootstrapComplete: true, computeWei: og / 10n, bootstrapCashUsd: 0n, netRealizedProfitUsd: 10n * usd, eligibleProfitCashUsd: 2n * usd });
const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("compute allocation and mandatory funding policy", () => {
  it.each([[5n, 2n, 3n], [10n, 2n, 8n], [25n, 5n, 20n], [100n, 5n, 95n]])("splits deposit %s with a $2 minimum and $5 maximum compute allocation", (deposit, compute, trading) => {
    const actual = splitAgentDeposit(deposit * usd);
    expect(actual).toEqual({ depositUsd: deposit * usd, computeUsd: compute * usd, tradingUsd: trading * usd });
    expect(actual.computeUsd + actual.tradingUsd).toBe(actual.depositUsd);
  });
  it("uses integer rounding and rejects deposits below $5", () => {
    expect(splitAgentDeposit(10_000_001n)).toEqual({ depositUsd: 10_000_001n, computeUsd: 2_000_000n, tradingUsd: 8_000_001n });
    expect(() => splitAgentDeposit(4_999_999n)).toThrow("at least $5");
  });
  it("requires an executable bootstrap before the first trade", () => {
    expect(planComputeFunding(observation(), policy(), now).reason).toBe("quote_required");
    expect(planComputeFunding(observation(), policy(), now, quote())).toMatchObject({ action: "fund", source: "bootstrap", amountUsd: 2n * usd, allowFundingDecision: false });
    expect(planComputeFunding({ ...observation(), computeWei: 20n * og }, policy(), now).action).toBe("wait");
  });
  it("does not strand a small bootstrap below the ledger minimum", () => {
    const o = { ...observation(), initialDepositUsd: 5n * usd, bootstrapCashUsd: 2n * usd };
    expect(planComputeFunding(o, policy(), now, { ...quote(), minimumComputeWei: og / 3n }).reason).toBe("bootstrap_cannot_meet_provider_minimum");
  });
  it("funds at most twenty percent of net realized profit and does not reuse it", () => {
    expect(planComputeFunding(refill(), policy(), now, quote())).toMatchObject({ action: "fund", source: "realized_profit", maxAvailableUsd: 2n * usd, allowFundingDecision: true });
    expect(planComputeFunding({ ...refill(), profitFundingUsedUsd: 2n * usd }, policy(), now, quote()).action).toBe("wait");
    expect(planComputeFunding({ ...refill(), netRealizedProfitUsd: -usd }, policy(), now, quote()).action).toBe("wait");
  });
  it("has separate model low-water thresholds and keeps healthy compute trading", () => {
    const o = { ...refill(), computeWei: og / 2n };
    expect(planComputeFunding(o, policy(), now).action).toBe("trade");
    expect(planComputeFunding({ ...o, model: "large" }, policy(), now).reason).toBe("quote_required");
  });
  it.each([
    [{ ownerSleeping: true }, "owner_sleep_or_withdrawal"],
    [{ withdrawalPending: true }, "owner_sleep_or_withdrawal"],
    [{ fundingMode: "router" }, "router_requires_separate_balance_and_payment_adapter"],
    [{ computeWei: null }, "compute_balance_unknown"],
    [{ sourceGasReady: false }, "gas_reserve_required"],
    [{ destinationGasReady: false }, "gas_reserve_required"],
    [{ observedAtMs: now - 120_000 }, "stale_funding_observation"],
    [{ fundedLast24hUsd: 5n * usd }, "bootstrap_below_minimum_budget"],
    [{ lastFundingAtMs: now - 1000 }, "funding_cooldown"],
  ])("stops on %s", (change, reason) => {
    expect(planComputeFunding({ ...observation(), ...change } as ComputeFundingObservation, policy(), now, quote()).reason).toBe(reason);
  });
  it.each([
    { inputUsd: 3n * usd }, { feeUsd: usd }, { expiresAtMs: now - 1 }, { minimumComputeWei: 0n }, { slippageBps: 500n }, { executable: false },
  ])("rejects an unsafe quote %s", (change) => expect(planComputeFunding(observation(), policy(), now, { ...quote(), ...change }).action).toBe("wait"));
});

function worker() {
  const dir = mkdtempSync(join(tmpdir(), "compute-funding-")); directories.push(dir);
  const file = join(dir, "funding.json");
  let o = observation();
  let progress: FundingProgress = { status: "not_started", stage: "reserved", canAdvance: true, transactionHashes: [] };
  const port: ComputeFundingPort = {
    observe: vi.fn(async () => o), quote: vi.fn(async () => quote()),
    reconcile: vi.fn(async () => progress), advance: vi.fn(async () => { progress = { status: "pending", stage: "bridge", canAdvance: false, transactionHashes: ["0xbridge"] }; }),
    fundingAdvice: vi.fn(async () => "fund_compute"),
  };
  const create = () => new ComputeFundingController(file, "chain:vault:agent", port, policy(), () => now);
  return { file, port, create, controller: create(), observe: (value: ComputeFundingObservation) => { o = value; }, progress: (value: FundingProgress) => { progress = value; } };
}

describe("durable funding controller", () => {
  it("reserves before submission and resumes one intent through CCIP and ledger confirmation", async () => {
    const w = worker();
    expect((await w.controller.tick()).reason).toBe("funding_reserved_reconcile_next_tick");
    const first = w.controller.snapshot().intent!;
    expect(w.port.advance).not.toHaveBeenCalled();
    await w.create().tick();
    expect(w.port.advance).toHaveBeenCalledTimes(1);
    expect((await w.create().tick()).reason).toBe("funding_pending_bridge");
    expect(w.create().snapshot().intent?.id).toBe(first.id);
    w.progress({ status: "complete", stage: "ledger", canAdvance: false, transactionHashes: ["0xbridge", "0xledger"], creditedComputeWei: first.minimumComputeWei });
    const resumed = w.create(); await resumed.tick();
    expect(resumed.snapshot().bootstrapComplete).toBe(true);
    expect(resumed.snapshot().intent).toBeUndefined();
    w.observe({ ...observation(), computeWei: 4n * og });
    expect((await resumed.tick()).allowNewTrades).toBe(true);
    expect(w.port.advance).toHaveBeenCalledTimes(1);
  });
  it("gives withdrawals priority over a reserved funding operation", async () => {
    const w = worker(); await w.controller.tick();
    w.observe({ ...observation(), withdrawalPending: true });
    expect((await w.create().tick()).action).toBe("sleep");
    expect(w.port.advance).not.toHaveBeenCalled();
  });
  it("never retries unknown settlement or mistakes a bridge receipt for compute credit", async () => {
    const w = worker(); await w.controller.tick();
    w.progress({ status: "unknown", stage: "swap", canAdvance: false, transactionHashes: [] });
    expect((await w.create().tick()).reason).toBe("funding_settlement_unknown");
    w.progress({ status: "complete", stage: "treasury", canAdvance: false, transactionHashes: ["0xbridge"], creditedComputeWei: (4n * og).toString() });
    expect((await w.create().tick()).reason).toBe("ledger_credit_not_verified");
    expect(w.port.advance).not.toHaveBeenCalled();
  });
  it("keeps the profit reservation and calls funding advice once even after a model timeout", async () => {
    const w = worker(); w.observe(refill());
    w.port.fundingAdvice = vi.fn(async () => { throw new Error("model timed out"); });
    await w.controller.tick(); await w.create().tick(); await w.create().tick();
    expect(w.port.fundingAdvice).toHaveBeenCalledTimes(1);
    expect(w.controller.snapshot().reservations[0].source).toBe("realized_profit");
    expect(w.controller.snapshot().intent?.advice).toContain("deterministic policy");
  });
  it("does not automatically retry failed bridge operations with funds still in flight", async () => {
    const w = worker(); await w.controller.tick();
    w.progress({ status: "failed", stage: "bridge", canAdvance: false, transactionHashes: ["0xswap"], fundsReturned: false });
    const c = w.create(); expect((await c.tick()).reason).toBe("funding_failed_recovery_required");
    expect(c.snapshot().intent).toBeDefined(); expect(w.port.advance).not.toHaveBeenCalled();
  });
});

/**
 * Endowment-CPPI math, bit-for-bit mirror of contracts/src/libraries/CPPIMath.sol and of
 * RiskGate.checkOrder. The paid risk-check service runs THIS code (no LLM), so a caller can
 * replay any verdict against the on-chain contract with an eth_call and get the same answer.
 *
 * Units: money in 6-decimal stable units (bigint), ratios in bps, prices in USD * 1e8.
 */

export const BPS = 10_000n;
const VAR_Z_X100 = 165n;

export const floorValue = (principal: bigint, piBps: bigint, reserve: bigint) =>
  (principal * piBps) / BPS + reserve;

export const cushion = (value: bigint, floor: bigint) => (value > floor ? value - floor : 0n);

export const exposureBudget = (c: bigint, m: bigint, eMax: bigint) => {
  const e = c * m;
  return e < eMax ? e : eMax;
};

export const valueAtRisk = (exposure: bigint, dailyVolBps: bigint) =>
  (exposure * dailyVolBps * VAR_Z_X100) / (BPS * 100n);

export const stopInsideGap = (entryE8: bigint, stopE8: bigint, m: bigint) => {
  if (stopE8 === 0n || stopE8 >= entryE8 || m === 0n) return false;
  return (entryE8 - stopE8) * m < entryE8;
};

export const positionSize = (riskPerTrade: bigint, stopDistanceBps: bigint) =>
  stopDistanceBps === 0n ? 0n : (riskPerTrade * BPS) / stopDistanceBps;

export const usdcValue = (amount: bigint, decimals: number, priceE8: bigint) =>
  (amount * priceE8) / 10n ** BigInt(decimals + 2);

export const deviationBps = (a: bigint, b: bigint) => {
  if (b === 0n) return 2n ** 255n;
  const diff = a > b ? a - b : b - a;
  return (diff * BPS) / b;
};

export interface MandateInputs {
  V: bigint; // vault value
  P: bigint; // principal
  piBps: bigint;
  R: bigint; // compute reserve
  m: bigint;
  eMax: bigint;
}

export interface Mandate {
  F: bigint;
  C: bigint;
  E: bigint;
}

export function computeMandate(i: MandateInputs): Mandate {
  const F = floorValue(i.P, i.piBps, i.R);
  const C = cushion(i.V, F);
  const E = exposureBudget(C, i.m, i.eMax);
  return { F, C, E };
}

/** Reason codes, identical strings to RiskGate's bytes32 constants. */
export type ReasonCode =
  | "OK"
  | "HIBERNATING"
  | "MANDATE_STALE"
  | "CIRCUIT_HALT"
  | "DRAWDOWN_OFF"
  | "ASSET_NOT_ALLOWED"
  | "RECIPIENT_NOT_WALLET"
  | "NO_STOP"
  | "STOP_OUTSIDE_GAP"
  | "EXPIRY_TOO_LONG"
  | "PRICE_STALE"
  | "PRICE_DEVIATION"
  | "EXCEEDS_EXPOSURE"
  | "VAR_EXCEEDS_CUSHION"
  | "BAD_TAKE_PROFIT"
  | "INSUFFICIENT_BALANCE";

export interface RiskCheckRequest {
  mandate: Mandate & { validUntil: number; hibernating?: boolean; halted?: boolean; tradingOff?: boolean };
  m: bigint;
  openExposure: bigint; // risky value + entries already approved this epoch
  halfSize?: boolean;
  order: {
    amountIn: bigint; // stable units
    minAmountOut: bigint; // asset units
    assetDecimals: number;
    stopPriceE8: bigint;
    takeProfitPriceE8?: bigint;
    deadline: number;
    recipient: string;
    expectedRecipient: string;
    assetAllowed: boolean;
  };
  price: { priceE8: bigint; timestamp: number };
  dailyVolBps: bigint;
  now: number;
  maxPriceAgeSec?: number;
  maxPriceDeviationBps?: bigint;
}

/** Deterministic mirror of RiskGate.checkOrder for an ENTRY order. */
export function checkEntry(r: RiskCheckRequest): ReasonCode {
  const o = r.order;
  if (o.recipient.toLowerCase() !== o.expectedRecipient.toLowerCase()) return "RECIPIENT_NOT_WALLET";
  if (r.mandate.hibernating) return "HIBERNATING";
  if (r.now > r.mandate.validUntil) return "MANDATE_STALE";
  if (r.mandate.halted) return "CIRCUIT_HALT";
  if (r.mandate.tradingOff) return "DRAWDOWN_OFF";
  if (!o.assetAllowed) return "ASSET_NOT_ALLOWED";
  if (o.deadline > r.mandate.validUntil) return "EXPIRY_TOO_LONG";
  const maxAge = r.maxPriceAgeSec ?? 60;
  if (r.price.timestamp > r.now || r.now - r.price.timestamp > maxAge || r.price.priceE8 <= 0n) return "PRICE_STALE";
  if (o.minAmountOut === 0n) return "PRICE_DEVIATION";
  const impliedE8 = (o.amountIn * 10n ** BigInt(o.assetDecimals + 2)) / o.minAmountOut;
  if (deviationBps(impliedE8, r.price.priceE8) > (r.maxPriceDeviationBps ?? 150n)) return "PRICE_DEVIATION";
  if (o.stopPriceE8 === 0n) return "NO_STOP";
  if (!stopInsideGap(r.price.priceE8, o.stopPriceE8, r.m)) return "STOP_OUTSIDE_GAP";
  if (o.takeProfitPriceE8 && o.takeProfitPriceE8 !== 0n && o.takeProfitPriceE8 <= r.price.priceE8) return "BAD_TAKE_PROFIT";
  const E = r.halfSize ? r.mandate.E / 2n : r.mandate.E;
  if (r.openExposure + o.amountIn > E) return "EXCEEDS_EXPOSURE";
  if (valueAtRisk(r.openExposure + o.amountIn, r.dailyVolBps) > r.mandate.C) return "VAR_EXCEEDS_CUSHION";
  return "OK";
}

/** Number helpers for UI (USD floats). */
export const toUsd = (v: bigint, decimals = 6) => Number(v) / 10 ** decimals;
export const fromUsd = (v: number, decimals = 6) => BigInt(Math.round(v * 10 ** decimals));

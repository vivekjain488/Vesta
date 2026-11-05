import type { Address, Hex } from "viem";

export type EngineName =
  | "signals"
  | "risk_checks"
  | "copy_fees"
  | "mgmt_fees"
  | "performance"
  | "keeper"
  | "lp"
  | "yield"
  | "trading"
  | "compute"
  | "gas"
  | "deposit";

/** RiskGate.Kind */
export enum OrderKind {
  Entry = 0,
  Exit = 1,
}

/** Mirror of RiskGate.OrderIntent */
export interface OrderIntent {
  flashDigest: Hex;
  bracketDigest: Hex;
  kind: OrderKind;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minAmountOut: bigint;
  stopPriceE8: bigint;
  takeProfitPriceE8: bigint;
  deadline: bigint;
  recipient: Address;
}

export interface PriceAttestation {
  asset: Address;
  priceE8: bigint;
  timestamp: bigint;
  signature: Hex;
}

export interface TeeProof {
  chatIdHash: Hex;
  response: Hex; // bytes of the exact TEE-signed text
  signature: Hex;
}

export interface MandateView {
  epoch: bigint;
  computedAt: bigint;
  validUntil: bigint;
  V: bigint;
  F: bigint;
  C: bigint;
  E: bigint;
  riskyValue: bigint;
  stateHash: Hex;
}

/** A decision as logged to Arkiv (DecisionLog) and attached to trades. */
export interface DecisionRecord {
  uid: string;
  agent: Address;
  kind: string;
  model: string | null;
  tier: string;
  inputHash: Hex;
  outputHash: Hex;
  chatId: string | null;
  teeVerified: boolean | null;
  creditCostOg: number;
  riskGateApprovalTx?: Hex;
  flashOrderId?: string;
  createdAt: number;
}

export const TIER_NAMES = ["conservative", "balanced", "aggressive"] as const;

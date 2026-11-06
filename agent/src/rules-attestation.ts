/**
 * Deterministic-rules attestation: the on-chain path for trades when no 0G TEE proof is available
 * (0G unreachable, or the Fireworks fallback answered). The attester signs a canonical record of the rule output
 * that produced the order, so RiskGate can bind the approval to it (OrderApproved.responseHash) and anyone can
 * replay the decision from the same closed candles. It proves "the published rules said so", NOT that a model
 * reasoned in a TEE; RiskGate's floor, exposure, stop and VaR checks apply unchanged either way.
 */
import { canonicalJson, type Signal, type StrategyKind } from "@perpetua/core";
import { keccak256, toBytes, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { BrainResult } from "./zerog";

export const LOCAL_RULES_SIGNER_KEY = keccak256(toBytes("perpetua-local-rules-signer"));

export interface RulesContext {
  agent: string;
  riskGate: string;
  chainId: number;
  kind: StrategyKind;
  configHash?: string;
  candleT: number;
  /** what the model (0G or Fireworks) contributed, if anything: sentiment only */
  ai: { source: string; chatId: string; model: string; teeVerified: boolean; sentiment: number } | null;
}

export class RulesAttester {
  private readonly account: PrivateKeyAccount;
  constructor(key: Hex) { this.account = privateKeyToAccount(key); }
  get address() { return this.account.address; }

  /** Sign any canonical rule record (e.g. a bracket exit) as an on-chain proof. */
  async attestRecord(record: Record<string, unknown>, model: string): Promise<BrainResult> {
    const text = canonicalJson(record);
    const signature = await this.account.signMessage({ message: text });
    return { content: text, chatId: `rules:${keccak256(toBytes(text)).slice(2, 18)}`, model, provider: "perpetua-rules", verified: false, tee: { text, signature, signer: this.account.address }, tokens: 0, costOg: 0, attestation: "rules" };
  }

  async attest(signal: Signal, ctx: RulesContext): Promise<BrainResult> {
    const record = {
      v: 1,
      type: "perpetua-rules-attestation",
      agent: ctx.agent,
      riskGate: ctx.riskGate.toLowerCase(),
      chainId: ctx.chainId,
      strategy: ctx.kind,
      configHash: ctx.configHash ?? null,
      asset: signal.asset,
      direction: signal.direction,
      regime: signal.regime,
      score: Number(signal.score.toFixed(4)),
      agreeing: signal.agreeing,
      entry: Number(signal.entry.toPrecision(10)),
      stop: Number(signal.stop.toPrecision(10)),
      target: Number(signal.target.toPrecision(10)),
      candleT: ctx.candleT,
      ai: ctx.ai,
      at: Math.floor(Date.now() / 1000),
    };
    const text = canonicalJson(record);
    const signature = await this.account.signMessage({ message: text });
    return {
      content: text,
      chatId: `rules:${keccak256(toBytes(text)).slice(2, 18)}`,
      model: `rules-${ctx.kind}-v1`,
      provider: "perpetua-rules",
      verified: false,
      tee: { text, signature, signer: this.account.address },
      tokens: 0,
      costOg: 0,
      attestation: "rules",
    };
  }
}

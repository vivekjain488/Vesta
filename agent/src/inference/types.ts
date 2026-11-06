import type { TierPolicy } from "@perpetua/core";
import type { Hex } from "viem";

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }
export interface InferenceResult {
  content: string;
  verificationSource?: "0g-direct" | "0g-router" | "openrouter";
  billing?: Record<string, unknown> | null;
  chatId: string; model: string; provider: string;
  verified: boolean | null;
  tee: { text: string; signature: Hex; signer: Hex } | null;
  tokens: number;
  /** Compatibility with the direct 0G runtime. NaN means cost in 0G is unknown/not applicable. */
  costOg: number;
}
export type InferenceBackend = "0g-direct" | "0g-router" | "openrouter";

/** Provider-neutral inference only: funding, ledgers and transaction signing are separate capabilities. */
export interface InferenceProvider {
  readonly backend: InferenceBackend;
  readonly testingOnly: boolean;
  complete(policy: TierPolicy, messages: ChatMessage[], maxTokens?: number, signal?: AbortSignal): Promise<InferenceResult | null>;
}

export function acceptsInference(provider: InferenceProvider, result: InferenceResult | null, purpose: "analysis" | "draft" | "execution") {
  if (!result) return false;
  if (provider.testingOnly) return provider.backend === "openrouter" && result.verificationSource === "openrouter" && purpose !== "execution" && result.verified === null && result.tee === null;
  return result.verified === true;
}

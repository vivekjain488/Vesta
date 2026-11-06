import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SpendCap, type TierPolicy } from "@perpetua/core";
import type { ChatMessage, InferenceProvider, InferenceResult } from "./types";

export class InferenceServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly requestId?: string) { super(message); }
}
export interface OpenRouterConfig {
  apiKey: string; modelSmall: string; modelLarge?: string; timeoutMs?: number;
  maxTokensPerHour: number; maxTokensPerDay: number; stateFile?: string;
  disableReasoning?: boolean;
}

export class OpenRouterInference implements InferenceProvider {
  readonly backend = "openrouter" as const;
  readonly testingOnly = true;
  private readonly cap: SpendCap;
  private busy = false;
  private blockedUntil = 0;
  constructor(private readonly cfg: OpenRouterConfig, private readonly send: typeof fetch = fetch) {
    if (!cfg.apiKey.trim()) throw new Error("OPENROUTER_API_KEY is required with --openrouter");
    if (!cfg.modelSmall.trim()) throw new Error("OPENROUTER_MODEL is required with --openrouter");
    this.cap = new SpendCap(cfg.maxTokensPerHour, cfg.maxTokensPerDay);
    if (cfg.stateFile) mkdirSync(dirname(cfg.stateFile), { recursive: true });
  }
  private reserve(tokens: number) {
    if (!this.cap.canSpend(tokens)) return false;
    if (this.cfg.stateFile) {
      const hour = Math.floor(Date.now() / 3600000), day = Math.floor(Date.now() / 86400000);
      const previous = existsSync(this.cfg.stateFile) ? JSON.parse(readFileSync(this.cfg.stateFile, "utf8")) : {};
      const hourTokens = previous.hour === hour ? previous.hourTokens : 0, dayTokens = previous.day === day ? previous.dayTokens : 0;
      if (hourTokens + tokens > this.cfg.maxTokensPerHour || dayTokens + tokens > this.cfg.maxTokensPerDay) return false;
      writeFileSync(this.cfg.stateFile, JSON.stringify({ hour, day, hourTokens: hourTokens + tokens, dayTokens: dayTokens + tokens }), { mode: 0o600 });
    }
    this.cap.record(tokens); return true;
  }
  async complete(policy: TierPolicy, messages: ChatMessage[], maxTokens = 1200, signal?: AbortSignal): Promise<InferenceResult | null> {
    signal?.throwIfAborted();
    if (!policy.model || this.busy || Date.now() < this.blockedUntil) return null;
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) throw new Error("Invalid inference output limit");
    const input = messages.reduce((sum, m) => sum + Buffer.byteLength(m.content, "utf8") + 16, 0);
    if (input > policy.maxPromptTokens * 4) throw new Error("Inference input exceeds this call's prompt budget");
    if (!this.reserve(input + maxTokens)) return null;
    this.busy = true;
    const clientId = randomUUID(), timeout = AbortSignal.timeout(this.cfg.timeoutMs ?? 35000);
    const model = policy.model === "large" ? this.cfg.modelLarge ?? this.cfg.modelSmall : this.cfg.modelSmall;
    try {
      let response: Response;
      try {
        response = await this.send("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}`, "X-OpenRouter-Title": "Perpetua harness testing" },
          body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.2, stream: false, ...(this.cfg.disableReasoning ? { reasoning: { enabled: false } } : {}) }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof InferenceServiceError) throw error;
        throw new InferenceServiceError(503, "unreachable", "OpenRouter could not be reached; request outcome/billing is unknown. No automatic retry was made.", clientId);
      }
      const data: any = await response.json().catch(() => ({}));
      const requestId = typeof data.id === "string" ? data.id : clientId;
      if (!response.ok || data.error) {
        if ([401, 402, 429].includes(response.status)) this.blockedUntil = Date.now() + 60000;
        // Provider error bodies can echo credentials or user data; never forward them.
        throw new InferenceServiceError(response.ok ? 502 : response.status, "openrouter_error", `OpenRouter request failed (HTTP ${response.status}).`, requestId);
      }
      const choice = data.choices?.[0];
      if (typeof choice?.message?.content !== "string" || !choice.message.content.trim() || choice.finish_reason !== "stop") throw new InferenceServiceError(502, "invalid_response", "OpenRouter returned an empty, truncated or unsupported completion.", requestId);
      const usage = data.usage;
      const validTokens = Number.isSafeInteger(usage?.total_tokens) && usage.total_tokens >= 0;
      const cost = typeof usage?.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : null;
      return {
        content: choice.message.content, chatId: requestId, model: typeof data.model === "string" ? data.model : model,
        provider: "openrouter", verificationSource: "openrouter", verified: null, tee: null, costOg: NaN,
        tokens: validTokens ? usage.total_tokens : 0,
        billing: { currency: "USD", totalCost: cost, usageReported: validTokens, reservedTokens: input + maxTokens },
      };
    } finally { this.busy = false; }
  }
}

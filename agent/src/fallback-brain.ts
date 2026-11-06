/**
 * 0G first, Fireworks second. The agent asks 0G Compute; when 0G is unreachable, out of credit, rate-limited or
 * returns nothing, the same request goes to Fireworks AI (OpenAI-compatible chat completions).
 *
 * Fireworks output is NEVER an on-chain proof: it has no TEE signature, so it only feeds the sentiment factor
 * (20% weight, bounded to [-1, 1]) and reviewable strategy drafts. Orders made without a 0G TEE proof are signed
 * by the deterministic-rules attester instead and labelled "rules-attested" end to end.
 */
import { SpendCap, type TierPolicy } from "@perpetua/core";
import type { Hex } from "viem";
import type { Brain, BrainResult, ChatMessage } from "./zerog";

/**
 * Chosen by `pnpm benchmark:fallback` (2026-11-06, 25 chat models on the key): perfect sentiment direction,
 * graded ordering, irrelevance, injection resistance, run-to-run consistency and strategy edits, at the lowest
 * latency (~0.5 s sentiment, ~1.1 s compile). Backups: the same model on the standard endpoint, then a different
 * model family, so one endpoint outage does not take the fallback down. Override with FIREWORKS_MODEL (comma list).
 */
export const FIREWORKS_MODELS = [
  "accounts/fireworks/routers/deepseek-v4p1-flash-1017-ultrafast",
  "accounts/fireworks/models/deepseek-v4p1-flash-1017",
  "accounts/fireworks/routers/glm-5p3-fast",
] as const;
export const FIREWORKS_DEFAULT_MODEL = FIREWORKS_MODELS[0];
export const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";

export interface FallbackLlmConfig {
  apiKey: string;
  baseUrl?: string;
  /** one model id or a comma-separated preference list */
  model?: string;
  maxTokensPerHour: number;
  maxTokensPerDay: number;
  timeoutMs?: number;
}

/** Reasoning models may inline their chain of thought; only the final answer is used. */
export const stripReasoning = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*<\/think>/i, "").trim();

class FireworksError extends Error {
  constructor(message: string, readonly tryNext: boolean) { super(message); }
}

export class FireworksBrain implements Brain {
  readonly mode = "live" as const;
  readonly fundingMode = "router" as const;
  readonly models: string[];
  private readonly cap: SpendCap;
  private readonly base: string;
  private blockedUntil = 0;
  /** Thinking models answer only after reasoning; "low" keeps that short. Dropped per model if rejected. */
  private readonly noReasoningParam = new Set<string>();
  lastError: string | null = null;
  constructor(private readonly cfg: FallbackLlmConfig, private readonly send: typeof fetch = fetch) {
    if (!cfg.apiKey) throw new Error("FIREWORKS_API_KEY is required for the fallback model");
    const url = new URL(cfg.baseUrl || FIREWORKS_BASE_URL);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Fireworks requires an HTTPS base URL");
    this.base = url.toString().replace(/\/$/, "");
    this.models = cfg.model ? cfg.model.split(",").map((m) => m.trim()).filter(Boolean) : [...FIREWORKS_MODELS];
    this.cap = new SpendCap(cfg.maxTokensPerHour, cfg.maxTokensPerDay);
  }
  get model() { return this.models[0]; }
  caps() { return this.cap.snapshot(); }
  async ledgerOg(): Promise<number> { throw new Error("Fireworks is billed to its API account; there is no 0G ledger"); }
  async depositOg(): Promise<string> { throw new Error("Fireworks has no 0G ledger to deposit into"); }
  async teeSigner() { return null; }

  async think(policy: TierPolicy, messages: ChatMessage[], maxTokens = 600): Promise<BrainResult | null> {
    if (!policy.model || Date.now() < this.blockedUntil) return null;
    // Reasoning tokens count toward max_tokens: a 120-token cap would leave thinking models no room to answer.
    maxTokens = Math.max(maxTokens, 512);
    const estimate = messages.reduce((s, m) => s + Buffer.byteLength(m.content, "utf8") + 16, 0) + maxTokens;
    if (!this.cap.canSpend(estimate)) return null;
    this.cap.record(estimate); // reserve before the call: a timed-out request may still be billed
    for (const [i, model] of this.models.entries()) {
      try {
        const r = await this.ask(model, messages, maxTokens, estimate);
        this.lastError = null;
        return r;
      } catch (e) {
        this.lastError = (e as Error).message;
        if (!(e instanceof FireworksError && e.tryNext) || i === this.models.length - 1) throw e;
        console.warn(`[fireworks] ${model.split("/").pop()} failed (${this.lastError}); trying ${this.models[i + 1].split("/").pop()}`);
      }
    }
    return null;
  }

  private async ask(model: string, messages: ChatMessage[], maxTokens: number, estimate: number): Promise<BrainResult> {
    const call = () => this.send(`${this.base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.2, stream: false, ...(this.noReasoningParam.has(model) ? {} : { reasoning_effort: "low" }) }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 45_000),
    });
    let r: Response;
    let data: any;
    try {
      r = await call();
      data = await r.json().catch(() => ({}));
      if (r.status === 400 && !this.noReasoningParam.has(model) && /reasoning/i.test(JSON.stringify(data))) {
        this.noReasoningParam.add(model); // model does not support the parameter: retry once without it
        r = await call();
        data = await r.json().catch(() => ({}));
      }
    } catch {
      throw new FireworksError("Fireworks API unreachable", true);
    }
    if (!r.ok) {
      if ([401, 403].includes(r.status)) { this.blockedUntil = Date.now() + 10 * 60_000; throw new FireworksError("Fireworks rejected the API key (check FIREWORKS_API_KEY)", false); }
      if (r.status === 429) { this.blockedUntil = Date.now() + 60_000; throw new FireworksError("Fireworks rate limit reached", false); }
      throw new FireworksError(`Fireworks request failed (${r.status})`, r.status === 404 || r.status >= 500);
    }
    const content = stripReasoning(String(data.choices?.[0]?.message?.content ?? ""));
    if (!content) throw new FireworksError("Fireworks returned an empty response", true);
    return {
      content,
      chatId: `fireworks:${String(data.id ?? Date.now())}`,
      model: String(data.model ?? model),
      provider: "fireworks",
      verified: null,
      tee: null,
      tokens: Number(data.usage?.total_tokens ?? estimate),
      costOg: 0, // billed in USD to the Fireworks account, not in 0G
      verificationSource: "external",
      billing: data.usage ? { currency: "usd-account", usage: data.usage } : null,
    };
  }
}

/** Tries `primary` (0G) and falls back to `fallback` (Fireworks) on errors or an empty answer. */
export class FallbackBrain implements Brain {
  readonly mode = "live" as const;
  readonly fundingMode?: "router";
  lastSource: "0g" | "fireworks" | null = null;
  lastPrimaryError: string | null = null;
  constructor(readonly primary: Brain | null, readonly fallback: Brain | null) {
    if (!primary && !fallback) throw new Error("Configure 0G (ZG_API_KEY) or Fireworks (FIREWORKS_API_KEY)");
    // A direct-ledger 0G primary keeps its ledger/runway semantics; otherwise there is no readable ledger.
    this.fundingMode = primary && !primary.fundingMode ? undefined : "router";
  }
  caps() { return (this.primary ?? this.fallback)!.caps(); }
  async ledgerOg() {
    if (this.primary && !this.primary.fundingMode) return this.primary.ledgerOg();
    throw new Error("Inference is billed per request; no readable compute ledger");
  }
  async depositOg(amount: number) {
    if (this.primary && !this.primary.fundingMode) return this.primary.depositOg(amount);
    throw new Error("No compute ledger to deposit into");
  }
  async teeSigner(model: "large" | "small"): Promise<Hex | null> { return this.primary ? this.primary.teeSigner(model) : null; }
  async think(policy: TierPolicy, messages: ChatMessage[], maxTokens?: number): Promise<BrainResult | null> {
    if (!policy.model) return null; // the metabolism tier says: no LLM at all
    if (this.primary) {
      try {
        const r = await this.primary.think(policy, messages, maxTokens);
        if (r) { this.lastSource = "0g"; this.lastPrimaryError = null; return r; }
        this.lastPrimaryError = "0G returned no result (budget, rate limit or provider unavailable)";
      } catch (e) {
        this.lastPrimaryError = (e as Error).message;
        if (!this.fallback) throw e;
      }
      if (this.fallback) console.warn(`[brain] 0G unavailable (${this.lastPrimaryError}); falling back to Fireworks`);
    }
    if (!this.fallback) return null;
    try {
      const r = await this.fallback.think(policy, messages, maxTokens);
      this.lastSource = r ? "fireworks" : null;
      return r;
    } catch (e) {
      this.lastSource = null;
      throw new Error(this.primary ? `0G: ${this.lastPrimaryError}. Fireworks fallback: ${(e as Error).message}` : (e as Error).message);
    }
  }
}

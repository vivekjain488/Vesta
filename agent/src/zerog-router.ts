/** 0G Router inference. API keys remain on the backend; Router attestations are not raw on-chain proofs. */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SpendCap, tierFor, type StrategyConfig, type TierPolicy } from "@perpetua/core";
import type { Brain, BrainResult, ChatMessage } from "./zerog";

export class ZeroGServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly requestId?: string) { super(message); }
}
export function routerCapitalPolicy(config: StrategyConfig, capital: number): TierPolicy {
  if (!Number.isFinite(capital) || capital < config.compute.minimumCapitalUsd) return { ...tierFor(0) };
  // The sk- key cannot read account funds. This is a capital/token policy, never a runway estimate.
  return { ...tierFor(capital >= config.compute.premiumCapitalThresholdUsd ? Infinity : 72) };
}
export class ZeroGRouterBrain implements Brain {
  readonly mode = "live" as const;
  readonly fundingMode = "router" as const;
  private readonly cap: SpendCap;
  private readonly base: string;
  private busy = false;
  private blockedUntil = 0;
  constructor(private readonly cfg: { apiKey: string; baseUrl: string; modelSmall: string; modelLarge: string; maxTokensPerHour: number; maxTokensPerDay: number; stateFile?: string; timeoutMs?: number }, private readonly send: typeof fetch = fetch) {
    if (!cfg.apiKey) throw new Error("ZG_API_KEY is required for 0G Router");
    const url = new URL(cfg.baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("0G Router requires an HTTPS base URL");
    this.base = cfg.baseUrl.replace(/\/$/, ""); this.cap = new SpendCap(cfg.maxTokensPerHour, cfg.maxTokensPerDay);
    if (cfg.stateFile) mkdirSync(dirname(cfg.stateFile), { recursive: true });
  }
  caps() { return this.cap.snapshot(); }
  async ledgerOg(): Promise<number> { throw new Error("Router account balance requires a management key; the inference key cannot read it"); }
  async depositOg(_amount: number): Promise<string> { throw new Error("Router deposits use its payment contract; direct SDK ledger deposits cannot fund this account"); }
  async teeSigner() { return null; }
  private reserve(tokens: number) {
    const now = Math.floor(Date.now() / 1000); const hour = Math.floor(now / 3600); const day = Math.floor(now / 86400);
    if (!this.cap.canSpend(tokens)) return false;
    if (this.cfg.stateFile) {
      const previous = existsSync(this.cfg.stateFile) ? JSON.parse(readFileSync(this.cfg.stateFile, "utf8")) : {};
      const hourTokens = previous.hour === hour ? previous.hourTokens : 0; const dayTokens = previous.day === day ? previous.dayTokens : 0;
      if (hourTokens + tokens > this.cfg.maxTokensPerHour || dayTokens + tokens > this.cfg.maxTokensPerDay) return false;
      // Reserve BEFORE the network call. Timeouts may still be billed; they never get a blind retry.
      writeFileSync(this.cfg.stateFile, JSON.stringify({ hour, day, hourTokens: hourTokens + tokens, dayTokens: dayTokens + tokens }), { mode: 0o600 });
    }
    this.cap.record(tokens); return true;
  }
  async think(policy: TierPolicy, messages: ChatMessage[], maxTokens = 600): Promise<BrainResult | null> {
    if (!policy.model || this.busy || Date.now() < this.blockedUntil) return null;
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) throw new Error("Invalid inference output limit");
    const input = messages.reduce((sum, m) => sum + Buffer.byteLength(m.content, "utf8") + 16, 0);
    if (input > policy.maxPromptTokens * 4) throw new Error("0G input exceeds this call's prompt budget");
    // UTF-8 bytes are a conservative token estimate; persist the full reservation, not unverified usage.
    if (!this.reserve(input + maxTokens)) return null;
    this.busy = true; const clientId = randomUUID(); const model = policy.model === "large" ? this.cfg.modelLarge : this.cfg.modelSmall;
    try {
      let response: Response;
      try {
        response = await this.send(`${this.base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}`, "X-Client-Request-Id": clientId, "X-0G-Provider-Trust-Mode": "verified", "X-0G-Provider-Sort": "price" }, body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.2, stream: false, verify_tee: true }), signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 60000) });
      } catch { throw new ZeroGServiceError(503, "unreachable", "The configured 0G Router could not be reached. Check its network/endpoint; no simulated response was substituted.", clientId); }
      const data: any = await response.json().catch(() => ({}));
      const requestId = response.headers.get("X-Request-ID") ?? data.x_0g_trace?.request_id ?? data.request_id ?? clientId;
      if (!response.ok) {
        if ([401, 402, 429].includes(response.status)) this.blockedUntil = Date.now() + 60000;
        const code = String(data.error?.code ?? "provider_error");
        const message = response.status === 402 ? "0G compute balance is insufficient. Deposit compute credits on the same network as this API key." : response.status === 401 ? "0G rejected the API key. Check that the key and Router endpoint use the same network." : `0G Router request failed (${response.status}, ${code}).`;
        throw new ZeroGServiceError(response.status, code, message, requestId);
      }
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim() || data.choices?.[0]?.finish_reason === "length") throw new ZeroGServiceError(502, "invalid_response", "0G returned an empty or truncated response; no strategy or order was accepted.", requestId);
      const trace = data.x_0g_trace;
      const billed = trace?.billing;
      const costOg = billed?.currency === "0g" && /^\d+$/.test(String(billed.total_cost)) ? Number(BigInt(billed.total_cost)) / 1e18 : NaN;
      const result: BrainResult = { content, chatId: requestId, model: data.model ?? model, provider: trace?.provider ?? response.headers.get("X-Provider") ?? "0g-router", verified: trace?.tee_verified === true ? true : trace?.tee_verified === false ? false : null, tee: null, tokens: Number(data.usage?.total_tokens ?? input + maxTokens), costOg, verificationSource: "0g-router", billing: billed ?? null };
      if (this.cfg.stateFile) appendFileSync(`${this.cfg.stateFile}.requests.jsonl`, JSON.stringify({ at: Date.now(), clientId, requestId, model: result.model, provider: result.provider, verified: result.verified, billing: billed ?? null, usage: data.usage ?? null }) + "\n", { mode: 0o600 });
      return result;
    } finally { this.busy = false; }
  }
}

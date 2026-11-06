import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { templateConfig, tierFor } from "../src";
import { acceptsInference, assertInferenceConfigured, createInference, inferenceBackend, OpenRouterInference } from "../../../agent/src/inference";
import { compileStrategy } from "../../../agent/src/strategy-compiler";

const policy = { ...tierFor(72), maxPromptTokens: 4000 };
const cfg = { apiKey: "secret-test-key", modelSmall: "test/small", modelLarge: "test/large", maxTokensPerHour: 20000, maxTokensPerDay: 50000 };
const directories: string[] = [];
afterEach(() => { for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }); });
const reply = (extra: Record<string, unknown> = {}) => new Response(JSON.stringify({ id: "generation-1", model: "test/actual-model", choices: [{ message: { content: '{"decision":"hold"}' }, finish_reason: "stop" }], usage: { total_tokens: 30, cost: 0.0001 }, ...extra }));

describe("modular inference selection", () => {
  it("gives --openrouter precedence without changing 0G settings", () => {
    const env = { ZG_MODE: "live", INFERENCE_PROVIDER: "0g-direct", OPENROUTER_API_KEY: cfg.apiKey, OPENROUTER_MODEL: cfg.modelSmall };
    expect(inferenceBackend(["--", "--openrouter"], env)).toBe("openrouter");
    expect(assertInferenceConfigured({ args: ["--openrouter"], env })).toBe("openrouter");
    expect(env.ZG_MODE).toBe("live"); expect(env.INFERENCE_PROVIDER).toBe("0g-direct");
  });
  it("preserves default 0G selection and supports an environment override for all processes", () => {
    expect(inferenceBackend([], { ZG_MODE: "router" })).toBe("0g-router");
    expect(inferenceBackend([], { ZG_MODE: "live" })).toBe("0g-direct");
    expect(inferenceBackend([], { ZG_MODE: "sim", INFERENCE_PROVIDER: "openrouter" })).toBe("openrouter");
    expect(() => inferenceBackend([], { INFERENCE_PROVIDER: "typo" })).toThrow("INFERENCE_PROVIDER");
    expect(() => inferenceBackend(["--openrouter=false"], {})).toThrow("without a value");
  });
  it("requires explicit provider credentials and never falls back after a selection error", async () => {
    const send = vi.fn();
    await expect(createInference({ args: ["--openrouter"], env: { ZG_MODE: "live", ZG_PRIVATE_KEY: "present", ZG_PROVIDER_SMALL: "present" }, send })).rejects.toThrow("OPENROUTER_API_KEY");
    expect(send).not.toHaveBeenCalled();
    expect(() => assertInferenceConfigured({ args: [], env: { ZG_MODE: "sim" } })).toThrow("Configure ZG_MODE");
  });
  it("creates either HTTP provider through the same interface", async () => {
    const openrouter = await createInference({ args: ["--openrouter"], env: { OPENROUTER_API_KEY: cfg.apiKey, OPENROUTER_MODEL: cfg.modelSmall }, send: (async () => reply()) as typeof fetch });
    const router = await createInference({ args: [], env: { ZG_MODE: "router", ZG_API_KEY: "router-key" }, send: (async () => new Response(JSON.stringify({ id: "zg-1", choices: [{ message: { content: "ok" } }], x_0g_trace: { tee_verified: true } }))) as typeof fetch });
    expect(openrouter.backend).toBe("openrouter"); expect(router.backend).toBe("0g-router");
    expect((await router.complete(policy, [{ role: "user", content: "Test" }], 10))?.verified).toBe(true);
  });
});

describe("OpenRouter adapter", () => {
  it("uses the selected model and Bearer auth, records USD costs and never invents a TEE proof", async () => {
    const send = vi.fn(async () => reply());
    const provider = new OpenRouterInference(cfg, send as typeof fetch);
    const result = await provider.complete({ ...policy, model: "large" }, [{ role: "user", content: "Test" }], 80);
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret-test-key");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: cfg.modelLarge, max_tokens: 80, stream: false });
    expect(result).toMatchObject({ chatId: "generation-1", provider: "openrouter", verified: null, tee: null, verificationSource: "openrouter", tokens: 30, billing: { currency: "USD", totalCost: 0.0001 } });
    expect(Number.isNaN(result!.costOg)).toBe(true);
    expect(acceptsInference(provider, result, "analysis")).toBe(true);
    expect(acceptsInference(provider, result, "execution")).toBe(false);
  });
  it("leaves omitted billing and usage explicitly unknown", async () => {
    const provider = new OpenRouterInference(cfg, (async () => reply({ usage: undefined })) as typeof fetch);
    expect(await provider.complete(policy, [{ role: "user", content: "Test" }])).toMatchObject({ tokens: 0, billing: { totalCost: null, usageReported: false } });
  });
  it.each([401, 402, 429])("does not retry HTTP %i and redacts provider error details", async (status) => {
    const send = vi.fn(async () => new Response(JSON.stringify({ error: { message: cfg.apiKey } }), { status }));
    const provider = new OpenRouterInference(cfg, send as typeof fetch);
    await expect(provider.complete(policy, [{ role: "user", content: "Test" }])).rejects.toMatchObject({ status });
    expect(await provider.complete(policy, [{ role: "user", content: "Test" }])).toBeNull(); expect(send).toHaveBeenCalledTimes(1);
    const other = new OpenRouterInference(cfg, send as typeof fetch);
    await expect(other.complete(policy, [{ role: "user", content: "Test" }])).rejects.not.toThrow(cfg.apiKey);
  });
  it("rejects empty, truncated, malformed and provider-error completions", async () => {
    for (const extra of [{ choices: [] }, { choices: [{ message: { content: "{}" }, finish_reason: "length" }] }, { error: { message: cfg.apiKey } }]) {
      const provider = new OpenRouterInference(cfg, (async () => reply(extra)) as typeof fetch);
      await expect(provider.complete(policy, [{ role: "user", content: "Test" }])).rejects.toThrow();
    }
  });
  it("forwards cancellation and keeps pre-call reservations after unknown network outcomes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perpetua-openrouter-")); directories.push(dir);
    const budget = { ...cfg, stateFile: join(dir, "budget.json"), maxTokensPerHour: 90, maxTokensPerDay: 90 };
    const failed = new OpenRouterInference(budget, (async () => { throw new Error(cfg.apiKey); }) as typeof fetch);
    await expect(failed.complete(policy, [{ role: "user", content: "A" }], 40)).rejects.not.toThrow(cfg.apiKey);
    const send = vi.fn(async () => reply());
    const restarted = new OpenRouterInference(budget, send as typeof fetch);
    expect(await restarted.complete(policy, [{ role: "user", content: "A" }], 40)).toBeNull(); expect(send).not.toHaveBeenCalled();
    const controller = new AbortController();
    const cancellable = new OpenRouterInference(cfg, (async (_url, init) => new Promise((_resolve, reject) => { init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); })) as typeof fetch);
    const work = cancellable.complete(policy, [{ role: "user", content: "A" }], 40, controller.signal); controller.abort(new Error("run_deadline_exceeded"));
    await expect(work).rejects.toThrow("run_deadline_exceeded");
  });
  it("compiles a strictly validated testing draft with honest provenance", async () => {
    const config = templateConfig("spot-dca");
    const provider = new OpenRouterInference(cfg, (async () => reply({ choices: [{ message: { content: JSON.stringify({ config, assumptions: [], unsupportedRequirements: [] }) }, finish_reason: "stop" }] })) as typeof fetch);
    const draft = await compileStrategy(provider, "Accumulate BTC cautiously");
    expect(draft.config).toEqual(config);
    expect(draft.proof).toMatchObject({ backend: "openrouter", testingOnly: true, verified: null, costOg: null, verificationSource: "openrouter" });
  });
});

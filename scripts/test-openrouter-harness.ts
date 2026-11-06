/** Explicitly invoked, bounded live inference test. No trading or Arkiv writes. */
import "../agent/src/config";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { configHash, templateConfig } from "@perpetua/core";
import { createInference, type InferenceProvider } from "../agent/src/inference";
import { defaultPorts } from "../agent/src/runtime/ports";
import { MinuteHarness } from "../agent/src/runtime/run";
import { RuntimeStore } from "../agent/src/runtime/store";
import type { RuntimeAgent } from "../agent/src/runtime/types";

const MODEL = "qwen/qwen3.7-flash";
const MAX_USD = 0.04, MAX_CALLS = 8, INPUT_USD_PER_M = 0.25, OUTPUT_USD_PER_M = 1;
const root = process.env.PERPETUA_STATE_DIR!;
const directory = resolve(root, "inference-tests", `qwen-flash-${Date.now()}`);
const budgetFile = resolve(root, "qwen-flash-smoke-budget.json");
if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is required");
const metadataResponse = await fetch(`https://openrouter.ai/api/v1/models/${MODEL}/endpoints`, { signal: AbortSignal.timeout(15000) });
if (!metadataResponse.ok) throw new Error(`Model catalog HTTP ${metadataResponse.status}`);
const metadata = (await metadataResponse.json() as any).data;
if (metadata.id !== MODEL || !metadata.endpoints.some((e: any) => Number(e.pricing.prompt) * 1e6 <= INPUT_USD_PER_M && Number(e.pricing.completion) * 1e6 <= OUTPUT_USD_PER_M)) throw new Error("Requested model is not available within the price ceilings");
mkdirSync(directory, { recursive: true });
const ledger: { model: string; reservedUsd: number; calls: any[] } = existsSync(budgetFile) ? JSON.parse(readFileSync(budgetFile, "utf8")) : { model: MODEL, reservedUsd: 0, calls: [] };
if (ledger.model !== MODEL) throw new Error("Budget ledger model mismatch");
const saveBudget = () => writeFileSync(budgetFile, JSON.stringify(ledger, null, 2), { mode: 0o600 });
const billedTotal = () => ledger.calls.reduce((sum, c) => sum + (c.billedUsd ?? 0), 0);
const boundedFetch: typeof fetch = async (url, init) => {
  if (url !== "https://openrouter.ai/api/v1/chat/completions") throw new Error("Unexpected inference endpoint");
  const request = JSON.parse(String(init?.body));
  if (request.model !== MODEL) throw new Error("Unexpected model");
  const inputBound = Buffer.byteLength(JSON.stringify(request.messages), "utf8") + 512;
  const maxTokens = Math.min(request.max_tokens, 768);
  // UTF-8 bytes conservatively bound text tokens; reserve overhead and a 25% margin.
  const upperUsd = (inputBound * INPUT_USD_PER_M / 1e6 + maxTokens * OUTPUT_USD_PER_M / 1e6) * 1.25;
  if (inputBound > 24000 || ledger.calls.length >= MAX_CALLS || ledger.reservedUsd + upperUsd > MAX_USD) throw new Error("Live smoke-test budget exhausted before submission");
  const entry: any = { index: ledger.calls.length + 1, upperUsd, submittedAt: new Date().toISOString(), state: "unknown" };
  ledger.calls.push(entry); ledger.reservedUsd += upperUsd; saveBudget();
  const response = await fetch(url, { ...init, body: JSON.stringify({ ...request, max_tokens: maxTokens,
    reasoning: { enabled: false }, provider: { allow_fallbacks: false, max_price: { prompt: INPUT_USD_PER_M, completion: OUTPUT_USD_PER_M, request: 0 } },
  }) });
  const data: any = await response.clone().json().catch(() => ({}));
  const cost = Number(data.usage?.cost);
  Object.assign(entry, { state: response.ok ? "responded" : "http_error", status: response.status, requestId: data.id, model: data.model,
    finishReason: data.choices?.[0]?.finish_reason, tokens: data.usage?.total_tokens,
    billedUsd: data.usage?.cost != null && Number.isFinite(cost) && cost >= 0 ? cost : null,
  });
  saveBudget();
  console.log(JSON.stringify({ event: "inference_response", ...entry, totalReportedUsd: billedTotal() }));
  return response;
};

const store = new RuntimeStore(resolve(directory, "runtime.sqlite"));
const owner = `0x${"11".repeat(20)}`;
store.bindPortfolio({ id: "smoke-portfolio", owner, chainId: 31337, rpc: "http://127.0.0.1:8545", vault: owner, wallet: owner, stable: owner, riskGate: owner });
const defaults = defaultPorts();
const providers = new Map<string, Promise<InferenceProvider>>();
const ports = { ...defaults,
  inference: async (agent: RuntimeAgent) => {
    if (!providers.has(agent.id)) providers.set(agent.id, createInference({ args: ["--openrouter"], env: { ...process.env, OPENROUTER_MODEL: MODEL }, send: boundedFetch, timeoutMs: 35000 }));
    return providers.get(agent.id)!;
  },
  portfolio: async () => ({ portfolioId: "smoke-portfolio", owner, sourceAtMs: Date.now(), cashMicros: "100000000", capacityMicros: "50000000", positions: [], source: "explicit_test_fixture; not a funded wallet" }),
  executor: undefined,
};
const agents = ["spot-momentum", "spot-range"].map((template, i) => {
  const config = templateConfig(template as "spot-momentum" | "spot-range"); config.symbols = ["BTC"];
  return store.activate({ id: `qwen-smoke-${i}`, owner, name: `Qwen test ${i}`, revision: 1, config, configHash: configHash(config), portfolioId: "smoke-portfolio", mode: "analysis", status: "active",
    instructions: `Integration test using a fixture portfolio: do not trade. Return a final hold with a concise rationale. In memorySummary preserve marker QWEN_TEST_${i} and describe what to review next. If previous memory exists, acknowledge its marker. ${i === 0 ? "On the first run only, request market.live for BTC once before the final decision to exercise tool feedback." : "Use the supplied observations to decide immediately."}` });
});
const harness = new MinuteHarness(store, ports);
const firstSlot = Math.floor(Date.now() / 60000);
try {
  // Accelerated logical minute slots exercise persistence without leaving an unattended scheduler running.
  for (let round = 0; round < 2; round++) {
    await Promise.all(agents.map(async (agent) => {
      const now = Date.now(), run = store.claim(agent, firstSlot + round, now, now + 55000)!;
      await harness.run(agent, run);
      const result = store.run(run.id)!;
      console.log(JSON.stringify({ event: "agent_run", agent: agent.name, round: round + 1, status: result.status, decision: result.decision, error: result.error, memoryVersion: store.memory(agent.id).version }));
    }));
  }
  const rows = agents.map((a, i) => ({ agentId: a.id, name: a.name, runs: store.runs(a.id).map(({ snapshot, ...r }) => r), memory: store.memory(a.id),
    memoryMarkerPreserved: store.memory(a.id).summary.includes(`QWEN_TEST_${i}`),
    tools: store.events(a.id).filter((e) => ["tool_requested", "tool_failed"].includes(e.kind)),
    contextMemoryVersions: store.events(a.id).filter((e) => e.kind === "context_loaded").map((e) => (e.payload as any).memoryVersion),
  }));
  const completed = rows.every((r) => r.runs.every((run) => run.status === "completed") && r.memory.version === 2 && r.memoryMarkerPreserved && r.contextMemoryVersions.includes(1));
  const summary = { model: MODEL, completed, acceleratedSlots: true, fixturePortfolio: true, liveSources: "direct live feeds + configured Arkiv history; tool failures recorded explicitly", arkivWrites: false, trades: store.actions().length,
    reportedCostUsd: billedTotal(), conservativeReservedUsd: ledger.reservedUsd, requests: ledger.calls.length, unknownCostRequests: ledger.calls.filter((c) => c.billedUsd == null).length,
    agents: rows, createdAt: new Date().toISOString() };
  writeFileSync(resolve(directory, "result.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ event: "summary", completed, model: MODEL, reportedCostUsd: summary.reportedCostUsd, conservativeReservedUsd: ledger.reservedUsd, requests: ledger.calls.length, artifact: resolve(directory, "result.json") }));
  if (!completed) process.exitCode = 1;
} finally { store.close(); }

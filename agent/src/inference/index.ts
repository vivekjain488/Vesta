import type { Brain } from "../zerog";
import { ZeroGBrain } from "../zerog";
import { ZeroGRouterBrain } from "../zerog-router";
import { OpenRouterInference } from "./openrouter";
import type { InferenceBackend, InferenceProvider } from "./types";
export * from "./types";
export * from "./openrouter";

export interface InferenceOptions {
  args?: string[]; env?: NodeJS.ProcessEnv; send?: typeof fetch;
  maxTokensPerHour?: number; maxTokensPerDay?: number; timeoutMs?: number; stateFile?: string;
}
export function inferenceBackend(args = process.argv.slice(2), env = process.env): InferenceBackend {
  if (args.some((arg) => arg.startsWith("--openrouter=") || arg.startsWith("--openrouter-"))) throw new Error("Use --openrouter without a value");
  if (args.includes("--openrouter")) return "openrouter";
  const selected = env.INFERENCE_PROVIDER;
  if (selected === "openrouter" || selected === "0g-router" || selected === "0g-direct") return selected;
  if (selected && selected !== "0g") throw new Error("INFERENCE_PROVIDER must be 0g, 0g-router, 0g-direct or openrouter");
  return env.ZG_MODE === "router" ? "0g-router" : "0g-direct";
}
export function assertInferenceConfigured(options: InferenceOptions = {}) {
  const env = options.env ?? process.env, backend = inferenceBackend(options.args, env);
  if (backend === "openrouter") {
    if (!env.OPENROUTER_API_KEY?.trim() || !env.OPENROUTER_MODEL?.trim()) throw new Error("Set OPENROUTER_API_KEY and OPENROUTER_MODEL for --openrouter");
  } else if (backend === "0g-router") {
    if (!env.ZG_API_KEY?.trim()) throw new Error("Set ZG_API_KEY for 0G Router inference");
  } else if (!(env.ZG_MODE === "live" || env.INFERENCE_PROVIDER === "0g-direct") || !(env.ZG_PRIVATE_KEY ?? env.PROPOSER_PRIVATE_KEY) || !env.ZG_PROVIDER_SMALL) throw new Error("Configure ZG_MODE=router or live with provider credentials, or select --openrouter for testing");
  return backend;
}
/** Compatibility adapter: legacy 0G runtimes keep their funding API, the harness sees only inference. */
export function inferenceFromBrain(brain: Brain): InferenceProvider {
  return {
    backend: brain.fundingMode === "router" ? "0g-router" : "0g-direct", testingOnly: false,
    complete: async (...args) => {
      if (brain.mode !== "live") throw new Error("Hosted inference requires a live provider; simulated inference is not accepted");
      return brain.think(...args);
    },
  };
}
export async function createInference(options: InferenceOptions = {}): Promise<InferenceProvider> {
  const env = options.env ?? process.env, backend = assertInferenceConfigured(options);
  const limits = { maxTokensPerHour: options.maxTokensPerHour ?? 10_000_000, maxTokensPerDay: options.maxTokensPerDay ?? 100_000_000 };
  if (backend === "openrouter") return new OpenRouterInference({ apiKey: env.OPENROUTER_API_KEY!, modelSmall: env.OPENROUTER_MODEL!, modelLarge: env.OPENROUTER_MODEL_LARGE, ...limits, timeoutMs: options.timeoutMs, stateFile: options.stateFile }, options.send);
  if (backend === "0g-router") return inferenceFromBrain(new ZeroGRouterBrain({ apiKey: env.ZG_API_KEY!, baseUrl: env.ZG_BASE_URL ?? "https://router-api.0g.ai/v1", modelSmall: env.ZG_MODEL_SMALL ?? "0gm-1.0-35b-a3b", modelLarge: env.ZG_MODEL_LARGE ?? "glm-5.2", ...limits, timeoutMs: options.timeoutMs ?? 35000, stateFile: options.stateFile }, options.send));
  return inferenceFromBrain(await new ZeroGBrain({ rpc: env.ZG_RPC_URL ?? "https://evmrpc-testnet.0g.ai", privateKey: (env.ZG_PRIVATE_KEY ?? env.PROPOSER_PRIVATE_KEY) as `0x${string}`, providerLarge: env.ZG_PROVIDER_LARGE ?? "", providerSmall: env.ZG_PROVIDER_SMALL!, subAccountTopUpOg: Number(env.ZG_SUBACCOUNT_TOPUP_OG ?? 1), minLedgerOg: 3, ...limits, initializeLedger: false }).init());
}

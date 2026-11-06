import "../config";
import { resolve } from "node:path";
import { RuntimeArkivPort } from "@perpetua/arkiv";
import { RuntimeStore } from "./store";
import { RuntimeService } from "./service";
import { AuditPublisher } from "./publisher";
import { loadRuntimePorts } from "./ports";
import { assertInferenceConfigured } from "../inference";

const state = process.env.PERPETUA_STATE_DIR!;
const backend = assertInferenceConfigured();
if (process.env.HOSTED_RUNTIME_ENABLED !== "true") throw new Error("Set HOSTED_RUNTIME_ENABLED=true for both API and worker; legacy local workers must be disabled for shared allocations");
const store = new RuntimeStore(resolve(state, "runtime.sqlite"));
const ports = await loadRuntimePorts();
if (process.env.HOSTED_RUNTIME_EXECUTION_ENABLED !== "true" || backend === "openrouter") delete ports.executor;
const key = process.env.ARKIV_RUNTIME_PRIVATE_KEY as `0x${string}` | undefined;
if (!key) throw new Error("ARKIV_RUNTIME_PRIVATE_KEY is required; hosted decisions must publish to Arkiv");
const audit = new RuntimeArkivPort(key);
if (process.env.ARKIV_RUNTIME_WRITER_ADDRESS?.toLowerCase() !== audit.owner.toLowerCase()) throw new Error("Runtime audit writer key/address mismatch");
const publisher = new AuditPublisher(store, audit);
const integer = (name: string, fallback: number) => { const n = Number(process.env[name] ?? fallback); if (!Number.isSafeInteger(n) || n < 1) throw new Error(`Invalid ${name}`); return n; };
const service = new RuntimeService(store, ports, {
  maxConcurrent: integer("HOSTED_MAX_CONCURRENT", 8), agentDailyTokens: integer("HOSTED_AGENT_DAILY_TOKENS", 20_000_000),
  walletDailyTokens: integer("HOSTED_WALLET_DAILY_TOKENS", 40_000_000), platformDailyTokens: integer("HOSTED_PLATFORM_DAILY_TOKENS", 200_000_000),
});
let stopping = false; let executing = false; let publishing = false;
let execution: Promise<unknown> = Promise.resolve(), publication: Promise<unknown> = Promise.resolve();
process.once("SIGINT", () => { stopping = true; }); process.once("SIGTERM", () => { stopping = true; });
console.log(`[hosted] inference=${backend}${backend === "openrouter" ? " (testing, no TEE)" : ""}; ${ports.executor ? "trusted execution adapter" : "analysis only"}; audit writer ${audit.owner}`);
while (!stopping) {
  service.step();
  if (!publishing) { publishing = true; publication = publisher.flush(20).catch((e) => console.error("[hosted:audit]", e.message)).finally(() => { publishing = false; }); }
  if (!executing) { executing = true; execution = service.executePending().catch((e) => console.error("[hosted:execution]", e.message)).finally(() => { executing = false; }); }
  await new Promise((done) => setTimeout(done, 1000));
}
await service.stop(); await Promise.allSettled([execution, publication]); store.close();

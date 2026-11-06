/** Backend entrypoint. HOSTED_ADAPTER_MODULE is an operator-controlled local module, never user input. */
import "dotenv/config";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { configHash, ownerAddress, validateStrategyConfig, type AgentDefinition } from "@perpetua/core";
import { PaperHarness, type KnowledgeTools } from "./harness";
import { AgentSupervisor } from "./supervisor";
import type { Brain } from "./zerog";

const root = resolve(process.env.PERPETUA_STATE_DIR ?? ".perpetua");
mkdirSync(root, { recursive: true });
const modulePath = process.env.HOSTED_ADAPTER_MODULE;
if (!modulePath) throw new Error("HOSTED_ADAPTER_MODULE must point to a trusted backend adapter exporting createTools(definition). No live futures adapter is bundled; see docs/agent-platform.md.");
const backend = await import(pathToFileURL(resolve(modulePath)).href) as {
  createTools: (definition: AgentDefinition) => Promise<KnowledgeTools>;
  createBrain?: (definition: AgentDefinition) => Promise<Brain>;
};
if (typeof backend.createTools !== "function") throw new Error("Hosted adapter must export createTools");
const supervisor = new AgentSupervisor(async (definition) => {
  const tools = await backend.createTools(definition);
  const brain = await backend.createBrain?.(definition);
  const harness = new PaperHarness(definition, tools, (event) => appendFileSync(resolve(root, `harness-${definition.id}.jsonl`), JSON.stringify(event) + "\n"), brain);
  return { tick: () => harness.tick(), sleep: () => harness.sleep() };
}, (id, error) => console.error(`[hosted:${id}]`, (error as Error).message));

function definitions(): AgentDefinition[] {
  const directory = resolve(root, "definitions");
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((f) => /^[a-f0-9-]{36}\.json$/.test(f)).flatMap((file) => {
    try {
      const d = JSON.parse(readFileSync(resolve(directory, file), "utf8")) as AgentDefinition;
      if (`${d.id}.json` !== file || d.configHash !== configHash(validateStrategyConfig(d.config))) throw new Error("Definition identity/hash mismatch");
      ownerAddress(d.owner);
      return [d];
    } catch (e) { console.error(`[hosted] Invalid definition ${file}: ${(e as Error).message}`); return []; }
  });
}
let stopping = false;
const inFlight = new Set<Promise<void>>();
process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });
console.log("[hosted] paper evaluation service started; no order submission or simulated fill accounting");
while (!stopping) {
  await supervisor.reconcile(definitions());
  const work = supervisor.step().finally(() => inFlight.delete(work));
  inFlight.add(work);
  await new Promise((done) => setTimeout(done, 1000));
}
await Promise.allSettled(inFlight);
await supervisor.stop();

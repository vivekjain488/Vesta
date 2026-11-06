import { Router, type Request } from "express";
import { resolve } from "node:path";
import { configHash } from "@perpetua/core";
import { runtimeHistory } from "@perpetua/arkiv";
import { RuntimeStore } from "../../agent/src/runtime/store";
import { loadRuntimePorts } from "../../agent/src/runtime/ports";
import type { RuntimeAgent } from "../../agent/src/runtime/types";
import { assertInferenceConfigured } from "../../agent/src/inference";
import type { ConfigAction, AgentDefinitions } from "./agent-definitions";
import type { Platform } from "./platform";

export function runtimeRouter(platform: Platform, definitions: AgentDefinitions, ownerOf: (req: Request) => string, authorize: (req: Request, action: ConfigAction, payload: unknown) => Promise<string>) {
  const router = Router();
  const store = new RuntimeStore(resolve(platform.state, "runtime.sqlite"));
  const owned = (req: Request) => {
    const agent = store.agent(String(req.params.id)); if (!agent || agent.owner !== ownerOf(req).toLowerCase()) throw new Error("Runtime agent belongs to another wallet"); return agent;
  };
  router.get("/portfolios", (req, res) => { res.json(store.portfolios(ownerOf(req))); });
  router.post("/portfolios", async (req, res) => {
    try {
      const payload = req.body.payload;
      if (!payload || Object.keys(payload).length !== 1 || typeof payload.deploymentAgentId !== "string") throw new Error("Select an existing owned deployment as the shared portfolio");
      const owner = await authorize(req, "bind-portfolio", payload);
      if (!await platform.owns(payload.deploymentAgentId, owner)) throw new Error("Portfolio belongs to another wallet");
      const deployment = platform.deployment(), a = platform.agent(payload.deploymentAgentId);
      const chainId = await platform.pub.getChainId();
      const portfolio = store.bindPortfolio({ id: `${chainId}:${a.vault.toLowerCase()}`, owner, chainId, rpc: process.env.VAULT_RPC_URL ?? "http://127.0.0.1:8545", vault: a.vault, wallet: a.wallet, riskGate: a.riskGate, stable: deployment.usdc });
      res.status(201).json(portfolio);
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  router.get("/agents", (req, res) => { res.json(store.agents(ownerOf(req))); });
  router.post("/agents/:id/activate", async (req, res) => {
    try {
      const payload = req.body.payload;
      if (!payload || Object.keys(payload).some((k) => !["id", "revision", "portfolioId", "mode", "configHash", "instructionsHash"].includes(k)) || payload.id !== req.params.id) throw new Error("Invalid activation payload");
      const owner = await authorize(req, "activate-runtime", payload);
      const d = definitions.get(String(req.params.id));
      if (d.owner.toLowerCase() !== owner.toLowerCase() || d.revision !== payload.revision || d.configHash !== payload.configHash || configHash(d.instructions ?? "") !== payload.instructionsHash) throw new Error("Activation does not match the current signed definition");
      if (d.status === "sleeping") throw new Error("Update the sleeping definition before activation");
      // Existing local workers must not trade the same allocation outside this coordinator.
      if (process.env.HOSTED_RUNTIME_ENABLED !== "true") throw new Error("Enable HOSTED_RUNTIME_ENABLED before activating hosted agents");
      const backend = assertInferenceConfigured();
      if (!process.env.ARKIV_RUNTIME_WRITER_ADDRESS) throw new Error("Configure the runtime Arkiv writer before activation");
      if (!["analysis", "execute"].includes(payload.mode)) throw new Error("Invalid runtime mode");
      const agent: RuntimeAgent = { id: d.id, owner, name: d.name, revision: d.revision, configHash: d.configHash, config: d.config, instructions: d.instructions ?? "", portfolioId: payload.portfolioId, mode: payload.mode, status: "active" };
      const binding = store.portfolio(agent.portfolioId);
      if (!binding || binding.owner !== owner.toLowerCase()) throw new Error("Portfolio belongs to another wallet");
      if (payload.mode === "execute") {
        if (backend === "openrouter") throw new Error("OpenRouter testing supports analysis mode only; it does not provide a 0G TEE proof");
        if (process.env.HOSTED_RUNTIME_EXECUTION_ENABLED !== "true" || !process.env.HOSTED_RUNTIME_ADAPTER_MODULE) throw new Error("Live execution requires an explicitly enabled, trusted execution adapter");
        const { executor } = await loadRuntimePorts();
        if (!executor) throw new Error("Execution adapter is unavailable");
        const admitted = await executor.authorizeActivation(agent, binding); if (!admitted.ok) throw new Error(admitted.reason ?? "Execution capability is unavailable for this portfolio/configuration");
      }
      res.json(store.activate(agent));
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  router.post("/agents/:id/pause", async (req, res) => {
    try { if (req.body.payload?.id !== req.params.id || Object.keys(req.body.payload).length !== 1) throw new Error("Invalid pause payload"); const owner = await authorize(req, "pause-runtime", req.body.payload); res.json(store.pause(String(req.params.id), owner)); }
    catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  router.get("/agents/:id/runs", (req, res) => { try { const a = owned(req); res.json(store.runs(a.id)); } catch (e) { res.status(403).json({ error: (e as Error).message }); } });
  router.get("/agents/:id/decision", (req, res) => {
    try {
      const a = owned(req), run = store.runs(a.id).find((r) => r.status !== "running") ?? null;
      const disposition = run ? store.events(a.id).find((e) => e.runId === run.id && ["action_rejected", "action_not_submitted", "action_reserved"].includes(e.kind)) : null;
      res.json({ run, disposition, publication: store.publicationStatus(a.id), actions: store.actions(a.portfolioId).filter((x) => x.agentId === a.id) });
    } catch (e) { res.status(403).json({ error: (e as Error).message }); }
  });
  router.get("/agents/:id/memory", (req, res) => { try { res.json(store.memory(owned(req).id)); } catch (e) { res.status(403).json({ error: (e as Error).message }); } });
  router.get("/agents/:id/events", async (req, res) => {
    try {
      const a = owned(req);
      if (req.query.source === "arkiv") {
        const writer = process.env.ARKIV_RUNTIME_WRITER_ADDRESS as `0x${string}` | undefined; if (!writer) throw new Error("Runtime audit writer is not configured");
        res.json({ source: "arkiv", events: await runtimeHistory(a.owner, a.id, writer) });
      } else res.json({ source: "operational_journal", publication: store.publicationStatus(a.id), events: store.events(a.id) });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  return router;
}

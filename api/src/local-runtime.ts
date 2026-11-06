import { readdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PerpetuaAgent } from "../../agent/src/agent";
import { loadConfig } from "../../agent/src/config";
import { AgentDefinitions } from "./agent-definitions";
import { Platform } from "./platform";
import { chainOperation, refreshLocalRisk } from "./local-withdrawals";
import type { AgentDefinition, StrategyKind } from "@perpetua/core";

export function pendingWithdrawals(platform: Platform, id: string) {
  const directory = resolve(platform.state, "withdrawals"); if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((f) => f.endsWith(".json")).map((file) => ({ file: resolve(directory, file), ...JSON.parse(readFileSync(resolve(directory, file), "utf8")) })).filter((r) => r.agent === id && ["closing_positions", "ready_for_wallet_withdrawal", "failed"].includes(r.status));
}
export function finishWithdrawals(platform: Platform, id: string, status: "completed" | "cancelled", transactionHash?: string) {
  for (const { file, ...request } of pendingWithdrawals(platform, id)) { if (request.status === "closing_positions") throw new Error("Withdrawal is still closing positions"); writeFileSync(file, JSON.stringify({ ...request, status, transactionHash, finishedAt: Date.now() }, null, 2)); }
}
/** Hosts configured local spot agents independently of browser sessions. On-chain gates remain authoritative. */
export function startLocalRuntime(platform: Platform, definitions: AgentDefinitions) {
  const workers = new Map<string, { revision: number; agent: PerpetuaAgent; next: number }>(); let running = false;
  const tick = async () => {
    if (running || process.env.FLASH_MODE !== "sim") return; running = true;
    try {
      if (await platform.pub.getChainId() !== 31337) return;
      for (const deployed of platform.agents().filter((a) => a.platformAgent)) {
        try {
          const d: AgentDefinition = definitions.get(deployed.id);
          if (d.status !== "paper" || pendingWithdrawals(platform, deployed.id).length) continue;
          let worker = workers.get(d.id); if (worker && worker.next > Date.now()) continue;
          const summary = await platform.summary(deployed);
          if (summary.chain.withdrawalPaused || summary.chain.V < d.config.compute.minimumCapitalUsd) continue;
          if (!worker || worker.revision !== d.revision) {
            worker?.agent.writer.stop();
            const base = loadConfig(); const kind: StrategyKind = d.config.template === "spot-dca" ? "dca" : d.config.template === "spot-range" ? "mean-reversion" : "momentum";
            const agent = await PerpetuaAgent.create({ ...base, agentName: d.id, agentId: deployed.agentId, vault: deployed.vault, wallet: deployed.wallet, riskGate: deployed.riskGate, assets: deployed.assets, strategy: kind, strategyConfig: d.config, tickSeconds: d.config.execution.pollSeconds });
            agent.writer.start(); worker = { agent, revision: d.revision, next: 0 }; workers.set(d.id, worker);
          }
          worker.next = Date.now() + d.config.execution.pollSeconds * 1000;
          await chainOperation(async () => { if (pendingWithdrawals(platform, d.id).length) return; await refreshLocalRisk(platform, d.id); await worker!.agent.tick(); });
        } catch (e) { console.error(`[agent:${deployed.id}] ${(e as Error).message}`); }
      }
    } finally { running = false; }
  };
  const timer = setInterval(() => void tick().catch((e) => console.error("[agents]", e.message)), 5000); timer.unref();
  return { stop: () => { clearInterval(timer); for (const w of workers.values()) w.agent.writer.stop(); } };
}

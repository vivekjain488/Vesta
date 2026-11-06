import { randomUUID } from "node:crypto";
import type { RuntimeStore } from "./store";
import { MinuteHarness, type RunOptions } from "./run";
import type { RuntimePorts } from "./types";

export class RuntimeService {
  private readonly running = new Map<string, Promise<void>>();
  private readonly harness: MinuteHarness;
  private stopping = false;
  constructor(private readonly store: RuntimeStore, private readonly ports: RuntimePorts, private readonly options: RunOptions & { maxConcurrent?: number } = {}) { this.harness = new MinuteHarness(store, ports, options); }
  step(now = Date.now()) {
    if (this.stopping) return;
    const slot = Math.floor(now / 60000), deadline = (slot + 1) * 60000 - 3000;
    // Rotate admission order each minute so a single large wallet cannot always win.
    const agents = this.store.agents().filter((a) => a.status === "active").sort((a, b) => a.id.localeCompare(b.id));
    for (const a of agents) this.store.auditSchedule(a, slot, now);
    if (deadline - now < 10000) { for (const a of agents) this.store.skip(a, slot, now, "minute_admission_deadline_exceeded"); return; }
    const offset = agents.length ? slot % agents.length : 0;
    for (const a of [...agents.slice(offset), ...agents.slice(0, offset)]) {
      if (this.running.size >= (this.options.maxConcurrent ?? 8)) break;
      if (this.running.has(a.id)) continue;
      const run = this.store.claim(a, slot, now, deadline); if (!run) continue;
      const work = this.harness.run(a, run).finally(() => this.running.delete(a.id));
      this.running.set(a.id, work);
    }
  }
  async drain() { await Promise.allSettled(this.running.values()); }
  async stop() { this.stopping = true; await this.drain(); }
  async executePending() {
    const adapter = this.ports.executor; if (!adapter) return;
    for (const candidate of this.store.actions().filter((a) => ["reserved", "submitting", "submitted", "unknown"].includes(a.state))) {
      const holder = randomUUID(), lane = `execution:${candidate.portfolioId}`;
      if (!this.store.lock(lane, holder, Date.now() + 90000)) continue;
      try {
        // Another process may have changed this action while we waited for the portfolio lane.
        const action = this.store.action(candidate.id)!;
        if (!["reserved", "submitting", "submitted", "unknown"].includes(action.state)) continue;
        const binding = this.store.portfolio(action.portfolioId)!;
        const signal = AbortSignal.timeout(30000);
        if (action.state !== "reserved") {
          // Never repeat a submission whose external outcome is uncertain.
          const result = await adapter.reconcile(action, binding, signal); this.store.updateAction(action, result); continue;
        }
        const agent = this.store.agent(action.agentId)!;
        if (agent.status !== "active" || agent.revision !== action.revision || agent.generation !== action.generation || agent.portfolioId !== action.portfolioId || Date.now() - action.createdAtMs > agent.config.execution.maxDecisionAgeSeconds * 1000) {
          this.store.updateAction(action, { state: "rejected", details: "activation_revoked_or_decision_expired" }); continue;
        }
        // Intent is part of the run's append-only history. New entries wait for confirmed publication.
        if (!this.store.intentPublished(action.runId)) continue;
        const checked = await adapter.validate(action, agent, binding, signal);
        const latest = this.store.agent(agent.id)!;
        if (!checked.ok || latest.status !== "active" || latest.revision !== action.revision || latest.generation !== action.generation) { this.store.updateAction(action, { state: "rejected", details: checked.reason ?? "activation_revoked" }); continue; }
        const submitting = this.store.updateAction(action, { state: "submitting" });
        try { this.store.updateAction(submitting, await adapter.submit(submitting, agent, binding, signal)); }
        catch { this.store.updateAction(submitting, { state: "unknown", details: "submission_failed_or_timed_out; reconcile before retry" }); }
      } finally { this.store.unlock(lane, holder); }
    }
  }
}

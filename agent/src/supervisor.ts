import { configHash, type AgentDefinition } from "@perpetua/core";

export interface HostedWorker { tick(): Promise<unknown>; close?(): Promise<void> }
interface Slot { revision: string; intervalMs: number; dueAt: number; worker: HostedWorker; busy: boolean }

/**
 * Server-owned scheduler: one worker per immutable agent ID, never one per login session.
 * Adapter provisioning controls which approved definitions can run. Trading keys stay in that backend.
 * A multi-process deployment must add a durable lease per agent; this scheduler is single-process.
 */
export class AgentSupervisor {
  private readonly slots = new Map<string, Slot>();
  private stopped = false;
  constructor(private readonly createWorker: (definition: AgentDefinition) => Promise<HostedWorker>, private readonly report: (agentId: string, error: unknown) => void) {}

  async reconcile(definitions: AgentDefinition[]) {
    if (this.stopped) throw new Error("Supervisor is stopped");
    const active = new Map(definitions.filter((d) => d.status === "paper").map((d) => [d.id, d]));
    for (const [id, slot] of this.slots) {
      const next = active.get(id);
      const revision = next ? `${next.owner}:${next.revision}:${configHash(next.config)}` : null;
      if (revision === slot.revision) { active.delete(id); continue; }
      if (slot.busy) { active.delete(id); continue; } // finish an in-flight cycle before replacing it
      await slot.worker.close?.();
      this.slots.delete(id);
    }
    for (const [id, definition] of active) {
      if (this.slots.has(id)) continue;
      try {
        const worker = await this.createWorker(structuredClone(definition));
        this.slots.set(id, { revision: `${definition.owner}:${definition.revision}:${configHash(definition.config)}`, intervalMs: definition.config.execution.pollSeconds * 1000, dueAt: 0, worker, busy: false });
      } catch (e) { this.report(id, e); }
    }
  }
  async step(now = Date.now()) {
    if (this.stopped) return;
    await Promise.all([...this.slots.entries()].map(async ([id, slot]) => {
      if (slot.busy || now < slot.dueAt) return;
      slot.busy = true;
      try { await slot.worker.tick(); } catch (e) { this.report(id, e); }
      finally { slot.busy = false; slot.dueAt = now + slot.intervalMs; }
    }));
  }
  status() { return [...this.slots].map(([id, s]) => ({ id, busy: s.busy, nextRunAt: s.dueAt, intervalMs: s.intervalMs })); }
  async stop() {
    this.stopped = true;
    for (const slot of this.slots.values()) {
      if (slot.busy) throw new Error("Wait for in-flight cycles before closing workers");
      await slot.worker.close?.();
    }
    this.slots.clear();
  }
}

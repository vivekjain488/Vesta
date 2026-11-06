import { randomUUID } from "node:crypto";
import type { AuditEvent } from "./types";
import type { RuntimeStore } from "./store";

export interface AuditPort {
  owner: string;
  find(id: string): Promise<string | undefined>;
  send(event: AuditEvent): Promise<string>;
  sendBatch?(events: AuditEvent[]): Promise<string>;
  confirm(hash: string): Promise<void>;
}
export class AuditPublisher {
  private busy = false;
  constructor(private readonly store: RuntimeStore, private readonly port: AuditPort) {}
  async flush(limit = 10) {
    if (this.busy) return; this.busy = true;
    const holder = randomUUID(), lane = `arkiv:${this.port.owner.toLowerCase()}`;
    if (!this.store.lock(lane, holder, Date.now() + 120000)) { this.busy = false; return; }
    try {
      const fresh: AuditEvent[] = [];
      for (const event of this.store.pending(limit)) {
        const existing = await this.port.find(event.id);
        if (existing) { this.store.acknowledge(event.id, existing); continue; }
        let hash = this.store.publication(event.id);
        // The SDK waits for receipts internally. Persist an uncertainty marker BEFORE entering it.
        // A crash or timeout cannot cause a second blind create; lookup reconciles confirmed entities.
        if (hash === "unknown") throw new Error(`Arkiv submission uncertain for ${event.id}; reconcile the writer transaction before retry`);
        if (!hash) {
          if (this.port.sendBatch) { fresh.push(event); continue; }
          this.store.submittedPublication(event.id, "unknown");
          try { hash = await this.port.send(event); this.store.submittedPublication(event.id, hash); }
          catch (error) { const txHash = (error as any).txHash; if (typeof txHash === "string") this.store.submittedPublication(event.id, txHash); throw error; }
        }
        await this.port.confirm(hash);
        const key = await this.port.find(event.id); if (!key) throw new Error("Confirmed runtime entity not indexed yet");
        this.store.acknowledge(event.id, key);
      }
      // Bound both count and bytes; large captured observations get their own transaction.
      while (fresh.length) {
        const batch: AuditEvent[] = []; let bytes = 0;
        while (fresh.length && batch.length < 5) {
          const size = Buffer.byteLength(JSON.stringify(fresh[0]), "utf8");
          if (batch.length && bytes + size > 100000) break;
          batch.push(fresh.shift()!); bytes += size;
        }
        for (const event of batch) this.store.submittedPublication(event.id, "unknown");
        let hash: string;
        try { hash = await this.port.sendBatch!(batch); }
        catch (error) { if (typeof (error as any).txHash === "string") for (const event of batch) this.store.submittedPublication(event.id, (error as any).txHash); throw error; }
        for (const event of batch) this.store.submittedPublication(event.id, hash);
        await this.port.confirm(hash);
        for (const event of batch) { const key = await this.port.find(event.id); if (!key) throw new Error("Confirmed runtime batch not indexed yet"); this.store.acknowledge(event.id, key); }
      }
    } finally { this.store.unlock(lane, holder); this.busy = false; }
  }
}

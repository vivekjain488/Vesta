import { ExpirationTime, type Schema } from "@arkiv-network/sdk";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Hex } from "viem";
import { arkivWallet } from "./client";

export interface WriteOp {
  uid: string; // natural key -> entity key map makes retries patch instead of duplicating
  schema: Schema;
  values: Record<string, unknown>;
  expiresInDays: number;
  /** Unchanged record: only extend its expiry (cheaper than a patch). */
  extendOnly?: boolean;
}

const stateDir = () => process.env.PERPETUA_STATE_DIR ?? ".perpetua";

/**
 * Write-behind worker. Records are queued and flushed with executeBatch every 30-60s, never on a caller's
 * request path (each write waits for a block, ~2s on testnet). Keeps a uid -> entityKey map so a retry or a
 * second write of the same uid becomes a patch (+ expiry extension), not a duplicate. Gas spent here is
 * part of the agent's burn.
 *
 * With no ARKIV_PRIVATE_KEY (offline demo) records go to .perpetua/arkiv-outbox.jsonl instead.
 */
export class ArkivWriter {
  private queue = new Map<string, WriteOp>();
  private keys: Record<string, Hex> = {};
  private timer?: NodeJS.Timeout;
  private readonly keyFile: string;
  private readonly outbox: string;
  readonly dryRun: boolean;
  private flushing = false;

  constructor(
    private readonly name: string,
    private readonly opts: { intervalMs?: number; maxOpsPerBatch?: number; privateKey?: Hex } = {},
  ) {
    this.keyFile = `${stateDir()}/arkiv-keys-${name}.json`;
    this.outbox = `${stateDir()}/arkiv-outbox.jsonl`;
    this.dryRun = !(opts.privateKey ?? process.env.ARKIV_PRIVATE_KEY);
    mkdirSync(dirname(this.keyFile), { recursive: true });
    if (existsSync(this.keyFile)) this.keys = JSON.parse(readFileSync(this.keyFile, "utf8"));
  }

  enqueue(op: WriteOp) {
    // Coalesce: the latest values for a uid win (e.g. an agent heartbeat written every minute).
    this.queue.set(`${op.schema.name}:${op.uid}`, op);
  }

  knownKey(schemaName: string, uid: string): Hex | undefined {
    return this.keys[`${schemaName}:${uid}`];
  }

  /** Seed the uid -> key map from an Arkiv query (e.g. on a fresh CI runner). */
  seedKey(schemaName: string, uid: string, key: Hex) {
    this.keys[`${schemaName}:${uid}`] = key;
  }

  start() {
    const ms = this.opts.intervalMs ?? 45_000;
    this.timer = setInterval(() => void this.flush().catch((e) => console.error("[arkiv] flush failed", e)), ms);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  get pending() {
    return this.queue.size;
  }

  async flush(): Promise<{ txHash?: Hex; created: number; patched: number }> {
    if (this.flushing || this.queue.size === 0) return { created: 0, patched: 0 };
    this.flushing = true;
    try {
      const batch = [...this.queue.entries()].slice(0, this.opts.maxOpsPerBatch ?? 40);
      if (this.dryRun) {
        for (const [k, op] of batch) {
          appendFileSync(this.outbox, JSON.stringify({ at: Date.now(), schema: op.schema.name, uid: op.uid, values: op.values }, bigintSafe) + "\n");
          this.queue.delete(k);
        }
        return { created: batch.length, patched: 0 };
      }
      const { client } = arkivWallet(this.opts.privateKey);
      const creates: any[] = [];
      const createIds: string[] = [];
      const patches: any[] = [];
      const extensions: any[] = [];
      for (const [k, op] of batch) {
        const existing = this.keys[k];
        if (existing && op.extendOnly) {
          extensions.push({ entityKey: existing, expiration: ExpirationTime.fromDays(op.expiresInDays) });
        } else if (existing) {
          patches.push({ schema: op.schema, entityKey: existing, set: op.values });
          extensions.push({ entityKey: existing, expiration: ExpirationTime.fromDays(op.expiresInDays) });
        } else {
          creates.push({ schema: op.schema, values: op.values, expiration: ExpirationTime.fromDays(op.expiresInDays) });
          createIds.push(k);
        }
      }
      const res = await (client as any).executeBatch({ creates, patches, extensions });
      res.createdEntities.forEach((key: Hex, i: number) => (this.keys[createIds[i]] = key));
      writeFileSync(this.keyFile, JSON.stringify(this.keys, null, 2));
      for (const [k] of batch) this.queue.delete(k);
      console.log(`[arkiv:${this.name}] batch ${res.txHash}: +${creates.length} ~${patches.length}`);
      return { txHash: res.txHash, created: creates.length, patched: patches.length };
    } finally {
      this.flushing = false;
    }
  }
}

export const bigintSafe = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

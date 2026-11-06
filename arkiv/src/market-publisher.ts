import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arkivChain, arkivPublic } from "./client";
import { findMarketEntity, schemaFor, writeHash, writeValues, type MarketWrite } from "./market-store";

export function atomicJson(path: string, data: unknown) { mkdirSync(dirname(path), { recursive: true }); const tmp = `${path}.tmp`; writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 }); renameSync(tmp, path); }
export function safeMarketError(error: unknown) {
  let text = error instanceof Error ? error.message : String(error);
  for (const key of [process.env.ARKIV_ACCESS_KEY, process.env.ARKIV_MARKET_PRIVATE_KEY, process.env.ARKIV_IMPORTER_PRIVATE_KEY].filter(Boolean) as string[]) text = text.split(key).join("[redacted]");
  return text.replace(/https?:\/\/\S+/g, "[endpoint]").split("\n")[0].slice(0, 300);
}
interface State { queue: MarketWrite[]; keys: Record<string, { key: Hex; expiresAtMs: number }>; dropped: number; inFlight?: { hash: Hex; items: MarketWrite[] }; transactions: { hash: Hex; atMs: number; records: number }[] }
export class MarketPublisher {
  readonly owner;
  private state: State;
  private client: any;
  private busy = false;
  private batchSize = 6;
  private currentBatch: MarketWrite[] = [];
  lastError: string | null = null;
  lastPublishedAtMs: number | null = null;
  private lastBalanceCheck = 0;
  balanceWei: string | null = null;
  constructor(private readonly cfg: { privateKey: Hex; file: string; maxPending: number; retentionDays: number; minimumBalanceWei: bigint }, private readonly deps: { client?: any; pub?: ReturnType<typeof arkivPublic>; find?: typeof findMarketEntity } = {}) {
    const account = privateKeyToAccount(cfg.privateKey); this.owner = account.address;
    this.state = existsSync(cfg.file) ? JSON.parse(readFileSync(cfg.file, "utf8")) : { queue: [], keys: {}, dropped: 0, transactions: [] };
    // Persist a broadcast hash before the SDK waits for its receipt, allowing restart reconciliation.
    const tracedTransport: any = (config: any) => {
      const transport = http(undefined, { timeout: 15000, retryCount: 0 })(config);
      return { ...transport, request: async (args: any, options: any) => {
        const result = await transport.request(args, options);
        if (args.method === "eth_sendRawTransaction") { this.state.inFlight = { hash: result as Hex, items: this.currentBatch }; this.save(); }
        return result;
      } };
    };
    this.client = deps.client ?? createWalletClient({ chain: arkivChain(), account, transport: tracedTransport });
    this.lastPublishedAtMs = this.state.transactions.at(-1)?.atMs ?? null;
  }
  private save() { atomicJson(this.cfg.file, this.state); }
  get pending() { return this.state.queue.length; }
  get dropped() { return this.state.dropped; }
  get recentTransactions() { return this.state.transactions.slice(-10); }
  enqueue(items: MarketWrite[]) {
    for (const item of items) {
      const index = this.state.queue.findIndex((r) => r.uid === item.uid);
      if (index >= 0) this.state.queue[index] = item; else this.state.queue.push(item);
    }
    while (this.state.queue.length > this.cfg.maxPending) {
      const index = this.state.queue.findIndex((item) => item.kind === "snapshot" && !this.state.inFlight?.items.some((r) => r.uid === item.uid));
      if (index < 0) throw new Error("Market queue is full; no history sample can be evicted safely");
      this.state.queue.splice(index, 1); this.state.dropped++;
    }
    this.save();
  }
  private acknowledge(items: MarketWrite[], hash: Hex) {
    for (const item of items) {
      const index = this.state.queue.findIndex((q) => q.uid === item.uid && writeHash(q) === writeHash(item));
      if (index >= 0) this.state.queue.splice(index, 1);
      // Immutable history is recovered by natural UID on demand; do not grow a multi-day key cache.
      if (item.kind === "snapshot") delete this.state.keys[item.uid];
    }
    this.state.transactions.push({ hash, atMs: Date.now(), records: items.length }); this.state.transactions = this.state.transactions.slice(-100);
    this.lastPublishedAtMs = Date.now(); delete this.state.inFlight; this.lastError = null; this.save();
  }
  private async reconcile() {
    const sent = this.state.inFlight; if (!sent) return;
    const receipt = await (this.deps.pub ?? arkivPublic()).waitForTransactionReceipt({ hash: sent.hash, timeout: 15000 });
    if (receipt.status !== "success") { delete this.state.inFlight; this.save(); throw new Error("Market publication reverted; queued data retained"); }
    for (const item of sent.items) {
      const key = await (this.deps.find ?? findMarketEntity)(item, this.owner); if (!key) throw new Error("Publication receipt confirmed; waiting for Arkiv query indexing");
      this.state.keys[item.uid] = { key, expiresAtMs: item.kind === "snapshot" ? Date.now() + this.cfg.retentionDays * 86400000 : Date.now() + 1 };
    }
    this.acknowledge(sent.items, sent.hash);
  }
  private expiryDays(item: MarketWrite) { return item.kind === "snapshot" ? this.cfg.retentionDays : 1; }
  async flush() {
    if (this.busy) return; this.busy = true;
    try {
      await this.reconcile(); if (!this.pending) return;
      if (Date.now() - this.lastBalanceCheck > 60000) { this.balanceWei = (await (this.deps.pub ?? arkivPublic()).getBalance({ address: this.owner })).toString(); this.lastBalanceCheck = Date.now(); }
      if (BigInt(this.balanceWei!) < this.cfg.minimumBalanceWei) throw new Error("Market writer has too little tGLM for publication; ingestion continues with a bounded local queue");
      // Prefer a fresh latest-state view before catching up history after an outage.
      this.state.queue = this.state.queue.filter((r) => r.kind !== "latest" || Date.now() - Math.min(r.data.sourceAtMs, r.data.book.atMs, r.data.openInterestAtMs, r.data.observedAtMs) <= 45000);
      const batch = [...this.state.queue].sort((a, b) => Number(b.kind === "latest") - Number(a.kind === "latest")).slice(0, this.batchSize);
      // JSON-RPC hex-encodes binary payloads: keep headroom below the endpoint's request cap.
      while (batch.length > 1 && batch.reduce((bytes, item) => bytes + writeValues(item).payload.byteLength + 2500, 0) > 32000) batch.pop();
      if (!batch.length) { this.save(); return; }
      const creates: any[] = [], createItems: MarketWrite[] = [], patches: any[] = [], extensions: any[] = [];
      const renewed = new Set<string>();
      for (const item of batch) {
        let known = this.state.keys[item.uid];
        if (known && known.expiresAtMs <= Date.now()) { delete this.state.keys[item.uid]; known = undefined as any; }
        if (!known) {
          const key = await (this.deps.find ?? findMarketEntity)(item, this.owner);
          if (key) known = this.state.keys[item.uid] = { key, expiresAtMs: item.kind === "snapshot" ? Date.now() + this.cfg.retentionDays * 86400000 : Date.now() + 1 };
        }
        if (known && item.kind === "snapshot") continue; // immutable history UID already settled before a restart
        if (known) {
          patches.push({ schema: schemaFor(item), entityKey: known.key, set: writeValues(item) });
          // Renew latest/candle entities periodically, rather than paying to extend expiry every patch.
          if (known.expiresAtMs - Date.now() < 12 * 3600000) { extensions.push({ entityKey: known.key, expiration: ExpirationTime.fromDays(this.expiryDays(item)) }); renewed.add(item.uid); }
        } else { creates.push({ schema: schemaFor(item), values: writeValues(item), expiration: ExpirationTime.fromDays(this.expiryDays(item)) }); createItems.push(item); }
      }
      if (!creates.length && !patches.length) { for (const item of batch) { this.state.queue = this.state.queue.filter((r) => r.uid !== item.uid); if (item.kind === "snapshot") delete this.state.keys[item.uid]; } this.save(); return; }
      this.currentBatch = batch;
      const result = await this.client.executeBatch({ creates, patches, extensions });
      result.createdEntities.forEach((key: Hex, index: number) => { const item = createItems[index]; this.state.keys[item.uid] = { key, expiresAtMs: Date.now() + this.expiryDays(item) * 86400000 }; });
      for (const uid of renewed) this.state.keys[uid].expiresAtMs = Date.now() + 86400000;
      for (const uid of Object.keys(this.state.keys)) if (this.state.keys[uid].expiresAtMs <= Date.now()) delete this.state.keys[uid];
      this.acknowledge(batch, result.txHash);
      console.log(`[market] published ${batch.length} records: ${result.txHash}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/413|too large|payload.*size/i.test(message)) this.batchSize = 1;
      this.lastError = safeMarketError(error); throw new Error(this.lastError);
    } finally { this.busy = false; }
  }
}

/**
 * Public track-record bundles on Swarm, pointed to from Arkiv.
 *
 * Every SWARM_BUNDLE_INTERVAL_MS (default 30 min) each agent with records gets a public JSON bundle uploaded to
 * Swarm UNENCRYPTED (its public Arkiv attributes: decisions, signals, trades, outcomes), and one stable Arkiv
 * entity (perpetua.swarm-bundle.v1, uid "<agentId>:track-record") is patched with the new 64-hex reference.
 * Anyone can open it on a public gateway; the paid bodies stay encrypted (see agent/src/records.ts).
 */
import { agentRecords, ArkivWriter, EXPIRY_DAYS, gatewayLink, jsonBytes, swarmBatch, swarmBee, swarmEnabled, SwarmBundle, swarmUploadJson, u64 } from "@perpetua/arkiv";
import type { Hex } from "viem";
import type { Platform } from "./platform";
import { recordsWriter } from "./data-market";

const BUNDLE_SCHEMA = "perpetua.swarm-bundle.v1";
const column = (v: any) => v?.value ?? v;
const strip = (r: any) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith("$") && k !== "payload").map(([k, v]) => [k, typeof column(v) === "bigint" ? column(v).toString() : column(v)]));

export interface BundleRecord { agentId: string; reference: string; link: string; entityKey: Hex | null; records: number; at: number }

export class SwarmBundles {
  private readonly writer = new ArkivWriter("swarm-bundles", { privateKey: process.env.ARKIV_PRIVATE_KEY as Hex | undefined });
  private latest = new Map<string, BundleRecord>();
  private busy = false;
  constructor(private readonly platform: Platform) {}

  get(agentId: string) {
    const b = this.latest.get(agentId);
    const entityKey = this.writer.knownKey(BUNDLE_SCHEMA, `${agentId}:track-record`) ?? null;
    return b ? { ...b, entityKey } : entityKey ? { agentId, entityKey } : null;
  }

  /** Build and upload one agent's public bundle, then point its Arkiv entity at it. */
  async publish(agentId: string): Promise<BundleRecord | null> {
    const writer = recordsWriter();
    if (!swarmEnabled() || !writer) return null;
    const agent = this.platform.agent(agentId);
    const [decisions, signals, trades] = await Promise.all((["decisions", "signals", "trades"] as const).map((k) => agentRecords(k, agentId, writer, 100)));
    const records = decisions.length + signals.length + trades.length;
    if (!records) return null;
    const closed = signals.filter((s) => column(s.status) === "closed");
    const bundle = {
      schema: "perpetua.track-record.v1", agentId, name: agent.name, generatedAt: new Date().toISOString(), arkivWriter: writer,
      note: "Public attributes only. Levels, sizes and reasoning are encrypted on Swarm and sold per query.",
      trackRecord: { closedSignals: closed.length, wins: closed.filter((s) => column(s.outcome) === "win").length },
      decisions: decisions.map(strip), signals: signals.map(strip), trades: trades.map(strip),
    };
    const up = await swarmUploadJson(bundle, { encrypt: false, name: `${agentId}-track-record.json` });
    this.writer.enqueue({
      uid: `${agentId}:track-record`, schema: SwarmBundle, expiresInDays: EXPIRY_DAYS.agent,
      values: { uid: `${agentId}:track-record`, agent_id: agentId, kind: "track-record", swarm_reference: up.reference, records: u64(records), created_at: u64(Math.floor(Date.now() / 1000)), payload: jsonBytes({ gateway: gatewayLink(up.reference), bee: swarmBee(), batch: swarmBatch() }) },
    });
    await this.writer.flush();
    const rec: BundleRecord = { agentId, reference: up.reference, link: gatewayLink(up.reference), entityKey: this.writer.knownKey(BUNDLE_SCHEMA, `${agentId}:track-record`) ?? null, records, at: Date.now() };
    this.latest.set(agentId, rec);
    console.log(`[swarm] ${agent.name}: track record (${records} records) -> ${up.reference} (Arkiv ${rec.entityKey})`);
    return rec;
  }

  async publishAll() {
    if (this.busy || !swarmEnabled()) return;
    this.busy = true;
    try { for (const a of this.platform.agents()) await this.publish(a.id).catch((e) => console.warn(`[swarm] ${a.id}: ${(e as Error).message.slice(0, 140)}`)); }
    finally { this.busy = false; }
  }

  start(intervalMs = Number(process.env.SWARM_BUNDLE_INTERVAL_MS ?? 30 * 60_000)) {
    if (!swarmEnabled()) { console.warn("[swarm] SWARM_POSTAGE_BATCH_ID not set: Swarm storage disabled (payloads stay sealed on Arkiv)"); return; }
    void this.publishAll();
    setInterval(() => void this.publishAll(), intervalMs).unref();
  }
}

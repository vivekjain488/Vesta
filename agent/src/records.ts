/**
 * Arkiv record builders. The agent writes every entity from its OWN wallet, so ownedBy(agent) proves who
 * wrote it. Signals are commit-reveal: direction/prices are hidden behind commit_hash until reveal (after
 * 15 minutes or once filled), so a confidence score can never be revised after the outcome is known.
 */
import { AgentEntity, DecisionLog, EXPIRY_DAYS, LedgerEntity, MandateEntity, SignalEntity, TradeEntity, addr, bool, dec, i32, jsonBytes, key, seal, str128, u64, type ArkivWriter } from "@perpetua/arkiv";
import type { MandateView, Signal } from "@perpetua/core";
import { keccak256, toBytes, type Address, type Hex } from "viem";

const now = () => Math.floor(Date.now() / 1000);
const usd = (v: bigint) => (Number(v) / 1e6).toFixed(6);

export class Records {
  constructor(
    private readonly w: ArkivWriter,
    private readonly agent: Address,
    /** platform agent ID, indexed so the paid data API can query one agent's records */
    private readonly agentId?: string,
  ) {}
  private get id() { return this.agentId ? { agent_id: this.agentId } : {}; }

  /** The paid body of a record, sealed (AES-256-GCM) so only the paid data API can read it. */
  private later(uid: string, value: unknown, enqueue: (b: { payload: Uint8Array }) => void) {
    enqueue({ payload: seal(uid, value) });
  }

  heartbeat(a: { name: string; strategy: string; status: "alive" | "retired"; tier: string; riskTier: string; runwayH: number; mandate: MandateView; followers: number; winRate: number; brier: number; createdAt: number; meta: Record<string, unknown> }) {
    this.w.enqueue({
      uid: this.agent,
      schema: AgentEntity,
      expiresInDays: a.status === "retired" ? EXPIRY_DAYS.deathCertificate : EXPIRY_DAYS.agent,
      values: {
        agent: addr(this.agent),
        name: a.name,
        strategy: str128(a.strategy),
        status: a.status,
        tier: a.tier,
        risk_tier: a.riskTier,
        runway_h: dec(Number.isNaN(a.runwayH) ? "-1" : Number.isFinite(a.runwayH) ? a.runwayH.toFixed(2) : "99999"), // -1 means unknown Router runway
        cushion: dec(usd(a.mandate.C)),
        floor: dec(usd(a.mandate.F)),
        exposure: dec(usd(a.mandate.E)),
        followers: i32(a.followers),
        win_rate: dec(a.winRate.toFixed(4)),
        brier: dec(a.brier.toFixed(4)),
        last_heartbeat: u64(now()),
        created_at: u64(a.createdAt),
        payload: jsonBytes(a.meta),
      },
    });
  }

  /** Commit: only the hash of the hidden fields is public. */
  commitSignal(uid: string, s: Signal, chainId: number, hidden: Record<string, unknown>): { commitHash: Hex; salt: Hex } {
    const salt = keccak256(toBytes(`${uid}:${Math.random()}:${Date.now()}`));
    const commitHash = keccak256(toBytes(JSON.stringify({ ...hidden, salt })));
    this.w.enqueue({
      uid,
      schema: SignalEntity,
      expiresInDays: EXPIRY_DAYS.signal,
      values: { uid, agent: addr(this.agent), asset: s.asset, chain_id: u64(chainId), created_at: u64(now()), commit_hash: commitHash, status: "committed", ...this.id },
    });
    return { commitHash, salt };
  }

  revealSignal(uid: string, s: Signal, chainId: number, commitHash: Hex, createdAt: number, hidden: Record<string, unknown>, salt: Hex) {
    this.later(uid, { ...hidden, salt }, (b) => this.w.enqueue({
      uid,
      schema: SignalEntity,
      expiresInDays: EXPIRY_DAYS.signal,
      values: {
        uid,
        agent: addr(this.agent),
        asset: s.asset,
        chain_id: u64(chainId),
        created_at: u64(createdAt),
        commit_hash: commitHash,
        status: "revealed",
        direction: s.direction,
        confidence: dec(s.confidence.toFixed(4)),
        regime: s.regime,
        revealed_at: u64(now()),
        ...this.id,
        ...b,
      },
    }));
  }

  closeSignal(uid: string, base: { asset: string; chainId: number; commitHash: Hex; createdAt: number; direction: string; confidence: number; regime: string; hidden: Record<string, unknown>; salt: Hex }, outcome: "win" | "loss" | "scratch", r: number) {
    this.later(uid, { ...base.hidden, salt: base.salt }, (b) => this.w.enqueue({
      uid,
      schema: SignalEntity,
      expiresInDays: EXPIRY_DAYS.signal,
      values: {
        uid,
        agent: addr(this.agent),
        asset: base.asset,
        chain_id: u64(base.chainId),
        created_at: u64(base.createdAt),
        commit_hash: base.commitHash,
        status: "closed",
        direction: base.direction,
        confidence: dec(base.confidence.toFixed(4)),
        regime: base.regime,
        outcome,
        r_multiple: dec(r.toFixed(4)),
        ...this.id,
        ...b,
      },
    }));
  }

  trade(t: { uid: string; asset: string; side: string; status: "open" | "closed" | "cancelled"; flashOrderId: string; openedAt: number; pnlUsd?: number; signalKey?: Hex; mandateKey?: Hex; meta: Record<string, unknown> }) {
    this.later(t.uid, t.meta, (b) => this.w.enqueue({
      uid: t.uid,
      schema: TradeEntity,
      expiresInDays: EXPIRY_DAYS.trade,
      values: {
        uid: t.uid,
        agent: addr(this.agent),
        asset: t.asset,
        side: t.side,
        status: t.status,
        flash_order_id: t.flashOrderId,
        ...(t.signalKey ? { signal: key(t.signalKey) } : {}),
        ...(t.mandateKey ? { mandate: key(t.mandateKey) } : {}),
        opened_at: u64(t.openedAt),
        created_at: u64(now()),
        ...(t.pnlUsd !== undefined ? { pnl_usd: dec(t.pnlUsd.toFixed(6)) } : {}),
        ...this.id,
        ...b,
      },
    }));
  }

  mandate(riskGate: Address, m: MandateView, txHash?: Hex) {
    this.w.enqueue({
      uid: `${riskGate}:${m.epoch}`,
      schema: MandateEntity,
      expiresInDays: EXPIRY_DAYS.mandate,
      values: {
        agent: addr(this.agent),
        mandate_id: `${riskGate}:${m.epoch}`,
        created_at: u64(Number(m.computedAt)),
        expires_at: u64(Number(m.validUntil)),
        payload: jsonBytes({ floor: usd(m.F), cushion: usd(m.C), E: usd(m.E), V: usd(m.V), riskyValue: usd(m.riskyValue), pokeTx: txHash }),
      },
    });
  }

  ledger(engine: string, hour: number, amountUsd: number, meta: Record<string, unknown>) {
    this.w.enqueue({
      uid: `${engine}:${hour}`,
      schema: LedgerEntity,
      expiresInDays: EXPIRY_DAYS.ledger,
      values: { agent: addr(this.agent), engine, hour: u64(hour), amount_usd: dec(amountUsd.toFixed(6)), created_at: u64(now()), payload: jsonBytes(meta) },
    });
  }

  decision(d: { uid: string; decision: string; model: string; tier: string; input: string; output: string; chatId: string; teeVerified: boolean; costOg: number; meta: Record<string, unknown> }) {
    this.later(d.uid, d.meta, (b) => this.w.enqueue({
      uid: d.uid,
      schema: DecisionLog,
      expiresInDays: EXPIRY_DAYS.decision,
      values: {
        uid: d.uid,
        agent: addr(this.agent),
        decision: d.decision,
        model: str128(d.model),
        tier: d.tier,
        input_hash: keccak256(toBytes(d.input)),
        output_hash: keccak256(toBytes(d.output)),
        chat_id: str128(d.chatId),
        tee_verified: bool(d.teeVerified),
        credit_cost_og: dec(d.costOg.toFixed(8)),
        created_at: u64(now()),
        ...this.id,
        ...b,
      },
    }));
  }
}

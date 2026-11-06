import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson, configHash, normalizedAgentName, ownerAddress, validateStrategyConfig } from "@perpetua/core";
import type { Action, AuditEvent, Decision, ExecutionResult, Memory, PortfolioBinding, PortfolioState, RunRecord, RuntimeAgent } from "./types";

const json = (v: unknown) => JSON.stringify(v);
const decode = <T>(row: any): T | undefined => row ? JSON.parse(row.body) as T : undefined;
const amount = (v: string) => { if (!/^\d{1,30}$/.test(v)) throw new Error("Invalid amount in stable micros"); return BigInt(v); };

/** Shared-host durable coordination. Transactions never span a network request. */
export class RuntimeStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS portfolios(id TEXT PRIMARY KEY, owner TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, owner TEXT NOT NULL, name_key TEXT NOT NULL, portfolio_id TEXT NOT NULL REFERENCES portfolios(id), body TEXT NOT NULL, UNIQUE(owner,name_key));
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, slot INTEGER NOT NULL, status TEXT NOT NULL, lease_until INTEGER NOT NULL, fence INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE(agent_id,slot));
      CREATE TABLE IF NOT EXISTS memory(agent_id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, run_id TEXT NOT NULL, sequence INTEGER NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0, entity_key TEXT, UNIQUE(run_id,sequence));
      CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY, portfolio_id TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS budgets(scope TEXT NOT NULL, day INTEGER NOT NULL, tokens INTEGER NOT NULL, PRIMARY KEY(scope,day));
      CREATE TABLE IF NOT EXISTS locks(id TEXT PRIMARY KEY, holder TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS publications(event_id TEXT PRIMARY KEY, tx_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedules(agent_id TEXT PRIMARY KEY, last_audited_slot INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS events_pending ON events(published);
      CREATE INDEX IF NOT EXISTS runs_agent ON runs(agent_id,slot);
    `);
  }
  close() { this.db.close(); }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  portfolio(id: string) { return decode<PortfolioBinding>(this.db.prepare("SELECT body FROM portfolios WHERE id=?").get(id)); }
  portfolios(owner: string) { return this.db.prepare("SELECT body FROM portfolios WHERE owner=?").all(owner.toLowerCase()).map((r) => decode<PortfolioBinding>(r)!); }
  bindPortfolio(input: PortfolioBinding) {
    const p = { ...input, owner: ownerAddress(input.owner).toLowerCase() };
    if (!p.id || !Number.isSafeInteger(p.chainId) || p.chainId < 1) throw new Error("Invalid portfolio binding");
    for (const value of [p.vault, p.wallet, p.riskGate, p.stable]) ownerAddress(value);
    return this.transaction(() => {
      const old = this.portfolio(p.id);
      if (old && canonicalJson(old) !== canonicalJson(p)) throw new Error("Portfolio binding is immutable");
      this.db.prepare("INSERT OR IGNORE INTO portfolios VALUES(?,?,?)").run(p.id, p.owner, json(p)); return p;
    });
  }
  agent(id: string) { return decode<RuntimeAgent>(this.db.prepare("SELECT body FROM agents WHERE id=?").get(id)); }
  agents(owner?: string) { return this.db.prepare(owner ? "SELECT body FROM agents WHERE owner=?" : "SELECT body FROM agents").all(...(owner ? [owner.toLowerCase()] : [])).map((r) => decode<RuntimeAgent>(r)!); }
  activate(a: RuntimeAgent, now = Date.now()) {
    validateStrategyConfig(a.config);
    if (configHash(a.config) !== a.configHash || !a.id || !Number.isSafeInteger(a.revision) || a.revision < 1 || !["analysis", "execute"].includes(a.mode) || a.instructions.length > 4000) throw new Error("Invalid runtime configuration");
    const next = structuredClone({ ...a, owner: ownerAddress(a.owner).toLowerCase(), status: "active" as const });
    return this.transaction(() => {
      const p = this.portfolio(a.portfolioId); const old = this.agent(a.id);
      if (!p || p.owner !== next.owner || old && old.owner !== next.owner) throw new Error("Portfolio/agent belongs to another wallet");
      if (old && a.revision < old.revision) throw new Error("Stale configuration revision");
      if (old && a.revision === old.revision && canonicalJson({ ...old, status: "active", generation: 0 }) !== canonicalJson({ ...next, generation: 0 })) throw new Error("Configuration changes require a new revision");
      next.generation = (old?.generation ?? 0) + 1;
      this.db.prepare("INSERT INTO agents VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name_key=excluded.name_key,portfolio_id=excluded.portfolio_id,body=excluded.body").run(a.id, next.owner, normalizedAgentName(a.name), a.portfolioId, json(next));
      this.db.prepare("INSERT INTO schedules VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET last_audited_slot=excluded.last_audited_slot").run(a.id, Math.floor(now / 60000) - 1);
      this.event(next, `activation:${a.id}:${now}`, "agent_activated", { definition: next }, now); return next;
    });
  }
  pause(id: string, owner: string, now = Date.now()) {
    return this.transaction(() => {
      const a = this.agent(id); if (!a || a.owner !== owner.toLowerCase()) throw new Error("Agent belongs to another wallet");
      a.status = "paused"; this.db.prepare("UPDATE agents SET body=? WHERE id=?").run(json(a), id);
      this.event(a, `pause:${id}:${now}`, "agent_paused", {}, now); return a;
    });
  }
  claim(a: RuntimeAgent, slot: number, now: number, deadline: number): RunRecord | undefined {
    return this.transaction(() => {
      const current = this.agent(a.id);
      if (current?.status !== "active" || canonicalJson(current) !== canonicalJson(a)) return;
      // Recover expired analyses without allowing a stale worker to finish them.
      for (const row of this.db.prepare("SELECT body FROM runs WHERE agent_id=? AND status='running' AND lease_until<=?").all(a.id, now)) {
        const expired = decode<RunRecord>(row)!;
        this.finishInside(expired.snapshot ?? a, expired, "timed_out", undefined, "run_deadline_exceeded", now);
      }
      if (this.db.prepare("SELECT 1 FROM runs WHERE agent_id=? AND status='running'").get(a.id)) return;
      const id = `${a.id}:${slot}`;
      const r: RunRecord = { id, agentId: a.id, slot, revision: a.revision, fence: slot + 1, leaseUntil: deadline, status: "running", startedAtMs: now, snapshot: a };
      const inserted = this.db.prepare("INSERT OR IGNORE INTO runs VALUES(?,?,?,?,?,?,?)").run(id, a.id, slot, r.status, deadline, r.fence, json(r));
      if (!inserted.changes) return;
      this.event(a, id, "run_started", { slot, configHash: a.configHash, instructionsHash: configHash(a.instructions) }, now); return r;
    });
  }
  assertRun(a: RuntimeAgent, r: RunRecord, now = Date.now()) {
    const current = this.agent(a.id), run = this.run(r.id);
    if (!current || current.status !== "active" || canonicalJson(current) !== canonicalJson(a) || !run || run.status !== "running" || run.fence !== r.fence || run.leaseUntil <= now) throw new Error("Run revoked, expired or superseded");
  }
  auditSchedule(a: RuntimeAgent, slot: number, now: number) {
    return this.transaction(() => {
      const previous = Number((this.db.prepare("SELECT last_audited_slot FROM schedules WHERE agent_id=?").get(a.id) as any)?.last_audited_slot ?? slot - 1);
      if (slot - 1 <= previous) return;
      const recorded = Number((this.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE agent_id=? AND slot>? AND slot<?").get(a.id, previous, slot) as any).n);
      if (slot - previous - 1 > recorded) this.event(a, `schedule:${a.id}:${slot}`, "schedule_gap", { fromSlot: previous + 1, throughSlot: slot - 1, missingRuns: slot - previous - 1 - recorded, reason: "worker_unavailable_or_capacity_exhausted", replay: false }, now);
      this.db.prepare("INSERT INTO schedules VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET last_audited_slot=excluded.last_audited_slot").run(a.id, slot - 1);
    });
  }
  skip(a: RuntimeAgent, slot: number, now: number, reason: string) {
    return this.transaction(() => {
      const id = `${a.id}:${slot}`; if (this.run(id)) return;
      const r: RunRecord = { id, agentId: a.id, slot, revision: a.revision, fence: slot + 1, leaseUntil: now, status: "skipped", startedAtMs: now, snapshot: a };
      this.db.prepare("INSERT INTO runs VALUES(?,?,?,?,?,?,?)").run(id, a.id, slot, "skipped", now, r.fence, json(r));
      this.finishInside(a, r, "skipped", undefined, reason, now, false);
    });
  }
  run(id: string) { return decode<RunRecord>(this.db.prepare("SELECT body FROM runs WHERE id=?").get(id)); }
  runs(agentId: string, limit = 50) { return this.db.prepare("SELECT body FROM runs WHERE agent_id=? ORDER BY slot DESC LIMIT ?").all(agentId, Math.max(1, Math.min(limit, 100))).map((r) => decode<RunRecord>(r)!); }
  memory(agentId: string): Memory { return decode<Memory>(this.db.prepare("SELECT body FROM memory WHERE agent_id=?").get(agentId)) ?? { version: 0, summary: "", updatedAtMs: 0, sourceEvents: [] }; }
  recordPaperOutcome(a: RuntimeAgent, runId: string, outcome: {decision: string; outcome: string; reason: string; cash: number; btc: number}, now = Date.now()) {
    return this.transaction(() => {
      const run = this.run(runId), current = this.agent(a.id), previous = this.memory(a.id);
      if (!run || run.agentId !== a.id || !current || current.owner !== a.owner || previous.lastRunId !== runId) throw new Error("Paper outcome does not match the latest agent run");
      const event = this.event(a, runId, "paper_settlement", outcome, now);
      const memory: Memory = { ...previous, version: previous.version + 1, updatedAtMs: now, sourceEvents: [event.id], summary: `Paper decision ${outcome.decision}: ${outcome.outcome} (${outcome.reason}). Confirmed paper cash $${outcome.cash.toFixed(2)} and BTC ${outcome.btc.toFixed(8)}. This is virtual money.` };
      this.event(a, runId, "memory_checkpoint", memory, now);
      this.db.prepare("INSERT INTO memory VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET body=excluded.body").run(a.id, json(memory));
    });
  }
  event(a: RuntimeAgent, runId: string, kind: string, payload: unknown, now = Date.now()): AuditEvent {
    const sequence = Number((this.db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS n FROM events WHERE run_id=?").get(runId) as any).n);
    const e: AuditEvent = { id: `${runId}:${sequence}`, owner: a.owner, agentId: a.id, portfolioId: a.portfolioId, runId, revision: a.revision, sequence, kind, atMs: now, payload };
    if (Buffer.byteLength(json(e), "utf8") > 90000) throw new Error("Audit observation exceeds the bounded event size");
    this.db.prepare("INSERT INTO events(id,agent_id,run_id,sequence,kind,body) VALUES(?,?,?,?,?,?)").run(e.id, a.id, runId, sequence, kind, json(e)); return e;
  }
  append(a: RuntimeAgent, r: RunRecord, kind: string, payload: unknown, now = Date.now()) { return this.transaction(() => { this.assertRun(a, r, now); return this.event(a, r.id, kind, payload, now); }); }
  finish(a: RuntimeAgent, r: RunRecord, status: string, decision?: Decision, error?: string, now = Date.now()) {
    return this.transaction(() => { this.assertRun(a, r, now); this.finishInside(a, r, status, decision, error, now); });
  }
  fail(a: RuntimeAgent, r: RunRecord, error: string, now = Date.now()) {
    return this.transaction(() => {
      const run = this.run(r.id); if (!run || run.status !== "running" || run.fence !== r.fence) return;
      const current = this.agent(a.id);
      this.finishInside(a, r, now >= r.leaseUntil ? "timed_out" : "error", undefined, error, now, current?.generation === a.generation && current?.status === "active");
    });
  }
  private finishInside(a: RuntimeAgent, r: RunRecord, status: string, decision: Decision | undefined, error: string | undefined, now: number, updateMemory = true) {
    const outcome = decision ?? { decision: "hold" as const, rationaleSummary: error ?? status, evidenceRefs: [], memorySummary: this.memory(a.id).summary };
    const event = this.event(a, r.id, "decision", { ...outcome, status, source: decision ? "model" : "runtime", error }, now);
    const previous = this.memory(a.id);
    const m: Memory = { version: previous.version + 1, summary: outcome.memorySummary, lastDecision: outcome, lastRunId: r.id, updatedAtMs: now, sourceEvents: [event.id] };
    if (updateMemory) {
      this.event(a, r.id, "memory_checkpoint", m, now);
      this.db.prepare("INSERT INTO memory VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET body=excluded.body").run(a.id, json(m));
    }
    const done = { ...r, status, finishedAtMs: now, decision: outcome, error };
    this.db.prepare("UPDATE runs SET status=?,body=? WHERE id=?").run(status, json(done), r.id);
  }
  events(agentId: string, limit = 100): AuditEvent[] { return this.db.prepare("SELECT body FROM events WHERE agent_id=? ORDER BY rowid DESC LIMIT ?").all(agentId, Math.max(1, Math.min(limit, 100))).map((r) => decode<AuditEvent>(r)!); }
  pending(limit = 10): AuditEvent[] { return this.db.prepare("SELECT body FROM events WHERE published=0 ORDER BY rowid LIMIT ?").all(limit).map((r) => decode<AuditEvent>(r)!); }
  published(id: string) { return !!(this.db.prepare("SELECT published FROM events WHERE id=?").get(id) as any)?.published; }
  publication(id: string) { return (this.db.prepare("SELECT tx_hash FROM publications WHERE event_id=?").get(id) as any)?.tx_hash as string | undefined; }
  submittedPublication(id: string, hash: string) { this.db.prepare("INSERT OR REPLACE INTO publications VALUES(?,?)").run(id, hash); }
  acknowledge(id: string, key: string) { this.db.prepare("UPDATE events SET published=1,entity_key=? WHERE id=?").run(key, id); }
  publicationStatus(agentId: string) { return this.db.prepare("SELECT COUNT(*) AS total,COALESCE(SUM(published),0) AS confirmed FROM events WHERE agent_id=?").get(agentId); }
  action(id: string) { return decode<Action>(this.db.prepare("SELECT body FROM actions WHERE id=?").get(id)); }
  intentPublished(runId: string) {
    const rows = this.db.prepare("SELECT published FROM events WHERE run_id=? AND kind IN ('model_decision','action_reserved')").all(runId) as { published: number }[];
    return rows.length === 2 && rows.every((r) => r.published === 1);
  }
  reserveTokens(a: RuntimeAgent, tokens: number, agentLimit: number, walletLimit: number, platformLimit: number, now: number) {
    if (!Number.isSafeInteger(tokens) || tokens < 1) throw new Error("Invalid token reservation");
    return this.transaction(() => {
      const day = Math.floor(now / 86400000), scopes = [[`agent:${a.id}`, agentLimit], [`wallet:${a.owner}`, walletLimit], ["platform", platformLimit]] as const;
      for (const [scope, limit] of scopes) { const used = Number((this.db.prepare("SELECT tokens FROM budgets WHERE scope=? AND day=?").get(scope, day) as any)?.tokens ?? 0); if (used + tokens > limit) return false; }
      for (const [scope] of scopes) this.db.prepare("INSERT INTO budgets VALUES(?,?,?) ON CONFLICT(scope,day) DO UPDATE SET tokens=tokens+excluded.tokens").run(scope, day, tokens);
      return true;
    });
  }
  actions(portfolioId?: string): Action[] { return this.db.prepare(portfolioId ? "SELECT body FROM actions WHERE portfolio_id=?" : "SELECT body FROM actions").all(...(portfolioId ? [portfolioId] : [])).map((r) => decode<Action>(r)!); }
  reserve(a: RuntimeAgent, r: RunRecord, d: Decision, p: PortfolioState, now: number): Action {
    return this.transaction(() => {
      this.assertRun(a, r, now);
      if (p.owner.toLowerCase() !== a.owner || p.portfolioId !== a.portfolioId || p.sourceAtMs > now || now - p.sourceAtMs > 10000) throw new Error("Portfolio observation is stale or incorrectly scoped");
      const proposed = amount(d.notionalMicros ?? ""); if (!proposed) throw new Error("Empty action");
      // Buys reserve cash/exposure. Sells reserve an exclusive instrument exit lane;
      // the trusted validator must additionally prove ownership/quantity of the agent's lots.
      const value = d.decision === "buy" ? proposed : 0n;
      const pending = this.actions(a.portfolioId).filter((x) => ["reserved", "submitting", "submitted", "unknown"].includes(x.state));
      if (pending.some((x) => x.decision.symbol === d.symbol && (x.decision.decision !== d.decision || d.decision === "sell"))) throw new Error("instrument_action_conflict");
      const reserved = pending.reduce((sum, x) => sum + amount(x.reservationMicros), 0n);
      if (reserved + value > amount(p.cashMicros) || reserved + value > amount(p.capacityMicros)) throw new Error("wallet_budget_exhausted");
      const own = pending.filter((x) => x.agentId === a.id).reduce((sum, x) => sum + amount(x.reservationMicros), 0n);
      if (own + value > BigInt(Math.floor(a.config.risk.maxNotionalUsd * 1e6))) throw new Error("agent_budget_exhausted");
      const action: Action = { id: `${r.id}:action`, agentId: a.id, portfolioId: a.portfolioId, runId: r.id, revision: a.revision, generation: a.generation, decision: d, state: "reserved", reservationMicros: String(value), createdAtMs: now };
      this.db.prepare("INSERT INTO actions VALUES(?,?,?,?)").run(action.id, action.portfolioId, action.state, json(action));
      this.event(a, r.id, "action_reserved", action, now); return action;
    });
  }
  updateAction(action: Action, result: ExecutionResult | { state: "submitting" }, now = Date.now()) {
    return this.transaction(() => {
      if (!["submitting", "submitted", "unknown", "filled", "cancelled", "rejected"].includes(result.state)) throw new Error("Invalid execution outcome");
      if (this.action(action.id)?.state !== action.state) throw new Error("Action changed during reconciliation");
      if ("transactions" in result && result.transactions?.some((t) => !Number.isSafeInteger(t.chainId) || t.chainId < 1 || !/^0x[0-9a-fA-F]{64}$/.test(t.hash) || typeof t.state !== "string")) throw new Error("Invalid transaction receipt reference");
      const a = { ...this.agent(action.agentId)!, revision: action.revision, portfolioId: action.portfolioId }; const next = { ...action, ...result };
      if (json(this.action(action.id)) === json(next)) return next;
      this.db.prepare("UPDATE actions SET state=?,body=? WHERE id=?").run(next.state, json(next), action.id);
      this.event(a, `execution:${action.id}`, `action_${next.state}`, next, now);
      if ("transactions" in result) for (const tx of result.transactions ?? []) this.event(a, `execution:${action.id}`, "transaction", { actionId: action.id, ...tx }, now);
      return next;
    });
  }
  lock(id: string, holder: string, until: number, now = Date.now()) {
    return this.transaction(() => { this.db.prepare("DELETE FROM locks WHERE id=? AND expires<=?").run(id, now); return !!this.db.prepare("INSERT OR IGNORE INTO locks VALUES(?,?,?)").run(id, holder, until).changes; });
  }
  unlock(id: string, holder: string) { this.db.prepare("DELETE FROM locks WHERE id=? AND holder=?").run(id, holder); }
}

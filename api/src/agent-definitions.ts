import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { verifyMessage, type Hex } from "viem";
import { configAuthMessage, configHash, ownerAddress, validateStrategyConfig, type AgentDefinition } from "@perpetua/core";

export type ConfigAction = "create" | "update" | "compile";
/** Single-process signed configuration service; deployment/runtime keys never enter this store. */
export class AgentDefinitions {
  private readonly challenges = new Map<string, { owner: string; action: ConfigAction; hash: string; message: string; expiresAt: number }>();
  private readonly directory: string;
  constructor(stateDir: string, private readonly audience: string) {
    this.directory = resolve(stateDir, "definitions");
    mkdirSync(this.directory, { recursive: true });
  }
  challenge(ownerInput: unknown, action: ConfigAction, payload: unknown, now = Date.now()) {
    const owner = ownerAddress(ownerInput);
    if (!["create", "update", "compile"].includes(action)) throw new Error("Unknown configuration action");
    for (const [key, value] of this.challenges) if (value.expiresAt < now) this.challenges.delete(key);
    if (this.challenges.size >= 1000) throw new Error("Too many pending signing requests");
    const nonce = randomBytes(24).toString("hex");
    const expiresAt = now + 5 * 60_000;
    const message = configAuthMessage(owner, action, payload, nonce, expiresAt, this.audience);
    this.challenges.set(nonce, { owner, action, hash: configHash(payload), message, expiresAt });
    return { nonce, expiresAt, message };
  }
  async authorize(ownerInput: unknown, action: ConfigAction, payload: unknown, nonce: unknown, signature: unknown, now = Date.now()) {
    const owner = ownerAddress(ownerInput);
    const c = this.challenges.get(String(nonce));
    // Consume before async verification; concurrent replays cannot both succeed.
    this.challenges.delete(String(nonce));
    if (!c || c.expiresAt < now || c.owner !== owner || c.action !== action || c.hash !== configHash(payload) || typeof signature !== "string") throw new Error("Invalid, expired or already used configuration authorization");
    if (!await verifyMessage({ address: owner, message: c.message, signature: signature as Hex })) throw new Error("Owner signature does not match");
    return owner;
  }
  list(ownerInput: unknown) {
    const owner = ownerAddress(ownerInput);
    return readdirSync(this.directory).filter((f) => /^[a-f0-9-]{36}\.json$/.test(f)).map((f) => JSON.parse(readFileSync(resolve(this.directory, f), "utf8")) as AgentDefinition).filter((a) => a.owner === owner);
  }
  get(id: string): AgentDefinition {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid agent ID");
    const path = resolve(this.directory, `${id}.json`);
    if (!existsSync(path)) throw new Error("Agent definition not found");
    return JSON.parse(readFileSync(path, "utf8"));
  }
  save(ownerInput: unknown, payload: any, id?: string): AgentDefinition {
    const owner = ownerAddress(ownerInput);
    if (!payload || typeof payload.name !== "string" || !/^[\p{L}\p{N} _-]{1,60}$/u.test(payload.name.trim())) throw new Error("Name must contain 1–60 letters, digits, spaces, underscores or hyphens");
    if (payload.status !== "draft" && payload.status !== "paper") throw new Error("Definitions support draft or paper mode only");
    const config = validateStrategyConfig(payload.config);
    const previous = id ? this.get(id) : null;
    if (previous && previous.owner !== owner) throw new Error("This wallet does not own the agent");
    if (previous && payload.revision !== previous.revision) throw new Error("Configuration changed; reload before updating");
    const now = Date.now();
    const record: AgentDefinition = { id: previous?.id ?? randomUUID(), owner, name: payload.name.trim(), revision: (previous?.revision ?? 0) + 1, status: payload.status, config, configHash: configHash(config), createdAt: previous?.createdAt ?? now, updatedAt: now };
    const target = resolve(this.directory, `${record.id}.json`);
    const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temporary, JSON.stringify(record, null, 2), { mode: 0o600 });
    renameSync(temporary, target);
    return record;
  }
}

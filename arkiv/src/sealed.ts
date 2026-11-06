/**
 * Sealed Arkiv payloads: the monetised part of a record. Public attributes (agent, asset, regime, outcome,
 * R-multiple, commit hash) stay readable so anyone can audit the track record for free; the payload (levels, sizes,
 * reasoning, order IDs) is AES-256-GCM encrypted with a per-record key derived from one master key, and is only
 * returned decrypted by the paid data API.
 *
 * Master key: ARKIV_DATA_KEY (32-byte hex). If unset, one is generated once into .perpetua/secrets (0600).
 * Losing it makes every sealed payload unreadable, so back it up with the other secrets.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const MAGIC = "perpetua-sealed-v1";
let cached: Buffer | null = null;

export function dataKey(): Buffer {
  if (cached) return cached;
  const env = process.env.ARKIV_DATA_KEY?.replace(/^0x/, "");
  if (env) {
    if (!/^[0-9a-fA-F]{64}$/.test(env)) throw new Error("ARKIV_DATA_KEY must be 32 bytes of hex");
    return (cached = Buffer.from(env, "hex"));
  }
  const dir = resolve(process.env.PERPETUA_STATE_DIR ?? ".perpetua", "secrets");
  const file = resolve(dir, "arkiv-data-key");
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
    console.warn(`[sealed] generated a new Arkiv data key at ${file}; back it up (sealed payloads are unreadable without it)`);
  }
  return (cached = Buffer.from(readFileSync(file, "utf8").trim(), "hex"));
}

/** Per-record key: HKDF-SHA256(master, salt = record uid). One leaked record key never opens another record. */
const recordKey = (uid: string) => Buffer.from(hkdfSync("sha256", dataKey(), Buffer.from(uid, "utf8"), Buffer.from(MAGIC), 32));

export function seal(uid: string, value: unknown): Uint8Array {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", recordKey(uid), iv);
  cipher.setAAD(Buffer.from(uid, "utf8")); // the ciphertext is bound to its record
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const envelope = { sealed: MAGIC, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
  return new TextEncoder().encode(JSON.stringify(envelope));
}

/** Accepts the raw payload column (hex string or bytes). Plain (unsealed) JSON payloads are returned as-is. */
export function unseal(uid: string, payload: unknown): { sealed: boolean; value: unknown } {
  const text = typeof payload === "string" ? (payload.startsWith("0x") ? Buffer.from(payload.slice(2), "hex").toString("utf8") : payload) : Buffer.from(payload as Uint8Array).toString("utf8");
  const parsed = JSON.parse(text);
  if (parsed?.sealed !== MAGIC) return { sealed: false, value: parsed };
  const decipher = createDecipheriv("aes-256-gcm", recordKey(uid), Buffer.from(parsed.iv, "base64"));
  decipher.setAAD(Buffer.from(uid, "utf8"));
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(parsed.ct, "base64")), decipher.final()]).toString("utf8");
  return { sealed: true, value: JSON.parse(plain) };
}

export const isSealed = (payload: unknown) => { try { return unsealedHeader(payload); } catch { return false; } };
function unsealedHeader(payload: unknown) {
  const text = typeof payload === "string" ? (payload.startsWith("0x") ? Buffer.from(payload.slice(2), "hex").toString("utf8") : payload) : Buffer.from(payload as Uint8Array).toString("utf8");
  return JSON.parse(text)?.sealed === MAGIC;
}

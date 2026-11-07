/**
 * Swarm (ethswarm.org) storage for agent data, through a Bee node's HTTP API.
 *
 *   Encrypted uploads return a 128-hex reference containing the decryption key.
 *   Public uploads return a 64-hex reference that can be opened on a gateway.
 *
 * Env: SWARM_BEE_URL (default http://localhost:1633), SWARM_POSTAGE_BATCH_ID (required to upload),
 *      SWARM_GATEWAY_URL (public reads, default https://api.gateway.ethswarm.org).
 */
export interface SwarmUpload { reference: string; encrypted: boolean; address: string; size: number }

export const swarmBee = () => (process.env.SWARM_BEE_URL ?? "http://localhost:1633").replace(/\/$/, "");
export const swarmGateway = () => (process.env.SWARM_GATEWAY_URL ?? "https://api.gateway.ethswarm.org").replace(/\/$/, "");
export const swarmBatch = () => process.env.SWARM_POSTAGE_BATCH_ID?.replace(/^0x/, "") ?? "";
export const swarmEnabled = () => /^[0-9a-f]{64}$/i.test(swarmBatch());

const REF = /^[0-9a-f]{64}([0-9a-f]{64})?$/i;
/** An encrypted reference is 128 hex: the first half is the chunk address (safe to publish), the second the key. */
export function splitReference(reference: string) {
  if (!REF.test(reference)) throw new Error("Not a Swarm reference");
  return { address: reference.slice(0, 64), key: reference.length === 128 ? reference.slice(64) : null, encrypted: reference.length === 128 };
}
/** Public link for an UNENCRYPTED reference (gateways refuse encrypted references by design). */
export const gatewayLink = (reference: string) => { if (!/^[0-9a-f]{64}$/i.test(reference)) throw new Error("Only unencrypted references have a public gateway link"); return `${swarmGateway()}/bzz/${reference}/`; };

async function bee(path: string, init: RequestInit = {}, send: typeof fetch = fetch) {
  const r = await send(`${swarmBee()}${path}`, { ...init, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`Bee ${init.method ?? "GET"} ${path.split("?")[0]} -> ${r.status} ${(await r.text().catch(() => "")).slice(0, 160)}`);
  return r;
}

/** Upload JSON as a named file (/bzz), encrypted or not. Needs a usable postage batch. */
export async function swarmUploadJson(value: unknown, opts: { encrypt: boolean; name?: string }, send: typeof fetch = fetch): Promise<SwarmUpload> {
  if (!swarmEnabled()) throw new Error("SWARM_POSTAGE_BATCH_ID is not set");
  const body = JSON.stringify(value);
  const r = await bee(`/bzz?name=${encodeURIComponent(opts.name ?? "data.json")}`, {
    method: "POST",
    headers: { "content-type": "application/json", "swarm-postage-batch-id": swarmBatch(), "swarm-encrypt": String(opts.encrypt), "swarm-pin": "true" },
    body,
  }, send);
  const { reference } = (await r.json()) as { reference: string };
  const parts = splitReference(reference);
  if (parts.encrypted !== opts.encrypt) throw new Error("Bee returned an unexpected reference type");
  return { reference, encrypted: parts.encrypted, address: parts.address, size: new TextEncoder().encode(body).length };
}

/** Read JSON back through our Bee node (required for encrypted references). */
export async function swarmDownloadJson<T = unknown>(reference: string, send: typeof fetch = fetch): Promise<T> {
  splitReference(reference);
  const r = await bee(`/bzz/${reference}/`, {}, send);
  return (await r.json()) as T;
}

/** Bee node + stamp status, for diagnostics. */
export async function swarmStatus(send: typeof fetch = fetch) {
  const out: Record<string, unknown> = { bee: swarmBee(), batch: swarmBatch() || null, gateway: swarmGateway() };
  try { out.health = await (await bee("/health", {}, send)).json(); } catch (e) { out.health = { error: (e as Error).message }; return out; }
  try { out.wallet = await (await bee("/wallet", {}, send)).json(); } catch { /* not available on every node mode */ }
  try { out.addresses = ((await (await bee("/addresses", {}, send)).json()) as any).ethereum ?? null; } catch { /* ignore */ }
  if (swarmBatch()) { try { out.stamp = await (await bee(`/stamps/${swarmBatch()}`, {}, send)).json(); } catch (e) { out.stamp = { error: (e as Error).message }; } }
  return out;
}

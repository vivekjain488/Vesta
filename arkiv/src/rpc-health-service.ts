/** One lightweight eth_chainId probe per eligible endpoint; bounded globally and per provider host. */
import "dotenv/config";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { healthKey, loadProbeTargets, probeRpc, readHealth, saveHealth } from "./rpc-health";
import { RpcHealthPublisher } from "./rpc-health-arkiv";
import type { RpcRecord } from "./registry-data";

const dir = resolve(process.env.PERPETUA_STATE_DIR ?? ".perpetua"); mkdirSync(dir, { recursive: true });
const lock = resolve(dir, "rpc-health.pid");
if (existsSync(lock)) { const pid = Number(readFileSync(lock, "utf8")); let alive = false; try { process.kill(pid, 0); alive = true; } catch {} if (alive) throw new Error(`RPC health service already running (${pid})`); unlinkSync(lock); }
const fd = openSync(lock, "wx"); writeFileSync(fd, String(process.pid)); closeSync(fd);
let stopped = false; for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { stopped = true; });
const publisher = new RpcHealthPublisher("monitor", process.env.RPC_HEALTH_VANTAGE ?? "perpetua-monitor");
if (!publisher.enabled) console.warn("[rpc-health] no Arkiv health key (ARKIV_HEALTH_PRIVATE_KEY / ARKIV_MARKET_PRIVATE_KEY): samples stay local");
const state = readHealth(), hostLast = new Map<string, number>(); let targets: RpcRecord[] = [], loadedAt = 0;
try {
  while (!stopped) {
    try {
      if (!targets.length || Date.now() - loadedAt > 3600_000) {
        const result = await loadProbeTargets(); targets = result.rows.filter((r) => r.executionEligible && !r.requiresKey && r.transport === "https");
        state.snapshot = result.snapshot; loadedAt = Date.now(); console.log(`[rpc-health] loaded ${targets.length} eligible public HTTPS targets`);
      }
      const now = Date.now();
      const sorted = targets.filter((r) => now - (state.entries[healthKey(r.chainId, r.endpointHash)]?.samples.at(-1)?.at ?? 0) >= 3600_000)
        .sort((a, b) => (state.entries[healthKey(a.chainId, a.endpointHash)]?.samples.at(-1)?.at ?? (a.chainId === 16602 ? -1 : 0)) - (state.entries[healthKey(b.chainId, b.endpointHash)]?.samples.at(-1)?.at ?? (b.chainId === 16602 ? -1 : 0)));
      const selected: RpcRecord[] = [];
      for (const row of sorted) { if (selected.length >= 4) break; if ((hostLast.get(row.host) ?? 0) > now) continue; hostLast.set(row.host, now + 60_000); selected.push(row); }
      const samples = await Promise.all(selected.map((row) => probeRpc(row)));
      for (let i = 0; i < selected.length; i++) { const row = selected[i], sample = samples[i], key = healthKey(row.chainId, row.endpointHash);
        if (sample.outcome === "rate_limited") { const raw = sample.headers["retry-after"]; const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : 0; const date = raw ? Date.parse(raw) : NaN; const wait = seconds ? seconds * 1000 : Number.isFinite(date) ? date - Date.now() : 300_000; hostLast.set(row.host, Date.now() + Math.max(60_000, Math.min(wait, 3600_000))); }
        const previous = state.entries[key]?.samples ?? []; state.entries[key] = { chainId: row.chainId, endpointHash: row.endpointHash, samples: [...previous.filter((p) => p.at >= now - 24 * 3600_000), sample].slice(-48) }; }
      for (let i = 0; i < selected.length; i++) publisher.enqueue(selected[i].chainId, selected[i].endpointHash, samples[i], "monitor");
      const published = await publisher.flush();
      if (published) console.log(`[rpc-health] stored ${published.published} samples on Arkiv: ${published.txHash}`);
      if (selected.length) { state.updatedAt = Date.now(); saveHealth(state); console.log(`[rpc-health] sampled ${selected.length} endpoints; ${samples.filter((s) => s.ok).length} healthy`); }
    } catch (error) { console.error(`[rpc-health] cycle failed: ${String((error as Error).message).replace(/https?:\/\/\S+/g, "[endpoint]").slice(0, 300)}`); await sleep(30_000); }
    if (!stopped) await sleep(5000);
  }
} finally { if (existsSync(lock) && Number(readFileSync(lock, "utf8")) === process.pid) unlinkSync(lock); }

import express from "express";
import { registryHead, registryChains, registryChain, registryRpcs, resolveRegistryRpc } from "@perpetua/arkiv";

const number = (v: unknown, fallback?: number) => { if (v === undefined) return fallback; if (typeof v !== "string" || !/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) throw new TypeError("Invalid numeric query"); return Number(v); };
const text = (v: unknown) => { if (v === undefined) return undefined; if (typeof v !== "string" || Buffer.byteLength(v) > 128) throw new TypeError("Invalid text query"); return v; };
const bool = (v: unknown) => { if (v === undefined) return undefined; if (v !== "true" && v !== "false") throw new TypeError("Use true or false"); return v === "true"; };

/** Public reads deliberately sit outside the wallet/session API. No team key or login is needed. */
export function registryRouter() {
  const router = express.Router(), traffic = new Map<string, { start: number; calls: number }>(); let resolving = 0;
  router.use((req, res, next) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET, OPTIONS");
    res.setHeader("cache-control", "no-store");
    if (req.method === "OPTIONS") return void res.sendStatus(204);
    const id = req.ip ?? "local", now = Date.now(), entry = traffic.get(id);
    const count = entry && now - entry.start < 60_000 ? entry : { start: now, calls: 0 };
    count.calls++; traffic.set(id, count);
    if (traffic.size > 1000) traffic.delete(traffic.keys().next().value!);
    if (count.calls > 120) { res.setHeader("retry-after", "60"); return void res.status(429).json({ error: "Registry read limit reached; retry in a minute or query Arkiv directly" }); }
    next();
  });
  const route = (handler: (req: express.Request) => Promise<unknown>) => async (req: express.Request, res: express.Response) => {
    try { res.json(await handler(req)); }
    catch (error) { const bad = error instanceof TypeError; res.status(bad ? 400 : 503).json({ error: bad ? error.message : "Arkiv registry is not available yet. Retry after the import completes." }); }
  };
  router.get("/status", route(() => registryHead()));
  router.get("/chains", route((req) => registryChains({ chainId: number(req.query.chainId), namePrefix: text(req.query.name), networkType: text(req.query.network), status: text(req.query.status), parent: text(req.query.parent), after: number(req.query.after), limit: number(req.query.limit, 50), snapshot: text(req.query.snapshot) })));
  router.get("/chains/:chainId", route((req) => registryChain(number(req.params.chainId)!)));
  router.get("/rpcs/:chainId", route((req) => registryRpcs(number(req.params.chainId)!, { transport: text(req.query.transport), requiresKey: bool(req.query.requiresKey), eligible: bool(req.query.eligible), limit: number(req.query.limit, 100), after: number(req.query.after), snapshot: text(req.query.snapshot) })));
  router.get("/resolve/:chainId", route(async (req) => {
    const chainId = number(req.params.chainId)!;
    if (resolving >= 4) throw new Error("Resolver busy");
    resolving++; try { return await resolveRegistryRpc(chainId); } finally { resolving--; }
  }));
  return router;
}

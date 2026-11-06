/**
 * Pay-per-query data market over the agents' Arkiv records.
 *
 *   GET /data/agents                         free   agents for sale, price, payout wallet
 *   GET /data/:agentId/summary               free   public track record (counts, outcomes, R) read from Arkiv
 *   GET /data/paid/:agentId/:kind            paid   decrypted decisions | signals | trades (latest first)
 *
 * Payment goes to the agent's own Privy income wallet, which is swept into its vault automatically and funds its
 * compute (see income-wallets.ts). Two settlement modes:
 *   x402   public networks: the x402 middleware (registered in server.ts) verifies and settles before this runs.
 *   local  Anvil: the buyer transfers USDC to the payout wallet and sends the tx hash in `x-payment-tx`; the
 *          transfer is verified on-chain (recipient, amount, success) and each tx pays for one query only.
 */
import express from "express";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeEventLog, erc20Abi, getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agentRecords, AGENT_DATA_KINDS, swarmDownloadJson, unseal, type AgentDataKind } from "@perpetua/arkiv";
import type { Platform } from "./platform";
import type { IncomeWallets } from "./income-wallets";

const KINDS = AGENT_DATA_KINDS;
type Kind = AgentDataKind;
const column = (v: any) => v?.value ?? v;
const PRICE_USD = Number(String(process.env.DATA_QUERY_PRICE ?? "$0.01").replace("$", ""));
export const dataQueryPrice = () => `$${PRICE_USD}`;
const PRICE_UNITS = BigInt(Math.round(PRICE_USD * 1e6));

/** The Arkiv writer the agents publish from; readers trust only its rows. */
export function recordsWriter(): Hex | null {
  const k = process.env.ARKIV_PRIVATE_KEY as Hex | undefined;
  return k ? privateKeyToAccount(k).address : null;
}

async function rows(kind: Kind, agentId: string, limit: number) {
  const writer = recordsWriter();
  if (!writer) throw new Error("Agent records are not being published to Arkiv (ARKIV_PRIVATE_KEY unset)");
  return agentRecords(kind, agentId, writer, limit);
}

function publicFields(r: any) {
  const out: Record<string, unknown> = { entityKey: r.$key };
  for (const [k, v] of Object.entries(r)) if (!k.startsWith("$") && k !== "payload") out[k] = typeof column(v) === "bigint" ? column(v).toString() : column(v);
  return out;
}

export function dataMarketRouter(platform: Platform, wallets: IncomeWallets) {
  const router = express.Router();
  const usedFile = resolve(platform.state, "data-payments.json");
  const used: Record<string, { agentId: string; at: number }> = existsSync(usedFile) ? JSON.parse(readFileSync(usedFile, "utf8")) : {};
  const local = async () => (process.env.DATA_PAYMENT_MODE ?? ((await platform.pub.getChainId()) === 31337 ? "local" : "x402")) === "local";
  const agentOr404 = (id: string) => { try { return platform.agent(id); } catch { return null; } };

  router.get("/agents", async (_req, res) => {
    const out = platform.agents().map((a) => ({ agentId: a.id, name: a.name, payTo: wallets.get(a.id)?.address ?? null, price: dataQueryPrice(), kinds: Object.keys(KINDS) }));
    res.json({ settlement: (await local()) ? "local" : "x402", agents: out });
  });

  router.get("/:agentId/summary", async (req, res) => {
    const agent = agentOr404(req.params.agentId);
    if (!agent) return void res.status(404).json({ error: "Unknown agent" });
    try {
      const [decisions, signals, trades] = await Promise.all((Object.keys(KINDS) as Kind[]).map((k) => rows(k, agent.id, 100)));
      const closed = signals.filter((s) => column(s.status) === "closed");
      const r = closed.map((s) => Number(column(s.r_multiple) ?? 0));
      res.json({
        agentId: agent.id, name: agent.name, writer: recordsWriter(), payTo: wallets.get(agent.id)?.address ?? null, price: dataQueryPrice(),
        counts: { decisions: decisions.length, signals: signals.length, trades: trades.length },
        trackRecord: { closedSignals: closed.length, wins: closed.filter((s) => column(s.outcome) === "win").length, avgR: r.length ? Number((r.reduce((a, b) => a + b, 0) / r.length).toFixed(3)) : null },
        latest: decisions.slice(0, 5).map(publicFields),
        income: (() => { const w = wallets.get(agent.id); return w ? { wallet: w.address, custody: "Privy server wallet (app-controlled, no user approval)", sales: w.sales, salesUsd: w.salesUsd, sweptUsd: Number(BigInt(w.swept)) / 1e6, lastSweep: w.sweeps.at(-1) ?? null, lastError: w.lastError ?? null } : null; })(),
        settlement: (await local()) ? "local" : "x402",
        note: "Public attributes are free on Arkiv. Payloads (levels, sizes, reasoning, order IDs) are sealed; buy them per query.",
      });
    } catch (e) { res.status(503).json({ error: (e as Error).message }); }
  });

  router.get("/paid/:agentId/:kind", async (req, res) => {
    const agent = agentOr404(req.params.agentId);
    const kind = req.params.kind as Kind;
    if (!agent || !(kind in KINDS)) return void res.status(404).json({ error: "Unknown agent or data kind (decisions | signals | trades)" });
    const wallet = wallets.get(agent.id);
    if (!wallet) return void res.status(503).json({ error: "This agent has no payout wallet yet" });
    try {
      if (await local()) {
        const tx = String(req.header("x-payment-tx") ?? "");
        const quote = { error: "Payment required", price: dataQueryPrice(), amount: PRICE_UNITS.toString(), asset: platform.deployment().usdc, payTo: wallet.address, chainId: await platform.pub.getChainId(), howTo: "Transfer the amount of USDC to payTo, then retry with header x-payment-tx: <tx hash>. One payment buys one query." };
        if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) return void res.status(402).json(quote);
        if (used[tx.toLowerCase()]) return void res.status(402).json({ ...quote, error: "This payment was already used" });
        const receipt = await platform.pub.getTransactionReceipt({ hash: tx as Hex }).catch(() => null);
        const paid = receipt?.status === "success" && receipt.logs.some((l) => {
          if (getAddress(l.address) !== getAddress(platform.deployment().usdc)) return false;
          try { const ev: any = decodeEventLog({ abi: erc20Abi, data: l.data, topics: l.topics }); return ev.eventName === "Transfer" && getAddress(ev.args.to) === wallet.address && ev.args.value >= PRICE_UNITS; } catch { return false; }
        });
        if (!paid) return void res.status(402).json({ ...quote, error: "No confirmed USDC transfer of the price to payTo in that transaction" });
        used[tx.toLowerCase()] = { agentId: agent.id, at: Date.now() };
        mkdirSync(platform.state, { recursive: true }); writeFileSync(usedFile, JSON.stringify(used), { mode: 0o600 });
      }
      const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 50) || 50));
      const records = await Promise.all((await rows(kind, agent.id, limit)).map(async (r) => {
        const uid = String(column(r.uid) ?? "");
        let payload: unknown = null, sealed = false;
        try { if (r.payload) ({ value: payload, sealed } = unseal(uid, column(r.payload))); } catch { payload = { error: "payload could not be decrypted" }; }
        // Swarm-backed body: the sealed payload holds the encrypted Swarm reference; read and decrypt it via our Bee.
        const ref = (payload as any)?.swarm?.reference as string | undefined;
        if (ref) {
          try { payload = ((await swarmDownloadJson<any>(ref)) as any).body; }
          catch (e) { payload = { error: `Swarm read failed: ${(e as Error).message.slice(0, 120)}` }; }
          return { ...publicFields(r), sealed, storage: "swarm-encrypted", swarm: { reference: ref, address: ref.slice(0, 64), note: "Encrypted reference (address + key): anyone holding it can read the body from Swarm through a Bee node." }, payload };
        }
        return { ...publicFields(r), sealed, storage: "arkiv-sealed", payload };
      }));
      wallets.recordSale(agent.id, PRICE_USD);
      res.json({ agentId: agent.id, kind, count: records.length, paidTo: wallet.address, price: dataQueryPrice(), records });
    } catch (e) { res.status(503).json({ error: (e as Error).message }); }
  });
  return router;
}

import { Router } from "express";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { decodeFunctionData, erc20Abi, getAddress, isAddress, parseUnits, verifyTypedData, type Address, type Hex } from "viem";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const WETH = "0x4200000000000000000000000000000000000006" as Address;
type Quote = { owner: Address; request: Record<string, unknown>; typed: string; quoteId: string; expires: number; agent: string; used: boolean };
const same = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const decimal = (x: unknown, places: number) => typeof x === "string" && new RegExp(`^(?:0|[1-9]\\d*)(?:\\.\\d{1,${places}})?$`).test(x) && Number(x) > 0 && Number.isFinite(Number(x));

/** Validate every spending permission before it is displayed to the user's wallet. */
export function validateFlashQuote(quote: any, owner: Address, qty: string, spender: Address) {
  if (!quote?.quoteId || quote.orderType !== "limit" || quote.side !== "buy" || !same(quote.targetAsset, WETH) || !same(quote.contraAsset, USDC) || quote.wrap || !quote.evm?.orderTypedData) throw new Error("Flash returned an unexpected quote");
  if (quote.evm.permitTypedData) throw new Error("Permit2 quotes are not supported in this flow yet; use a wallet without a pre-existing Permit2 authorization.");
  const td = JSON.parse(quote.evm.orderTypedData);
  const m = td.message;
  const fields = ["swapper:address", "vault:address", "recipient:address", "fromToken:address", "toToken:address", "fromAmount:uint256", "salt:uint256", "deadline:uint256"];
  const actualFields = Array.isArray(td.types?.FlashOrder) ? td.types.FlashOrder.map((field: any) => `${field.name}:${field.type}`) : [];
  if (JSON.stringify(fields) !== JSON.stringify(actualFields) || td.domain?.version !== "1" || BigInt(m?.deadline ?? 0) <= BigInt(Math.floor(Date.now() / 1000))) throw new Error("Unexpected or expired Flash signing format");
  if (td.primaryType !== "FlashOrder" || td.domain?.name !== "DefinitiveFlashAllowance" || Number(td.domain.chainId) !== 8453 || !same(td.domain.verifyingContract, spender) || !same(m?.swapper, owner) || !same(m?.recipient, owner) || !same(m?.fromToken, USDC) || !same(m?.toToken, WETH) || BigInt(m?.fromAmount ?? 0) !== parseUnits(qty, 6)) throw new Error("Flash signing payload does not match the requested order");
  if (quote.evm.approveTx) {
    const tx = quote.evm.approveTx;
    if (!same(tx.to, USDC)) throw new Error("Unexpected approval token");
    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    if (decoded.functionName !== "approve" || !same(decoded.args[0], spender) || decoded.args[1] > parseUnits(qty, 6)) throw new Error("Unexpected or excessive Flash approval");
  }
  return td;
}

export function flashSocialRouter(state: string, ownerOf: (req: any) => Address, knownAgent: (name: string) => boolean) {
  const router = Router();
  const quotes = new Map<string, Quote>();
  const key = process.env.FLASH_API_KEY ?? "";
  const base = process.env.FLASH_BASE_URL ?? "https://flash.definitive.fi/v1";
  const spender = process.env.FLASH_SOCIAL_SPENDER ?? "";
  const log = `${state}/flash-social-orders.jsonl`;
  const configured = () => !!key && isAddress(spender) && process.env.FLASH_SOCIAL_ENABLED === "true";
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, headers: { "x-definitive-api-key": key, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    const data = await response.json() as any;
    if (!response.ok) throw new Error(`Flash ${response.status}: ${data?.error?.message ?? "request failed"}`);
    return data;
  };
  router.get("/config", (_req, res) => res.json({ enabled: configured(), quoteEnabled: !!key, chain: "Base", chainId: 8453, pair: "WETH / USDC", maxUsd: Number(process.env.COPY_MAX_USD ?? 100) }));
  router.post("/quote", async (req, res) => {
    try {
      if (!key) return void res.status(503).json({ error: "Flash quote service is not configured." });
      const owner = getAddress(ownerOf(req));
      const { agent, amount, limitPrice } = req.body ?? {};
      if (typeof agent !== "string" || !knownAgent(agent)) throw new Error("Select an agent from the leaderboard");
      if (!decimal(amount, 6) || Number(amount) > Number(process.env.COPY_MAX_USD ?? 100)) throw new Error("Invalid USDC amount or amount exceeds the order cap");
      if (!decimal(limitPrice, 6)) throw new Error("Enter a valid positive USD limit price");
      const request = { targetChain: "base", contraChain: "base", targetAsset: WETH, contraAsset: USDC, side: "buy", qty: amount, orderType: "limit", limitNotionalPrice: limitPrice, funderAddress: owner, forceMinimalAllowance: true, evmUsePermit2: false };
      const quote = await call("/quote", "POST", request);
      // A preview cannot be signed or submitted unless the settlement address is independently configured.
      const observed = JSON.parse(quote?.evm?.orderTypedData ?? "{}").domain?.verifyingContract;
      const submissionEnabled = configured();
      if (!isAddress(observed ?? "")) throw new Error("Flash quote has no valid settlement contract");
      validateFlashQuote(quote, owner, amount, submissionEnabled ? getAddress(spender) : getAddress(observed));
      if (!submissionEnabled) return void res.json({ submissionEnabled: false, request, quote: { from: quote.from, to: quote.to, fees: quote.fees, approvalRequired: !!quote.evm.approveTx } });
      const id = randomUUID(); const now = Date.now();
      for (const [k, v] of quotes) if (v.expires < now || v.used) quotes.delete(k);
      if (quotes.size >= 1000) throw new Error("Too many pending quotes; try again shortly");
      quotes.set(id, { owner, request, typed: quote.evm.orderTypedData, quoteId: quote.quoteId, expires: now + 15 * 60_000, agent, used: false });
      res.json({ id, submissionEnabled: true, request, quote: { from: quote.from, to: quote.to, fees: quote.fees, evm: quote.evm }, expiresAt: now + 15 * 60_000 });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  router.post("/order", async (req, res) => {
    try {
      if (!configured()) return void res.status(503).json({ error: "Flash orders are not configured by the operator." });
      const q = quotes.get(req.body?.id); const owner = getAddress(ownerOf(req));
      if (!q || q.used || q.expires < Date.now() || !same(q.owner, owner)) throw new Error("Quote expired or unavailable; request a new quote");
      const signature = req.body?.signature as Hex;
      if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) throw new Error("A wallet signature is required");
      const typed = JSON.parse(q.typed);
      if (!await verifyTypedData({ address: owner, ...typed, signature })) throw new Error("Signature does not match the signed-in wallet");
      if (q.used) throw new Error("Quote already submitted");
      q.used = true; // Never retry an ambiguous submission automatically.
      appendFileSync(log, JSON.stringify({ attemptId: req.body.id, owner, agent: q.agent, request: q.request, at: Date.now(), status: "submission_attempted" }) + "\n");
      const { forceMinimalAllowance: _minimal, evmUsePermit2: _permit, ...orderRequest } = q.request;
      const result = await call("/order", "POST", { ...orderRequest, quoteId: q.quoteId, userSignature: signature, evmOrderTypedData: q.typed });
      if (typeof result.orderId !== "string") throw new Error("Flash did not return an order ID; check Flash before retrying");
      appendFileSync(log, JSON.stringify({ attemptId: req.body.id, orderId: result.orderId, owner, agent: q.agent, request: q.request, at: Date.now() }) + "\n");
      res.json({ orderId: result.orderId, status: "submitted" });
    } catch (e) { res.status(400).json({ error: `${(e as Error).message}. If submission was attempted, check your Flash orders before retrying.` }); }
  });
  router.get("/orders", async (req, res) => {
    try {
      const owner = getAddress(ownerOf(req));
      const rows = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((x) => JSON.parse(x)).filter((x) => same(x.owner, owner)).slice(-50).reverse() : [];
      const completed = new Set(rows.filter((row) => row.orderId).map((row) => row.attemptId));
      const result = await Promise.all(rows.filter((row) => row.orderId || !completed.has(row.attemptId)).map(async (row) => { if (!row.orderId) return { ...row, flash: null }; try { return { ...row, flash: await call(`/orders/${encodeURIComponent(row.orderId)}?funderAddress=${owner}`) }; } catch { return { ...row, flash: null }; } }));
      res.json(result);
    } catch { res.status(503).json({ error: "Orders are unavailable" }); }
  });
  return router;
}

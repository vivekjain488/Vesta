/**
 * Definitive Flash REST client (https://flash.definitive.fi/v1, schema from /v1/openapi.json).
 * quote -> (RiskGate approval) -> EIP-1271 "signature" from AgentWallet -> order. Integrator fee is sent
 * identically on /quote and /order. A sim backend mirrors the same shapes for the offline demo.
 */
import { decodeFunctionData, erc20Abi, keccak256, toHex, type Address, type Hex } from "viem";

export type OrderType = "market" | "limit" | "twap" | "stop" | "stop-loss" | "take-profit" | "bracket";

export interface QuoteRequest {
  targetChain: string;
  contraChain: string;
  targetAsset: Address;
  contraAsset: Address;
  side: "buy" | "sell";
  qty: string; // decimal string, units of the SPENT asset
  orderType: OrderType;
  funderAddress?: Address;
  maxSlippage?: string;
  limitNotionalPrice?: string;
  expireTime?: string;
  triggers?: { notionalPrice?: string; crossPrice?: string; triggerType: "upper" | "lower"; limitPrice?: string }[];
  attachedBracket?: { takeProfit: { notionalPrice: string }; stopLoss: { notionalPrice: string }; expireTime?: string };
  flashIntegratorFeeBps?: string;
  forceMinimalAllowance?: boolean;
}

export interface QuoteResponse {
  quoteId: string;
  orderType: OrderType;
  side: "buy" | "sell";
  targetAsset: string;
  contraAsset: string;
  from: { asset: "target" | "contra"; amount: string; notional: string };
  to: { asset: "target" | "contra"; amount: string; notional: string } | null;
  fees: { estimatedFeeNotional: string };
  estimatedPriceImpact: string | null;
  recommendedSlippage?: string | null;
  evm: { approveTx: { to: Address; data: Hex } | null; permitTypedData: string | null; orderTypedData: string | null } | null;
  attachedBracket?: { evm?: { orderTypedData: string; salt?: string; permitTypedData?: string | null }; deadline?: string; signedMaxFromAmount?: string } | null;
}

export interface FlashOrder {
  orderId: string;
  status: string;
  orderType: string;
  side: string;
  funderAddress: string;
  qty: string;
  trigger?: unknown;
}

export interface FlashBackend {
  quote(q: QuoteRequest): Promise<QuoteResponse>;
  order(body: Record<string, unknown>): Promise<{ orderId: string; attachedBracket?: unknown }>;
  getOrder(orderId: string): Promise<{ order: FlashOrder; fills: any[] }>;
  listOrders(funder: Address, statuses?: string[]): Promise<FlashOrder[]>;
  cancel(orderId: string, cancelMessage: string, userSignature: Hex): Promise<unknown>;
}

export class FlashHttp implements FlashBackend {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}
  private async call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { "x-definitive-api-key": this.apiKey, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Flash ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : {};
  }
  quote(q: QuoteRequest) {
    return this.call("POST", "/quote", q);
  }
  order(body: Record<string, unknown>) {
    return this.call("POST", "/order", body);
  }
  getOrder(orderId: string) {
    return this.call("GET", `/orders/${orderId}`);
  }
  async listOrders(funder: Address, statuses?: string[]) {
    const qs = new URLSearchParams({ funderAddress: funder, pageSize: "200" });
    if (statuses?.length) qs.set("statuses", statuses.join(","));
    const r = await this.call("GET", `/orders?${qs}`);
    return (r.orders ?? []) as FlashOrder[];
  }
  cancel(orderId: string, cancelMessage: string, userSignature: Hex) {
    return this.call("POST", `/orders/${orderId}/cancel`, { cancelMessage, userSignature });
  }
}

/** Canonical cancel message (em dash U+2014, single \n): verified byte-for-byte by Flash. */
export const cancelMessage = (orderId: string) => `Definitive Flash v1 — Cancel Order\nOrder: ${orderId}`;

/** The spender Flash wants approved (Permit2 or DefinitiveFlashAllowance), read from quote.evm.approveTx. */
export function approvalSpender(q: QuoteResponse): Address | null {
  const tx = q.evm?.approveTx;
  if (!tx) return null;
  try {
    const { args } = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    return (args?.[0] as Address) ?? null;
  } catch {
    return null;
  }
}

/** USD price of the target asset implied by a quote (notional / amount of the target leg). */
export function impliedTargetPrice(q: QuoteResponse): number {
  const leg = q.from.asset === "target" ? q.from : q.to;
  if (!leg || Number(leg.amount) === 0) throw new Error("quote has no target leg");
  return Number(leg.notional) / Number(leg.amount);
}

// ------------------------------------------------------------------------------------------- sim backend

/**
 * Offline simulator with the same request/response shapes. Typed data uses a "FlashSim" domain so the digest
 * pipeline (hash -> RiskGate approval -> EIP-1271) is exercised exactly as in production. Never used with
 * FLASH_MODE=live.
 */
export class FlashSim implements FlashBackend {
  private orders = new Map<string, { order: FlashOrder; fills: any[] }>();
  constructor(
    private readonly price: (asset: string) => number,
    private readonly chainId: number,
  ) {}
  async quote(q: QuoteRequest): Promise<QuoteResponse> {
    const p = this.price(q.targetAsset);
    const qty = Number(q.qty);
    const fee = qty * (Number(q.flashIntegratorFeeBps ?? 0) + 10) / 10_000;
    const quoteId = `simq_${keccak256(toHex(JSON.stringify(q) + Date.now())).slice(2, 14)}`;
    const targetAmount = q.side === "buy" ? (qty - fee) / p : qty;
    const contraAmount = q.side === "buy" ? qty : qty * p - fee;
    const typed = (kind: string, extra: Record<string, unknown>) =>
      JSON.stringify({
        domain: { name: "FlashSim", version: "1", chainId: this.chainId, verifyingContract: "0x000000000000000000000000000000000000f1a5" },
        types: {
          Order: [
            { name: "quoteId", type: "string" },
            { name: "kind", type: "string" },
            { name: "funder", type: "address" },
            { name: "qty", type: "string" },
            { name: "deadline", type: "uint256" },
          ],
        },
        primaryType: "Order",
        message: { quoteId, kind, funder: q.funderAddress ?? "0x0000000000000000000000000000000000000000", qty: q.qty, deadline: String(Math.floor(Date.now() / 1000) + 3600), ...extra },
      });
    return {
      quoteId,
      orderType: q.orderType,
      side: q.side,
      targetAsset: q.targetAsset,
      contraAsset: q.contraAsset,
      from: q.side === "buy" ? { asset: "contra", amount: String(qty), notional: String(qty) } : { asset: "target", amount: String(qty), notional: String(qty * p) },
      to: q.side === "buy" ? { asset: "target", amount: String(targetAmount), notional: String(targetAmount * p) } : { asset: "contra", amount: String(contraAmount), notional: String(contraAmount) },
      fees: { estimatedFeeNotional: String(fee) },
      estimatedPriceImpact: "0.0005",
      recommendedSlippage: "0.005",
      evm: { approveTx: null, permitTypedData: null, orderTypedData: typed("entry", {}) },
      attachedBracket: q.attachedBracket ? { evm: { orderTypedData: typed("bracket", {}) } } : null,
    };
  }
  async order(body: Record<string, unknown>) {
    const orderId = crypto.randomUUID();
    this.orders.set(orderId, {
      order: { orderId, status: "ORDER_STATUS_FILLED", orderType: String(body.orderType), side: String(body.side), funderAddress: String(body.funderAddress), qty: String(body.qty) },
      fills: [{ integratorFeeAmount: (Number(body.qty) * Number(body.flashIntegratorFeeBps ?? 0)) / 10_000, feeTicker: "USDC" }],
    });
    return { orderId };
  }
  async getOrder(orderId: string) {
    const o = this.orders.get(orderId);
    if (!o) throw new Error("not found");
    return o;
  }
  async listOrders(funder: Address) {
    return [...this.orders.values()].map((o) => o.order).filter((o) => o.funderAddress.toLowerCase() === funder.toLowerCase());
  }
  async cancel(orderId: string) {
    const o = this.orders.get(orderId);
    if (o) o.order.status = "ORDER_STATUS_CANCELLED";
    return { ok: true };
  }
}

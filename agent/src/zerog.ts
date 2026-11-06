/**
 * The agent's brain on the 0G Compute Network, in direct mode: the agent's OWN wallet holds the compute
 * ledger, pays per token, and every response is TEE-signed. Three spend caps:
 *   1. runtime cap (SpendCap: per-hour / per-day token budget, enforced here before every call)
 *   2. provider sub-account cap (only `subAccountTopUpOg` is moved into a provider's sub-account at a time)
 *   3. ComputeTreasury daily withdrawal cap (on-chain, see ComputeTreasury.sol)
 */
import { SpendCap, type TierPolicy } from "@perpetua/core";
import { keccak256, toBytes, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { projectRpc } from "@perpetua/arkiv";
import type { ChatMessage, InferenceResult as BrainResult } from "./inference/types";
export type { ChatMessage, InferenceResult as BrainResult } from "./inference/types";

export interface Brain {
  readonly mode: "live" | "sim";
  readonly fundingMode?: "router";
  ledgerOg(): Promise<number>;
  depositOg(amount: number): Promise<string>;
  think(policy: TierPolicy, messages: ChatMessage[], maxTokens?: number, signal?: AbortSignal): Promise<BrainResult | null>;
  teeSigner(model: "large" | "small"): Promise<Hex | null>;
  caps(): ReturnType<SpendCap["snapshot"]>;
}

const OG = 1e18;

export class ZeroGBrain implements Brain {
  readonly mode = "live" as const;
  private broker: any;
  private readonly cap: SpendCap;
  constructor(
    private readonly cfg: {
      rpc: string;
      privateKey: Hex;
      providerLarge: string;
      providerSmall: string;
      subAccountTopUpOg: number;
      minLedgerOg: number;
      maxTokensPerHour: number;
      maxTokensPerDay: number;
      /** Hosted workers reserve bootstrap capital before any on-chain ledger/provider funding. */
      initializeLedger?: boolean;
    },
  ) {
    this.cap = new SpendCap(cfg.maxTokensPerHour, cfg.maxTokensPerDay);
  }

  async init() {
    const { ethers } = await import("ethers");
    const sdk: any = await import("@0gfoundation/0g-compute-ts-sdk");
    const chainId = Number(process.env.ZG_CHAIN_ID ?? 16602);
    const discovered = await projectRpc(chainId, this.cfg.rpc);
    const provider = new ethers.JsonRpcProvider(discovered.endpoint);
    if ((await provider.getNetwork()).chainId !== BigInt(chainId)) throw new Error("0G RPC returned the wrong chain ID");
    const wallet = new ethers.Wallet(this.cfg.privateKey, provider);
    this.broker = await sdk.createZGComputeNetworkBroker(wallet);
    const providers = [...new Set([this.cfg.providerLarge, this.cfg.providerSmall].filter(Boolean))];
    const services = await this.broker.inference.listService();
    for (const p of providers) {
      if (!services.some((service: any) => service.provider.toLowerCase() === p.toLowerCase() && service.teeSignerAcknowledged)) throw new Error(`0G provider ${p} has no acknowledged TEE signer`);
    }
    try {
      await this.broker.ledger.getLedger();
    } catch (error) {
      // A transient RPC failure is not permission to create/fund another account.
      if (!/Account does not exist/i.test((error as Error).message)) throw error;
      if (this.cfg.initializeLedger === false) return this;
      await this.broker.ledger.addLedger(this.cfg.minLedgerOg);
    }
    // SDK signer checks may create/fund provider sub-accounts. The ledger must exist first.
    for (const p of this.cfg.initializeLedger === false ? [] : providers) {
      const status = await this.broker.inference.checkProviderSignerStatus(p);
      if (!status.isAcknowledged) throw new Error(`0G provider ${p} signer is not acknowledged`);
    }
    return this;
  }

  caps() {
    return this.cap.snapshot();
  }

  async ledgerOg() {
    try {
      const l = await this.broker.ledger.getLedger();
      return Number(l.availableBalance ?? l[1]) / OG;
    } catch (error) {
      if (/Account does not exist/i.test((error as Error).message)) return 0;
      throw error;
    }
  }

  async depositOg(amount: number) {
    await this.broker.ledger.depositFund(amount);
    return `depositFund(${amount})`;
  }

  async teeSigner(model: "large" | "small") {
    const p = model === "large" ? this.cfg.providerLarge : this.cfg.providerSmall;
    if (!p) return null;
    const s = await this.broker.inference.checkProviderSignerStatus(p);
    return s.teeSignerAddress as Hex;
  }

  private async ensureSubAccount(provider: string) {
    try {
      const acct = await this.broker.inference.getAccount(provider);
      const bal = Number(acct.balance ?? acct[3] ?? 0n) / OG;
      if (bal >= this.cfg.subAccountTopUpOg / 2) return;
    } catch {
      /* no sub-account yet */
    }
    const amount = BigInt(Math.round(this.cfg.subAccountTopUpOg * OG));
    await this.broker.ledger.transferFund(provider, "inference", amount);
  }

  async think(policy: TierPolicy, messages: ChatMessage[], maxTokens = 600, signal?: AbortSignal): Promise<BrainResult | null> {
    if (!policy.model) return null; // Starving / Hibernate: rules only
    const provider = policy.model === "large" ? this.cfg.providerLarge : this.cfg.providerSmall;
    if (!provider) return null;
    const estTokens = Math.min(policy.maxPromptTokens, messages.reduce((s, m) => s + m.content.length / 4, 0)) + maxTokens;
    if (!this.cap.canSpend(estTokens)) return null; // runtime spend cap: degrade, never error out

    await this.ensureSubAccount(provider);
    const before = await this.ledgerOg().catch(() => NaN);
    const { endpoint, model } = await this.broker.inference.getServiceMetadata(provider);
    const headers = await this.broker.inference.getRequestHeaders(provider, JSON.stringify(messages));
    const res = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ messages, model, max_tokens: maxTokens, temperature: 0.2 }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`0G provider ${provider} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data: any = await res.json();
    const chatId: string = res.headers.get("ZG-Res-Key") ?? data.id;
    const content: string = data.choices?.[0]?.message?.content ?? "";
    const verified: boolean | null = await this.broker.inference.processResponse(provider, chatId, JSON.stringify(data.usage ?? {}));
    const tokens = Number(data.usage?.total_tokens ?? estTokens);
    this.cap.record(tokens);

    // The exact TEE-signed text + signature, so RiskGate can verify the proposal on-chain.
    let tee: BrainResult["tee"] = null;
    try {
      const sdk: any = await import("@0gfoundation/0g-compute-ts-sdk");
      const svc = (await this.broker.inference.listService()).find((s: any) => s.provider.toLowerCase() === provider.toLowerCase());
      const sig = await sdk.InferenceVerifier.fetchSignatureByChatID(svc.url, chatId, model);
      const signer = (await this.teeSigner(policy.model)) as Hex;
      tee = { text: sig.text, signature: sig.signature as Hex, signer };
    } catch (e) {
      console.warn("[0g] TEE signature unavailable; RiskGate will refuse any order from this call:", (e as Error).message);
    }
    const after = await this.ledgerOg().catch(() => NaN);
    return { content, chatId, model, provider, verified, tee, tokens, costOg: Number.isFinite(before - after) ? Math.max(0, before - after) : 0 };
  }
}

/**
 * Offline simulator (ZG_MODE=sim). A local key plays the TEE signer, the ledger is in-memory, and costs are the
 * configured per-call estimates. Responses come from a deterministic rules "model". The demo discloses this.
 */
export class SimBrain implements Brain {
  readonly mode = "sim" as const;
  private ledger: number;
  private readonly cap: SpendCap;
  private readonly tee = privateKeyToAccount(keccak256(toBytes("perpetua-sim-tee-signer")));
  constructor(
    private readonly cfg: { startOg: number; costOg: { large: number; small: number }; maxTokensPerHour: number; maxTokensPerDay: number },
  ) {
    this.ledger = cfg.startOg;
    this.cap = new SpendCap(cfg.maxTokensPerHour, cfg.maxTokensPerDay);
  }
  caps() {
    return this.cap.snapshot();
  }
  async ledgerOg() {
    return this.ledger;
  }
  /** Simulated idle burn (heartbeats, ledger fees); demo accelerates this. */
  burn(og: number) {
    this.ledger = Math.max(0, this.ledger - og);
  }
  async depositOg(amount: number) {
    this.ledger += amount;
    return `sim-deposit-${amount}`;
  }
  async teeSigner() {
    return this.tee.address as Hex;
  }
  async think(policy: TierPolicy, messages: ChatMessage[], maxTokens = 600): Promise<BrainResult | null> {
    if (!policy.model) return null;
    const estTokens = messages.reduce((s, m) => s + m.content.length / 4, 0) + maxTokens;
    if (!this.cap.canSpend(estTokens)) return null;
    const cost = this.cfg.costOg[policy.model];
    if (this.ledger < cost) return null;
    this.ledger -= cost;
    this.cap.record(estTokens);
    const user = messages[messages.length - 1].content;
    const pos = (user.match(/\b(surge|rally|record|approval|partnership|upgrade|inflow|launch)\b/gi) ?? []).length;
    const neg = (user.match(/\b(hack|exploit|lawsuit|outflow|crash|ban|delay|selloff)\b/gi) ?? []).length;
    const score = Math.max(-1, Math.min(1, (pos - neg) / 4 + 0.15));
    const content = JSON.stringify({ sentiment: Number(score.toFixed(2)), reasons: [`${pos} positive / ${neg} negative headline cues`], model: `sim-${policy.model}` });
    const chatId = `sim-${keccak256(toHex(content + Date.now())).slice(2, 18)}`;
    const signature = await this.tee.signMessage({ message: content });
    return { content, chatId, model: `sim-${policy.model}`, provider: "sim", verified: true, tee: { text: content, signature, signer: this.tee.address }, tokens: Math.round(estTokens), costOg: cost };
  }
}

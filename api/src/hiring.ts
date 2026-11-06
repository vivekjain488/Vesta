/**
 * Strategy hiring: users rank agents on the leaderboard and hire one (copy-trade + strategy access) by paying in
 * any accepted token. StrategyHire swaps the payment to $0G and sends it with Chainlink CCIP to HireReceiver on
 * 0G Chain, which pays the agent's Privy wallet. Prices follow the leaderboard (operator = platform admin).
 *
 * Local Anvil: both contracts are deployed on the same chain and connected through the mock CCIP router (auto
 * delivery), with a fixed-rate swap venue. On public networks set HIRE_CONTRACT / HIRE_RECEIVER (+ the real CCIP
 * router, the 0G CCT and a DEX adapter) instead; the API only reads them.
 */
import express from "express";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { encodeFunctionData, erc20Abi, getAddress, parseUnits, type Address, type Hex } from "viem";
import { harvestRouterAbi, hireReceiverAbi, mockCCIPRouterAbi, mockERC20Abi, strategyHireAbi } from "@perpetua/core";
import { clients } from "../../agent/src/chain";
import type { Platform } from "./platform";
import type { IncomeWallets } from "./income-wallets";

const PERIOD_DAYS = 30;
const OG_PRICE_USD = Number(process.env.OG_PRICE_USD ?? 0.5);
/** Demo prices for the local swap venue (USD per token). */
const LOCAL_PRICES: Record<string, number> = { USDC: 1, LINK: 15, WETH: 3000, WBTC: 76000, ...JSON.parse(process.env.HIRE_PRICES_JSON ?? "{}") };

export interface HireToken { symbol: string; address: Address; decimals: number; priceUsd: number }
interface HireState { hire: Address; receiver: Address; swapAdapter: Address; tokens: HireToken[]; plans: Record<string, number> }

/** Leaderboard price: $5 + 20% of the agent's profit, rounded to $0.50, capped at $250 per 30 days. */
export const hirePriceUsd = (profitUsd: number) => Math.min(250, Math.max(5, Math.round((5 + 0.2 * Math.max(0, profitUsd)) * 2) / 2));

export class HireService {
  private readonly file: string;
  private s: HireState | null;
  constructor(private readonly platform: Platform, private readonly wallets: IncomeWallets) {
    this.file = resolve(platform.state, "hiring.json");
    this.s = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : null;
  }
  private save() { writeFileSync(this.file, JSON.stringify(this.s, null, 2)); }
  get state() { return this.s; }
  private admin() { return clients(process.env.VAULT_RPC_URL ?? "http://127.0.0.1:8545", 31337, process.env.FLASH_SPENDER_PRIVATE_KEY as Hex); }

  /** Local chain only: deploy + wire StrategyHire, HireReceiver, accepted tokens and swap rates once. */
  async ensureLocal() {
    const pub = this.platform.pub;
    if ((await pub.getChainId()) !== 31337) return;
    if (this.s && (await pub.getCode({ address: this.s.hire }))?.length) return;
    const admin = this.admin();
    const dep = this.platform.deployment();
    const artifacts = resolve(new URL("../..", import.meta.url).pathname, "contracts/out");
    const receipt = async (hash: Hex) => { const r = await pub.waitForTransactionReceipt({ hash }); if (r.status !== "success") throw new Error("hire setup transaction reverted"); return r; };
    const deploy = async (name: string, args: any[]) => { const a = JSON.parse(readFileSync(resolve(artifacts, `${name}.sol/${name}.json`), "utf8")); const r = await receipt(await admin.wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object as Hex, args, account: admin.account, chain: admin.chain })); return r.contractAddress!; };
    const send = async (address: Address, abi: any, functionName: string, args: any[]) => receipt(await admin.wallet.writeContract({ address, abi, functionName, args, account: admin.account, chain: admin.chain }));

    const swapAdapter = (await pub.readContract({ address: dep.harvestRouter, abi: harvestRouterAbi, functionName: "swapAdapter" })) as Address;
    const localSelector = (await pub.readContract({ address: dep.ccipRouter, abi: mockCCIPRouterAbi, functionName: "localChainSelector" })) as bigint;
    const hire = await deploy("StrategyHire", [dep.ccipRouter, dep.usdc, admin.account.address]);
    const receiver = await deploy("HireReceiver", [dep.ccipRouter, dep.zeroG, admin.account.address]);
    await send(hire, strategyHireAbi, "configure", [dep.zeroG, swapAdapter, localSelector, receiver, 250_000n, 200n]);
    await send(hire, strategyHireAbi, "setOperator", [admin.account.address]);
    await send(receiver, hireReceiverAbi, "setAllowedSender", [localSelector, hire, true]);

    const tokens: HireToken[] = [{ symbol: "USDC", address: getAddress(dep.usdc), decimals: 6, priceUsd: 1 }, { symbol: "LINK", address: getAddress(dep.link), decimals: 18, priceUsd: LOCAL_PRICES.LINK }];
    tokens.push({ symbol: "WETH", address: await deploy("MockERC20", ["Wrapped Ether", "WETH", 18]), decimals: 18, priceUsd: LOCAL_PRICES.WETH });
    tokens.push({ symbol: "WBTC", address: await deploy("MockERC20", ["Wrapped Bitcoin", "WBTC", 8]), decimals: 8, priceUsd: LOCAL_PRICES.WBTC });
    const setRate = async (from: HireToken, to: Address, toDecimals: number, usdPerToToken: number) => {
      // MockSwapAdapter: out = in * rate / 1e18, so rate = (price_from / price_to) * 10^toDec * 1e18 / 10^fromDec
      const ratio = parseUnits((from.priceUsd / usdPerToToken).toFixed(12), 12);
      const rate = (ratio * 10n ** BigInt(toDecimals) * 10n ** 18n) / (10n ** 12n * 10n ** BigInt(from.decimals));
      await send(swapAdapter, [{ type: "function", name: "setRate", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }], outputs: [] }], "setRate", [from.address, to, rate]);
    };
    for (const t of tokens) {
      if (t.symbol !== "USDC") { await send(hire, strategyHireAbi, "setAcceptedToken", [t.address, true]); await setRate(t, dep.usdc, 6, 1); }
      await setRate(t, dep.zeroG, 18, OG_PRICE_USD);
    }
    this.s = { hire, receiver, swapAdapter, tokens, plans: {} };
    this.save();
    console.log(`[hire] deployed StrategyHire ${hire} and HireReceiver ${receiver} (local CCIP + swap)`);
  }

  /** Keep on-chain prices and payout wallets in line with the leaderboard and the agents' Privy wallets. */
  async syncPlans() {
    if (!this.s) return;
    const admin = this.admin();
    const send = async (address: Address, abi: any, functionName: string, args: any[]) => this.platform.pub.waitForTransactionReceipt({ hash: await admin.wallet.writeContract({ address, abi, functionName, args, account: admin.account, chain: admin.chain }) });
    for (const a of this.platform.agents().filter((x) => x.platformAgent)) {
      try {
        const price = hirePriceUsd((await this.platform.summary(a)).profit);
        if (this.s.plans[a.id] !== price) {
          await send(this.s.hire, strategyHireAbi, "setPlan", [a.agentId, parseUnits(price.toFixed(2), 6), PERIOD_DAYS, true]);
          this.s.plans[a.id] = price;
        }
        const payout = this.wallets.get(a.id)?.address;
        if (payout) {
          const current = (await this.platform.pub.readContract({ address: this.s.receiver, abi: hireReceiverAbi, functionName: "payoutOf", args: [a.agentId] })) as Address;
          if (current.toLowerCase() !== payout.toLowerCase()) await send(this.s.receiver, hireReceiverAbi, "setPayout", [a.agentId, payout]);
        }
      } catch (e) { console.warn(`[hire] plan ${a.id}: ${(e as Error).message.slice(0, 120)}`); }
    }
    this.save();
  }

  agentOf(ref: string) { return this.platform.agents().find((a) => a.id === ref || a.name === ref) ?? null; }

  async hiredUntil(agentRef: string, user: Address): Promise<number> {
    const a = this.agentOf(agentRef);
    if (!this.s || !a) return 0;
    return Number(await this.platform.pub.readContract({ address: this.s.hire, abi: strategyHireAbi, functionName: "hiredUntil", args: [a.agentId, user] }));
  }

  start() {
    void this.ensureLocal().then(() => this.syncPlans()).catch((e) => console.warn("[hire]", (e as Error).message));
    setInterval(() => void this.syncPlans().catch(() => {}), 10 * 60_000).unref();
  }
}

export function hireRouter(platform: Platform, hire: HireService, wallets: IncomeWallets, owner: (req: express.Request) => Address | undefined) {
  const router = express.Router();
  const ready = (res: express.Response) => { if (!hire.state) { res.status(503).json({ error: "Hiring contracts are not deployed yet" }); return false; } return true; };

  router.get("/agents", async (req, res) => {
    if (!ready(res)) return;
    try {
      const s = hire.state!, user = owner(req);
      const rows = await Promise.all(platform.agents().filter((a) => a.platformAgent).map(async (a) => {
        const summary = await platform.summary(a);
        const plan = (await platform.pub.readContract({ address: s.hire, abi: strategyHireAbi, functionName: "plans", args: [a.agentId] })) as readonly [bigint, number, boolean];
        const received = (await platform.pub.readContract({ address: s.receiver, abi: hireReceiverAbi, functionName: "paidTotal", args: [a.agentId] })) as bigint;
        return {
          agentId: a.id, name: a.name, profit: summary.profit, priceUsd: Number(plan[0]) / 1e6, periodDays: plan[1], active: plan[2],
          payoutWallet: wallets.get(a.id)?.address ?? null, zeroGReceived: Number(received) / 1e18,
          hiredUntil: user ? await hire.hiredUntil(a.id, user) : 0,
        };
      }));
      rows.sort((x, y) => y.profit - x.profit);
      const fee = (await platform.pub.readContract({ address: s.hire, abi: strategyHireAbi, functionName: "estimateFee", args: ["0x" + "00".repeat(32) as Hex, 1n] })) as bigint;
      res.json({ chainId: await platform.pub.getChainId(), contract: s.hire, receiver: s.receiver, ccipFeeWei: fee.toString(), zeroGPriceUsd: OG_PRICE_USD, tokens: s.tokens, agents: rows.map((r, i) => ({ rank: i + 1, ...r })) });
    } catch (e) { res.status(503).json({ error: (e as Error).message }); }
  });

  /** Exact amounts + calldata for approve and hire; the user's wallet signs both. */
  router.get("/quote", async (req, res) => {
    if (!ready(res)) return;
    try {
      const s = hire.state!, a = hire.agentOf(String(req.query.agent ?? ""));
      const token = s.tokens.find((t) => t.symbol === String(req.query.token ?? "USDC") || t.address.toLowerCase() === String(req.query.token).toLowerCase());
      if (!a || !token) return void res.status(404).json({ error: "Unknown agent or token" });
      const plan = (await platform.pub.readContract({ address: s.hire, abi: strategyHireAbi, functionName: "plans", args: [a.agentId] })) as readonly [bigint, number, boolean];
      if (!plan[2]) return void res.status(409).json({ error: "This agent is not available for hire yet" });
      const priceUsd = Number(plan[0]) / 1e6;
      // +0.5% so venue rounding never leaves the payment a hair under the price
      const amountIn = token.symbol === "USDC" ? plan[0] : parseUnits(((priceUsd / token.priceUsd) * 1.005).toFixed(token.decimals), token.decimals);
      const zeroGOut = Number(((priceUsd * (token.symbol === "USDC" ? 1 : 1.005)) / OG_PRICE_USD).toFixed(6));
      const fee = (await platform.pub.readContract({ address: s.hire, abi: strategyHireAbi, functionName: "estimateFee", args: [a.agentId, parseUnits(String(zeroGOut), 18)] })) as bigint;
      res.json({
        agent: a.id, name: a.name, priceUsd, periodDays: plan[1], token, amountIn: amountIn.toString(), zeroGOut, ccipFeeWei: fee.toString(),
        approve: { to: token.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [s.hire, amountIn] }) },
        hire: { to: s.hire, data: encodeFunctionData({ abi: strategyHireAbi, functionName: "hire", args: [a.agentId, token.address, amountIn, 0n] }), value: fee.toString() },
        payoutWallet: wallets.get(a.id)?.address ?? null,
      });
    } catch (e) { res.status(503).json({ error: (e as Error).message }); }
  });

  /** Local chain only: test balances of every accepted token so users can try paying in any of them. */
  router.post("/test-tokens", async (req, res) => {
    if (!ready(res)) return;
    try {
      const user = owner(req);
      if (!user || (await platform.pub.getChainId()) !== 31337) return void res.status(400).json({ error: "Local test tokens are only available on the local chain" });
      const admin = clients(process.env.VAULT_RPC_URL ?? "http://127.0.0.1:8545", 31337, process.env.FLASH_SPENDER_PRIVATE_KEY as Hex);
      const minted: Record<string, string> = {};
      for (const t of hire.state!.tokens) {
        const amount = parseUnits(String(Math.max(1, Math.ceil(500 / t.priceUsd))), t.decimals); // ~$500 of each
        await platform.pub.waitForTransactionReceipt({ hash: await admin.wallet.writeContract({ address: t.address, abi: mockERC20Abi, functionName: "mint", args: [user, amount], account: admin.account, chain: admin.chain }) });
        minted[t.symbol] = amount.toString();
      }
      res.json({ minted });
    } catch (e) { res.status(503).json({ error: (e as Error).message }); }
  });
  return router;
}

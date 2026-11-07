import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, http, getAddress, erc20Abi, type Address } from "viem";
import { agentWalletAbi, perpetuaVaultAbi, riskGateAbi } from "@perpetua/core";
import { projectTransport } from "@perpetua/arkiv";

const json = (value: unknown) => JSON.parse(JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v));
export class Platform {
  readonly pub = createPublicClient({ transport: projectTransport(Number(process.env.VAULT_CHAIN_ID ?? 31337), process.env.VAULT_RPC_URL ?? "http://127.0.0.1:8545") });
  constructor(readonly state: string) {}
  deployment() {
    const file = process.env.DEPLOYMENT_FILE ?? resolve(this.state, "../contracts/deployments/local-31337.json");
    if (!existsSync(file)) return {};
    const dep = JSON.parse(readFileSync(file, "utf8"));
    for (const [key, value] of Object.entries(dep)) if (typeof value === "string" && value.startsWith("{")) dep[key] = JSON.parse(value);
    return dep;
  }
  agents() { return Object.entries(this.deployment()).filter(([, v]: any) => v && typeof v === "object" && v.vault && v.riskGate && v.wallet).map(([id, value]: any) => ({ id, name: value.name ?? id, ...value })); }
  agent(id: string) { const agent = this.agents().find((a) => a.id === id); if (!agent) throw new Error("Agent not found"); return agent; }
  async owns(id: string, owner: string) { const a = this.agent(id); return (await this.pub.readContract({ address: a.vault, abi: perpetuaVaultAbi, functionName: "agentOwner" })).toLowerCase() === owner.toLowerCase(); }
  stateOf(id: string) {
    if (!/^[A-Za-z0-9_-]{1,60}$/.test(id)) throw new Error("Invalid agent");
    const path = resolve(this.state, `agent-${id}.json`);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  }
  computeFundingOf(id: string) {
    if (!/^[A-Za-z0-9_-]{1,60}$/.test(id)) throw new Error("Invalid agent");
    const file = resolve(this.state, `compute-funding-${id}.json`);
    const runtime = this.stateOf(id);
    const journal = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    return {
      initialAllocation: { percent: 20, maximumUsd: 5 },
      profitRefillPercent: 20,
      status: journal?.status ?? runtime?.computeFunding ?? { action: "wait", reason: "funding_not_started", allowNewTrades: false },
      bootstrapComplete: journal?.bootstrapComplete ?? false,
      pending: journal?.intent ? { id: journal.intent.id, source: journal.intent.source, amountUsdMicros: journal.intent.amountUsd, minimumComputeWei: journal.intent.minimumComputeWei, createdAtMs: journal.intent.createdAtMs } : null,
      progress: journal?.progress ?? null,
      history: journal?.reservations ?? [],
    };
  }
  // Public RPCs commonly limit eth_getLogs ranges; never scan a public chain from genesis.
  private async events(address: Address, abi: any, options: { eventName?: string; args?: any } = {}): Promise<any[]> {
    const chainId = await this.pub.getChainId();
    const configured = this.deployment().startBlock ?? process.env.VAULT_DEPLOYMENT_START_BLOCK;
    if (chainId !== 31337 && configured === undefined) throw new Error("Public deployment requires a startBlock for event history");
    if (configured !== undefined && !/^\d+$/.test(String(configured))) throw new Error("Invalid deployment startBlock");
    const start = configured === undefined ? 0n : BigInt(configured);
    const latest = await this.pub.getBlockNumber({ cacheTime: 0 });
    if (start > latest) throw new Error("Deployment startBlock is ahead of the RPC head");
    const result: any[] = [];
    const chunk = chainId === 31337 ? 100_000n : 1_000n;
    for (let fromBlock = start; fromBlock <= latest; fromBlock += chunk) {
      const toBlock = fromBlock + chunk - 1n < latest ? fromBlock + chunk - 1n : latest;
      result.push(...await this.pub.getContractEvents({ address, abi, ...options, fromBlock, toBlock } as any));
    }
    return result;
  }
  async history(id: string) {
    const a = this.agent(id);
    const logs = (await Promise.all([[a.vault, perpetuaVaultAbi], [a.wallet, agentWalletAbi], [a.riskGate, riskGateAbi]].map(([address, abi]) => this.events(address as Address, abi)))).flat();
    const names = new Set(["Deposit", "Withdraw", "IncomeRecorded", "WalletFunded", "WalletPulled", "Harvested", "OrderApproved", "WithdrawalSleep", "Returned"]);
    const rows: any[] = logs.filter((l: any) => names.has(l.eventName)).map((l: any) => ({ id: `${l.transactionHash}:${l.logIndex}`, type: l.eventName, transactionHash: l.transactionHash, blockNumber: l.blockNumber, logIndex: l.logIndex, args: l.args }));
    const dep = this.deployment();
    const tokens = [{ address: dep.usdc, symbol: "USDC", decimals: 6 }, ...(a.assets ?? [{ address: dep.link, symbol: "LINK", decimals: 18 }])];
    for (const token of tokens) {
      const transfers = (await Promise.all(["from", "to"].map((side) => this.events(token.address, erc20Abi, { eventName: "Transfer", args: { [side]: a.wallet } })))).flat();
      for (const l of transfers) rows.push({ id: `${l.transactionHash}:${l.logIndex}`, type: l.args.to?.toLowerCase() === a.wallet.toLowerCase() ? "AssetReceived" : "AssetSent", transactionHash: l.transactionHash, blockNumber: l.blockNumber, logIndex: l.logIndex, args: { amount: l.args.value, symbol: token.symbol, decimals: token.decimals } });
    }
    return json([...new Map(rows.map((r) => [r.id, r])).values()].sort((a, b) => Number(b.blockNumber - a.blockNumber) || b.logIndex - a.logIndex));
  }
  async summary(a: any) {
    const read = (address: Address, abi: any, functionName: string) => this.pub.readContract({ address, abi, functionName });
    const [owner, V, principal, mandate, hibernating, withdrawalPaused, tradingOff, reserve, piBps, harvested, harvestable] = await Promise.all([
      read(a.vault, perpetuaVaultAbi, "agentOwner"), read(a.vault, perpetuaVaultAbi, "totalAssets"), read(a.vault, perpetuaVaultAbi, "principal"), read(a.riskGate, riskGateAbi, "mandate"),
      read(a.riskGate, riskGateAbi, "hibernating"), read(a.riskGate, riskGateAbi, "withdrawalPaused"), read(a.riskGate, riskGateAbi, "tradingOff"),
      read(a.vault, perpetuaVaultAbi, "computeReserve"), read(a.vault, perpetuaVaultAbi, "piBps"), read(a.vault, perpetuaVaultAbi, "totalHarvested"), read(a.vault, perpetuaVaultAbi, "harvestableIncome"),
    ]) as any[];
    const flows = await this.events(a.vault, perpetuaVaultAbi);
    const deposits = flows.filter((l) => l.eventName === "Deposit").reduce((sum: bigint, l: any) => sum + BigInt(l.args.assets), 0n) as bigint;
    const withdrawals = flows.filter((l) => l.eventName === "Withdraw").reduce((sum: bigint, l: any) => sum + BigInt(l.args.assets), 0n) as bigint;
    const usd = (n: bigint) => Number(n) / 1e6;
    const runtime = this.stateOf(a.id);
    const profit = usd(BigInt(V) + withdrawals - deposits);
    const executionEnabled = this.deployment().executionEnabled !== false;
    return { id: a.id, name: a.name, owner: getAddress(owner), strategy: a.strategy ?? "Managed strategy", riskTier: a.riskTier ?? "balanced", profit, deposited: usd(deposits), withdrawn: usd(withdrawals), status: withdrawalPaused || runtime?.sleeping ? "sleeping" : V === 0n ? "awaiting_funding" : !executionEnabled ? "inactive" : "active",
      chain: { V: usd(V), principal: usd(principal), F: usd(BigInt(principal) * BigInt(piBps) / 10000n + BigInt(reserve)), C: Math.max(0, usd(BigInt(V) - (BigInt(principal) * BigInt(piBps) / 10000n + BigInt(reserve)))), E: usd(mandate[6]), riskyValue: usd(mandate[7]), epoch: Number(mandate[0]), validUntil: Number(mandate[2]), hibernating, withdrawalPaused, tradingOff, reserve: usd(reserve), piBps: Number(piBps), harvested: usd(harvested), harvestable: usd(harvestable) },
      runtime: runtime ? { ...runtime, signals: Object.values(runtime.signals ?? {}), trades: Object.values(runtime.trades ?? {}) } : null };
  }
}

/** Typed viem wrappers around RiskGate / PerpetuaVault / AgentWallet / ComputeTreasury. */
import { agentWalletAbi, computeTreasuryAbi, perpetuaVaultAbi, riskGateAbi, type MandateView, type OrderIntent, type PriceAttestation, type TeeProof } from "@perpetua/core";
import { BaseError, ContractFunctionRevertedError, hexToString, type Address, type Hex } from "viem";
import type { Clients } from "./chain";

export class Gate {
  constructor(
    private readonly c: Clients,
    readonly riskGate: Address,
    readonly vault: Address,
    readonly wallet: Address,
  ) {}

  async mandate(): Promise<MandateView> {
    const m = (await this.c.pub.readContract({ address: this.riskGate, abi: riskGateAbi, functionName: "mandate" })) as readonly any[];
    const [epoch, computedAt, validUntil, V, F, C, E, riskyValue, stateHash] = m;
    return { epoch, computedAt, validUntil, V, F, C, E, riskyValue, stateHash };
  }

  async flags() {
    const read = (fn: any) => this.c.pub.readContract({ address: this.riskGate, abi: riskGateAbi as any, functionName: fn }) as Promise<any>;
    const [hibernating, tradingOff, halfSize, haltedUntil, multiplier, eMax, riskTier, withdrawalPaused] = await Promise.all([
      read("hibernating"),
      read("tradingOff"),
      read("halfSize"),
      read("haltedUntil"),
      read("multiplier"),
      read("eMax"),
      read("riskTier"),
      read("withdrawalPaused"),
    ]);
    return { hibernating, tradingOff, halfSize, withdrawalPaused: Boolean(withdrawalPaused), haltedUntil: Number(haltedUntil), multiplier: Number(multiplier), eMax: eMax as bigint, riskTier: Number(riskTier) };
  }

  async vaultState() {
    const read = (fn: any) => this.c.pub.readContract({ address: this.vault, abi: perpetuaVaultAbi as any, functionName: fn }) as unknown as Promise<bigint>;
    const [principal, totalAssets, floorValue, harvestable, totalHarvested, piBps, computeReserve] = await Promise.all([
      read("principal"),
      read("totalAssets"),
      read("floorValue"),
      read("harvestableIncome"),
      read("totalHarvested"),
      read("piBps"),
      read("computeReserve"),
    ]);
    return { principal, totalAssets, floorValue, harvestable, totalHarvested, piBps, computeReserve };
  }

  async poke(prices: PriceAttestation[]) {
    const hash = await this.c.wallet.writeContract({ address: this.riskGate, abi: riskGateAbi, functionName: "poke", args: [prices as any], account: this.c.account, chain: this.c.chain });
    return this.c.pub.waitForTransactionReceipt({ hash });
  }

  async checkOrder(o: OrderIntent, px: PriceAttestation): Promise<string> {
    const r = (await this.c.pub.readContract({ address: this.riskGate, abi: riskGateAbi, functionName: "checkOrder", args: [o as any, px as any] })) as Hex;
    return hexToString(r, { size: 32 }).replace(/\0/g, "");
  }

  /** Submits the proposal. Returns the receipt, or the on-chain rejection reason (the reverted tx). */
  async approveOrder(o: OrderIntent, px: PriceAttestation, proof: TeeProof): Promise<{ ok: true; txHash: Hex } | { ok: false; reason: string; txHash?: Hex }> {
    try {
      await this.c.pub.simulateContract({ address: this.riskGate, abi: riskGateAbi, functionName: "approveOrder", args: [o as any, px as any, proof as any], account: this.c.account });
    } catch (e) {
      return { ok: false, reason: revertReason(e) };
    }
    const hash = await this.c.wallet.writeContract({ address: this.riskGate, abi: riskGateAbi, functionName: "approveOrder", args: [o as any, px as any, proof as any], account: this.c.account, chain: this.c.chain });
    const rc = await this.c.pub.waitForTransactionReceipt({ hash });
    return rc.status === "success" ? { ok: true, txHash: hash } : { ok: false, reason: "REVERTED", txHash: hash };
  }

  /** Demo beat: send the reckless proposal anyway (skip simulation) so the reverted tx is on-chain. */
  async approveOrderUnsafe(o: OrderIntent, px: PriceAttestation, proof: TeeProof) {
    const hash = await this.c.wallet.writeContract({ address: this.riskGate, abi: riskGateAbi, functionName: "approveOrder", args: [o as any, px as any, proof as any], account: this.c.account, chain: this.c.chain, gas: 1_500_000n });
    return { hash, receipt: await this.c.pub.waitForTransactionReceipt({ hash }) };
  }

  async isValidSignature(digest: Hex, sig: Hex) {
    return this.c.pub.readContract({ address: this.wallet, abi: agentWalletAbi, functionName: "isValidSignature", args: [digest, sig] });
  }

  async approveCancel(orderId: string) {
    const hash = await this.c.wallet.writeContract({ address: this.wallet, abi: agentWalletAbi, functionName: "approveCancel", args: [orderId], account: this.c.account, chain: this.c.chain });
    return this.c.pub.waitForTransactionReceipt({ hash });
  }

  async setFeeParams(mgmtBps: bigint, perfBps: bigint, computeNeed: bigint) {
    const hash = await this.c.wallet.writeContract({ address: this.vault, abi: perpetuaVaultAbi, functionName: "setFeeParams", args: [mgmtBps, perfBps, computeNeed], account: this.c.account, chain: this.c.chain });
    return this.c.pub.waitForTransactionReceipt({ hash });
  }

  async setRuntimeFlags(halfSize: boolean, highVol: boolean) {
    const hash = await this.c.wallet.writeContract({ address: this.riskGate, abi: riskGateAbi, functionName: "setRuntimeFlags", args: [halfSize, highVol], account: this.c.account, chain: this.c.chain });
    return this.c.pub.waitForTransactionReceipt({ hash });
  }
}

export class Treasury {
  constructor(
    private readonly c: Clients,
    readonly address: Address,
    readonly agentId: Hex,
  ) {}
  async balance(): Promise<bigint> {
    return (await this.c.pub.readContract({ address: this.address, abi: computeTreasuryAbi, functionName: "balanceOf", args: [this.agentId] })) as bigint;
  }
  async withdrawForLedger(amount: bigint) {
    const hash = await this.c.wallet.writeContract({ address: this.address, abi: computeTreasuryAbi, functionName: "withdrawForLedger", args: [this.agentId, amount], account: this.c.account, chain: this.c.chain });
    return { hash, receipt: await this.c.pub.waitForTransactionReceipt({ hash }) };
  }
  async funded(operationId: Hex): Promise<boolean> {
    return this.c.pub.readContract({ address: this.address, abi: computeTreasuryAbi, functionName: "fundedOperations", args: [this.agentId, operationId] });
  }
  /** Atomic native conversion + recipient-ledger deposit; the operation ID prevents duplicate credits. */
  async fundLedger(operationId: Hex, amount: bigint) {
    const args = [this.agentId, operationId, amount] as const;
    await this.c.pub.simulateContract({ address: this.address, abi: computeTreasuryAbi, functionName: "fundLedger", args, account: this.c.account });
    const hash = await this.c.wallet.writeContract({ address: this.address, abi: computeTreasuryAbi, functionName: "fundLedger", args, account: this.c.account, chain: this.c.chain });
    const receipt = await this.c.pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("Compute ledger funding reverted");
    return { hash, receipt };
  }
}

export function revertReason(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (r?.data?.errorName === "Rejected") return hexToString(r.data.args?.[0] as Hex, { size: 32 }).replace(/\0/g, "");
    if (r?.data?.errorName) return r.data.errorName;
    return r?.reason ?? e.shortMessage;
  }
  return String(e);
}

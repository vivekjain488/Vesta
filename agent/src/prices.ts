/**
 * Price attestor. Flash quotes are not signed by Definitive, so a relayer key fetches a fresh Flash /quote
 * and signs (asset, priceE8, timestamp) as EIP-712 for RiskGate (<= 60s old). The SAME Flash quote that
 * will execute the order is what RiskGate enforces against: there is no second oracle to disagree with.
 */
import { priceAttestationTypedData, type PriceAttestation } from "@perpetua/core";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AssetCfg } from "./config";
import { impliedTargetPrice, type FlashBackend } from "./flash";

export class PriceAttestor {
  private readonly account;
  constructor(
    key: Hex,
    private readonly chainId: number,
    private readonly riskGate: Address,
    private readonly flash: FlashBackend,
    private readonly flashChain: string,
    private readonly usdc: Address,
    private readonly flashAssetAddress: (a: AssetCfg) => Address = (a) => a.address,
  ) {
    this.account = privateKeyToAccount(key);
  }

  get signer() {
    return this.account.address;
  }

  async priceUsd(asset: AssetCfg): Promise<number> {
    const q = await this.flash.quote({
      targetChain: this.flashChain,
      contraChain: this.flashChain,
      targetAsset: this.flashAssetAddress(asset),
      contraAsset: this.usdc,
      side: "buy",
      qty: "100",
      orderType: "market",
    });
    return impliedTargetPrice(q);
  }

  /** `nowSec` should be the latest block timestamp: RiskGate rejects attestations from the "future". */
  async attest(asset: AssetCfg, priceUsd?: number, nowSec?: bigint): Promise<PriceAttestation & { priceUsd: number }> {
    const p = priceUsd ?? (await this.priceUsd(asset));
    const priceE8 = BigInt(Math.round(p * 1e8));
    const timestamp = nowSec ?? BigInt(Math.floor(Date.now() / 1000));
    const td = priceAttestationTypedData(this.chainId, this.riskGate, asset.address, priceE8, timestamp);
    const signature = await this.account.signTypedData(td as any);
    return { asset: asset.address, priceE8, timestamp, signature, priceUsd: p };
  }
}

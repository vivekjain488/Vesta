/**
 * Local-only fill simulator for FLASH_MODE=sim on anvil. It settles an approved order the way Flash's
 * settlement contract would: pulling `amountIn` from the AgentWallet THROUGH the allowance RiskGate granted
 * (so the allowance cap is genuinely exercised) and crediting the bought asset to the wallet. Uses the
 * testnet MockERC20 (public mint/burn). Never wired up outside sim mode.
 */
import { erc20Abi, type Address } from "viem";
import { mockERC20Abi } from "@perpetua/core";
import type { Clients } from "./chain";

export class SimSettlement {
  constructor(private readonly spender: Clients) {}

  async fillEntry(o: { wallet: Address; tokenIn: Address; tokenOut: Address; amountIn: bigint; amountOut: bigint }) {
    const { pub, wallet, account, chain } = this.spender;
    const h1 = await wallet.writeContract({ address: o.tokenIn, abi: erc20Abi, functionName: "transferFrom", args: [o.wallet, account.address, o.amountIn], account, chain });
    if ((await pub.waitForTransactionReceipt({ hash: h1 })).status !== "success") throw new Error("Simulated input transfer reverted; no output was credited");
    const h2 = await wallet.writeContract({ address: o.tokenOut, abi: mockERC20Abi, functionName: "mint", args: [o.wallet, o.amountOut], account, chain });
    if ((await pub.waitForTransactionReceipt({ hash: h2 })).status !== "success") throw new Error("Simulated output credit reverted; reconcile the input transfer");
    return h2;
  }

  async fillExit(o: { wallet: Address; tokenIn: Address; tokenOut: Address; amountIn: bigint; amountOut: bigint }) {
    const { pub, wallet, account, chain } = this.spender;
    const h1 = await wallet.writeContract({ address: o.tokenIn, abi: erc20Abi, functionName: "transferFrom", args: [o.wallet, account.address, o.amountIn], account, chain });
    if ((await pub.waitForTransactionReceipt({ hash: h1 })).status !== "success") throw new Error("Simulated input transfer reverted; no output was credited");
    const h2 = await wallet.writeContract({ address: o.tokenOut, abi: mockERC20Abi, functionName: "mint", args: [o.wallet, o.amountOut], account, chain });
    if ((await pub.waitForTransactionReceipt({ hash: h2 })).status !== "success") throw new Error("Simulated output credit reverted; reconcile the input transfer");
    return h2;
  }
}

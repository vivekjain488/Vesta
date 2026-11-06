import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { erc20Abi, formatUnits, getAddress, isAddress, type Address } from "viem";
import { perpetuaVaultAbi, riskGateAbi } from "@perpetua/core";

type Reader = (address: Address, abi: any, name: string, args?: any[]) => Promise<any>;
export interface Investment {
  id: string;
  kind: "cash" | "lending" | "spot";
  token: Address;
  symbol: string;
  decimals: number;
  amount: string;
  valueUsd: number | null;
  costBasisUsd: number | null;
  unrealizedPnlUsd: number | null;
  valuation: "usdc" | "exit_quote" | "unavailable";
}

/** Actual holdings, not the runtime's list of assumed open orders. Null means unknown, never zero. */
export async function investments(read: Reader, deployment: any, agent: any, trades: any[], quoteExit?: (token: Address, amount: string) => Promise<number>) {
  const vault = agent.vault as Address;
  const gate = agent.riskGate as Address;
  const owner = getAddress(await read(vault, perpetuaVaultAbi, "agentOwner"));
  const [idle, safe, walletCash, shares, claimable, fullClaim, sleeping, minimum, count] = await Promise.all([
    read(vault, perpetuaVaultAbi, "idle"), read(vault, perpetuaVaultAbi, "safeValue"),
    read(deployment.usdc, erc20Abi, "balanceOf", [agent.wallet]), read(vault, perpetuaVaultAbi, "balanceOf", [owner]),
    read(vault, perpetuaVaultAbi, "maxWithdraw", [owner]), read(vault, perpetuaVaultAbi, "maxRedeem", [owner]),
    read(gate, riskGateAbi, "withdrawalPaused"), read(gate, riskGateAbi, "minimumOperatingCapital"), read(gate, riskGateAbi, "assetCount"),
  ]);
  if (Number(count) > 50) throw new Error("Asset list exceeds dashboard limit");
  const rows: Investment[] = [
    { id: "cash", kind: "cash", token: deployment.usdc, symbol: "USDC", decimals: 6, amount: formatUnits(idle + walletCash, 6), valueUsd: Number(idle + walletCash) / 1e6, costBasisUsd: null, unrealizedPnlUsd: null, valuation: "usdc" },
    { id: "safe-leg", kind: "lending", token: deployment.usdc, symbol: "USDC", decimals: 6, amount: formatUnits(safe, 6), valueUsd: Number(safe) / 1e6, costBasisUsd: null, unrealizedPnlUsd: null, valuation: "usdc" },
  ];
  for (let i = 0; i < Number(count); i++) {
    const token = getAddress(await read(gate, riskGateAbi, "assetList", [BigInt(i)]));
    const balance: bigint = await read(token, erc20Abi, "balanceOf", [agent.wallet]);
    if (balance === 0n) continue;
    const [, decimals] = await read(gate, riskGateAbi, "assets", [token]);
    const symbol = await read(token, erc20Abi, "symbol").catch(() => token.slice(0, 10));
    const amount = formatUnits(balance, Number(decimals));
    let valueUsd: number | null = null;
    if (quoteExit) {
      try { const value = await quoteExit(token, amount); if (Number.isFinite(value) && value >= 0) valueUsd = value; } catch { /* unavailable is displayed explicitly */ }
    }
    const tracked = trades.filter((t) => t.status === "open" && t.asset === symbol);
    const trackedQty = tracked.reduce((s, t) => s + Number(t.qty), 0);
    const trackedCost = tracked.reduce((s, t) => s + Number(t.sizeUsd), 0);
    const costBasisUsd = trackedQty > 0 && Number.isFinite(trackedCost) ? trackedCost / trackedQty * Number(amount) : null;
    rows.push({ id: token, kind: "spot", token, symbol, decimals: Number(decimals), amount, valueUsd, costBasisUsd, unrealizedPnlUsd: valueUsd !== null && costBasisUsd !== null ? valueUsd - costBasisUsd : null, valuation: valueUsd === null ? "unavailable" : "exit_quote" });
  }
  return { owner, vault, riskGate: gate, wallet: agent.wallet, ownerShares: shares.toString(), maxWithdraw: claimable.toString(), maxRedeem: fullClaim.toString(), sleeping: Boolean(sleeping), minimumOperatingCapital: minimum.toString(), investments: rows.filter((r) => shares > 0n && Number(r.amount) > 0), exitExecutionAvailable: false };
}

/** Persist exact owner intent; a request is never represented as a fill or a transfer. */
export function saveExitRequest(directory: string, owner: Address, payload: any) {
  if (!payload || typeof payload.agent !== "string" || !/^[A-Za-z0-9_-]{1,60}$/.test(payload.agent) || !isAddress(payload.token)) throw new Error("Invalid investment");
  if (typeof payload.amount !== "string" || !/^\d{1,78}$/.test(payload.amount) || BigInt(payload.amount) <= 0n) throw new Error("Positive base-unit amount required");
  if (typeof payload.minProceedsUsdc !== "string" || !/^\d{1,78}$/.test(payload.minProceedsUsdc) || BigInt(payload.minProceedsUsdc) <= 0n) throw new Error("Positive minimum USDC proceeds required");
  if (payload.allowLoss !== true) throw new Error("Confirm that exiting can realise a loss");
  const id = randomUUID();
  const request = { id, owner, agent: payload.agent, token: getAddress(payload.token), amount: payload.amount, minProceedsUsdc: payload.minProceedsUsdc, allowLoss: true, receiver: owner, status: "blocked_adapter_unavailable", createdAt: Date.now(), note: "No position was closed or money transferred. A venue execution/reconciliation adapter is required; fresh quotes and renewed owner consent are required before execution." };
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, `${id}.json`), JSON.stringify(request, null, 2), { mode: 0o600 });
  return request;
}

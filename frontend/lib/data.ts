"use client";
import { apiFetch } from "@/lib/api";
import { perpetuaVaultAbi, riskGateAbi } from "@perpetua/core";
import { createPublicClient, http, type Address } from "viem";

import { API } from "./api";
export { API } from "./api";

export const AGENTS = [
  { name: "Atlas", strategy: "Momentum: trades 4h trend breakouts with a bracket on every entry.", riskTier: "balanced" },
  { name: "Halcyon", strategy: "Mean-reversion: limit entries only when the market is range-bound.", riskTier: "conservative" },
  { name: "Ember", strategy: "DCA accumulator: steady bracketed buys, uses more of its cushion.", riskTier: "aggressive" },
] as const;

export interface Deployment {
  rpc: string;
  chainId: number;
  usdc: Address;
  link: Address;
  computeTreasury: Address;
  registry: Address;
  [agent: string]: any;
}

export interface OnChainAgent {
  V: number;
  F: number;
  C: number;
  E: number;
  riskyValue: number;
  epoch: number;
  validUntil: number;
  hibernating: boolean;
  withdrawalPaused: boolean;
  tradingOff: boolean;
  principal: number;
  piBps: number;
  reserve: number;
  harvested: number;
  harvestable: number;
}

export async function getJson<T>(path: string): Promise<T | null> {
  try {
    const r = await apiFetch(`${API}${path}`, { cache: "no-store" });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

let depCache: Deployment | null = null;
export async function deployment(): Promise<Deployment | null> {
  if (depCache) return depCache;
  depCache = await getJson<Deployment>("/v1/deployment");
  return depCache;
}

const usd = (x: bigint) => Number(x) / 1e6;

/** Read F/C/E straight from RiskGate: the Arena never trusts the agent's own number. */
export async function readAgent(dep: Deployment, name: string): Promise<OnChainAgent | null> {
  const a = dep[name];
  if (!a) return null;
  const pub = createPublicClient({ transport: http(dep.rpc) });
  try {
    const [m, hibernating, tradingOff, principal, piBps, reserve, harvested, harvestable, withdrawalPaused] = await Promise.all([
      pub.readContract({ address: a.riskGate, abi: riskGateAbi, functionName: "mandate" }) as Promise<readonly any[]>,
      pub.readContract({ address: a.riskGate, abi: riskGateAbi, functionName: "hibernating" }) as Promise<boolean>,
      pub.readContract({ address: a.riskGate, abi: riskGateAbi, functionName: "tradingOff" }) as Promise<boolean>,
      pub.readContract({ address: a.vault, abi: perpetuaVaultAbi, functionName: "principal" }) as Promise<bigint>,
      pub.readContract({ address: a.vault, abi: perpetuaVaultAbi, functionName: "piBps" }) as Promise<bigint>,
      pub.readContract({ address: a.vault, abi: perpetuaVaultAbi, functionName: "computeReserve" }) as Promise<bigint>,
      pub.readContract({ address: a.vault, abi: perpetuaVaultAbi, functionName: "totalHarvested" }) as Promise<bigint>,
      pub.readContract({ address: a.vault, abi: perpetuaVaultAbi, functionName: "harvestableIncome" }) as Promise<bigint>,
      pub.readContract({ address: a.riskGate, abi: riskGateAbi, functionName: "withdrawalPaused" }) as Promise<boolean>,
    ]);
    return {
      epoch: Number(m[0]),
      validUntil: Number(m[2]),
      V: usd(m[3]),
      F: usd(m[4]),
      C: usd(m[5]),
      E: usd(m[6]),
      riskyValue: usd(m[7]),
      hibernating,
      withdrawalPaused,
      tradingOff,
      principal: usd(principal),
      piBps: Number(piBps),
      reserve: usd(reserve),
      harvested: usd(harvested),
      harvestable: usd(harvestable),
    };
  } catch {
    return null;
  }
}

export interface AgentRuntime {
  tier: string;
  createdAt: number;
  burnOgPerHour: number;
  liveTrades: number;
  wins: number;
  trades: any[];
  signals: any[];
}

export const fmt = (n: number, d = 2) => (Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—");

export const TIER_COPY: Record<string, { label: string; tone: string; brain: string }> = {
  thrive: { label: "Thrive", tone: "text-alive", brain: "Largest 0G model" },
  frugal: { label: "Frugal", tone: "text-cushion", brain: "Smaller 0G model" },
  starving: { label: "Starving", tone: "text-exposure", brain: "Rules only, no LLM" },
  hibernate: { label: "Hibernating", tone: "text-dim", brain: "Asleep; stops stay live on-chain" },
};

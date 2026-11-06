"use client";
import { useEffect, useState } from "react";
import { getJson, type AgentRuntime, type OnChainAgent } from "@/lib/data";

export interface AgentView {
  id: string;
  profit?: number;
  status?: string;
  name: string;
  strategy: string;
  riskTier: string;
  chain: OnChainAgent | null;
  runtime: (AgentRuntime & { lastLedgerOg?: number; lastRunwayH?: number | null }) | null;
}

/** Polls RiskGate/vault on-chain + the agent's published runtime state. */
export function useAgents(intervalMs = 8000) {
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [online, setOnline] = useState<boolean | null>(null);
  useEffect(() => {
    let stop = false;
    const load = async () => {
      const rows = await getJson<AgentView[]>("/v1/dashboard");
      setOnline(rows !== null);
      if (!stop) setAgents(rows ?? []);
    };
    load();
    const t = setInterval(load, intervalMs);
    window.addEventListener("perpetua:capital-changed", load);
    return () => {
      stop = true;
      clearInterval(t);
      window.removeEventListener("perpetua:capital-changed", load);
    };
  }, [intervalMs]);
  return { agents, online };
}

export function runwayDays(a: AgentView): number {
  const h = a.runtime?.lastRunwayH;
  if (h === null || h === undefined) return Number.POSITIVE_INFINITY;
  return h / 24;
}

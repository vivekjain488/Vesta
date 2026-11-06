"use client";
import { useEffect, useState } from "react";
import { type AgentRuntime, type OnChainAgent } from "@/lib/data";
import { apiFetch } from "@/lib/api";

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
  const [chainDegraded, setChainDegraded] = useState(false);
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const response = await apiFetch("/v1/dashboard");
        if (!response.ok) throw new Error("Dashboard unavailable");
        const rows = await response.json() as AgentView[];
        if (!stop) { setOnline(true); setChainDegraded(response.headers.get("x-perpetua-chain-degraded") === "true"); setAgents(rows); }
      } catch { if (!stop) { setOnline(false); setAgents([]); } }
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
  return { agents, online, chainDegraded };
}

export function runwayDays(a: AgentView): number {
  const h = a.runtime?.lastRunwayH;
  if (h === null || h === undefined) return Number.POSITIVE_INFINITY;
  return h / 24;
}

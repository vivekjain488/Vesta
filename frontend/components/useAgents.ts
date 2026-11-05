"use client";
import { useEffect, useState } from "react";
import { AGENTS, deployment, getJson, readAgent, type AgentRuntime, type OnChainAgent } from "@/lib/data";

export interface AgentView {
  name: string;
  strategy: string;
  riskTier: string;
  chain: OnChainAgent | null;
  runtime: (AgentRuntime & { lastLedgerOg?: number; lastRunwayH?: number | null }) | null;
}

/** Polls RiskGate/vault on-chain + the agent's published runtime state. */
export function useAgents(intervalMs = 8000) {
  const [agents, setAgents] = useState<AgentView[]>(AGENTS.map((a) => ({ ...a, chain: null, runtime: null })));
  const [online, setOnline] = useState<boolean | null>(null);
  useEffect(() => {
    let stop = false;
    const load = async () => {
      const dep = await deployment();
      setOnline(!!dep);
      const rows = await Promise.all(
        AGENTS.map(async (a) => ({
          ...a,
          chain: dep ? await readAgent(dep, a.name) : null,
          runtime: await getJson<any>(`/v1/state/${a.name}`),
        })),
      );
      if (!stop) setAgents(rows);
    };
    load();
    const t = setInterval(load, intervalMs);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [intervalMs]);
  return { agents, online };
}

export function runwayDays(a: AgentView): number {
  const h = a.runtime?.lastRunwayH;
  if (h === null || h === undefined) return Number.POSITIVE_INFINITY;
  return h / 24;
}

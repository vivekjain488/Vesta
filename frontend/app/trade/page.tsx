"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AgentTradeHistory } from "@/components/AgentTradeHistory";
import { CopyPanel } from "@/components/CopyPanel";
import { PageHeader } from "@/components/ui-perpetua";
import { apiFetch } from "@/lib/api";

export default function TradingPage() {
  const [agents, setAgents] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [paper, setPaper] = useState<any>(null);
  useEffect(() => {
    let active = true;
    async function load() {
      const results = await Promise.allSettled([apiFetch("/v1/leaderboard"), apiFetch("/v1/paper-leaderboard")]);
      const names: string[] = []; let successful = false;
      for (const result of results) {
        if (result.status !== "fulfilled" || !result.value.ok) continue;
        try {
          const data = await result.value.json(); successful = true;
          if (!Array.isArray(data) && data?.rows) setPaper(data);
          const rows = Array.isArray(data) ? data : data?.rows;
          if (Array.isArray(rows)) for (const row of rows) if (typeof row.name === "string") names.push(row.name);
        } catch { /* The other leaderboard may still be available. */ }
      }
      if (!active) return;
      setAgents([...new Set(names)]);
      setError(successful ? "" : "Agent list could not be loaded. Check that the API is running, then refresh.");
    }
    void load(); return () => { active = false; };
  }, []);
  return <div className="w-full max-w-5xl space-y-6 pt-4 lg:pt-6">
    <PageHeader eyebrow="Powered by Definitive Flash" title="Trading" description="Review an agent’s market history, then prepare a Flash limit order from your own wallet." />
    {error && <p role="alert" className="rounded-xl bg-trade-soft p-4 text-sm">{error}</p>}
    <CopyPanel agents={agents} />
    <AgentTradeHistory agents={agents} paper={paper} />
    {!error && agents.length === 0 && <p className="text-sm text-muted-foreground">No agents are available to select yet. Explore the <Link href="/leaderboard" className="underline">leaderboard</Link> for available agents.</p>}
  </div>;
}

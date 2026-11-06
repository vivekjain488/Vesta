"use client";
import { use } from "react";
import Link from "next/link";
import { Funding } from "@/components/Funding";
import { Investments } from "@/components/Investments";
import { TransactionHistory } from "@/components/TransactionHistory";
import { useAgents } from "@/components/useAgents";
import { fmt } from "@/lib/data";
export default function AgentPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params); const { agents, online } = useAgents(5000); const a = agents.find((a) => a.id === name);
  if (!a) return <p className="pt-12 text-dim">{online === null ? "Loading agent…" : "Agent not found in your account."}</p>;
  return <div className="pt-12"><Link href="/" className="text-sm text-dim">← Dashboard</Link><div className="mt-5 flex items-end justify-between gap-4"><div><h1 className="font-display text-5xl">{a.name}</h1><p className="mt-3 text-paper/70">{a.strategy}</p></div><span className="text-sm capitalize text-dim">{a.status?.replaceAll("_", " ")}</span></div><div className="my-7 grid grid-cols-2 gap-4"><div className="border border-line bg-panel p-4"><p className="text-xs text-dim">Current capital</p><p className="num mt-2 text-2xl">${fmt(a.chain?.V ?? 0)}</p></div><div className="border border-line bg-panel p-4"><p className="text-xs text-dim">Cumulative profit</p><p className={`num mt-2 text-2xl ${(a.profit ?? 0) < 0 ? "text-exposure" : "text-alive"}`}>{(a.profit ?? 0) >= 0 ? "+" : "−"}${fmt(Math.abs(a.profit ?? 0))}</p></div></div><Funding agent={a.id} /><Investments agent={a.id} /><TransactionHistory agent={a.id} /></div>;
}

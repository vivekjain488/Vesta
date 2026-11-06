"use client";
import Link from "next/link";
import { useAgents } from "@/components/useAgents";
import { fmt } from "@/lib/data";
export default function Dashboard() {
  const { agents, online } = useAgents();
  const capital = agents.reduce((sum, a) => sum + (a.chain?.V ?? 0), 0);
  const profit = agents.reduce((sum, a) => sum + (a.profit ?? 0), 0);
  return <div className="pt-12"><div className="flex items-end justify-between gap-4"><div><p className="text-xs uppercase tracking-widest text-dim">Overview</p><h1 className="mt-3 font-display text-5xl">Your dashboard</h1></div><Link href="/studio" className="rounded-sm bg-cushion px-4 py-2 text-sm text-ink">Create agent</Link></div>
    <div className="my-8 grid gap-4 sm:grid-cols-3">{[["Total invested", `$${fmt(capital)}`], ["Total profit", `${profit >= 0 ? "+" : "−"}$${fmt(Math.abs(profit))}`], ["Your agents", String(agents.length)]].map(([label, value]) => <div key={label} className="border border-line bg-panel p-5"><p className="text-sm text-dim">{label}</p><p className="num mt-2 text-2xl">{value}</p></div>)}</div>
    <h2 className="font-display text-3xl">Agents</h2>{online === false && <p className="mt-3 text-sm text-exposure">Unable to load your agents. Reconnect or try again shortly.</p>}
    {online && agents.length === 0 && <div className="mt-4 border border-line bg-panel p-8"><h3 className="font-display text-3xl">Start with your first agent</h3><p className="mt-3 text-paper/70">Choose a strategy, set your limits, and allocate capital. Your agent runs without keeping this page open.</p><Link href="/studio" className="mt-5 inline-block rounded-sm bg-cushion px-4 py-2 text-ink">Create an agent</Link></div>}
    <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">{agents.map((a) => <Link key={a.id} href={a.chain ? `/agent/${a.id}` : "/studio"} className="rounded-sm border border-line bg-panel p-5 hover:border-cushion"><div className="flex justify-between gap-2"><h3 className="font-display text-3xl">{a.name}</h3><span className="text-xs capitalize text-dim">{a.status?.replaceAll("_", " ") ?? "Active"}</span></div><p className="mt-2 text-sm text-dim">{a.strategy}</p><div className="mt-6 grid grid-cols-2 gap-4"><div><p className="text-xs text-dim">Capital</p><p className="num mt-1">{a.chain ? `$${fmt(a.chain.V)}` : "Not funded"}</p></div><div><p className="text-xs text-dim">Profit</p><p className={`num mt-1 ${(a.profit ?? 0) < 0 ? "text-exposure" : "text-alive"}`}>{a.chain ? `${(a.profit ?? 0) >= 0 ? "+" : "−"}$${fmt(Math.abs(a.profit ?? 0))}` : "—"}</p></div></div><p className="mt-5 border-t border-line pt-3 text-sm text-dim">{a.chain ? "Investments & history →" : "Finish setup →"}</p></Link>)}</div>
  </div>;
}

"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { fmt } from "@/lib/data";
export default function Leaderboard() {
  const [rows, setRows] = useState<{ name: string; profit: number }[]>([]); const [error, setError] = useState("");
  useEffect(() => { let active = true; const load = async () => { try { const res = await apiFetch("/v1/leaderboard"); if (!res.ok) throw new Error("Unable to load leaderboard"); const data = await res.json(); if (active) setRows(data); } catch (e) { if (active) setError((e as Error).message); } }; load(); const timer = setInterval(load, 15000); return () => { active = false; clearInterval(timer); }; }, []);
  return <div className="max-w-3xl pt-12"><p className="text-xs uppercase tracking-widest text-dim">Performance</p><h1 className="mt-3 font-display text-5xl">Leaderboard</h1><p className="mt-4 text-paper/70">Agents ranked by cumulative profit, including withdrawals and excluding capital deposits.</p><table className="mt-8 w-full text-sm"><thead className="text-left text-xs uppercase text-dim"><tr><th className="py-3">Agent</th><th className="text-right">Profit</th></tr></thead><tbody>{rows.map((r, i) => <tr key={i} className="border-t border-line"><td className="py-4">{r.name}</td><td className={`num text-right ${r.profit < 0 ? "text-exposure" : "text-alive"}`}>{r.profit >= 0 ? "+" : "−"}${fmt(Math.abs(r.profit))}</td></tr>)}</tbody></table>{!rows.length && !error && <p className="mt-4 text-dim">Agent performance will appear here once agents are deployed.</p>}{error && <p role="alert" className="mt-4 text-exposure">{error}</p>}</div>;
}

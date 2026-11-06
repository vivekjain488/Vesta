"use client";
import { useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
async function read(path: string) { const response = await fetch(`${API}/registry${path}`, { credentials: "omit", cache: "no-store" }); const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Registry query failed"); return data; }
type Chain = { entityKey: string; chainId: number; name: string; networkType: string; status: string; nativeSymbol: string; rpcCount: number; publicHttpsCount: number; sourcePath: string };
type Rpc = { entityKey: string; endpoint: string; transport: string; requiresKey: boolean; executionEligible: boolean; eligibilityReason: string };
export default function RegistryPage() {
  const [query, setQuery] = useState(""); const [network, setNetwork] = useState(""); const [page, setPage] = useState<any>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [selection, setSelection] = useState<Chain | null>(null);
  const [rpcs, setRpcs] = useState<Rpc[]>([]); const [resolved, setResolved] = useState<any>(null);
  async function search(after?: number, snapshot?: string) {
    setBusy(true); setError("");
    const params = new URLSearchParams({ limit: "25" }); const q = query.trim();
    if (q) params.set(/^\d+$/.test(q) ? "chainId" : "name", q);
    if (network) params.set("network", network);
    if (after !== undefined) params.set("after", String(after)); if (snapshot) params.set("snapshot", snapshot);
    try { setPage(await read(`/chains?${params}`)); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  useEffect(() => { void search(); }, []);
  async function inspect(chain: Chain) {
    setSelection(chain); setRpcs([]); setResolved(null); setError("");
    try { const result = await read(`/rpcs/${chain.chainId}?snapshot=${page.snapshot}`); setRpcs(result.rows); } catch (e) { setError((e as Error).message); }
  }
  return <div className="pt-12">
    <p className="text-xs uppercase tracking-widest text-dim">Public Ethereum infrastructure</p>
    <h1 className="mt-3 font-display text-5xl">Chain & RPC registry</h1>
    <p className="mt-4 max-w-3xl text-paper/70">Chain metadata and RPC endpoints mirrored from ethereum-lists/chains into Arkiv. Every result below is queried from a confirmed Arkiv snapshot.</p>
    {page && <div className="mt-7 flex flex-wrap gap-8 border-y border-line py-5 text-sm"><span><strong className="num text-xl">{page.chainCount.toLocaleString()}</strong> chains</span><span><strong className="num text-xl">{page.rpcCount.toLocaleString()}</strong> RPC endpoints</span><span>License: {page.license}</span><span>Source checked {new Date(page.checkedAtMs).toLocaleString()}</span></div>}
    <form className="mt-7 flex flex-wrap gap-3" onSubmit={(e) => { e.preventDefault(); void search(); }}>
      <input aria-label="Chain ID or name prefix" className="min-w-60 flex-1 border border-line bg-panel px-4 py-3" placeholder="Chain ID or name prefix, e.g. 16602 or Ethereum" value={query} onChange={(e) => setQuery(e.target.value)} />
      <select aria-label="Network type" className="border border-line bg-panel px-4 py-3" value={network} onChange={(e) => setNetwork(e.target.value)}><option value="">All network types</option><option value="mainnet">Mainnet</option><option value="testnet">Testnet</option><option value="unknown">Not declared</option></select>
      <button disabled={busy} className="bg-cushion px-5 py-3 text-ink disabled:opacity-50">{busy ? "Querying Arkiv…" : "Search"}</button>
    </form>
    {error && <p role="alert" className="mt-5 text-exposure">{error}</p>}
    <div className="mt-6 overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-xs uppercase text-dim"><tr><th className="py-3">Chain</th><th>Chain ID</th><th>Network</th><th>Currency</th><th>RPCs</th><th>Public HTTPS</th><th /></tr></thead><tbody>{page?.rows.map((chain: Chain) => <tr key={chain.chainId} className="border-t border-line"><td className="py-4">{chain.name}<span className="ml-2 text-xs text-dim">{chain.status !== "active" ? chain.status : ""}</span></td><td className="num">{chain.chainId}</td><td>{chain.networkType}</td><td>{chain.nativeSymbol}</td><td>{chain.rpcCount}</td><td>{chain.publicHttpsCount}</td><td><button className="text-cushion" onClick={() => void inspect(chain)}>View RPCs</button></td></tr>)}</tbody></table></div>
    {page?.rows.length === 0 && <p className="mt-5 text-dim">No matching chains in this snapshot.</p>}
    {page?.nextAfter !== null && page?.nextAfter !== undefined && <button disabled={busy} className="mt-5 border border-line px-4 py-2" onClick={() => void search(page.nextAfter, page.snapshot)}>Next 25 chains →</button>}
    {selection && <section className="mt-10 border border-line bg-panel p-6"><div className="flex flex-wrap items-center justify-between gap-4"><h2 className="font-display text-3xl">{selection.name} RPCs</h2><button className="border border-line px-4 py-2 text-sm" onClick={async () => { setBusy(true); setError(""); try { setResolved(await read(`/resolve/${selection.chainId}`)); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }} disabled={busy}>Resolve & verify chain ID</button></div>
      {resolved && <div className="mt-5 border border-alive/40 p-4 text-sm"><p className="text-alive">Chain ID {resolved.chainId} verified from an Arkiv-selected RPC</p><p className="mt-2 break-all font-mono">{resolved.endpoint}</p><p className="mt-2 text-dim">Checked {new Date(resolved.checkedAtMs).toLocaleTimeString()}</p></div>}
      <div className="mt-5 overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-xs uppercase text-dim"><tr><th className="py-3">Endpoint</th><th>Transport</th><th>Access</th><th>Discovery</th></tr></thead><tbody>{rpcs.map((rpc) => <tr className="border-t border-line" key={rpc.entityKey}><td className="max-w-xl break-all py-3 pr-4 font-mono text-xs">{rpc.endpoint}</td><td className="pr-4">{rpc.transport}</td><td className="pr-4">{rpc.requiresKey ? "Key required" : "No key declared"}</td><td>{rpc.executionEligible ? "Eligible; not yet health-checked" : rpc.eligibilityReason.replaceAll("_", " ")}</td></tr>)}</tbody></table></div>
      <a className="mt-5 inline-block text-sm text-cushion" target="_blank" rel="noreferrer" href={`https://rabdi.explorer.arkiv.network/entity-explorer?q=${encodeURIComponent(`$key = key(${selection.entityKey})`)}`}>Inspect chain entity on Arkiv ↗</a>
    </section>}
    {page && <p className="mt-8 break-all text-xs text-dim">Writer {page.writer} · Snapshot {page.snapshot} · Upstream commit <a className="text-cushion" target="_blank" rel="noreferrer" href={`https://github.com/ethereum-lists/chains/commit/${page.sourceCommit}`}>{page.sourceCommit.slice(0, 12)}</a>. Public API: <a className="text-cushion" href={`${API}/registry/chains`} target="_blank" rel="noreferrer">/registry/chains</a> — no wallet or account required.</p>}
  </div>;
}

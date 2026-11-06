"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowUpRight, Loader2, Network, Search, ShieldCheck } from "lucide-react";
import { RpcMetrics } from "@/components/rpc-metrics";
import { startLiveRpcPolling } from "@/lib/live-rpc-poll";
import { samplesForDisplay, type RpcSample } from "@/lib/rpc-metrics";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AnimatedNumber, scrollToId } from "@/components/motion";
import { EmptyState, ErrorNote, Hash, Micro, PageHeader } from "@/components/ui-perpetua";
import { cn } from "@/lib/utils";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
async function read(path: string) { const response = await fetch(`${API}/registry${path}`, { credentials: "omit", cache: "no-store" }); const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Registry query failed"); return data; }
type Chain = { entityKey: string; chainId: number; name: string; networkType: string; status: string; nativeSymbol: string; rpcCount: number; publicHttpsCount: number; sourcePath: string };
async function checkRpcs(chainId: number, snapshot: string, hashes: string[]) {
  const response = await fetch(`${API}/registry/check/${chainId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ snapshot, hashes }) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Could not check RPCs"); return data;
}
type Rpc = { entityKey: string; endpointHash: string; endpoint: string; transport: string; requiresKey: boolean; executionEligible: boolean; eligibilityReason: string };

const NETWORKS = [["", "All"], ["mainnet", "Mainnet"], ["testnet", "Testnet"], ["unknown", "Not declared"]] as const;
const networkVariant = (t: string) => (t === "mainnet" ? "brand" : t === "testnet" ? "trade" : "muted");
const count = (n: number) => Math.round(n).toLocaleString();

export default function RegistryPage() {
  const [query, setQuery] = useState(""); const [network, setNetwork] = useState(""); const [page, setPage] = useState<any>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [selection, setSelection] = useState<Chain | null>(null);
  const [rpcs, setRpcs] = useState<Rpc[]>([]); const [selectedSnapshot, setSelectedSnapshot] = useState("");
  const [liveSamples, setLiveSamples] = useState<Record<string, RpcSample[]>>({}); const [liveStatus, setLiveStatus] = useState("Waiting for samples"); const [graphWindow, setGraphWindow] = useState<"30m" | "24h">("30m");
  const [selectedRpcs, setSelectedRpcs] = useState<string[]>([]); const [checks, setChecks] = useState<Record<string, any>>({}); const [checking, setChecking] = useState<string[]>([]); const activeChain = useRef<number | null>(null); const generation = useRef(0);
  const [health, setHealth] = useState<Record<string, any>>({}); const [healthUnavailable, setHealthUnavailable] = useState(false); const [rpcAfter, setRpcAfter] = useState<number | null>(null); const [rpcLoading, setRpcLoading] = useState(false);
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
    activeChain.current = chain.chainId; const epoch = ++generation.current; setSelection(chain); setRpcs([]); setSelectedSnapshot(""); setLiveSamples({}); setLiveStatus("Waiting for samples"); setSelectedRpcs([]); setChecks({}); setChecking([]); setHealth({}); setHealthUnavailable(false); setRpcAfter(null); setError(""); setRpcLoading(true);
    requestAnimationFrame(() => scrollToId("registry-rpcs", 24));
    try {
      const [result, metrics] = await Promise.all([read(`/rpcs/${chain.chainId}?snapshot=${page.snapshot}`), read(`/health/${chain.chainId}`).catch(() => null)]);
      if (activeChain.current === chain.chainId && generation.current === epoch) {
        setRpcs(result.rows); setSelectedSnapshot(result.snapshot); setRpcAfter(result.nextAfter); setHealth(metrics?.entries ?? {}); setHealthUnavailable(!metrics);
        void autoCheck(chain.chainId, result.snapshot, result.rows, metrics?.entries ?? {}, epoch);
      }
    } catch (e) { if (generation.current === epoch) setError((e as Error).message); } finally { if (generation.current === epoch) setRpcLoading(false); }
  }
  async function moreRpcs() {
    if (!selection || rpcAfter === null) return;
    setRpcLoading(true);
    try { const chainId = selection.chainId, epoch = generation.current; const result = await read(`/rpcs/${chainId}?snapshot=${selectedSnapshot}&after=${rpcAfter}`); if (generation.current === epoch) { setRpcs((current) => [...current, ...result.rows]); setRpcAfter(result.nextAfter); void autoCheck(chainId, result.snapshot, result.rows, health, epoch); } }
    catch (e) { setError((e as Error).message); } finally { setRpcLoading(false); }
  }
  useEffect(() => {
    if (!selection) return;
    const chainId = selection.chainId;
    const timer = setInterval(() => { void read(`/health/${chainId}`).then((result) => { if (activeChain.current === chainId) { setHealth(result.entries); setHealthUnavailable(false); } }).catch(() => { if (activeChain.current === chainId) setHealthUnavailable(true); }); }, 30_000);
    return () => clearInterval(timer);
  }, [selection]);
  function recordResults(results: Record<string, any>, epoch: number) {
    if (generation.current !== epoch) return;
    setChecks((current) => {
      const next = { ...current };
      for (const [hash, result] of Object.entries(results)) next[hash] = result.sample ? result : { ...current[hash], ...result };
      return next;
    });
    setLiveSamples((current) => {
      const next = { ...current };
      for (const [hash, result] of Object.entries(results)) if (result.sample) next[hash] = samplesForDisplay(current[hash], result.sample).slice(-1440);
      return next;
    });
  }
  async function autoCheck(chainId: number, snapshot: string, rows: Rpc[], metrics: Record<string, any>, epoch: number) {
    const hashes = rows.filter((rpc) => rpc.executionEligible && !rpc.requiresKey && (!metrics[`${chainId}:${rpc.endpointHash}`]?.latest || Date.now() - metrics[`${chainId}:${rpc.endpointHash}`].latest.at > 60_000)).map((rpc) => rpc.endpointHash);
    if (!hashes.length) return;
    setChecking((current) => [...new Set([...current, ...hashes])]);
    for (let i = 0; i < hashes.length && generation.current === epoch; i += 10) {
      const batch = hashes.slice(i, i + 10);
      try {
        const result = await checkRpcs(chainId, snapshot, batch);
        recordResults(result.results, epoch);
      } catch {
        if (generation.current === epoch) setChecks((current) => ({ ...current, ...Object.fromEntries(batch.map((hash) => [hash, { message: "Check unavailable; retry using Check selected" }])) }));
      } finally { if (generation.current === epoch) setChecking((current) => current.filter((hash) => !batch.includes(hash))); }
    }
  }
  async function runChecks(hashes: string[]) {
    if (!selection || !page || !hashes.length) return;
    const chainId = selection.chainId, epoch = generation.current; setError(""); setChecking((current) => [...new Set([...current, ...hashes])]);
    try {
      const data = await checkRpcs(chainId, selectedSnapshot, hashes);
      recordResults(data.results, epoch);
    } catch (e) { if (generation.current === epoch) setError((e as Error).message); }
    finally { if (generation.current === epoch) setChecking((current) => current.filter((hash) => !hashes.includes(hash))); }
  }
  useEffect(() => {
    if (!selection || !selectedSnapshot || !rpcs.length) return;
    const chainId = selection.chainId, epoch = generation.current;
    const hashes = rpcs.filter((rpc) => rpc.executionEligible && !rpc.requiresKey).map((rpc) => rpc.endpointHash);
    if (!hashes.length) { setLiveStatus("No eligible public HTTPS RPCs"); return; }
    let cancelled = false;
    const visible = () => document.visibilityState === "visible";
    setLiveStatus(visible() ? "Live · checks about every minute" : "Live checks paused in background");
    const poller = startLiveRpcPolling(async () => {
      if (cancelled || generation.current !== epoch || !visible()) return;
      setLiveStatus("Refreshing RPC checks…");
      let failed = false;
      for (let i = 0; i < hashes.length && !cancelled && generation.current === epoch && visible(); i += 10) {
        try { const data = await checkRpcs(chainId, selectedSnapshot, hashes.slice(i, i + 10)); if (!cancelled) recordResults(data.results, epoch); }
        catch { failed = true; }
      }
      if (!cancelled && generation.current === epoch) setLiveStatus(!visible() ? "Live checks paused in background" : failed ? "Some checks unavailable · retrying automatically" : "Live · checks about every minute");
    }, visible);
    const onVisibility = () => { if (!visible()) setLiveStatus("Live checks paused in background"); else { setLiveStatus("Live · refreshing…"); poller.wake(); } };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { cancelled = true; poller.stop(); document.removeEventListener("visibilitychange", onVisibility); };
  }, [selection, selectedSnapshot, rpcs]);
  function selectRpc(hash: string, checked: boolean) {
    setSelectedRpcs((current) => checked ? current.length < 10 ? [...current, hash] : current : current.filter((item) => item !== hash));
  }

  return (
    <div className="space-y-6 pt-4 lg:pt-6">
      <PageHeader eyebrow="Public Ethereum infrastructure" title="Chain & RPC registry" description="Chain metadata and RPC endpoints come from Arkiv. Our monitor samples eligible public HTTPS endpoints from this host; results are observations, not provider guarantees." />

      {/* Snapshot stats */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {!page ? (
          [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[104px] rounded-[28px]" />)
        ) : (
          <>
            <Card size="sm"><CardContent><Micro>Chains</Micro><p className="num mt-2 text-3xl font-semibold tracking-tight"><AnimatedNumber value={page.chainCount} format={count} /></p></CardContent></Card>
            <Card size="sm"><CardContent><Micro>RPC endpoints</Micro><p className="num mt-2 text-3xl font-semibold tracking-tight"><AnimatedNumber value={page.rpcCount} format={count} /></p></CardContent></Card>
            <Card size="sm"><CardContent><Micro>License</Micro><p className="mt-2 truncate text-xl font-semibold tracking-tight">{page.license}</p></CardContent></Card>
            <Card size="sm"><CardContent><Micro>Source checked</Micro><p className="num mt-2 text-xl font-semibold tracking-tight">{new Date(page.checkedAtMs).toLocaleDateString()}</p><p className="num text-xs text-muted-foreground">{new Date(page.checkedAtMs).toLocaleTimeString()}</p></CardContent></Card>
          </>
        )}
      </div>

      {/* Search */}
      <Card>
        <CardContent className="space-y-3">
          <form className="flex items-center gap-2 rounded-[22px] bg-muted p-2 pl-4" onSubmit={(e) => { e.preventDefault(); void search(); }}>
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input aria-label="Chain ID or name prefix" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint" placeholder="Chain ID or name prefix, e.g. 16602 or Ethereum" value={query} onChange={(e) => setQuery(e.target.value)} />
            <Button type="submit" disabled={busy}>{busy ? <><Loader2 className="animate-spin" /> Querying Arkiv…</> : <>Search <ArrowRight /></>}</Button>
          </form>
          <div className="flex flex-wrap items-center gap-2">
            <Micro>Network</Micro>
            <ToggleGroup type="single" size="sm" spacing={1} value={network || "all"} onValueChange={(v) => v && setNetwork(v === "all" ? "" : v)} className="rounded-full bg-muted p-1" aria-label="Network type">
              {NETWORKS.map(([v, label]) => <ToggleGroupItem key={label} value={v || "all"}>{label}</ToggleGroupItem>)}
            </ToggleGroup>
            <span className="text-xs text-faint">Applies on the next search</span>
          </div>
        </CardContent>
      </Card>

      {error && <ErrorNote>{error}</ErrorNote>}

      {/* Results */}
      <Card>
        <CardHeader>
          <CardTitle>Chains</CardTitle>
          <CardDescription>{page ? `${page.rows.length} shown from snapshot` : "Loading snapshot…"}</CardDescription>
          {page && <CardAction><Hash value={page.snapshot} head={8} tail={6} /></CardAction>}
        </CardHeader>
        <CardContent>
          {!page ? (
            <div className="space-y-2">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-12 rounded-2xl" />)}</div>
          ) : page.rows.length === 0 ? (
            <EmptyState title="No matching chains in this snapshot." icon={<Network className="size-4" />}>Try a chain ID like 1 or a name prefix like &quot;Base&quot;.</EmptyState>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Chain</TableHead>
                  <TableHead>Chain ID</TableHead>
                  <TableHead>Network</TableHead>
                  <TableHead>Currency</TableHead>
                  <TableHead className="text-right">RPCs</TableHead>
                  <TableHead className="text-right">Public HTTPS</TableHead>
                  <TableHead className="text-right"><span className="sr-only">Action</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.rows.map((chain: Chain) => (
                  <TableRow key={chain.chainId} data-state={selection?.chainId === chain.chainId ? "selected" : undefined}>
                    <TableCell className="font-medium">
                      {chain.name}
                      {chain.status !== "active" && <Badge variant="muted" size="micro" className="ml-2">{chain.status}</Badge>}
                    </TableCell>
                    <TableCell className="num font-mono text-xs">{chain.chainId}</TableCell>
                    <TableCell><Badge variant={networkVariant(chain.networkType)} className="capitalize">{chain.networkType}</Badge></TableCell>
                    <TableCell className="text-muted-foreground">{chain.nativeSymbol}</TableCell>
                    <TableCell className="num text-right">{chain.rpcCount}</TableCell>
                    <TableCell className="num text-right">{chain.publicHttpsCount}</TableCell>
                    <TableCell className="text-right"><Button variant={selection?.chainId === chain.chainId ? "default" : "soft"} size="sm" onClick={() => void inspect(chain)}>View RPCs</Button></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {page?.nextAfter !== null && page?.nextAfter !== undefined && (
            <div className="mt-4 flex justify-end">
              <Button variant="outline" disabled={busy} onClick={() => void search(page.nextAfter, page.snapshot)}>Next 25 chains <ArrowRight /></Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Selected chain RPCs */}
      {selection && (
        <Card id="registry-rpcs" className="scroll-mt-6">
          <CardHeader>
            <CardTitle>{selection.name} RPCs</CardTitle>
            <CardDescription>
              Chain ID <span className="num font-mono">{selection.chainId}</span> · {selection.nativeSymbol} · <span className="capitalize">{selection.networkType}</span>
            </CardDescription>
            <CardAction>
              <Button onClick={() => void runChecks(selectedRpcs)} disabled={!selectedRpcs.length || selectedRpcs.some((hash) => checking.includes(hash))}>
                {selectedRpcs.some((hash) => checking.includes(hash)) ? <Loader2 className="animate-spin" /> : <ShieldCheck />} Check selected ({selectedRpcs.length}/10)
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-4">
            {selection.chainId === 5 && <p className="rounded-xl bg-muted p-3 text-sm text-muted-foreground">Goerli is an older testnet whose core-team support ended; many listed endpoints may no longer work. <a className="underline" href="https://blog.ethereum.org/2023/11/30/goerli-lts-update" target="_blank" rel="noreferrer">Ethereum Foundation update</a>.</p>}
            <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground"><span aria-live="polite" className="font-medium text-foreground">{liveStatus}</span> · Checks run while this tab is visible; many endpoints may take longer per cycle.</p><ToggleGroup type="single" size="sm" value={graphWindow} onValueChange={(v) => { if (v === "30m" || v === "24h") setGraphWindow(v); }} aria-label="Graph time range"><ToggleGroupItem value="30m">30 min</ToggleGroupItem><ToggleGroupItem value="24h">24 hours</ToggleGroupItem></ToggleGroup></div>
            <p className="text-xs text-muted-foreground">Availability is the share of successful observed checks, not continuous uptime. The graph uses a rolling one-hour sample; gaps mean no data. Select up to 10 RPCs to check again.</p>
            {rpcLoading && rpcs.length === 0 ? (
              <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-11 rounded-2xl" />)}</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Select</TableHead>
                    <TableHead>Endpoint</TableHead>
                    <TableHead>Transport</TableHead>
                    <TableHead>Access</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>HTTP</TableHead>
                    <TableHead>Latency</TableHead>
                    <TableHead>Availability (24h)</TableHead>
                    <TableHead>Live graphs</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rpcs.map((rpc) => {
                    const m = health[`${selection.chainId}:${rpc.endpointHash}`], check = checks[rpc.endpointHash];
                    const sample = check?.sample && (!m?.latest || check.sample.at >= m.latest.at) ? check.sample : m?.latest;
                    const samples = samplesForDisplay([...(m?.samples ?? []), ...(liveSamples[rpc.endpointHash] ?? [])], check?.sample);
                    const successes = samples.filter((item) => item.ok).length;
                    const availability = samples.length ? Math.round(successes * 10000 / samples.length) / 100 : null;
                    const status = checking.includes(rpc.endpointHash) ? "Checking…" : check?.message ?? (sample ? sample.httpStatus === 401 ? "Authentication required" : sample.httpStatus === 403 ? "Access denied" : sample.outcome.replaceAll("_", " ") : rpc.requiresKey || rpc.eligibilityReason === "credentials_in_url" ? "Key required" : !rpc.executionEligible ? rpc.eligibilityReason.replaceAll("_", " ") : healthUnavailable ? "Health data unavailable" : "No sample yet");
                    return <TableRow key={rpc.entityKey}>
                      <TableCell><input type="checkbox" aria-label={`Select ${rpc.endpoint}`} checked={selectedRpcs.includes(rpc.endpointHash)} disabled={!selectedRpcs.includes(rpc.endpointHash) && selectedRpcs.length >= 10} onChange={(event) => selectRpc(rpc.endpointHash, event.target.checked)} /></TableCell>
                      <TableCell className="max-w-sm min-w-48 font-mono text-xs break-all whitespace-normal">{rpc.endpoint}</TableCell>
                      <TableCell><Badge variant="secondary" size="micro">{rpc.transport}</Badge></TableCell>
                      <TableCell><Badge variant={rpc.requiresKey || rpc.eligibilityReason === "credentials_in_url" ? "trade" : "secondary"}>{rpc.requiresKey || rpc.eligibilityReason === "credentials_in_url" ? "Key required" : sample?.httpStatus === 401 ? "Authentication required" : sample?.httpStatus === 403 ? "Access denied" : "No key declared"}</Badge></TableCell>
                      <TableCell className={cn("min-w-36 text-sm whitespace-normal", sample?.ok ? "text-profit" : "text-muted-foreground")}><span>{status}</span>{sample && <p className="mt-1 text-xs text-muted-foreground">{new Date(sample.at).toLocaleString()}{!check?.sample && m?.stale ? " · stale" : ""}</p>}</TableCell>
                      <TableCell className="font-mono text-xs">{sample?.httpStatus ?? "—"}</TableCell>
                      <TableCell className="text-xs">{sample ? `${sample.latencyMs} ms${sample.ok ? "" : " (failed)"}` : "—"}</TableCell>
                      <TableCell className="min-w-32 text-xs">{availability === null ? "No samples" : <>{availability}%<p className="mt-1 text-muted-foreground">{successes}/{samples.length} checks</p></>}</TableCell>
                      <TableCell><RpcMetrics samples={samples} now={Date.now()} windowMs={graphWindow === "30m" ? 30 * 60_000 : 24 * 3600_000} /></TableCell>
                    </TableRow>;
                  })}
                </TableBody>
              </Table>
            )}
            <div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => setSelectedRpcs(rpcs.filter((rpc) => rpc.executionEligible).slice(0, 10).map((rpc) => rpc.endpointHash))} disabled={!rpcs.some((rpc) => rpc.executionEligible)}>Select eligible (up to 10)</Button><Button variant="ghost" size="sm" onClick={() => setSelectedRpcs([])} disabled={!selectedRpcs.length}>Clear selection</Button></div>
            {rpcAfter !== null && <Button variant="outline" disabled={rpcLoading} onClick={() => void moreRpcs()}>Load more RPCs</Button>}
            {!rpcLoading && rpcs.length === 0 && <p className="text-sm text-muted-foreground">No RPCs listed for this chain.</p>}
            <Button asChild variant="link" className="px-0">
              <a target="_blank" rel="noreferrer" href={`https://rabdi.explorer.arkiv.network/entity-explorer?q=${encodeURIComponent(`$key = key(${selection.entityKey})`)}`}>Inspect chain entity on Arkiv <ArrowUpRight /></a>
            </Button>
          </CardContent>
        </Card>
      )}

      {page && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          Writer <Hash value={page.writer} /> · Snapshot <Hash value={page.snapshot} head={10} tail={6} /> · Upstream commit{" "}
          <a className="font-mono text-foreground underline-offset-4 hover:underline" target="_blank" rel="noreferrer" href={`https://github.com/ethereum-lists/chains/commit/${page.sourceCommit}`}>{page.sourceCommit.slice(0, 12)}</a>
          · Public API: <a className="font-mono text-foreground underline-offset-4 hover:underline" href={`${API}/registry/chains`} target="_blank" rel="noreferrer">/registry/chains</a> (no wallet or account required)
        </p>
      )}
    </div>
  );
}

"use client";
import { useEffect, useState } from "react";
import { ArrowRight, ArrowUpRight, Check, Loader2, Network, Search, ShieldCheck } from "lucide-react";
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
type Rpc = { entityKey: string; endpoint: string; transport: string; requiresKey: boolean; executionEligible: boolean; eligibilityReason: string };

const NETWORKS = [["", "All"], ["mainnet", "Mainnet"], ["testnet", "Testnet"], ["unknown", "Not declared"]] as const;
const networkVariant = (t: string) => (t === "mainnet" ? "brand" : t === "testnet" ? "trade" : "muted");
const count = (n: number) => Math.round(n).toLocaleString();

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
    requestAnimationFrame(() => scrollToId("registry-rpcs", 24));
    try { const result = await read(`/rpcs/${chain.chainId}?snapshot=${page.snapshot}`); setRpcs(result.rows); } catch (e) { setError((e as Error).message); }
  }
  async function resolve() {
    if (!selection) return;
    setBusy(true); setError("");
    try { setResolved(await read(`/resolve/${selection.chainId}`)); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-6 pt-4 lg:pt-6">
      <PageHeader eyebrow="Public Ethereum infrastructure" title="Chain & RPC registry" description="Chain metadata and RPC endpoints mirrored from ethereum-lists/chains into Arkiv. Every result below is queried from a confirmed Arkiv snapshot." />

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
              <Button onClick={() => void resolve()} disabled={busy}>
                {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />} Resolve & verify chain ID
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-4">
            {resolved && (
              <div className="pop-in rounded-2xl bg-profit/8 p-4 ring-1 ring-profit/25">
                <p className="flex items-center gap-2 text-sm font-medium text-profit"><Check className="size-4" /> Chain ID {resolved.chainId} verified from an Arkiv-selected RPC</p>
                <p className="mt-2 font-mono text-xs break-all">{resolved.endpoint}</p>
                <p className="mt-1 text-xs text-muted-foreground">Checked {new Date(resolved.checkedAtMs).toLocaleTimeString()}</p>
              </div>
            )}
            {rpcs.length === 0 ? (
              <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-11 rounded-2xl" />)}</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Endpoint</TableHead>
                    <TableHead>Transport</TableHead>
                    <TableHead>Access</TableHead>
                    <TableHead>Discovery</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rpcs.map((rpc) => (
                    <TableRow key={rpc.entityKey}>
                      <TableCell className="max-w-xl font-mono text-xs break-all whitespace-normal">{rpc.endpoint}</TableCell>
                      <TableCell><Badge variant="secondary" size="micro">{rpc.transport}</Badge></TableCell>
                      <TableCell><Badge variant={rpc.requiresKey ? "trade" : "secondary"}>{rpc.requiresKey ? "Key required" : "No key declared"}</Badge></TableCell>
                      <TableCell className={cn("text-sm", rpc.executionEligible ? "text-profit" : "text-muted-foreground")}>
                        {rpc.executionEligible ? "Eligible; not yet health-checked" : rpc.eligibilityReason.replaceAll("_", " ")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
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

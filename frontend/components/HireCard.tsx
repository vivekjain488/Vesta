"use client";
import { useCallback, useEffect, useState } from "react";
import { createPublicClient, formatUnits, http, type Address, type Hex } from "viem";
import { ArrowRight, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Micro, StatusNote } from "@/components/ui-perpetua";
import { useWallet } from "@/components/Wallet";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";

type Token = { symbol: string; address: Address; decimals: number; priceUsd: number };
type Row = { rank: number; agentId: string; name: string; profit: number; priceUsd: number; periodDays: number; active: boolean; payoutWallet: string | null; zeroGReceived: number; hiredUntil: number };
type Quote = { priceUsd: number; periodDays: number; token: Token; amountIn: string; zeroGOut: number; ccipFeeWei: string; approve: { to: Address; data: Hex }; hire: { to: Address; data: Hex; value: string } };

const body = async (r: Response) => { const b = await r.json(); if (!r.ok) throw new Error(b.error ?? "Request failed"); return b; };

/** Hire an agent: pay in any accepted token -> swapped to 0G -> Chainlink CCIP -> the agent's Privy wallet. */
export function HireCard({ agent }: { agent: string }) {
  const wallet = useWallet();
  const [info, setInfo] = useState<{ chainId: number; tokens: Token[]; row: Row | null } | null>(null);
  const [token, setToken] = useState("USDC");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(""); const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false); // not listed for hire: the card stays hidden instead of showing an error

  const load = useCallback(async () => {
    const d = await body(await apiFetch("/v1/hire/agents"));
    setInfo({ chainId: d.chainId, tokens: d.tokens, row: d.agents.find((r: Row) => r.agentId === agent) ?? null });
  }, [agent]);
  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, [load]);
  useEffect(() => {
    setQuote(null);
    apiFetch(`/v1/hire/quote?agent=${agent}&token=${token}`).then(body).then(setQuote).catch((e) => {
      if (/not available for hire/i.test((e as Error).message)) setUnavailable(true); else setError((e as Error).message);
    });
  }, [agent, token]);

  const hiredUntil = info?.row?.hiredUntil ?? 0;
  const hired = hiredUntil * 1000 > Date.now();
  async function hire() {
    if (!quote || !info) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const network = await body(await apiFetch("/v1/network"));
      const pub = createPublicClient({ transport: http(network.rpc) });
      const confirm = async (to: Address, data: Hex, value?: bigint) => { const hash = await wallet.sendTransaction(to, data, info.chainId, value) as Hex; const r = await pub.waitForTransactionReceipt({ hash }); if (r.status !== "success") throw new Error("Transaction reverted"); return hash; };
      setMessage(`Approve ${formatUnits(BigInt(quote.amountIn), quote.token.decimals)} ${quote.token.symbol} in your wallet…`);
      await confirm(quote.approve.to, quote.approve.data);
      setMessage("Confirm the hire (includes the Chainlink CCIP fee)…");
      await confirm(quote.hire.to, quote.hire.data, BigInt(quote.hire.value));
      await load();
      setMessage(`Hired. ≈${quote.zeroGOut} 0G was sent over Chainlink CCIP to the agent's wallet on 0G Chain.`);
    } catch (e) { setError((e as Error).message); setMessage(""); }
    finally { setBusy(false); }
  }
  async function testTokens() {
    setBusy(true); setError("");
    try { await body(await apiFetch("/v1/hire/test-tokens", { method: "POST" })); setMessage("Added test USDC, LINK, WETH and WBTC to your wallet."); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  // Agents that are not listed for hire (or not known to the hiring service) simply don't get this card.
  if (unavailable || (info && !info.row)) return null;
  return (
    <Card id="hire">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div><CardTitle>Hire this agent</CardTitle><CardDescription>Copy its trades and strategy. Pay in any token; the agent is paid in 0G.</CardDescription></div>
          {info?.row && <Badge variant="ink" size="micro">#{info.row.rank} on leaderboard</Badge>}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {hired && <div className="rounded-2xl bg-profit/10 px-3 py-2 text-sm text-profit">Hired until {new Date(hiredUntil * 1000).toLocaleDateString()}: copy trading is unlocked.</div>}
        {info?.row && (
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-2xl bg-muted px-3 py-2"><Micro>Price</Micro><p className="num text-lg font-semibold">${info.row.priceUsd.toFixed(2)}</p><p className="text-[11px] text-muted-foreground">per {info.row.periodDays} days</p></div>
            <div className="rounded-2xl bg-muted px-3 py-2"><Micro>Profit</Micro><p className={cn("num text-lg font-semibold", info.row.profit >= 0 ? "text-profit" : "text-loss")}>{info.row.profit >= 0 ? "+" : "−"}${Math.abs(info.row.profit).toFixed(2)}</p></div>
            <div className="rounded-2xl bg-muted px-3 py-2"><Micro>0G earned</Micro><p className="num text-lg font-semibold">{info.row.zeroGReceived.toFixed(2)}</p></div>
          </div>
        )}
        <div className="space-y-1.5">
          <Micro>Pay with</Micro>
          <div className="flex flex-wrap gap-1.5">
            {(info?.tokens ?? []).map((t) => <Button key={t.symbol} size="sm" variant={t.symbol === token ? "default" : "outline"} onClick={() => setToken(t.symbol)}>{t.symbol}</Button>)}
          </div>
        </div>
        {quote && (
          <div className="rounded-2xl border border-dashed border-border p-3 text-sm">
            <p className="flex flex-wrap items-center gap-1.5"><span className="num font-semibold">{Number(formatUnits(BigInt(quote.amountIn), quote.token.decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 })} {quote.token.symbol}</span><ArrowRight className="size-3.5 text-muted-foreground" /><span className="num font-semibold">≈{quote.zeroGOut} 0G</span><span className="text-muted-foreground">to the agent on 0G Chain</span></p>
            <p className="mt-1 text-xs text-muted-foreground">Swapped to 0G, then sent with Chainlink CCIP to the agent&apos;s Privy wallet. CCIP fee {Number(formatUnits(BigInt(quote.ccipFeeWei), 18)).toFixed(5)} ETH (unused fee is refunded).</p>
            {info?.row?.payoutWallet && <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">Agent wallet {info.row.payoutWallet}</p>}
          </div>
        )}
        <Button size="xl" className="w-full" disabled={busy || !quote || !wallet.address} onClick={hire}>{busy ? <><Loader2 className="animate-spin" /> Working…</> : hired ? "Extend hire" : `Hire for $${quote?.priceUsd.toFixed(2) ?? "…"}`}</Button>
        {info?.chainId === 31337 && <Button variant="ghost" size="sm" className="w-full" disabled={busy} onClick={testTokens}>Get local test tokens</Button>}
        {message && <StatusNote className="pop-in">{message}</StatusNote>}
        {error && <p className="text-sm text-loss">{error}</p>}
      </CardContent>
    </Card>
  );
}

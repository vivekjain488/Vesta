"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useWallet } from "./Wallet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Config = { enabled: boolean; quoteEnabled: boolean; maxUsd: number };
type Prepared = { id?: string; submissionEnabled: boolean; request: { qty: string; limitNotionalPrice: string }; quote: { fees?: { estimatedFeeNotional?: string }; approvalRequired?: boolean; evm?: { orderTypedData: string; approveTx: { to: string; data: string } | null } } };
type Row = { attemptId: string; orderId?: string; agent: string; request: { qty: string; limitNotionalPrice: string }; flash: any; evidence?: { transactionHash: string; receipt: string; matchedTransfers: boolean; blockNumber?: string }[] };
async function json(res: Response) { const value = await res.json(); if (!res.ok) throw new Error(typeof value.error === "string" ? value.error : "Request failed"); return value; }

/** A follower chooses their own order; leaderboard performance is context, not an automatic copy signal. */
export function CopyPanel({ agents }: { agents: string[] }) {
  const wallet = useWallet();
  const [config, setConfig] = useState<Config | null>(null);
  const [configError, setConfigError] = useState("");
  const [agent, setAgent] = useState("");
  const [amount, setAmount] = useState("5");
  const [price, setPrice] = useState("");
  const [quote, setQuote] = useState<Prepared | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const loadOrders = () => { void apiFetch("/v1/flash/orders").then(json).then(setRows).catch(() => {}); };
  useEffect(() => { void apiFetch("/v1/flash/config").then(json).then(setConfig).catch(() => setConfigError("Unable to reach the Flash service. Check that the current API server is running and refresh.")); loadOrders(); const timer = setInterval(loadOrders, 30000); return () => clearInterval(timer); }, []);
  async function prepare() {
    setBusy(true); setMessage(""); setQuote(null);
    try { setQuote(await json(await apiFetch("/v1/flash/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent, amount, limitPrice: price }) }))); }
    catch (e) { setMessage((e as Error).message); } finally { setBusy(false); }
  }
  async function place() {
    if (!quote?.submissionEnabled || !quote.id || !quote.quote.evm) return;
    setBusy(true); setMessage("");
    try {
      await wallet.switchChain(8453);
      if (quote.quote.evm.approveTx) {
        setMessage("Approve the exact USDC amount in your wallet, then wait for confirmation.");
        const { to, data } = quote.quote.evm.approveTx;
        const hash = await wallet.sendTransaction(to, data, 8453);
        setMessage(`Approval submitted: ${hash}. Waiting for confirmation…`);
        await wallet.waitForTransaction(hash);
      }
      setMessage("Sign the Flash order in your wallet.");
      const signature = await wallet.signTypedDataJson(quote.quote.evm.orderTypedData);
      setMessage("Submitting the signed order to Flash…");
      const result = await json(await apiFetch("/v1/flash/order", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: quote.id, signature }) }));
      setQuote(null); setMessage(`Order submitted: ${result.orderId}. A submission is not a fill; watch its status below.`); loadOrders();
    } catch (e) { setQuote(null); setMessage((e as Error).message); } finally { setBusy(false); }
  }
  return <section className="rounded-[28px] border bg-card p-6">
    <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-trade-deep">Definitive Flash · Base</p><h2 className="font-display text-3xl">Place a limit order</h2>
    <p className="mt-2 text-sm text-muted-foreground">Choose an agent for context and set your own WETH limit buy on Base. Definitive Flash executes eligible orders from your wallet. Selecting an agent does not automatically copy its trades.</p>
    {configError && <p role="alert" className="mt-3 text-sm text-trade-deep">{configError}</p>}
    {config && !config.quoteEnabled && <p className="mt-3 text-sm text-muted-foreground">Flash quotes are unavailable until an API key is configured.</p>}
    {config?.quoteEnabled && !config.enabled && <p className="mt-3 text-sm text-muted-foreground">Quote preview is available. Order submission requires a verified Flash settlement address and operator configuration.</p>}
    {!config && !configError && <p className="mt-3 text-sm text-muted-foreground">Checking Flash availability…</p>}
    <div className="mt-4 grid gap-3 sm:grid-cols-3">
      <label className="text-sm">Agent<select className="mt-1 h-10 w-full rounded-md border bg-background px-3" value={agent} onChange={e => { setAgent(e.target.value); setQuote(null); }}><option value="">Choose an agent</option>{agents.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
      <label className="text-sm">Spend USDC<Input className="mt-1" inputMode="decimal" value={amount} onChange={e => { setAmount(e.target.value); setQuote(null); }} /></label>
      <label className="text-sm">Maximum USD per WETH<Input className="mt-1" inputMode="decimal" value={price} onChange={e => { setPrice(e.target.value); setQuote(null); }} placeholder="e.g. 2000" /></label>
    </div>
    <p className="mt-3 text-xs text-muted-foreground">Base mainnet · maximum ${config?.maxUsd ?? 100} per order · requires Base USDC and ETH for gas. Orders can remain unfilled; a stop-loss is not attached.</p>
    {!quote ? <Button className="mt-4" disabled={busy || !config?.quoteEnabled || !agent || !amount || !price} onClick={prepare}>Review Definitive Flash quote</Button> : <div className="mt-4 rounded-xl bg-muted p-4 text-sm"><p>Spend up to {quote.request.qty} USDC at a limit of ${quote.request.limitNotionalPrice} per WETH.</p><p className="mt-1">Estimated Flash fees: ${quote.quote.fees?.estimatedFeeNotional ?? "unavailable"}. {(quote.quote.evm?.approveTx || quote.quote.approvalRequired) ? "A USDC approval transaction is required." : "No new approval transaction requested."}</p>{quote.submissionEnabled ? <Button className="mt-3" disabled={busy} onClick={place}>Approve and submit order</Button> : <p className="mt-2 text-muted-foreground">Preview only. Order submission is disabled until Flash settlement is verified and configured.</p>} <Button className="mt-3" variant="outline" disabled={busy} onClick={() => setQuote(null)}>Cancel</Button></div>}
    {message && <p role="status" className="mt-3 break-all text-sm">{message}</p>}
    {rows.length > 0 && <div className="mt-6"><h3 className="font-semibold">Your Flash orders</h3><ul className="mt-2 space-y-2 text-sm">{rows.map(row => <li key={row.orderId ?? row.attemptId} className="rounded-lg bg-muted p-3"><span>{row.agent} · {row.request.qty} USDC · limit ${row.request.limitNotionalPrice}</span><br /><span className="text-muted-foreground">{row.orderId ? (row.flash?.order?.status ?? row.flash?.status ?? "Status unavailable") : "Submission outcome unknown — check Flash before retrying"} · {row.orderId ?? row.attemptId}</span>{row.evidence?.map(e => <p key={e.transactionHash} className="mt-2 text-xs">{e.matchedTransfers ? "Confirmed on Base: USDC spent and WETH received" : e.receipt === "unavailable" ? "Receipt not yet available" : "Receipt found; matching transfers not confirmed"} · <a className="text-trade-deep underline" target="_blank" rel="noreferrer" href={`https://basescan.org/tx/${e.transactionHash}`}>View transaction on BaseScan</a></p>)}</li>)}</ul></div>}
  </section>;
}

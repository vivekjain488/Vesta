"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useWallet } from "./Wallet";
import { ArrowRight, Fuel, Info, Landmark, ShieldOff, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { ErrorNote, Micro, StatusNote } from "@/components/ui-perpetua";

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
  const maxUsd = config?.maxUsd ?? 100;
  const orderBadge = (row: Row) => {
    const status = String(row.orderId ? (row.flash?.order?.status ?? row.flash?.status ?? "Status unavailable") : "Outcome unknown");
    const variant = /fill|complete|success/i.test(status) ? "profit" : /cancel|fail|reject|expire|unknown/i.test(status) ? "loss" : "secondary";
    return <Badge variant={variant} size="micro">{status}</Badge>;
  };
  return (
    <Card className="gap-0 overflow-hidden py-0" aria-labelledby="limit-order-title">
      <div className="space-y-2 px-6 pt-6">
        <Badge variant="trade" size="micro">Definitive Flash · Base</Badge>
        <h2 id="limit-order-title" className="font-display text-3xl leading-tight tracking-tight">Place a limit order</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">Choose an agent for context and set your own WETH limit buy on Base. Definitive Flash executes eligible orders from your wallet. Selecting an agent does not automatically copy its trades.</p>
      </div>

      <div className="space-y-3 px-6 pt-4">
        {configError && <ErrorNote>{configError}</ErrorNote>}
        {config && !config.quoteEnabled && <p className="flex items-start gap-2 rounded-2xl bg-muted px-4 py-3 text-sm text-muted-foreground"><Info className="mt-0.5 size-4 shrink-0" />Flash quotes are unavailable until an API key is configured.</p>}
        {config?.quoteEnabled && !config.enabled && <p className="flex items-start gap-2 rounded-2xl bg-muted px-4 py-3 text-sm text-muted-foreground"><Info className="mt-0.5 size-4 shrink-0" />Quote preview is available. Order submission requires a verified Flash settlement address and operator configuration.</p>}
        {!config && !configError && <p className="flex items-start gap-2 rounded-2xl bg-muted px-4 py-3 text-sm text-muted-foreground"><Info className="mt-0.5 size-4 shrink-0" />Checking Flash availability…</p>}
      </div>

      <div className="grid gap-4 px-6 pt-5 md:grid-cols-[1.3fr_1fr_1fr]">
        <div className="space-y-1.5">
          <Label htmlFor="flash-agent">Agent</Label>
          <NativeSelect id="flash-agent" value={agent} onChange={(e) => { setAgent(e.target.value); setQuote(null); }}>
            <option value="">Choose an agent</option>
            {agents.map((name) => <option key={name} value={name}>{name}</option>)}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="flash-amount">Spend</Label>
          <div className="relative">
            <Input id="flash-amount" className="num pr-16 text-lg font-semibold" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); setQuote(null); }} />
            <span className="micro pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-muted-foreground">USDC</span>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="flash-price">Maximum USD per WETH</Label>
          <div className="relative">
            <span className="num pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-lg text-muted-foreground">$</span>
            <Input id="flash-price" className="num pl-8 text-lg font-semibold" inputMode="decimal" value={price} onChange={(e) => { setPrice(e.target.value); setQuote(null); }} placeholder="e.g. 2000" />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 px-6 pt-4" aria-label="Order limits">
        <Badge variant="secondary" className="gap-1.5"><Landmark className="size-3" />Base mainnet</Badge>
        <Badge variant="secondary" className="num gap-1.5">Maximum ${maxUsd} per order</Badge>
        <Badge variant="secondary" className="gap-1.5"><Fuel className="size-3" />Requires Base USDC and ETH for gas</Badge>
        <Badge variant="secondary" className="gap-1.5"><ShieldOff className="size-3" />No stop-loss attached</Badge>
      </div>
      <p className="px-6 pt-2 text-xs text-muted-foreground">Orders can remain unfilled; a stop-loss is not attached.</p>

      <div className="px-6 pt-5 pb-6">
        {!quote ? (
          <Button size="xl" className="w-full sm:w-auto" disabled={busy || !config?.quoteEnabled || !agent || !amount || !price} onClick={prepare}>
            Review Definitive Flash quote <ArrowRight />
          </Button>
        ) : (
          <div className="space-y-3 rounded-3xl bg-muted p-5 text-sm">
            <Micro>Quote</Micro>
            <p className="text-base">Spend up to <span className="num font-semibold">{quote.request.qty} USDC</span> at a limit of <span className="num font-semibold">${quote.request.limitNotionalPrice}</span> per WETH.</p>
            <p className="text-muted-foreground">Estimated Flash fees: ${quote.quote.fees?.estimatedFeeNotional ?? "unavailable"}. {(quote.quote.evm?.approveTx || quote.quote.approvalRequired) ? "A USDC approval transaction is required." : "No new approval transaction requested."}</p>
            {!quote.submissionEnabled && <p className="text-muted-foreground">Preview only. Order submission is disabled until Flash settlement is verified and configured.</p>}
            <div className="flex flex-wrap gap-2 pt-1">
              {quote.submissionEnabled && <Button disabled={busy} onClick={place}><Wallet /> Approve and submit order</Button>}
              <Button variant="outline" disabled={busy} onClick={() => setQuote(null)}>Cancel</Button>
            </div>
          </div>
        )}
        {message && <StatusNote className="mt-3 break-all">{message}</StatusNote>}
      </div>

      {rows.length > 0 && (
        <div className="border-t border-border/70 px-6 py-5">
          <h3 className="font-display text-xl leading-tight">Your Flash orders</h3>
          <ul className="mt-3 space-y-2">
            {rows.map((row) => (
              <li key={row.orderId ?? row.attemptId} className="rounded-2xl bg-muted p-4 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{row.agent} · <span className="num">{row.request.qty} USDC</span> · limit <span className="num">${row.request.limitNotionalPrice}</span></span>
                  {orderBadge(row)}
                </div>
                <p className="mt-1.5 break-all text-xs text-muted-foreground">{row.orderId ? (row.flash?.order?.status ?? row.flash?.status ?? "Status unavailable") : "Submission outcome unknown — check Flash before retrying"} · {row.orderId ?? row.attemptId}</p>
                {row.evidence?.map((e) => <p key={e.transactionHash} className="mt-2 text-xs">{e.matchedTransfers ? "Confirmed on Base: USDC spent and WETH received" : e.receipt === "unavailable" ? "Receipt not yet available" : "Receipt found; matching transfers not confirmed"} · <a className="text-brand-hover underline underline-offset-2" target="_blank" rel="noreferrer" href={`https://basescan.org/tx/${e.transactionHash}`}>View transaction on BaseScan</a></p>)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

"use client";
import { apiFetch } from "@/lib/api";
import { useState } from "react";
import { API } from "@/lib/data";
import { useWallet } from "./Wallet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * One-tap copy. The follower sets a size cap; the API builds the SAME order (type, stop, target) for the
 * follower's own wallet via Flash, with the integrator fee paid to the agent. The follower signs it. Funds
 * never touch the agent's vault.
 */
export function CopyPanel({ agent, hasOpenTrade }: { agent: string; hasOpenTrade: boolean }) {
  const w = useWallet();
  const [cap, setCap] = useState(5);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function copy() {
    setBusy(true);
    setStatus(null);
    try {
      const follower = w.address ?? await w.connect();
      if (!follower) throw new Error("Connect a wallet first");
      const q = await (await apiFetch(`${API}/v1/copy/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent, follower, capUsd: cap }) })).json();
      if (q.error) throw new Error(q.error);
      if (q.simulated) {
        const o = await (await apiFetch(`${API}/v1/copy/order`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent, order: { ...q.request, userSignature: "0xsim" } }) })).json();
        setStatus(`Simulated copy placed (API has no Flash key). Order ${o.orderId}`);
        return;
      }
      const td = q.quote?.evm?.orderTypedData;
      if (!td) throw new Error("Flash quote returned no EVM order to sign");
      const userSignature = await w.signTypedDataJson(td);
      const order = { ...q.request, quoteId: q.quote.quoteId, userSignature, evmOrderTypedData: td };
      const r = await (await apiFetch(`${API}/v1/copy/order`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent, order }) })).json();
      setStatus(r.orderId ? `Copied. Flash order ${r.orderId}` : `Flash: ${JSON.stringify(r).slice(0, 160)}`);
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-[28px] bg-trade p-6 text-foreground">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-display text-[2rem] leading-none">Copy {agent}</h2>
        <Badge variant="trade-deep" size="micro">{hasOpenTrade ? "Open trade" : "Idle"}</Badge>
      </div>
      <p className="mt-2 text-sm text-foreground/75">
        Mirror the agent&apos;s current bracket order from your own wallet. You keep custody. The integrator fee goes to {agent}&apos;s treasury and pays for its next thought.
      </p>
      <label className="micro mt-5 block text-foreground/70" htmlFor="cap">
        Your size cap (USDC)
      </label>
      <div className="mt-1.5 flex gap-2">
        <Input id="cap" type="number" min={1} max={100} value={cap} onChange={(e) => setCap(Number(e.target.value))} className="num w-28 bg-white/70 font-semibold hover:bg-white focus-visible:bg-white" />
        <Button onClick={copy} disabled={busy || !hasOpenTrade} variant="white" size="lg" className="micro flex-1 text-xs">
          {busy ? "Working…" : w.address ? "Copy trade" : "Connect & copy"}
        </Button>
      </div>
      {!hasOpenTrade && <p className="mt-2 text-xs text-foreground/70">No open trade to copy right now.</p>}
      {w.address && <p className="mt-2 font-mono text-[11px] break-all text-foreground/60">{w.kind} · {w.address}</p>}
      {status && <p role="status" className="mt-3 rounded-2xl bg-white/60 px-4 py-2.5 text-sm">{status}</p>}
      <p className="mt-3 text-[11px] text-foreground/70">Capped at $100 per copy. Not financial advice. The full track record, losses included, is shown left.</p>
    </section>
  );
}

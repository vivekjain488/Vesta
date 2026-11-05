"use client";
import { useState } from "react";
import { API } from "@/lib/data";
import { useWallet } from "./Wallet";

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
      const q = await (await fetch(`${API}/v1/copy/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent, follower, capUsd: cap }) })).json();
      if (q.error) throw new Error(q.error);
      if (q.simulated) {
        const o = await (await fetch(`${API}/v1/copy/order`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent, order: { ...q.request, userSignature: "0xsim" } }) })).json();
        setStatus(`Simulated copy placed (API has no Flash key). Order ${o.orderId}`);
        return;
      }
      const td = q.quote?.evm?.orderTypedData;
      if (!td) throw new Error("Flash quote returned no EVM order to sign");
      const userSignature = await w.signTypedDataJson(td);
      const order = { ...q.request, quoteId: q.quote.quoteId, userSignature, evmOrderTypedData: td };
      const r = await (await fetch(`${API}/v1/copy/order`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent, order }) })).json();
      setStatus(r.orderId ? `Copied. Flash order ${r.orderId}` : `Flash: ${JSON.stringify(r).slice(0, 160)}`);
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-sm border border-cushion/40 bg-cushion/5 p-5">
      <h2 className="font-display text-3xl">Copy {agent}</h2>
      <p className="mt-1 text-sm text-paper/75">
        Mirror the agent&apos;s current bracket order from your own wallet. You keep custody. The integrator fee goes to {agent}&apos;s treasury and pays for its next thought.
      </p>
      <label className="mt-4 block text-xs uppercase tracking-wider text-dim" htmlFor="cap">
        Your size cap (USDC)
      </label>
      <div className="mt-1 flex gap-2">
        <input id="cap" type="number" min={1} max={100} value={cap} onChange={(e) => setCap(Number(e.target.value))} className="num w-28 rounded-sm border border-line bg-ink px-2 py-1.5" />
        <button onClick={copy} disabled={busy || !hasOpenTrade} className="flex-1 rounded-sm bg-cushion px-3 py-1.5 text-sm font-medium text-ink disabled:opacity-40">
          {busy ? "Working…" : w.address ? "Copy trade" : "Connect & copy"}
        </button>
      </div>
      {!hasOpenTrade && <p className="mt-2 text-xs text-dim">No open trade to copy right now.</p>}
      {w.address && <p className="num mt-2 break-all text-[11px] text-dim">{w.kind} · {w.address}</p>}
      {status && <p className="mt-3 text-sm">{status}</p>}
      <p className="mt-3 text-[11px] text-dim">Capped at $100 per copy. Not financial advice. The full track record, losses included, is shown left.</p>
    </section>
  );
}

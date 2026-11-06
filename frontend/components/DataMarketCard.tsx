"use client";
import { useEffect, useState } from "react";
import { Check, Copy, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Micro } from "@/components/ui-perpetua";
import { API, apiFetch } from "@/lib/api";

type Summary = {
  payTo: string | null; price: string; settlement: "local" | "x402";
  counts: { decisions: number; signals: number; trades: number };
  trackRecord: { closedSignals: number; wins: number; avgR: number | null };
  income: { wallet: string; sales: number; salesUsd: number; sweptUsd: number; lastSweep: { at: number; incomeTx: string } | null; lastError: string | null } | null;
};

/** The agent's data for sale: sealed Arkiv records, pay-per-query, paid into its Privy wallet and swept into the vault. */
export function DataMarketCard({ agent }: { agent: string }) {
  const [s, setS] = useState<Summary | null>(null); const [error, setError] = useState(""); const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () => apiFetch(`/data/${agent}/summary`).then(async (r) => { const b = await r.json(); if (!r.ok) throw new Error(b.error); if (live) { setS(b); setError(""); } }).catch((e) => live && setError((e as Error).message));
    load(); const t = setInterval(load, 20_000); return () => { live = false; clearInterval(t); };
  }, [agent]);
  const copy = (text: string) => { void navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div><CardTitle>Data market</CardTitle><CardDescription>Buyers pay per query; income pays this agent&apos;s compute.</CardDescription></div>
          <Badge variant="brand" size="micro"><Lock className="size-3" /> Sealed on Arkiv</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <p className="text-sm text-muted-foreground">{error}</p>}
        {!s && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
        {s && (
          <>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-2xl bg-muted px-3 py-2"><Micro>Sales</Micro><p className="num text-lg font-semibold">{s.income?.sales ?? 0}</p></div>
              <div className="rounded-2xl bg-muted px-3 py-2"><Micro>Earned</Micro><p className="num text-lg font-semibold">${(s.income?.salesUsd ?? 0).toFixed(2)}</p></div>
              <div className="rounded-2xl bg-muted px-3 py-2"><Micro>To vault</Micro><p className="num text-lg font-semibold">${(s.income?.sweptUsd ?? 0).toFixed(2)}</p></div>
            </div>
            <div className="rounded-2xl bg-muted px-3 py-2 text-sm">
              <Micro>Payout wallet · Privy (automatic)</Micro>
              {s.payTo ? (
                <button type="button" onClick={() => copy(s.payTo!)} className="mt-1 flex w-full items-center justify-between gap-2 font-mono text-xs" aria-label="Copy payout wallet address">
                  <span className="truncate">{s.payTo}</span>{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5 text-muted-foreground" />}
                </button>
              ) : <p className="mt-1 text-xs text-muted-foreground">Not created yet</p>}
              {s.income?.lastSweep && <p className="mt-1 text-xs text-muted-foreground">Last swept into the vault {new Date(s.income.lastSweep.at).toLocaleString()}</p>}
              {s.income?.lastError && <p className="mt-1 text-xs text-loss">{s.income.lastError}</p>}
            </div>
            <dl className="grid grid-cols-3 gap-2 text-center text-xs">
              <div><dt className="text-muted-foreground">Decisions</dt><dd className="num font-semibold">{s.counts.decisions}</dd></div>
              <div><dt className="text-muted-foreground">Signals</dt><dd className="num font-semibold">{s.counts.signals}</dd></div>
              <div><dt className="text-muted-foreground">Trades</dt><dd className="num font-semibold">{s.counts.trades}</dd></div>
            </dl>
            <div className="rounded-2xl border border-dashed border-border p-3 text-xs text-muted-foreground">
              <p><span className="font-medium text-foreground">{s.price} per query</span> · {s.settlement === "x402" ? "x402 (USDC)" : "local USDC transfer"}</p>
              <p className="mt-1 break-all font-mono">GET {API}/data/paid/{agent}/trades</p>
              <p className="mt-1">The track record is free on Arkiv; levels, sizes and reasoning are encrypted and returned only after payment.</p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

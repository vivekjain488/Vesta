"use client";
import { useState } from "react";
import { API } from "@/lib/data";

interface Row {
  signature: string;
  kind: string;
  confidence: string;
  sourcesAgreeing: number;
  decodeVerified: number;
  asFact: boolean;
  corroborated: boolean;
  key: string;
}

const EXAMPLES = ["0xa9059cbb", "0x095ea7b3", "0x23b872dd", "0x38ed1739"];

export default function Atlas() {
  const [q, setQ] = useState("0xa9059cbb");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function lookup(sel = q) {
    setErr(null);
    setRows(null);
    const s = sel.trim().toLowerCase();
    if (!/^0x[0-9a-f]{8}([0-9a-f]{56})?$/.test(s)) return setErr("Enter a 4-byte function selector (0x + 8 hex) or a 32-byte event topic.");
    const r = await fetch(`${API}/v1/atlas/${s}`).catch(() => null);
    if (!r) return setErr("API offline.");
    const j = await r.json();
    if (!r.ok) return setErr(j.error ?? "lookup failed");
    setRows(j);
  }

  return (
    <div className="pt-14">
      <p className="num text-[11px] uppercase tracking-[0.25em] text-dim">Arkiv mirror · 4byte.directory, cross-checked against OpenChain</p>
      <h1 className="mt-3 font-display text-6xl">Signature Atlas</h1>
      <p className="mt-4 max-w-2xl text-paper/75">
        Ethereum&apos;s function and event signatures, mirrored into Arkiv. Every entry records its source and the wallet that submitted it. Perpetua&apos;s risk-check and decoding services read it. Source agreement and successful decoding provide evidence; selector collisions mean they cannot prove a deployed contract&apos;s behavior.
      </p>
      <form
        className="mt-8 flex max-w-xl gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          lookup();
        }}
      >
        <label htmlFor="sel" className="sr-only">Selector</label>
        <input id="sel" value={q} onChange={(e) => setQ(e.target.value)} className="num flex-1 rounded-sm border border-line bg-panel px-3 py-2" placeholder="0xa9059cbb" />
        <button className="rounded-sm bg-paper px-4 text-sm font-medium text-ink">Resolve</button>
      </form>
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        {EXAMPLES.map((e) => (
          <button key={e} onClick={() => (setQ(e), lookup(e))} className="num rounded-sm border border-line px-2 py-1 text-dim hover:text-paper">
            {e}
          </button>
        ))}
      </div>
      {err && <p className="mt-6 text-sm text-exposure">{err}</p>}
      {rows && (
        <div className="mt-8 overflow-x-auto">
          {rows.length === 0 ? (
            <p className="text-dim">No entries owned by the importer wallet yet. Run <code className="num">pnpm atlas:import</code>.</p>
          ) : (
            <table className="w-full min-w-[560px] text-sm">
              <thead className="text-left text-[11px] uppercase tracking-wider text-dim">
                <tr className="border-b border-line">
                  <th className="py-2 font-normal">Signature</th>
                  <th className="font-normal">Kind</th>
                  <th className="font-normal">Confidence</th>
                  <th className="text-right font-normal">Sources</th>
                  <th className="text-right font-normal">Decode-verified</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className="border-b border-line/60">
                    <td className="num py-2.5">{r.signature}<span className="ml-2 text-[10px] uppercase text-dim">{r.corroborated ? "corroborated" : "candidate"}</span></td>
                    <td className="text-dim">{r.kind}</td>
                    <td className={r.confidence === "high" ? "text-alive" : r.confidence === "low" || r.confidence === "disputed" ? "text-exposure" : "text-cushion"}>{r.confidence}</td>
                    <td className="num text-right">{r.sourcesAgreeing}</td>
                    <td className="num text-right">{r.decodeVerified}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

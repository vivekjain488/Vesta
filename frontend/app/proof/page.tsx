"use client";
import { useEffect, useState } from "react";
import { getJson } from "@/lib/data";

/** The README checklist, live: every tx hash / request ID the demo produced, per sponsor. */
export default function Proof() {
  const [ev, setEv] = useState<any>(null);
  useEffect(() => {
    getJson<any>("/v1/evidence").then(setEv);
  }, []);
  const beats = ev?.beats ?? {};
  return (
    <div className="pt-14">
      <h1 className="font-display text-6xl">Proof</h1>
      <p className="mt-4 max-w-2xl text-paper/75">
        No human topped it up. Principal was never at risk. Every decision can be audited. Each line below links a claim to the transaction or request that proves it.
      </p>
      {ev?.disclosure && <p className="mt-4 max-w-2xl rounded-sm border border-line px-3 py-2 text-sm text-dim">{ev.disclosure}</p>}
      {!ev?.beats && <p className="mt-8 text-dim">No evidence yet. Run <code className="num">pnpm demo</code>.</p>}
      <div className="mt-10 space-y-6">
        {Object.entries(beats).map(([k, v]) => (
          <section key={k} className="rounded-sm border border-line bg-panel/80 p-5">
            <h2 className="text-lg">{k}</h2>
            <pre className="num mt-3 overflow-x-auto whitespace-pre-wrap break-all text-[12px] leading-relaxed text-paper/80">{JSON.stringify(v, null, 2)}</pre>
          </section>
        ))}
      </div>
    </div>
  );
}

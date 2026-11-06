"use client";
import { apiFetch } from "@/lib/api";
import { useState } from "react";
import { ArrowUp, Fingerprint } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorNote, PageHeader } from "@/components/ui-perpetua";
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
const confidenceVariant = (c: string) => (c === "high" ? "profit" : c === "low" || c === "disputed" ? "loss" : "trade");

export default function Atlas() {
  const [q, setQ] = useState("0xa9059cbb");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function lookup(sel = q) {
    setErr(null);
    setRows(null);
    const s = sel.trim().toLowerCase();
    if (!/^0x[0-9a-f]{8}([0-9a-f]{56})?$/.test(s)) return setErr("Enter a 4-byte function selector (0x + 8 hex) or a 32-byte event topic.");
    const r = await apiFetch(`${API}/v1/atlas/${s}`).catch(() => null);
    if (!r) return setErr("API offline.");
    const j = await r.json();
    if (!r.ok) return setErr(j.error ?? "lookup failed");
    setRows(j);
  }

  return (
    <div className="max-w-5xl space-y-6 pt-4 lg:pt-6">
      <PageHeader
        eyebrow="Arkiv mirror · 4byte.directory, cross-checked against OpenChain"
        title="Signature Atlas"
        description="Ethereum's function and event signatures, mirrored into Arkiv. Every entry records its source and the wallet that submitted it. Perpetua's risk-check and decoding services read it. Source agreement and successful decoding provide evidence; selector collisions mean they cannot prove a deployed contract's behavior."
      />
      <Card>
        <CardContent className="space-y-4">
          <form
            className="flex items-center gap-2 rounded-[22px] bg-muted p-2 pl-4"
            onSubmit={(e) => {
              e.preventDefault();
              lookup();
            }}
          >
            <Fingerprint className="size-4 shrink-0 text-muted-foreground" />
            <label htmlFor="sel" className="sr-only">Selector</label>
            <input id="sel" value={q} onChange={(e) => setQ(e.target.value)} className="min-w-0 flex-1 bg-transparent font-mono text-sm outline-none placeholder:text-faint" placeholder="0xa9059cbb" />
            <Button type="submit" size="icon-sm" aria-label="Resolve"><ArrowUp /></Button>
          </form>
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((e) => (
              <Button key={e} variant="chip-outline" onClick={() => (setQ(e), lookup(e))}>{e}</Button>
            ))}
          </div>
          {err && <ErrorNote>{err}</ErrorNote>}
          {rows &&
            (rows.length === 0 ? (
              <EmptyState title="No entries yet" icon={<Fingerprint className="size-4" />}>
                No entries owned by the importer wallet yet. Run <code className="font-mono">pnpm atlas:import</code>.
              </EmptyState>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Signature</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Confidence</TableHead>
                    <TableHead className="text-right">Sources</TableHead>
                    <TableHead className="text-right">Decode-verified</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.key}>
                      <TableCell>
                        <span className="font-mono text-[13px]">{r.signature}</span>
                        <Badge variant="muted" size="micro" className="ml-2">{r.corroborated ? "corroborated" : "candidate"}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{r.kind}</TableCell>
                      <TableCell><Badge variant={confidenceVariant(r.confidence)}>{r.confidence}</Badge></TableCell>
                      <TableCell className="num text-right">{r.sourcesAgreeing}</TableCell>
                      <TableCell className="num text-right">{r.decodeVerified}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ))}
        </CardContent>
      </Card>
    </div>
  );
}

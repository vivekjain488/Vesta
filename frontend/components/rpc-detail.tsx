"use client";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { ShadeTip, UptimeStrip } from "@/components/rpc-metrics";
import { Button } from "@/components/ui/button";
import { AVAILABILITY_TIP, LATENCY_TIP, availabilityShade, errorBreakdown, headShade, httpShade, lagShade, latencyShade, rateLimitHint, windowStats, type RpcSample } from "@/lib/rpc-metrics";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export type RpcInspection = {
  at: number;
  vantage: string;
  chainOk: boolean | null;
  chainOutcome: string;
  probeLatencyMs: number | null;
  blockLatencyMs: number | null;
  blockNumber: string | null;
  peerMaxBlock: string | null;
  peerCount: number;
  lagBlocks: number | null;
  headAgeSec: number | null;
  archive: "yes" | "no" | "unknown";
  batch: "yes" | "no" | "unknown";
  clientVersion: string | null;
  tlsProtocol: string | null;
  tlsOk: boolean | null;
  httpStatus?: number;
};

type Rpc = { endpointHash: string; endpoint: string; transport: string; requiresKey: boolean; executionEligible: boolean; eligibilityReason: string };
type Chain = { chainId: number; name: string };

function ago(at: number, now: number) {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function duration(seconds: number) {
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

function flagShade(value: "yes" | "no" | "unknown" | boolean | null, pass: string, fail: string) {
  if (value === true || value === "yes") return { color: "#16a36a", label: pass };
  if (value === false || value === "no") return { color: "#e35d5b", label: fail };
  return { color: "#b5b5b2", label: "Not measured" };
}

function Row({ label, value, color, hint }: { label: string; value: string; color?: string; hint: string }) {
  return (
    <div className="grid gap-1 border-b border-border/80 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium">{label}</p>
        <p className="num text-right text-sm font-semibold" style={color ? { color } : undefined}>{value}</p>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
    </div>
  );
}

export function RpcDetail({ rpc, chain, snapshot, samples, now, onClose }: { rpc: Rpc | null; chain: Chain | null; snapshot: string; samples: RpcSample[]; now: number; onClose: () => void }) {
  const [history, setHistory] = useState<RpcSample[] | null>(null);
  const [inspection, setInspection] = useState<RpcInspection | null>(null);
  const [stored, setStored] = useState<boolean | null>(null);
  const [vantage, setVantage] = useState("This API host");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!rpc) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rpc, onClose]);

  useEffect(() => {
    if (!rpc || !chain || !snapshot) return;
    let cancel = false;
    setHistory(null); setInspection(null); setStored(null); setError(""); setBusy(true);
    const hash = rpc.endpointHash;
    void (async () => {
      try {
        const response = await fetch(`${API}/registry/health/${chain.chainId}/${hash}`, { cache: "no-store" });
        const data = await response.json();
        if (!cancel && response.ok) {
          setHistory(Array.isArray(data.samples) ? data.samples : []);
          if (data.inspection) setInspection(data.inspection);
          if (data.vantage) setVantage(data.vantage);
        }
      } catch { /* The table already has the 24h samples. */ }
      if (rpc.requiresKey || !rpc.executionEligible) { if (!cancel) setBusy(false); return; }
      try {
        const response = await fetch(`${API}/registry/inspect/${chain.chainId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ snapshot, hash }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Could not inspect this RPC");
        if (!cancel) { setInspection(data.inspection); setStored(Boolean(data.stored)); if (data.inspection?.vantage) setVantage(data.inspection.vantage); }
      } catch (e) { if (!cancel) setError((e as Error).message); }
      finally { if (!cancel) setBusy(false); }
    })();
    return () => { cancel = true; };
  }, [rpc, chain, snapshot]);

  if (!rpc || !chain) return null;
  const byTime = new Map<number, RpcSample>();
  for (const sample of [...(history ?? []), ...samples]) byTime.set(sample.at, sample);
  const series = [...byTime.values()].sort((a, b) => a.at - b.at);
  const day = windowStats(series, 24 * 3600_000, now);
  const week = windowStats(series, 7 * 24 * 3600_000, now);
  const errors = errorBreakdown(series.filter((sample) => sample.at >= now - 24 * 3600_000));
  const limits = rateLimitHint(series.filter((sample) => sample.at >= now - 24 * 3600_000));
  const latest = series.at(-1);
  const checkedAt = Math.max(latest?.at ?? 0, inspection?.at ?? 0);
  const latency = latencyShade(inspection?.blockLatencyMs ?? day.medianLatencyMs, inspection ? inspection.blockLatencyMs != null : true);
  const dayShade = availabilityShade(day.availability);
  const weekShade = availabilityShade(week.availability);
  const chainShade = flagShade(inspection?.chainOk ?? null, "Pass", "Wrong chain");
  const lag = lagShade(inspection?.lagBlocks);
  const head = headShade(inspection?.headAgeSec);
  const archive = flagShade(inspection?.archive ?? "unknown", "Yes", "No");
  const batch = flagShade(inspection?.batch ?? "unknown", "Yes", "No");
  const tls = inspection?.tlsOk == null ? { color: "#b5b5b2", label: "Not measured" } : inspection.tlsOk ? { color: "#16a36a", label: inspection.tlsProtocol ?? "OK" } : { color: "#e35d5b", label: "Issue" };
  const limitShade = limits.level === "low" ? { color: "#16a36a", label: "Low" } : limits.level === "medium" ? { color: "#d4a017", label: "Medium" } : limits.level === "high" ? { color: "#e35d5b", label: "High" } : { color: "#b5b5b2", label: "Unknown" };
  const pct = (value: number | null, count: number, ok: number) => value === null ? "No samples" : `${value}% · ${ok}/${count}`;

  return (
    <div className="fixed inset-0 z-40">
      <button type="button" aria-label="Close RPC details" className="absolute inset-0 bg-black/25" onClick={onClose} />
      <aside role="dialog" aria-modal="true" aria-label={`${rpc.endpoint} health`} className="absolute inset-y-0 right-0 flex w-full max-w-[440px] flex-col border-l border-border bg-background shadow-2xl">
        <div className="flex items-start justify-between gap-3 px-5 pt-5">
          <div className="min-w-0">
            <p className="micro text-muted-foreground">RPC health · {chain.name}</p>
            <h2 className="mt-2 font-mono text-sm leading-relaxed break-all">{rpc.endpoint}</h2>
            <p className="mt-2 text-xs text-muted-foreground">{rpc.transport} · chain {chain.chainId} · measured from {vantage}</p>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X /></Button>
        </div>
        <div className="mt-4 flex-1 space-y-4 overflow-y-auto px-5 pb-8">
          <div className="rounded-2xl bg-muted/70 p-3">
            <div className="mb-2 flex items-center justify-between text-[10px] text-muted-foreground"><span>Uptime, last 24 hours</span><span style={{ color: dayShade.color }}>{dayShade.label}</span></div>
            <UptimeStrip samples={series} now={now} hours={24} className="h-7" />
            <p className="mt-2 text-[10px] text-muted-foreground">Green means every probe that hour passed. Amber means some failed. Red means all failed. Gray means we did not probe.</p>
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between text-[10px] text-muted-foreground"><span>Uptime, last 7 days</span><span style={{ color: weekShade.color }}>{week.availability === null ? "No samples" : `${week.availability}%`}</span></div>
            <UptimeStrip samples={series} now={now} hours={168} className="h-5" />
          </div>
          {busy && <p className="text-xs text-muted-foreground">Measuring block height, head age, archive, batch, and TLS…</p>}
          {error && <p className="rounded-xl bg-muted p-3 text-xs text-muted-foreground">{error}</p>}
          <div>
            <Row label="Latency" color={latency.color} value={inspection?.blockLatencyMs != null ? `${inspection.blockLatencyMs} ms · ${latency.label}` : day.medianLatencyMs != null ? `${day.medianLatencyMs} ms median · ${latency.label}` : "No sample"} hint={`${LATENCY_TIP} The opened panel times eth_blockNumber. Median and p95 below use the stored probe history.`} />
            <Row label="Median / p95" color={latencyShade(day.medianLatencyMs, true).color} value={day.medianLatencyMs == null ? "No successful probes" : `${day.medianLatencyMs} ms / ${day.p95LatencyMs} ms`} hint="Successful probes only, over the samples stored for the last 24 hours." />
            <Row label="Uptime, 24h" color={dayShade.color} value={pct(day.availability, day.sampleCount, day.successfulSamples)} hint={AVAILABILITY_TIP} />
            <Row label="Uptime, 7d" color={weekShade.color} value={pct(week.availability, week.sampleCount, week.successfulSamples)} hint="Same ratio over seven days of stored probes. Missing hours are left out, not treated as downtime." />
            <Row label="Chain ID" color={chainShade.color} value={inspection ? `${chainShade.label}${inspection.chainOutcome && inspection.chainOutcome !== "healthy" ? ` · ${inspection.chainOutcome.replaceAll("_", " ")}` : ""}` : busy ? "Checking…" : "Not checked"} hint="eth_chainId must match this registry chain. A mismatch means the endpoint is serving a different network." />
            <Row label="Block freshness" color={lag.color} value={inspection?.lagBlocks == null ? (busy ? "Checking…" : "No peer sample") : `${inspection.lagBlocks} blocks ${lag.label.toLowerCase()}`} hint={inspection?.peerCount ? `Compared with ${inspection.peerCount} other public endpoints on this chain. Within 2 blocks is synced, within 10 is behind, and further back looks stuck.` : "Needs at least one other reachable public endpoint on this chain."} />
            <Row label="Head age" color={head.color} value={inspection?.headAgeSec == null ? (busy ? "Checking…" : "Unknown") : `${duration(inspection.headAgeSec)} · ${head.label.toLowerCase()}`} hint="Time since the latest block timestamp. Under 30 seconds is fresh and under 2 minutes is aging. Chains with slower blocks can look older while still being healthy." />
            <Row label="Last checked" value={checkedAt ? ago(checkedAt, now) : "Never"} hint="The newer of the latest stored probe and this inspection." />
            <Row label="Errors, 24h" color={errors.failed ? "#e35d5b" : "#16a36a"} value={errors.total ? `${errors.failed}/${errors.total}${errors.rows[0] ? ` · ${errors.rows[0].outcome.replaceAll("_", " ")}` : ""}` : "No samples"} hint={errors.rows.length ? errors.rows.map((row) => `${row.outcome.replaceAll("_", " ")} ${row.count}`).join(" · ") : "Timeouts, HTTP errors, rate limits, and JSON-RPC errors are counted separately when they occur."} />
            <Row label="Archive" color={archive.color} value={archive.label} hint="eth_getBalance at block 1. Yes means this node can answer an old block. No means it reported that history is unavailable." />
            <Row label="Batch" color={batch.color} value={batch.label} hint="A two-call JSON-RPC batch must return both eth_chainId and web3_clientVersion. Yes means bulk reads work." />
            <Row label="Rate limit" color={limitShade.color} value={limits.total ? `${limitShade.label} · ${limits.limited}/${limits.total} were 429` : "Unknown"} hint="How often our normal probe rate received HTTP 429 or a rate-limit error over the stored samples. Low means none of them were throttled." />
            <Row label="TLS" color={tls.color} value={inspection?.tlsOk == null ? (busy ? "Checking…" : "Not measured") : tls.label} hint="The certificate had to validate for the probe to connect. The protocol version is whatever this host negotiated." />
            <Row label="Client" value={inspection?.clientVersion ?? (busy ? "Checking…" : "Not reported")} hint="web3_clientVersion, when the endpoint answers it. Useful for telling Geth, Nethermind, Erigon, and others apart." />
            <Row label="Region" value={vantage} hint="Latency and head age are from this prober. A result that looks slow here can be faster next to the node." />
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {stored === false ? "This readout is live, and Arkiv did not accept the write. The hourly probe history is still queued for Arkiv when the writer is available." : "Probe history and this inspection are written to Arkiv for 30 days, so uptime is recomputed from those samples."}
            {" "}HTTP {latest?.httpStatus ?? inspection?.httpStatus ?? "—"}
            {latest?.httpStatus ? <ShadeTip color={httpShade(latest.httpStatus).color} tip="HTTP status of the latest stored probe."> · {httpShade(latest.httpStatus).label}</ShadeTip> : null}
          </p>
        </div>
      </aside>
    </div>
  );
}

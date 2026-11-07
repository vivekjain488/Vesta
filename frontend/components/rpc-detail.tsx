"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { LatencyChart, ShadeTip, UptimeStrip } from "@/components/rpc-metrics";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AVAILABILITY_TIP, LATENCY_TIP, SHADE, availabilityShade, errorBreakdown, headShade, httpShade, lagShade, latencyShade, rateLimitHint, timeAgo, windowStats, type RpcSample } from "@/lib/rpc-metrics";
import { cn } from "@/lib/utils";
import { API } from "@/lib/api";

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

const EXIT_MS = 320;
const tint = (color: string, alpha = "1f") => `${color}${alpha}`;

function duration(seconds: number) {
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

function flagShade(value: "yes" | "no" | "unknown" | boolean | null, pass: string, fail: string) {
  if (value === true || value === "yes") return { color: SHADE.good, label: pass };
  if (value === false || value === "no") return { color: SHADE.bad, label: fail };
  return { color: SHADE.none, label: "Not measured" };
}

/** One summary figure; the explanation appears on hover instead of taking up space. */
function Tile({ label, value, sub, color, hint }: { label: string; value: string; sub: string; color?: string; hint: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="cursor-help rounded-2xl bg-muted/70 p-4 transition-colors duration-200 hover:bg-muted">
          <p className="micro text-muted-foreground">{label}</p>
          <p className="num mt-2.5 text-[26px] leading-none font-semibold tracking-tight transition-colors duration-500" style={color ? { color } : undefined}>{value}</p>
          <p className="mt-2 text-xs text-muted-foreground">{sub}</p>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[260px] leading-snug">{hint}</TooltipContent>
    </Tooltip>
  );
}

/** One health check on a single line: coloured dot + label (hover for what it means) and the measured value. */
function Check({ label, hint, value, color, pending }: { label: string; hint: ReactNode; value: ReactNode | null; color?: string; pending?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex shrink-0 cursor-help items-center gap-2.5 text-sm text-muted-foreground">
            <span aria-hidden className="size-1.5 shrink-0 rounded-full transition-colors duration-500" style={{ background: color ?? SHADE.none }} />
            <span className="underline decoration-border decoration-dotted underline-offset-4">{label}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="left" className="max-w-[260px] leading-snug">{hint}</TooltipContent>
      </Tooltip>
      <span className="num min-w-0 flex-1 truncate text-right text-sm font-medium transition-colors duration-500" style={color ? { color } : undefined} title={typeof value === "string" ? value : undefined}>
        {pending && value == null ? <Skeleton className="ml-auto h-4 w-20" /> : value ?? "—"}
      </span>
    </div>
  );
}

function Group({ title, children, delay }: { title: string; children: ReactNode; delay: number }) {
  return (
    <section className="animate-in fade-in-0 slide-in-from-bottom-2 fill-mode-both duration-500" style={{ animationDelay: `${delay}ms` }}>
      <h3 className="micro mb-1 text-muted-foreground">{title}</h3>
      <div className="divide-y divide-border/60 rounded-2xl border border-border/70 px-4">{children}</div>
    </section>
  );
}

function Legend() {
  const items = [[SHADE.good, "All passed"], [SHADE.warn, "Some failed"], [SHADE.bad, "All failed"], [SHADE.empty, "Not probed"]] as const;
  return <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1">{items.map(([c, l]) => <span key={l} className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground"><span className="size-2 rounded-[2px]" style={{ background: c }} />{l}</span>)}</div>;
}

export function RpcDetail({ rpc, chain, snapshot, samples, now, onClose }: { rpc: Rpc | null; chain: Chain | null; snapshot: string; samples: RpcSample[]; now: number; onClose: () => void }) {
  const [history, setHistory] = useState<RpcSample[] | null>(null);
  const [inspection, setInspection] = useState<RpcInspection | null>(null);
  const [stored, setStored] = useState<boolean | null>(null);
  const [vantage, setVantage] = useState("This API host");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Keep the last panel content while the drawer slides out, so closing animates instead of vanishing.
  const last = useRef<{ rpc: Rpc; chain: Chain; samples: RpcSample[]; now: number } | null>(null);
  if (rpc && chain) last.current = { rpc, chain, samples, now };
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (rpc) {
      setMounted(true);
      const frame = requestAnimationFrame(() => requestAnimationFrame(() => { setVisible(true); closeButton.current?.focus({ preventScroll: true }); }));
      return () => cancelAnimationFrame(frame);
    }
    setVisible(false);
    const timer = setTimeout(() => setMounted(false), EXIT_MS);
    return () => clearTimeout(timer);
  }, [rpc]);

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

  const view = last.current;
  if (!mounted || !view) return null;
  const { rpc: r, chain: c } = view;
  const byTime = new Map<number, RpcSample>();
  for (const sample of [...(history ?? []), ...view.samples]) byTime.set(sample.at, sample);
  const series = [...byTime.values()].sort((a, b) => a.at - b.at);
  const t = view.now;
  const day = windowStats(series, 24 * 3600_000, t);
  const week = windowStats(series, 7 * 24 * 3600_000, t);
  const errors = errorBreakdown(series.filter((sample) => sample.at >= t - 24 * 3600_000));
  const limits = rateLimitHint(series.filter((sample) => sample.at >= t - 24 * 3600_000));
  const latest = series.at(-1);
  const checkedAt = Math.max(latest?.at ?? 0, inspection?.at ?? 0);
  const medianShade = latencyShade(day.medianLatencyMs, true);
  const p95Shade = latencyShade(day.p95LatencyMs, true);
  const blockShade = latencyShade(inspection?.blockLatencyMs, inspection ? inspection.blockLatencyMs != null : true);
  const dayShade = availabilityShade(day.availability);
  const weekShade = availabilityShade(week.availability);
  const chainShade = flagShade(inspection?.chainOk ?? null, "Pass", "Wrong chain");
  const lag = lagShade(inspection?.lagBlocks);
  const head = headShade(inspection?.headAgeSec);
  const archive = flagShade(inspection?.archive ?? "unknown", "Yes", "No");
  const batch = flagShade(inspection?.batch ?? "unknown", "Yes", "No");
  const tls = inspection?.tlsOk == null ? { color: SHADE.none, label: "Not measured" } : inspection.tlsOk ? { color: SHADE.good, label: inspection.tlsProtocol ?? "OK" } : { color: SHADE.bad, label: "Issue" };
  const limitShade = limits.level === "low" ? { color: SHADE.good, label: "Low" } : limits.level === "medium" ? { color: SHADE.warn, label: "Medium" } : limits.level === "high" ? { color: SHADE.bad, label: "High" } : { color: SHADE.none, label: "Unknown" };
  const verdict = !latest ? { label: "No data", color: SHADE.none }
    : !latest.ok ? { label: "Failing", color: SHADE.bad }
    : dayShade.band === "bad" ? { label: "Unreliable", color: SHADE.bad }
    : dayShade.band === "warn" ? { label: "Degraded", color: SHADE.warn }
    : { label: "Healthy", color: SHADE.good };
  const [, proto = "", rest = r.endpoint] = /^([a-z]+:\/\/)(.*)$/i.exec(r.endpoint) ?? [];
  const stagger = (i: number) => ({ animationDelay: `${i * 60}ms` });
  const enter = "animate-in fade-in-0 slide-in-from-bottom-2 fill-mode-both duration-500";

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label="Close RPC details"
        tabIndex={-1}
        className={cn("absolute inset-0 cursor-default bg-black/25 backdrop-blur-[2px] transition-opacity duration-300 ease-out motion-reduce:transition-none", visible ? "opacity-100" : "opacity-0")}
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`${r.endpoint} health`}
        className={cn(
          // A floating card, like the rest of the UI: inset from every edge, 28px corners, white on the off-white canvas.
          "absolute inset-y-3 right-3 flex w-[calc(100%-1.5rem)] max-w-[480px] flex-col overflow-hidden rounded-[28px] bg-card ring-1 ring-black/5 shadow-[0_28px_80px_-24px_rgba(17,17,17,0.5)] sm:inset-y-4 sm:right-4 sm:w-[calc(100%-2rem)]",
          "transition-[transform,opacity] duration-[360ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform motion-reduce:transition-none",
          visible ? "translate-x-0 opacity-100" : "translate-x-[calc(100%+2rem)] opacity-0",
        )}
      >
        <header className="shrink-0 bg-gradient-to-b from-trade-soft to-card px-7 pt-7 pb-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="micro text-trade-deep">RPC health · {c.name}</p>
              <h2 className="mt-2.5 font-mono text-[15px] leading-snug font-medium break-all"><span className="text-muted-foreground">{proto}</span>{rest}</h2>
            </div>
            <Button ref={closeButton} type="button" variant="ghost" size="icon" className="-mt-1.5 -mr-2 shrink-0 rounded-full bg-card/70 hover:bg-card" onClick={onClose} aria-label="Close"><X /></Button>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors duration-500" style={{ color: verdict.color, background: tint(verdict.color) }}>
              <span className={cn("size-1.5 rounded-full", verdict.label === "Healthy" && "pulse-soft")} style={{ background: verdict.color }} />{verdict.label}
            </span>
            <span className="rounded-full bg-muted px-2.5 py-1 font-mono text-[11px] text-muted-foreground uppercase">{r.transport}</span>
            <span className="rounded-full bg-muted px-2.5 py-1 font-mono text-[11px] text-muted-foreground">chain {c.chainId}</span>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">Measured from {vantage}{checkedAt ? ` · checked ${timeAgo(checkedAt, t)}` : ""}</p>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto overscroll-contain px-7 pt-1 pb-10 [scrollbar-width:thin]">
          {error && <p className="rounded-2xl bg-muted p-3 text-xs text-muted-foreground">{error}</p>}

          <div className={cn("grid grid-cols-2 gap-2.5", enter)} style={stagger(0)}>
            <Tile label="Median latency" value={day.medianLatencyMs == null ? "—" : `${day.medianLatencyMs} ms`} sub={day.medianLatencyMs == null ? "No successful probes" : medianShade.label} color={medianShade.color} hint={`${LATENCY_TIP} Median of successful probes over the last 24 hours.`} />
            <Tile label="Slowest 5% (p95)" value={day.p95LatencyMs == null ? "—" : `${day.p95LatencyMs} ms`} sub={day.p95LatencyMs == null ? "No successful probes" : p95Shade.label} color={p95Shade.color} hint="95% of successful probes were faster than this, over the samples stored for the last 24 hours." />
            <Tile label="Uptime · 24h" value={day.availability == null ? "—" : `${day.availability}%`} sub={day.availability == null ? "No samples" : `${day.successfulSamples}/${day.sampleCount} probes · ${dayShade.label}`} color={dayShade.color} hint={AVAILABILITY_TIP} />
            <Tile label="Uptime · 7d" value={week.availability == null ? "—" : `${week.availability}%`} sub={week.availability == null ? "No samples" : `${week.successfulSamples}/${week.sampleCount} probes · ${weekShade.label}`} color={weekShade.color} hint="Same ratio over seven days of stored probes. Missing hours are left out, not treated as downtime." />
          </div>

          <section className={enter} style={stagger(1)}>
            <div className="rounded-2xl border border-border/70 p-4">
              <div className="flex items-baseline justify-between"><h3 className="text-sm font-medium">Uptime</h3><span className="text-[11px] text-muted-foreground">one bar per hour</span></div>
              <div className="mt-4 mb-1.5 flex items-center justify-between text-xs text-muted-foreground"><span>Last 24 hours</span><span className="num font-medium" style={{ color: dayShade.color }}>{day.availability == null ? "No samples" : `${day.availability}%`}</span></div>
              <UptimeStrip samples={series} now={t} hours={24} className="h-9" />
              <div className="mt-4 mb-1.5 flex items-center justify-between text-xs text-muted-foreground"><span>Last 7 days</span><span className="num font-medium" style={{ color: weekShade.color }}>{week.availability == null ? "No samples" : `${week.availability}%`}</span></div>
              <UptimeStrip samples={series} now={t} hours={168} className="h-6" />
              <Legend />
            </div>
          </section>

          <section className={enter} style={stagger(2)}>
            <div className="rounded-2xl border border-border/70 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"><h3 className="text-sm font-medium">Latency, last 24 hours</h3><span className="text-[11px] text-muted-foreground">green &lt;300 ms · amber &lt;1 s · red slower</span></div>
              <div className="mt-3"><LatencyChart samples={series} now={t} hours={24} /></div>
            </div>
          </section>

          <Group title="Sync & chain" delay={180}>
            <Check label="Chain ID" color={chainShade.color} pending={busy} value={inspection ? `${chainShade.label}${inspection.chainOutcome && inspection.chainOutcome !== "healthy" ? ` · ${inspection.chainOutcome.replaceAll("_", " ")}` : ""}` : busy ? null : "Not checked"} hint="eth_chainId must match this registry chain. A mismatch means the endpoint is serving a different network." />
            <Check label="Block freshness" color={lag.color} pending={busy} value={inspection?.lagBlocks == null ? (busy ? null : "No peer sample") : `${inspection.lagBlocks} blocks · ${lag.label.toLowerCase()}`} hint={inspection?.peerCount ? `Compared with ${inspection.peerCount} other public endpoints on this chain. Within 2 blocks is synced, within 10 is behind, and further back looks stuck.` : "Needs at least one other reachable public endpoint on this chain."} />
            <Check label="Head age" color={head.color} pending={busy} value={inspection?.headAgeSec == null ? (busy ? null : "Unknown") : `${duration(inspection.headAgeSec)} · ${head.label.toLowerCase()}`} hint="Time since the latest block timestamp. Under 30 seconds is fresh and under 2 minutes is aging. Chains with slower blocks can look older while still being healthy." />
            <Check label="Block call" color={blockShade.color} pending={busy} value={inspection?.blockLatencyMs == null ? (busy ? null : "No sample") : `${inspection.blockLatencyMs} ms · ${blockShade.label.toLowerCase()}`} hint="Round-trip time of one eth_blockNumber call made when this panel opened." />
            <Check label="Client" pending={busy} value={inspection?.clientVersion ?? (busy ? null : "Not reported")} hint="web3_clientVersion, when the endpoint answers it. Useful for telling Geth, Nethermind, Erigon, and others apart." />
          </Group>

          <Group title="Capabilities" delay={240}>
            <Check label="Archive" color={archive.color} pending={busy} value={inspection ? archive.label : busy ? null : "Not measured"} hint="eth_getBalance at block 1. Yes means this node can answer an old block. No means it reported that history is unavailable." />
            <Check label="Batch requests" color={batch.color} pending={busy} value={inspection ? batch.label : busy ? null : "Not measured"} hint="A two-call JSON-RPC batch must return both eth_chainId and web3_clientVersion. Yes means bulk reads work." />
            <Check label="TLS" color={tls.color} pending={busy} value={inspection?.tlsOk == null ? (busy ? null : "Not measured") : tls.label} hint="The certificate had to validate for the probe to connect. The protocol version is whatever this host negotiated." />
          </Group>

          <Group title="Reliability" delay={300}>
            <Check label="Errors · 24h" color={errors.failed ? SHADE.bad : SHADE.good} value={errors.total ? `${errors.failed}/${errors.total}${errors.rows[0] ? ` · ${errors.rows[0].outcome.replaceAll("_", " ")}` : ""}` : "No samples"} hint={errors.rows.length ? errors.rows.map((row) => `${row.outcome.replaceAll("_", " ")} ${row.count}`).join(" · ") : "Timeouts, HTTP errors, rate limits, and JSON-RPC errors are counted separately when they occur."} />
            <Check label="Rate limit" color={limitShade.color} value={limits.total ? `${limitShade.label} · ${limits.limited}/${limits.total} were 429` : "Unknown"} hint="How often our normal probe rate received HTTP 429 or a rate-limit error over the stored samples. Low means none of them were throttled." />
            <Check label="Last HTTP status" color={latest?.httpStatus ? httpShade(latest.httpStatus).color : undefined} value={latest?.httpStatus ?? inspection?.httpStatus ? `${latest?.httpStatus ?? inspection?.httpStatus} · ${httpShade(latest?.httpStatus ?? inspection?.httpStatus).label}` : "—"} hint="HTTP status of the latest stored probe." />
            <Check label="Vantage" value={vantage} hint="Latency and head age are from this prober. A result that looks slow here can be faster next to the node." />
          </Group>

          <p className="text-xs leading-relaxed text-muted-foreground">
            {stored === false ? "This readout is live, and Arkiv did not accept the write. The hourly probe history is still queued for Arkiv when the writer is available." : "A background monitor probes every public endpoint about every 30 minutes; the history and this inspection are written to Arkiv, so uptime is recomputed from those samples. Hover any label for what it measures."}
            {" "}<ShadeTip tip="Availability counts the probes we actually made. An hour with no probes shows gray and is not counted as downtime.">How uptime is counted</ShadeTip>
          </p>
        </div>
      </aside>
    </div>
  );
}

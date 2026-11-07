"use client";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { signedUsd } from "@/components/ui-perpetua";
import { fmt } from "@/lib/data";
import { cn } from "@/lib/utils";
import { CppiBar } from "./CppiBar";
import { AnimatedNumber } from "./motion";
import type { DashboardAgent } from "./agent-utils";

const usd = (n: number) => `$${fmt(n)}`;
const METRICS ={ value: "Value", floor: "Floor", cushion: "Cushion", exposure: "Exposure" } as const;
type Metric = keyof typeof METRICS;

/** The reference's blue wallet card: the owner's whole portfolio, summed across their funded agents. */
export function PortfolioCard({ agents, loading, className }: { agents: DashboardAgent[]; loading: boolean; className?: string }) {
  const [metric, setMetric] = useState<Metric>("value");
  const funded = agents.filter((a) => a.chain);
  const sum = (k: "V" | "F" | "C" | "E" | "principal") => funded.reduce((s, a) => s + (a.chain?.[k] ?? 0), 0);
  const V = sum("V");
  const F = sum("F");
  const C = sum("C");
  const E = sum("E");
  const profit = agents.reduce((s, a) => s + (a.profit ?? 0), 0);
  const deposited = agents.reduce((s, a) => s + (a.deposited ?? 0), 0);
  const figure = { value: V, floor: F, cushion: C, exposure: E }[metric];
  const trading = funded.filter((a) => !a.chain?.tradingOff && !a.chain?.hibernating && a.status === "active").length;
  const breaches = funded.filter((a) => (a.chain?.V ?? 0) < (a.chain?.F ?? 0)).length;

  return (
    <section
      data-reveal
      aria-label="Your portfolio"
      className={cn("relative flex flex-col overflow-hidden rounded-[28px] bg-gradient-to-b from-[#6a88fb] to-brand p-6 text-white shadow-[0_24px_60px_-32px_rgba(91,124,250,0.7)]", className)}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-display text-[2rem] leading-[1.1] tracking-tight">Portfolio</h2>
          <p className="mt-2 flex items-center gap-1.5 text-sm text-white/75">
            <span className="size-1.5 rounded-full bg-white/80" aria-hidden /> {agents.length} agent{agents.length === 1 ? "" : "s"} · {funded.length} funded
          </p>
        </div>
        <div className="shrink-0 pt-1.5 text-right">
          <p className="num text-sm leading-tight font-semibold">{loading ? "—" : `$${fmt(deposited)}`}</p>
          <p className="mt-0.5 text-xs text-white/65">Deposited</p>
        </div>
      </div>

      <div className="mt-5 border-t border-white/15 pt-5">
        {loading ? (
          <Skeleton className="h-14 w-56 rounded-2xl bg-white/20" />
        ) : (
          <p className="num text-[3.25rem] leading-none font-semibold tracking-tight" aria-live="polite">
            <AnimatedNumber value={figure} format={usd} />
          </p>
        )}
        <p className="mt-2 text-sm text-white/80">
          {METRICS[metric]} · Total profit <span className="num font-semibold text-white">{loading ? "—" : signedUsd(profit)}</span>
        </p>
      </div>

      <ToggleGroup type="single" size="sm" spacing={1.5} value={metric} onValueChange={(v) => v && setMetric(v as Metric)} className="mt-5" aria-label="Portfolio figure">
        {(Object.keys(METRICS) as Metric[]).map((m) => (
          <ToggleGroupItem key={m} value={m} variant="onBrand" className="px-3.5 text-[0.8rem]">
            {METRICS[m]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {funded.length > 0 && <CppiBar V={V} F={F} C={C} E={E} zoom={false} onBrand className="mt-5" />}

      <dl className="mt-5 space-y-2.5 text-sm">
        <div className="flex items-center justify-between">
          <dt className="text-white/85">Agents trading</dt>
          <dd className="num rounded-full bg-white/15 px-2.5 py-0.5 text-xs font-medium">{trading} / {funded.length}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-white/85">Floor breaches</dt>
          <dd className={cn("num rounded-full px-2.5 py-0.5 text-xs font-medium", breaches ? "bg-white text-loss" : "bg-white/15")}>{breaches}</dd>
        </div>
      </dl>

      <div className="mt-auto pt-6">
        <Button asChild size="xl" className="w-full">
          <Link href="/studio">Create agent</Link>
        </Button>
      </div>
    </section>
  );
}

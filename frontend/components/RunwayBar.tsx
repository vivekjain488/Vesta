"use client";
import { useRef } from "react";
import { useBarTween } from "@/components/motion";
import { ZeroGText } from "@/components/ZeroG";
import { TIER_COPY } from "@/lib/data";
import { cn } from "@/lib/utils";

/** Runway in days of thinking left, with the degradation-ladder thresholds marked (12h / 2d / 7d). */
export function RunwayBar({ name, days, tier }: { name: string; days: number; tier: string }) {
  const max = 14;
  const pct = Math.max(0, Math.min(1, days / max)) * 100;
  const t = TIER_COPY[tier] ?? TIER_COPY.thrive;
  const fillRef = useRef<HTMLDivElement>(null);
  useBarTween([fillRef], [{ width: `${pct}%` }], [pct]);
  const color = tier === "thrive" ? "bg-brand" : tier === "frugal" ? "bg-trade" : tier === "starving" ? "bg-trade-deep" : "bg-faint";
  return (
    <div>
      <p className="text-sm">
        <span className="font-medium">{name}</span> has <span className="num font-semibold">{Number.isFinite(days) ? days.toFixed(1) : "∞"} days</span> of thinking left.
      </p>
      <div className="relative mt-2.5 h-2 rounded-full bg-muted" role="img" aria-label={`Compute runway ${Number.isFinite(days) ? days.toFixed(1) : "unlimited"} days`}>
        <div ref={fillRef} className={cn("h-full w-0 rounded-full", color, tier === "starving" && "pulse-soft")} />
        {[0.5, 2, 7].map((d) => (
          <span key={d} className="absolute -top-0.5 h-3 w-px bg-foreground/20" style={{ left: `${(d / max) * 100}%` }} title={`${d} days`} />
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{t.label}</span> · <ZeroGText text={t.brain} />
      </p>
    </div>
  );
}

import { TIER_COPY } from "@/lib/data";

/** Runway in days of thinking left, with the degradation-ladder thresholds marked (12h / 2d / 7d). */
export function RunwayBar({ name, days, tier }: { name: string; days: number; tier: string }) {
  const max = 14;
  const pct = Math.max(0, Math.min(1, days / max)) * 100;
  const t = TIER_COPY[tier] ?? TIER_COPY.thrive;
  const color = tier === "thrive" ? "bg-alive" : tier === "frugal" ? "bg-cushion" : tier === "starving" ? "bg-exposure" : "bg-dim";
  return (
    <div>
      <p className="text-sm">
        <span className="font-medium">{name}</span> has{" "}
        <span className={`num ${t.tone}`}>{Number.isFinite(days) ? days.toFixed(1) : "∞"} days</span> of thinking left.
      </p>
      <div className="relative mt-2 h-1.5 rounded-full bg-line">
        <div className={`h-full rounded-full ${color} ${tier === "starving" ? "pulse-soft" : ""}`} style={{ width: `${pct}%` }} />
        {[0.5, 2, 7].map((d) => (
          <span key={d} className="absolute -top-1 h-3.5 w-px bg-dim/60" style={{ left: `${(d / max) * 100}%` }} title={`${d} days`} />
        ))}
      </div>
      <p className="mt-1.5 text-xs text-dim">
        <span className={t.tone}>{t.label}</span> · {t.brain}
      </p>
    </div>
  );
}

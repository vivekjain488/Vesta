import { fmt } from "@/lib/data";
import { cn } from "@/lib/utils";

/**
 * The CPPI picture in one bar: the floor F (protected, blue), the cushion C above it (the only money that may ever be
 * risked, orange), and a black marker at the exposure budget E = min(m*C, E_max) measured from the floor.
 * `zoom` shows the top slice of V so a small cushion stays visible (same logic as the original gauge).
 */
export function CppiBar({ V, F, C, E, zoom = true, onBrand = false, className }: { V: number; F: number; C: number; E: number; zoom?: boolean; onBrand?: boolean; className?: string }) {
  const total = Math.max(V, F, 1);
  const lo = zoom ? Math.max(0, F - Math.max(C * 1.5, V * 0.04)) : 0;
  const span = zoom ? Math.max(V - lo, 1) : total;
  const floorPct = Math.max(0, Math.min(100, ((Math.min(F, V) - lo) / span) * 100));
  const cushionPct = Math.max(0, Math.min(100 - floorPct, (C / span) * 100));
  const exposurePct = Math.max(0, Math.min(100, floorPct + (Math.min(E, C) / span) * 100));
  const breached = V < F;

  return (
    <div className={className}>
      <div
        role="img"
        aria-label={`Floor ${fmt(F)} dollars, cushion ${fmt(C)} dollars, exposure budget ${fmt(E)} dollars${breached ? ", value is below the floor" : ""}`}
        className={cn("relative h-3 overflow-hidden rounded-full", onBrand ? "bg-white/20" : "bg-muted")}
      >
        <div className={cn("absolute inset-y-0 left-0 rounded-l-full", onBrand ? "bg-white" : "bg-brand")} style={{ width: `${floorPct}%` }} />
        <div className="absolute inset-y-0 bg-trade" style={{ left: `${floorPct}%`, width: `${cushionPct}%` }} />
        {E > 0 && <div className={cn("absolute -inset-y-px w-[3px] rounded-full", onBrand ? "bg-foreground" : "bg-foreground")} style={{ left: `calc(${exposurePct}% - 1.5px)` }} />}
      </div>
      <div className={cn("mt-2 flex items-center justify-between text-[11px]", onBrand ? "text-white/75" : "text-muted-foreground")}>
        <span className="flex items-center gap-1.5">
          <span className={cn("size-1.5 rounded-full", onBrand ? "bg-white" : "bg-brand")} /> Floor
          <span className="size-1.5 rounded-full bg-trade" /> Cushion
          <span className="h-2 w-[3px] rounded-full bg-foreground" /> Exposure
        </span>
        {zoom && <span className="num">zoom ${fmt(lo, 0)}–${fmt(V, 0)}</span>}
      </div>
    </div>
  );
}

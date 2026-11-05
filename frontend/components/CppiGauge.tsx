import { fmt } from "@/lib/data";

/**
 * The CPPI picture in one bar: the floor F (protected), the cushion C above it (the only money that may ever
 * be risked), and the exposure budget E = min(m*C, E_max) the trading wallet may hold.
 */
export function CppiGauge({ V, F, C, E, compact = false }: { V: number; F: number; C: number; E: number; compact?: boolean }) {
  const total = Math.max(V, F, 1);
  const floorPct = (Math.min(F, V) / total) * 100;
  const cushionPct = (C / total) * 100;
  const zoom = !compact; // zoomed view: show the top 12% of V so the cushion is visible
  const lo = zoom ? Math.max(0, F - Math.max(C * 1.5, V * 0.04)) : 0;
  const span = Math.max(V - lo, 1);
  const zFloor = ((Math.min(F, V) - lo) / span) * 100;
  const zCushion = (C / span) * 100;

  return (
    <div>
      <div className="relative h-9 overflow-hidden rounded-sm border border-line bg-panel" role="img" aria-label={`Floor ${fmt(F)} dollars, cushion ${fmt(C)} dollars, exposure budget ${fmt(E)} dollars`}>
        <div className="absolute inset-y-0 left-0 bg-floor/25" style={{ width: `${zoom ? zFloor : floorPct}%` }} />
        <div className="absolute inset-y-0 bg-cushion/70" style={{ left: `${zoom ? zFloor : floorPct}%`, width: `${zoom ? zCushion : cushionPct}%` }} />
        <div className="absolute inset-y-0 border-l-2 border-floor" style={{ left: `${zoom ? zFloor : floorPct}%` }} />
        <div className="absolute inset-0 flex items-center justify-between px-3 text-[11px] uppercase tracking-wider">
          <span className="text-floor">floor ${fmt(F, 0)}</span>
          <span className="num text-ink/80 mix-blend-normal">{zoom ? `zoom: $${fmt(lo, 0)}–$${fmt(V, 0)}` : ""}</span>
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-4 gap-2 text-xs">
        <Stat label="Value V" value={V} />
        <Stat label="Floor F" value={F} tone="text-floor" />
        <Stat label="Cushion C" value={C} tone="text-cushion" />
        <Stat label="Exposure E" value={E} tone="text-exposure" />
      </dl>
    </div>
  );
}

function Stat({ label, value, tone = "text-paper" }: { label: string; value: number; tone?: string }) {
  return (
    <div>
      <dt className="text-dim">{label}</dt>
      <dd className={`num text-sm ${tone}`}>${fmt(value)}</dd>
    </div>
  );
}

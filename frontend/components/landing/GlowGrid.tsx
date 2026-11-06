"use client";
import { useEffect, useRef, type CSSProperties } from "react";
import { FlickeringGrid } from "@/components/ui/flickering-grid";
import { reducedMotion } from "@/lib/gsap";
import { cn } from "@/lib/utils";

/**
 * Flickering grid that glows from an origin. Three layers share the same cells, each masked by a radial ellipse
 * centred on (--gx, --gy), so squares deepen toward the origin and fade out around it.
 *  - tone "light": on the page background, light → brand → deep orange.
 *  - tone "orange": on a solid brand-orange field, peach → white squares.
 *  - follow: the glow chases the pointer while it is over the parent element, then eases back to `origin`.
 */
export function GlowGrid({ className, intensity = 1, origin = "50% 100%", tone = "light", follow = false }: { className?: string; intensity?: number; origin?: string; tone?: "light" | "orange"; follow?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const [ox, oy] = (origin.match(/-?[\d.]+/g) ?? ["50", "100"]).map(Number);

  useEffect(() => {
    const el = root.current;
    const host = el?.parentElement;
    if (!follow || !el || !host) return;
    const cur = { x: ox, y: oy };
    const target = { x: ox, y: oy };
    let raf = 0;
    const write = () => {
      el.style.setProperty("--gx", `${cur.x.toFixed(2)}%`);
      el.style.setProperty("--gy", `${cur.y.toFixed(2)}%`);
    };
    const step = () => {
      const k = reducedMotion() ? 1 : 0.14; // ease toward the pointer each frame
      cur.x += (target.x - cur.x) * k;
      cur.y += (target.y - cur.y) * k;
      write();
      raf = Math.abs(target.x - cur.x) + Math.abs(target.y - cur.y) > 0.05 ? requestAnimationFrame(step) : 0;
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(step);
    };
    const move = (e: PointerEvent) => {
      const r = host.getBoundingClientRect();
      target.x = ((e.clientX - r.left) / r.width) * 100;
      target.y = ((e.clientY - r.top) / r.height) * 100;
      kick();
    };
    const leave = () => {
      target.x = ox;
      target.y = oy;
      kick();
    };
    host.addEventListener("pointermove", move);
    host.addEventListener("pointerleave", leave);
    return () => {
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerleave", leave);
      cancelAnimationFrame(raf);
    };
  }, [follow, ox, oy]);

  const at = "at var(--gx) var(--gy)";
  const mask = (w: number, h: number): CSSProperties => {
    const m = `radial-gradient(ellipse ${w}% ${h}% ${at}, #000 0%, rgba(0,0,0,0.85) 35%, rgba(0,0,0,0.35) 65%, transparent 100%)`;
    return { maskImage: m, WebkitMaskImage: m };
  };
  const grid = { squareSize: 5, gridGap: 6, flickerChance: 0.18 } as const;
  const orange = tone === "orange";
  const layers = orange
    ? [
        { color: "#FF8A57", op: 0.55, w: 95, h: 72 },
        { color: "#FFC2A6", op: 0.7, w: 68, h: 56 },
        { color: "#FFFFFF", op: 0.85, w: 40, h: 38 },
      ]
    : [
        { color: "#FF9466", op: 0.75, w: 90, h: 66 },
        { color: "#FF4D00", op: 0.9, w: 64, h: 52 },
        { color: "#D93F00", op: 1, w: 38, h: 34 },
      ];
  const wash = orange
    ? `radial-gradient(ellipse 75% 65% ${at}, #ff8d5c 0%, #ff6a2a 35%, rgba(255,77,0,0.5) 60%, transparent 85%)`
    : `radial-gradient(ellipse 75% 60% ${at}, #ffb08c 0%, #ffd0bb 30%, rgba(255,222,207,0.55) 55%, transparent 80%)`;
  return (
    <div
      ref={root}
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 isolate overflow-hidden", orange ? "bg-trade" : "bg-background", className)}
      style={{ ["--gx" as string]: `${ox}%`, ["--gy" as string]: `${oy}%` } as CSSProperties}
    >
      <div className="absolute inset-0" style={{ opacity: 0.9 * intensity, background: wash }} />
      {layers.map((l) => (
        <FlickeringGrid key={l.color} className="absolute inset-0 size-full" {...grid} color={l.color} maxOpacity={l.op * intensity} style={mask(l.w, l.h)} />
      ))}
    </div>
  );
}

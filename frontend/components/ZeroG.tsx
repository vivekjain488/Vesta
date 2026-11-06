/**
 * The 0G mark (paths taken from 0g.ai's own header logo). Renders in currentColor so it inherits text colour.
 * Use ZeroGText to show any string with the literal "0G" replaced by the mark; screen readers still hear "0G".
 */
import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

const P1 = "M12.7564 76.599C27.9701 90.3547 51.4889 89.9098 66.166 75.2651C81.302 60.1612 81.302 35.6736 66.166 20.5697C51.0293 5.4662 26.4887 5.4662 11.3523 20.5697C-2.85916 34.7506 -3.72755 57.2033 8.747 72.3955L21.1931 59.9763C15.4656 51.6888 16.2964 40.2495 23.6854 32.8765C32.0103 24.5694 45.5079 24.5694 53.8332 32.8765C62.1575 41.1836 62.1575 54.6519 53.8332 62.9589C47.4416 69.3364 38.0017 70.8179 30.1942 67.4029L51.0922 46.5499L46.9813 42.4482L12.7564 76.599Z";
const P2 = "M160 49.967C158.99 70.4282 142.045 86.7085 121.288 86.7085C99.8824 86.7085 82.5293 69.3927 82.5293 48.0328C82.5293 26.6729 99.8824 9.35762 121.288 9.35762C141.386 9.35762 157.912 24.6218 159.857 44.1657H142.255C140.432 34.2641 131.738 26.7618 121.289 26.7618C109.515 26.7618 99.9709 36.2851 99.9709 48.0328C99.9709 59.7812 109.515 69.3046 121.289 69.3046C130.327 69.3046 138.052 63.6914 141.153 55.7684H111.598V49.967H160Z";

/** Standalone mark. Default size follows the surrounding font size (≈ cap height). */
export function ZeroGMark({ className, style, title = "0G" }: { className?: string; style?: CSSProperties; title?: string }) {
  return (
    <svg viewBox="0 9 160 78" fill="currentColor" role="img" aria-label={title} className={cn("inline-block h-[0.74em] w-auto shrink-0", className)} style={style}>
      <path d={P1} />
      <path d={P2} />
    </svg>
  );
}

/** For use inside another SVG: draws the mark at (x, y) with the given height. */
export function ZeroGGlyph({ x, y, height, fill = "currentColor" }: { x: number; y: number; height: number; fill?: string }) {
  const s = height / 78;
  return (
    <g transform={`translate(${x} ${y}) scale(${s}) translate(0 -9)`} fill={fill} aria-label="0G">
      <path d={P1} />
      <path d={P2} />
    </g>
  );
}
export const ZERO_G_ASPECT = 160 / 78;

/** Text with every literal "0G" swapped for the inline mark. */
export function ZeroGText({ text, className, markClassName }: { text: string; className?: string; markClassName?: string }) {
  const parts = text.split(/(0G)/);
  if (parts.length === 1) return <span className={className}>{text}</span>;
  return (
    <span className={className}>
      {parts.map((p, i) => (p === "0G" ? <ZeroGMark key={i} className={cn("mx-[0.08em] align-[-0.06em]", markClassName)} /> : p))}
    </span>
  );
}

/** Icon-shaped wrapper so the mark can stand in for a lucide icon (`<Icon className="size-4" />`). */
export function ZeroGIcon({ className }: { className?: string; strokeWidth?: number }) {
  // a square icon box (e.g. size-4); the wide mark is letterboxed inside it by the viewBox
  return <ZeroGMark className={cn("size-4 scale-[1.35]", className)} />;
}

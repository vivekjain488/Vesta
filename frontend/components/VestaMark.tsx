import { cn } from "@/lib/utils";

/**
 * The VESTA logo (frontend/design/vesta.svg, converted to a transparent mask at /vesta.svg).
 * It is drawn with the current text colour, so it follows light, dark and orange surfaces. Set the height with a class
 * such as `h-8`; the width follows the logo's aspect ratio.
 */
export function VestaMark({ className }: { className?: string }) {
  const mask = "url(/vesta.svg) center / contain no-repeat";
  return <span role="img" aria-label="VESTA" className={cn("inline-block aspect-[1500/1294] shrink-0 bg-current", className)} style={{ mask, WebkitMask: mask }} />;
}

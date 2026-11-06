"use client";
/** Restrained GSAP motion primitives. Every effect is skipped when the user prefers reduced motion. */
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { dur, gsap, reducedMotion, SplitText, useGSAP } from "@/lib/gsap";

/** Serif page title that reveals word by word inside line masks (SplitText). */
export function SplitHeading({ children, className, as: Tag = "h1" }: { children: ReactNode; className?: string; as?: "h1" | "h2" }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useGSAP(
    () => {
      if (!ref.current || reducedMotion()) return;
      const split = SplitText.create(ref.current, {
        type: "words,lines",
        mask: "lines",
        autoSplit: true,
        onSplit: (self) => gsap.from(self.words, { yPercent: 110, duration: 0.7, ease: "power3.out", stagger: 0.05 }),
      });
      return () => split.revert();
    },
    { scope: ref },
  );
  return (
    <Tag ref={ref} className={className}>
      {children}
    </Tag>
  );
}

/**
 * A number that tweens to each new value (counts up from zero on first mount). The animated text is aria-hidden;
 * screen readers get the final formatted value only, so live regions are not flooded with intermediate frames.
 */
export function AnimatedNumber({ value, format, className }: { value: number; format: (n: number) => string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const state = useRef({ v: 0, mounted: false });
  const fmtRef = useRef(format);
  fmtRef.current = format;
  useGSAP(
    () => {
      const el = ref.current;
      if (!el || !Number.isFinite(value)) return;
      const first = !state.current.mounted;
      state.current.mounted = true;
      const write = () => (el.textContent = fmtRef.current(state.current.v));
      gsap.killTweensOf(state.current);
      const d = dur(first ? 0.6 : 0.35);
      if (d === 0) {
        state.current.v = value;
        write();
        return;
      }
      gsap.to(state.current, { v: value, duration: d, ease: "power2.out", onUpdate: write, onComplete: write });
    },
    { dependencies: [value] },
  );
  return (
    <span className={className}>
      <span ref={ref} aria-hidden>
        {format(value)}
      </span>
      <span className="sr-only">{format(value)}</span>
    </span>
  );
}

/** Cross-fade a container's children whenever `key` changes (not on first mount). */
export function useSwapFade(ref: RefObject<HTMLElement | null>, key: unknown) {
  const first = useRef(true);
  useGSAP(
    () => {
      if (first.current) {
        first.current = false;
        return;
      }
      if (!ref.current || reducedMotion()) return;
      gsap.fromTo(ref.current.children, { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0, duration: 0.25, ease: "power2.out", stagger: 0.03, clearProps: "opacity,visibility,transform" });
    },
    { dependencies: [key] },
  );
}

/** Smooth scroll to an element id (ScrollToPlugin), leaving room above it. */
export function scrollToId(id: string, offsetY = 24) {
  const target = document.getElementById(id);
  if (!target) return false;
  gsap.to(window, { scrollTo: { y: target, offsetY }, duration: dur(0.7), ease: "power2.inOut" });
  history.replaceState(null, "", `#${id}`);
  return true;
}

/** On arrival with a #hash, scroll to it once the target exists (content loads after data arrives). */
export function useHashScroll(ready: boolean) {
  const done = useRef(false);
  useEffect(() => {
    if (!ready || done.current) return;
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id) return;
    // Panels below load their own data; wait until the page height settles (max ~2s) so the target stops moving.
    let last = -1;
    let stable = 0;
    let ticks = 0;
    const timer = window.setInterval(() => {
      const h = document.documentElement.scrollHeight;
      stable = h === last ? stable + 1 : 0;
      last = h;
      if (stable >= 2 || ++ticks > 13) {
        window.clearInterval(timer);
        done.current = true;
        scrollToId(id);
      }
    }, 150);
    return () => window.clearInterval(timer);
  }, [ready]);
}

/** Bar width driven by GSAP so it grows on mount and eases between values. */
export function useBarTween(refs: RefObject<HTMLElement | null>[], styles: gsap.TweenVars[], deps: unknown[]) {
  useGSAP(
    () => {
      refs.forEach((r, i) => {
        if (!r.current) return;
        gsap.to(r.current, { ...styles[i], duration: dur(0.5), ease: "power2.out", overwrite: "auto" });
      });
    },
    { dependencies: deps },
  );
}

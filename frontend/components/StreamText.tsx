"use client";
import { useEffect, useRef, useState } from "react";
import { reducedMotion } from "@/lib/gsap";
import { cn } from "@/lib/utils";

/**
 * Typewriter / LLM-style streaming text. Reveals in small irregular chunks with a blinking caret, at ~55 chars/s but
 * never longer than `maxMs`, then calls onDone. When `animate` is false (old messages) or the user prefers reduced
 * motion, the full text renders immediately. Screen readers always get the complete text once.
 */
export function StreamText({ text, animate = true, maxMs = 2200, delayMs = 0, onDone, className }: { text: string; animate?: boolean; maxMs?: number; delayMs?: number; onDone?: () => void; className?: string }) {
  const instant = !animate || reducedMotion();
  const [count, setCount] = useState(instant ? text.length : 0);
  const done = count >= text.length;
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (instant) {
      setCount(text.length);
      doneRef.current?.();
      return;
    }
    setCount(0);
    const cps = Math.max(55, (text.length / maxMs) * 1000);
    let raf = 0;
    let shown = 0;
    let start = 0;
    let carry = 0;
    let last = 0;
    const tick = (now: number) => {
      if (!start) start = last = now + delayMs;
      if (now < start) {
        raf = requestAnimationFrame(tick);
        return;
      }
      carry += ((now - last) / 1000) * cps * (0.6 + Math.random() * 0.8); // irregular, like tokens arriving
      last = now;
      const step = Math.floor(carry);
      if (step > 0) {
        carry -= step;
        shown = Math.min(text.length, shown + step);
        setCount(shown);
      }
      if (shown < text.length) raf = requestAnimationFrame(tick);
      else doneRef.current?.();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, instant, maxMs, delayMs]);

  return (
    <span className={className}>
      <span aria-hidden>
        {text.slice(0, count)}
        {!done && <span className="type-caret" />}
      </span>
      <span className="sr-only">{text}</span>
    </span>
  );
}

/** Wrapper whose children pop in (staggered) once `show` turns true, e.g. chips after a message finishes typing. */
export function PopGroup({ show, children, className, step = 70 }: { show: boolean; children: React.ReactNode[] | React.ReactNode; className?: string; step?: number }) {
  if (!show) return null;
  const items = Array.isArray(children) ? children.filter(Boolean) : [children];
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {items.map((c, i) => (
        <span key={i} className="pop-in inline-flex" style={{ ["--pop-delay" as string]: `${i * step}ms` }}>
          {c}
        </span>
      ))}
    </div>
  );
}

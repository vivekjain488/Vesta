"use client";
/**
 * Site-wide entrance motion. Every card, table row and [data-reveal] element rises and scales into place the first
 * time it is on screen, staggered in document order. Content that mounts later (data loads, route changes, new rows
 * or messages) is picked up by a MutationObserver, so it pops in too. Elements animate once; skipped for reduced motion.
 *
 * data-reveal variants: "" / "up" (default), "down", "left", "right", "fade".
 */
import { useRef, type ReactNode } from "react";
import { gsap, reducedMotion, useGSAP } from "@/lib/gsap";

const SELECTOR = '[data-slot="card"], [data-slot="table-row"], [data-reveal]';

const fromVars = (el: HTMLElement): gsap.TweenVars => {
  switch (el.dataset.reveal) {
    case "right": return { x: 32 };
    case "left": return { x: -32 };
    case "down": return { y: -20 };
    case "fade": return {};
    default: return { y: el.dataset.slot === "table-row" ? 14 : 40, scale: el.dataset.slot === "table-row" ? 1 : 0.95 };
  }
};

export function RevealRoot({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const host = root.current;
      if (!host || reducedMotion() || typeof IntersectionObserver === "undefined") return;
      let queue: HTMLElement[] = [];
      let frame = 0;

      const flush = () => {
        frame = 0;
        const batch = queue.splice(0).sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
        gsap.to(batch, {
          autoAlpha: 1,
          x: 0,
          y: 0,
          scale: 1,
          duration: 0.95,
          ease: "power4.out",
          // ~65ms between items, but a long batch (e.g. a table) never takes more than 0.9s to finish cascading.
          stagger: { amount: Math.min(0.9, Math.max(0, batch.length - 1) * 0.065) },
          clearProps: "opacity,visibility,transform",
        });
      };

      const io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            io.unobserve(e.target);
            queue.push(e.target as HTMLElement);
          }
          if (queue.length && !frame) frame = requestAnimationFrame(flush);
        },
        { rootMargin: "0px 0px -4% 0px" },
      );

      const register = (el: HTMLElement) => {
        if (el.hasAttribute("data-revealed")) return; // persistent chrome (rail, nav) animates only on first load
        el.setAttribute("data-revealed", "");
        gsap.set(el, { autoAlpha: 0, ...fromVars(el) });
        // Fixed chrome (rail, mobile nav) is always on screen and can sit inside the trigger margin: reveal right away.
        if (getComputedStyle(el).position === "fixed" || el.parentElement?.closest("aside")) {
          queue.push(el);
          if (!frame) frame = requestAnimationFrame(flush);
          return;
        }
        io.observe(el);
      };
      const scan = (node: Node) => {
        if (!(node instanceof HTMLElement)) return;
        if (node.matches(SELECTOR)) register(node);
        node.querySelectorAll<HTMLElement>(SELECTOR).forEach(register);
      };

      scan(host);
      // MutationObserver callbacks run as microtasks before paint, so late content never flashes before hiding.
      const mo = new MutationObserver((records) => records.forEach((r) => r.addedNodes.forEach(scan)));
      mo.observe(host, { childList: true, subtree: true });

      return () => {
        mo.disconnect();
        io.disconnect();
        cancelAnimationFrame(frame);
      };
    },
    { scope: root },
  );
  return <div ref={root}>{children}</div>;
}

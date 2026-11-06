"use client";
/**
 * Dark live-progress sheet (reference: "Grid bot starting" → steps → "Placed 23 of 24 orders"). It never drives a
 * transaction: it only *reads* the status messages an existing flow already emits, maps them onto steps, and shows
 * success/failure when the flow's busy flag clears. The page behind blurs while it is open.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Bot, Check, Loader2, X } from "lucide-react";
import { BorderBeam } from "@/components/ui/border-beam";
import { dur, gsap, useGSAP } from "@/lib/gsap";
import { cn } from "@/lib/utils";

export interface FlowStep {
  label: string;
  /** Status message(s) that mean this step is in progress. */
  match: RegExp;
  /** Heading shown while this step is active. */
  title: string;
}

type Status = "working" | "done" | "error";

/** Derive sheet state from an existing flow's (busy, message) pair. Opens lazily on the first step message. */
export function useActionFlow({ busy, message, steps, success }: { busy: boolean; message: string; steps: FlowStep[]; success: RegExp }) {
  const [state, setState] = useState<{ open: boolean; active: number; status: Status; footer: string }>({ open: false, active: 0, status: "working", footer: "" });
  const wasBusy = useRef(false);
  useEffect(() => {
    const idx = message ? steps.findIndex((s) => s.match.test(message)) : -1;
    if (busy) {
      if (idx >= 0) setState((s) => ({ open: true, active: Math.max(s.open ? s.active : 0, idx), status: "working", footer: message }));
    } else if (wasBusy.current) {
      setState((s) => (s.open ? { ...s, active: success.test(message) ? steps.length : s.active, status: success.test(message) ? "done" : "error", footer: message || "Something went wrong" } : s));
    }
    wasBusy.current = busy;
  }, [busy, message]); // eslint-disable-line react-hooks/exhaustive-deps
  // Success closes itself after a beat; errors wait for the user.
  useEffect(() => {
    if (state.status !== "done" || !state.open) return;
    const t = setTimeout(() => setState((s) => ({ ...s, open: false })), 3200);
    return () => clearTimeout(t);
  }, [state.status, state.open]);
  return { ...state, steps, close: () => setState((s) => ({ ...s, open: false })) };
}

export function ActionSheet({ flow, tag, figure, doneTitle = "Done", errorTitle = "Didn't complete" }: { flow: ReturnType<typeof useActionFlow>; tag: string; figure?: ReactNode; doneTitle?: string; errorTitle?: string }) {
  const [mounted, setMounted] = useState(false);
  const [present, setPresent] = useState(false); // stays true during the exit animation
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (flow.open) setPresent(true);
  }, [flow.open]);

  // Enter / exit choreography.
  useGSAP(
    () => {
      const el = root.current;
      if (!el || !present) return;
      const backdrop = el.querySelector<HTMLElement>("[data-sheet-backdrop]");
      const sheet = el.querySelector<HTMLElement>("[data-sheet]");
      const parts = el.querySelectorAll<HTMLElement>("[data-sheet-part]");
      if (flow.open) {
        gsap.fromTo(backdrop, { opacity: 0, backdropFilter: "blur(0px)" }, { opacity: 1, backdropFilter: "blur(10px)", duration: dur(0.45), ease: "power2.out" });
        gsap.fromTo(sheet, { yPercent: 110, scale: 0.96 }, { yPercent: 0, scale: 1, duration: dur(0.7), ease: "back.out(1.2)" });
        gsap.fromTo(parts, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: dur(0.5), ease: "power3.out", stagger: 0.06, delay: dur(0.2) });
      } else {
        gsap.to(sheet, { yPercent: 115, duration: dur(0.45), ease: "power3.in" });
        gsap.to(backdrop, { opacity: 0, backdropFilter: "blur(0px)", duration: dur(0.45), ease: "power2.in", onComplete: () => setPresent(false) });
      }
    },
    { dependencies: [flow.open, present], scope: root },
  );

  useEffect(() => {
    if (!flow.open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && flow.close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flow.open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!mounted || !present) return null;
  const step = flow.steps[Math.min(flow.active, flow.steps.length - 1)];
  const title = flow.status === "done" ? doneTitle : flow.status === "error" ? errorTitle : step?.title;
  const tone = flow.status === "done" ? "done" : flow.status === "error" ? "error" : "working";

  return createPortal(
    <div ref={root} className="fixed inset-0 z-50">
      <div data-sheet-backdrop className="absolute inset-0 bg-[#f5f5f3]/45" onClick={() => flow.status !== "working" && flow.close()} />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-4 lg:justify-start lg:pr-[112px] lg:pl-6">
        <section
          data-sheet
          role="dialog"
          aria-modal="true"
          aria-live="polite"
          aria-label={title}
          className="pointer-events-auto relative w-full max-w-[560px] overflow-hidden rounded-[28px] bg-[#0b0b0b] text-white shadow-[0_30px_80px_-20px_rgba(0,0,0,0.55)]"
        >
          {tone === "working" && <BorderBeam size={120} duration={5} borderWidth={1.5} colorFrom="#5B7CFA" colorTo="#FF4D00" />}
          <div className="px-6 pt-3 pb-6">
            <div className="mx-auto h-1 w-10 rounded-full bg-white/20" aria-hidden />
            <div data-sheet-part className="mt-3 flex items-center justify-between">
              <span className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs text-white/85">
                <span className="size-1.5 rounded-full bg-trade" aria-hidden /> {tag}
              </span>
              <button onClick={flow.close} aria-label="Close" className="flex size-8 items-center justify-center rounded-full bg-white/10 text-white/80 transition-colors hover:bg-white/20">
                <X className="size-4" />
              </button>
            </div>
            <div data-sheet-part className="mt-5 flex items-start gap-3">
              <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", tone === "done" ? "bg-profit" : tone === "error" ? "bg-loss" : "bg-brand")} aria-hidden>
                {tone === "done" ? <Check className="size-4" /> : tone === "error" ? <X className="size-4" /> : <Bot className="size-4" />}
              </span>
              <div key={`${tone}:${title}`} className="pop-in min-w-0">
                <p className="text-xl font-medium tracking-tight">{title}</p>
                <p className="mt-0.5 text-sm text-white/65">{tone === "working" ? `Step ${flow.active + 1} of ${flow.steps.length}` : tone === "done" ? "All steps confirmed on-chain" : "No further steps were taken"}</p>
              </div>
            </div>
            {figure && (
              <div data-sheet-part className="num mt-5 text-[2.4rem] leading-none font-semibold tracking-tight">
                {figure}
              </div>
            )}
            <div data-sheet-part className="mt-8 grid gap-2" style={{ gridTemplateColumns: `repeat(${flow.steps.length}, minmax(0, 1fr))` }}>
              {flow.steps.map((s, i) => {
                const complete = i < flow.active || flow.status === "done";
                const current = i === flow.active && flow.status !== "done";
                return (
                  <div key={s.label}>
                    <div className="relative h-[3px] overflow-hidden rounded-full bg-white/15">
                      <div
                        className={cn("absolute inset-y-0 left-0 rounded-full transition-[width,background-color] duration-500 ease-out", current && flow.status === "error" ? "bg-loss" : "bg-white")}
                        style={{ width: complete ? "100%" : current ? "45%" : "0%" }}
                      />
                      {current && flow.status === "working" && <div className="step-sweep absolute inset-y-0 w-1/3 rounded-full bg-gradient-to-r from-transparent via-white/80 to-transparent" />}
                    </div>
                    <p className={cn("mt-2 text-xs transition-colors duration-300", complete || current ? "text-white" : "text-white/40")}>{s.label}</p>
                  </div>
                );
              })}
            </div>
          </div>
          <div
            className={cn(
              "flex items-center justify-center gap-2 px-6 py-3.5 text-sm transition-colors duration-500",
              tone === "done" ? "bg-profit/20 text-[#4ade80]" : tone === "error" ? "bg-loss/20 text-[#ff8a88]" : "bg-trade/15 text-trade",
            )}
          >
            {tone === "done" ? <Check className="size-4 shrink-0" /> : tone === "error" ? <X className="size-4 shrink-0" /> : <Loader2 className="size-4 shrink-0 animate-spin" />}
            <span key={flow.footer} className="pop-in line-clamp-2 text-center">{flow.footer}</span>
          </div>
        </section>
      </div>
    </div>,
    document.body,
  );
}

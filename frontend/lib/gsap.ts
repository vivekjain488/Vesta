"use client";
/** Single place where GSAP plugins are registered (once, at module load, never inside a component). */
import gsap from "gsap";
import { Flip } from "gsap/Flip";
import { ScrollToPlugin } from "gsap/ScrollToPlugin";
import { SplitText } from "gsap/SplitText";
import { useGSAP } from "@gsap/react";

if (typeof window !== "undefined") gsap.registerPlugin(useGSAP, Flip, SplitText, ScrollToPlugin);

/** Motion stays restrained and is skipped entirely for users who ask for reduced motion. */
export const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
export const dur = (seconds: number) => (reducedMotion() ? 0 : seconds);

export { gsap, Flip, ScrollToPlugin, SplitText, useGSAP };

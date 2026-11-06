"use client";
/**
 * Who calls whom when a VESTA agent trades, drawn like an agent graph: orthogonal rounded links, icon tiles with
 * labels, light trails for calls (blue), answers (green) and money (orange). Illustrative, not live data.
 */
import { Bot, Brain, Database, Link2, ShieldCheck, User, Vault, Zap, type LucideIcon } from "lucide-react";
import { useEffect, useRef, type CSSProperties } from "react";
import { reducedMotion } from "@/lib/gsap";
import { ZeroGIcon, ZeroGText } from "../ZeroG";
import { cn } from "@/lib/utils";

const W = 960;
const H = 560;
type P = [number, number];
type Kind = "call" | "value";

/** Orthogonal polyline with rounded corners. */
function route(pts: P[], r = 14) {
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1];
    const [x, y] = pts[i];
    const [nx, ny] = pts[i + 1];
    const inLen = Math.hypot(x - px, y - py);
    const outLen = Math.hypot(nx - x, ny - y);
    const k1 = Math.min(r, inLen / 2) / inLen;
    const k2 = Math.min(r, outLen / 2) / outLen;
    d += ` L${x - (x - px) * k1} ${y - (y - py) * k1} Q${x} ${y} ${x + (nx - x) * k2} ${y + (ny - y) * k2}`;
  }
  const [lx, ly] = pts[pts.length - 1];
  return `${d} L${lx} ${ly}`;
}

const TILES: { id: string; x: number; y: number; name: string; detail: string; icon: LucideIcon; cls: string; badge?: { text: string; cls: string } }[] = [
  { id: "you", x: 300, y: 80, name: "You", detail: "Owner wallet", icon: User, cls: "bg-card text-foreground ring-1 ring-border" },
  { id: "arkiv", x: 660, y: 80, name: "Arkiv", detail: "Signals · decisions", icon: Database, cls: "bg-card text-foreground ring-1 ring-border" },
  { id: "zg", x: 170, y: 250, name: "0G Compute", detail: "TEE-signed inference", icon: ZeroGIcon as unknown as LucideIcon, cls: "bg-brand text-white" },
  { id: "gate", x: 790, y: 250, name: "RiskGate", detail: "F · C · E on-chain", icon: ShieldCheck, cls: "bg-primary text-primary-foreground", badge: { text: "Approved", cls: "bg-profit text-white" } },
  { id: "flash", x: 300, y: 440, name: "Flash", detail: "Bracket orders", icon: Zap, cls: "bg-[#FF4D00] text-foreground", badge: { text: "Live", cls: "bg-primary text-white" } },
  { id: "vault", x: 660, y: 440, name: "Vault", detail: "Floor locked", icon: Vault, cls: "bg-card text-foreground ring-1 ring-border" },
  { id: "ccip", x: 860, y: 440, name: "CCIP", detail: "Fees → 0G chain", icon: Link2, cls: "bg-card text-foreground ring-1 ring-border" },
];

const LINKS: { pts: P[]; label: string; at: P; kind: Kind; answer?: boolean; dur: number; delay: number }[] = [
  { pts: [[300, 150], [300, 190], [460, 190], [460, 272]], label: "MANDATE", at: [380, 182], kind: "call", dur: 3.4, delay: 0 },
  { pts: [[390, 300], [320, 300], [320, 250], [196, 250]], label: "REASON", at: [258, 242], kind: "call", answer: true, dur: 2.6, delay: 0.5 },
  { pts: [[570, 300], [640, 300], [640, 250], [764, 250]], label: "APPROVE ORDER", at: [702, 242], kind: "call", answer: true, dur: 2.6, delay: 1.2 },
  { pts: [[790, 320], [790, 360], [660, 360], [660, 414]], label: "FUND ≤ E", at: [725, 352], kind: "value", dur: 3, delay: 1.9 },
  { pts: [[470, 328], [470, 380], [300, 380], [300, 414]], label: "BRACKET", at: [385, 372], kind: "call", answer: true, dur: 2.8, delay: 2.4 },
  { pts: [[500, 272], [500, 170], [660, 170], [660, 150]], label: "COMMIT", at: [580, 162], kind: "call", dur: 3, delay: 0.9 },
  { pts: [[686, 440], [834, 440]], label: "HARVEST", at: [760, 432], kind: "value", dur: 2.4, delay: 2.8 },
  { pts: [[886, 440], [918, 440], [918, 524], [96, 524], [96, 250], [144, 250]], label: "PAY FOR COMPUTE", at: [500, 516], kind: "value", dur: 5.2, delay: 3.2 },
];

const color = { call: "#5B7CFA", answer: "#16A36A", value: "#FF4D00" };

/** Thin light streak: a faint tail and a bright head moving in lockstep (no blur filter, so it stays smooth). */
const HEAD = 60;
const TAIL = 150;
const EASE = "cubic-bezier(0.37, 0, 0.63, 1)"; // sine in-out

/**
 * Thin light streak with a fading tail, sized in real path units (same length on every route). Animated with the Web
 * Animations API so each path gets exact keyframes; skipped entirely for reduced motion.
 */
function Streak({ d, len, color: c, dur, delay }: { d: string; len: number; color: string; dur: number; delay: number }) {
  const head = useRef<SVGPathElement>(null);
  const tail = useRef<SVGPathElement>(null);
  const L = Math.round(len);
  useEffect(() => {
    if (reducedMotion() || !head.current || !tail.current) return;
    const timing: KeyframeAnimationOptions = { duration: dur * 1000, delay: delay * 1000, iterations: Infinity, easing: EASE };
    const a = head.current.animate([{ strokeDashoffset: HEAD }, { strokeDashoffset: -L }], timing);
    // the tail ends exactly where the head begins, for the whole run
    const b = tail.current.animate([{ strokeDashoffset: HEAD + TAIL }, { strokeDashoffset: TAIL - L }], timing);
    return () => {
      a.cancel();
      b.cancel();
    };
  }, [L, dur, delay]);
  const hidden: CSSProperties = { strokeDashoffset: HEAD + TAIL + 1 };
  return (
    <>
      <path ref={tail} d={d} pathLength={L} fill="none" stroke={c} strokeWidth="1.4" strokeLinecap="round" strokeDasharray={`${TAIL} ${L + TAIL * 2}`} opacity={0.26} style={hidden} />
      <path ref={head} d={d} pathLength={L} fill="none" stroke={c} strokeWidth="1.6" strokeLinecap="round" strokeDasharray={`${HEAD} ${L + TAIL * 2}`} style={hidden} />
    </>
  );
}
const lengthOf = (pts: P[]) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
const pct = (x: number, y: number) => ({ left: `${(x / W) * 100}%`, top: `${(y / H) * 100}%` });

export function AgentGraph({ className }: { className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-[28px] bg-card shadow-[0_1px_2px_rgba(17,17,17,0.03),0_0_0_1px_rgba(17,17,17,0.04)]", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-4">
        <p className="flex items-center gap-2 text-sm font-medium">
          <span className="size-2 rounded-full bg-brand shadow-[0_0_0_4px_rgba(91,124,250,0.18)]" /> Agent graph
        </p>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span><b className="font-medium text-foreground">1</b> agent</span>
          <span><b className="font-medium text-foreground">7</b> services</span>
          <span><b className="font-medium text-foreground">8</b> links</span>
          <span className="micro rounded-full bg-trade-soft px-2 py-0.5 text-trade-deep">Example</span>
        </p>
      </div>
      <div className="overflow-x-auto [scrollbar-width:none]">
        <div className="relative mx-4 mb-2 aspect-[960/560] min-w-[720px] rounded-[22px] bg-muted/60">
          <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 size-full" aria-hidden>
            <defs>
              <radialGradient id="lead-glow">
                <stop offset="0%" stopColor="#5B7CFA" stopOpacity="0.28" />
                <stop offset="100%" stopColor="#5B7CFA" stopOpacity="0" />
              </radialGradient>
            </defs>
            <ellipse cx="480" cy="300" rx="190" ry="120" fill="url(#lead-glow)" className="breathe" />
            {LINKS.map((l, i) => {
              const d = route(l.pts);
              const back = route([...l.pts].reverse());
              const c = color[l.kind];
              return (
                <g key={i}>
                  <path d={d} fill="none" stroke="#E2E2DE" strokeWidth="1.2" />
                  <Streak d={d} len={lengthOf(l.pts)} color={c} dur={l.dur} delay={l.delay} />
                  {l.answer && <Streak d={back} len={lengthOf(l.pts)} color={color.answer} dur={l.dur} delay={l.delay + l.dur / 2} />}
                  <text x={l.at[0]} y={l.at[1]} textAnchor="middle" fill="#A3A3A3" style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, letterSpacing: "0.08em" }}>{l.label}</text>
                </g>
              );
            })}
          </svg>

          {/* lead agent card */}
          <div className="absolute -translate-x-1/2 -translate-y-1/2" style={pct(480, 300)}>
            <div className="flex w-[180px] items-center gap-2.5 rounded-2xl bg-card p-2 shadow-[0_12px_30px_-16px_rgba(91,124,250,0.55),0_0_0_1px_rgba(17,17,17,0.05)]">
              <span className="relative flex size-10 items-center justify-center rounded-xl bg-brand text-white">
                <Bot className="size-5" strokeWidth={1.75} />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">Your agent</span>
                <span className="block truncate text-[11px] text-muted-foreground">Momentum · Thrive</span>
              </span>
              <span className="micro absolute -top-2 right-2 rounded-full bg-primary px-1.5 py-0.5 text-[9px] text-white">Thinking</span>
            </div>
          </div>

          {TILES.map((t) => {
            const Icon = t.icon;
            return (
              <div key={t.id} className="absolute flex flex-col items-center" style={{ ...pct(t.x, t.y), transform: "translate(-50%, -26px)" }} aria-label={`${t.name}, ${t.detail}${t.badge ? `, ${t.badge.text}` : ""}`}>
                <span className={cn("relative flex size-[52px] items-center justify-center rounded-2xl shadow-[0_8px_20px_-14px_rgba(17,17,17,0.45)]", t.cls)}>
                  <Icon className="size-5" strokeWidth={1.75} />
                  {t.badge && <span className={cn("micro absolute -top-2 -right-3 rounded-full px-1.5 py-0.5 text-[9px]", t.badge.cls)}>{t.badge.text}</span>}
                </span>
                <span className="mt-2 text-xs font-medium whitespace-nowrap"><ZeroGText text={t.name} /></span>
                <span className="text-[11px] whitespace-nowrap text-muted-foreground"><ZeroGText text={t.detail} /></span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1 px-5 pt-1 pb-4 text-xs text-muted-foreground">
        {[["Call", color.call], ["Answer", color.answer], ["Money", color.value]].map(([n, c]) => (
          <span key={n} className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded-full" style={{ background: c }} /> {n}</span>
        ))}
        <span className="micro text-faint sm:hidden">Swipe to explore →</span>
      </div>
      <ul className="sr-only">
        <li>You set a mandate for your agent.</li>
        <li>The agent asks 0G Compute for reasoning, asks RiskGate to approve orders, places bracket orders on Flash, and commits signals to Arkiv.</li>
        <li>RiskGate funds the trading wallet from the vault up to the exposure limit; the vault harvests income over CCIP to pay for 0G compute.</li>
      </ul>
    </div>
  );
}

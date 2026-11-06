"use client";
/**
 * Skeleton-UI illustrations (card-in-tray, logo tile, branching light-trail lines) in the VESTA palette.
 * Motion is CSS only (stroke-dash light trails, scale fills, fades), so it stays smooth and pauses for reduced motion.
 * Illustrative only: values are examples, not live data.
 */
import type { CSSProperties, ReactNode } from "react";
import { ArrowLeftRight, Check, Coins, Link2, Lock, ShieldCheck, X } from "lucide-react";
import { ZeroGGlyph } from "../ZeroG";

const C = { trail: "#FF4D00", ink: "#111111", blue: "#5B7CFA", blueSoft: "#E9EEFF", orange: "#FF4D00", orangeSoft: "#FFE9DF", deep: "#C23A00", muted: "#F1F1F0", skel: "#EAEAE8", line: "#E3E3E0", faint: "#A3A3A3", green: "#16A36A", greenSoft: "#E3F5EC", red: "#E35D5B", redSoft: "#FCE9E8", white: "#FFFFFF" };
const mono: CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 7.5, letterSpacing: "0.08em" };
const geist: CSSProperties = { fontFamily: "var(--font-geist)" };
const vars = (dur: number, delay = 0) => ({ ["--dur" as string]: `${dur}s`, ["--delay" as string]: `${delay}s` }) as CSSProperties;

/** Back-compat export; motion is CSS-driven now. */
export function useMotionOK() {
  return true;
}

function Frame({ children, label }: { children: ReactNode; label: string }) {
  return (
    <svg viewBox="0 0 340 210" className="h-full w-full" role="img" aria-label={label}>
      <rect x="4" y="4" width="332" height="202" rx="20" fill={C.muted} />
      <rect x="16" y="16" width="308" height="178" rx="14" fill={C.white} stroke={C.line} />
      <g>{[0, 1, 2].map((i) => <circle key={i} cx={30 + i * 8} cy="28" r="2.3" fill={C.skel} />)}</g>
      {children}
    </svg>
  );
}

/** A grey track line plus a coloured light trail travelling along it. */
function Trail({ d, color, dur = 2.6, delay = 0, width = 1.4 }: { d: string; color: string; dur?: number; delay?: number; width?: number }) {
  return (
    <g>
      <path d={d} fill="none" stroke={C.line} strokeWidth={1.2} strokeLinecap="round" />
      <path d={d} pathLength={100} className="comet-tail" stroke={color} strokeWidth={width} style={vars(dur, delay)} />
      <path d={d} pathLength={100} className="comet" stroke={color} strokeWidth={width + 0.2} style={vars(dur, delay)} />
    </g>
  );
}

function Tile({ x, y, size = 40, fill, children, glow }: { x: number; y: number; size?: number; fill: string; children: ReactNode; glow?: string }) {
  return (
    <g>
      {glow && <rect x={x - 6} y={y - 6} width={size + 12} height={size + 12} rx={14} fill={glow} className="breathe" />}
      <rect x={x} y={y} width={size} height={size} rx={11} fill={fill} />
      <svg x={x + size / 2 - 9} y={y + size / 2 - 9} width="18" height="18" viewBox="0 0 24 24" overflow="visible">{children}</svg>
    </g>
  );
}

const Skel = ({ x, y, w, h = 5, fill = C.skel }: { x: number; y: number; w: number; h?: number; fill?: string }) => <rect x={x} y={y} width={w} height={h} rx={h / 2} fill={fill} />;

function Card({ x, y, w, h, children }: { x: number; y: number; w: number; h: number; children?: ReactNode }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx="9" fill={C.white} stroke={C.line} />
      {children}
    </g>
  );
}

/** 01: a deposit flows into the vault and splits into a locked floor and a tradable cushion. */
export function VaultIllustration() {
  return (
    <Frame label="A deposit flows into the vault and splits into a protected floor and a small tradable cushion">
      <Card x={30} y={52} w={96} h={112}>
        <text x="40" y="70" fill={C.faint} style={mono}>DEPOSIT</text>
        <text x="40" y="92" fill={C.ink} style={{ ...geist, fontSize: 17, fontWeight: 600 }}>1,000</text>
        <text x="40" y="104" fill={C.faint} style={mono}>USDC</text>
        <Skel x={40} y={120} w={60} />
        <Skel x={40} y={131} w={42} />
        <circle cx="108" cy="146" r="7" fill={C.orange} className="float-y" />
      </Card>
      <Trail d="M126 108 H150" color={C.blue} dur={2.8} />
      <Tile x={150} y={88} fill={C.ink} glow="rgba(91,124,250,0.18)">
        <Lock color="#fff" strokeWidth={2} />
      </Tile>
      <Trail d="M190 108 H198 C210 108 208 76 220 76 H234" color={C.blue} dur={2.8} delay={0.7} />
      <Trail d="M190 108 H198 C210 108 208 140 220 140 H234" color={C.trail} dur={2.8} delay={0.9} />
      <Card x={234} y={52} w={78} h={48}>
        <text x="244" y="68" fill="#4869EB" style={mono}>FLOOR · 96%</text>
        <rect x="244" y="78" width="58" height="7" rx="3.5" fill={C.blueSoft} />
        <rect x="244" y="78" width="56" height="7" rx="3.5" fill={C.blue} className="bar-fill" style={vars(5.6, 0.9)} />
      </Card>
      <Card x={234} y={116} w={78} h={48}>
        <text x="244" y="132" fill={C.deep} style={mono}>CUSHION · 4%</text>
        <rect x="244" y="142" width="58" height="7" rx="3.5" fill={C.orangeSoft} />
        <rect x="244" y="142" width="22" height="7" rx="3.5" fill={C.orange} className="bar-fill" style={vars(5.6, 1.1)} />
      </Card>
      <text x="170" y="150" textAnchor="middle" fill={C.faint} style={mono}>F = π·P + R</text>
    </Frame>
  );
}

/** 02: candles, news and indicators converge on 0G; a TEE-signed answer comes out. */
export function BrainIllustration() {
  return (
    <Frame label="Candles, headlines and indicators flow into 0G Compute, which returns a TEE-signed sentiment of +0.40">
      {/* Same grid as the RiskGate scene: inputs 100×36 at x 28 (rows centred y 58 / 106 / 154), 0G tile centred x 170. */}
      <Card x={28} y={40} w={100} h={36}>
        <text x="38" y="52" fill={C.faint} style={{ ...mono, fontSize: 6.5 }}>4H CANDLES</text>
        {[[1, 6], [6, 3], [3, 8], [8, 5], [5, 10], [10, 7], [7, 12], [12, 9], [9, 14]].map(([o, c], k) => {
          const base = 72.5;
          const hi = Math.max(o, c);
          const lo = Math.min(o, c);
          const x = 40 + k * 9.4;
          const up = c > o;
          return (
            <g key={k}>
              <line x1={x + 2} x2={x + 2} y1={base - hi - 1.6} y2={base - lo + 1.2} stroke={up ? C.ink : "#C9C9C6"} strokeWidth="0.8" />
              <rect x={x - 0.5} y={base - hi} width="5" height={Math.max(1.6, hi - lo)} rx="1" fill={up ? C.ink : "#C9C9C6"} />
            </g>
          );
        })}
      </Card>
      <Card x={28} y={88} w={100} h={36}>
        <text x="38" y="100" fill={C.faint} style={{ ...mono, fontSize: 6.5 }}>HEADLINES</text>
        <circle cx="40" cy="108.5" r="1.8" fill={C.orange} />
        <Skel x={45} y={106.5} w={62} h={4} />
        <Skel x={38} y={113.5} w={44} h={4} />
      </Card>
      <Card x={28} y={136} w={100} h={36}>
        <text x="38" y="148" fill={C.faint} style={{ ...mono, fontSize: 6.5 }}>RSI · ATR</text>
        <path d="M38 158 H118" stroke={C.skel} strokeWidth="0.8" strokeDasharray="2 2" />
        <path d="M38 163 C46 152 53 152 61 159 S77 168 86 160 S102 151 118 156" fill="none" stroke={C.blue} strokeWidth="1.5" strokeLinecap="round" />
      </Card>

      <Trail d="M128 58 C139 58 135 96 146 96" color={C.blue} dur={2.8} />
      <Trail d="M128 106 H146" color={C.blue} dur={2.8} delay={0.35} />
      <Trail d="M128 154 C139 154 135 116 146 116" color={C.blue} dur={2.8} delay={0.7} />

      <rect x="140" y="76" width="60" height="60" rx="17" fill="rgba(91,124,250,0.18)" className="breathe" />
      <rect x="146" y="82" width="48" height="48" rx="13" fill={C.blue} />
      <ZeroGGlyph x={155.6} y={99} height={14} fill="#fff" />
      <ZeroGGlyph x={145} y={141.5} height={6} fill={C.faint} />
      <text x="160" y="147.5" fill={C.faint} style={mono}>COMPUTE</text>

      <Trail d="M194 106 H212" color={C.trail} dur={2.8} delay={1.3} />

      <Card x={212} y={66} w={100} h={80}>
        <text x="222" y="81" fill={C.faint} style={{ ...mono, fontSize: 6.5 }}>SENTIMENT</text>
        <g className="fade-cycle" style={vars(5.6, 1.4)}>
          <text x="222" y="104" fill={C.ink} style={{ ...geist, fontSize: 19, fontWeight: 600 }}>+0.40</text>
          <circle cx="299" cy="97" r="6.5" fill={C.green} />
          <path d="M295.8 97 l2.2 2.2 l3.9 -4.3" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </g>
        {/* −1 … +1 meter, filling from the centre to +0.40 */}
        <rect x="222" y="113" width="80" height="4" rx="2" fill={C.skel} />
        <line x1="262" x2="262" y1="110.5" y2="119.5" stroke={C.faint} strokeWidth="0.8" />
        <rect x="262" y="113" width="16" height="4" rx="2" fill={C.green} className="bar-fill" style={vars(5.6, 1.4)} />
        <rect x="222" y="125" width="58" height="14" rx="7" fill={C.orangeSoft} />
        <text x="251" y="134.6" textAnchor="middle" fill={C.deep} style={{ ...mono, fontSize: 6.4 }}>TEE SIGNED</text>
      </Card>
    </Frame>
  );
}

/** 03: RiskGate lets the bounded order through and stops the reckless one. */
export function RiskGateIllustration() {
  return (
    <Frame label="RiskGate approves a $50 order and rejects a $500 order that exceeds the exposure budget">
      {/* Symmetric grid: 100×44 cards at x 28 / 212 (12px margins), rows centred on y 74 and 144, shield centred at x 170. */}
      {[
        { y: 52, dot: C.green, amount: "$50", sub: "LINK · BRACKET" },
        { y: 122, dot: C.red, amount: "$500", sub: "LINK · MARKET" },
      ].map((o) => (
        <Card key={o.amount} x={28} y={o.y} w={100} h={44}>
          <circle cx="42" cy={o.y + 22} r="4" fill={o.dot} />
          <text x="54" y={o.y + 20} fill={C.ink} style={{ ...geist, fontSize: 11.5, fontWeight: 600 }}>{o.amount}</text>
          <text x="54" y={o.y + 32} fill={C.faint} style={{ ...mono, fontSize: 6.5 }}>{o.sub}</text>
        </Card>
      ))}

      <Trail d="M128 74 C139 74 136 101 147 101" color={C.green} dur={3} />
      <Trail d="M128 144 C139 144 136 117 147 117" color={C.red} dur={3} delay={0.5} />

      <g>
        <rect x="147" y="83" width="46" height="52" rx="12" fill="rgba(91,124,250,0.16)" className="breathe" />
        <path d="M170 87 L188 94 V108 C188 119 180 126 170 131 C160 126 152 119 152 108 V94 Z" fill={C.ink} />
        <path d="M170 93.5 L182 98.5 V108 C182 115.5 177 120.5 170 124 C163 120.5 158 115.5 158 108 V98.5 Z" fill={C.blue} />
        <path d="M164 108.5 l4 4 l8 -8.5" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      <text x="170" y="152" textAnchor="middle" fill={C.faint} style={mono}>RISKGATE</text>

      <Trail d="M193 101 C204 101 201 74 212 74" color={C.green} dur={3} delay={1.1} />
      <path d="M193 117 C204 117 201 144 212 144" fill="none" stroke={C.red} strokeWidth="1.4" strokeDasharray="2 3.5" strokeLinecap="round" opacity="0.55" />

      <Card x={212} y={52} w={100} h={44}>
        <svg x="222" y="61" width="13" height="13" viewBox="0 0 24 24"><Check color={C.green} strokeWidth={3} /></svg>
        <text x="240" y="71.5" fill={C.green} style={{ ...geist, fontSize: 10.5, fontWeight: 600 }}>Approved</text>
        <text x="222" y="86" fill={C.faint} style={{ ...mono, fontSize: 6.3 }}>WITHIN E = $120</text>
      </Card>
      <g className="fade-cycle" style={vars(3, 1.3)}>
        <rect x="212" y="122" width="100" height="44" rx="9" fill={C.redSoft} stroke="rgba(227,93,91,0.28)" />
        <svg x="222" y="131" width="13" height="13" viewBox="0 0 24 24"><X color={C.red} strokeWidth={3} /></svg>
        <text x="240" y="141.5" fill={C.red} style={{ ...geist, fontSize: 10.5, fontWeight: 600 }}>Rejected</text>
        <text x="222" y="156" fill={C.red} style={{ ...mono, fontSize: 6.3 }}>EXCEEDS_EXPOSURE</text>
      </g>
    </Frame>
  );
}

/** 04: fees → swap → CCIP → 0G compute, a closed loop with value travelling around it. */
export function MetabolismIllustration() {
  const loop = "M170 48 H222 C252 48 264 70 264 105 C264 140 252 162 222 162 H118 C88 162 76 140 76 105 C76 70 88 48 118 48 Z";
  const nodes = [
    { x: 150, y: 28, fill: C.orange, icon: <Coins color={C.ink} strokeWidth={2} />, label: "FEES", lx: 212, ly: 40 },
    { x: 244, y: 85, fill: C.white, icon: <ArrowLeftRight color={C.ink} strokeWidth={2} />, label: "SWAP", lx: 304, ly: 108 },
    { x: 150, y: 142, fill: C.ink, icon: <Link2 color="#fff" strokeWidth={2} />, label: "CCIP", lx: 212, ly: 178 },
    { x: 56, y: 85, fill: C.blue, icon: <ZeroGGlyph x={-0.4} y={6.2} height={11.6} fill="#fff" />, label: "", lx: 38, ly: 108 },
  ];
  return (
    <Frame label="Fees are swapped, bridged with CCIP and pay for the agent's 0G compute, in a loop">
      <path d={loop} fill="none" stroke={C.line} strokeWidth="1.4" />
      {[0, 1.4, 2.8].map((d) => (
        <g key={d}>
          <path d={loop} pathLength={100} className="comet-tail" stroke={C.trail} strokeWidth="1.6" style={vars(4.2, d)} />
          <path d={loop} pathLength={100} className="comet" stroke={C.trail} strokeWidth="1.8" style={vars(4.2, d)} />
        </g>
      ))}
      <text x="170" y="103" textAnchor="middle" fill={C.ink} style={{ fontFamily: "var(--font-display)", fontSize: 21 }}>self-funded</text>
      <text x="170" y="118" textAnchor="middle" fill={C.faint} style={mono}>NO HUMAN TOP-UPS</text>
      {nodes.map((n) => (
        <g key={n.label}>
          <rect x={n.x} y={n.y} width="40" height="40" rx="11" fill={n.fill} stroke={n.fill === C.white ? C.line : "none"} />
          <svg x={n.x + 11} y={n.y + 11} width="18" height="18" viewBox="0 0 24 24">{n.icon}</svg>
          <text x={n.lx} y={n.ly} textAnchor="middle" fill={C.faint} style={mono}>{n.label}</text>
        </g>
      ))}
      <svg x="296" y="30" width="16" height="16" viewBox="0 0 24 24"><ShieldCheck color={C.faint} strokeWidth={1.8} /></svg>
    </Frame>
  );
}

"use client";
/**
 * The agent's activity as an assistant conversation (reference: "Thought for 5s ›", streamed reply, popped setting
 * chip, approval card, timestamp). Every line is built from real records only: the agent's posts, its committed /
 * revealed signals, and RiskGate-approved trades. Only messages that arrive while you watch (plus the latest one when
 * the panel opens) are typed out; older history renders instantly.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Hash as HashIcon, ShieldCheck, Sparkles } from "lucide-react";
import { AnimatedShinyText } from "@/components/ui/animated-shiny-text";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, Hash, Micro } from "@/components/ui-perpetua";
import { fmt } from "@/lib/data";
import { dur, gsap } from "@/lib/gsap";
import { cn } from "@/lib/utils";
import { ProofChips, useFeedState, type Post } from "./Feed";
import { PopGroup, StreamText } from "./StreamText";
import { ZeroGText } from "./ZeroG";
import type { DashboardAgent } from "./agent-utils";

type Msg =
  | { key: string; kind: "post"; at: number; post: Post }
  | { key: string; kind: "signal"; at: number; s: any }
  | { key: string; kind: "trade"; at: number; t: any };

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const px = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? fmt(n, n >= 100 ? 2 : 3) : "—");

function textOf(m: Msg): string {
  if (m.kind === "post") return m.post.text.split("\n")[0];
  if (m.kind === "trade") {
    const t = m.t;
    const lv = t.embargoed ? "Levels stay hidden for the 15-minute embargo." : `Entry $${px(t.entry)}, stop $${px(t.stop)}, target $${px(t.target)}.`;
    return `RiskGate approved a $${fmt(t.sizeUsd)} ${t.asset} order${t.status === "closed" ? ", now closed" : ""}. ${lv}`;
  }
  const s = m.s;
  if (!s.signal) return `Committed a ${s.asset} signal. Paying agents have it now; it is revealed here at ${clock(s.revealAt * 1000)}.`;
  const sig = s.signal;
  const reason = (sig.reasons ?? [])[0];
  return `${sig.direction === "long" ? "Long" : "Staying flat on"} ${s.asset} in a ${sig.regime} regime, confidence ${Number(sig.confidence).toFixed(2)}.${reason ? ` ${reason}` : ""}`;
}

function metaLabel(m: Msg) {
  if (m.kind === "signal") return m.s.signal ? "Reasoned on 0G" : "Signal committed";
  if (m.kind === "trade") return "RiskGate check";
  return "Agent post";
}

/** Details that pop in after the message finishes typing (setting chip, approval-style card, proofs). */
function Extras({ m }: { m: Msg }) {
  if (m.kind === "post") return <ProofChips proof={m.post.proof} />;
  if (m.kind === "trade") {
    const t = m.t;
    return (
      <div className="space-y-2">
        <PopGroup show>
          <span className="flex items-center gap-1.5 text-sm font-medium"><HashIcon className="size-3.5" /> Order</span>
          <Badge variant="trade-solid">{t.status === "open" ? "Approved by RiskGate" : "Closed"}</Badge>
          {t.attestation && <Badge variant={t.attestation === "rules-attested" ? "trade" : "brand"} size="micro">{t.attestation === "rules-attested" ? "Rules-attested" : "0G TEE-attested"}</Badge>}
        </PopGroup>
        <div className="pop-in max-w-xs rounded-2xl bg-muted p-3" style={{ ["--pop-delay" as string]: "160ms" }}>
          <p className="text-sm font-medium">{t.status === "open" ? "Live order" : "Settled order"}</p>
          <p className="text-xs text-muted-foreground">Only the cushion can be traded</p>
          <span className="mt-2 inline-flex rounded-lg bg-brand-soft px-2 py-1 font-mono text-[11px] tracking-wide text-brand-hover">
            SIZE ${fmt(t.sizeUsd)}{t.embargoed ? " · EMBARGOED" : ` · STOP ${px(t.stop)} → TARGET ${px(t.target)}`}
          </span>
          <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">approval <Hash value={t.approvalTx} head={8} tail={4} /></p>
        </div>
      </div>
    );
  }
  const s = m.s;
  const sig = s.signal;
  if (!sig)
    return (
      <PopGroup show>
        <Badge variant="muted" size="micro">Commit</Badge>
        <Hash value={s.commitHash} head={10} tail={4} />
      </PopGroup>
    );
  return (
    <div className="space-y-2">
      <PopGroup show>
        <span className="flex items-center gap-1.5 text-sm font-medium"><HashIcon className="size-3.5" /> Proposal</span>
        <Badge variant="trade-solid">Checked by RiskGate</Badge>
        {Number.isFinite(sig.rewardRisk) && <Badge variant="secondary" className="num">R/R {Number(sig.rewardRisk).toFixed(1)}</Badge>}
      </PopGroup>
      <div className="pop-in max-w-xs rounded-2xl bg-muted p-3" style={{ ["--pop-delay" as string]: "200ms" }}>
        <p className="text-sm font-medium">Bracket levels</p>
        <p className="text-xs text-muted-foreground">Committed on Arkiv before the reveal</p>
        <span className="mt-2 inline-flex rounded-lg bg-brand-soft px-2 py-1 font-mono text-[11px] tracking-wide text-brand-hover">
          ENTRY {px(sig.entry)} → TARGET {px(sig.target)}
        </span>
      </div>
    </div>
  );
}

function Message({ m, typing, onTyped }: { m: Msg; typing: boolean; onTyped: () => void }) {
  const [done, setDone] = useState(!typing);
  const label = metaLabel(m);
  const reasons: string[] = m.kind === "signal" ? m.s.signal?.reasons ?? [] : [];
  return (
    <li data-reveal="pop" className="space-y-2">
      {reasons.length > 0 && done ? (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ZeroGText text={label} /> <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-1.5 space-y-1 text-xs text-muted-foreground">
            {reasons.slice(0, 4).map((r, i) => <p key={i}>· {r}</p>)}
            {m.kind === "signal" && <p className="flex flex-wrap items-center gap-1.5"><ZeroGText text="0G chat" /> <Hash value={m.s.chatId} /></p>}
          </CollapsibleContent>
        </Collapsible>
      ) : (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          {done ? <ZeroGText text={label} /> : <AnimatedShinyText className="mx-0 max-w-none text-muted-foreground"><ZeroGText text={`${label}…`} /></AnimatedShinyText>}
          {done && <ChevronRight className="size-3.5" />}
        </p>
      )}
      <p className="text-sm leading-relaxed text-foreground">
        <StreamText text={textOf(m)} animate={typing} onDone={() => { setDone(true); onTyped(); }} />
      </p>
      {done && (
        <div className={cn(typing && "pop-in")}>
          <Extras m={m} />
        </div>
      )}
      {done && <Micro className="pop-in block normal-case tracking-normal" >{clock(m.at)}</Micro>}
    </li>
  );
}

export function AgentChat({ agent, loading }: { agent?: DashboardAgent; loading: boolean }) {
  const feed = useFeedState(agent ? [agent.name, agent.id] : undefined);
  const messages = useMemo<Msg[]>(() => {
    if (!agent) return [];
    const list: Msg[] = [
      ...feed.posts.map((p) => ({ key: `p:${p.at}:${p.agent}`, kind: "post" as const, at: p.at, post: p })),
      ...((agent.runtime?.signals ?? []) as any[]).map((s) => ({ key: `s:${s.uid}:${s.signal ? "r" : "c"}`, kind: "signal" as const, at: (s.createdAt ?? 0) * 1000, s })),
      ...((agent.runtime?.trades ?? []) as any[]).map((t) => ({ key: `t:${t.uid}:${t.status}`, kind: "trade" as const, at: (t.openedAt ?? 0) * 1000, t })),
    ];
    return list.sort((a, b) => a.at - b.at).slice(-24); // chat order: newest at the bottom
  }, [agent, feed.posts]);

  // Which message types out: the latest one when this agent's history first loads, then the newest arrival.
  // Bookkeeping is idempotent (safe under React's double render), so a message mounts already "typing" and never
  // flashes its full text first.
  const seen = useRef<{ agent?: string; keys: Set<string>; ready: boolean; typing: string | null }>({ keys: new Set(), ready: false, typing: null });
  if (seen.current.agent !== agent?.id) seen.current = { agent: agent?.id, keys: new Set(), ready: false, typing: null };
  const s = seen.current;
  if (agent && feed.loaded) {
    if (!s.ready) {
      s.ready = true;
      messages.forEach((m) => s.keys.add(m.key));
      s.typing = messages[messages.length - 1]?.key ?? null;
    } else {
      const fresh = messages.filter((m) => !s.keys.has(m.key));
      if (fresh.length) {
        fresh.forEach((m) => s.keys.add(m.key));
        s.typing = fresh[fresh.length - 1].key;
      }
    }
  }
  const typing = s.typing;
  const [, rerender] = useState(0);
  const finished = (key: string) => {
    if (seen.current.typing === key) {
      seen.current.typing = null;
      rerender((n) => n + 1);
    }
  };

  // Keep the newest message in view, scrolling smoothly as text streams in.
  const scroller = useRef<HTMLDivElement>(null);
  const toBottom = (smooth = true) => {
    const vp = scroller.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (vp) gsap.to(vp, { scrollTo: { y: "max" }, duration: smooth ? dur(0.6) : 0, ease: "power2.out", overwrite: "auto" });
  };
  useEffect(() => toBottom(false), [agent?.id, feed.loaded]);
  useEffect(() => toBottom(true), [messages.length, typing]);
  useEffect(() => {
    if (!typing) return;
    const t = setInterval(() => toBottom(true), 350);
    return () => clearInterval(t);
  }, [typing]);

  return (
    <ScrollArea ref={scroller} className="mt-4 h-[360px] px-6">
      {loading && !agent ? (
        <div className="space-y-2.5">
          <Skeleton className="h-20 rounded-3xl" />
          <Skeleton className="h-24 rounded-3xl" />
        </div>
      ) : messages.length === 0 ? (
        <EmptyState title="No verified activity yet" icon={<Sparkles className="size-4" />} className="mt-2">
          Signals, RiskGate approvals and the agent&apos;s posts appear here as they happen. No decisions are shown until they exist.
        </EmptyState>
      ) : (
        <ol className="space-y-6 pb-5">
          {messages.map((m) => (
            <Message key={`${agent?.id}:${m.key}`} m={m} typing={typing === m.key} onTyped={() => finished(m.key)} />
          ))}
        </ol>
      )}
      {agent && (
        <p className="flex items-center gap-1.5 pb-4 text-[11px] text-faint">
          <ShieldCheck className="size-3" /> Every order still needs RiskGate&apos;s on-chain approval.
        </p>
      )}
    </ScrollArea>
  );
}

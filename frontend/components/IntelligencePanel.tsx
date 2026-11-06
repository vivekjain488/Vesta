"use client";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { Flip, reducedMotion, useGSAP } from "@/lib/gsap";
import { AnimatedNumber } from "./motion";
import { ArrowUp, ArrowUpRight, Bot, ChevronDown, ChevronRight, Plus, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, Hash, Micro, signedUsd, TierBadge } from "@/components/ui-perpetua";
import { fmt, TIER_COPY } from "@/lib/data";
import { cn } from "@/lib/utils";
import { CppiBar } from "./CppiBar";
import { ProofChips, useFeed, type Post } from "./Feed";
import { agentHref, agentSymbols, hasOpenTrade, isFunded, type DashboardAgent } from "./agent-utils";
import { runwayDays } from "./useAgents";

type Event =
  | { kind: "post"; at: number; post: Post }
  | { kind: "signal"; at: number; s: any }
  | { kind: "trade"; at: number; t: any };

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function Bubble({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "brand" | "trade" }) {
  return <div className={cn("rounded-3xl px-4 py-3 text-sm", tone === "brand" ? "bg-brand-soft" : tone === "trade" ? "bg-trade-soft" : "bg-muted/70")}>{children}</div>;
}

function SignalEvent({ s }: { s: any }) {
  const sig = s.signal;
  if (!sig)
    return (
      <Bubble>
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">Signal committed · {s.asset}</span>
          <Micro>{time(s.createdAt * 1000)}</Micro>
        </div>
        <p className="mt-1 text-muted-foreground">Paying agents already have it. It is revealed here at {new Date(s.revealAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.</p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Badge variant="muted" size="micro">Commit</Badge>
          <Hash value={s.commitHash} head={10} tail={4} />
        </div>
      </Bubble>
    );
  return (
    <Bubble tone="brand">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">
          {sig.direction === "long" ? "Long" : "Flat"} proposal · {s.asset}
        </span>
        <Micro>{time(s.createdAt * 1000)}</Micro>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Badge variant="white" size="micro">conf {Number(sig.confidence).toFixed(2)}</Badge>
        <Badge variant="white" size="micro">{sig.regime}</Badge>
        {Number.isFinite(sig.rewardRisk) && <Badge variant="white" size="micro">R/R {Number(sig.rewardRisk).toFixed(1)}</Badge>}
      </div>
      <Collapsible className="mt-2">
        <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          Reasoned on 0G <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 space-y-1.5 text-xs text-muted-foreground">
          {(sig.reasons ?? []).slice(0, 4).map((r: string, i: number) => (
            <p key={i}>· {r}</p>
          ))}
          <p className="num">
            Entry {fmt(sig.entry, 3)} · Stop {fmt(sig.stop, 3)} · Target {fmt(sig.target, 3)}
          </p>
          <p className="flex flex-wrap items-center gap-1.5">
            0G chat <Hash value={s.chatId} /> · commit <Hash value={s.commitHash} head={10} tail={4} />
          </p>
        </CollapsibleContent>
      </Collapsible>
    </Bubble>
  );
}

function TradeEvent({ t }: { t: any }) {
  return (
    <Bubble tone={t.status === "open" ? "trade" : "muted"}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">RiskGate approved · {t.asset}</span>
        <Micro>{time(t.openedAt * 1000)}</Micro>
      </div>
      <p className="num mt-1 text-muted-foreground">
        ${fmt(t.sizeUsd)} {t.embargoed ? "· levels under 15-min embargo" : `at $${fmt(t.entry, 3)} · stop $${fmt(t.stop, 3)} · target $${fmt(t.target, 3)}`}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge variant={t.status === "open" ? "trade-solid" : "muted"} size="micro">{t.status}</Badge>
        <span className="text-xs text-muted-foreground">approval</span> <Hash value={t.approvalTx} head={8} tail={4} />
      </div>
    </Bubble>
  );
}

const SORTS = { profit: "Profit", capital: "Capital", runway: "Runway" } as const;

function AgentTile({ a, selected, onSelect }: { a: DashboardAgent; selected: boolean; onSelect: () => void }) {
  const featured = hasOpenTrade(a);
  const c = a.chain;
  return (
    <div
      data-flip-id={a.id}
      data-reveal
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onSelect())}
      className={cn(
        "flex min-h-[200px] w-[210px] shrink-0 flex-col rounded-[24px] p-4 text-left transition-[box-shadow,transform] duration-150 outline-none focus-visible:ring-3 focus-visible:ring-ring/40",
        featured ? "bg-trade text-foreground" : "bg-muted text-foreground",
        selected && "ring-2 ring-foreground",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-display text-2xl leading-none">{a.name}</p>
          <Badge variant={featured ? "trade-deep" : "ink"} size="micro" className="mt-2">
            {featured ? "Open trade" : (a.status ?? "active").replaceAll("_", " ")}
          </Badge>
        </div>
        <Button asChild variant="white" size="xs" className="micro h-6 shrink-0 shadow-[0_0_0_1px_rgba(17,17,17,0.06)]" onClick={(e) => e.stopPropagation()}>
          <Link href={agentHref(a)}>{a.chain ? "View" : "Setup"}</Link>
        </Button>
      </div>
      <div className="mt-auto pt-6">
        {c && <CppiBar V={c.V} F={c.F} C={c.C} E={c.E} zoom={false} className="[&>div:last-child]:hidden" />}
        <Micro className={cn("mt-3 block", featured ? "text-foreground/70" : undefined)}>Profit</Micro>
        <p className="num text-[1.9rem] leading-tight font-semibold tracking-tight">{a.chain ? <AnimatedNumber value={a.profit ?? 0} format={(n) => signedUsd(n)} /> : "—"}</p>
      </div>
    </div>
  );
}

/** The reference's tall assistant card: the selected agent's verified activity, the owner's agents, next steps. */
export function IntelligencePanel({ agent, agents, onSelect, loading, className }: { agent?: DashboardAgent; agents: DashboardAgent[]; onSelect: (id: string) => void; loading: boolean; className?: string }) {
  const [sort, setSort] = useState<keyof typeof SORTS>("profit");
  const posts = useFeed(agent ? [agent.name, agent.id] : undefined);

  // Flip: capture tile positions before the sort changes, then animate them into their new order.
  const tilesRef = useRef<HTMLDivElement>(null);
  const flipState = useRef<ReturnType<typeof Flip.getState> | null>(null);
  const changeSort = (next: keyof typeof SORTS) => {
    if (tilesRef.current && !reducedMotion()) flipState.current = Flip.getState(tilesRef.current.querySelectorAll("[data-flip-id]"));
    setSort(next);
  };
  useGSAP(
    () => {
      const state = flipState.current;
      if (!state) return;
      flipState.current = null;
      Flip.from(state, { duration: 0.4, ease: "power2.inOut" });
    },
    { dependencies: [sort], scope: tilesRef },
  );
  const events = useMemo<Event[]>(() => {
    if (!agent) return [];
    const list: Event[] = [
      ...posts.map((p) => ({ kind: "post" as const, at: p.at, post: p })),
      ...((agent.runtime?.signals ?? []) as any[]).map((s) => ({ kind: "signal" as const, at: (s.createdAt ?? 0) * 1000, s })),
      ...((agent.runtime?.trades ?? []) as any[]).map((t) => ({ kind: "trade" as const, at: (t.openedAt ?? 0) * 1000, t })),
    ];
    return list.sort((a, b) => b.at - a.at).slice(0, 24);
  }, [agent, posts]);

  const sorted = useMemo(() => {
    const val = (a: DashboardAgent) => (sort === "profit" ? a.profit ?? 0 : sort === "capital" ? a.chain?.V ?? 0 : Math.min(runwayDays(a), 1e9));
    return [...agents].sort((a, b) => val(b) - val(a));
  }, [agents, sort]);

  const tier = agent?.runtime?.tier;
  const symbol = agent ? agentSymbols(agent)[0] ?? "LINK" : "LINK";

  return (
    <Card className={cn("gap-0 py-0", className)}>
      <div className="flex items-center gap-3 px-6 pt-6">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-brand text-white" aria-hidden>
          <Bot className="size-5" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-[1.75rem] leading-none">{agent ? `${agent.name} intelligence` : "Intelligence"}</p>
          <p className="mt-1 truncate text-sm text-muted-foreground">
            {agent ? `Watching ${symbol} on the 4h chart · ${TIER_COPY[tier ?? "thrive"]?.label ?? "Thrive"}` : "Select an agent to see its decisions"}
          </p>
        </div>
        {agent && (
          <Button asChild variant="soft" size="icon-lg" aria-label={`Open ${agent.name}`}>
            <Link href={agentHref(agent)}><ArrowUpRight className="size-4" /></Link>
          </Button>
        )}
      </div>

      <ScrollArea className="mt-4 h-[340px] px-6">
        {loading && !agent ? (
          <div className="space-y-2.5">
            <Skeleton className="h-20 rounded-3xl" />
            <Skeleton className="h-24 rounded-3xl" />
          </div>
        ) : events.length === 0 ? (
          <EmptyState title="No verified activity yet" icon={<Sparkles className="size-4" />} className="mt-2">
            Signals, RiskGate approvals and the agent&apos;s posts appear here as they happen. No decisions are shown until they exist.
          </EmptyState>
        ) : (
          <ol className="space-y-2.5 pb-4">
            {events.map((e, i) => (
              <li key={`${agent?.id}-${e.kind}-${e.at}-${i}`} data-reveal>
                {e.kind === "post" ? (
                  <Bubble>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{e.post.agent}</span>
                      <Micro>{time(e.post.at)}</Micro>
                    </div>
                    <p className="mt-1 leading-relaxed">{e.post.text.split("\n")[0]}</p>
                    <ProofChips proof={e.post.proof} />
                  </Bubble>
                ) : e.kind === "signal" ? (
                  <SignalEvent s={e.s} />
                ) : (
                  <TradeEvent t={e.t} />
                )}
              </li>
            ))}
          </ol>
        )}
      </ScrollArea>

      {agent?.chain && (
        <div className="flex flex-wrap gap-1.5 border-t border-border/70 px-6 py-3">
          <Badge variant="secondary" className="num">Burn {fmt(agent.runtime?.burnOgPerHour ?? 0, 4)} 0G/h</Badge>
          <Badge variant="secondary" className="num">Income harvested ${fmt(agent.chain.harvested)}</Badge>
          <Badge variant="secondary" className="num">Pending ${fmt(agent.chain.harvestable)}</Badge>
          <TierBadge tier={tier} />
        </div>
      )}

      <div className="border-t border-border/70 px-6 pt-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Your agents</span>
            <Badge variant="ink" size="micro">Live</Badge>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="soft" size="xs" className="h-7 px-3">
                {SORTS[sort]} <ChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="rounded-2xl">
              <DropdownMenuRadioGroup value={sort} onValueChange={(v) => changeSort(v as keyof typeof SORTS)}>
                {(Object.keys(SORTS) as (keyof typeof SORTS)[]).map((k) => (
                  <DropdownMenuRadioItem key={k} value={k}>Sort by {SORTS[k].toLowerCase()}</DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div ref={tilesRef} className="-mx-6 mt-3 flex gap-3 overflow-x-auto px-6 pb-1 [scrollbar-width:none]">
          {loading && !agents.length ? (
            <>
              <Skeleton className="h-[200px] w-[210px] shrink-0 rounded-[24px]" />
              <Skeleton className="h-[200px] w-[210px] shrink-0 rounded-[24px]" />
            </>
          ) : sorted.length === 0 ? (
            <EmptyState title="No agents yet" className="w-full py-6" action={<Button asChild size="sm"><Link href="/studio">Create an agent</Link></Button>} />
          ) : (
            sorted.map((a) => <AgentTile key={a.id} a={a} selected={a.id === agent?.id} onSelect={() => onSelect(a.id)} />)
          )}
        </div>
      </div>

      {/* Composer-style action bar: real destinations only (no free-form chat backend exists). */}
      <div className="p-4 pt-4">
        <div className="flex items-center gap-2 rounded-[22px] bg-muted p-2 pl-2.5">
          <Button asChild variant="white" size="icon-sm" aria-label="Create agent" className="shadow-[0_0_0_1px_rgba(17,17,17,0.06)]">
            <Link href="/studio"><Plus /></Link>
          </Button>
          <p className="min-w-0 flex-1 truncate px-1 text-sm text-muted-foreground">
            {!agent ? "Create your first agent" : !isFunded(agent) ? `Add capital to start ${agent.name}` : `Review ${agent.name}'s investments`}
          </p>
          {agent?.chain && (
            <>
              <Button asChild variant="chip" className="hidden sm:inline-flex">
                <Link href={`/agent/${agent.id}#add-capital`}>Add funds</Link>
              </Button>
              <Button asChild variant="chip-outline" className="hidden sm:inline-flex">
                <Link href={`/agent/${agent.id}#history`}>History</Link>
              </Button>
            </>
          )}
          <Button asChild size="icon-sm" aria-label="Go">
            <Link href={agent ? agentHref(agent) : "/studio"}><ArrowUp /></Link>
          </Button>
        </div>
      </div>
    </Card>
  );
}

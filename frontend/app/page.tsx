"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Bot, ChevronDown, WifiOff } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { IntelligencePanel } from "@/components/IntelligencePanel";
import { MarketChart } from "@/components/MarketChart";
import { PortfolioCard } from "@/components/PortfolioCard";
import { RiskGateCard } from "@/components/RiskGateCard";
import { agentHref, agentSymbols, openLevels, type DashboardAgent } from "@/components/agent-utils";
import { AgentAvatar, Micro, PageHeader, PnL, StatusBadge } from "@/components/ui-perpetua";
import { useAgents } from "@/components/useAgents";
import { fmt } from "@/lib/data";

export default function Dashboard() {
  const { agents: rows, online } = useAgents();
  const agents = rows as DashboardAgent[];
  const loading = online === null;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (!agents.length) return;
    if (!selectedId || !agents.some((a) => a.id === selectedId)) setSelectedId((agents.find((a) => a.chain) ?? agents[0]).id);
  }, [agents, selectedId]);
  const selected = agents.find((a) => a.id === selectedId);

  return (
    <div className="space-y-3">
      <div className="pt-4 pb-5 lg:pt-6">
        <PageHeader
          eyebrow="Overview"
          title="Your dashboard"
          action={
            <div className="flex items-center gap-2">
              {agents.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="flex h-11 items-center gap-2 rounded-full bg-primary py-1 pr-4 pl-1 text-primary-foreground transition-colors duration-150 hover:bg-primary/85 focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none" aria-label="Choose agent">
                      {selected ? <AgentAvatar name={selected.name} className="size-9" /> : <Bot className="ml-2 size-4" />}
                      <span className="max-w-40 truncate text-sm font-medium">{selected?.name ?? "Agent"}</span>
                      <ChevronDown className="size-4 text-white/60" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-56 rounded-2xl">
                    <DropdownMenuRadioGroup value={selectedId ?? ""} onValueChange={setSelectedId}>
                      {agents.map((a) => (
                        <DropdownMenuRadioItem key={a.id} value={a.id}>
                          <span className="truncate">{a.name}</span>
                          <span className="ml-auto pl-3 text-xs text-muted-foreground">{a.chain ? `$${fmt(a.chain.V, 0)}` : "Not funded"}</span>
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <Button asChild variant="outline" size="lg" className="hidden sm:inline-flex">
                <Link href="/studio">Create agent</Link>
              </Button>
            </div>
          }
        />
      </div>

      {online === false && (
        <Alert className="rounded-3xl border-0 bg-loss/8 text-loss">
          <WifiOff />
          <AlertTitle>Unable to load your agents.</AlertTitle>
          <AlertDescription className="text-loss/80">Reconnect or try again shortly.</AlertDescription>
        </Alert>
      )}

      {online && agents.length === 0 && (
        <Card className="items-start px-8 py-10">
          <Micro>Get started</Micro>
          <h3 className="font-display text-4xl leading-none">Start with your first agent</h3>
          <p className="max-w-xl text-muted-foreground">Choose a strategy, set your limits, and allocate capital. Your agent runs without keeping this page open.</p>
          <Button asChild size="lg" className="mt-2">
            <Link href="/studio">Create an agent <ArrowRight /></Link>
          </Button>
        </Card>
      )}

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <MarketChart symbols={agentSymbols(selected)} levels={openLevels(selected)} agentName={selected?.name} />
          <div className="grid gap-3 md:grid-cols-2">
            <PortfolioCard agents={agents} loading={loading} />
            <RiskGateCard agent={selected} loading={loading} />
          </div>
        </div>
        <IntelligencePanel agent={selected} agents={agents} onSelect={setSelectedId} loading={loading} className="xl:sticky xl:top-6 xl:self-start" />
      </div>

      {(loading || agents.length > 0) && (
        <section className="pt-8">
          <div className="flex items-end justify-between gap-4">
            <h2 className="font-display text-4xl leading-none">Agents</h2>
            <Micro>{agents.length} total</Micro>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {loading
              ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-52 rounded-[28px]" />)
              : agents.map((a) => (
                  <Link key={a.id} href={agentHref(a)} className="group rounded-[28px] outline-none focus-visible:ring-3 focus-visible:ring-ring/40">
                    <Card className="h-full transition-shadow duration-150 group-hover:shadow-[0_12px_32px_-18px_rgba(17,17,17,0.25),0_0_0_1px_rgba(17,17,17,0.04)]">
                      <div className="flex items-start justify-between gap-3 px-6">
                        <div className="flex min-w-0 items-center gap-3">
                          <AgentAvatar name={a.name} className="size-10" />
                          <div className="min-w-0">
                            <h3 className="truncate font-display text-[1.75rem] leading-none">{a.name}</h3>
                            <p className="mt-1 truncate text-sm text-muted-foreground">{a.strategy}</p>
                          </div>
                        </div>
                        <StatusBadge status={a.status} />
                      </div>
                      <dl className="mx-6 grid grid-cols-2 gap-3 rounded-2xl bg-muted p-4">
                        <div>
                          <dt className="text-xs text-muted-foreground">Capital</dt>
                          <dd className="num mt-1 text-lg font-semibold">{a.chain ? `$${fmt(a.chain.V)}` : "Not funded"}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted-foreground">Profit</dt>
                          <dd className="mt-1 text-lg font-semibold">{a.chain ? <PnL value={a.profit ?? 0} /> : <span className="text-muted-foreground">—</span>}</dd>
                        </div>
                      </dl>
                      <p className="flex items-center justify-between px-6 text-sm text-muted-foreground transition-colors duration-150 group-hover:text-foreground">
                        {a.chain ? "Investments & history" : "Finish setup"} <ArrowRight className="size-4" />
                      </p>
                    </Card>
                  </Link>
                ))}
          </div>
        </section>
      )}
    </div>
  );
}

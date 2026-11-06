"use client";
import { ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, Stat, TierBadge, ValueField } from "@/components/ui-perpetua";
import { fmt } from "@/lib/data";
import { cn } from "@/lib/utils";
import { CppiBar } from "./CppiBar";
import { RunwayBar } from "./RunwayBar";
import { runwayDays, type AgentView } from "./useAgents";

/** The reference's "bot settings" card, translated: RiskGate's on-chain mandate and the agent's metabolism. */
export function RiskGateCard({ agent, loading, className }: { agent?: AgentView; loading?: boolean; className?: string }) {
  const c = agent?.chain;
  return (
    <Card className={cn("@container", className)}>
      <CardHeader>
        <CardTitle>RiskGate</CardTitle>
        <CardDescription>
          {c ? (
            <>
              Mandate epoch <span className="num">{c.epoch}</span> · valid until <span className="num">{new Date(c.validUntil * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            </>
          ) : (
            "On-chain risk limits"
          )}
        </CardDescription>
        <CardAction>
          <span className="flex size-10 items-center justify-center rounded-full bg-muted text-foreground" aria-hidden>
            <ShieldCheck className="size-4" strokeWidth={1.75} />
          </span>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        {loading && !agent ? (
          <Skeleton className="h-56 rounded-3xl" />
        ) : !agent || !c ? (
          <EmptyState title="No mandate yet" icon={<ShieldCheck className="size-4" />}>
            RiskGate computes the floor, cushion and exposure once the agent holds capital.
          </EmptyState>
        ) : (
          <Tabs defaultValue="protection">
            <TabsList variant="line">
              <TabsTrigger value="protection">Protection</TabsTrigger>
              <TabsTrigger value="metabolism">Metabolism</TabsTrigger>
            </TabsList>
            <TabsContent value="protection" className="mt-3 space-y-2.5">
              <div className="relative">
                <Badge variant="trade-solid" size="micro" className="absolute -top-2 right-3 z-10">Set by RiskGate</Badge>
                <div className="grid gap-2.5 @md:grid-cols-3">
                  <ValueField label="Floor F" value={`$${fmt(c.F)}`} />
                  <ValueField label="Cushion C" value={`$${fmt(c.C)}`} />
                  <ValueField label="Exposure E" value={`$${fmt(c.E)}`} />
                </div>
              </div>
              <CppiBar V={c.V} F={c.F} C={c.C} E={c.E} className="pt-2" />
              <p className="text-xs leading-relaxed text-muted-foreground">
                F = π·P + R = {(c.piBps / 100).toFixed(0)}% × ${fmt(c.principal)} + ${fmt(c.reserve)}. Only the ${fmt(c.C)} cushion can be traded, and the trading wallet never holds more than E = ${fmt(c.E)}.
              </p>
              {(c.hibernating || c.tradingOff || c.withdrawalPaused) && (
                <div className="flex flex-wrap gap-1.5">
                  {c.hibernating && <Badge variant="muted">Hibernating · stale price on a held asset</Badge>}
                  {c.tradingOff && <Badge variant="loss">Drawdown breaker · services only</Badge>}
                  {c.withdrawalPaused && <Badge variant="trade">Paused for withdrawal</Badge>}
                </div>
              )}
            </TabsContent>
            <TabsContent value="metabolism" className="mt-3 space-y-4">
              <RunwayBar name={agent.name} days={runwayDays(agent)} tier={agent.runtime?.tier ?? "thrive"} />
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-2xl bg-muted p-4">
                <Stat label="0G ledger" value={`${fmt(agent.runtime?.lastLedgerOg ?? 0, 3)} 0G`} className="[&_dd]:text-base" />
                <Stat label="Burn / hour" value={`${fmt(agent.runtime?.burnOgPerHour ?? 0, 4)} 0G`} className="[&_dd]:text-base" />
                <Stat label="Harvested to 0G" value={`$${fmt(c.harvested)}`} className="[&_dd]:text-base" />
                <Stat label="Harvestable now" value={`$${fmt(c.harvestable)}`} className="[&_dd]:text-base" />
              </dl>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                Model tier <TierBadge tier={agent.runtime?.tier} />
              </div>
            </TabsContent>
          </Tabs>
        )}
      </CardContent>
    </Card>
  );
}

"use client";
import { use, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Funding } from "@/components/Funding";
import { Investments } from "@/components/Investments";
import { MarketChart } from "@/components/MarketChart";
import { RiskGateCard } from "@/components/RiskGateCard";
import { TransactionHistory } from "@/components/TransactionHistory";
import { agentSymbols, openLevels } from "@/components/agent-utils";
import { AgentAvatar, EmptyState, StatusBadge, TierBadge } from "@/components/ui-perpetua";
import { useAgents } from "@/components/useAgents";
import { scrollToId, useHashScroll } from "@/components/motion";
import { apiFetch } from "@/lib/api";

const SECTIONS = [["add-capital", "Add capital"], ["investments", "Investments"], ["history", "History"]] as const;

function DraftSetup({ id, name }: { id: string; name: string }) {
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  return <div className="space-y-4 pt-8"><Button asChild variant="ghost"><Link href="/"><ArrowLeft /> Dashboard</Link></Button><h1 className="font-display text-5xl">{name}</h1><p className="max-w-xl text-muted-foreground">Your strategy is saved. Finish setup to create its local test agent. Live deposits and trading are not enabled.</p><Button disabled={busy} onClick={async () => { setBusy(true); setMessage(""); try { const response = await apiFetch(`/v1/agent-definitions/${id}/deploy`, { method: "POST" }); const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Setup failed"); window.dispatchEvent(new Event("perpetua:capital-changed")); setMessage("Test agent created. Loading your agent…"); } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); } }}>{busy ? "Setting up…" : "Finish test setup"}</Button>{message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}</div>;
}

export default function AgentPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params); const { agents, online } = useAgents(5000); const a = agents.find((a) => a.id === name);
  useHashScroll(!!a);
  if (!a)
    return online === null ? (
      <div className="space-y-3 pt-6" aria-busy="true">
        <p className="sr-only">Loading agent…</p>
        <Skeleton className="h-16 w-80 rounded-2xl" />
        <Skeleton className="h-[420px] rounded-[28px]" />
      </div>
    ) : (
      <EmptyState className="mt-10" title="Agent not found in your account." action={<Button asChild variant="outline"><Link href="/">Back to dashboard</Link></Button>} />
    );

  if (!a.chain) return <DraftSetup id={a.id} name={a.name} />;

  return (
    <div className="space-y-3">
      <div className="pt-4 pb-5 lg:pt-6">
        <Button asChild variant="ghost" size="sm" className="-ml-3">
          <Link href="/"><ArrowLeft /> Dashboard</Link>
        </Button>
        <div data-reveal className="mt-3 flex flex-wrap items-end justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <AgentAvatar name={a.name} className="size-14 text-base" />
            <div className="min-w-0">
              <h1 className="truncate font-display text-5xl leading-none tracking-tight sm:text-6xl">{a.name}</h1>
              <p className="mt-2 text-muted-foreground">{a.strategy}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={a.status} />
            {a.runtime?.tier && <TierBadge tier={a.runtime.tier} />}
          </div>
        </div>
        <nav data-reveal aria-label="Sections" className="mt-5 flex flex-wrap gap-1.5">
          {SECTIONS.map(([id, label]) => (
            <Button key={id} variant="chip-outline" asChild>
              <a href={`#${id}`} onClick={(e) => { if (scrollToId(id)) e.preventDefault(); }}>{label}</a>
            </Button>
          ))}
        </nav>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <MarketChart symbols={agentSymbols(a)} levels={openLevels(a)} agentName={a.name} />
          <RiskGateCard agent={a} />
        </div>
        <Funding agent={a.id} name={a.name} value={a.chain?.V ?? 0} profit={a.profit ?? 0} className="lg:sticky lg:top-6 lg:self-start" />
      </div>
      <Investments agent={a.id} />
      <TransactionHistory agent={a.id} />
    </div>
  );
}

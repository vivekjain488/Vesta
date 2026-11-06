/** Pure view helpers over the dashboard's AgentView rows. No fetching, no invented values. */
import type { AgentView } from "./useAgents";
import type { TradeLevels } from "./MarketChart";

export type DashboardAgent = AgentView & { deposited?: number; withdrawn?: number };

export const isFunded = (a: AgentView) => !!a.chain && a.status !== "awaiting_funding" && a.status !== "draft";
export const agentHref = (a: AgentView) => (a.chain ? `/agent/${a.id}` : "/studio");

export const openTrades = (a: AgentView) => ((a.runtime?.trades ?? []) as any[]).filter((t) => t.status === "open");
export const hasOpenTrade = (a: AgentView) => openTrades(a).length > 0;

/** Levels of the newest open trade, unless it is still under the 15-minute embargo. */
export function openLevels(a: AgentView | undefined): TradeLevels | null {
  if (!a) return null;
  const t = openTrades(a).sort((x, y) => (y.openedAt ?? 0) - (x.openedAt ?? 0))[0];
  if (!t || t.embargoed) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const levels = { entry: n(t.entry), stop: n(t.stop), target: n(t.target) };
  return levels.entry ?? levels.stop ?? levels.target ? levels : null;
}

/** Assets this agent has actually traded or signalled; the chart falls back to LINK (the default spot asset). */
export function agentSymbols(a: AgentView | undefined): string[] {
  if (!a) return [];
  const xs = [...((a.runtime?.trades ?? []) as any[]), ...((a.runtime?.signals ?? []) as any[])].map((x) => String(x.asset ?? "")).filter(Boolean);
  return [...new Set(xs)];
}

export const statusOf = (a: AgentView) => a.status ?? "active";

import type { AgentDefinition, Bar, StrategyConfig } from "@perpetua/core";
import type { InferenceProvider } from "../inference";

export interface PortfolioBinding {
  id: string; owner: string; chainId: number; rpc: string; vault: string; wallet: string; riskGate: string; stable: string;
}
export interface RuntimeAgent {
  id: string; owner: string; name: string; revision: number; configHash: string; config: StrategyConfig;
  instructions: string; portfolioId: string; mode: "analysis" | "execute"; status: "active" | "paused";
  generation?: number;
}
export interface Observation<T = unknown> {
  sourceKind: "live_feed" | "chain_read" | "arkiv_history"; source: string; symbol?: string;
  sourceAtMs: number; receivedAtMs: number; hash: string; data: T;
}
export interface PortfolioState {
  portfolioId: string; owner: string; sourceAtMs: number; cashMicros: string; capacityMicros: string;
  positions: unknown[]; blockNumber?: string;
}
export interface Memory {
  version: number; summary: string; lastDecision?: Decision; lastRunId?: string;
  updatedAtMs: number; sourceEvents: string[];
}
export type ToolCall = { tool: "market.live" | "market.history" | "portfolio.current" | "memory.search"; symbol?: string; limit?: number };
export interface Decision {
  decision: "hold" | "buy" | "sell"; symbol?: string; notionalMicros?: string;
  rationaleSummary: string; evidenceRefs: string[]; memorySummary: string;
}
export interface ModelTurn { tools?: ToolCall[]; decision?: Decision }
export interface RunRecord {
  id: string; agentId: string; slot: number; revision: number; fence: number; leaseUntil: number;
  status: string; startedAtMs: number; finishedAtMs?: number; decision?: Decision; error?: string;
  snapshot?: RuntimeAgent;
}
export interface AuditEvent {
  id: string; owner: string; agentId: string; portfolioId: string; runId: string; revision: number;
  sequence: number; kind: string; atMs: number; payload: unknown;
}
export interface Action {
  id: string; agentId: string; portfolioId: string; runId: string; revision: number; decision: Decision;
  state: "reserved" | "submitting" | "submitted" | "unknown" | "filled" | "cancelled" | "rejected";
  reservationMicros: string; createdAtMs: number; externalId?: string;
  generation?: number;
}
export interface ExecutionResult {
  state: "submitted" | "unknown" | "filled" | "cancelled" | "rejected"; externalId?: string;
  transactions?: { chainId: number; hash: string; state: string }[]; details?: unknown;
}
/** Trusted adapters own fresh quotes, deterministic sizing, lot attribution, gate/proof checks and venue idempotency. */
export interface ExecutionAdapter {
  authorizeActivation(agent: RuntimeAgent, portfolio: PortfolioBinding): Promise<{ ok: boolean; reason?: string }>;
  validate(action: Action, agent: RuntimeAgent, portfolio: PortfolioBinding, signal: AbortSignal): Promise<{ ok: boolean; reason?: string }>;
  submit(action: Action, agent: RuntimeAgent, portfolio: PortfolioBinding, signal: AbortSignal): Promise<ExecutionResult>;
  reconcile(action: Action, portfolio: PortfolioBinding, signal: AbortSignal): Promise<ExecutionResult>;
}
export interface RuntimePorts {
  inference(agent: RuntimeAgent): Promise<InferenceProvider>;
  live(symbol: string, market: StrategyConfig["market"], signal: AbortSignal): Promise<Observation>;
  history(symbol: string, limit: number, signal: AbortSignal): Promise<Observation<{ bars: Bar[]; entityKey: string }>>;
  portfolio(binding: PortfolioBinding, signal: AbortSignal): Promise<PortfolioState>;
  episodes?(agent: RuntimeAgent, limit: number, signal: AbortSignal): Promise<unknown[]>;
  executor?: ExecutionAdapter;
}
export type RuntimeDefinition = AgentDefinition;
export type { InferenceResult } from "../inference";

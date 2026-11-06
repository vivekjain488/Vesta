"use client";
import { useCallback, useEffect, useState } from "react";
import { applyRiskProfile, configAuthMessage, configHash, RISK_PROFILES, STRATEGY_TEMPLATES, templateConfig, type AgentDefinition, type RiskProfile, type StrategyConfig } from "@perpetua/core";
import { apiFetch, API } from "@/lib/api";
import { useWallet } from "@/components/Wallet";
import { PageHeader, StatusNote } from "@/components/ui-perpetua";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface Portfolio { id: string; chainId: number; vault: string }
interface Agent { id: string; name: string; status: string; portfolioId: string; mode: string }
interface Latest { run: { status: string; startedAtMs: number; error?: string; decision?: { decision: string; symbol?: string; rationaleSummary: string } } | null; disposition?: { kind: string; payload: { reason?: string } }; publication: { total: number; confirmed: number }; actions: { id: string; state: string }[] }
async function body<T>(response: Response): Promise<T> { const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Request failed"); return data as T; }
const selectClass = "w-full rounded-2xl bg-muted px-4 py-3 text-sm";

export default function RuntimePage() {
  const wallet = useWallet();
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]), [agents, setAgents] = useState<Agent[]>([]), [definitions, setDefinitions] = useState<AgentDefinition[]>([]);
  const [deployments, setDeployments] = useState<{ id: string; name: string }[]>([]), [deploymentId, setDeploymentId] = useState("");
  const [portfolioId, setPortfolioId] = useState(""), [agentId, setAgentId] = useState("");
  const [name, setName] = useState(""), [instructions, setInstructions] = useState(""), [template, setTemplate] = useState<StrategyConfig["template"]>("spot-momentum"), [symbols, setSymbols] = useState("BTC, ETH");
  const [profile, setProfile] = useState<RiskProfile>("balanced");
  const [latest, setLatest] = useState<Latest | null>(null), [memory, setMemory] = useState<{ version: number; summary: string } | null>(null), [history, setHistory] = useState<string>("");
  const [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const [p, a, d, dashboard] = await Promise.all([
      apiFetch("/v1/runtime/portfolios").then(body<Portfolio[]>), apiFetch("/v1/runtime/agents").then(body<Agent[]>),
      apiFetch("/v1/agent-definitions").then(body<AgentDefinition[]>), apiFetch("/v1/dashboard").then(body<{ id: string; name: string; chain?: unknown }[]>),
    ]);
    setPortfolios(p); setAgents(a); setDefinitions(d); setDeployments(dashboard.filter((x) => x.chain));
    setPortfolioId((value) => value || p[0]?.id || ""); setDeploymentId((value) => value || dashboard.find((x) => x.chain)?.id || "");
  }, []);
  useEffect(() => { if (!wallet.address) return; let cancelled = false; const refresh = () => { void load().catch((e) => { if (!cancelled) setMessage(e.message); }); }; refresh(); const timer = setInterval(refresh, 10000); return () => { cancelled = true; clearInterval(timer); }; }, [load, wallet.address]);
  useEffect(() => {
    setLatest(null); setMemory(null); setHistory(""); if (!agentId) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const [decision, context] = await Promise.all([apiFetch(`/v1/runtime/agents/${agentId}/decision`).then(body<Latest>), apiFetch(`/v1/runtime/agents/${agentId}/memory`).then(body<{ version: number; summary: string }>)]);
        if (!cancelled) { setLatest(decision); setMemory(context); }
      } catch (e) { if (!cancelled) setMessage((e as Error).message); }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 5000); return () => { cancelled = true; clearInterval(timer); };
  }, [agentId]);
  async function signed<T>(action: string, payload: unknown, path: string): Promise<T> {
    if (!wallet.address) throw new Error("Sign in first");
    const c = await body<{ nonce: string; expiresAt: number; message: string }>(await apiFetch("/v1/config/challenge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: wallet.address, action, payload }) }));
    const message = configAuthMessage(wallet.address, action, payload, c.nonce, c.expiresAt, new URL(API).origin);
    if (message !== c.message) throw new Error("Signing request does not match this operation");
    const signature = await wallet.signMessage(message);
    return body<T>(await apiFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: wallet.address, action, payload, nonce: c.nonce, signature }) }));
  }
  async function work(operation: () => Promise<void>) { setBusy(true); setMessage(""); try { await operation(); await load(); } catch (e) { setMessage((e as Error).message); } finally { setBusy(false); } }
  async function activate(d: AgentDefinition) {
    if (!portfolioId) throw new Error("Select a shared portfolio first");
    await signed("activate-runtime", { id: d.id, revision: d.revision, portfolioId, mode: "analysis", configHash: d.configHash, instructionsHash: configHash(d.instructions ?? "") }, `/v1/runtime/agents/${d.id}/activate`);
    setAgentId(d.id); setMessage("Agent activated. Its next minute run will appear here.");
  }
  return <div className="space-y-6 pt-4 lg:pt-6">
    <PageHeader eyebrow="Hosted agents" title="One portfolio, independent agents" description="Each active agent makes an AI decision every minute using live state, past trends and its own memory." />
    {message && <div role="status"><StatusNote>{message}</StatusNote></div>}
    <div className="grid gap-4 lg:grid-cols-2">
      <Card><CardHeader><CardTitle>Shared portfolio</CardTitle><CardDescription>Connect an existing funded allocation. Every agent you activate below can observe this shared portfolio.</CardDescription></CardHeader><CardContent className="space-y-3">
        <Label htmlFor="runtime-portfolio">Portfolio</Label><select id="runtime-portfolio" className={selectClass} value={portfolioId} onChange={(e) => setPortfolioId(e.target.value)}><option value="">Select a portfolio</option>{portfolios.map((p) => <option key={p.id} value={p.id}>Chain {p.chainId} · {p.vault.slice(0, 10)}…</option>)}</select>
        <Label htmlFor="runtime-deployment">Existing allocation</Label><select id="runtime-deployment" className={selectClass} value={deploymentId} onChange={(e) => setDeploymentId(e.target.value)}><option value="">Select an owned allocation</option>{deployments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        <Button disabled={busy || !deploymentId} onClick={() => void work(async () => { const p = await signed<Portfolio>("bind-portfolio", { deploymentAgentId: deploymentId }, "/v1/runtime/portfolios"); setPortfolioId(p.id); setMessage("Shared portfolio connected."); })}>Connect allocation</Button>
        {!deployments.length && <p className="text-sm text-muted-foreground">Create and fund an allocation from the dashboard first.</p>}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Create an agent</CardTitle><CardDescription>Decisions, explanations and strategy memory are public on Arkiv. Analysis mode produces proposals without placing orders.</CardDescription></CardHeader><CardContent className="space-y-3">
        <Label htmlFor="runtime-name">Unique name for your wallet</Label><Input id="runtime-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        <Label htmlFor="runtime-template">Strategy template</Label><select id="runtime-template" className={selectClass} value={template} onChange={(e) => setTemplate(e.target.value as StrategyConfig["template"])}>{STRATEGY_TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
        <Label htmlFor="runtime-profile">Risk personality</Label><select id="runtime-profile" className={selectClass} value={profile} onChange={(e) => setProfile(e.target.value as RiskProfile)}>{(Object.keys(RISK_PROFILES) as RiskProfile[]).map((key) => <option key={key} value={key}>{RISK_PROFILES[key].label} · ${RISK_PROFILES[key].maxNotionalUsd} max order</option>)}</select>
        <p className="text-sm text-muted-foreground">{RISK_PROFILES[profile].description} Risk per trade target: {RISK_PROFILES[profile].riskPerTradePct}%; daily loss setting: {RISK_PROFILES[profile].maxDailyLossPct}%.</p>
        <Label htmlFor="runtime-symbols">Assets</Label><Input id="runtime-symbols" value={symbols} onChange={(e) => setSymbols(e.target.value)} />
        <Label htmlFor="runtime-instructions">Personality and instructions</Label><Textarea id="runtime-instructions" maxLength={3500} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Describe what to watch, how to interpret the template, and what context to remember." />
        <p className="text-sm text-muted-foreground">Uses closed 4h trends. Personality guides analysis and sizing within the signed limits; it does not guarantee returns or limit losses.</p>
        <Button disabled={busy || !name.trim() || !portfolioId} onClick={() => void work(async () => { const config = applyRiskProfile(templateConfig(template), profile); config.symbols = symbols.toUpperCase().split(",").map((s) => s.trim()); const preferences = [RISK_PROFILES[profile].instructions, instructions.trim()].filter(Boolean).join("\n\n"); const d = await signed<AgentDefinition>("create", { name, instructions: preferences, config, status: "draft" }, "/v1/agent-definitions"); await activate(d); setName(""); })}>Create and activate analysis</Button>
      </CardContent></Card>
    </div>
    <Card><CardHeader><CardTitle>Your agents</CardTitle><CardDescription>Agent memory stays separate. Market observations and the selected capital allocation are shared.</CardDescription></CardHeader><CardContent className="space-y-3">
      {definitions.map((d) => { const runtime = agents.find((a) => a.id === d.id); return <div key={d.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-muted p-4"><div><p className="font-medium">{d.name}</p><p className="text-sm text-muted-foreground">{d.config.template} · {runtime?.status ?? "draft"} {runtime ? `· ${runtime.mode}` : ""} · ${d.config.risk.maxNotionalUsd} max order · {d.config.risk.riskPerTradePct}% risk target</p>{d.instructions && <p className="mt-1 max-w-xl text-sm text-muted-foreground">{d.instructions}</p>}</div><div className="flex gap-2">{runtime && <Button variant="ghost" onClick={() => setAgentId(d.id)}>Inspect</Button>}{runtime?.status === "active" ? <Button disabled={busy} variant="secondary" onClick={() => void work(async () => { await signed("pause-runtime", { id: d.id }, `/v1/runtime/agents/${d.id}/pause`); setMessage("Agent paused."); })}>Pause</Button> : <Button disabled={busy || !portfolioId || d.status === "sleeping"} onClick={() => void work(() => activate(d))}>Activate analysis</Button>}</div></div>; })}
      {!definitions.length && <p className="text-sm text-muted-foreground">Create your first agent above.</p>}
    </CardContent></Card>
    {agentId && <Card><CardHeader><CardTitle>{definitions.find((a) => a.id === agentId)?.name ?? "Agent"}: latest decision</CardTitle></CardHeader><CardContent className="space-y-4">
      {latest?.run ? <><p className="font-medium">{latest.run.decision?.decision.toUpperCase()} {latest.run.decision?.symbol} · {latest.run.status}</p><p>{latest.run.decision?.rationaleSummary}</p><p className="text-sm text-muted-foreground">{new Date(latest.run.startedAtMs).toLocaleString()}{latest.run.error ? ` · ${latest.run.error}` : ""}</p></> : <p>Waiting for the next minute run.</p>}
      <div><p className="font-medium">Memory · version {memory?.version ?? 0}</p><p className="text-sm text-muted-foreground">{memory?.summary || "Memory appears after the first completed run."}</p></div>
      <p className="text-sm text-muted-foreground">Arkiv: {latest?.publication.confirmed ?? 0} / {latest?.publication.total ?? 0} events confirmed</p>
      {latest?.disposition && <p className="text-sm">Proposal outcome: {latest.disposition.kind.replace(/^action_/, "").replaceAll("_", " ")}{latest.disposition.payload.reason ? ` · ${latest.disposition.payload.reason.replaceAll("_", " ")}` : ""}</p>}
      {latest?.actions.map((a) => <p key={a.id} className="text-sm">Execution: {a.state}</p>)}
      <Button variant="secondary" disabled={busy} onClick={() => void work(async () => { const events = await body<unknown>(await apiFetch(`/v1/runtime/agents/${agentId}/events?source=arkiv`)); setHistory(JSON.stringify(events, null, 2)); })}>Read confirmed Arkiv history</Button>
      {history && <pre className="max-h-96 overflow-auto rounded-2xl bg-muted p-4 text-xs">{history}</pre>}
    </CardContent></Card>}
  </div>;
}

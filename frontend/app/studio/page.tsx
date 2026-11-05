"use client";
import { useEffect, useState } from "react";
import { configAuthMessage, STRATEGY_TEMPLATES, templateConfig, validateStrategyConfig, type AgentDefinition, type StrategyConfig } from "@perpetua/core";
import { API } from "@/lib/data";
import { useWallet } from "@/components/Wallet";

export default function Studio() {
  const wallet = useWallet();
  const [name, setName] = useState("My agent");
  const [selected, setSelected] = useState<StrategyConfig["template"]>("perp-trend");
  const [json, setJson] = useState(JSON.stringify(templateConfig("perp-trend"), null, 2));
  const [prompt, setPrompt] = useState("");
  const [notes, setNotes] = useState<string[]>([]);
  const [unresolved, setUnresolved] = useState(false);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [editing, setEditing] = useState<AgentDefinition | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"draft" | "paper">("draft");
  async function readResponse(r: Response) {
    const body = await r.json();
    if (!r.ok) throw new Error(body.error ?? `API ${r.status}`);
    return body;
  }
  async function refresh() {
    if (wallet.address) setAgents(await readResponse(await fetch(`${API}/v1/agent-definitions?owner=${encodeURIComponent(wallet.address)}`)));
    else setAgents([]);
  }
  useEffect(() => { refresh().catch((e) => setStatus(e.message)); }, [wallet.address]);
  async function signed(action: "create" | "update" | "compile", payload: unknown, path: string, method = "POST", authorizationPayload = payload) {
    if (!wallet.address) throw new Error("Connect your owner wallet first");
    const challenge = await readResponse(await fetch(`${API}/v1/config/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: wallet.address, action, payload: authorizationPayload }) }));
    // Recompute the message locally: the API cannot substitute another owner/action/config.
    const audience = new URL(API).origin;
    const expected = configAuthMessage(wallet.address, action, authorizationPayload, challenge.nonce, challenge.expiresAt, audience);
    if (challenge.message !== expected) throw new Error("Signing request does not match this service and configuration");
    const signature = await wallet.signMessage(expected);
    return readResponse(await fetch(`${API}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: wallet.address, payload, nonce: challenge.nonce, signature }) }));
  }
  async function run(task: () => Promise<void>) {
    setBusy(true); setStatus("");
    try { await task(); } catch (e) { setStatus((e as Error).message); } finally { setBusy(false); }
  }
  const selectTemplate = (id: StrategyConfig["template"]) => {
    setSelected(id); setJson(JSON.stringify(templateConfig(id), null, 2)); setNotes([]); setUnresolved(false); setEditing(null);
  };
  const edit = (mutate: (config: StrategyConfig) => void) => {
    try { const next = JSON.parse(json); mutate(next); setJson(JSON.stringify(next, null, 2)); } catch { setStatus("Fix the advanced configuration JSON first"); }
  };
  let draft: StrategyConfig | null = null;
  try { draft = JSON.parse(json); } catch {}
  return <div className="mx-auto max-w-5xl py-12">
    <p className="text-xs uppercase tracking-widest text-dim">Strategy studio</p>
    <h1 className="mt-3 font-display text-5xl">One wallet. Your agents.</h1>
    <p className="mt-4 max-w-3xl text-paper/75">Choose a starting strategy or describe your own. Review its parameters and save a draft for paper evaluation. A 20–30 second reasoning delay is an execution constraint; these strategies use longer holding horizons. Templates have no established profitability.</p>
    <ol className="mt-6 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">{["1. Connect MetaMask", "2. Choose a strategy", "3. Review allocation", "4. Save agent"].map((step) => <li key={step} className="rounded-sm border border-line bg-panel p-3">{step}</li>)}</ol>
    <p className="mt-3 text-sm text-dim">Funding and on-chain deployment are the next integration step. Saving a draft does not deposit funds. Once connected, hosted workers handle scheduling; keeping a browser tab open is not required.</p>
    <div className="my-6 flex flex-wrap items-center gap-3">
      <button className="rounded-sm bg-cushion px-4 py-2 text-ink" disabled={busy} onClick={() => run(async () => { await wallet.connect(); })}>{wallet.address ? "Owner wallet connected" : "Connect owner wallet"}</button>
      <span className="num break-all text-xs text-dim">{wallet.address}</span>
    </div>
    <div className="grid gap-8 md:grid-cols-[1fr_1.4fr]">
      <section className="space-y-4">
        <h2 className="font-display text-3xl">Strategy templates</h2>
        {STRATEGY_TEMPLATES.map((t) => <button key={t.id} onClick={() => selectTemplate(t.id)} className={`block w-full rounded-sm border p-4 text-left ${selected === t.id ? "border-cushion bg-cushion/5" : "border-line bg-panel"}`}>
          <span className="font-medium">{t.label}</span><span className="ml-2 text-xs text-dim">{t.market === "perpetual" ? "Futures research" : "Spot"}</span><p className="mt-1 text-sm text-dim">{t.description}</p>
        </button>)}
        <label htmlFor="strategy-prompt" className="block text-sm">Describe your strategy</label>
        <textarea id="strategy-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={4000} rows={5} className="w-full rounded-sm border border-line bg-panel p-3" placeholder="Trade BTC and ETH trends, use at most 2× leverage, risk 0.25% per trade, and account for a 30-second execution delay." />
        <button disabled={busy || !wallet.address || prompt.trim().length < 10} className="rounded-sm border border-cushion px-4 py-2 disabled:opacity-40" onClick={() => run(async () => {
          const result = await signed("compile", { prompt }, "/v1/strategy/compile");
          setJson(JSON.stringify(result.config, null, 2)); setSelected(result.config.template); setUnresolved(result.requiresClarification);
          setNotes([...result.assumptions, ...result.unsupportedRequirements.map((s: string) => `Needs clarification: ${s}`), `0G request: ${result.proof.chatId}`]);
          setStatus("Draft generated. Review every parameter before saving.");
        })}>{busy ? "Working…" : "Generate draft with 0G"}</button>
        {notes.length > 0 && <ul className="list-disc space-y-2 pl-5 text-sm text-dim">{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      </section>
      <section>
        <h2 className="font-display text-3xl">{editing ? "Edit agent" : "Configure agent"}</h2>
        <label htmlFor="agent-name" className="mt-4 block text-sm">Name</label>
        <input id="agent-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className="mt-1 w-full rounded-sm border border-line bg-panel p-2" />
        {draft && <div className="mt-4 grid grid-cols-2 gap-4">
          <label className="text-sm">Assets<input aria-label="Assets" value={draft.symbols?.join(", ") ?? ""} onChange={(e) => edit((c) => { c.symbols = e.target.value.toUpperCase().split(",").map((s) => s.trim()); })} className="mt-1 w-full border border-line bg-panel p-2" /></label>
          <label className="text-sm">Direction<select value={draft.direction} onChange={(e) => edit((c) => { c.direction = e.target.value as StrategyConfig["direction"]; })} className="mt-1 w-full border border-line bg-panel p-2"><option value="long">Long only</option>{draft.market === "perpetual" && <><option value="short">Short only</option><option value="both">Long & short</option></>}</select></label>
          <label className="text-sm">Exposure cap (USD)<input type="number" value={draft.risk?.maxNotionalUsd ?? 100} min={1} max={100000} onChange={(e) => edit((c) => { c.risk.maxNotionalUsd = Number(e.target.value); })} className="mt-1 w-full border border-line bg-panel p-2" /></label>
          <label className="text-sm">Leverage cap<input type="number" value={draft.risk?.maxLeverage ?? 1} min={1} max={draft.market === "spot" ? 1 : 2} step={0.1} onChange={(e) => edit((c) => { c.risk.maxLeverage = Number(e.target.value); })} className="mt-1 w-full border border-line bg-panel p-2" /></label>
          <label className="text-sm">Risk per trade (%)<input type="number" value={draft.risk?.riskPerTradePct ?? 0.25} min={0.01} max={1} step={0.05} onChange={(e) => edit((c) => { c.risk.riskPerTradePct = Number(e.target.value); })} className="mt-1 w-full border border-line bg-panel p-2" /></label>
          <label className="text-sm">Premium model from (USD)<input type="number" value={draft.compute?.premiumCapitalThresholdUsd ?? 5000} min={100} max={1000000} onChange={(e) => edit((c) => { c.compute.premiumCapitalThresholdUsd = Number(e.target.value); })} className="mt-1 w-full border border-line bg-panel p-2" /></label>
        </div>}
        <p className="mt-3 text-xs text-dim">Below the premium threshold, eligible agents use a cheaper model. Compute runway and spend limits can reduce usage further. Risk settings are modeling constraints, not guaranteed loss limits.</p>
        <details className="mt-5"><summary className="cursor-pointer text-sm text-dim">Advanced strategy settings</summary><label htmlFor="strategy-json" className="mt-4 block text-sm">Configuration · percentages use 0–100</label><textarea id="strategy-json" value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} rows={28} className="num mt-2 w-full rounded-sm border border-line bg-panel p-3 text-xs" /></details>
        <label htmlFor="agent-mode" className="mt-3 block text-sm">Review status</label>
        <select id="agent-mode" value={mode} onChange={(e) => setMode(e.target.value as "draft" | "paper")} className="mt-1 rounded-sm border border-line bg-panel p-2"><option value="draft">Draft</option><option value="paper">Ready for paper evaluation</option></select>
        {unresolved && <p className="mt-2 text-exposure">Some requirements are unsupported. Revise your description and regenerate, or choose a template.</p>}
        <button disabled={busy || !wallet.address || unresolved} className="mt-4 rounded-sm bg-cushion px-4 py-2 text-ink disabled:opacity-40" onClick={() => run(async () => {
          const config = validateStrategyConfig(JSON.parse(json));
          const payload = { name, config, status: mode, ...(editing ? { revision: editing.revision } : {}) };
          const agent = editing ? await signed("update", payload, `/v1/agent-definitions/${editing.id}`, "PUT", { id: editing.id, ...payload }) : await signed("create", payload, "/v1/agent-definitions");
          setEditing(agent); await refresh(); setStatus(`Saved ${agent.name}, revision ${agent.revision}. This draft is not connected to funds or a trading venue.`);
        })}>{editing ? "Sign & save changes" : "Sign & create agent draft"}</button>
      </section>
    </div>
    {status && <p role="status" className="my-5 rounded-sm border border-line p-3 text-sm">{status}</p>}
    <section className="mt-10"><h2 className="font-display text-3xl">Your agent drafts</h2><p className="mt-2 text-sm text-dim">Each draft has its own ID and configuration. Drafts are public configuration records. On-chain deployment and live futures activation are not available here.</p>
      <div className="mt-4 grid gap-3 md:grid-cols-2">{agents.map((a) => <button key={a.id} onClick={() => { setEditing(a); setName(a.name); setSelected(a.config.template); setJson(JSON.stringify(a.config, null, 2)); setNotes([]); setUnresolved(false); }} className="rounded-sm border border-line bg-panel p-4 text-left"><p>{a.name} · {a.config.template}</p><p className="num mt-2 break-all text-xs text-dim">{a.id}</p><p className="mt-2 text-xs text-dim">{a.status} · revision {a.revision} · {a.config.symbols.join(", ")}</p></button>)}</div>
    </section>
  </div>;
}

"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, Flame, Loader2, Minus, Plus, RotateCcw, Scale, ShieldCheck, Sparkles, TriangleAlert } from "lucide-react";
import { AGENT_PRESETS, configAuthMessage, STRATEGY_TEMPLATES, templateConfig, validateStrategyConfig, type AgentPreset, type RiskTierId, type StrategyConfig } from "@perpetua/core";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Micro, PageHeader, StatusNote, ValueField } from "@/components/ui-perpetua";
import { apiFetch, API } from "@/lib/api";
import { useWallet } from "@/components/Wallet";
import { ActionSheet, useActionFlow, type FlowStep } from "@/components/ActionSheet";
import { ZeroGText } from "@/components/ZeroG";
import { cn } from "@/lib/utils";

const CREATE_STEPS: FlowStep[] = [
  { label: "Sign", match: /^Review and sign your agent/, title: "Signing your agent" },
  { label: "Deploy", match: /^Creating your agent contracts/, title: "Deploying agent contracts" },
  { label: "Open", match: /(?!)/, title: "Opening your agent" },
];
const TIER_ICON = { conservative: ShieldCheck, balanced: Scale, aggressive: Flame } as const;
const KIND_LABEL: Record<AgentPreset["kind"], string> = { adaptive: "Adaptive: trend + range", momentum: "Trend momentum", "mean-reversion": "Range reversion", dca: "Accumulation" };
const pct = (n: number, d = 1) => `${n > 0 ? "+" : ""}${n.toFixed(d)}%`;
const month = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en", { month: "short", year: "numeric", timeZone: "UTC" });

/** The reference's "- value +" field; the value stays directly editable. */
function NumberField({ id, label, value, step, min, max, onChange }: { id: string; label: string; value: number; step: number; min?: number; max?: number; onChange: (n: number) => void }) {
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, Math.round(n * 1e6) / 1e6));
  return (
    <div className="flex items-center gap-1 rounded-2xl bg-muted p-1.5">
      <Button type="button" variant="ghost" size="icon" aria-label={`Decrease ${label}`} onClick={() => onChange(clamp(value - step))} disabled={min !== undefined && value <= min}>
        <Minus />
      </Button>
      <div className="min-w-0 flex-1 text-center">
        <Label htmlFor={id} className="justify-center text-xs font-normal text-muted-foreground">{label}</Label>
        <input id={id} type="number" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="num w-full bg-transparent text-center text-lg font-semibold tracking-tight outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none" />
      </div>
      <Button type="button" variant="ghost" size="icon" aria-label={`Increase ${label}`} onClick={() => onChange(clamp(value + step))} disabled={max !== undefined && value >= max}>
        <Plus />
      </Button>
    </div>
  );
}

function TierCard({ preset, active, onSelect }: { preset: AgentPreset; active: boolean; onSelect: () => void }) {
  const Icon = TIER_ICON[preset.id];
  const wf = preset.backtest.walkForward;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={cn(
        "group relative flex h-full flex-col gap-4 rounded-[28px] bg-card p-5 text-left transition-[box-shadow,transform] duration-200 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "ring-2 ring-trade shadow-[0_12px_32px_-18px_rgba(255,77,0,0.55)]" : "ring-1 ring-border/60",
      )}
    >
      <span className="flex items-start justify-between gap-3">
        <span className={cn("grid size-11 place-items-center rounded-2xl", active ? "bg-trade text-foreground" : "bg-muted text-foreground")}><Icon className="size-5" /></span>
        {active ? <Badge variant="trade-solid" size="micro">Selected</Badge> : <Badge variant="muted" size="micro">Tier {preset.profile.onchainTier}</Badge>}
      </span>
      <span>
        <span className="font-display text-3xl leading-none">{preset.profile.label}</span>
        <span className="mt-2 block text-sm text-muted-foreground">{preset.profile.tagline}</span>
      </span>
      <dl className="grid grid-cols-3 gap-2 text-sm">
        <div className="rounded-2xl bg-muted px-3 py-2"><dt className="text-[11px] text-muted-foreground">Floor</dt><dd className="num font-semibold">{preset.profile.piBps / 100}%</dd></div>
        <div className="rounded-2xl bg-muted px-3 py-2"><dt className="text-[11px] text-muted-foreground">Exposure</dt><dd className="num font-semibold">{preset.profile.multiplier}× cushion</dd></div>
        <div className="rounded-2xl bg-muted px-3 py-2"><dt className="text-[11px] text-muted-foreground">Risk / trade</dt><dd className="num font-semibold">{preset.profile.riskPerTradePct}%</dd></div>
      </dl>
      <div className="mt-auto rounded-2xl border border-dashed border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <Micro>Out-of-sample · after costs</Micro>
          <Badge variant="outline" size="micro">{KIND_LABEL[preset.kind]}</Badge>
        </div>
        {wf ? (
          <>
            <dl className="mt-2 grid grid-cols-3 gap-2">
              <div><dt className="text-[11px] text-muted-foreground">Return / yr</dt><dd className={cn("num text-lg font-semibold", wf.cagrPct >= 0 ? "text-profit" : "text-loss")}>{pct(wf.cagrPct, 2)}</dd></div>
              <div><dt className="text-[11px] text-muted-foreground">Max drawdown</dt><dd className="num text-lg font-semibold">−{wf.maxDrawdownPct.toFixed(1)}%</dd></div>
              <div><dt className="text-[11px] text-muted-foreground">Trades</dt><dd className="num text-lg font-semibold">{wf.trades}</dd></div>
            </dl>
            <p className="mt-2 text-xs text-muted-foreground">
              {month(wf.from)} – {month(wf.to)} · BTC/ETH buy &amp; hold {pct(wf.buyHoldPct)} · floor {wf.floorHeld ? "held" : "breached"}
            </p>
          </>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">Backtest not generated yet. Run <code className="font-mono">pnpm optimize:presets</code>.</p>
        )}
      </div>
    </button>
  );
}

export default function Studio() {
  const router = useRouter(); const wallet = useWallet();
  const [tier, setTier] = useState<RiskTierId>("balanced");
  const preset = useMemo(() => AGENT_PRESETS.find((p) => p.id === tier)!, [tier]);
  const [suffix] = useState(() => Math.random().toString(36).slice(2, 5).toUpperCase());
  const [customName, setCustomName] = useState<string | null>(null);
  const name = customName ?? `${preset.profile.label} BTC ETH ${suffix}`;
  const [config, setConfig] = useState<StrategyConfig>(preset.config);
  const [prompt, setPrompt] = useState(preset.prompt);
  const [notes, setNotes] = useState<string[]>([]); const [unresolved, setUnresolved] = useState(false);
  const [draftSource, setDraftSource] = useState<"0g" | "fireworks" | null>(null);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  const promptEdited = prompt.trim() !== preset.prompt;
  const configEdited = JSON.stringify(config) !== JSON.stringify(preset.config);

  const body = async (r: Response) => { const b = await r.json(); if (!r.ok) throw new Error(b.error); return b; };
  function edit(change: (c: StrategyConfig) => void) { setConfig((previous) => { const next = structuredClone(previous); change(next); return next; }); }
  function selectTier(id: RiskTierId) {
    const next = AGENT_PRESETS.find((p) => p.id === id)!;
    setTier(id); setConfig(next.config); setPrompt(next.prompt); setNotes([]); setUnresolved(false); setDraftSource(null); setMessage("");
  }
  function reset() { setConfig(preset.config); setPrompt(preset.prompt); setNotes([]); setUnresolved(false); setDraftSource(null); }
  async function signed(action: "create" | "compile", payload: unknown, path: string) {
    if (!wallet.address) throw new Error("Sign in first");
    const c = await body(await apiFetch("/v1/config/challenge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: wallet.address, action, payload }) }));
    const message = configAuthMessage(wallet.address, action, payload, c.nonce, c.expiresAt, new URL(API).origin);
    if (message !== c.message) throw new Error("Configuration signing request mismatch");
    const signature = await wallet.signMessage(message);
    return body(await apiFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: wallet.address, payload, nonce: c.nonce, signature }) }));
  }
  // The create flow ends by navigating away; if it finished on the deploy message (no error replaced it), it succeeded.
  const flow = useActionFlow({ busy, message, steps: CREATE_STEPS, success: /^Creating your agent contracts/ });
  async function run(work: () => Promise<void>) { setBusy(true); setMessage(""); try { await work(); } catch (e) { setMessage((e as Error).message); } finally { setBusy(false); } }

  const create = () => run(async () => {
    const validated = validateStrategyConfig({ ...config, riskTier: tier }); setMessage("Review and sign your agent in your wallet…");
    const definition = await signed("create", { name: name.trim(), config: validated, status: "draft", preset: tier, prompt: prompt.trim() }, "/v1/agent-definitions");
    setMessage("Creating your agent contracts…"); await body(await apiFetch(`/v1/agent-definitions/${definition.id}/deploy`, { method: "POST" })); router.push(`/agent/${definition.id}`);
  });
  const rebuild = () => run(async () => {
    const result = await signed("compile", { prompt: prompt.trim(), base: tier }, "/v1/strategy/compile");
    setConfig(result.config); setNotes([...result.assumptions, ...result.unsupportedRequirements]); setUnresolved(result.requiresClarification);
    setDraftSource(result.proof?.verificationSource === "external" ? "fireworks" : "0g");
  });

  return (
    <div className="space-y-6 pt-4 lg:pt-6">
      <PageHeader eyebrow="New agent" title="Pick a risk tier. Your agent does the rest." description="Each tier is a BTC/ETH strategy tuned on five years of real 4h candles, with a capital floor enforced on-chain. One signature creates and deploys it." />

      <div role="radiogroup" aria-label="Risk tier" className="grid gap-3 md:grid-cols-3">
        {AGENT_PRESETS.map((p) => <TierCard key={p.id} preset={p} active={p.id === tier} onSelect={() => selectTier(p.id)} />)}
      </div>
      <p className="text-xs text-muted-foreground">
        Simulated results on periods the parameters were not fitted on. {preset.backtest.method ?? "Walk-forward"}. Past performance does not predict future returns. Not financial advice.
      </p>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle>Agent prompt</CardTitle>
                  <CardDescription><ZeroGText text="Predefined for this tier. 0G reads the news with it on every decision; edit it to steer your agent." /></CardDescription>
                </div>
                {(promptEdited || configEdited) && <Button variant="ghost" size="sm" onClick={reset} disabled={busy}><RotateCcw /> Reset</Button>}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-[22px] bg-muted p-2">
                <Label htmlFor="agent-prompt" className="sr-only">Agent prompt</Label>
                <Textarea id="agent-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={4000} rows={6} className="min-h-36 resize-none bg-transparent text-sm leading-relaxed hover:bg-transparent focus-visible:bg-card" />
                <div className="flex flex-wrap items-center justify-between gap-2 px-2 pt-2 pb-1">
                  <Micro>{promptEdited ? "Edited · rules unchanged until you rebuild" : "Preset prompt"}</Micro>
                  <Button variant="chip" disabled={busy || !promptEdited || prompt.trim().length < 10} onClick={rebuild}>
                    {busy ? <Loader2 className="animate-spin" /> : <Sparkles />} Rebuild rules with 0G
                  </Button>
                </div>
              </div>
              {draftSource && (
                <Badge variant={draftSource === "0g" ? "brand" : "trade"} className="pop-in">
                  {draftSource === "0g" ? "Drafted by 0G Compute (TEE-verified)" : "Drafted by Fireworks fallback · not TEE-verified"}
                </Badge>
              )}
              {notes.length > 0 && (
                <ul className="space-y-1.5">
                  {notes.map((n, i) => <li key={i} className="rounded-2xl bg-brand-soft px-4 py-2.5 text-sm">{n}</li>)}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <Collapsible>
              <CardHeader>
                <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 text-left">
                  <span>
                    <CardTitle>Customize <span className="text-muted-foreground">(optional)</span></CardTitle>
                    <CardDescription className="mt-1">Assets, limits, strategy and raw parameters. The tier&apos;s on-chain floor stays fixed.</CardDescription>
                  </span>
                  <ChevronRight className="size-5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
                </CollapsibleTrigger>
              </CardHeader>
              <CollapsibleContent>
                <CardContent className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="assets">Assets</Label>
                    <Input id="assets" value={config.symbols.join(", ")} onChange={(e) => edit((c) => { c.symbols = e.target.value.toUpperCase().split(",").map((s) => s.trim()); })} />
                  </div>
                  <div className="grid gap-2.5 sm:grid-cols-2">
                    <NumberField id="max-exposure" label="Max exposure (USDC)" value={config.risk.maxNotionalUsd} step={50} min={1} onChange={(n) => edit((c) => { c.risk.maxNotionalUsd = n; })} />
                    <NumberField id="risk-per-trade" label="Risk per trade (%)" value={config.risk.riskPerTradePct} step={0.05} min={0.01} max={1} onChange={(n) => edit((c) => { c.risk.riskPerTradePct = n; })} />
                    <NumberField id="sleep-below" label="Sleep below capital (USDC)" value={config.compute.minimumCapitalUsd} step={10} min={1} max={1000} onChange={(n) => edit((c) => { c.compute.minimumCapitalUsd = n; })} />
                    <NumberField id="premium-from" label="Premium model from (USDC)" value={config.compute.premiumCapitalThresholdUsd} step={500} min={100} onChange={(n) => edit((c) => { c.compute.premiumCapitalThresholdUsd = n; })} />
                  </div>
                  <div className="space-y-2">
                    <Label>Strategy</Label>
                    <ToggleGroup
                      type="single"
                      spacing={2}
                      value={config.template}
                      onValueChange={(v) => { if (!v) return; const t = templateConfig(v as StrategyConfig["template"]); edit((c) => { c.template = t.template; c.market = t.market; c.direction = t.direction; }); }}
                      className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2"
                      aria-label="Strategy template"
                    >
                      {STRATEGY_TEMPLATES.filter((t) => t.market === "spot").map((t) => (
                        <ToggleGroupItem key={t.id} value={t.id} className="h-auto w-full flex-col items-start justify-start gap-0.5 rounded-2xl bg-muted p-3 text-left whitespace-normal text-foreground hover:bg-hover data-[state=on]:bg-card data-[state=on]:ring-2 data-[state=on]:ring-brand">
                          <span className="text-sm font-medium">{t.label}</span>
                          <span className="text-xs font-normal text-muted-foreground">{t.description}</span>
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  </div>
                  <Collapsible>
                    <CollapsibleTrigger className="group flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                      Advanced parameters (JSON) <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" />
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <Textarea value={JSON.stringify(config, null, 2)} onChange={(e) => { try { setConfig(JSON.parse(e.target.value)); } catch { setMessage("Invalid configuration JSON"); } }} rows={18} spellCheck={false} className="mt-2 font-mono text-xs" />
                    </CollapsibleContent>
                  </Collapsible>
                </CardContent>
              </CollapsibleContent>
            </Collapsible>
          </Card>
        </div>

        <Card className="lg:sticky lg:top-6 lg:self-start">
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle>Create agent</CardTitle>
              {configEdited ? <Badge variant="trade" size="micro">Customized</Badge> : <Badge variant="brand" size="micro">Tuned preset</Badge>}
            </div>
            <CardDescription>{config.symbols.join(", ")} · spot, long-only · closed 4h candles</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2.5">
            <div className="space-y-1.5 pb-1">
              <Label htmlFor="agent-name">Name</Label>
              <Input id="agent-name" value={name} onChange={(e) => setCustomName(e.target.value)} maxLength={60} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <ValueField label="Protected floor" value={`${preset.profile.piBps / 100}%`} />
              <ValueField label="Exposure cap" value={`${preset.profile.multiplier}× cushion`} />
              <ValueField label="Risk per trade" value={`${config.risk.riskPerTradePct}%`} />
              <ValueField label="Daily loss stop" value={`${config.risk.maxDailyLossPct}%`} />
            </div>
            <div className="rounded-2xl bg-muted p-3 text-sm text-muted-foreground">
              <ZeroGText text="0G Compute scores the news before each entry; if 0G is unreachable, Fireworks takes over. Every order passes RiskGate on-chain and is labelled 0G TEE-attested or rules-attested." />
            </div>
            {configEdited && <p className="text-xs text-muted-foreground">Backtest figures above describe the unmodified preset, not your customized rules.</p>}
            {config.market === "perpetual" && (
              <Alert className="rounded-2xl border-0 bg-trade-soft text-trade-deep">
                <TriangleAlert />
                <AlertDescription className="text-trade-deep">Futures strategies require a derivatives venue before deployment. Choose a spot strategy to continue.</AlertDescription>
              </Alert>
            )}
            <div className="pt-2">
              <Button size="xl" className="w-full" disabled={busy || !name.trim() || unresolved || config.market !== "spot"} onClick={create}>
                {busy ? <><Loader2 className="animate-spin" /> Working…</> : `Create ${preset.profile.label.toLowerCase()} agent`}
              </Button>
              <p className="mt-2 text-center text-xs text-muted-foreground">One signature. Add capital from your wallet afterwards.</p>
            </div>
            {message && <StatusNote key={message} className="pop-in">{message}</StatusNote>}
            <ActionSheet flow={flow} tag={`${name.trim() || "New agent"} · ${preset.profile.label}`} doneTitle="Agent created" errorTitle="Agent wasn't created" figure={name.trim() || undefined} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

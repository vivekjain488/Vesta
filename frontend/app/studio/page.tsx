"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, Loader2, Minus, Plus, Sparkles, TriangleAlert } from "lucide-react";
import { applyRiskProfile, configAuthMessage, RISK_PROFILES, STRATEGY_TEMPLATES, templateConfig, validateStrategyConfig, type RiskProfile, type StrategyConfig } from "@perpetua/core";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Micro, PageHeader, StatusNote } from "@/components/ui-perpetua";
import { apiFetch, API } from "@/lib/api";
import { useWallet } from "@/components/Wallet";
import { ActionSheet, useActionFlow, type FlowStep } from "@/components/ActionSheet";
import { cn } from "@/lib/utils";

const CREATE_STEPS: FlowStep[] = [
  { label: "Sign", match: /^Review and sign your strategy/, title: "Signing your strategy" },
  { label: "Deploy", match: /^Creating your agent contracts/, title: "Deploying agent contracts" },
  { label: "Open", match: /(?!)/, title: "Opening your agent" },
];

/** Assets with a public price feed (the same list the dashboard chart supports). */
const ASSET_OPTIONS = [
  { symbol: "BTC", name: "Bitcoin" },
  { symbol: "ETH", name: "Ethereum" },
  { symbol: "LINK", name: "Chainlink" },
  { symbol: "SOL", name: "Solana" },
] as const;
const MAX_ASSETS = 5;

/** Pick the assets an agent may trade. At least one is required; custom symbols from the advanced JSON stay selectable. */
function AssetPicker({ symbols, onChange }: { symbols: string[]; onChange: (next: string[]) => void }) {
  const known: string[] = ASSET_OPTIONS.map((a) => a.symbol);
  const options = [...ASSET_OPTIONS, ...symbols.filter((s) => !known.includes(s)).map((s) => ({ symbol: s, name: "Custom" }))];
  const toggle = (symbol: string, on: boolean) => {
    if (on && symbols.length >= MAX_ASSETS) return;
    if (!on && symbols.length <= 1) return;
    // Keep a stable order: the options order, not the order of clicking.
    const next = on ? [...symbols, symbol] : symbols.filter((s) => s !== symbol);
    onChange(options.map((o) => o.symbol).filter((s) => next.includes(s)));
  };
  return (
    <fieldset className="space-y-2 border-0 p-0">
      <legend className="mb-1.5 flex w-full items-center justify-between text-sm font-medium">
        Assets <span className="text-xs font-normal text-muted-foreground">{symbols.length} selected · choose 1–{MAX_ASSETS}</span>
      </legend>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {options.map((o) => {
          const on = symbols.includes(o.symbol);
          const locked = (on && symbols.length <= 1) || (!on && symbols.length >= MAX_ASSETS);
          return (
            <label key={o.symbol} htmlFor={`asset-${o.symbol}`} className={cn("flex cursor-pointer items-center gap-3 rounded-2xl p-3 transition-colors duration-150", on ? "bg-foreground text-background" : "bg-muted hover:bg-hover", locked && !on && "cursor-not-allowed opacity-50")}>
              <Checkbox id={`asset-${o.symbol}`} checked={on} disabled={locked && !on} onCheckedChange={(v) => toggle(o.symbol, v === true)} className={cn("size-5 rounded-md", on && "border-background bg-background text-foreground")} />
              <span className="min-w-0 leading-tight">
                <span className="block text-sm font-semibold">{o.symbol}</span>
                <span className={cn("block truncate text-xs", on ? "text-background/60" : "text-muted-foreground")}>{o.name}</span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

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

export default function Studio() {
  const router = useRouter(); const wallet = useWallet();
  const [name, setName] = useState(""); const [config, setConfig] = useState(templateConfig("spot-momentum"));
  const [profile, setProfile] = useState<RiskProfile>("balanced"); const [personality, setPersonality] = useState("");
  const [prompt, setPrompt] = useState(""); const [notes, setNotes] = useState<string[]>([]); const [unresolved, setUnresolved] = useState(false);
  const [compiledFor, setCompiledFor] = useState<{ prompt: string; profile: RiskProfile } | null>(null);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  const [step, setStep] = useState(0); const [savedId, setSavedId] = useState<string | null>(null);
  const body = async (r: Response) => { const b = await r.json(); if (!r.ok) throw new Error(b.error); return b; };
  function edit(change: (c: StrategyConfig) => void) { setConfig((previous) => { const next = structuredClone(previous); change(next); return next; }); }
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

  return (
    <div className="max-w-4xl space-y-6 pt-4 lg:pt-6">
      <PageHeader eyebrow="New agent" title="Create your agent" description="Choose a strategy, set your preferences, and review before signing with MetaMask." />
      <ol aria-label="Agent creation progress" className="grid grid-cols-3 gap-2">{["Strategy", "Preferences", "Review"].map((label, i) => <li key={label} aria-current={step === i ? "step" : undefined} className={cn("rounded-2xl px-4 py-3 text-sm", step === i ? "bg-trade text-foreground" : "bg-muted text-muted-foreground")}><span className="mr-2 font-semibold">0{i + 1}</span>{label}</li>)}</ol>
      <p className="text-sm text-muted-foreground">Agents currently use the local test network. Live deposits and autonomous trading are not enabled.</p>
      <div className="grid gap-3">
        <fieldset disabled={!!savedId} className={cn("flex min-w-0 flex-col gap-3 border-0 p-0", step === 2 && "hidden")}>
          <Card className={step !== 0 ? "hidden" : ""}>
            <CardHeader>
              <CardTitle>Strategy</CardTitle>
              <CardDescription>Start from a template. Templates have no established profitability.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-1.5">
                <Label htmlFor="agent-name">Agent name</Label>
                <Input id="agent-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. Long-term growth" />
              </div>
              <ToggleGroup
                type="single"
                spacing={2.5}
                value={config.template}
                onValueChange={(v) => { if (!v) return; setConfig(applyRiskProfile(templateConfig(v as StrategyConfig["template"]), profile)); setCompiledFor(null); setUnresolved(false); setNotes([]); }}
                className="grid w-full grid-cols-1 gap-2.5 sm:grid-cols-2"
                aria-label="Strategy template"
              >
                {STRATEGY_TEMPLATES.map((t) => {
                  const active = config.template === t.id;
                  return (
                    <ToggleGroupItem
                      key={t.id}
                      value={t.id}
                      className={cn("relative h-auto w-full flex-col items-start justify-start gap-1 rounded-[22px] bg-muted p-4 text-left whitespace-normal text-foreground hover:bg-hover data-[state=on]:bg-trade-soft data-[state=on]:shadow-none", active && "ring-2 ring-trade")}
                    >
                      <span className="flex w-full items-center justify-between gap-2">
                        <span className="font-medium">{t.label}</span>
                        {active ? <Badge variant="trade-solid" size="micro">Selected</Badge> : <Badge variant={t.market === "perpetual" ? "ink" : "white"} size="micro">{t.market === "perpetual" ? "Futures" : "Spot"}</Badge>}
                      </span>
                      <span className="text-sm font-normal text-muted-foreground">{t.description}</span>
                    </ToggleGroupItem>
                  );
                })}
              </ToggleGroup>
            </CardContent>
          </Card>

          <Card className={step !== 1 ? "hidden" : ""}>
            <CardHeader><CardTitle>Personality and risk</CardTitle><CardDescription>Choose starting limits and describe how your agent should weigh opportunities. You can review and edit the limits before signing.</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              <ToggleGroup type="single" value={profile} onValueChange={(v) => { if (!v) return; const next = v as RiskProfile; setProfile(next); setConfig((c) => applyRiskProfile(c, next)); }} className="grid grid-cols-1 gap-2 sm:grid-cols-3" aria-label="Risk personality">
                {(Object.keys(RISK_PROFILES) as RiskProfile[]).map((key) => <ToggleGroupItem key={key} value={key} className="h-auto flex-col items-start gap-1 rounded-2xl bg-muted p-3 text-left whitespace-normal data-[state=on]:bg-trade-soft data-[state=on]:ring-2 data-[state=on]:ring-trade"><span className="font-medium">{RISK_PROFILES[key].label}</span><span className="text-xs font-normal text-muted-foreground">{RISK_PROFILES[key].description}</span></ToggleGroupItem>)}
              </ToggleGroup>
              <div className="space-y-1.5"><Label htmlFor="personality">Additional personality instructions</Label><Textarea id="personality" value={personality} onChange={(e) => setPersonality(e.target.value)} maxLength={2500} placeholder="For example: favor trend breakouts, take profits gradually, and avoid trading on weak evidence." /><p className="text-xs text-muted-foreground">Personality guides analysis and sizing; it cannot override the signed limits or guarantee results.</p></div>
            </CardContent>
          </Card>

          <Card className={step !== 1 ? "hidden" : ""}>
            <CardHeader>
              <CardTitle>Or describe your strategy</CardTitle>
              <CardDescription>Qwen3.7 Flash on OpenRouter drafts a configuration from your strategy and selected risk personality. Review the settings before creating the agent.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-[22px] bg-muted p-2">
                <Label htmlFor="strategy-prompt" className="sr-only">Describe your strategy</Label>
                <Textarea id="strategy-prompt" value={prompt} onChange={(e) => { setPrompt(e.target.value); setNotes([]); setUnresolved(false); }} maxLength={4000} rows={4} className="min-h-28 resize-none bg-transparent hover:bg-transparent focus-visible:bg-card" placeholder="Describe your goals, preferred assets, and risk limits." />
                <div className="flex items-center justify-between gap-2 px-2 pt-2 pb-1">
                  <Micro>{prompt.trim().length < 10 ? "At least 10 characters" : `${prompt.length} / 4000`}</Micro>
                  <Button variant="chip" disabled={busy || prompt.trim().length < 10} onClick={() => run(async () => { setCompiledFor(null); const result = await signed("compile", { prompt, profile }, "/v1/strategy/compile"); setConfig(result.config); setNotes([...result.assumptions, ...result.unsupportedRequirements]); setUnresolved(result.requiresClarification); setCompiledFor({ prompt, profile }); })}>
                    {busy ? <Loader2 className="animate-spin" /> : <Sparkles />} Generate strategy
                  </Button>
                </div>
              </div>
              {prompt.trim() && (!compiledFor || compiledFor.prompt !== prompt || compiledFor.profile !== profile) && <p className="text-sm text-muted-foreground">Generate the configuration for the current description and risk personality before creating the agent.</p>}
              {notes.length > 0 && (
                <ul className="space-y-1.5">
                  {notes.map((n, i) => <li key={i} className="rounded-2xl bg-brand-soft px-4 py-2.5 text-sm">{n}</li>)}
                </ul>
              )}
            </CardContent>
          </Card>
        </fieldset>

        <Card className={step !== 2 ? "hidden" : ""}>
          <CardHeader>
            <CardTitle>Review your agent</CardTitle>
            <CardDescription>{name.trim() || "Unnamed agent"} · {STRATEGY_TEMPLATES.find((t) => t.id === config.template)?.label} · {RISK_PROFILES[profile].label} risk</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2.5">
            <fieldset disabled={!!savedId} className="space-y-2.5 border-0 p-0">
            <div className="pb-2">
              <AssetPicker symbols={config.symbols} onChange={(next) => edit((c) => { c.symbols = next; })} />
            </div>
            <NumberField id="max-exposure" label="Maximum proposal (USDC)" value={config.risk.maxNotionalUsd} step={50} min={1} onChange={(n) => edit((c) => { c.risk.maxNotionalUsd = n; })} />
            <NumberField id="risk-per-trade" label="Risk per trade (%)" value={config.risk.riskPerTradePct} step={0.05} min={0.01} max={1} onChange={(n) => edit((c) => { c.risk.riskPerTradePct = n; })} />
            <NumberField id="sleep-below" label="Sleep below remaining capital (USDC)" value={config.compute.minimumCapitalUsd} step={10} min={1} max={1000} onChange={(n) => edit((c) => { c.compute.minimumCapitalUsd = n; })} />
            <NumberField id="premium-from" label="Premium model from allocated capital (USDC)" value={config.compute.premiumCapitalThresholdUsd} step={500} min={100} onChange={(n) => edit((c) => { c.compute.premiumCapitalThresholdUsd = n; })} />
            <p className="pt-1 text-sm text-muted-foreground">Smaller allocations use a cheaper model. Compute balance and spending limits also affect model choice.</p>
            <Collapsible>
              <CollapsibleTrigger className="group flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                Advanced parameters <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <Textarea value={JSON.stringify(config, null, 2)} onChange={(e) => { try { setConfig(JSON.parse(e.target.value)); } catch { setMessage("Invalid configuration JSON"); } }} rows={18} spellCheck={false} className="mt-2 font-mono text-xs" />
              </CollapsibleContent>
            </Collapsible>
            </fieldset>
            {config.market === "perpetual" && (
              <Alert className="rounded-2xl border-0 bg-trade-soft text-trade-deep">
                <TriangleAlert />
                <AlertDescription className="text-trade-deep">Futures strategies require a derivatives venue before deployment. Choose a spot strategy to continue.</AlertDescription>
              </Alert>
            )}
            <div className="pt-3">
              <Button variant="trade" size="xl" className="w-full" disabled={busy || !name.trim() || unresolved || config.market !== "spot" || (!!prompt.trim() && (!compiledFor || compiledFor.prompt !== prompt || compiledFor.profile !== profile))} onClick={() => run(async () => {
                const validated = validateStrategyConfig(config);
                const instructions = [prompt.trim() && `Owner strategy: ${prompt.trim()}`, personality.trim() && `Additional owner preferences: ${personality.trim()}`, `Risk personality (secondary to explicit owner strategy): ${RISK_PROFILES[profile].instructions}`].filter(Boolean).join("\n\n");
                if (instructions.length > 4000) throw new Error("Strategy description and personality together must be at most 4000 characters");
                let id = savedId;
                if (!id) { setMessage("Review and sign your strategy in MetaMask…"); const definition = await signed("create", { name, instructions, config: validated, status: "draft" }, "/v1/agent-definitions"); id = definition.id; setSavedId(id); }
                setMessage("Creating your agent contracts…"); await body(await apiFetch(`/v1/agent-definitions/${id}/deploy`, { method: "POST" })); router.push(`/agent/${id}`);
              })}>{busy ? <><Loader2 className="animate-spin" /> Working…</> : savedId ? "Retry setup" : "Create test agent"}</Button>
              {savedId && <p className="mt-2 text-sm text-muted-foreground">Your strategy is saved. Retry setup to deploy this same agent without creating another draft.</p>}
            </div>
            {message && <StatusNote key={message} className="pop-in">{message}</StatusNote>}
            <ActionSheet flow={flow} tag={`${name.trim() || "New agent"} · ${config.symbols.join(", ")}`} doneTitle="Agent created" errorTitle="Agent wasn't created" figure={name.trim() || undefined} />
          </CardContent>
        </Card>
      </div>
      <div className="flex justify-between gap-3"><Button variant="outline" disabled={busy || step === 0 || !!savedId} onClick={() => setStep((s) => s - 1)}>Back</Button>{step < 2 && <Button variant="trade" disabled={busy || (step === 0 && !name.trim())} onClick={() => setStep((s) => s + 1)}>Continue</Button>}</div>
    </div>
  );
}

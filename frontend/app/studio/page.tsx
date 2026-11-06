"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, Loader2, Minus, Plus, Sparkles, TriangleAlert } from "lucide-react";
import { configAuthMessage, STRATEGY_TEMPLATES, templateConfig, validateStrategyConfig, type StrategyConfig } from "@perpetua/core";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
  const [prompt, setPrompt] = useState(""); const [notes, setNotes] = useState<string[]>([]); const [unresolved, setUnresolved] = useState(false);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
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
    <div className="space-y-6 pt-4 lg:pt-6">
      <PageHeader eyebrow="New agent" title="Choose how your agent invests" description="Set a strategy and operating limits. After creating your agent, add capital from your wallet." />
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <Card>
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
                onValueChange={(v) => { if (!v) return; setConfig(templateConfig(v as StrategyConfig["template"])); setUnresolved(false); setNotes([]); }}
                className="grid w-full grid-cols-1 gap-2.5 sm:grid-cols-2"
                aria-label="Strategy template"
              >
                {STRATEGY_TEMPLATES.map((t) => {
                  const active = config.template === t.id;
                  return (
                    <ToggleGroupItem
                      key={t.id}
                      value={t.id}
                      className={cn("relative h-auto w-full flex-col items-start justify-start gap-1 rounded-[22px] bg-muted p-4 text-left whitespace-normal text-foreground hover:bg-hover data-[state=on]:bg-card data-[state=on]:shadow-none", active && "ring-2 ring-brand")}
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

          <Card>
            <CardHeader>
              <CardTitle>Or describe your strategy</CardTitle>
              <CardDescription>0G drafts a configuration from your description. Review every parameter before creating the agent.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-[22px] bg-muted p-2">
                <Label htmlFor="strategy-prompt" className="sr-only">Describe your strategy</Label>
                <Textarea id="strategy-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={4000} rows={4} className="min-h-28 resize-none bg-transparent hover:bg-transparent focus-visible:bg-card" placeholder="Describe your goals, preferred assets, and risk limits." />
                <div className="flex items-center justify-between gap-2 px-2 pt-2 pb-1">
                  <Micro>{prompt.trim().length < 10 ? "At least 10 characters" : `${prompt.length} / 4000`}</Micro>
                  <Button variant="chip" disabled={busy || prompt.trim().length < 10} onClick={() => run(async () => { const result = await signed("compile", { prompt }, "/v1/strategy/compile"); setConfig(result.config); setNotes([...result.assumptions, ...result.unsupportedRequirements]); setUnresolved(result.requiresClarification); })}>
                    {busy ? <Loader2 className="animate-spin" /> : <Sparkles />} Generate strategy
                  </Button>
                </div>
              </div>
              {notes.length > 0 && (
                <ul className="space-y-1.5">
                  {notes.map((n, i) => <li key={i} className="rounded-2xl bg-brand-soft px-4 py-2.5 text-sm">{n}</li>)}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="lg:sticky lg:top-6 lg:self-start">
          <CardHeader>
            <CardTitle>Your limits</CardTitle>
            <CardDescription>{config.symbols.join(", ") || "No assets"} · {config.market === "spot" ? "Spot" : "Futures research"}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2.5">
            <div className="space-y-1.5 pb-1">
              <Label htmlFor="assets">Assets</Label>
              <Input id="assets" value={config.symbols.join(", ")} onChange={(e) => edit((c) => { c.symbols = e.target.value.toUpperCase().split(",").map((s) => s.trim()); })} />
            </div>
            <NumberField id="max-exposure" label="Maximum trading exposure (USDC)" value={config.risk.maxNotionalUsd} step={50} min={1} onChange={(n) => edit((c) => { c.risk.maxNotionalUsd = n; })} />
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
            {config.market === "perpetual" && (
              <Alert className="rounded-2xl border-0 bg-trade-soft text-trade-deep">
                <TriangleAlert />
                <AlertDescription className="text-trade-deep">Futures strategies require a derivatives venue before deployment. Choose a spot strategy to continue.</AlertDescription>
              </Alert>
            )}
            <div className="pt-3">
              <Button size="xl" className="w-full" disabled={busy || !name.trim() || unresolved || config.market !== "spot"} onClick={() => run(async () => {
                const validated = validateStrategyConfig(config); setMessage("Review and sign your strategy in MetaMask…");
                const definition = await signed("create", { name, config: validated, status: "draft" }, "/v1/agent-definitions");
                setMessage("Creating your agent contracts…"); await body(await apiFetch(`/v1/agent-definitions/${definition.id}/deploy`, { method: "POST" })); router.push(`/agent/${definition.id}`);
              })}>{busy ? <><Loader2 className="animate-spin" /> Working…</> : "Create agent"}</Button>
            </div>
            {message && <StatusNote key={message} className="pop-in">{message}</StatusNote>}
            <ActionSheet flow={flow} tag={`${name.trim() || "New agent"} · ${config.symbols.join(", ")}`} doneTitle="Agent created" errorTitle="Agent wasn't created" figure={name.trim() || undefined} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

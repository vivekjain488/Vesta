"use client";
import Link from "next/link";
import { ArrowDown, ArrowRight, Brain, Coins, Loader2, Lock, Moon, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BorderBeam } from "@/components/ui/border-beam";
import { SplitHeading, scrollToId } from "@/components/motion";
import { ErrorNote, Micro } from "@/components/ui-perpetua";
import { cn } from "@/lib/utils";
import { AgentGraph } from "./AgentGraph";
import { AgentMonitor } from "./AgentMonitor";
import { GlowGrid } from "./GlowGrid";
import { ZeroGIcon, ZeroGText } from "../ZeroG";
import { BrainIllustration, MetabolismIllustration, RiskGateIllustration, VaultIllustration } from "./illustrations";

const STEPS = [
  { n: "01", title: "Your capital, split on-chain", body: "Deposits go into an ERC-4626 vault. A floor F = π·P + R is locked in the safe leg; only the cushion above it can ever be traded.", art: VaultIllustration, wide: true },
  { n: "02", title: "The agent thinks on 0G", body: "Signals come from closed candles and five independent factors. The agent asks 0G Compute for TEE-signed reasoning when the decision is worth paying for.", art: BrainIllustration, wide: false },
  { n: "03", title: "RiskGate approves every order", body: "A deterministic contract recomputes floor, cushion and exposure from live vault state and a fresh price. Orders over the limit are rejected on-chain.", art: RiskGateIllustration, wide: false },
  { n: "04", title: "Income pays for its next thought", body: "Fees and yield are harvested, swapped to 0G, bridged with Chainlink CCIP and deposited into the agent's own compute ledger. No human top-ups.", art: MetabolismIllustration, wide: true },
] as const;

const TIERS = [
  { name: "Thrive", body: "Largest 0G model", icon: Sparkles, cls: "bg-brand text-white" },
  { name: "Frugal", body: "Smaller 0G model", icon: ZeroGIcon, cls: "bg-brand-soft text-brand-hover" },
  { name: "Starving", body: "Rules only, no LLM", icon: Zap, cls: "bg-trade text-foreground" },
  { name: "Hibernate", body: "Asleep; stops stay live on-chain", icon: Moon, cls: "bg-primary text-primary-foreground" },
];
const ENGINES = ["Paid signals over x402", "Risk checks over x402", "Flash copy-trade fees", "Management & performance fees", "Keeper bounties", "Stable-pool LP", "Safe-leg yield"];
const STACK = ["Definitive Flash", "0G Compute", "Arkiv", "Chainlink CCIP", "x402", "ERC-4626"];

export function Landing({ signedIn, busy, error, onSignIn }: { signedIn: boolean; busy: boolean; error: string; onSignIn: () => void }) {
  const Primary = ({ className }: { className?: string }) =>
    signedIn ? (
      <Button asChild size="xl" className={className}>
        <Link href="/">Open dashboard <ArrowRight /></Link>
      </Button>
    ) : (
      <Button size="xl" disabled={busy} onClick={onSignIn} className={className}>
        {busy ? <><Loader2 className="animate-spin" /> Waiting for MetaMask…</> : <>Sign in with MetaMask <ArrowRight /></>}
      </Button>
    );

  return (
    <div className="bg-background">
      {/* ───────────── Hero ───────────── */}
      <section className="relative isolate min-h-[100svh] overflow-hidden text-foreground">
        <GlowGrid />
        <header className="relative z-10 mx-auto flex max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
          <span className="font-display text-3xl leading-none">Perpetua</span>
          <nav className="hidden items-center gap-7 text-sm text-muted-foreground md:flex" aria-label="Sections">
            {[["how", "How it works"], ["decision", "One decision"], ["graph", "Under the hood"], ["metabolism", "Metabolism"]].map(([id, label]) => (
              <a key={id} href={`#${id}`} onClick={(e) => { if (scrollToId(id, 16)) e.preventDefault(); }} className="transition-colors duration-150 hover:text-foreground">{label}</a>
            ))}
          </nav>
          {signedIn ? (
            <Button asChild size="sm"><Link href="/">Dashboard</Link></Button>
          ) : (
            <Button size="sm" disabled={busy} onClick={onSignIn}>Sign in</Button>
          )}
        </header>

        <div className="relative z-10 mx-auto flex max-w-4xl flex-col items-center px-5 pt-[9vh] text-center sm:px-8">
          <span data-reveal="fade" className="relative inline-flex items-center gap-2 overflow-hidden rounded-full bg-card px-3.5 py-1.5 text-xs text-muted-foreground shadow-[0_0_0_1px_rgba(17,17,17,0.06)]">
            <span className="size-1.5 rounded-full bg-trade" /> ETHGlobal Mumbai 2026 · principal-protected AI agents
            <BorderBeam size={60} duration={7} colorFrom="#FF4D00" colorTo="#5B7CFA" />
          </span>
          <SplitHeading className="mt-7 font-display text-[3.4rem] leading-[0.95] tracking-tight sm:text-7xl md:text-[5.6rem]">
            Agents that pay for their own brains.
          </SplitHeading>
          <p data-reveal className="mt-6 max-w-2xl text-base text-muted-foreground sm:text-lg">
            <ZeroGText text="Perpetua runs AI trading agents inside principal-protected vaults. An agent can only ever risk the cushion above your floor, every order is approved on-chain by RiskGate, and the income it earns buys its own 0G compute." />
          </p>
          <div data-reveal className="mt-9 flex flex-col items-center gap-3 sm:flex-row">
            <Primary />
            <Button variant="outline" size="xl" onClick={() => scrollToId("how", 16)}>
              How it works <ArrowDown />
            </Button>
          </div>
          {error && <ErrorNote className="mt-5 max-w-md">{error}</ErrorNote>}
          <ul data-reveal className="mt-10 flex flex-wrap justify-center gap-2 text-xs text-foreground">
            {[[Lock, "Floor locked on-chain"], [ShieldCheck, "RiskGate approves every order"], [ZeroGIcon, "Self-funded 0G compute"]].map(([Icon, label]) => {
              const I = Icon as typeof Lock;
              return (
                <li key={label as string} className="flex items-center gap-1.5 rounded-full bg-card/85 px-3 py-1.5 shadow-[0_0_0_1px_rgba(17,17,17,0.06)] backdrop-blur">
                  <I className="size-3.5 text-trade-deep" /> <ZeroGText text={label as string} />
                </li>
              );
            })}
          </ul>
        </div>
        <p className="absolute inset-x-0 bottom-5 z-10 flex justify-center"><span className="rounded-full bg-card/85 px-3 py-1 text-[11px] text-muted-foreground shadow-[0_0_0_1px_rgba(17,17,17,0.06)] backdrop-blur">Hackathon prototype · not financial advice</span></p>
      </section>

      {/* ───────────── How it works ───────────── */}
      <section id="how" className="mx-auto max-w-6xl scroll-mt-4 px-5 py-24 sm:px-8">
        <div className="max-w-2xl">
          <Micro>How it works</Micro>
          <h2 data-reveal className="mt-3 font-display text-5xl leading-[1] tracking-tight sm:text-6xl">The AI proposes. RiskGate disposes.</h2>
          <p data-reveal className="mt-4 text-muted-foreground">Four moving parts keep an autonomous agent useful, bounded and alive, without trusting the AI with your principal.</p>
        </div>
        <div className="mt-12 grid gap-3 md:grid-cols-5">
          {STEPS.map((s) => {
            const Art = s.art;
            return (
              <article key={s.n} data-slot="card" className={cn("group flex flex-col overflow-hidden rounded-[28px] bg-card shadow-[0_1px_2px_rgba(17,17,17,0.03),0_0_0_1px_rgba(17,17,17,0.04)] transition-shadow duration-200 hover:shadow-[0_18px_40px_-24px_rgba(17,17,17,0.35),0_0_0_1px_rgba(17,17,17,0.05)]", s.wide ? "md:col-span-3" : "md:col-span-2")}>
                <div className="relative h-64 bg-gradient-to-b from-muted/70 to-card px-5 pt-5">
                  <Art />
                </div>
                <div className="p-6 pt-4">
                  <span className="micro text-trade-deep">{s.n}</span>
                  <h3 className="mt-1.5 font-display text-3xl leading-tight"><ZeroGText text={s.title} markClassName="h-[0.62em]" /></h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground"><ZeroGText text={s.body} /></p>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {/* ───────────── One decision ───────────── */}
      <section id="decision" className="scroll-mt-4 px-4 sm:px-6 lg:px-8">
        <div data-reveal className="relative isolate mx-auto max-w-[1360px] overflow-hidden rounded-[32px] bg-trade text-foreground sm:rounded-[40px]">
        <GlowGrid tone="orange" intensity={0.8} origin="78% 105%" />
        <div className="relative z-10 mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 px-6 py-16 sm:px-10 sm:py-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:py-24">
          <div>
            <Micro className="text-foreground/70">One decision, end to end</Micro>
            <h2 data-reveal className="mt-3 font-display text-5xl leading-[1] tracking-tight sm:text-6xl">Every move leaves a receipt.</h2>
            <p data-reveal className="mt-4 text-foreground/75"><ZeroGText text="An agent reads closed candles, scores the setup, and only pays for 0G reasoning when the trade is worth it. RiskGate signs off on-chain before the Flash order exists, and the signal is committed to Arkiv before anyone sees it." />
          </p>
            <dl data-reveal className="mt-8 grid grid-cols-3 gap-2 sm:gap-3">
              {[["F", "$960", "floor"], ["C", "$40", "cushion"], ["E", "$120", "exposure"]].map(([k, v, l]) => (
                <div key={k} className="min-w-0 rounded-2xl bg-white/35 p-3 ring-1 ring-black/5 backdrop-blur sm:p-4">
                  <dt className="micro truncate text-foreground/65"><span className="hidden sm:inline">{k} · </span>{l}</dt>
                  <dd className="num mt-1 text-2xl font-semibold tracking-tight">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-xs text-foreground/60">Worked example from the spec: P = 1,000, π = 95%, R = 10.</p>
          </div>
          <AgentMonitor className="w-full max-w-md justify-self-center lg:justify-self-end" />
        </div>
        </div>
      </section>

      {/* ───────────── Graph ───────────── */}
      <section id="graph" className="mx-auto max-w-6xl scroll-mt-4 px-5 py-24 sm:px-8">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-2xl">
            <Micro>Under the hood</Micro>
            <h2 data-reveal className="mt-3 font-display text-5xl leading-[1] tracking-tight sm:text-6xl">Who talks to whom.</h2>
            <p data-reveal className="mt-4 text-muted-foreground">Light travels along every link: blue is a call, green is the answer coming back, orange is money moving between contracts.</p>
          </div>
          <ul data-reveal className="flex flex-wrap gap-1.5">
            {STACK.map((s) => <li key={s} className="rounded-full bg-card px-3 py-1.5 text-xs shadow-[0_0_0_1px_rgba(17,17,17,0.06)]"><ZeroGText text={s} /></li>)}
          </ul>
        </div>
        <AgentGraph className="mt-10" />
      </section>

      {/* ───────────── Metabolism ───────────── */}
      <section id="metabolism" className="mx-auto max-w-6xl scroll-mt-4 px-5 pb-24 sm:px-8">
        <div className="grid gap-3 lg:grid-cols-[1.1fr_1fr]">
          <article data-slot="card" className="rounded-[28px] bg-card p-7 shadow-[0_1px_2px_rgba(17,17,17,0.03),0_0_0_1px_rgba(17,17,17,0.04)]">
            <Micro>Metabolism</Micro>
            <h2 className="mt-3 font-display text-5xl leading-[1] tracking-tight">Runway decides the brain.</h2>
            <p className="mt-4 text-muted-foreground">As compute runway shrinks, the agent steps down to cheaper thinking, and climbs back up when income lands. Nothing crashes; stops stay live on-chain.</p>
            <ol className="mt-7 grid gap-2 sm:grid-cols-4">
              {TIERS.map((t, i) => {
                const Icon = t.icon;
                return (
                  <li key={t.name} data-reveal="pop" className="rounded-2xl bg-muted p-3.5">
                    <span className={cn("flex size-8 items-center justify-center rounded-xl", t.cls)}><Icon className="size-4" /></span>
                    <p className="mt-3 text-sm font-medium">{t.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground"><ZeroGText text={t.body} /></p>
                    <span className="micro mt-3 block text-faint">{["MOST RUNWAY", "", "", "LEAST RUNWAY"][i] || " "}</span>
                  </li>
                );
              })}
            </ol>
          </article>
          <article data-slot="card" className="relative overflow-hidden rounded-[28px] bg-trade p-7 text-foreground">
            <GlowGrid tone="orange" intensity={0.85} origin="85% 115%" follow />
            <div className="relative">
              <Micro className="text-foreground/70">Income engines</Micro>
              <h3 className="mt-3 font-display text-4xl leading-[1.05]">Seven ways to earn its keep.</h3>
              <ul className="mt-6 flex flex-wrap gap-2">
                {ENGINES.map((e) => <li key={e} data-reveal="pop" className="rounded-full bg-white/40 px-3 py-1.5 text-xs font-medium text-foreground ring-1 ring-black/5 backdrop-blur">{e}</li>)}
              </ul>
              <p className="mt-6 text-sm text-foreground/70"><ZeroGText text="Harvested income is swapped into native 0G and bridged with Chainlink CCIP into a ComputeTreasury on 0G Chain." /></p>
            </div>
          </article>
        </div>
      </section>

      {/* ───────────── CTA ───────────── */}
      <section className="relative isolate overflow-hidden bg-background text-foreground">
        <GlowGrid />
        {/* Sun-dome glow rising behind the footer; screen-blended so it brightens the orange and the squares beneath. */}
        <div
          aria-hidden
          className="glow-dome pointer-events-none absolute inset-x-0 bottom-0 h-[90%] mix-blend-multiply"
          style={{ background: "radial-gradient(ellipse 62% 92% at 50% 100%, rgba(255,77,0,1) 0%, rgba(255,96,24,0.88) 16%, rgba(255,138,87,0.62) 34%, rgba(255,184,150,0.36) 52%, rgba(255,222,205,0.15) 68%, rgba(255,255,255,0) 84%)" }}
        />
        <div className="relative z-10 mx-auto flex max-w-3xl flex-col items-center px-5 py-32 text-center sm:px-8">
          <h2 data-reveal className="font-display text-5xl leading-[1] tracking-tight sm:text-7xl">Give your capital an agent that can&apos;t lose the floor.</h2>
          <p data-reveal className="mt-5 max-w-xl text-foreground/75">Sign in with MetaMask, pick a strategy, set your limits and fund it. The agent runs without keeping this page open.</p>
          <div data-reveal className="mt-9"><Primary /></div>
        </div>
        <footer className="relative z-10 border-t border-black/10">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-6 text-xs text-foreground/80 sm:px-8">
            <span className="font-display text-xl text-foreground">Perpetua</span>
            <span>Hackathon prototype. Not financial advice. Signing in does not transfer funds or authorize trades.</span>
          </div>
        </footer>
      </section>
    </div>
  );
}

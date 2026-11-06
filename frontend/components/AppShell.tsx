"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Bot, LayoutGrid, Loader2, LogOut, Plus, Trophy, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ErrorNote, Micro } from "@/components/ui-perpetua";
import { SplitHeading } from "@/components/motion";
import { cn } from "@/lib/utils";
import { useWallet } from "./Wallet";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutGrid },
  { href: "/leaderboard", label: "Leaderboard", icon: Trophy },
  { href: "/studio", label: "Create agent", icon: Bot },
] as const;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!wallet.ready)
    return (
      <main className="flex min-h-screen items-center justify-center text-muted-foreground" aria-busy="true">
        <Loader2 className="mr-2 size-4 animate-spin" /> Loading…
      </main>
    );

  if (!wallet.address)
    return (
      <main className="flex min-h-screen items-center justify-center px-5 py-10">
        <section data-reveal className="relative w-full max-w-md overflow-hidden rounded-[32px] bg-gradient-to-b from-[#6a88fb] to-brand p-8 text-white shadow-[0_24px_60px_-28px_rgba(91,124,250,0.6)] sm:p-10">
          <div className="flex items-center justify-between">
            <p className="font-display text-3xl leading-none">Perpetua</p>
            <span className="micro rounded-full bg-white/15 px-2.5 py-1 text-white/90">Sign in</span>
          </div>
          <SplitHeading className="mt-14 font-display text-[3.4rem] leading-[0.95] tracking-tight">
            Your agents.
            <br />
            Your capital.
          </SplitHeading>
          <p className="mt-5 text-white/80">Sign in with MetaMask to manage your agents and investments.</p>
          <Button
            size="xl"
            disabled={busy}
            className="mt-10 w-full"
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await wallet.connect();
                router.replace("/");
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <><Loader2 className="animate-spin" /> Waiting for MetaMask…</> : "Sign in with MetaMask"}
          </Button>
          <p className="mt-3 text-center text-xs text-white/70">Signing in does not transfer funds or authorize trades.</p>
          {error && <ErrorNote className="mt-5 bg-white text-loss">{error}</ErrorNote>}
        </section>
      </main>
    );

  return (
    <>
      <MobileTopBar address={wallet.address} />
      <main className="mx-auto w-full max-w-[1440px] px-4 pt-4 pb-28 sm:px-6 lg:pt-6 lg:pr-[112px] lg:pb-12">{children}</main>
      <Rail address={wallet.address} onSignOut={() => void wallet.logout()} />
      <MobileNav onSignOut={() => void wallet.logout()} />
    </>
  );
}

function useActive() {
  const path = usePathname();
  return (href: string) => (href === "/" ? path === "/" || path.startsWith("/agent/") : path.startsWith(href));
}

function RailButton({ href, label, icon: Icon, active }: { href: string; label: string; icon: typeof LayoutGrid; active: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={href}
          aria-label={label}
          aria-current={active ? "page" : undefined}
          className={cn(
            "flex size-12 items-center justify-center rounded-full transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none",
            active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
          )}
        >
          <Icon className="size-5" strokeWidth={1.75} />
        </Link>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}

/** Desktop: slim right-edge rail, as in the reference (status + create on top, navigation pill at the bottom). */
function Rail({ address, onSignOut }: { address: string; onSignOut: () => void }) {
  const isActive = useActive();
  return (
    <aside className="fixed inset-y-6 right-6 z-40 hidden w-16 flex-col items-center justify-between lg:flex" aria-label="Main navigation">
      <div data-reveal="right" className="flex flex-col items-center gap-3">
        <Link href="/" className="font-display text-2xl leading-none" aria-label="Perpetua dashboard">
          P<span className="text-brand">.</span>
        </Link>
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="relative mt-2 flex size-14 items-center justify-center rounded-full bg-card text-foreground shadow-[0_1px_2px_rgba(17,17,17,0.05),0_0_0_1px_rgba(17,17,17,0.03)] outline-none focus-visible:ring-3 focus-visible:ring-ring/40">
              <Wallet className="size-5" strokeWidth={1.75} />
              <span className="absolute top-3 right-3 size-2 rounded-full bg-profit ring-2 ring-card" aria-hidden />
              <span className="sr-only">Signed in as {address}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="left" className="font-mono text-[11px]">Signed in · {short(address)}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button asChild size="icon-xl" aria-label="Create agent">
              <Link href="/studio"><Plus /></Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">Create agent</TooltipContent>
        </Tooltip>
      </div>
      <nav data-reveal="right" className="flex flex-col items-center gap-1 rounded-full bg-card p-2 shadow-[0_1px_2px_rgba(17,17,17,0.05),0_0_0_1px_rgba(17,17,17,0.03)]">
        {NAV.map((n) => <RailButton key={n.href} {...n} active={isActive(n.href)} />)}
        <Tooltip>
          <TooltipTrigger asChild>
            <button onClick={onSignOut} aria-label="Sign out" className="flex size-12 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-muted/70 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none">
              <LogOut className="size-5" strokeWidth={1.75} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left">Sign out</TooltipContent>
        </Tooltip>
      </nav>
    </aside>
  );
}

function MobileTopBar({ address }: { address: string }) {
  return (
    <header data-reveal="down" className="flex items-center justify-between px-4 pt-4 sm:px-6 lg:hidden">
      <Link href="/" className="font-display text-3xl leading-none">Perpetua</Link>
      <span className="flex items-center gap-2 rounded-full bg-card px-3 py-1.5 shadow-[0_0_0_1px_rgba(17,17,17,0.04)]">
        <span className="size-1.5 rounded-full bg-profit" aria-hidden />
        <Micro className="text-foreground">{short(address)}</Micro>
      </span>
    </header>
  );
}

/** Mobile: fixed bottom pill with the same destinations. */
function MobileNav({ onSignOut }: { onSignOut: () => void }) {
  const isActive = useActive();
  return (
    <nav data-reveal className="fixed inset-x-4 bottom-4 z-40 flex items-center justify-between rounded-full bg-card p-1.5 shadow-[0_8px_30px_-12px_rgba(17,17,17,0.25),0_0_0_1px_rgba(17,17,17,0.04)] lg:hidden" aria-label="Main navigation">
      {NAV.map(({ href, label, icon: Icon }) => (
        <Link key={href} href={href} aria-label={label} aria-current={isActive(href) ? "page" : undefined} className={cn("flex h-11 flex-1 items-center justify-center rounded-full transition-colors duration-150", isActive(href) ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>
          <Icon className="size-5" strokeWidth={1.75} />
        </Link>
      ))}
      <button onClick={onSignOut} aria-label="Sign out" className="flex h-11 flex-1 items-center justify-center rounded-full text-muted-foreground">
        <LogOut className="size-5" strokeWidth={1.75} />
      </button>
    </nav>
  );
}

"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { ArrowLeftRight, Bot, Cpu, LayoutGrid, Loader2, LogOut, Network, Plus, Trophy, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Micro } from "@/components/ui-perpetua";
import { Landing } from "@/components/landing/Landing";
import { VestaMark } from "@/components/VestaMark";
import { cn } from "@/lib/utils";
import { useWallet } from "./Wallet";
import { usePrivyGate } from "./PrivyBridge";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutGrid },
  { href: "/leaderboard", label: "Leaderboard", icon: Trophy },
  { href: "/trade", label: "Trading", icon: ArrowLeftRight },
  { href: "/studio", label: "Create agent", icon: Bot },
  { href: "/runtime", label: "Hosted agents", icon: Cpu },
  { href: "/registry", label: "Chain registry", icon: Network },
] as const;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const wallet = useWallet();
  const privy = usePrivyGate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pathname = usePathname();

  if (!wallet.ready || !privy.ready)
    return (
      <main className="flex min-h-screen items-center justify-center text-muted-foreground" aria-busy="true">
        <Loader2 className="mr-2 size-4 animate-spin" /> Loading…
      </main>
    );

  // The chain registry is public infrastructure. Signed-out visitors can read it; every other route, and /welcome, stays on the landing page.
  const signedIn = !!wallet.address && privy.authenticated && privy.addresses.includes(wallet.address.toLowerCase());
  if (!signedIn && pathname.startsWith("/registry"))
    return <main className="mx-auto w-full max-w-[1440px] px-4 pt-4 pb-12 sm:px-6 lg:px-8">{children}</main>;

  // Signed-out visitors (any route) and /welcome (anyone) see the full-bleed landing page.
  if (!signedIn || pathname === "/welcome")
    return (
      <Landing
        signedIn={signedIn}
        busy={busy}
        error={error}
        onSignIn={async () => {
          setBusy(true);
          setError("");
          try {
            const addresses = await privy.connect();
            if (!addresses.length) throw new Error("Sign in to Privy with your MetaMask account.");
            await wallet.connect(addresses);
            router.replace("/");
          } catch (e) {
            if ((e as Error).message.includes("same MetaMask") || (e as Error).message.includes("with your MetaMask account")) await privy.logout().catch(() => {});
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      />
    );

  return (
    <>
      <MobileTopBar address={wallet.address!} />
      <main className="mx-auto w-full max-w-[1440px] px-4 pt-4 pb-28 sm:px-6 lg:pt-6 lg:pr-[112px] lg:pb-12">{children}</main>
      <Rail address={wallet.address!} onSignOut={() => void Promise.allSettled([wallet.logout(), privy.logout()])} />
      <MobileNav onSignOut={() => void Promise.allSettled([wallet.logout(), privy.logout()])} />
    </>
  );
}

function useActive() {
  const path = usePathname();
  return (href: string) => (href === "/" ? path === "/" || path.startsWith("/agent/") : path.startsWith(href));
}

function RailButton({ href, label, icon: Icon, active }: { href: string; label: string; icon: typeof LayoutGrid; active: boolean }) {
  return (
    <Link
      href={href}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-12 items-center gap-3.5 rounded-full px-[14px] transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none",
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
      )}
    >
      <Icon className="size-5 shrink-0" strokeWidth={1.75} />
      <RailLabel>{label}</RailLabel>
    </Link>
  );
}

/** Label that fades in once the rail has widened on hover or keyboard focus. */
function RailLabel({ children }: { children: ReactNode }) {
  return <span className="text-sm font-medium whitespace-nowrap opacity-0 transition-opacity delay-75 duration-200 group-focus-within/nav:opacity-100 group-hover/nav:opacity-100 motion-reduce:transition-none">{children}</span>;
}

/** Desktop: slim right-edge rail, as in the reference (status + create on top, navigation pill at the bottom). */
function Rail({ address, onSignOut }: { address: string; onSignOut: () => void }) {
  const isActive = useActive();
  return (
    <aside className="fixed inset-y-6 right-6 z-40 hidden w-16 flex-col items-center justify-between lg:flex" aria-label="Main navigation">
      <div data-reveal="right" className="flex flex-col items-center gap-3">
        <Link href="/" className="block text-foreground transition-opacity duration-150 hover:opacity-70" aria-label="VESTA dashboard">
          <VestaMark className="h-9" />
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
            <Button asChild variant="trade" size="icon-xl" aria-label="Create agent">
              <Link href="/studio"><Plus /></Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">Create agent</TooltipContent>
        </Tooltip>
      </div>
      {/* Slim icon pill that widens leftwards on hover/focus so every page name is readable. */}
      <nav data-reveal="right" className="group/nav flex w-16 flex-col gap-1 self-end overflow-hidden rounded-[32px] bg-card p-2 shadow-[0_1px_2px_rgba(17,17,17,0.05),0_0_0_1px_rgba(17,17,17,0.03)] transition-[width,box-shadow] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] focus-within:w-60 hover:w-60 hover:shadow-[0_18px_50px_-18px_rgba(17,17,17,0.35),0_0_0_1px_rgba(17,17,17,0.04)] motion-reduce:transition-none">
        {NAV.map((n) => <RailButton key={n.href} {...n} active={isActive(n.href)} />)}
        <button onClick={onSignOut} aria-label="Sign out" className="flex h-12 items-center gap-3.5 rounded-full px-[14px] text-loss transition-colors duration-150 hover:bg-loss/10 focus-visible:ring-3 focus-visible:ring-loss/30 focus-visible:outline-none">
          <LogOut className="size-5 shrink-0" strokeWidth={1.75} />
          <RailLabel>Sign out</RailLabel>
        </button>
      </nav>
    </aside>
  );
}

function MobileTopBar({ address }: { address: string }) {
  return (
    <header data-reveal="down" className="flex items-center justify-between px-4 pt-4 sm:px-6 lg:hidden">
      <Link href="/" className="flex items-center gap-2.5" aria-label="VESTA dashboard"><VestaMark className="h-7" /><span className="font-display text-3xl leading-none">VESTA</span></Link>
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
      <button onClick={onSignOut} aria-label="Sign out" className="flex h-11 flex-1 items-center justify-center rounded-full text-loss">
        <LogOut className="size-5" strokeWidth={1.75} />
      </button>
    </nav>
  );
}

"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { useWallet } from "./Wallet";
export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter(); const wallet = useWallet(); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  if (!wallet.ready) return <main className="flex min-h-screen items-center justify-center text-dim">Loading…</main>;
  if (!wallet.address) return <main className="flex min-h-screen items-center justify-center px-6"><section className="w-full max-w-md rounded-sm border border-line bg-panel p-9"><p className="font-display text-3xl">Perpetua</p><h1 className="mt-10 font-display text-5xl">Your agents.<br />Your capital.</h1><p className="mt-5 text-paper/70">Sign in with MetaMask to manage your agents and investments.</p><button disabled={busy} className="mt-8 w-full rounded-sm bg-cushion px-5 py-3 font-medium text-ink disabled:opacity-50" onClick={async () => { setBusy(true); setError(""); try { await wallet.connect(); router.replace("/"); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>{busy ? "Waiting for MetaMask…" : "Sign in with MetaMask"}</button><p className="mt-3 text-xs text-dim">Signing in does not transfer funds or authorize trades.</p>{error && <p role="alert" className="mt-4 text-sm text-exposure">{error}</p>}</section></main>;
  return <><header className="border-b border-line"><nav className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-5"><Link href="/" className="font-display text-3xl">Perpetua</Link><div className="flex flex-wrap items-center gap-6 text-sm"><Link href="/">Dashboard</Link><Link href="/leaderboard">Leaderboard</Link><Link href="/studio">Create agent</Link><Link href="/registry">Chain registry</Link><button className="text-dim" onClick={() => wallet.logout()}>Sign out</button></div></nav></header><main className="mx-auto max-w-6xl px-6 pb-20">{children}</main></>;
}

"use client";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { createPublicClient, encodeFunctionData, erc20Abi, http, parseUnits, type Address, type Hex } from "viem";
import { perpetuaVaultAbi, splitAgentDeposit } from "@perpetua/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { signedUsd } from "@/components/ui-perpetua";
import { apiFetch } from "@/lib/api";
import { fmt } from "@/lib/data";
import { cn } from "@/lib/utils";
import { useWallet } from "./Wallet";
import { AnimatedNumber } from "./motion";
import { ActionSheet, useActionFlow, type FlowStep } from "./ActionSheet";

const PRESETS = ["100", "500", "1000"] as const;
const DEPOSIT_STEPS: FlowStep[] = [
  { label: "Approve", match: /^Approve the USDC/, title: "Approving USDC" },
  { label: "Deposit", match: /^Confirm the deposit/, title: "Depositing into the vault" },
  { label: "Live", match: /(?!)/, title: "Updating RiskGate" },
];

/** Local test deposits only until the live split/compute settlement coordinator is available. */
export function Funding({ agent, name, value, profit, className }: { agent: string; name?: string; value?: number | null; profit?: number | null; className?: string }) {
  const wallet = useWallet(); const [network, setNetwork] = useState<any>(null); const [portfolio, setPortfolio] = useState<any>(null); const [amount, setAmount] = useState("1000"); const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  const body = async (r: Response) => { const b = await r.json(); if (!r.ok) throw new Error(b.error); return b; };
  async function load() { setNetwork(await body(await apiFetch("/v1/network"))); const p = await body(await apiFetch(`/v1/investments/${agent}`)); setPortfolio(p); return p; }
  useEffect(() => { load().catch((e) => setMessage(e.message)); }, [agent]);
  async function run(work: () => Promise<void>) { setBusy(true); setMessage(""); try { await work(); } catch (e) { setMessage((e as Error).message); } finally { setBusy(false); } }
  const flow = useActionFlow({ busy, message, steps: DEPOSIT_STEPS, success: /^Capital deposited/ });
  const max = network?.balanceUsdc ? String(Math.floor(Number(network.balanceUsdc) * 100) / 100) : null;
  const preset = PRESETS.find((p) => p === amount) ?? (max && amount === max ? "max" : "");
  let initialAllocation: ReturnType<typeof splitAgentDeposit> | undefined;
  try { initialAllocation = splitAgentDeposit(parseUnits(amount, 6)); } catch { /* invalid or below minimum */ }

  return (
    <section data-reveal id="add-capital" aria-label="Add capital" className={cn("flex scroll-mt-6 flex-col rounded-[28px] bg-gradient-to-b from-[#6a88fb] to-brand p-6 text-white shadow-[0_24px_60px_-32px_rgba(91,124,250,0.7)]", className)}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-display text-[2rem] leading-none">Add capital</h2>
          <p className="mt-1.5 flex items-center gap-1.5 text-sm text-white/75">
            <span className="size-1.5 rounded-full bg-white/80" aria-hidden />
            {network ? (network.local ? "Local test network" : `Network ${network.chainId}`) : "Checking network…"}
          </p>
        </div>
        <div className="text-right">
          <p className="num text-sm font-semibold">{network ? `${fmt(Number(network.balanceUsdc))} USDC` : "—"}</p>
          <p className="text-xs text-white/65">In wallet</p>
        </div>
      </div>

      {value !== undefined && (
        <div className="mt-5 border-t border-white/15 pt-5">
          <p className="num text-[3.25rem] leading-none font-semibold tracking-tight">
            <AnimatedNumber value={value ?? 0} format={(n) => `$${fmt(n)}`} />
          </p>
          <p className="mt-2 text-sm text-white/80">
            {name ? `${name} capital` : "Current capital"} · Profit <span className="num font-semibold text-white">{signedUsd(profit ?? 0)}</span>
          </p>
        </div>
      )}

      <label htmlFor={`deposit-${agent}`} className="mt-6 text-xs text-white/75">Deposit amount (USDC)</label>
      <Input
        id={`deposit-${agent}`}
        aria-label="Deposit amount in USDC"
        type="number"
        min="5"
        step="0.01"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        className="num mt-1.5 h-12 bg-white/15 text-lg font-semibold text-white placeholder:text-white/50 hover:bg-white/20 focus-visible:bg-white/20 focus-visible:ring-white/40"
      />
      <ToggleGroup type="single" size="sm" spacing={1.5} value={preset} onValueChange={(v) => v && setAmount(v === "max" ? max ?? amount : v)} className="mt-3" aria-label="Quick amounts">
        {PRESETS.map((p) => (
          <ToggleGroupItem key={p} value={p} variant="onBrand" className="num px-3.5">{fmt(Number(p), 0)}</ToggleGroupItem>
        ))}
        {max && Number(max) > 0 && <ToggleGroupItem value="max" variant="onBrand" className="px-3.5">Max</ToggleGroupItem>}
      </ToggleGroup>
      {initialAllocation && <p className="mt-3 text-xs text-white/80">Proposed first-deposit allocation: {(Number(initialAllocation.computeUsd) / 1e6).toFixed(2)} USDC for compute and {(Number(initialAllocation.tradingUsd) / 1e6).toFixed(2)} USDC for trading. The split and 0G funding are not yet connected.</p>}
      <p className="mt-2 text-xs text-white/80">{network?.local ? "Local test deposits go entirely to the simulated vault; they do not fund 0G." : "Live deposits are unavailable until compute funding and settlement are connected."}</p>

      <div className="mt-auto space-y-2 pt-6">
        <Button size="xl" className="w-full" disabled={busy || !network?.local || !portfolio || !wallet.address || !initialAllocation} onClick={() => run(async () => {
          if (!network?.local) throw new Error("Live deposits require the compute funding coordinator");
          const assets = parseUnits(amount, 6); splitAgentDeposit(assets);
          const pub = createPublicClient({ transport: http(network.rpc) });
          const confirm = async (to: Address, data: Hex) => { const hash = await wallet.sendTransaction(to, data, network.chainId) as Hex; const receipt = await pub.waitForTransactionReceipt({ hash }); if (receipt.status !== "success") throw new Error("Transaction reverted"); };
          setMessage("Approve the USDC allocation in MetaMask…"); await confirm(network.usdc, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [portfolio.vault, assets] }));
          setMessage("Confirm the deposit in MetaMask…"); await confirm(portfolio.vault, encodeFunctionData({ abi: perpetuaVaultAbi, functionName: "deposit", args: [assets, wallet.address as Address] }));
          await body(await apiFetch(`/v1/agents/${agent}/refresh`, { method: "POST" })); await load(); window.dispatchEvent(new Event("perpetua:capital-changed")); setMessage("Capital deposited in the local test vault. This did not fund 0G compute.");
        })}>{busy ? <><Loader2 className="animate-spin" /> Working…</> : "Add funds"}</Button>
        {network?.local && (
          <Button variant="ghost" disabled={busy} className="w-full bg-white/15 text-white hover:bg-white/25 hover:text-white" onClick={() => run(async () => { await body(await apiFetch("/v1/local-faucet", { method: "POST" })); await load(); setMessage("10,000 test USDC and local gas added to your wallet."); })}>
            Get test funds
          </Button>
        )}
      </div>
      {message && <p key={message} role="status" className="pop-in mt-3 rounded-2xl bg-white/15 px-4 py-2.5 text-sm text-white">{message}</p>}
      <ActionSheet
        flow={flow}
        tag={`${name ?? "Agent"} · vault deposit`}
        doneTitle="Capital added"
        errorTitle="Deposit didn't complete"
        figure={<AnimatedNumber value={Number(amount) || 0} format={(n) => `${fmt(n)} USDC`} />}
      />
    </section>
  );
}

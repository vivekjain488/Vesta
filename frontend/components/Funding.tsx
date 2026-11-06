"use client";
import { useEffect, useState } from "react";
import { createPublicClient, encodeFunctionData, erc20Abi, http, parseUnits, type Address, type Hex } from "viem";
import { perpetuaVaultAbi } from "@perpetua/core";
import { apiFetch } from "@/lib/api";
import { useWallet } from "./Wallet";
export function Funding({ agent }: { agent: string }) {
  const wallet = useWallet(); const [network, setNetwork] = useState<any>(null); const [portfolio, setPortfolio] = useState<any>(null); const [amount, setAmount] = useState("1000"); const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  const body = async (r: Response) => { const b = await r.json(); if (!r.ok) throw new Error(b.error); return b; };
  async function load() { setNetwork(await body(await apiFetch("/v1/network"))); const p = await body(await apiFetch(`/v1/investments/${agent}`)); setPortfolio(p); return p; }
  useEffect(() => { load().catch((e) => setMessage(e.message)); }, [agent]);
  async function run(work: () => Promise<void>) { setBusy(true); setMessage(""); try { await work(); } catch (e) { setMessage((e as Error).message); } finally { setBusy(false); } }
  return <section className="mb-6 rounded-sm border border-line bg-panel p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-display text-3xl">Add capital</h2>{network && <span className="text-xs text-dim">{network.local ? "Local test network" : `Network ${network.chainId}`} · {network.balanceUsdc} USDC in wallet</span>}</div><div className="mt-4 flex flex-wrap gap-3"><input aria-label="Deposit amount in USDC" type="number" min="1" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-40 border border-line bg-ink p-2" /><button disabled={busy || !network || !portfolio || !wallet.address} className="bg-cushion px-4 py-2 text-ink disabled:opacity-40" onClick={() => run(async () => {
    const assets = parseUnits(amount, 6); if (assets <= 0n) throw new Error("Enter a positive amount");
    const pub = createPublicClient({ transport: http(network.rpc) });
    const confirm = async (to: Address, data: Hex) => { const hash = await wallet.sendTransaction(to, data, network.chainId) as Hex; const receipt = await pub.waitForTransactionReceipt({ hash }); if (receipt.status !== "success") throw new Error("Transaction reverted"); };
    setMessage("Approve the USDC allocation in MetaMask…"); await confirm(network.usdc, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [portfolio.vault, assets] }));
    setMessage("Confirm the deposit in MetaMask…"); await confirm(portfolio.vault, encodeFunctionData({ abi: perpetuaVaultAbi, functionName: "deposit", args: [assets, wallet.address as Address] }));
    await body(await apiFetch(`/v1/agents/${agent}/refresh`, { method: "POST" })); const after = await load(); window.dispatchEvent(new Event("perpetua:capital-changed")); setMessage(after.sleeping ? "Capital deposited. Resume the agent when its remaining capital meets the operating minimum." : "Capital deposited. Your agent is ready to operate within its limits.");
  })}>{busy ? "Working…" : "Add funds"}</button>{network?.local && <button disabled={busy} className="border border-line px-3 py-2 text-sm disabled:opacity-40" onClick={() => run(async () => { await body(await apiFetch("/v1/local-faucet", { method: "POST" })); await load(); setMessage("10,000 test USDC and local gas added to your wallet."); })}>Get test funds</button>}</div>{message && <p role="status" className="mt-3 text-sm text-dim">{message}</p>}</section>;
}

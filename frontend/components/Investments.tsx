"use client";
import { useEffect, useState } from "react";
import { configAuthMessage, perpetuaVaultAbi, riskGateAbi } from "@perpetua/core";
import { createPublicClient, encodeFunctionData, formatUnits, http, parseUnits, type Address, type Hex } from "viem";
import { apiFetch, API } from "@/lib/api";
import { deployment, fmt } from "@/lib/data";
import { useWallet } from "./Wallet";
import { Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, PnL, StatusNote } from "@/components/ui-perpetua";
import { ActionSheet, useActionFlow, type FlowStep } from "./ActionSheet";
const WITHDRAW_STEPS: FlowStep[] = [
  { label: "Sign", match: /^Review the withdrawal instruction/, title: "Signing the withdrawal" },
  { label: "Settle", match: /^Closing positions and settling/, title: "Settling positions" },
  { label: "Withdraw", match: /^(Confirm the (full )?withdrawal|Waiting for your withdrawal)/, title: "Withdrawing to your wallet" },
];
interface Position { id: string; kind: "cash" | "lending" | "spot"; token: Address; symbol: string; decimals: number; amount: string; valueUsd: number | null; unrealizedPnlUsd: number | null }
interface Portfolio { owner: Address; vault: Address; riskGate: Address; ownerShares: string; maxWithdraw: string; maxRedeem: string; sleeping: boolean; minimumOperatingCapital: string; investments: Position[]; chainId: number; blockNumber: string; exitExecutionAvailable: boolean; withdrawalPending: boolean }
export function Investments({ agent }: { agent: string }) {
  const wallet = useWallet(); const [portfolio, setPortfolio] = useState<Portfolio | null>(null); const [selected, setSelected] = useState<Position | null>(null); const [quantity, setQuantity] = useState(""); const [minimum, setMinimum] = useState(""); const [lossConsent, setLossConsent] = useState(false); const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  const body = async (res: Response) => { const data = await res.json(); if (!res.ok) throw new Error(data.error ?? "Request failed"); return data; };
  async function refresh() { const p = await body(await apiFetch(`/v1/investments/${agent}`)); setPortfolio(p); return p as Portfolio; }
  useEffect(() => { let active = true; const load = async () => { try { const p = await body(await apiFetch(`/v1/investments/${agent}`)); if (active) setPortfolio(p); } catch (e) { if (active) setMessage((e as Error).message); } }; load(); const timer = setInterval(load, 10000); window.addEventListener("perpetua:capital-changed", load); return () => { active = false; clearInterval(timer); window.removeEventListener("perpetua:capital-changed", load); }; }, [agent]);
  async function run(work: () => Promise<void>) { setBusy(true); setMessage(""); try { await work(); } catch (e) { setMessage((e as Error).message); } finally { setBusy(false); } }
  async function transaction(to: Address, data: Hex, p: Portfolio) {
    const dep = await deployment(); if (!dep || dep.chainId !== p.chainId) throw new Error("Network changed; reload before withdrawing");
    const hash = await wallet.sendTransaction(to, data, p.chainId) as Hex; setMessage("Waiting for your withdrawal to confirm…");
    const receipt = await createPublicClient({ transport: http(dep.rpc) }).waitForTransactionReceipt({ hash }); if (receipt.status !== "success") throw new Error("Transaction reverted; withdrawal did not complete"); return hash;
  }
  async function prepare(p: Portfolio, positions: Position[], scope: "all" | "position", requestedQuantity?: string) {
    if (positions.length && !p.exitExecutionAvailable) throw new Error("Position execution is not available on this network yet");
    const payload = { agent, operationId: crypto.randomUUID(), scope, allowLoss: true, positions: positions.map((position) => { const q = requestedQuantity ?? position.amount; const portion = Number(q) / Number(position.amount); return { token: position.token, amount: parseUnits(q, position.decimals).toString(), minProceedsUsdc: parseUnits(scope === "position" ? minimum : ((position.valueUsd ?? 0) * portion * 0.99).toFixed(6), 6).toString() }; }) };
    const challenge = await body(await apiFetch("/v1/config/challenge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: wallet.address, action: "withdraw", payload }) }));
    const expected = configAuthMessage(wallet.address!, "withdraw", payload, challenge.nonce, challenge.expiresAt, new URL(API).origin); if (challenge.message !== expected) throw new Error("Withdrawal instruction mismatch");
    setMessage("Review the withdrawal instruction in MetaMask…"); const signature = await wallet.signMessage(expected); setMessage("Closing positions and settling proceeds…");
    const result = await body(await apiFetch(`/v1/agents/${agent}/prepare-withdrawal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: wallet.address, payload, nonce: challenge.nonce, signature }) }));
    if (result.status !== "ready_for_wallet_withdrawal") throw new Error(result.error ?? "Positions have not finished settling"); return result;
  }
  async function withdrawAll() {
    let p = await refresh(); if (BigInt(p.ownerShares) === 0n) throw new Error("No invested capital to withdraw");
    const positions = p.investments.filter((i) => i.kind === "spot"); await prepare(p, positions, "all"); p = await refresh();
    if (BigInt(p.maxRedeem) < BigInt(p.ownerShares)) throw new Error("Some funds are still settling. No final withdrawal has been made.");
    setMessage("Confirm the full withdrawal in MetaMask…"); const hash = await transaction(p.vault, encodeFunctionData({ abi: perpetuaVaultAbi, functionName: "redeem", args: [BigInt(p.ownerShares), wallet.address as Address, wallet.address as Address] }), p);
    await body(await apiFetch(`/v1/agents/${agent}/withdrawal-complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transactionHash: hash }) }));
    await refresh(); setSelected(null); window.dispatchEvent(new Event("perpetua:capital-changed")); setMessage("All investments and the protected allocation have been withdrawn to your wallet. The agent is sleeping.");
  }
  async function withdrawSelected() {
    if (!selected) return; let p = await refresh(); const current = p.investments.find((i) => i.id === selected.id); if (!current) throw new Error("This investment is no longer open");
    if (parseUnits(quantity, current.decimals) <= 0n || parseUnits(quantity, current.decimals) > parseUnits(current.amount, current.decimals)) throw new Error("Choose an amount within this investment");
    let assets: bigint;
    if (current.kind === "spot") { if (!lossConsent) throw new Error("Confirm that the exit can realise a loss"); const result = await prepare(p, [current], "position", quantity); assets = BigInt(result.proceedsUsdc); p = await refresh(); }
    else assets = parseUnits(quantity, 6);
    if (assets > BigInt(p.maxWithdraw)) throw new Error("Your settled proceeds exceed the currently withdrawable share balance");
    if (assets > 0n) { setMessage("Confirm the withdrawal in MetaMask…"); const hash = await transaction(p.vault, encodeFunctionData({ abi: perpetuaVaultAbi, functionName: "withdrawFromInvestment", args: [assets, wallet.address as Address, current.kind === "lending"] }), p); await body(await apiFetch(`/v1/agents/${agent}/withdrawal-complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transactionHash: hash }) })); }
    else { await body(await apiFetch(`/v1/agents/${agent}/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resume: true }) })); await refresh(); setSelected(null); window.dispatchEvent(new Event("perpetua:capital-changed")); setMessage("Position closed with no proceeds. No funds were transferred to your wallet."); return; }
    const after = await refresh(); setSelected(null); window.dispatchEvent(new Event("perpetua:capital-changed")); setMessage(`Withdrawal complete.${after.sleeping ? " The agent is sleeping because its remaining capital is below its operating minimum." : " The agent can continue with the remaining capital."}`);
  }
  const flow = useActionFlow({ busy, message, steps: WITHDRAW_STEPS, success: /^(Withdrawal complete|All investments and the protected allocation|Position closed with no proceeds)/ });
  const kindLabel = (position: Position) => (position.kind === "cash" ? "Cash" : position.kind === "lending" ? "Protected allocation" : position.symbol);
  return <Card id="investments" className="scroll-mt-6">
    <CardHeader>
      <CardTitle>Current investments</CardTitle>
      <CardDescription>Open allocations with a remaining balance. You can withdraw a losing investment. Withdraw all closes every position and redeems the protected allocation too.</CardDescription>
      <CardAction><Button variant="outline" disabled={busy || !portfolio || BigInt(portfolio.ownerShares) === 0n} onClick={() => run(withdrawAll)}>Withdraw all</Button></CardAction>
    </CardHeader>
    <CardContent className="space-y-4">
      {!portfolio && !message && <Skeleton className="h-32 rounded-3xl" />}
      {portfolio && <>
        {portfolio.investments.length === 0 ? <EmptyState title="No current investments">Add funds to start.</EmptyState> : <Table>
          <TableHeader><TableRow className="hover:bg-transparent">
            <TableHead>Investment</TableHead><TableHead>Balance</TableHead><TableHead>Value</TableHead><TableHead>Profit / loss</TableHead><TableHead className="text-right"><span className="sr-only">Action</span></TableHead>
          </TableRow></TableHeader>
          <TableBody>{portfolio.investments.map((position) => <TableRow key={position.id} data-state={selected?.id === position.id ? "selected" : undefined}>
            <TableCell className="font-medium">{kindLabel(position)}</TableCell>
            <TableCell className="num">{Number(position.amount).toLocaleString(undefined, { maximumFractionDigits: 8 })} {position.symbol}</TableCell>
            <TableCell className="num">{position.valueUsd === null ? <span className="text-muted-foreground">Quote unavailable</span> : `$${fmt(position.valueUsd)}`}</TableCell>
            <TableCell><PnL value={position.unrealizedPnlUsd} /></TableCell>
            <TableCell className="text-right"><Button variant="soft" size="sm" disabled={busy || (position.kind === "spot" && !portfolio.exitExecutionAvailable)} onClick={() => { setSelected(position); setQuantity(position.amount); setMinimum(position.valueUsd !== null ? (position.valueUsd * 0.99).toFixed(6) : ""); setLossConsent(false); }}>Withdraw</Button></TableCell>
          </TableRow>)}</TableBody>
        </Table>}
        <p className="text-xs text-muted-foreground"><span className="num font-medium text-foreground">{formatUnits(BigInt(portfolio.maxWithdraw), 6)} USDC</span> is immediately withdrawable. The agent sleeps below <span className="num">{formatUnits(BigInt(portfolio.minimumOperatingCapital), 6)} USDC</span> remaining capital. Quoted values can change before execution.</p>
        {selected && <div className="space-y-4 rounded-3xl bg-muted p-5">
          <h3 className="font-display text-2xl leading-none">Withdraw {selected.kind === "lending" ? "from the protected allocation" : selected.symbol}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5"><Label htmlFor="withdraw-qty">Amount ({selected.symbol})</Label><Input id="withdraw-qty" aria-label="Investment withdrawal amount" value={quantity} onChange={(e) => setQuantity(e.target.value)} className="num bg-card" /></div>
            {selected.kind === "spot" && <div className="space-y-1.5"><Label htmlFor="withdraw-min">Minimum proceeds (USDC)</Label><Input id="withdraw-min" value={minimum} onChange={(e) => setMinimum(e.target.value)} className="num bg-card" /></div>}
          </div>
          {selected.kind === "spot" && <Label className="flex items-center gap-2.5 font-normal"><Checkbox checked={lossConsent} onCheckedChange={(v) => setLossConsent(v === true)} />I understand this exit can realise a loss.</Label>}
          <div className="flex flex-wrap gap-2"><Button variant="trade" disabled={busy || !quantity || (selected.kind === "spot" && (!lossConsent || !minimum))} onClick={() => run(withdrawSelected)}>{busy ? <><Loader2 className="animate-spin" /> Processing…</> : "Confirm withdrawal"}</Button><Button variant="ghost" disabled={busy} onClick={() => setSelected(null)}>Cancel</Button></div>
        </div>}
        {(portfolio.sleeping || portfolio.withdrawalPending) && BigInt(portfolio.ownerShares) > 0n && <Button variant="outline" disabled={busy} onClick={() => run(async () => { if (portfolio.sleeping) await transaction(portfolio.riskGate, encodeFunctionData({ abi: riskGateAbi, functionName: "resumeAfterWithdrawal" }), portfolio); await body(await apiFetch(`/v1/agents/${agent}/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resume: true }) })); await refresh(); window.dispatchEvent(new Event("perpetua:capital-changed")); setMessage("Agent resumed."); })}><RotateCcw /> Resume agent</Button>}
      </>}
      {message && <StatusNote key={message} className="pop-in">{message}</StatusNote>}
      <ActionSheet flow={flow} tag={`${selected ? (selected.kind === "lending" ? "Protected allocation" : selected.symbol) : "All investments"} · withdrawal`} doneTitle="Withdrawal complete" errorTitle="Withdrawal didn't complete" />
    </CardContent>
  </Card>;
}

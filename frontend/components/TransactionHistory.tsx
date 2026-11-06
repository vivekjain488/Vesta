"use client";
import { useEffect, useState } from "react";
import { History } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorNote, Hash } from "@/components/ui-perpetua";
import { apiFetch } from "@/lib/api";
import { fmt } from "@/lib/data";
const labels: Record<string, string> = { Deposit: "Capital deposited", Withdraw: "Withdrawal", IncomeRecorded: "Income received", WalletFunded: "Capital allocated to trading", WalletPulled: "Trading proceeds returned", Harvested: "Compute funded", OrderApproved: "Order approved", WithdrawalSleep: "Agent sleep changed", Returned: "Funds returned to vault" };
const dot: Record<string, string> = { Deposit: "bg-brand", Withdraw: "bg-foreground", IncomeRecorded: "bg-profit", Harvested: "bg-brand", OrderApproved: "bg-trade", WalletFunded: "bg-trade", WalletPulled: "bg-trade", AssetReceived: "bg-faint", AssetSent: "bg-faint" };
export function TransactionHistory({ agent }: { agent: string }) {
  const [rows, setRows] = useState<any[]>([]); const [error, setError] = useState("");
  useEffect(() => { let active = true; const load = async () => { try { const r = await apiFetch(`/v1/history/${agent}`); const body = await r.json(); if (!r.ok) throw new Error(body.error); if (active) setRows(body); } catch (e) { if (active) setError((e as Error).message); } }; load(); const timer = setInterval(load, 10000); window.addEventListener("perpetua:capital-changed", load); return () => { active = false; clearInterval(timer); window.removeEventListener("perpetua:capital-changed", load); }; }, [agent]);
  return (
    <Card id="history" className="scroll-mt-6">
      <CardHeader>
        <CardTitle>Transaction history</CardTitle>
        <CardDescription>Every on-chain event from the vault, trading wallet and RiskGate.</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Activity</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Block</TableHead>
                <TableHead>Transaction</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">
                    <span className="flex items-center gap-2.5">
                      <span className={`size-2 rounded-full ${dot[r.type] ?? "bg-faint"}`} aria-hidden />
                      {r.type === "AssetReceived" ? "Investment received" : r.type === "AssetSent" ? "Investment sent" : labels[r.type] ?? r.type}
                    </span>
                  </TableCell>
                  <TableCell className="num">{r.args?.assets !== undefined ? `${fmt(Number(r.args.assets) / 1e6)} USDC` : r.args?.symbol ? `${fmt(Number(r.args.amount) / 10 ** r.args.decimals)} ${r.args.symbol}` : r.type === "IncomeRecorded" ? `${fmt(Number(r.args.amount) / 1e6)} USDC` : <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell className="num text-muted-foreground">{r.blockNumber}</TableCell>
                  <TableCell><Hash value={r.transactionHash} head={10} tail={6} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {!rows.length && !error && <EmptyState title="No transactions yet" icon={<History className="size-4" />}>Deposits, approvals, income and withdrawals appear here once they land on-chain.</EmptyState>}
        {error && <ErrorNote className="mt-3">{error}</ErrorNote>}
      </CardContent>
    </Card>
  );
}

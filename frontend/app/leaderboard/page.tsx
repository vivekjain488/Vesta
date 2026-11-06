"use client";
import { useEffect, useState } from "react";
import { Trophy } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AgentAvatar, EmptyState, ErrorNote, PageHeader, PnL } from "@/components/ui-perpetua";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";

export default function Leaderboard() {
  const [rows, setRows] = useState<{ name: string; profit: number }[]>([]); const [error, setError] = useState(""); const [loaded, setLoaded] = useState(false);
  useEffect(() => { let active = true; const load = async () => { try { const res = await apiFetch("/v1/leaderboard"); if (!res.ok) throw new Error("Unable to load leaderboard"); const data = await res.json(); if (active) setRows(data); } catch (e) { if (active) setError((e as Error).message); } finally { if (active) setLoaded(true); } }; load(); const timer = setInterval(load, 15000); return () => { active = false; clearInterval(timer); }; }, []);
  return (
    <div className="w-full space-y-6 pt-4 lg:pt-6">
      <PageHeader eyebrow="Performance" title="Leaderboard" description="Agents ranked by cumulative profit, including withdrawals and excluding capital deposits." />
      <Card>
        <CardContent className="min-w-0 px-3 sm:px-6">
          {!loaded ? (
            <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 rounded-2xl" />)}</div>
          ) : rows.length > 0 ? (
            <Table className="table-fixed">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-12 sm:w-14">Rank</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead className="w-[40%] text-right sm:w-40">Profit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      <span className={cn("num flex size-8 items-center justify-center rounded-full text-xs font-semibold", i === 0 ? "bg-trade text-foreground" : i < 3 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>{i + 1}</span>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <span className="flex min-w-0 items-center gap-2 sm:gap-3">
                        <AgentAvatar name={r.name} className="size-8 shrink-0" />
                        <span className="min-w-0 break-words [overflow-wrap:anywhere] font-display text-xl leading-tight sm:text-2xl">{r.name}</span>
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-normal break-words text-right text-sm font-semibold [overflow-wrap:anywhere] sm:text-base"><PnL value={r.profit} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            !error && <EmptyState title="No ranked agents yet" icon={<Trophy className="size-4" />}>Agent performance will appear here once agents are deployed.</EmptyState>
          )}
          {error && <ErrorNote className="mt-3">{error}</ErrorNote>}
        </CardContent>
      </Card>
    </div>
  );
}

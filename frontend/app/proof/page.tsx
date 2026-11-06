"use client";
import { useEffect, useState } from "react";
import { ChevronRight, Info, ShieldCheck } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, PageHeader } from "@/components/ui-perpetua";
import { getJson } from "@/lib/data";

/** The README checklist, live: every tx hash / request ID the demo produced, per sponsor. */
export default function Proof() {
  const [ev, setEv] = useState<any>(undefined);
  useEffect(() => {
    getJson<any>("/v1/evidence").then(setEv);
  }, []);
  const beats = ev?.beats ?? {};
  return (
    <div className="max-w-4xl space-y-6 pt-4 lg:pt-6">
      <PageHeader eyebrow="Audit" title="Proof" description="No human topped it up. Principal was never at risk. Every decision can be audited. Each line below links a claim to the transaction or request that proves it." />
      {ev?.disclosure && (
        <Alert className="rounded-3xl border-0 bg-card">
          <Info />
          <AlertDescription>{ev.disclosure}</AlertDescription>
        </Alert>
      )}
      {ev === undefined ? (
        <Skeleton className="h-40 rounded-[28px]" />
      ) : !ev?.beats ? (
        <EmptyState title="No evidence yet" icon={<ShieldCheck className="size-4" />}>
          Run <code className="font-mono">pnpm demo</code>.
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {Object.entries(beats).map(([k, v]) => (
            <Card key={k}>
              <CardHeader>
                <CardTitle className="text-2xl">{k}</CardTitle>
              </CardHeader>
              <CardContent>
                <Collapsible defaultOpen>
                  <CollapsibleTrigger className="group flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                    Evidence <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" />
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <pre className="mt-3 overflow-x-auto rounded-2xl bg-muted p-4 font-mono text-[12px] leading-relaxed break-all whitespace-pre-wrap">{JSON.stringify(v, null, 2)}</pre>
                  </CollapsibleContent>
                </Collapsible>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

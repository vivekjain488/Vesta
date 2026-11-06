"use client";
/** Small presentational building blocks shared by every Perpetua screen. No data fetching here. */
import type { ReactNode } from "react";
import { AlertCircle, Inbox } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fmt, TIER_COPY } from "@/lib/data";
import { cn } from "@/lib/utils";

export function Micro({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("micro text-muted-foreground", className)}>{children}</span>;
}

export function Stat({ label, value, tone, className, hint }: { label: ReactNode; value: ReactNode; tone?: string; className?: string; hint?: ReactNode }) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("num mt-1 truncate text-lg font-semibold tracking-tight", tone)}>{value}</dd>
      {hint && <p className="mt-0.5 text-xs text-faint">{hint}</p>}
    </div>
  );
}

export const signedUsd = (n: number, d = 2) => `${n >= 0 ? "+" : "−"}$${fmt(Math.abs(n), d)}`;

/** Green/red only for real financial outcomes. */
export function PnL({ value, className, d = 2 }: { value: number | null | undefined; className?: string; d?: number }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return <span className={cn("num text-muted-foreground", className)}>—</span>;
  return <span className={cn("num", value < 0 ? "text-loss" : value > 0 ? "text-profit" : "text-muted-foreground", className)}>{signedUsd(value, d)}</span>;
}

const STATUS: Record<string, { label: string; variant: "brand" | "trade" | "muted" | "loss" | "profit" | "secondary" }> = {
  active: { label: "Active", variant: "profit" },
  awaiting_funding: { label: "Awaiting funding", variant: "trade" },
  sleeping: { label: "Sleeping", variant: "muted" },
  withdrawing: { label: "Withdrawing", variant: "trade" },
  draft: { label: "Draft", variant: "secondary" },
  paper: { label: "Paper", variant: "brand" },
};
export function StatusBadge({ status }: { status?: string }) {
  const s = STATUS[status ?? "active"] ?? { label: (status ?? "active").replaceAll("_", " "), variant: "secondary" as const };
  return <Badge variant={s.variant} className="capitalize">{s.label}</Badge>;
}

export function TierBadge({ tier }: { tier?: string }) {
  const t = TIER_COPY[tier ?? "thrive"] ?? TIER_COPY.thrive;
  const variant = tier === "frugal" ? "trade" : tier === "starving" ? "trade-deep" : tier === "hibernate" ? "muted" : "brand";
  return <Badge variant={variant}>{t.label}</Badge>;
}

const AVATAR_TONES = ["bg-brand text-white", "bg-trade text-foreground", "bg-primary text-primary-foreground", "bg-brand-soft text-brand-hover", "bg-trade-soft text-trade-deep"];
export function AgentAvatar({ name, className }: { name: string; className?: string }) {
  const tone = AVATAR_TONES[[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % AVATAR_TONES.length];
  const initials = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "A";
  return (
    <Avatar className={cn("size-9", className)}>
      <AvatarFallback className={cn("text-xs font-semibold", tone)}>{initials}</AvatarFallback>
    </Avatar>
  );
}

/** Read-only version of the reference's stepper field: label above a large value in a muted rounded box. */
export function ValueField({ label, value, tone, className }: { label: ReactNode; value: ReactNode; tone?: string; className?: string }) {
  return (
    <div className={cn("rounded-2xl bg-muted px-4 py-3 text-center", className)}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("num mt-0.5 text-lg font-semibold tracking-tight", tone)}>{value}</p>
    </div>
  );
}

export function Hash({ value, head = 8, tail = 6, className }: { value?: string | null; head?: number; tail?: number; className?: string }) {
  if (!value) return <span className={cn("font-mono text-xs text-faint", className)}>—</span>;
  const short = value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={cn("cursor-default font-mono text-xs text-muted-foreground outline-none", className)}>{short}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm font-mono text-[11px] break-all">{value}</TooltipContent>
    </Tooltip>
  );
}

/** Thin line in currentColor. Expects real values; renders nothing below two points. */
export function Sparkline({ values, className, height = 48 }: { values: number[]; className?: string; height?: number }) {
  if (values.length < 2) return null;
  const w = 160;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(height - 4 - ((v - min) / span) * (height - 8)).toFixed(1)}`);
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className={cn("h-12 w-full", className)} aria-hidden>
      <polyline points={pts.join(" ")} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function EmptyState({ title, children, action, icon, className }: { title: ReactNode; children?: ReactNode; action?: ReactNode; icon?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center rounded-3xl bg-muted/60 px-6 py-10 text-center", className)}>
      <div className="flex size-10 items-center justify-center rounded-full bg-card text-muted-foreground">{icon ?? <Inbox className="size-4" />}</div>
      <p className="mt-3 text-sm font-medium">{title}</p>
      {children && <div className="mt-1 max-w-sm text-sm text-muted-foreground">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p role="alert" className={cn("flex items-start gap-2 rounded-2xl bg-loss/8 px-4 py-3 text-sm text-loss", className)}>
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

export function StatusNote({ children, className }: { children: ReactNode; className?: string }) {
  return <p role="status" className={cn("rounded-2xl bg-muted px-4 py-3 text-sm text-foreground", className)}>{children}</p>;
}

/** Page header: mono eyebrow, serif title, muted description. */
export function PageHeader({ eyebrow, title, description, action }: { eyebrow?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <Micro>{eyebrow}</Micro>}
        <h1 className="mt-2 font-display text-5xl leading-[1.02] tracking-tight sm:text-6xl">{title}</h1>
        {description && <p className="mt-3 max-w-2xl text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

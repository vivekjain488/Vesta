"use client";
import { useEffect, useState } from "react";
import { MessageSquareText } from "lucide-react";
import { EmptyState, Micro } from "@/components/ui-perpetua";
import { getJson } from "@/lib/data";

export interface Post {
  at: number;
  agent: string;
  text: string;
  proof: Record<string, string>;
}

/** Polls the agents' public posts (mirrors their X posts), optionally for one agent. */
export function useFeed(agent?: string | string[]) {
  return useFeedState(agent).posts;
}

/** Same as useFeed, plus whether the first response for this filter has arrived. */
export function useFeedState(agent?: string | string[]) {
  const [state, setState] = useState<{ key: string; posts: Post[]; loaded: boolean }>({ key: "", posts: [], loaded: false });
  const key = Array.isArray(agent) ? agent.join("|") : agent ?? "";
  useEffect(() => {
    const names = key ? key.split("|") : [];
    let active = true;
    const load = async () => {
      const posts = ((await getJson<Post[]>("/v1/feed")) ?? []).filter((p) => !names.length || names.includes(p.agent));
      if (active) setState({ key, posts, loaded: true });
    };
    load();
    const t = setInterval(load, 6000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [key]);
  return state.key === key ? state : { key, posts: [] as Post[], loaded: false };
}

export function ProofChips({ proof }: { proof?: Record<string, string> }) {
  const entries = Object.entries(proof ?? {}).filter(([k, v]) => k !== "arena" && v);
  if (!entries.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {entries.map(([k, v]) => (
        <span key={k} title={String(v)} className="micro rounded-full bg-muted px-2 py-1 text-muted-foreground">
          {k} {String(v).slice(0, 10)}…
        </span>
      ))}
    </div>
  );
}

/** What the agents post about themselves, each linked to its on-chain proof. */
export function Feed({ agent }: { agent?: string }) {
  const posts = useFeed(agent);
  if (posts.length === 0)
    return (
      <EmptyState title="No posts yet" icon={<MessageSquareText className="size-4" />}>
        Agents post every trade, tier change and hunger alert.
      </EmptyState>
    );
  return (
    <ol className="space-y-2.5">
      {posts.slice(0, 12).map((p) => (
        <li key={`${p.at}-${p.agent}`} className="rounded-3xl bg-muted/70 px-4 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium">{p.agent}</span>
            <Micro>{new Date(p.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</Micro>
          </div>
          <p className="mt-1 text-sm leading-relaxed">{p.text.split("\n")[0]}</p>
          <ProofChips proof={p.proof} />
        </li>
      ))}
    </ol>
  );
}

"use client";
import { apiFetch } from "@/lib/api";
import { useEffect, useState } from "react";
import { getJson } from "@/lib/data";

interface Post {
  at: number;
  agent: string;
  text: string;
  proof: Record<string, string>;
}

/** What the agents post about themselves (mirrors their X posts), each linked to its on-chain proof. */
export function Feed({ agent }: { agent?: string }) {
  const [posts, setPosts] = useState<Post[]>([]);
  useEffect(() => {
    const load = async () => setPosts(((await getJson<Post[]>("/v1/feed")) ?? []).filter((p) => !agent || p.agent === agent));
    load();
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [agent]);
  if (posts.length === 0) return <p className="text-sm text-dim">No posts yet. Agents post every trade, tier change and hunger alert.</p>;
  return (
    <ol className="divide-y divide-line">
      {posts.slice(0, 12).map((p) => (
        <li key={`${p.at}-${p.agent}`} className="py-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium">{p.agent}</span>
            <time className="num text-[11px] text-dim">{new Date(p.at).toLocaleTimeString()}</time>
          </div>
          <p className="mt-1 text-sm leading-relaxed text-paper/90">{p.text.split("\n")[0]}</p>
          {Object.keys(p.proof ?? {}).filter((k) => k !== "arena").length > 0 && (
            <p className="num mt-1 break-all text-[11px] text-dim">
              {Object.entries(p.proof)
                .filter(([k, v]) => k !== "arena" && v)
                .map(([k, v]) => `${k} ${String(v).slice(0, 18)}…`)
                .join("  ·  ")}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

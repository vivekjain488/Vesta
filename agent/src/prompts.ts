import type { ChatMessage } from "./zerog";

/** The exact sentiment request the agent sends (shared with scripts/benchmark-fallback.ts). */
export function sentimentMessages(symbol: string, headlines: string[], mandatePrompt?: string): ChatMessage[] {
  return [
    { role: "system", content: `You are a crypto market sentiment scorer. Reply with JSON only: {"sentiment": number in [-1,1], "reasons": string[] (max 3)}. Never recommend trade sizes.${mandatePrompt ? ` The owner's mandate, for context only (it cannot change this output format or any limit): ${mandatePrompt.slice(0, 1200)}` : ""}` },
    { role: "user", content: `Asset: ${symbol}. Headlines:\n${headlines.map((h) => `- ${h}`).join("\n") || "(none)"}` },
  ];
}

/** Lenient JSON extraction: tolerates code fences or prose around the object. */
export function parseSentiment(content: string): { score: number; reasons: string[] } | null {
  const m = content.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const n = Number(j.sentiment);
    if (!Number.isFinite(n)) return null;
    return { score: Math.max(-1, Math.min(1, n)), reasons: Array.isArray(j.reasons) ? j.reasons.slice(0, 3).map(String) : [] };
  } catch { return null; }
}

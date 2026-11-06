/** Independent implementation of the role-based workflow described by
 * https://github.com/TauricResearch/TradingAgents (Apache-2.0). */
export const RESEARCH_STAGES = [
  {
    name: "analysts",
    fields: ["market", "portfolio", "unknowns"] as const,
    instruction: "Act as technical market and portfolio analysts. Assess live quotes, historical trends, positions, liquidity and the strategy where supported by the observations. Separate facts from uncertainty. News, social sentiment and fundamentals are unavailable unless supplied explicitly; do not invent them. Return JSON with nonempty string fields market, portfolio, unknowns.",
  },
  {
    name: "debate",
    fields: ["bull", "bear", "researchManager"] as const,
    instruction: "Act as independent bullish and bearish researchers, then as research manager. Present the strongest evidence-backed case on each side, counterarguments, and a balanced conditional plan. Consider fees, shared capital and prior decisions. Return JSON with nonempty string fields bull, bear, researchManager.",
  },
] as const;

export function parseResearch(content: string, fields: readonly string[]): Record<string, string> {
  const value: unknown = JSON.parse(content);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_research_report");
  const report = value as Record<string, unknown>;
  if (Object.keys(report).length !== fields.length || fields.some((field) => typeof report[field] !== "string" || !(report[field] as string).trim() || (report[field] as string).length > 2000)) throw new Error("invalid_research_report");
  return report as Record<string, string>;
}

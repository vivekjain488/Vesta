/** Bounded live connection check. Reads the backend key; never prints it or substitutes a simulation. */
import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { ZeroGRouterBrain, ZeroGServiceError } from "../agent/src/zerog-router";
import { tierFor } from "@perpetua/core";
const baseUrl = process.env.ZG_BASE_URL ?? "https://router-api.0g.ai/v1";
const report: any = { at: new Date().toISOString(), baseUrl, mode: "router", configured: Boolean(process.env.ZG_API_KEY) };
try {
  const r = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`Model catalog returned ${r.status}`);
  const models: any = await r.json(); const model = process.env.ZG_MODEL_SMALL ?? "0gm-1.0-35b-a3b";
  report.catalogReachable = true; report.model = model;
  if (!models.data?.some((m: any) => m.id === model)) throw new Error("Configured model is absent from this network's catalog");
  const brain = new ZeroGRouterBrain({ apiKey: process.env.ZG_API_KEY ?? "", baseUrl, modelSmall: model, modelLarge: process.env.ZG_MODEL_LARGE ?? model, maxTokensPerHour: 1000, maxTokensPerDay: 2000, stateFile: ".perpetua/0g-check-budget.json", timeoutMs: 30000 });
  const result = await brain.think(tierFor(72), [{ role: "user", content: "Reply with the single word OK." }], 24);
  if (!result) throw new Error("Connection check's token budget is exhausted");
  Object.assign(report, { success: true, response: result.content, requestId: result.chatId, verified: result.verified, verificationSource: result.verificationSource, billing: result.billing });
} catch (e) {
  Object.assign(report, { success: false, error: e instanceof ZeroGServiceError ? e.message : "0G endpoint/catalog is unavailable or its model configuration does not match. Check the network and try again.", ...(e instanceof ZeroGServiceError ? { status: e.status, code: e.code, requestId: e.requestId } : {}) });
  process.exitCode = 1;
}
mkdirSync(".perpetua", { recursive: true }); writeFileSync(".perpetua/0g-connection.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

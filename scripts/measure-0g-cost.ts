/**
 * Day-one measurement: real 0G cost per call for each provider, from the agent's own ledger delta. Prints the
 * constants to paste into .env (ZG_COST_LARGE_USD / ZG_COST_SMALL_USD) and economics.ts.
 *   ZG_MODE=live ZG_PRIVATE_KEY=... ZG_PROVIDER_LARGE=0x.. ZG_PROVIDER_SMALL=0x.. OG_PRICE_USD=.. tsx scripts/measure-0g-cost.ts [calls=3]
 * Also lists available services (pick models from https://pc.0g.ai/models).
 */
import "dotenv/config";
import { tierFor } from "@perpetua/core";
import { ZeroGBrain } from "../agent/src/zerog";

const calls = Number(process.argv[2] ?? 3);
const og = Number(process.env.OG_PRICE_USD ?? 0.5);
const brain = await new ZeroGBrain({
  rpc: process.env.ZG_RPC_URL ?? "https://evmrpc-testnet.0g.ai",
  privateKey: process.env.ZG_PRIVATE_KEY as `0x${string}`,
  providerLarge: process.env.ZG_PROVIDER_LARGE ?? "",
  providerSmall: process.env.ZG_PROVIDER_SMALL ?? "",
  subAccountTopUpOg: Number(process.env.ZG_SUBACCOUNT_TOPUP_OG ?? 1),
  minLedgerOg: Number(process.env.ZG_MIN_LEDGER_OG ?? 3),
  maxTokensPerHour: 1e9,
  maxTokensPerDay: 1e9,
}).init();

const services = await (brain as any).broker.inference.listService();
console.table(services.map((s: any) => ({ provider: s.provider, models: (s.models ?? []).join(","), pricePerToken: String(s.pricePerToken ?? ""), tee: s.teeSignerAddress, ack: s.teeSignerAcknowledged })));

for (const model of ["large", "small"] as const) {
  if (!(model === "large" ? process.env.ZG_PROVIDER_LARGE : process.env.ZG_PROVIDER_SMALL)) continue;
  const policy = { ...tierFor(1e6), model };
  const costs: number[] = [];
  for (let i = 0; i < calls; i++) {
    const r = await brain.think(policy, [{ role: "user", content: 'Reply with JSON {"sentiment":0.1,"reasons":["test"]}' }], 60);
    if (!r) break;
    costs.push(r.costOg);
    console.log(`${model} #${i + 1}: chatId=${r.chatId} verified=${r.verified} tee=${r.tee ? "yes" : "no"} cost=${r.costOg} 0G tokens=${r.tokens}`);
  }
  const avg = costs.reduce((a, b) => a + b, 0) / Math.max(1, costs.length);
  console.log(`\nZG_COST_${model.toUpperCase()}_USD=${(avg * og).toFixed(6)}   # ${avg} 0G/call @ $${og}/0G`);
}
console.log(`ledger now ${await brain.ledgerOg()} 0G`);

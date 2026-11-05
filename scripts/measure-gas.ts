/**
 * Day-one measurement: gas of every money-path transaction (poke, approveOrder, harvest, recordIncome) from the
 * receipts the demo produced, priced at the current vault-chain gas price. Output feeds
 * infrastructure_cost_per_month_usd in packages/core/src/economics.ts.
 *   tsx scripts/measure-gas.ts            (after `pnpm demo`; or point VAULT_RPC_URL at Base and pass tx hashes)
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { createPublicClient, formatEther, http, type Hex } from "viem";

const rpc = process.env.VAULT_RPC_URL ?? "http://127.0.0.1:8545";
const ethUsd = Number(process.env.ETH_PRICE_USD ?? 3000);
const pub = createPublicClient({ transport: http(rpc) });
const ev = JSON.parse(readFileSync(".perpetua/evidence.json", "utf8"));
const hashes: Record<string, Hex> = {};
const walk = (o: any, path: string) => {
  for (const [k, v] of Object.entries(o ?? {})) {
    if (typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v) && /tx|Tx/.test(k)) hashes[`${path}.${k}`] = v as Hex;
    else if (v && typeof v === "object") walk(v, `${path}.${k}`);
  }
};
walk(ev.beats, "");
const extra = process.argv.slice(2).filter((h) => h.startsWith("0x")) as Hex[];
extra.forEach((h, i) => (hashes[`arg${i}`] = h));

const gasPrice = process.env.GAS_PRICE_GWEI ? BigInt(Math.round(Number(process.env.GAS_PRICE_GWEI) * 1e9)) : await pub.getGasPrice();
const rows = [];
for (const [k, h] of Object.entries(hashes)) {
  const r = await pub.getTransactionReceipt({ hash: h }).catch(() => null);
  if (!r) continue;
  const costEth = Number(formatEther(r.gasUsed * gasPrice));
  rows.push({ tx: k.slice(1), gasUsed: Number(r.gasUsed), status: r.status, usdAtCurrentGas: +(costEth * ethUsd).toFixed(5) });
}
console.table(rows);
console.log(`gas price ${Number(gasPrice) / 1e9} gwei, ETH $${ethUsd}`);

/**
 * Prints what the dashboard would show for one owner, read straight from the local chain and runtime state.
 *   tsx scripts/demo-status.ts --owner 0x... [--state <dir>] [--deployment <file>]
 */
import "dotenv/config";
import { resolve } from "node:path";
import { getAddress, isAddress } from "viem";
import { Platform } from "../api/src/platform";

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const owner = arg("owner");
if (!owner || !isAddress(owner)) throw new Error("Usage: demo-status.ts --owner 0x... [--state dir] [--deployment file]");
if (arg("deployment")) process.env.DEPLOYMENT_FILE = resolve(arg("deployment")!);
const platform = new Platform(resolve(arg("state") ?? ".perpetua"));
const rows = [];
for (const a of platform.agents()) {
  const s = await platform.summary(a).catch(() => null);
  if (!s || s.owner.toLowerCase() !== getAddress(owner).toLowerCase()) continue;
  const trades: any[] = s.runtime?.trades ?? [];
  rows.push({ name: s.name, status: s.status, tier: s.runtime?.tier ?? "-", capital: +s.chain.V.toFixed(2), profit: +s.profit.toFixed(2), floor: +s.chain.F.toFixed(2), cushion: +s.chain.C.toFixed(2), exposure: +s.chain.E.toFixed(2), open: trades.filter((t) => t.status === "open").length, closed: trades.filter((t) => t.status !== "open").length, signals: (s.runtime?.signals ?? []).length });
}
console.table(rows);
process.exit(0);

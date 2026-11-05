/**
 * Income forwarder. x402 revenue settles in USDC to X402_PAY_TO (the agent's income wallet on the vault chain).
 * This forwards the not-yet-forwarded amount into the agent's vault with recordIncome(engine, amount), which
 * raises V and the cushion (never principal) so the next poke() can harvest it to 0G. Run on a cron.
 *   tsx scripts/forward-income.ts
 */
import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { erc20Abi, parseUnits, stringToHex, type Address, type Hex } from "viem";
import { perpetuaVaultAbi } from "@perpetua/core";
import { clients } from "../agent/src/chain";

const dep = JSON.parse(readFileSync(process.env.DEPLOYMENT_FILE ?? "contracts/deployments/local-31337.json", "utf8"));
const agent = process.env.AGENT_NAME ?? "Atlas";
const a = typeof dep[agent] === "string" ? JSON.parse(dep[agent]) : dep[agent];
const key = process.env.INCOME_WALLET_PRIVATE_KEY as Hex;
if (!key) throw new Error("INCOME_WALLET_PRIVATE_KEY (the X402_PAY_TO wallet) required");
const c = clients(process.env.VAULT_RPC_URL ?? "http://127.0.0.1:8545", Number(process.env.VAULT_CHAIN_ID ?? 31337), key);
const file = ".perpetua/x402-revenue.json";
if (!existsSync(file)) process.exit(0);
const rev = JSON.parse(readFileSync(file, "utf8"));

for (const engine of ["signals", "risk_checks"] as const) {
  const due = rev[engine] - (rev.forwarded?.[engine] ?? 0);
  if (due < 0.01) continue;
  const amount = parseUnits(due.toFixed(6), 6);
  await c.pub.waitForTransactionReceipt({ hash: await c.wallet.writeContract({ address: dep.usdc as Address, abi: erc20Abi, functionName: "approve", args: [a.vault, amount], account: c.account, chain: c.chain }) });
  const hash = await c.wallet.writeContract({ address: a.vault, abi: perpetuaVaultAbi, functionName: "recordIncome", args: [stringToHex(engine, { size: 32 }), amount], account: c.account, chain: c.chain });
  await c.pub.waitForTransactionReceipt({ hash });
  rev.forwarded = { ...(rev.forwarded ?? {}), [engine]: rev[engine] };
  console.log(`forwarded ${due.toFixed(4)} USDC of ${engine} -> vault ${a.vault}: ${hash}`);
}
writeFileSync(file, JSON.stringify(rev, null, 2));

/**
 * Seeds demo agents for one wallet on the LOCAL anvil chain, through the same code paths the app uses:
 * signed-definition store -> deployLocalAgent (vault, AgentWallet, RiskGate, registry, Privy income wallet)
 * -> real USDC deposit with the owner as share receiver -> RiskGate poke.
 * The hosted local runtime (running inside `pnpm api`) then trades these `paper` agents on its own, so all
 * positions, history and PnL come from real local-chain activity, not canned numbers.
 *
 *   tsx scripts/seed-demo.ts --owner 0x... [--state <dir>] [--deployment <file>]
 *
 * Re-runnable: an agent name the owner already has is skipped. Local simulation only (FLASH_MODE=sim, chain 31337).
 */
import "dotenv/config";
import { resolve } from "node:path";
import { erc20Abi, getAddress, isAddress, parseUnits, type Address } from "viem";
import { RISK_PROFILES, applyRiskProfile, computeTreasuryAbi, mockERC20Abi, perpetuaVaultAbi, templateConfig, type RiskProfile, type StrategyConfig } from "@perpetua/core";
import { AgentDefinitions } from "../api/src/agent-definitions";
import { deployLocalAgent, ensureTreasuryOperatorGas, localAdmin, treasuryOperator } from "../api/src/local-agents";
import { chainOperation, refreshLocalRisk } from "../api/src/local-withdrawals";
import { Platform } from "../api/src/platform";

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const owner = arg("owner");
if (!owner || !isAddress(owner)) throw new Error("Usage: seed-demo.ts --owner 0x... [--state dir] [--deployment file]");
const state = resolve(arg("state") ?? ".perpetua");
if (arg("deployment")) process.env.DEPLOYMENT_FILE = resolve(arg("deployment")!);
process.env.FLASH_MODE = "sim";

interface Seed { name: string; template: StrategyConfig["template"]; profile: RiskProfile; symbols: string[]; depositUsdc: number; note: string }
const SEEDS: Seed[] = [
  { name: "Trend Rider", template: "spot-momentum", profile: "balanced", symbols: ["BTC", "ETH", "LINK"], depositUsdc: 6000, note: "Follows closed-candle trends on BTC, ETH and LINK. Funded above the premium-model threshold." },
  { name: "Steady Accumulator", template: "spot-dca", profile: "cautious", symbols: ["BTC", "ETH"], depositUsdc: 2500, note: "Small bracketed buys outside downtrends. Cautious sizing." },
  { name: "Range Runner", template: "spot-range", profile: "balanced", symbols: ["ETH", "LINK"], depositUsdc: 1500, note: "Buys oversold dips in range regimes." },
  { name: "Breakout Hunter", template: "spot-breakout", profile: "aggressive", symbols: ["BTC", "ETH"], depositUsdc: 1000, note: "Follows closes above the prior channel high. Larger orders within RiskGate limits." },
  { name: "Band Reverter", template: "spot-bollinger", profile: "cautious", symbols: ["LINK", "ETH"], depositUsdc: 800, note: "Looks for a recovery through the lower volatility band." },
];

const platform = new Platform(state);
const definitions = new AgentDefinitions(state, process.env.CONFIG_AUTH_AUDIENCE ?? "http://localhost:8787");
const ownerAddress = getAddress(owner) as Address;
const dep = platform.deployment();
console.log(`state ${state}\nowner ${ownerAddress}\nchain ${await platform.pub.getChainId()}  usdc ${dep.usdc}`);

for (const seed of SEEDS) {
  if (definitions.list(ownerAddress).some((d) => d.name.toLowerCase() === seed.name.toLowerCase())) { console.log(`skip ${seed.name}: already exists`); continue; }
  const config = applyRiskProfile({ ...templateConfig(seed.template), symbols: seed.symbols }, seed.profile);
  const definition = definitions.save(ownerAddress, { name: seed.name, status: "paper", config, instructions: `${seed.note} ${RISK_PROFILES[seed.profile].instructions}`.slice(0, 4000) });
  const deployed = await deployLocalAgent(platform, definition);
  const admin = await localAdmin(platform);
  const amount = parseUnits(String(seed.depositUsdc), 6);
  await chainOperation(async () => {
    const wait = (hash: `0x${string}`) => admin.pub.waitForTransactionReceipt({ hash });
    await wait(await admin.wallet.writeContract({ address: dep.usdc, abi: mockERC20Abi, functionName: "mint", args: [admin.account.address, amount], account: admin.account, chain: admin.chain }));
    await wait(await admin.wallet.writeContract({ address: dep.usdc, abi: erc20Abi, functionName: "approve", args: [deployed.vault, amount], account: admin.account, chain: admin.chain }));
    await wait(await admin.wallet.writeContract({ address: deployed.vault, abi: perpetuaVaultAbi, functionName: "deposit", args: [amount, ownerAddress], account: admin.account, chain: admin.chain }));
  });
  await chainOperation(() => refreshLocalRisk(platform, definition.id));
  console.log(`created ${seed.name}  id ${definition.id.slice(0, 8)}  vault ${deployed.vault}  funded $${seed.depositUsdc}  income wallet ${deployed.incomeWallet ?? "n/a"}`);
}
// Repair: agents deployed before the operator fix registered the proposer as treasury operator, but the runtime signs with
// ZG_PRIVATE_KEY. Reconfiguring keeps the treasury balances and only sets who may pull them.
{
  const admin = await localAdmin(platform);
  await chainOperation(() => ensureTreasuryOperatorGas(platform));
  for (const d of definitions.list(ownerAddress)) {
    const deployed = platform.agents().find((a) => a.id === d.id); if (!deployed) continue;
    const current = (await platform.pub.readContract({ address: dep.computeTreasury, abi: computeTreasuryAbi, functionName: "agents", args: [deployed.agentId] })) as readonly any[];
    if (String(current[0]).toLowerCase() === treasuryOperator().toLowerCase()) continue;
    await chainOperation(async () => admin.pub.waitForTransactionReceipt({ hash: await admin.wallet.writeContract({ address: dep.computeTreasury, abi: computeTreasuryAbi, functionName: "configureAgent", args: [deployed.agentId, treasuryOperator(), parseUnits(String(d.config.compute.maxDailySpendOg), 18)], account: admin.account, chain: admin.chain }) }));
    console.log(`repaired treasury operator for ${d.name}`);
  }
}
console.log("done");
process.exit(0);

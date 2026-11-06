import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { keccak256, toBytes, parseUnits, type Address, type Hex } from "viem";
import { agentRegistryAbi, agentWalletAbi, computeTreasuryAbi, harvestRouterAbi, mockERC20Abi, perpetuaVaultAbi, riskGateAbi, type AgentDefinition } from "@perpetua/core";
import { clients } from "../../agent/src/chain";
import { privateKeyToAccount } from "viem/accounts";
import { chainOperation } from "./local-withdrawals";
import { Platform } from "./platform";

export async function localAdmin(platform: Platform) {
  if (process.env.FLASH_MODE !== "sim" || await platform.pub.getChainId() !== 31337 || !(await platform.pub.request({ method: "web3_clientVersion" })).toLowerCase().includes("anvil")) throw new Error("Local deployment is unavailable on this network");
  return clients(process.env.VAULT_RPC_URL!, 31337, process.env.FLASH_SPENDER_PRIVATE_KEY as Hex);
}
export async function deployLocalAgent(platform: Platform, definition: AgentDefinition) {
  if (definition.config.market !== "spot") throw new Error("Futures deployment requires a configured derivatives venue. Choose a spot strategy for now.");
  return chainOperation(async () => {
    const admin = await localAdmin(platform); const dep = platform.deployment();
    if (dep[definition.id]?.vault) return dep[definition.id];
    const receipt = async (hash: Hex) => { const r = await admin.pub.waitForTransactionReceipt({ hash }); if (r.status !== "success") throw new Error("Deployment transaction reverted"); return r; };
    const deploy = async (name: string, args: any[]) => { const a = JSON.parse(readFileSync(resolve(`contracts/out/${name}.sol/${name}.json`), "utf8")); const r = await receipt(await admin.wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object as Hex, args, account: admin.account, chain: admin.chain })); if (!r.contractAddress) throw new Error("No contract deployed"); return r.contractAddress; };
    const send = async (address: Address, abi: any, functionName: string, args: any[]) => receipt(await admin.wallet.writeContract({ address, abi, functionName, args, account: admin.account, chain: admin.chain }));
    const id = keccak256(toBytes(definition.id)); const proposer = privateKeyToAccount(process.env.PROPOSER_PRIVATE_KEY as Hex).address;
    const priceSigner = privateKeyToAccount(process.env.PRICE_SIGNER_PRIVATE_KEY as Hex).address;
    const vault = await deploy("PerpetuaVault", [dep.usdc, definition.name, "pAGENT", id, 9500n, 10000000n, false, admin.account.address]);
    const wallet = await deploy("AgentWallet", [admin.account.address]);
    const gate = await deploy("RiskGate", [vault, wallet, parseUnits(String(definition.config.risk.maxNotionalUsd), 6), 1, proposer, priceSigner, admin.account.address]);
    await send(wallet, agentWalletAbi, "wire", [vault, gate, proposer, admin.account.address]);
    await send(vault, perpetuaVaultAbi, "wire", [dep.safeLeg, gate, wallet, dep.harvestRouter]);
    dep.assets ??= { LINK: dep.link };
    const assets = [];
    for (const symbol of definition.config.symbols) {
      const address = dep.assets[symbol] ?? await deploy("MockERC20", [symbol, symbol, 18]); dep.assets[symbol] = address;
      assets.push({ symbol, address, decimals: 18, krakenPair: symbol === "BTC" ? "XBTUSD" : `${symbol}USD`, binanceSymbol: `${symbol}USDT` });
      await send(gate, riskGateAbi, "setAsset", [address, true, 500]);
    }
    await send(gate, riskGateAbi, "setTeeSigner", [privateKeyToAccount(keccak256(toBytes("perpetua-sim-tee-signer"))).address, true]);
    await send(gate, riskGateAbi, "setMinimumOperatingCapital", [parseUnits(String(definition.config.compute.minimumCapitalUsd), 6)]);
    await send(vault, perpetuaVaultAbi, "setFeeManager", [proposer]);
    await send(vault, perpetuaVaultAbi, "setAgentOwner", [definition.owner]);
    await send(dep.harvestRouter, harvestRouterAbi, "setVault", [vault, true]);
    await send(dep.computeTreasury, computeTreasuryAbi, "configureAgent", [id, proposer, parseUnits(String(definition.config.compute.maxDailySpendOg), 18)]);
    await send(dep.registry, agentRegistryAbi, "register", [id, definition.name, definition.config.template, vault, gate, wallet, proposer]);
    for (const [address, abi] of [[vault, perpetuaVaultAbi], [wallet, agentWalletAbi], [gate, riskGateAbi]] as const) await send(address, abi, "transferOwnership", [definition.owner]);
    const result = { vault, wallet, riskGate: gate, agentId: id, name: definition.name, strategy: definition.config.template, riskTier: "balanced", platformAgent: true, assets };
    dep[definition.id] = result;
    writeFileSync(process.env.DEPLOYMENT_FILE ?? "contracts/deployments/local-31337.json", JSON.stringify(dep, null, 2));
    const state = { createdAt: Math.floor(Date.now() / 1000), tier: "hibernate", lastThought: 0, lastBarT: {}, lastEpoch: "0", burnOgPerHour: 0.02, liveTrades: 0, wins: 0, consecutiveLosses: 0, lastIncomeBlock: "0", signals: {}, trades: {}, lastLedgerOg: 12, lastRunwayH: 0 };
    writeFileSync(resolve(platform.state, `agent-${definition.id}.json`), JSON.stringify(state, null, 2));
    return result;
  });
}
const funded = new Map<string, number>();
export async function localFaucet(platform: Platform, owner: Address) {
  return chainOperation(async () => {
    const admin = await localAdmin(platform);
    if ((funded.get(owner) ?? 0) > Date.now() - 3600000) throw new Error("Local test funds already added. Try again in one hour.");
    const dep = platform.deployment();
    const hash = await admin.wallet.writeContract({ address: dep.usdc, abi: mockERC20Abi, functionName: "mint", args: [owner, 10000_000000n], account: admin.account, chain: admin.chain });
    await admin.pub.waitForTransactionReceipt({ hash });
    const gas = await admin.wallet.sendTransaction({ to: owner, value: parseUnits("1", 18), account: admin.account, chain: admin.chain }); await admin.pub.waitForTransactionReceipt({ hash: gas });
    funded.set(owner, Date.now()); return { transactionHash: hash, gasTransactionHash: gas };
  });
}

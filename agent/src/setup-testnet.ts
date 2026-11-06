/** Provision the direct 0G testnet path when the Router is unavailable. Never runs on mainnet. */
import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { ethers } from "ethers";
import { createZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk";
const rpc = "https://evmrpc-testnet.0g.ai";
const provider = new ethers.JsonRpcProvider(rpc);
if ((await provider.getNetwork()).chainId !== 16602n) throw new Error("Expected 0G Galileo testnet only");
if (!process.env.ZG_PRIVATE_KEY && existsSync(".perpetua/0g-direct-setup.json")) throw new Error("Restore the existing backend wallet key before setup; refusing to replace its funding address");
const account = new ethers.Wallet(process.env.ZG_PRIVATE_KEY ?? ethers.Wallet.createRandom().privateKey, provider);
let env = readFileSync(".env", "utf8");
function set(name: string, value: string) { const lines = env.split("\n").filter((l) => !l.startsWith(`${name}=`)); lines.push(`${name}=${value}`); env = lines.join("\n"); }
set("ZG_PRIVATE_KEY", account.privateKey); set("ZG_RPC_URL", rpc);
const broker = await createZGComputeNetworkBroker(account);
const services = (await broker.inference.listService()).filter((s) => s.serviceType === "chatbot" && s.teeSignerAcknowledged);
if (!services.length) throw new Error("No acknowledged testnet chatbot provider available");
const sorted = [...services].sort((a,b) => Number(a.inputPrice + a.outputPrice - b.inputPrice - b.outputPrice));
set("ZG_PROVIDER_SMALL", sorted[0].provider); set("ZG_PROVIDER_LARGE", sorted.at(-1)!.provider);
writeFileSync(".env", env + "\n", {mode:0o600});
const balance = await provider.getBalance(account.address);
let ledgerAvailableOg: number | null = null;
try { const ledger = await broker.ledger.getLedger(); ledgerAvailableOg = Number(ledger.availableBalance) / 1e18; }
catch (e) { if (!/Account does not exist/i.test((e as Error).message)) throw e; }
const info = { ledgerAvailableOg, address: account.address, network: "0G Galileo testnet", chainId: 16602, balance: ethers.formatEther(balance), needed: "4 testnet 0G total: 3 for initial compute ledger, remainder for gas", providers: sorted.map((s) => ({address:s.provider,model:s.model,url:s.url})), ready: balance >= ethers.parseEther(ledgerAvailableOg === null ? "3.1" : "0.01") };
mkdirSync(".perpetua", {recursive:true});writeFileSync(".perpetua/0g-direct-setup.json",JSON.stringify(info,null,2));
console.log(JSON.stringify(info,null,2));

if (process.argv.includes("--activate")) {
  if (!info.ready) throw new Error(`Waiting for testnet funding at ${account.address}; no ledger deposit was attempted`);
  const { ZeroGBrain } = await import("./zerog");
  const brain = await new ZeroGBrain({ rpc, privateKey: account.privateKey as `0x${string}`, providerSmall: sorted[0].provider, providerLarge: sorted.at(-1)!.provider, subAccountTopUpOg: 1, minLedgerOg: 3, maxTokensPerHour: 20000, maxTokensPerDay: 50000 }).init();
  const result = await brain.think({ tier: "frugal", minRunwayHours: 48, model: "small", maxCandidates: 1, maxPromptTokens: 1200, postsReasoning: false, canHireHelpers: false, managesPositionsOnly: false, closesRiskyPositions: false }, [{ role: "user", content: "Reply with only OK." }], 128);
  if (!result || !result.content.trim() || result.verified !== true) throw new Error("Testnet inference did not return a verified response; app mode was not changed");
  // Preserve any local configuration changes made while the network requests ran.
  env = readFileSync(".env", "utf8"); set("ZG_MODE", "live"); set("CONFIG_COMPILER_ENABLED", "true");
  writeFileSync(".env", env + "\n", { mode: 0o600 });
  const evidence = { ...info, ready: true, activatedAt: new Date().toISOString(), requestId: result.chatId, model: result.model, provider: result.provider, verified: result.verified, rawTeeProofAvailable: Boolean(result.tee), ledgerAvailableOg: await brain.ledgerOg() };
  writeFileSync(".perpetua/0g-direct-setup.json", JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2));
}

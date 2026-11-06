/** Provision the direct 0G testnet path when the Router is unavailable. Never runs on mainnet. */
import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { ethers } from "ethers";
import { createZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk";
const rpc = "https://evmrpc-testnet.0g.ai";
const provider = new ethers.JsonRpcProvider(rpc);
if ((await provider.getNetwork()).chainId !== 16602n) throw new Error("Expected 0G Galileo testnet only");
const account = process.env.ZG_PRIVATE_KEY ? new ethers.Wallet(process.env.ZG_PRIVATE_KEY, provider) : ethers.Wallet.createRandom().connect(provider);
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
const info = { address: account.address, network: "0G Galileo testnet", chainId: 16602, balance: ethers.formatEther(balance), needed: "4 testnet 0G total: 3 for initial compute ledger, remainder for gas", providers: sorted.map((s) => ({address:s.provider,model:s.model,url:s.url})), ready: balance >= ethers.parseEther("3.1") };
mkdirSync(".perpetua", {recursive:true});writeFileSync(".perpetua/0g-direct-setup.json",JSON.stringify(info,null,2));
console.log(JSON.stringify(info,null,2));

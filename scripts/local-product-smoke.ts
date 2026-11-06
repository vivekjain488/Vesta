/** Explicit local-chain integration check. Requires the API and Anvil; never uses a real wallet. */
import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { createPublicClient, createWalletClient, erc20Abi, http, keccak256, toBytes, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";
import { templateConfig, perpetuaVaultAbi, riskGateAbi } from "@perpetua/core";
const base = "http://localhost:8787";
const pub = createPublicClient({ transport: http("http://127.0.0.1:8545") });
assert.equal(await pub.getChainId(), 31337);
assert.match(await pub.request({method:"web3_clientVersion"}), /anvil/i);
const account = privateKeyToAccount(keccak256(toBytes(`perpetua-local-smoke:${randomUUID()}`)));
const chain = defineChain({ id: 31337, name: "Local", nativeCurrency: { name:"Ether",symbol:"ETH",decimals:18 }, rpcUrls:{default:{http:["http://127.0.0.1:8545"]}} });
const wallet = createWalletClient({ account, chain, transport: http() });
let cookie = ""; const ids: string[] = [];
async function request(path: string, data?: any, method = data === undefined ? "GET" : "POST", expected = 200) {
 const r = await fetch(base + path, {method, headers: {"content-type":"application/json",cookie}, body:data === undefined ? undefined : JSON.stringify(data)});
 const body = await r.json(); assert.equal(r.status, expected, `${path}: ${JSON.stringify(body)}`); return { body, r };
}
async function signed(path: string, action: string, payload: any, method = "POST", expected = 200) {
 const { body: c } = await request("/v1/config/challenge", {owner:account.address,action,payload});
 return (await request(path,{owner:account.address,payload,nonce:c.nonce,signature:await account.signMessage({message:c.message})},method,expected)).body;
}
async function send(address: any, abi: any, functionName: string, args: any[]) {
 const hash = await wallet.writeContract({address,abi,functionName,args}); const receipt = await pub.waitForTransactionReceipt({hash}); assert.equal(receipt.status,"success"); return hash;
}
try {
 await request("/v1/dashboard",undefined,"GET",401);
 const { body:c } = await request("/auth/challenge",{address:account.address,chainId:31337});
 const signature = await account.signMessage({message:c.message});
 const { r } = await request("/auth/verify",{nonce:c.nonce,signature}); cookie = r.headers.get("set-cookie")!.split(";")[0];
 await request("/auth/verify",{nonce:c.nonce,signature},"POST",401);
 assert.equal((await request("/v1/dashboard")).body.length,0);
 await request("/v1/investments/Atlas",undefined,"GET",403);
 const config = templateConfig("spot-dca"); config.symbols = ["LINK", "ETH"]; config.execution.pollSeconds = 5;
 const definition = await signed("/v1/agent-definitions","create",{name:"Local verification",status:"draft",config},"POST",201); ids.push(definition.id);
 const id = definition.id; const { body:a } = await request(`/v1/agent-definitions/${id}/deploy`,{});
 console.log("Authenticated, owner isolation checked, agent deployed",id);
 await request("/v1/local-faucet",{});
 const {body:network} = await request("/v1/network");
 await send(network.usdc,erc20Abi,"approve",[a.vault,parseUnits("1000",6)]);
 await send(a.vault,perpetuaVaultAbi,"deposit",[parseUnits("1000",6),account.address]);
 await request(`/v1/agents/${id}/refresh`,{});
 let positions:any;
 for (let n=0; n<8; n++) { positions=(await request(`/v1/investments/${id}`)).body; if(positions.investments.some((p:any)=>p.kind==="spot"))break; await new Promise(r=>setTimeout(r,3000)); }
 console.log("Investments",positions.investments.map((p:any)=>({kind:p.kind,symbol:p.symbol,amount:p.amount})));
 assert(positions.investments.some((p:any)=>p.kind==="spot"),"Hosted agent did not settle a trade");
 assert(positions.investments.some((p:any)=>p.kind==="lending"),"Protected allocation missing");
 const current = (await request("/v1/agent-definitions")).body.find((d:any)=>d.id===id);
 await signed(`/v1/agent-definitions/${id}`,"update",{id,name:current.name,status:"sleeping",config:current.config,revision:current.revision},"PUT");
 const spot = positions.investments.find((p:any)=>p.kind==="spot");
 const half = parseUnits(spot.amount,spot.decimals)/2n;
 const partial = await signed(`/v1/agents/${id}/prepare-withdrawal`,"withdraw",{agent:id,operationId:randomUUID(),scope:"position",allowLoss:true,positions:[{token:spot.token,amount:half.toString(),minProceedsUsdc:"0"}]});
 assert.equal(partial.status,"ready_for_wallet_withdrawal");
 const partialHash = await send(a.vault,perpetuaVaultAbi,"withdrawFromInvestment",[BigInt(partial.proceedsUsdc),account.address,false]);
 await request(`/v1/agents/${id}/withdrawal-complete`,{transactionHash:partialHash});
 positions=(await request(`/v1/investments/${id}`)).body;
 assert(positions.investments.some((p:any)=>p.kind==="spot"&&p.token===spot.token));
 assert.equal(positions.sleeping,false,"A funded partial withdrawal should remain awake");
 const allPayload = {agent:id,operationId:randomUUID(),scope:"all",allowLoss:true,positions:positions.investments.filter((p:any)=>p.kind==="spot").map((p:any)=>({token:p.token,amount:parseUnits(p.amount,p.decimals).toString(),minProceedsUsdc:"0"}))};
 const all=await signed(`/v1/agents/${id}/prepare-withdrawal`,"withdraw",allPayload);
 assert.equal(all.status,"ready_for_wallet_withdrawal");
 await request(`/v1/agents/${id}/withdrawal-complete`,{transactionHash:partialHash},"POST",400);
 const retry = await signed(`/v1/agents/${id}/prepare-withdrawal`,"withdraw",allPayload);
 assert.deepEqual(retry.transactions,all.transactions,"An idempotent retry must not execute another exit");
 positions=(await request(`/v1/investments/${id}`)).body;
 assert.equal(positions.maxRedeem,positions.ownerShares);
 const finalHash=await send(a.vault,perpetuaVaultAbi,"redeem",[BigInt(positions.ownerShares),account.address,account.address]);
 await request(`/v1/agents/${id}/withdrawal-complete`,{transactionHash:finalHash});
 positions=(await request(`/v1/investments/${id}`)).body;
 assert.equal(positions.ownerShares,"0"); assert.equal(positions.investments.length,0); assert.equal(positions.sleeping,true);
 assert.equal(await pub.readContract({address:a.vault,abi:perpetuaVaultAbi,functionName:"safeValue"}),0n);
 const history=(await request(`/v1/history/${id}`)).body; assert(history.some((x:any)=>x.type==="Deposit")); assert(history.some((x:any)=>x.type==="Withdraw")); assert(history.some((x:any)=>x.type==="AssetReceived")); assert(history.some((x:any)=>x.type==="AssetSent"));
 const board=(await request("/v1/leaderboard")).body; assert(board.every((r:any)=>Object.keys(r).sort().join(",")==="name,profit"));
 writeFileSync(".perpetua/local-product-verification.json",JSON.stringify({at:new Date().toISOString(),id,depositUsdc:1000,partialHash,finalHash,allTransactions:all.transactions,historyEvents:history.length,checks:["SIWE login and replay rejection","wallet isolation","deployment","hosted trade settlement","protected allocation","partial position exit and payout","full exit and protected redemption","empty portfolio and withdrawal sleep","transaction history","leaderboard fields"]},null,2));
 console.log("PASS: deposit, hosted trading, partial exit, full redemption including protected funds, sleep, history and private leaderboard.");
} finally {
 // Remove only this check's definitions and deployment entries; retain chain receipts/evidence.
 const file=process.env.DEPLOYMENT_FILE!; const dep=JSON.parse(readFileSync(file,"utf8"));
 for(const id of ids){delete dep[id];try{unlinkSync(`.perpetua/definitions/${id}.json`)}catch{}}
 writeFileSync(file,JSON.stringify(dep,null,2));
}

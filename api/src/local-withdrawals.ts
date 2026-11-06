import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { erc20Abi, formatUnits, keccak256, parseUnits, toBytes, toHex, type Address, type Hex } from "viem";
import { priceAttestationTypedData, riskGateAbi } from "@perpetua/core";
import { privateKeyToAccount } from "viem/accounts";
import { clients } from "../../agent/src/chain";
import { SimSettlement } from "../../agent/src/simSettlement";
import { fetchBars4h, latestClose, replayActive, syntheticBars } from "../../agent/src/market";
import { Platform } from "./platform";

let queue: Promise<unknown> = Promise.resolve();
export function chainOperation<T>(work: () => Promise<T>): Promise<T> { const result = queue.then(work); queue = result.catch(() => {}); return result; }
const syntheticPrice = (symbol: string) => syntheticBars(400, symbol === "BTC" ? 65000 : symbol === "ETH" ? 2500 : 15).at(-1)!.c;
/** Paper mark: the latest closed candle (replay clock aware) for real-data runs; the synthetic series otherwise. */
export const localPriceUsd = (symbol = "LINK") =>
  process.env.CANDLE_SOURCE === "synthetic" && !replayActive() ? syntheticPrice(symbol) : latestClose(`${symbol}USDT`) ?? syntheticPrice(symbol);
/** Same as localPriceUsd, but fetches a real close first when this process has not seen one yet. */
export async function markPriceUsd(symbol: string) {
  const source = process.env.CANDLE_SOURCE;
  if (!replayActive() && source !== "synthetic" && latestClose(`${symbol}USDT`) === undefined)
    await fetchBars4h({ krakenPair: symbol === "BTC" ? "XBTUSD" : `${symbol}USD`, binanceSymbol: `${symbol}USDT`, source: (source as any) ?? "kraken", limit: 2 }).catch(() => undefined);
  return localPriceUsd(symbol);
}

export async function refreshLocalRisk(platform: Platform, id: string) {
  const a = platform.agent(id);
  const admin = clients(process.env.VAULT_RPC_URL!, 31337, process.env.FLASH_SPENDER_PRIVATE_KEY as Hex);
  if (await platform.pub.getChainId() !== 31337 || process.env.FLASH_MODE !== "sim") throw new Error("Local risk refresh unavailable");
  const signer = privateKeyToAccount(process.env.PRICE_SIGNER_PRIVATE_KEY as Hex);
  const prices = [];
  const count = await platform.pub.readContract({ address: a.riskGate, abi: riskGateAbi, functionName: "assetCount" });
  for (let i = 0; i < Number(count); i++) {
    const token = await platform.pub.readContract({ address: a.riskGate, abi: riskGateAbi, functionName: "assetList", args: [BigInt(i)] });
    if (!await platform.pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [a.wallet] })) continue;
    const symbol = await platform.pub.readContract({ address: token, abi: erc20Abi, functionName: "symbol" });
    const timestamp = (await platform.pub.getBlock({ blockTag: "latest" })).timestamp; const priceE8 = BigInt(Math.round((await markPriceUsd(String(symbol))) * 1e8));
    prices.push({ asset: token, timestamp, priceE8, signature: await signer.signTypedData(priceAttestationTypedData(31337, a.riskGate, token, priceE8, timestamp)) });
  }
  const hash = await admin.wallet.writeContract({ address: a.riskGate, abi: riskGateAbi, functionName: "poke", args: [prices], account: admin.account, chain: admin.chain });
  const receipt = await admin.pub.waitForTransactionReceipt({ hash }); if (receipt.status !== "success") throw new Error("Risk refresh reverted");
  return hash;
}

/** Executes on the explicit local Anvil simulator only. No fake successful result for a live venue. */
export async function prepareLocalWithdrawal(platform: Platform, owner: Address, payload: any) {
  if (process.env.FLASH_MODE !== "sim" || await platform.pub.getChainId() !== 31337 || !(await platform.pub.request({ method: 'web3_clientVersion' })).toLowerCase().includes("anvil")) throw new Error("Live position execution is not configured");
  if (!payload || !/^[a-f0-9-]{36}$/.test(payload.operationId) || !["all", "position"].includes(payload.scope) || payload.allowLoss !== true || !Array.isArray(payload.positions) || payload.positions.length > 50) throw new Error("Invalid withdrawal instruction");
  if (!await platform.owns(payload.agent, owner)) throw new Error("Agent belongs to another wallet");
  return chainOperation(async () => {
    const path = resolve(platform.state, "withdrawals", `${payload.operationId}.json`); mkdirSync(resolve(platform.state, "withdrawals"), { recursive: true });
    if (existsSync(path)) { const previous = JSON.parse(readFileSync(path, "utf8")); if (previous.owner !== owner || previous.instructionHash !== keccak256(toBytes(JSON.stringify(payload)))) throw new Error("Withdrawal ID already used"); return previous; }
    const pending = readdirSync(resolve(platform.state, "withdrawals")).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(resolve(platform.state, "withdrawals", f), "utf8"))).some((r) => r.agent === payload.agent && ["closing_positions", "ready_for_wallet_withdrawal", "failed"].includes(r.status));
    if (pending) throw new Error("Finish the existing withdrawal or resume the agent before requesting another");
    const dep = platform.deployment(); const a = platform.agent(payload.agent);
    const admin = clients(process.env.VAULT_RPC_URL!, 31337, process.env.FLASH_SPENDER_PRIVATE_KEY as Hex);
    const proposer = clients(process.env.VAULT_RPC_URL!, 31337, process.env.PROPOSER_PRIVATE_KEY as Hex);
    const signer = privateKeyToAccount(process.env.PRICE_SIGNER_PRIVATE_KEY as Hex);
    const tee = privateKeyToAccount(keccak256(toBytes("perpetua-sim-tee-signer")));
    const read = (token: Address, name: string, args: any[] = []): Promise<any> => platform.pub.readContract({ address: token, abi: erc20Abi as any, functionName: name, args });
    const count = await platform.pub.readContract({ address: a.riskGate, abi: riskGateAbi, functionName: "assetCount" });
    const held: Address[] = [];
    for (let i = 0; i < Number(count); i++) { const token = await platform.pub.readContract({ address: a.riskGate, abi: riskGateAbi, functionName: "assetList", args: [BigInt(i)] }); if (await read(token, "balanceOf", [a.wallet]) > 0n) held.push(token); }
    const selected = new Set<string>();
    for (const p of payload.positions) {
      if (!p || typeof p.amount !== "string" || !/^\d{1,78}$/.test(p.amount) || typeof p.minProceedsUsdc !== "string" || !/^\d{1,78}$/.test(p.minProceedsUsdc) || BigInt(p.amount) <= 0n || !held.some((t) => t.toLowerCase() === String(p.token).toLowerCase()) || selected.has(String(p.token).toLowerCase())) throw new Error("Invalid or duplicate position");
      selected.add(p.token.toLowerCase());
      const balance = await read(p.token, "balanceOf", [a.wallet]);
      if (BigInt(p.amount) > balance || (payload.scope === "all" && BigInt(p.amount) !== balance)) throw new Error("Position changed; refresh before withdrawing");
      const decimals = Number(await read(p.token, "decimals")); const output = parseUnits((Number(formatUnits(BigInt(p.amount), decimals)) * (localPriceUsd(String(await read(p.token, "symbol"))))).toFixed(6), 6);
      if (output < BigInt(p.minProceedsUsdc)) throw new Error("Current exit proceeds are below your minimum");
    }
    if (payload.scope === "all" && held.some((t) => !selected.has(t.toLowerCase()))) throw new Error("Withdraw all must include every current position");
    const result: any = { id: payload.operationId, owner, agent: payload.agent, scope: payload.scope, instructionHash: keccak256(toBytes(JSON.stringify(payload))), status: "closing_positions", transactions: [], proceedsUsdc: "0", mode: "local", createdAt: Date.now() };
    const save = () => writeFileSync(path, JSON.stringify(result, null, 2)); save();
    const send = async (client: typeof admin, functionName: string, args: any[]) => { const hash = await client.wallet.writeContract({ address: a.riskGate, abi: riskGateAbi as any, functionName, args, account: client.account, chain: client.chain }); result.transactions.push(hash); save(); const receipt = await client.pub.waitForTransactionReceipt({ hash }); if (receipt.status !== "success") throw new Error(`${functionName} reverted`); };
    const attest = async (token: Address) => { const timestamp = (await platform.pub.getBlock({ blockTag: "latest" })).timestamp; const priceE8 = BigInt(Math.round(localPriceUsd(String(await read(token, "symbol"))) * 1e8)); return { asset: token, timestamp, priceE8, signature: await signer.signTypedData(priceAttestationTypedData(31337, a.riskGate, token, priceE8, timestamp)) }; };
    try {
      if (payload.scope === "all" || payload.positions.length) await send(admin, "forceHibernate", [toHex("OWNER_EXIT", { size: 32 })]);
      for (const p of payload.positions) {
        const decimals = Number(await read(p.token, "decimals")); const quantity = Number(formatUnits(BigInt(p.amount), decimals));
        const output = parseUnits((quantity * (localPriceUsd(String(await read(p.token, "symbol"))))).toFixed(6), 6);
        const px = await attest(p.token); const digest = keccak256(toBytes(`${payload.operationId}:${p.token}`));
        const text = `Local owner-requested exit ${payload.operationId}, ${p.token}, ${p.amount}`;
        await send(proposer, "approveOrder", [{ flashDigest: digest, bracketDigest: `0x${"00".repeat(32)}`, kind: 1, tokenIn: p.token, tokenOut: dep.usdc, amountIn: BigInt(p.amount), minAmountOut: BigInt(p.minProceedsUsdc), stopPriceE8: 0n, takeProfitPriceE8: 0n, deadline: px.timestamp + 120n, recipient: a.wallet }, px, { chatIdHash: keccak256(toBytes(text)), response: toHex(text), signature: await tee.signMessage({ message: text }) }]);
        const hash = await new SimSettlement(admin).fillExit({ wallet: a.wallet, tokenIn: p.token, tokenOut: dep.usdc, amountIn: BigInt(p.amount), amountOut: output });
        result.transactions.push(hash); result.proceedsUsdc = (BigInt(result.proceedsUsdc) + output).toString(); save();
        const state = platform.stateOf(a.id);
        if (state) {
          const symbol = await read(p.token, "symbol"); let remaining = quantity;
          for (const t of Object.values(state.trades ?? {}).sort((x: any, y: any) => x.openedAt - y.openedAt) as any[]) {
            if (t.status !== "open" || t.asset !== symbol || remaining <= 0) continue;
            const qty = Number(t.qty); if (!Number.isFinite(qty) || qty <= 0) continue;
            const take = Math.min(qty, remaining); const basis = Number(t.sizeUsd) * take / qty;
            t.pnlUsd = (t.pnlUsd ?? 0) + take * localPriceUsd(String(symbol)) - basis; t.qty = String(qty - take); t.sizeUsd -= basis; t.exitTx = hash;
            if (take === qty) { t.status = "closed"; t.closedAt = Date.now() / 1000; } remaining -= take;
          }
          writeFileSync(resolve(platform.state, `agent-${a.id}.json`), JSON.stringify(state, null, 2));
        }
      }
      const prices = []; for (const token of held) if (await read(token, "balanceOf", [a.wallet]) > 0n) prices.push(await attest(token));
      await send(admin, "poke", [prices]);
      result.settledAtBlock = (await platform.pub.getBlockNumber({ cacheTime: 0 })).toString();
      result.status = "ready_for_wallet_withdrawal"; save(); return result;
    } catch (e) { result.status = "failed"; result.error = (e as Error).message; save(); throw e; }
  });
}

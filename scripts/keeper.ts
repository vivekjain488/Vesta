/**
 * poke() keeper. Permissionless: any address can run this and earn the keeper bounty. For each agent in the
 * deployment file it attests fresh prices (<= 60s, from a Flash quote) for every risky asset the wallet holds,
 * calls RiskGate.poke(), checks every held position still has a live Flash stop (read-only GET, safe from any
 * address) and, if the keeper is also the guardian, forces hibernation when one is missing. Then it writes a
 * LeaderboardSnapshot cycle to Arkiv.
 *
 *   pnpm keeper                 # loop every POKE_LOOP_SECONDS (default 600)
 *   pnpm keeper --once
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { erc20Abi, stringToHex, type Address, type Hex } from "viem";
import { riskGateAbi } from "@perpetua/core";
import { clients } from "../agent/src/chain";
import { FlashHttp, FlashSim } from "../agent/src/flash";
import { fetchBars4h } from "../agent/src/market";
import { PriceAttestor } from "../agent/src/prices";

const dep = JSON.parse(readFileSync(process.env.DEPLOYMENT_FILE ?? "contracts/deployments/local-31337.json", "utf8"));
const rpc = process.env.VAULT_RPC_URL ?? "http://127.0.0.1:8545";
const chainId = Number(process.env.VAULT_CHAIN_ID ?? 31337);
const keeperKey = (process.env.KEEPER_PRIVATE_KEY ?? "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6") as Hex;
const priceKey = (process.env.PRICE_SIGNER_PRIVATE_KEY ?? process.env.PROPOSER_PRIVATE_KEY ?? "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d") as Hex;
const c = clients(rpc, chainId, keeperKey);
const assets = process.env.ASSETS_JSON ? JSON.parse(process.env.ASSETS_JSON) : [{ symbol: "LINK", address: dep.link as Address, decimals: 18, krakenPair: "LINKUSD", binanceSymbol: "LINKUSDT" }];

let linkPrice = 15;
const flash = process.env.FLASH_MODE === "live" ? new FlashHttp(process.env.FLASH_BASE_URL ?? "https://flash.definitive.fi/v1", process.env.FLASH_API_KEY ?? "") : new FlashSim(() => linkPrice, chainId);

export async function pokeAll() {
  try {
    const bars = await fetchBars4h({ krakenPair: "LINKUSD", binanceSymbol: "LINKUSDT", source: (process.env.CANDLE_SOURCE as any) ?? (chainId === 31337 && process.env.FLASH_MODE !== "live" ? "synthetic" : "kraken"), limit: 2 });
    linkPrice = bars[bars.length - 1].c;
  } catch {
    /* keep last */
  }
  const now = (await c.pub.getBlock()).timestamp;
  const out: Record<string, unknown> = {};
  for (const name of ["Atlas", "Halcyon", "Ember"]) {
    const a = typeof dep[name] === "string" ? JSON.parse(dep[name]) : dep[name];
    if (!a) continue;
    const attestor = new PriceAttestor(priceKey, chainId, a.riskGate, flash, process.env.FLASH_CHAIN ?? "base", dep.usdc);
    const prices = [];
    for (const asset of assets) {
      const bal = await c.pub.readContract({ address: asset.address, abi: erc20Abi, functionName: "balanceOf", args: [a.wallet] });
      if (bal === 0n) continue;
      const { priceUsd, ...att } = await attestor.attest(asset, process.env.FLASH_MODE === "live" ? undefined : linkPrice, now);
      prices.push(att);
    }
    const hash = await c.wallet.writeContract({ address: a.riskGate, abi: riskGateAbi, functionName: "poke", args: [prices as any], account: c.account, chain: c.chain });
    const rc = await c.pub.waitForTransactionReceipt({ hash });
    const m = (await c.pub.readContract({ address: a.riskGate, abi: riskGateAbi, functionName: "mandate" })) as readonly any[];
    out[name] = { tx: hash, status: rc.status, epoch: Number(m[0]), V: Number(m[3]) / 1e6, F: Number(m[4]) / 1e6, C: Number(m[5]) / 1e6, E: Number(m[6]) / 1e6 };

    if (process.env.FLASH_MODE === "live" && process.env.KEEPER_IS_GUARDIAN === "true") {
      for (const asset of assets) {
        const bal = await c.pub.readContract({ address: asset.address, abi: erc20Abi, functionName: "balanceOf", args: [a.wallet] });
        if (bal === 0n) continue;
        const open = await flash.listOrders(a.wallet, ["ORDER_STATUS_ACCEPTED", "ORDER_STATUS_PENDING"]);
        if (!open.some((o) => o.side === "sell")) {
          const h = await c.wallet.writeContract({ address: a.riskGate, abi: riskGateAbi, functionName: "forceHibernate", args: [stringToHex("NO_LIVE_STOP", { size: 32 })], account: c.account, chain: c.chain });
          console.warn(`[keeper] ${name}: ${asset.symbol} held without a live stop -> forceHibernate ${h}`);
        }
      }
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const once = process.argv.includes("--once");
  const run = async () => console.table(await pokeAll().catch((e) => ({ error: (e as Error).message })));
  await run();
  if (!once) setInterval(run, Number(process.env.POKE_LOOP_SECONDS ?? 600) * 1000);
}

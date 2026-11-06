import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Address, Hex } from "viem";
import type { StrategyKind, StrategyConfig } from "@perpetua/core";

export interface AssetCfg {
  symbol: string; // LINK | ETH | cbBTC
  address: Address;
  decimals: number;
  krakenPair: string;
  binanceSymbol: string;
}

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);
process.env.PERPETUA_STATE_DIR ??= resolve(repoRoot, ".perpetua");

export function loadDeployment(): any {
  const file = process.env.DEPLOYMENT_FILE ?? `${repoRoot}/contracts/deployments/local-31337.json`;
  if (!existsSync(file)) throw new Error(`deployment file not found: ${file} (run the deploy script first)`);
  return JSON.parse(readFileSync(file, "utf8"));
}

export function loadConfig() {
  const dep = loadDeployment();
  const agentName = env("AGENT_NAME", "Atlas");
  const a = typeof dep[agentName] === "string" ? JSON.parse(dep[agentName]) : dep[agentName];
  if (!a) throw new Error(`agent ${agentName} not in deployment file`);
  const strategy: StrategyKind = (process.env.AGENT_STRATEGY as StrategyKind) ??
    ({ Atlas: "momentum", Halcyon: "mean-reversion", Ember: "dca" } as Record<string, StrategyKind>)[agentName] ??
    "momentum";
  if (!["momentum", "mean-reversion", "dca"].includes(strategy)) throw new Error("Unsupported spot strategy");
  if (process.env.FLASH_MODE === "live" && process.env.CANDLE_SOURCE === "synthetic") throw new Error("Synthetic market data cannot be used for live trading");

  const assets: AssetCfg[] = process.env.ASSETS_JSON
    ? JSON.parse(process.env.ASSETS_JSON)
    : [{ symbol: "LINK", address: dep.link, decimals: 18, krakenPair: "LINKUSD", binanceSymbol: "LINKUSDT" }];

  return {
    repoRoot,
    agentName,
    strategy,
    strategyConfig: undefined as StrategyConfig | undefined,
    agentId: a.agentId as Hex,
    vault: a.vault as Address,
    wallet: a.wallet as Address,
    riskGate: a.riskGate as Address,
    usdc: dep.usdc as Address,
    registry: dep.registry as Address,
    computeTreasury: dep.computeTreasury as Address,
    ccipRouter: dep.ccipRouter as Address,
    assets,

    vaultRpc: env("VAULT_RPC_URL", "http://127.0.0.1:8545"),
    vaultChainId: Number(env("VAULT_CHAIN_ID", "31337")),
    treasuryRpc: env("TREASURY_RPC_URL", process.env.VAULT_RPC_URL ?? "http://127.0.0.1:8545"),
    treasuryChainId: Number(env("TREASURY_CHAIN_ID", process.env.VAULT_CHAIN_ID ?? "31337")),

    proposerKey: env("PROPOSER_PRIVATE_KEY") as Hex,
    priceSignerKey: (process.env.PRICE_SIGNER_PRIVATE_KEY ?? process.env.PROPOSER_PRIVATE_KEY) as Hex,
    keeperKey: (process.env.KEEPER_PRIVATE_KEY ?? process.env.PROPOSER_PRIVATE_KEY) as Hex,

    flash: {
      mode: env("FLASH_MODE", "sim") as "live" | "sim",
      baseUrl: env("FLASH_BASE_URL", "https://flash.definitive.fi/v1"),
      apiKey: process.env.FLASH_API_KEY ?? "",
      chain: env("FLASH_CHAIN", "base"),
      integratorFeeBps: env("FLASH_INTEGRATOR_FEE_BPS", "20"),
      attributionCode: process.env.FLASH_ERC8021_CODE,
    },

    zeroG: {
      mode: env("ZG_MODE", "sim") as "live" | "sim" | "router",
      apiKey: process.env.ZG_API_KEY ?? "",
      baseUrl: env("ZG_BASE_URL", "https://router-api.0g.ai/v1"),
      modelSmall: env("ZG_MODEL_SMALL", "0gm-1.0-35b-a3b"),
      modelLarge: env("ZG_MODEL_LARGE", "glm-5.2"),
      rpc: env("ZG_RPC_URL", "https://evmrpc-testnet.0g.ai"),
      privateKey: (process.env.ZG_PRIVATE_KEY ?? process.env.PROPOSER_PRIVATE_KEY) as Hex,
      providerLarge: process.env.ZG_PROVIDER_LARGE ?? "",
      providerSmall: process.env.ZG_PROVIDER_SMALL ?? "",
      subAccountTopUpOg: Number(env("ZG_SUBACCOUNT_TOPUP_OG", "1")),
      reserveOg: Number(env("ZG_RESERVE_OG", "2")),
      minLedgerOg: Number(env("ZG_MIN_LEDGER_OG", "3")),
      costPerCallUsd: { large: Number(env("ZG_COST_LARGE_USD", "0.01")), small: Number(env("ZG_COST_SMALL_USD", "0.003")) },
      ogPriceUsd: Number(env("OG_PRICE_USD", "0.5")),
      simStartOg: Number(env("ZG_SIM_START_OG", "12")),
      /** demo only (disclosed): multiplies the simulated burn so the ladder is visible on stage */
      burnAcceleration: Number(env("BURN_ACCELERATION", "1")),
      maxTokensPerHour: Number(env("MAX_TOKENS_PER_HOUR", "60000")),
      maxTokensPerDay: Number(env("MAX_TOKENS_PER_DAY", "600000")),
    },

    x: { userToken: process.env.X_USER_ACCESS_TOKEN ?? "", arenaUrl: env("ARENA_URL", "http://localhost:3000") },
    tickSeconds: Number(env("TICK_SECONDS", "60")),
    candleSource: env("CANDLE_SOURCE", "kraken") as "kraken" | "binance" | "synthetic",
  };
}

export type Config = ReturnType<typeof loadConfig>;

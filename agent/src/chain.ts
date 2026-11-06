import { createPublicClient, createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia, foundry } from "viem/chains";
import { projectTransport } from "@perpetua/arkiv";

export function chainFor(id: number, rpc: string) {
  if (id === base.id) return base;
  if (id === baseSepolia.id) return baseSepolia;
  if (id === foundry.id) return foundry;
  if (id === 16602 || id === 16601) {
    return defineChain({ id, name: "0G Galileo", nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  }
  return defineChain({ id, name: `chain-${id}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
}

export function clients(rpc: string, chainId: number, key: Hex) {
  const chain = chainFor(chainId, rpc);
  const account = privateKeyToAccount(key);
  return {
    account,
    chain,
    // Local anvil mines instantly; viem's 4s default polling would make every receipt wait for no reason.
    pub: createPublicClient({ chain, transport: projectTransport(chainId, rpc), ...(chainId === 31337 ? { pollingInterval: 50 } : {}) }),
    wallet: createWalletClient({ chain, transport: projectTransport(chainId, rpc), account, ...(chainId === 31337 ? { pollingInterval: 50 } : {}) }),
  };
}

export type Clients = ReturnType<typeof clients>;

import { createPublicClient, createWalletClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Arkiv clients on Rabdi (current testnet; note in friction.md: older docs/examples say "Sorbet").
 * Reads are free and permissionless; the access key only lifts the public endpoint's rate limit.
 */
export function arkivChain() {
  return rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? "" });
}

export function arkivPublic() {
  return createPublicClient({ chain: arkivChain(), transport: http() });
}

export function arkivWallet(privateKey?: Hex) {
  const pk = (privateKey ?? process.env.ARKIV_PRIVATE_KEY) as Hex | undefined;
  if (!pk) throw new Error("ARKIV_PRIVATE_KEY not set (the agent's / importer's own Arkiv wallet)");
  const account = privateKeyToAccount(pk);
  return { client: createWalletClient({ chain: arkivChain(), transport: http(), account }), account };
}

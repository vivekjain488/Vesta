import { hashTypedData, type Address, type Hex, type TypedDataDefinition } from "viem";

/** EIP-712 domain/type for RiskGate.PriceAttestation (must match RiskGate's EIP712("PerpetuaRiskGate","1")). */
export const priceAttestationTypes = {
  PriceAttestation: [
    { name: "asset", type: "address" },
    { name: "priceE8", type: "uint256" },
    { name: "timestamp", type: "uint64" },
  ],
} as const;

export function riskGateDomain(chainId: number, riskGate: Address) {
  return { name: "PerpetuaRiskGate", version: "1", chainId, verifyingContract: riskGate } as const;
}

export function priceAttestationTypedData(chainId: number, riskGate: Address, asset: Address, priceE8: bigint, timestamp: bigint) {
  return {
    domain: riskGateDomain(chainId, riskGate),
    types: priceAttestationTypes,
    primaryType: "PriceAttestation",
    message: { asset, priceE8, timestamp },
  } as const;
}

/**
 * Flash returns `evm.orderTypedData` as a JSON string ({domain, types, primaryType, message}). The digest
 * RiskGate approves (and AgentWallet's EIP-1271 check sees) is the standard EIP-712 hash of exactly that.
 */
export function parseFlashTypedData(json: string): TypedDataDefinition {
  const td = JSON.parse(json);
  if (td.types?.EIP712Domain) delete td.types.EIP712Domain; // viem derives the domain type itself
  return td as TypedDataDefinition;
}

export function flashDigest(json: string): Hex {
  return hashTypedData(parseFlashTypedData(json) as any);
}

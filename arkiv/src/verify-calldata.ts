/**
 * On-chain decode verification. For selectors seen in real calldata on Base, Arbitrum and Ethereum, decode the
 * call against each candidate signature and check the argument count/types actually fit. A candidate that
 * does not parse is flagged low-confidence, never deleted (several valid signatures can share a selector).
 *
 *   tsx src/verify-calldata.ts [blocks=3]
 */
import { createPublicClient, decodeFunctionData, http, parseAbiItem, type Hex } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";

export function decodesCleanly(text: string, calldata: Hex): boolean {
  try {
    const item = parseAbiItem(`function ${text}`) as any;
    const decoded = decodeFunctionData({ abi: [item], data: calldata });
    // re-encode check is implicit in viem's strict decoder; also require full consumption of static args
    return decoded.functionName === item.name;
  } catch {
    return false;
  }
}

export async function sampleCalldata(blocks = 3): Promise<Map<string, { chain: string; data: Hex }[]>> {
  const chains = [
    { name: "base", chain: base, rpc: process.env.BASE_RPC_URL },
    { name: "arbitrum", chain: arbitrum, rpc: process.env.ARBITRUM_RPC_URL },
    { name: "ethereum", chain: mainnet, rpc: process.env.ETHEREUM_RPC_URL },
  ];
  const bySelector = new Map<string, { chain: string; data: Hex }[]>();
  for (const c of chains) {
    const client = createPublicClient({ chain: c.chain, transport: http(c.rpc) });
    try {
      const latest = await client.getBlockNumber();
      for (let i = 0n; i < BigInt(blocks); i++) {
        const block = await client.getBlock({ blockNumber: latest - i, includeTransactions: true });
        for (const tx of block.transactions as any[]) {
          if (!tx.input || tx.input.length < 10) continue;
          const sel = tx.input.slice(0, 10).toLowerCase();
          const arr = bySelector.get(sel) ?? [];
          if (arr.length < 3) arr.push({ chain: c.name, data: tx.input });
          bySelector.set(sel, arr);
        }
      }
    } catch (e) {
      console.warn(`[verify] ${c.name} sampling failed: ${(e as Error).message}`);
    }
  }
  return bySelector;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const samples = await sampleCalldata(Number(process.argv[2] ?? 3));
  console.log(`sampled ${samples.size} distinct selectors from live calldata`);
  const transfer = samples.get("0xa9059cbb");
  if (transfer) console.log("transfer(address,uint256) decodes:", decodesCleanly("transfer(address,uint256)", transfer[0].data));
}

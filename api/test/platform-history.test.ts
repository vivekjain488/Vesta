import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Platform } from "../src/platform";

test("public chain history starts at deployment and respects RPC block limits", async () => {
  const platform = new Platform(".");
  const ranges: [bigint, bigint][] = [];
  Object.defineProperty(platform, "deployment", { value: () => ({ startBlock: 100 }) });
  Object.defineProperty(platform, "pub", { value: {
    getChainId: async () => 11155111,
    getBlockNumber: async () => 2601n,
    getContractEvents: async ({ fromBlock, toBlock }: any) => { ranges.push([fromBlock, toBlock]); return [{ blockNumber: fromBlock }]; },
  } });
  const events = await (platform as any).events("0x0000000000000000000000000000000000000001", []);
  assert.deepEqual(ranges, [[100n, 1099n], [1100n, 2099n], [2100n, 2601n]]);
  assert.equal(events.length, 3);
});

test("public history fails closed when its deployment block is unknown", async () => {
  const platform = new Platform(".");
  Object.defineProperty(platform, "deployment", { value: () => ({}) });
  Object.defineProperty(platform, "pub", { value: { getChainId: async () => 11155111 } });
  const previous = process.env.VAULT_DEPLOYMENT_START_BLOCK;
  delete process.env.VAULT_DEPLOYMENT_START_BLOCK;
  try { await assert.rejects((platform as any).events("0x0000000000000000000000000000000000000001", []), /requires a startBlock/); }
  finally { if (previous !== undefined) process.env.VAULT_DEPLOYMENT_START_BLOCK = previous; }
});

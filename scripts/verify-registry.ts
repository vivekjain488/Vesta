/** Live, read-only integration proof. Does not send transactions or require a wallet login. */
import "dotenv/config";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { registryHead, registryChains, registryChain, registryRpcs, projectRpc, resolveRegistryRpc } from "@perpetua/arkiv";
const head = await registryHead(), source = JSON.parse(readFileSync(".perpetua/registry-source-report.json", "utf8"));
assert.equal(head.chainCount, source.chains); assert.equal(head.rpcCount, source.rpcEntries); assert.equal(head.sourceCommit, source.sourceCommit);
const first = await registryChains({ limit: 2 }), second = await registryChains({ limit: 2, after: first.nextAfter!, snapshot: first.snapshot });
assert(first.rows.length === 2 && second.rows.length === 2); assert(second.rows.every((r) => r.chainId > first.nextAfter!));
assert.equal(new Set([...first.rows, ...second.rows].map((r) => r.chainId)).size, 4);
const eth = await registryChains({ namePrefix: "ethereum", networkType: "mainnet", limit: 10 });
assert(eth.rows.some((r) => r.chainId === 1));
const zg = await registryChain(16602), rpcs = await registryRpcs(16602, { transport: "https", requiresKey: false, eligible: true });
assert.equal(zg.chain.raw.chainId, 16602); assert(rpcs.rows.length > 0);
assert(rpcs.rows.every((r) => r.executionEligible && !r.requiresKey && r.transport === "https"));
const resolved = await resolveRegistryRpc(16602, { fresh: true }); assert.equal(resolved.source, "arkiv");
const runtime = await projectRpc(16602, "https://this-configured-url-must-not-be-used.invalid"); assert.equal(runtime.source, "arkiv"); assert.equal(runtime.endpoint, resolved.endpoint);
const base = process.env.LOCAL_PRODUCT_API_URL ?? "http://localhost:8787";
const response = await fetch(`${base}/registry/chains?chainId=16602`, { headers: { origin: "https://independent-reader.example" } });
assert.equal(response.status, 200); assert.equal(response.headers.get("access-control-allow-origin"), "*"); assert.equal((await response.json()).rows[0].chainId, 16602);
assert.equal((await fetch(`${base}/v1/dashboard`)).status, 401);
const apiResolved = await fetch(`${base}/registry/resolve/16602`); assert.equal(apiResolved.status, 200); assert.equal((await apiResolved.json()).source, "arkiv");
const evidence = { verifiedAt: new Date().toISOString(), network: "Rabdi", arkivChainId: 7794095, ...head, zeroG: resolved,
  checks: ["complete manifest and exact upstream counts", "stable numeric keyset pagination", "indexed case-insensitive name prefix and network classification", "separate RPC transport/access filters", "payload/index/hash integrity", "live 0G chain ID verification", "project runtime selects Arkiv instead of configured URL", "anonymous public API with cross-origin reads", "wallet dashboard still requires authentication"] };
writeFileSync("arkiv/registry-verification.json", JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence, null, 2));

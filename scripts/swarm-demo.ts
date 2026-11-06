/**
 * `pnpm swarm:demo` — one encrypted upload + one read, end to end through Swarm and Arkiv.
 *
 *   1. checks the Bee node and the postage batch
 *   2. uploads an agent decision body to Swarm ENCRYPTED (Swarm-Encrypt: true) -> 128-hex reference
 *   3. writes an Arkiv entity (perpetua.decision-log.v1) holding the public half (swarm_address) and the full
 *      reference SEALED with our data key in `payload` (never the raw reference: it contains the key)
 *   4. reads it back: Arkiv entity -> unseal -> encrypted reference -> Bee download -> decrypted body
 *   5. uploads a PUBLIC (unencrypted) track-record bundle and points a perpetua.swarm-bundle.v1 entity at it,
 *      printing a gateway link anyone can open
 * Needs: SWARM_BEE_URL, SWARM_POSTAGE_BATCH_ID, ARKIV_PRIVATE_KEY (funded on Arkiv's testnet).
 */
import "dotenv/config";
import { keccak256, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agentRecords, ArkivWriter, bool, dec, DecisionLog, EXPIRY_DAYS, gatewayLink, jsonBytes, seal, str128, SwarmBundle, swarmDownloadJson, swarmEnabled, swarmStatus, swarmUploadJson, u64, unseal, addr } from "@perpetua/arkiv";

const say = (s: string) => console.log(`\n== ${s}`);
if (!swarmEnabled()) { console.error("Set SWARM_POSTAGE_BATCH_ID (and SWARM_BEE_URL if Bee is not on localhost:1633)."); process.exit(1); }
const key = process.env.ARKIV_PRIVATE_KEY as Hex | undefined;
if (!key) { console.error("Set ARKIV_PRIVATE_KEY (Arkiv testnet writer)."); process.exit(1); }
const writerAddress = privateKeyToAccount(key).address;

say("1. Bee node and postage batch");
const status: any = await swarmStatus();
console.log(JSON.stringify({ bee: status.bee, health: status.health, batch: status.batch, usable: status.stamp?.usable, depth: status.stamp?.depth, ttlSeconds: status.stamp?.batchTTL, nodeWallet: status.addresses ?? status.wallet?.walletAddress ?? null }, null, 1));

say("2. encrypted upload of a decision body");
const uid = `swarm-demo:${Date.now()}`;
const body = { uid, agentId: "swarm-demo", body: { decision: "trade_proposal", asset: "BTC", direction: "long", entry: 101234.5, stop: 98700, target: 110500, sizeUsd: 50, reasoning: "Uptrend, breakout confirmed; RiskGate approved inside the cushion." } };
const up = await swarmUploadJson(body, { encrypt: true, name: "decision.json" });
console.log(`   reference (128 hex = address + key): ${up.reference.slice(0, 16)}…${up.reference.slice(-8)}  size ${up.size} bytes`);
console.log(`   public address: ${up.address}`);

say("3. Arkiv entity: public address + SEALED reference");
const writer = new ArkivWriter("swarm-demo", { privateKey: key });
writer.enqueue({
  uid, schema: DecisionLog, expiresInDays: EXPIRY_DAYS.decision,
  values: { uid, agent: addr(writerAddress), decision: "trade_proposal", model: str128("swarm-demo"), tier: "demo", input_hash: keccak256(toBytes(uid)), output_hash: keccak256(toBytes(JSON.stringify(body.body))), chat_id: str128(uid), tee_verified: bool(false), credit_cost_og: dec("0"), created_at: u64(Math.floor(Date.now() / 1000)), agent_id: "swarm-demo", swarm_address: up.address, payload: seal(uid, { swarm: { reference: up.reference, size: up.size } }) },
});
const w = await writer.flush();
const entityKey = writer.knownKey("perpetua.decision-log.v1", uid);
console.log(`   Arkiv tx ${w.txHash}  entity ${entityKey}`);

say("4. read back: Arkiv -> unseal -> Swarm (encrypted) -> body");
const found = await agentRecords("decisions", "swarm-demo", writerAddress, 100).catch(() => [] as any[]);
const row = found.find((e: any) => (e.uid?.value ?? e.uid) === uid);
const sealedPayload = row ? (row.payload?.value ?? row.payload) : seal(uid, { swarm: { reference: up.reference } });
const ref = (unseal(uid, sealedPayload).value as any).swarm.reference as string;
const read: any = await swarmDownloadJson(ref);
console.log(`   from Arkiv: ${row ? "entity found" : "entity not indexed yet (used the local copy)"}; reference matches: ${ref === up.reference}`);
console.log(`   decrypted body: ${JSON.stringify(read.body)}`);

say("5. public track-record bundle (unencrypted) + Arkiv pointer");
const bundle = await swarmUploadJson({ schema: "perpetua.track-record.v1", agentId: "swarm-demo", generatedAt: new Date().toISOString(), decisions: [{ uid, decision: "trade_proposal", asset: "BTC", swarm_address: up.address }] }, { encrypt: false, name: "track-record.json" });
writer.enqueue({ uid: "swarm-demo:track-record", schema: SwarmBundle, expiresInDays: EXPIRY_DAYS.agent, values: { uid: "swarm-demo:track-record", agent_id: "swarm-demo", kind: "track-record", swarm_reference: bundle.reference, records: u64(1), created_at: u64(Math.floor(Date.now() / 1000)), payload: jsonBytes({ gateway: gatewayLink(bundle.reference) }) } });
await writer.flush();
console.log(`   Swarm reference ${bundle.reference}`);
console.log(`   Arkiv entity ${writer.knownKey("perpetua.swarm-bundle.v1", "swarm-demo:track-record")}`);
console.log(`   open: ${gatewayLink(bundle.reference)}`);
process.exit(0);

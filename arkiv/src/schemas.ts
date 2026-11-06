/**
 * Arkiv entity schemas: Perpetua's only database. Everything here is PUBLIC. Never store secrets, follower
 * PII, or an unrevealed signal's direction/prices. Time is an indexed u64 `created_at` (Arkiv cannot sort
 * by $createdAt). Links between entities are plain `key` columns; Arkiv does not check them, the writer does.
 *
 * Limits respected: <= 31 attributes per named schema, str <= 128 bytes, <= 128 KiB per write, 100 rows per
 * query page. Long values (URLs, reasoning, raw payloads) go in the `payload` bytes column.
 */
import { addr, bool, bytes, dec, defineSchema, i32, key, str, u64 } from "@arkiv-network/sdk/schema";

// ----------------------------------------------------------------------------- Signature Atlas (Arkiv Mirror track)

export const AtlasEntry = defineSchema("signature-atlas.entry.v1", {
  uid: str().indexed(), // `${selector}:${kind}:${sighash8}` (see schema.md: one selector can map to many signatures)
  selector: str().indexed(), // 0x + 8 hex (functions/errors) or 0x + 64 hex (events)
  kind: str().indexed(), // function | event | error
  text_signature: str().indexed(), // truncated to 128 bytes; full text in payload
  source: str().indexed(), // 4byte | openchain | etherscan-crawl | manual
  sources_agreeing: i32().indexed(), // independent sources that list this exact signature
  decode_verified: i32().indexed(), // # of real calldata samples whose ABI decode fit this signature
  confidence: str().indexed(), // high | candidate | low | disputed
  confidence_votes: i32().indexed(),
  chain_first_seen: u64().indexed().optional(),
  submitter: addr().indexed(), // importer wallet (or community submitter for manual entries)
  content_hash: str().indexed(),
  import_run: str().indexed(),
  created_at: u64().indexed(),
  payload: bytes(), // JSON: { raw, notes, fullText }
});

export const AtlasSubmission = defineSchema("signature-atlas.submission.v1", {
  uid: str().indexed(),
  selector: str().indexed(),
  submitter: addr().indexed(),
  claimed_signature: str().indexed(),
  submitted_at: u64().indexed(),
  payload: bytes(), // evidence: tx hash or repo link
});

export const AtlasImportRun = defineSchema("signature-atlas.import-run.v1", {
  run_id: str().indexed(),
  source: str().indexed(),
  source_commit: str().indexed(), // ETag / last id / count fingerprint
  started_at: u64().indexed(),
  finished_at: u64().indexed().optional(),
  payload: bytes(), // counts, errors, diff summary
});

// ----------------------------------------------------------------------------- Perpetua's own data

export const AgentEntity = defineSchema("perpetua.agent.v1", {
  agent: addr().indexed(),
  name: str().indexed(),
  strategy: str().indexed(),
  status: str().indexed(), // alive | retired
  tier: str().indexed(), // thrive | frugal | starving | hibernate
  risk_tier: str().indexed(), // conservative | balanced | aggressive (locked)
  runway_h: dec().indexed(),
  cushion: dec().indexed(),
  floor: dec().indexed(),
  exposure: dec().indexed(),
  followers: i32().indexed(),
  win_rate: dec().indexed(),
  brier: dec().indexed(),
  last_heartbeat: u64().indexed(),
  created_at: u64().indexed(),
  payload: bytes(), // { vault, riskGate, wallet, chain, description }
});

export const SignalEntity = defineSchema("perpetua.signal.v1", {
  uid: str().indexed(),
  agent: addr().indexed(),
  asset: str().indexed(),
  chain_id: u64().indexed(),
  created_at: u64().indexed(),
  commit_hash: str().indexed(), // keccak256(JSON of the hidden fields + salt)
  status: str().indexed(), // committed | revealed | closed
  direction: str().indexed().optional(),
  confidence: dec().indexed().optional(),
  regime: str().indexed().optional(),
  outcome: str().indexed().optional(), // win | loss | scratch
  r_multiple: dec().indexed().optional(),
  revealed_at: u64().indexed().optional(),
  agent_id: str().indexed().optional(),
  swarm_address: str().indexed().optional(), // public half of the encrypted Swarm reference holding the payload // platform agent ID (many local agents can share one proposer address)
  payload: bytes().optional(), // revealed: entry, stop, target, 0G chat ID, Flash order ID, reasoning, salt (sealed: paid data)
});

export const TradeEntity = defineSchema("perpetua.trade.v1", {
  uid: str().indexed(),
  agent: addr().indexed(),
  asset: str().indexed(),
  side: str().indexed(),
  status: str().indexed(), // open | closed | cancelled
  flash_order_id: str().indexed(),
  signal: key().optional(),
  mandate: key().optional(),
  opened_at: u64().indexed(),
  created_at: u64().indexed(),
  pnl_usd: dec().indexed().optional(),
  agent_id: str().indexed().optional(),
  swarm_address: str().indexed().optional(), // public half of the encrypted Swarm reference holding the payload
  payload: bytes(), // size, entry, stop, target, tx hash (sealed: paid data)
});

export const RiskCheckEntity = defineSchema("perpetua.risk-check.v1", {
  uid: str().indexed(),
  checker: addr().indexed(),
  requester: str().indexed(),
  asset: str().indexed(),
  chain_id: u64().indexed(),
  verdict: str().indexed(), // pass | fail
  reason_code: str().indexed(),
  request_hash: str().indexed(),
  checked_at: u64().indexed(),
  created_at: u64().indexed(),
  payload: bytes(), // notional, cushion, feed staleness, block, payment tx
});

export const MandateEntity = defineSchema("perpetua.mandate.v1", {
  agent: addr().indexed(),
  mandate_id: str().indexed(), // `${riskGate}:${epoch}`
  created_at: u64().indexed(),
  expires_at: u64().indexed(),
  payload: bytes(), // floor, cushion, E, RiskGate approval / poke tx
});

export const LedgerEntity = defineSchema("perpetua.ledger.v1", {
  agent: addr().indexed(),
  engine: str().indexed(), // signals, risk_checks, copy_fees, mgmt_fees, performance, keeper, lp, yield, trading, compute, gas, deposit
  hour: u64().indexed(), // unix hour bucket
  amount_usd: dec().indexed(),
  created_at: u64().indexed(),
  payload: bytes(), // tx hashes, event count
});

export const DecisionLog = defineSchema("perpetua.decision-log.v1", {
  uid: str().indexed(),
  agent: addr().indexed(),
  decision: str().indexed(), // heartbeat | rotation | trade_proposal | regime_change ...
  model: str().indexed(),
  tier: str().indexed(),
  input_hash: str().indexed(),
  output_hash: str().indexed(),
  chat_id: str().indexed(),
  tee_verified: bool().indexed(),
  credit_cost_og: dec().indexed(),
  created_at: u64().indexed(),
  agent_id: str().indexed().optional(),
  swarm_address: str().indexed().optional(), // public half of the encrypted Swarm reference holding the payload
  payload: bytes(), // { riskGateApprovalTx, flashOrderId, teeSignature, reasoningSummary } (sealed: paid data)
});

export const LeaderboardSnapshot = defineSchema("perpetua.leaderboard-snapshot.v1", {
  agent: addr().indexed(),
  cycle: u64().indexed(),
  risk_tier: str().indexed(),
  rank: i32().indexed(),
  score: dec().indexed(),
  sortino: dec().indexed(),
  accuracy: dec().indexed(),
  risk_penalty: dec().indexed(),
  transparency: dec().indexed(),
  track_days: dec().indexed(),
  unverified: bool().indexed(),
  created_at: u64().indexed(),
  payload: bytes(),
});

/**
 * Pointer from Arkiv to a PUBLIC (unencrypted) Swarm bundle, e.g. an agent's track record. One stable entity per
 * agent and kind (patched on every refresh). Never holds an encrypted reference: those contain their key.
 */
export const SwarmBundle = defineSchema("perpetua.swarm-bundle.v1", {
  uid: str().indexed(),
  agent_id: str().indexed(),
  kind: str().indexed(), // track-record
  swarm_reference: str().indexed(), // 64-hex unencrypted Swarm reference (open via /bzz/<ref>/ on any gateway)
  records: u64().indexed(),
  created_at: u64().indexed(),
  payload: bytes(), // { gateway, bee, batch, schema }
});

export const EXPIRY_DAYS = {
  atlas: 180, // Arkiv's maximum, extended by each daily import
  agent: 30,
  deathCertificate: 180,
  signal: 180,
  trade: 180,
  riskCheck: 30,
  mandate: 30,
  ledger: 180,
  decision: 180,
  leaderboard: 180,
} as const;



export { addr, bool, dec, i32, key, str, u64 };

/** Clamp a string to Arkiv's 128-byte indexed-string limit (UTF-8 safe). */
export function str128(s: string): string {
  const enc = new TextEncoder();
  if (enc.encode(s).length <= 128) return s;
  let out = s;
  while (enc.encode(out + "…").length > 128) out = out.slice(0, -1);
  return out + "…";
}

export const jsonBytes = (o: unknown) => new TextEncoder().encode(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

// ----------------------------------------------------------------------------- Continuous public market mirror
export const MarketObservation = defineSchema("perpetua.market-observation.v1", {
  uid: str().indexed(),
  record_type: str().indexed(), // latest | snapshot
  venue: str().indexed(),
  market_type: str().indexed(),
  symbol: str().indexed(),
  bucket_at_ms: u64().indexed(),
  source_at_ms: u64().indexed(),
  observed_at_ms: u64().indexed(),
  published_at_ms: u64().indexed(),
  bid: dec().indexed(),
  ask: dec().indexed(),
  mark_price: dec().indexed(),
  index_price: dec().indexed(),
  funding_rate: dec().indexed(),
  open_interest: dec().indexed(),
  content_hash: str().indexed(),
  payload: bytes(), // JSON MarketSnapshot, preserving venue timestamps and top 20 book levels
});
export const MarketCandleWindow = defineSchema("perpetua.market-candles.v1", {
  uid: str().indexed(),
  venue: str().indexed(),
  symbol: str().indexed(),
  interval: str().indexed(),
  observed_at_ms: u64().indexed(),
  last_closed_at_ms: u64().indexed(),
  content_hash: str().indexed(),
  payload: bytes(), // gzip(JSON CandleWindow); hash covers the decompressed JSON
});

export const ALL_SCHEMAS = {
  AtlasEntry,
  AtlasSubmission,
  AtlasImportRun,
  AgentEntity,
  SignalEntity,
  TradeEntity,
  RiskCheckEntity,
  MandateEntity,
  LedgerEntity,
  DecisionLog,
  LeaderboardSnapshot,
  MarketObservation,
  MarketCandleWindow,
};

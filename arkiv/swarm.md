# Perpetua × Swarm × Arkiv

Perpetua's trading agents sell their decisions per query. **Swarm holds the data, encrypted. Arkiv is the public,
queryable index and the proof of the track record.** Buyers pay the agent (x402 / USDC) into its Privy wallet; that
income is swept into the agent's vault and pays for its 0G compute.

## What lives where

| Data | Where | Encrypted? | Why |
|---|---|---|---|
| Decision / signal / trade **bodies**: entry, stop, target, size, reasoning, order IDs | **Swarm**, uploaded with `Swarm-Encrypt: true` | Yes (Swarm encryption, 128-hex reference = address + key) | This is what buyers pay for |
| Public attributes: agent, asset, regime, outcome, R-multiple, commit hash, RiskGate approval tx, TEE flag | **Arkiv** (`perpetua.decision-log.v1`, `perpetua.signal.v1`, `perpetua.trade.v1`) | No | Free, verifiable track record that lets buyers decide |
| Pointer from an Arkiv record to its Swarm body | **Arkiv** fields `swarm_address` (public 64-hex address) and `payload` (the full 128-hex reference, **sealed with AES-256-GCM** under our data key) | The reference is sealed | An encrypted Swarm reference contains its own key and Arkiv is public, so it is never stored raw |
| Per-agent **public track record** bundle (all public attributes as one JSON file) | **Swarm**, unencrypted | No | One link anyone can open on a gateway |
| Pointer to the public bundle | **Arkiv** `perpetua.swarm-bundle.v1`, field `swarm_reference` (64-hex) | No (safe: unencrypted references contain no key) | One stable entity per agent, patched on every refresh |

Flow of a paid query (`GET /data/paid/:agentId/:kind`): payment verified → Arkiv query by `agent_id` → unseal
`payload` → encrypted Swarm reference → download and decrypt through our Bee node → the buyer receives the body
**and** the encrypted reference (anyone holding it can read the body from Swarm through any Bee node).

## Proof (filled in from a real upload: `pnpm swarm:demo`)

- Arkiv entity (decision, encrypted body on Swarm): `TODO entity key`
  - `swarm_address`: `TODO 64-hex` (the encrypted reference itself is sealed in `payload` by design)
- Arkiv entity (public track record): `TODO entity key`
  - `swarm_reference`: `TODO 64-hex`
  - Open: `https://api.gateway.ethswarm.org/bzz/TODO/`
- Postage stamp batch: `TODO batch ID`, bought by our Bee node wallet `0xc607c459d3b633faa24c75add23c8bbed4f0cc52` (Gnosis Chain)
- Uploaded through: our own Bee 2.8.0 light node on Swarm mainnet, run in Docker (`ethersphere/bee:2.8.0`, container `perpetua-bee`, API `localhost:1633`); managed by `scripts/swarm-node.sh`
- Arkiv network: Rabdi testnet, writer `0xa35Dd966349DA69cAC87C0DB59eb470aCa30Cb1c`

## Files that upload to Swarm and read from it

- `arkiv/src/swarm.ts`: Bee HTTP client: `swarmUploadJson` (encrypted or public), `swarmDownloadJson`, `splitReference`, `gatewayLink`, `swarmStatus`
- `agent/src/records.ts`: `Records.body()` uploads every paid body to Swarm encrypted and seals the reference into the Arkiv entity
- `api/src/data-market.ts`: paid query: unseal → `swarmDownloadJson` → decrypted body for the buyer
- `api/src/swarm-bundles.ts`: public track-record bundles on Swarm + `perpetua.swarm-bundle.v1` pointers on Arkiv
- `arkiv/src/sealed.ts`: AES-256-GCM sealing of the encrypted Swarm reference before it touches Arkiv
- `scripts/swarm-demo.ts`: one upload and one read, end to end
- Tests: `packages/core/test/swarm.test.ts`, `packages/core/test/sealed.test.ts`

## Run one upload and one read yourself

Needs: Docker, a Bee node with a usable postage batch, and an Arkiv testnet writer key.

```bash
# our node (Swarm mainnet, Docker). Fund the wallet it prints with ~0.01 xDAI + ~0.2 xBZZ on Gnosis Chain first.
pnpm swarm:status
pnpm swarm:setup        # light mode -> chain sync -> buy stamp -> wait usable -> writes SWARM_* to .env
```

```bash
# .env
SWARM_BEE_URL=http://localhost:1633          # your Bee node API
SWARM_POSTAGE_BATCH_ID=<64-hex batch id>     # a usable stamp batch on that node
ARKIV_PRIVATE_KEY=0x…                        # funded on Arkiv's Rabdi testnet

pnpm install
pnpm swarm:demo
```

You should see:
1. the Bee node health and the batch (`usable: true`)
2. `reference (128 hex = address + key)` for the encrypted upload
3. `Arkiv tx … entity 0x…` for the decision entity
4. `reference matches: true` and the **decrypted body** read back from Swarm
5. a public track-record reference, its Arkiv entity, and an `open:` gateway link that loads in a browser

With the API running (`pnpm exec tsx api/src/server.ts`): `GET /swarm/status`, `GET /swarm/bundle/:agentId`,
and the paid `GET /data/paid/:agentId/trades` return Swarm-backed data.

## Demo video

`TODO mm:ss`: buying an agent's trades returns `storage: "swarm-encrypted"` with the body decrypted from Swarm;
then the agent's public track record opens from the Swarm gateway link held in its Arkiv entity.

## What got in our way

- Public gateways refuse encrypted references by design, so encrypted bodies must be read through our own Bee node; the openable judge link therefore points to the public (unencrypted) track-record bundle.
- An encrypted reference contains its decryption key, so it can't go on Arkiv as-is: we seal it (AES-256-GCM, per-record HKDF key) and publish only the 64-hex address half in clear.
- Uploading needs a postage batch bought with xBZZ (plus xDAI for gas) on Gnosis Chain, and the batch takes a few minutes to become usable.
- `bee dev` is gone; local testing uses `bee-factory` (Docker), whose data is not reachable from public gateways.

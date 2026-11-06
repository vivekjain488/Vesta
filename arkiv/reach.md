# Reach: Ethereum chain and RPC registry

The mirror's primary dataset is [ethereum-lists/chains](https://github.com/ethereum-lists/chains), also distributed through [chainid.network](https://chainid.network/chains.json). The pinned initial revision contains **2,855 chain definitions and 4,220 RPC strings**, normalized to **4,219 distinct chain/URL pairs**. Counts are computed from every `_data/chains/eip155-*.json` file, not a hand-picked chain list.

The repository's own [consumer list](https://github.com/ethereum-lists/chains#usages) names Trezor, WallETH, Minerva Wallet, Otterscan, Chainlist, Chainlink docs, dRPC Chainlist and other registries/tooling. These are upstream examples of dependence, not claimed users of our new mirror. [Ethereum.org's infrastructure directory](https://ethereum.org/developers/tools/categories/network-infrastructure/) describes it as canonical EVM chain metadata used for wallet and network configuration. The upstream GitHub API reported **9,834 stars and 8,232 forks** when checked on 6 November 2026: [reproduce repository statistics](https://api.github.com/repos/ethereum-lists/chains). Stars/forks are interest indicators, not a count of active users or secured funds.

## Who would use the Arkiv copy after Mumbai?

* Wallet/network-picker builders: query chain IDs, names, native currencies and available endpoints without downloading and filtering the full GitHub corpus.
* Multi-chain applications and agent frameworks: find public HTTPS endpoints for a specific chain, then verify identity before connecting.
* Infrastructure monitors: find all chains missing an eligible public HTTPS endpoint, discover deprecated entries, or compare successive complete snapshots.
* Registry maintainers: publish independent mirrors with their own writer identity, compare hashes/provenance, and audit what changed against a pinned Git revision.

VESTA is an actual consumer: remote chain clients, API chain reads, the direct 0G brain and 0G testnet setup use `projectRpc` / `projectTransport`, querying the Arkiv mirror rather than calling the upstream registry. Its signed-in **Chain registry** table reads public Arkiv-backed API routes. Blockchain RPC discovery is separate from 0G's model-serving API.

```sh
pnpm registry:query chain 16602
pnpm registry:query resolve 16602
curl 'http://localhost:8787/registry/rpcs/16602?transport=https&requiresKey=false&eligible=true'
```

The data can be read directly from Rabdi with the public writer address in README, even when our server is offline. The new mirror has no measured third-party adoption yet; the reach evidence describes the existing upstream dataset. Its current deployment is a testnet mirror with finite retention and a local daily refresh scheduler.

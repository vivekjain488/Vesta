# Reach

## The data
4byte.directory lists 1,186,235 function signatures and 278,705 event signatures. Those counts came from `GET /api/v1/signatures/` and `/api/v1/event-signatures/` on 2026-11-05.

Every wallet, explorer and decoder has to turn a 4-byte selector back into a readable signature. A hash can't be reversed, only looked up.

The ecosystem leans on a handful of single-maintainer services for this:
- **Etherface** (7.9M signatures) was sunset by its maintainer and folded into Sourcify.
- **4byte.directory** has no redundancy.
- **OpenChain**'s bulk export has disappeared (see friction.md #10).

## TVS / GitHub
TODO: fill in before submission.
- Total value secured by contracts whose calldata the Atlas decodes: count the distinct selectors in the hot set across Base/Arbitrum/Ethereum blocks, from `import-run` payloads.
- Stars and dependents of the 4byte consumers listed below.

## Who would use this after the hackathon
- **Wallet teams:** transaction-preview decoding with a confidence score, not a single unaccountable guess.
- **Block-explorer teams:** a second, independently sourced signature corpus with a provenance trail.
- **Security and decoder tools:** "is this the selector I think it is?" checks, with a `disputed` flag when several signatures share a selector.
- **Agent frameworks** that parse calldata themselves. Perpetua's risk-check service already does: an agent paying $0.005 gets the counterparty call decoded through the Atlas.

## How Perpetua itself depends on it
- The x402 `/v1/risk-check` decodes counterparty calldata through the Atlas.
- The Arena has a public Atlas explorer at `/atlas`.
- RiskGate's off-chain tooling reads it over Arkiv JSON-RPC. RiskGate's on-chain math never does.

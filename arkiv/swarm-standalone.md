# Swarm storage

The Bee HTTP client supports JSON uploads and downloads, encrypted references, and Bee diagnostics.

To demonstrate a real upload, run a Bee node with a usable postage batch and set `SWARM_BEE_URL` (default `http://localhost:1633`) and `SWARM_POSTAGE_BATCH_ID` in the environment or `.env`. Optionally set `SWARM_GATEWAY_URL` for public links.

```sh
pnpm exec tsx scripts/swarm-standalone.ts status
pnpm exec tsx scripts/swarm-standalone.ts demo
```

The demo uploads a small public sample, reads it back from Bee, and prints its gateway link. It requires a working Bee node and postage batch; a gateway may take time to retrieve the uploaded content. The client also supports encrypted uploads, whose full 128-character reference contains the decryption key and must be kept private.

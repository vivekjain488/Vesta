# Continuous market mirror on Arkiv

The `market` service collects live public Binance USDⓈ-M futures data and publishes a shared, queryable copy to Arkiv Rabdi. It runs independently of browser sessions and AI calls. The default universe is **BTCUSDT, ETHUSDT and LINKUSDT**. This is a sampled market mirror: it preserves the top 20 book levels and periodic observations, rather than every trade or a full depth-update tape.

## Data and timing

- Collect a fresh depth snapshot, mark/index prices, funding rate/next funding time and open interest every **5 seconds**.
- Queue a latest-state update and a historical observation every **15 seconds**. Confirmation adds chain/RPC latency; this is a target cadence, not a maximum-latency guarantee.
- Refresh **400 closed 4-hour candles** every **60 seconds**. In-progress candles are excluded; missing/invalid bars are rejected rather than synthesized.
- Retain sampled history for **7 days** by default. Latest-state and candle entities have a one-day lifetime, renewed while the service is running.

Prices/quantities remain decimal strings in snapshot payloads. Each observation includes venue, market type, symbol, upstream endpoints, exchange event times, local observation time and publication time. Funding is the venue's raw reported rate; no fixed funding interval is inferred. Quotes are denominated in USDT. Stored candles use the numeric OHLCV representation required by the strategy engine.

Sources: Binance's public `/fapi/v1/premiumIndex`, `/fapi/v1/depth`, `/fapi/v1/openInterest` and `/fapi/v1/klines` endpoints. No exchange API key is required. This off-chain feed complements the Ethereum Signature Atlas; the Atlas remains the separate public Ethereum-data mirror.

## Running and supervision

From the repository root:

```sh
pnpm market                            # foreground continuous process
pnpm market --once                     # one collection + confirmed publication cycle
pnpm market:query BTCUSDT               # fresh latest quote read from Arkiv
pnpm market:query BTCUSDT candles       # closed-candle window read from Arkiv
pnpm market:query BTCUSDT history       # recent retained samples read from Arkiv
pnpm market:service install             # macOS: start at login and restart after crashes
pnpm market:service status
pnpm market:service stop
pnpm market:service start
```

The installed macOS LaunchAgent is `network.perpetua.market-mirror`. Its plist contains paths and process options; credentials are loaded from the ignored root `.env`. Logs are in `.perpetua/logs/market.stdout.log` and `market.stderr.log`. The supervisor restarts the service after failures and user login. It runs while this Mac is awake and connected; an always-on server is needed for uptime while the Mac is asleep/offline. On another host, supervise `pnpm market` with that host's service manager and retain the state directory on persistent storage. Run only one publisher per writer/state directory.

Configuration:

```dotenv
ARKIV_ACCESS_KEY=...
ARKIV_MARKET_PRIVATE_KEY=...
ARKIV_MARKET_WRITER_ADDRESS=...
ARKIV_MARKET_SYMBOLS=BTCUSDT,ETHUSDT,LINKUSDT
ARKIV_MARKET_POLL_SECONDS=5
ARKIV_MARKET_PUBLISH_SECONDS=15
ARKIV_MARKET_CANDLE_SECONDS=60
ARKIV_MARKET_RETENTION_DAYS=7
ARKIV_MARKET_MAX_PENDING=600
```

The current dedicated testnet writer is `0xEA3060Dba8B22A3aCBFa11f02F24B901910CBb2c`. It was funded from the existing project's funded Arkiv wallet; the market service has its own signing key and nonce stream. The Signature Atlas importer remains separate. Publication pauses below **0.01 tGLM**; ingest continues into the bounded queue. Add Rabdi gas to the market writer to resume writes.

## Recovery and freshness

Pending data and publication receipts persist in `.perpetua/market-writer.json`. A captured broadcast transaction is reconciled before another write is sent. Natural UIDs are checked against writer-owned Arkiv rows after restart. Latest-state and candle writes coalesce; historical samples have stable sampling-bucket IDs. Historical records are not overwritten on retry. A new observation arriving while an older latest-state write is pending is retained for the next publication.

Requests are batched with payload headroom and fall back to smaller batches on size errors. Source failures use per-symbol backoff; writer failures back off separately. The queue is bounded. During a long outage the oldest unsent history is dropped and counted, while latest-state/candle updates are preserved. This is visible loss/gap reporting, not a claim to recover every tick. Mutable entity keys and recent receipts remain small; history is rediscovered by UID when needed.

Latest-state reads filter the configured writer, verify payload hashes, and reject any quote component older than **45 seconds** or implausibly in the future. Source failures do not advance source timestamps. Candle reads require the most recent closed 4h interval. The service health file lists component errors, last source/observation times, pending writes, dropped history count, gas balance and recent transaction hashes.

## Consumers

The authenticated application API exposes:

- `GET /v1/market/status`
- `GET /v1/market/BTCUSDT`
- `GET /v1/market/BTCUSDT/candles?limit=400`
- `GET /v1/market/BTCUSDT/history?limit=50&beforeMs=<cursor>`

Quote/candle/history responses are read from **Arkiv**, not the diagnostic disk cache. Public on-chain readers can query the same owner-filtered schemas without an app session. `latestMarket`, `marketCandles` and `marketHistory` are exported from `@perpetua/arkiv` for trusted backend knowledge tools.

`CANDLE_SOURCE=arkiv` makes the existing agent candle loader use this mirror. If the mirror is unavailable or missing the last closed candle, that path fails closed; it never substitutes synthetic candles. The current local execution environment keeps its explicit synthetic source so mock settlement prices stay consistent. Mirrored futures candles are market knowledge, not a Flash spot-execution quote or a venue-derived futures margin authorization. Fresh venue quotes and account checks remain necessary after AI reasoning.

## Verification

Live read/write evidence is stored in `.perpetua/market-live-verification.json`; setup funding evidence is in `market-setup.json`. Tests in `packages/core/test/market-mirror.test.ts` cover stale/future/crossed quotes, closed candles and payload integrity, bounded recovery, failed writes, updates arriving during publication, receipt reconciliation, and low-gas behavior.

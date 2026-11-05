# Perpetual futures strategy research

Research date: 2026-11-06. This is a paper-trading research plan, not evidence that any strategy is profitable. The parameters below are starting hypotheses, not optimized settings or safety guarantees. Venue rules, available markets, fees and legal access must be checked before use.

## Fit for the existing system

The existing Flash path is a **spot token-swap** integration. `packages/core/src/strategy.ts` generates long/flat signals, and `contracts/src/RiskGate.sol` treats entries as stable-to-risky swaps and exits as risky-to-stable swaps. A sell is not an opening perpetual short. The current wallet and cushion limit do not account for derivative notional, margin, unrealized PnL, funding, borrowing, liquidation or auto-deleveraging. Do not route these futures templates through the existing Flash order path as if that created leveraged positions.

The existing `scripts/backtest.ts` is useful for a spot rules baseline but uses 4-hour candles, a next-bar-open fill, an assumed fixed round-trip cost and OHLC-based bracket exits. It does not establish a futures edge or simulate the stated 20–30 second observation-to-execution delay, intrabar executable prices, funding, liquidation, partial fills or venue-specific order mechanics. Its trade-based NAV approximation is not a full shared-portfolio simulation. In addition, `RiskGate.sol` documents a digest-to-intent binding limitation when `orderHasher` is unset; that must be resolved before relying on this path for real funds. Its current spot protection is not a substitute for a perpetual-specific risk gate.

## Strategy candidates

Start with liquid BTC and ETH linear, stablecoin-margined contracts from a single specified venue, with point-in-time data and accessible historical fills or quotes. All signals use **completed** candles and decisions are made only after the candle is actually available. Treat the following as separate experiments; do not combine them into a composite until their standalone results and correlations are understood.

### 1. Four-hour trend following: first candidate

- At each completed 4-hour close, go long if the close breaks the high of the previous 20 completed candles and is above the 200-candle EMA. The candidate short is symmetric: break the prior 20-candle low while below the EMA. The current candle must be excluded from the channel.
- Exit a long on a close below the previous 10-candle low; reverse the rule for a short. Also place a protective venue-supported stop initially about 2 four-hour ATRs away, subject to the sizing and liquidation checks below. Do not assume this stop's execution price is guaranteed. Evaluate a maximum holding time such as seven days as a separate test, not an optimized default.
- Reevaluate at most once per completed bar unless the independent risk system needs to reduce exposure. Do not open a new position if the move has already invalidated the trade after inference.

A 30-second delay is only 0.21% of a four-hour bar, so this horizon is a reasonable *candidate* for delayed execution. That ratio says nothing about the actual price move during those 30 seconds; replay must measure it. Research on cryptocurrency returns identifies time-series momentum at historical weekly horizons, but it does not validate this particular four-hour rule or a current net edge ([Liu and Tsyvinski, *Risks and Returns of Cryptocurrency*](https://www.nber.org/papers/w24877.pdf)).

### 2. Spot–perpetual funding carry: separate two-leg experiment

When forecast funding is positive, consider buying spot and shorting the same underlying's linear perpetual in roughly equal dollar notional. Forecast **net** carry over a multi-day expected holding period must exceed both legs' entry and exit costs, slippage and impact, any funding paid, spot financing or borrow costs, and a model-risk buffer. Exit or reduce the hedge when forecast net carry falls below the exit-cost threshold, hedge imbalance exceeds its limit, or either venue's risk or liquidity deteriorates. Use a funding forecast based only on information available at the decision time; do not annualize one displayed rate as if it were guaranteed.

This requires spot and perpetual adapters, hedge-ratio and fill reconciliation, pre-funded collateral, monitoring of both legs, and a procedure for failed or partial hedges. A delta-neutral starting position still has funding reversal, basis, liquidation, execution, stablecoin and venue risks. Perpetuals have no expiry and do not have guaranteed spot convergence; their funding and basis must be modeled together ([He et al., *Fundamentals of Perpetual Futures*](https://arxiv.org/abs/2212.06888)). This candidate is not implemented by the existing spot engine.

### 3. Four-hour range reversion: lower-priority hypothesis

In a separately defined range regime, test a long after a completed close below a 20-candle lower volatility band with RSI(14) below 30, targeting a return toward the 20-candle midpoint; test the symmetric short above the upper band with RSI above 70. Exit on a protective stop, midpoint, regime change or a predeclared time limit. A 2-standard-deviation band and a 12-bar maximum holding time are initial research settings, not evidence of a profitable trade. Test how often directional breakouts persist after a range signal and whether costs erase any reversal.

Avoid making market-making, rapid scalping, fleeting cross-venue arbitrage or funding-cutoff timing the first AI-driven strategy: those depend directly on prices and order states that can change materially during the delay. None of the candidates should trade merely because an LLM expressed confidence.

## Freshness and order preflight

Record source observation time, data receipt time, inference start/end, risk-check time, order submission, acknowledgment and each fill. Use a monotonic clock for local elapsed time, check clock synchronization for external timestamps, and monitor observed p50/p95/p99 delays. A 20–30 second inference time is only part of the elapsed path: market-data age, chain confirmation, venue acceptance and execution all add to it.

After inference and immediately before submitting each entry, refresh the executable quote or venue oracle, position, collateral, funding, market status and risk limits. Re-run deterministic eligibility and sizing without waiting for another AI call. Cancel the entry if the signal changed, the stop has already been touched, the latest executable price breaches its limit, the market is unavailable, costs exceed the predeclared budget or margin and liquidation buffers no longer pass. Where technically supported, submit a bounded-price order with a short expiry; a limit can remain unfilled. An unfilled or rejected order is not a successful trade.

For initial paper experiments, reject new entries if observation-to-submission age exceeds **90 seconds** or the executable quote is more than **5 seconds** old; use a lower venue-appropriate oracle maximum age if its rules require it. Reject if adverse price movement since observation exceeds the smaller of **0.25 ATR** and **half of the original price-to-stop distance**. These values are illustrative configuration hypotheses, not empirical thresholds. Test stricter and looser values, compare reject rates and realized slippage, and set limits from measured venue data. Also apply maximum spread, estimated impact, minimum depth and order-size constraints. Recheck on retries; do not reuse stale quotes. During feed or venue uncertainty, block new risk while preserving a safe risk-reduction path wherever supported.

Execution must be idempotent and reconcile pending orders and partial fills before retrying. Protective exits should be maintained and monitored independently of the slower AI loop, with venue-supported reduce-only semantics where available. Verify actual venue behavior, including stop trigger source, partial-fill handling, OCO cancellation, expiry and whether protection survives disconnection. A stop is a trigger, not a guaranteed fill. On GMX, for example, stops can lose the race to liquidation, and trigger/execution prices use direction-dependent oracle bounds rather than a conventional order book ([GMX order types](https://docs.gmx.io/docs/trading/order-types/)).

## Risk and venue modeling

An illustrative paper risk budget is **0.25% of current portfolio NAV per trade**, with isolated margin and at most **2x notional-to-allocated-margin leverage** as initial constraints; neither prevents loss or liquidation. For linear USD-margined contracts, a sizing upper bound is:

```text
position notional <= budgeted loss in USD /
  (stop distance as a fraction of entry + stressed gap/slippage fraction
   + estimated round-trip fees and impact fraction + funding/borrow cost fraction)
```

Take the minimum of this result and the per-asset, total gross, correlated exposure, venue liquidity and margin caps. Include the spot hedge when computing portfolio exposure. Use venue-specific contract multipliers and PnL math; inverse contracts need a different calculation. Margin and liquidation checks must use current collateral, maintenance tiers, unrealized PnL, estimated close/liquidation fees and anticipated funding or borrow, not just the initial margin. Reject trades unless the protective stop is comfortably ahead of liquidation even after an adverse gap, spread widening, oracle delay and execution delay. Stress correlated moves and venue outages, and set a portfolio drawdown kill switch. Fixed leverage alone is not a risk budget, and 30 trades alone are not enough to justify estimating Kelly sizing.

Funding schedules and liquidation differ by venue. Binance documents funding transfers based on position notional and notes that insufficient balance may draw on position margin; its funding schedule can change ([Binance funding](https://www.binance.com/en/support/faq/detail/360033525031)). It uses mark price for liquidation and notes that actual liquidation outcomes can differ during fast moves ([Binance liquidation](https://www.binance.com/en/support/faq/detail/360033525271)). GMX instead documents oracle-bound pricing, variable funding and borrowing, price impact, and liquidation thresholds specific to its markets ([GMX liquidation](https://docs.gmx.io/docs/trading/liquidations/)). GMX currently describes position fees of 0.04% or 0.06% on each opening or closing action for most markets, before other applicable costs; verify the active contract and parameters rather than assuming those rates everywhere ([GMX fees](https://docs.gmx.io/docs/trading/fees/)).

## Validation before promotion

1. Select a specific venue and market, obtain timestamped historical trades or executable bids/asks or oracle bounds, mark/index prices, contract settings, funding and fee history. Preserve point-in-time information, including unavailable or stale data and delisted instruments. Use closed-bar values only after their availability time.
2. Implement event-time, portfolio-level replay. Simulate observation, inference, risk checks, submission and fills, with 20-, 30-, 60- and 120-second delays plus measured chain/keeper or venue delay. Model spread, impact, order expiry, partial or missed fills, fees, funding, borrow, stops, gaps, margin tiers and liquidation. Include outages and failed hedges. Use actual venue rules rather than mixing an order-book fill model with an oracle-based venue.
3. Use chronological training and validation windows, followed by a genuinely untouched test; roll forward across market regimes and assets. Freeze the strategy and risk parameters before the final test, document all experiments, and account for multiple testing and serial dependence, for example with block-bootstrap confidence intervals and a selection-bias diagnostic. Backtest selection itself can overfit ([Bailey et al., *Backtest Overfitting in Financial Markets*](https://escholarship.org/content/qt4hn4t174/qt4hn4t174_noSplash_2bb6c5b6dbbb66bcadbc3d0a05e3af6b.pdf)).
4. Compare to cash, buy-and-hold and identical rules without AI; isolate whether AI sentiment adds value after its delay and cost. Report net return, turnover, exposure, drawdown, tail losses, liquidation events, funding, fees, slippage, rejection and missed-fill rates. Stress worse costs, slower execution and changes in funding. Evaluate capacity and regime stability, not only Sharpe or win rate.
5. If results survive, run a timestamped paper deployment with live data and reconciled simulated orders. Compare observed latency and market conditions against replay. Any eventual live deployment requires a real derivatives adapter, independent position and risk accounting, robust emergency controls, and a separate review of venue and custody risks. A positive backtest or paper result does not guarantee future performance.

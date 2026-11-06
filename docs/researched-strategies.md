# Research strategy templates

These are independently implemented, four-hour crypto spot research templates inspired by common trading techniques. They are not copied trading bots and have not been shown profitable on this product. All setups use completed bars; the current quote and execution/risk controls remain separate. The existing one-minute decision cadence does not turn a four-hour setup into a one-minute strategy.

| Template | Entry setup | Exit evidence | Important limitation |
| --- | --- | --- | --- |
| Channel breakout | Close above the previous configured number of bars' highs | Close below the previous ten bars' lows | False breakouts and transaction costs can cause losses. This adapts channel-breakout concepts to 4h crypto, not the original historical trading system. |
| Band reversion | Previous close below its 20-bar lower band, followed by a close back above the updated lower band while still below its mean | Close at or above the 20-bar mean | Bands can remain stretched in a persistent trend; a band touch alone is not a reliable reversal. |
| RSI recovery | 14-period RSI crosses up through the configured oversold threshold | RSI reaches 70 | RSI can remain extreme in trending markets and crossings can whipsaw. |

The hosted harness includes these setup observations in the selected agent's analysis. The model still chooses whether to propose a trade, and the entry and exit flags are not orders. The legacy deterministic entry engine applies its common risk and cost gates before a new setup can become an entry signal; existing execution and exit logic is unchanged. Max notional and other constraints still apply. The momentum-specific factor thresholds do not become universal entry gates for the three new setup styles.

References: [time-series momentum research](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2089463) studied liquid futures at multi-month horizons, not these 4h crypto strategies; [Fidelity's Bollinger Bands guide](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/bollinger-bands) describes volatility bands and their trend limitations; and [Freqtrade's strategy documentation](https://docs.freqtrade.io/en/stable/strategy-customization/) illustrates closed-candle indicator and RSI-cross strategy rules. These sources motivate research rather than validate performance here.

Compare strategies using multiple historical periods and out-of-sample data, including fees, spread, slippage, drawdown, trading frequency, and a buy-and-hold baseline. Do not select a winning agent from a single short replay.

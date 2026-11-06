# Investments and withdrawals

After MetaMask sign-in, the dashboard shows only the wallet's agents. Each deployed agent has actual cash, protected lending and nonzero token balances, plus contract transaction history. Losing positions remain visible. Holdings are pinned to one block; PnL uses tracked cost basis and current exit estimates. Unknown values are displayed as unknown.

## Local execution

On the explicit Anvil network (chain 31337, `FLASH_MODE=sim`), manual spot exits execute real local token transfers through the allowance granted by RiskGate. The backend verifies an owner-signed, single-use instruction containing the exact agent, assets, quantities, minimum proceeds and acceptance of possible losses. A losing position is eligible for exit. This uses mock tokens and synthetic market prices.

- **Individual position:** close the selected quantity, settle USDC, then ask MetaMask to withdraw those proceeds to the owner. Partial exits preserve the remaining holding and its cost basis.
- **Cash:** `withdrawFromInvestment(..., false)` uses cash in the vault/trading wallet and does not pull protected lending.
- **Protected allocation:** `withdrawFromInvestment(..., true)` explicitly pulls the requested amount from the safe leg.
- **Withdraw all:** freeze entries, close every positive token holding, refresh the valuation, and redeem **all owner shares**, including the protected allocation. If all shares cannot be redeemed, the UI waits rather than silently paying only part of the balance.

A position exit and a wallet payout are separate confirmed transactions. The agent stays paused between them. Pending operations persist under `.perpetua/withdrawals`; the same operation ID cannot execute twice. A completion receipt must come after settlement, contain the owner's withdrawal event, and for withdraw-all leave no owner shares. Cancelling a wallet prompt does not undo a settled exit. The owner can explicitly resume with the remaining funds. Zero-proceeds exits report that no wallet transfer occurred.

The UI reports a payout only after a successful receipt. Adding capital does not silently restart an agent already sleeping after withdrawal; use **Resume agent** after meeting its minimum.

## Sleep behavior

Owner withdrawals invalidate existing entry authority. When remaining owner NAV falls below `minimumOperatingCapital` (default **25 USDC**, chosen at agent creation), the contract persists withdrawal sleep. A sufficiently funded partial withdrawal permits further operation after fresh risk limits. Full withdrawal sleeps the agent. While withdrawal-sleeping, the worker makes no compute top-ups or inference calls; poke cannot silently wake it, charge management fees for the sleeping interval or harvest new compute funds.

The hook covers positive withdrawals/redemptions of owner shares, including an authorized delegate; another depositor cannot sleep the owner using a zero-value call. `resumeAfterWithdrawal()` is an owner transaction and requires enough remaining owner NAV. Marked NAV and the existing price trust model remain authoritative; this is not a guarantee against market loss.

## Live-network boundary

The hosted withdrawal executor is deliberately restricted to Anvil. A live venue needs order/bracket cancellation, partial-fill reconciliation, fresh quotes and risk-reducing exits before releasing settled funds. Futures additionally need a derivatives adapter with margin and reduce-only protections. Legacy `POST /v1/investment-exit-requests` records explicitly blocked requests on unsupported networks; it does not claim a sale or payout.

Non-upgradeable deployments must use the current contract artifacts. New agents created through the local app use these artifacts automatically; older scripted seed vaults do not gain new methods.

Verification: `pnpm test:contracts` and, with API + Anvil running, `pnpm exec tsx scripts/local-product-smoke.ts`. The latter deploys a temporary owned agent, deposits, waits for an actual hosted trade, partially exits, withdraws all including lending, checks sleep/history/access isolation, and removes its dashboard entries. Receipt evidence is retained in `.perpetua/local-product-verification.json`.

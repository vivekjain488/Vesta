# Privy, Flash and autonomous agents

Status: sign-in opens Privy's login modal, then signs the existing MetaMask SIWE challenge. The app checks in the browser that both sessions include the same external address. Server verification of Privy identity, agent wallet creation, delegation, funding, withdrawals and autonomous Flash execution are **not** wired up. A browser-side match is not authorization for backend operations. Privy may create the user's default embedded wallet at login according to dashboard settings; it is not an agent wallet. Do not deposit to an address presented as an agent wallet until those paths and recovery have been verified end to end.

## Product flow

1. The user signs in using MetaMask, then explicitly authenticates with Privy. The backend verifies the Privy access token and independently verifies that the Privy identity is linked to the same MetaMask address as the existing SIWE session. A client-supplied Privy user ID is not evidence of ownership.
2. The user creates an agent. Create a **separate user-owned embedded EVM wallet** for it, associate its Privy wallet ID and address with the agent and authenticated owner in durable storage, and recover this association after restarts. Privy's wallet external IDs can support idempotent lookup; reconcile ambiguous API timeouts before retrying creation. Verify that the selected Privy account and wallet creation flow really support multiple distinct user-owned wallets and user recovery before enabling deposits.
3. Show the wallet address and network, then have MetaMask transfer the selected amount on the same chain. Require an explicit transaction confirmation and verify the receipt, sender, chain, destination and actual value. A transfer on Sepolia is not a deposit on Base.
4. Show the user exactly what the service signer may do and request authorization. Attach a separate Privy authorization signer under restrictive policies. Keep the user owner able to revoke access and recover/withdraw funds without relying on the agent. A backend-held authorization key is not the user's MetaMask key. Merely connecting MetaMask or setting an app secret does not grant this access.
5. With separate explicit activation, the hosted worker may request a Flash quote for that agent's wallet, validate it against the agent mandate, obtain restricted signatures and send permitted approval transactions, then submit and reconcile the advanced order. The model proposes an order; deterministic controls decide if it is permitted. Pause must stop new orders, revoke service authority as appropriate, and cancel outstanding orders; previously issued permits/allowances may require separate revocation. Withdrawals must pause execution and account for pending orders and positions.

See Privy's [trading bot guide](https://docs.privy.io/recipes/telegram-bot), [policy model](https://docs.privy.io/security/wallet-infrastructure/policy-and-controls), [access-token verification](https://docs.privy.io/authentication/user-authentication/access-tokens), and [wallet external IDs](https://docs.privy.io/wallets/wallets/external-ids).

## Dashboard and credentials

1. In the [Privy dashboard](https://dashboard.privy.io/), select the app and enable wallet authentication with MetaMask and embedded Ethereum wallets. Configure the app's allowed frontend origins and redirect settings for local and deployed environments.
2. The supplied app ID and app secret are in local `.env` as `NEXT_PUBLIC_PRIVY_APP_ID`, `PRIVY_APP_ID` and `PRIVY_APP_SECRET`. The public ID is also in `frontend/.env.local` so Next.js can read it. The app secret is server-only. The agent page can open Privy login, but that login does not establish a backend-verified agent wallet binding.
3. Create a dedicated authorization key/signer in Privy's dashboard. Store its private key in a production secret manager or HSM-compatible signing service; set the signer ID and private key only on the backend. Never put either secret in a `NEXT_PUBLIC_` variable. A signer ID or app secret alone is not delegation. The required signer and policy IDs and authorization private key have not been configured or verified.
4. Configure and test policies for the actual chain, Flash settlement/Permit2 contracts, ERC-20 approvals and EIP-712 messages. Restrict tokens, allowance amounts, recipients, expiry and transactions; explicitly deny unrelated signatures. Verify exactly what Privy can enforce for each Flash typed-data and permit field. If a limit cannot be enforced at the signing boundary, add an independently enforced mechanism or do not enable that operation. Application-side USD/rolling limits need trusted prices and a durable reservation ledger; they are not a substitute for independently enforced signer policies.
5. Register an integrator via [Flash getting started](https://flash.definitive.fi/docs/getting-started), set its key in `FLASH_API_KEY`, and configure and disclose any fee. Flash's public integration key is useful for ordinary integration testing, but is not a substitute for an app-specific integrator account or confirmation of fee entitlement.

Check only the supplied Privy app credentials with `node --env-file=.env scripts/check-privy.mjs`. This lists wallets read-only and prints neither credentials nor wallet data. A successful response does not verify identity linking, delegation, policies or recovery.

## Flash order and chain constraints

The existing `agent/src/flash.ts` implements a REST client and simulator. It is not a Privy signer integration. Flash's [agent guide](https://flash.definitive.fi/docs/for-agents) specifies quote → approval/wrap if needed → EIP-712 order/optional permit signature → order submission → status/fill reconciliation. Brackets can require another signature. A cancelled order does not necessarily revoke a permit or an allowance. Validate all quote fields, EIP-712 domain and message, token approvals, spend caps and expiry against the user's mandate before any signing; never blindly forward an API-returned transaction. Integrator fees must agree between quote and order.

At the time of review, Flash's documented supported-chain list does not list Sepolia or 0G. Confirm supported chains and demo assets with Flash before funding. The requested Flash-track demo needs a real advanced order and on-chain fill on a supported network; local simulations and Sepolia transfers do not establish track eligibility. A limit, TWAP or bracket order and its on-chain settlement need to be shown, as well as the requested video submissions.

## 0G funding

An EVM wallet address can exist on multiple EVM chains, but its balances and gas are separate. A Privy wallet does not convert assets, bridge them, or fund 0G inference by itself. Current 0G Router credit is a separate prepaid account; the existing adapter does not establish that a 0G token deposit credits that account. Before promising self-funding, identify a verified supported conversion and CCIP route, destination asset, destination gas source and 0G compute payment mechanism for the actual provider. Do not assume CCIP supports any given route or token. Enforce the earlier `min(20% of initial deposit, $5 equivalent)` allocation, per-agent accounting and reservation limits; pause inference/trading when funds or a verified route are insufficient. The actual conversion/bridge/provider-credit adapter is not implemented.

## Work before activation

- Bind Privy and SIWE identities, provision and recover one user-owned wallet per agent, and support direct owner withdrawal.
- Implement policy-constrained delegation, service key custody, authorization renewal and revocation; prove restrictions for Flash orders, permits and approvals.
- Integrate the hosted harness with Privy and Flash, idempotent order submission, status/fill reconciliation, cancellation, limits and recovery from retries.
- Deliver a supported 0G top-up route with separate per-agent budgets and enforceable provider spend limits.
- Perform adversarial tests, independent security review, test a real supported-chain trade with appropriate funds, and demonstrate withdrawal and revocation. This repository does not yet establish production safety.

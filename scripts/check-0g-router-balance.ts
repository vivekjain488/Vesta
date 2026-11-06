import "dotenv/config";
import { formatUnits } from "viem";
import { readRouterBalance } from "../agent/src/router-balance";

const managementKey = process.env.ZG_ROUTER_MANAGEMENT_KEY;
const expectedAddress = process.env.ZG_ROUTER_ACCOUNT_ADDRESS;
if (!managementKey || !expectedAddress) throw new Error("Set ZG_ROUTER_MANAGEMENT_KEY (account:read) and ZG_ROUTER_ACCOUNT_ADDRESS in .env");
const balance = await readRouterBalance({ baseUrl: process.env.ZG_BASE_URL ?? "https://router-api.0g.ai/v1", managementKey, expectedAddress });
console.log(JSON.stringify({ address: balance.address, currency: balance.currency, ledgerLessReportedCharges: formatUnits(balance.conservativeLedgerBalance, balance.currency === "usd" ? 6 : 18), unsettledChargeReported: balance.unsettledChargeReported, observedAt: new Date(balance.observedAtMs).toISOString(), note: "Router ledger only; excludes shared payment-vault funds and unreported liabilities. Not an agent-specific balance or a guarantee of request admission." }, null, 2));

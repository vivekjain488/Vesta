// Read-only credential check: never creates wallets, signs, transfers or prints account data.
const id = process.env.PRIVY_APP_ID;
const secret = process.env.PRIVY_APP_SECRET;
if (!id || !secret) {
  console.error("Set PRIVY_APP_ID and PRIVY_APP_SECRET before checking Privy.");
  process.exitCode = 1;
} else {
  try {
    const response = await fetch("https://api.privy.io/v1/wallets?limit=1", {
      headers: { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "privy-app-id": id },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      console.error(`Privy wallet-list request failed (HTTP ${response.status}). Check the app credentials and wallet API access.`);
      process.exitCode = 1;
    } else {
      console.log("Privy credentials accepted for a read-only wallet-list request. Delegation, policies and wallet recovery are not verified.");
    }
  } catch {
    console.error("Could not reach Privy within 15 seconds; no wallet operations were attempted.");
    process.exitCode = 1;
  }
}

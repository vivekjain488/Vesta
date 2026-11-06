import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { EIP1193Provider } from "@privy-io/react-auth";
import { sendOwnerTransaction } from "../lib/owner-transaction";

const owner = "0x1111111111111111111111111111111111111111";
const destination = "0x2222222222222222222222222222222222222222";
function mock(options: { authorized?: boolean; switchError?: number; otherAccount?: boolean } = {}) {
  const calls: string[] = []; let connected = options.authorized ?? false; let chain = "0x1"; let providers = 0;
  const provider = { request: async ({ method }: { method: string }) => {
    calls.push(method);
    if (method === "eth_accounts") return connected ? [options.otherAccount ? destination : owner] : [];
    if (method === "eth_requestAccounts") { connected = true; return [options.otherAccount ? destination : owner]; }
    if (method === "eth_chainId") return chain;
    if (method === "wallet_switchEthereumChain") { if (options.switchError) throw { code: options.switchError }; chain = "0x7a69"; return null; }
    if (method === "wallet_addEthereumChain") { chain = "0x7a69"; return null; }
    if (method === "eth_sendTransaction") return "0xtest";
    throw new Error(`Unexpected method: ${method}`);
  } } as unknown as EIP1193Provider;
  return { calls, getProvider: async () => { providers++; return provider; }, providerCount: () => providers };
}

test("requests account access before switching and obtains the provider again", async () => {
  const wallet = mock();
  assert.equal(await sendOwnerTransaction(wallet.getProvider, owner, destination, "0x", 31337), "0xtest");
  assert.deepEqual(wallet.calls, ["eth_accounts", "eth_requestAccounts", "eth_chainId", "wallet_switchEthereumChain", "eth_chainId", "eth_accounts", "eth_sendTransaction"]);
  assert.equal(wallet.providerCount(), 2);
});
test("adds the local network when MetaMask reports it is unknown", async () => {
  const wallet = mock({ authorized: true, switchError: 4902 });
  await sendOwnerTransaction(wallet.getProvider, owner, destination, "0x", 31337);
  assert.ok(wallet.calls.includes("wallet_addEthereumChain"));
});
test("never sends when account or network authorization fails", async () => {
  const wrong = mock({ otherAccount: true });
  await assert.rejects(sendOwnerTransaction(wrong.getProvider, owner, destination, "0x", 31337), /same MetaMask account/);
  assert.ok(!wrong.calls.includes("eth_sendTransaction"));
  const rejected = mock({ authorized: true, switchError: 4100 });
  await assert.rejects(sendOwnerTransaction(rejected.getProvider, owner, destination, "0x", 31337), /not authorized.*switch networks/);
  assert.ok(!rejected.calls.includes("eth_sendTransaction"));
});

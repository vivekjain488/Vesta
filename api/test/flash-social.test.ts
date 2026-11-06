import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { flashSocialRouter, matchFlashTransfers, validateFlashQuote } from "../src/flash-social";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const other = privateKeyToAccount(`0x${"22".repeat(32)}`);
const spender = "0x5d00000873b6BF41539e6f5365B0Ff7d3c368f78" as Address;
const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const weth = "0x4200000000000000000000000000000000000006" as Address;
const typed = { domain: { name: "DefinitiveFlashAllowance", version: "1", chainId: 8453, verifyingContract: spender }, types: { FlashOrder: [{ name: "swapper", type: "address" }, { name: "vault", type: "address" }, { name: "recipient", type: "address" }, { name: "fromToken", type: "address" }, { name: "toToken", type: "address" }, { name: "fromAmount", type: "uint256" }, { name: "salt", type: "uint256" }, { name: "deadline", type: "uint256" }] }, primaryType: "FlashOrder", message: { swapper: account.address, vault: spender, salt: "1", deadline: "281474976710655", recipient: account.address, fromToken: usdc, toToken: weth, fromAmount: "5000000" } } as const;
const quote = () => ({ quoteId: "example", orderType: "limit", side: "buy", targetAsset: weth, contraAsset: usdc, evm: { orderTypedData: JSON.stringify(typed), permitTypedData: "", approveTx: { to: usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, 5000000n] }) } } });

test("rejects wrong recipient and oversized approvals", () => {
  assert.doesNotThrow(() => validateFlashQuote(quote(), account.address, "5", spender));
  const wrong = quote(); const td = JSON.parse(wrong.evm.orderTypedData); td.message.recipient = other.address; wrong.evm.orderTypedData = JSON.stringify(td);
  assert.throws(() => validateFlashQuote(wrong, account.address, "5", spender));
  const tooMuch = quote(); tooMuch.evm.approveTx.data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, 5000001n] });
  assert.throws(() => validateFlashQuote(tooMuch, account.address, "5", spender));
});

test("signed orders are session-bound, immutable and submitted at most once", async () => {
  process.env.FLASH_SOCIAL_ENABLED = "true"; process.env.FLASH_SOCIAL_SPENDER = spender; process.env.FLASH_API_KEY = "test";
  const dir = mkdtempSync(join(tmpdir(), "flash-social-"));
  const app = express(); app.use(express.json()); app.use(flashSocialRouter(dir, (req) => req.headers["x-owner"] as Address, (name) => name === "Alpha"));
  const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  const original = globalThis.fetch; let submissions = 0; let posted: any;
  globalThis.fetch = (async (url: any, opts: any) => {
    if (String(url).startsWith("https://flash.definitive.fi/v1")) {
      if (String(url).endsWith("/quote")) return Response.json(quote());
      if (String(url).endsWith("/order")) { submissions++; posted = JSON.parse(opts.body); return Response.json({ orderId: "order-1" }); }
    }
    return original(url, opts);
  }) as typeof fetch;
  const post = (path: string, body: unknown, owner = account.address) => original(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-owner": owner }, body: JSON.stringify(body) });
  try {
    assert.equal((await post("/quote", { agent: "../x", amount: "5", limitPrice: "1500" })).status, 400);
    assert.equal((await post("/quote", { agent: "Alpha", amount: "NaN", limitPrice: "1500" })).status, 400);
    process.env.COPY_MAX_USD = "invalid";
    assert.equal((await post("/quote", { agent: "Alpha", amount: "5", limitPrice: "1500" })).status, 400);
    delete process.env.COPY_MAX_USD;
    const response = await post("/quote", { agent: "Alpha", amount: "5", limitPrice: "1500" }); assert.equal(response.status, 200);
    const prepared = await response.json() as any;
    const wrongSignature = await other.signTypedData(typed as any);
    assert.equal((await post("/order", { id: prepared.id, signature: wrongSignature })).status, 400);
    const signature = await account.signTypedData(typed as any);
    assert.equal((await post("/order", { id: prepared.id, signature }, other.address)).status, 400);
    assert.equal((await post("/order", { id: prepared.id, signature, qty: "1000000" })).status, 200);
    assert.equal(posted.qty, "5"); assert.equal(posted.limitNotionalPrice, "1500");
    assert.equal((await post("/order", { id: prepared.id, signature })).status, 400); assert.equal(submissions, 1);
  } finally { globalThis.fetch = original; server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("read-only quote works without enabling order submission", async () => {
  process.env.FLASH_SOCIAL_ENABLED = "false"; process.env.FLASH_API_KEY = "test";
  const dir = mkdtempSync(join(tmpdir(), "flash-preview-"));
  const app = express(); app.use(express.json()); app.use(flashSocialRouter(dir, () => account.address, (name) => name === "Alpha"));
  const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, opts: any) => String(url).startsWith("https://flash.definitive.fi/v1") ? Response.json(quote()) : original(url, opts)) as typeof fetch;
  try {
    const response = await original(`http://127.0.0.1:${port}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "Alpha", amount: "5", limitPrice: "1000" }) });
    assert.equal(response.status, 200); const result = await response.json() as any;
    assert.equal(result.submissionEnabled, false); assert.equal(result.id, undefined); assert.equal(result.quote.evm, undefined);
    const order = await original(`http://127.0.0.1:${port}/order`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "anything", signature: "0x00" }) });
    assert.equal(order.status, 503);
  } finally { globalThis.fetch = original; server.close(); rmSync(dir, { recursive: true, force: true }); }
});


test("onchain evidence requires a successful receipt with both wallet transfers", () => {
  const event = (token: Address, from: Address, to: Address) => ({ address: token, topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }), data: encodeAbiParameters([{ type: "uint256" }], [1n]) });
  const out = event(usdc, account.address, other.address), incoming = event(weth, other.address, account.address);
  assert.equal(matchFlashTransfers({ status: "success", logs: [out, incoming] }, account.address), true);
  assert.equal(matchFlashTransfers({ status: "reverted", logs: [out, incoming] }, account.address), false);
  assert.equal(matchFlashTransfers({ status: "success", logs: [out] }, account.address), false);
  assert.equal(matchFlashTransfers({ status: "success", logs: [out, incoming] }, other.address), false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { replayLimits, type ArkivRow } from "../lib/arkiv-limit-replay";
const row = (time: number, bid: number, ask: number): ArkivRow => ({ entityKey: `key-${time}`, publishedAtMs: time, data: { symbol: "BTCUSDT", book: { bids: [[String(bid), "1"]], asks: [[String(ask), "1"]] } } });
test("replay uses only the next observation for a limit fill", () => {
  const result = replayLimits([row(3, 99, 100), row(1, 99, 100), row(2, 100, 101)]);
  assert.equal(result.length, 1); assert.equal(result[0].side, "buy"); assert.equal(result[0].limit, 101);
  assert.equal(result[0].status, "paper fill"); assert.equal(result[0].fillPrice, 100); assert.equal(result[0].resultAt, 3);
});
test("unreached limit expires and cannot use a later favorable quote", () => {
  const result = replayLimits([row(1, 99, 100), row(2, 100, 101), row(3, 102, 103), row(4, 90, 91)]);
  const order = result.find(r => r.at === 2); assert.equal(order?.status, "expired unfilled"); assert.equal(order?.fillPrice, undefined);
});
test("insufficient or duplicate observations never produce a trade", () => {
  assert.deepEqual(replayLimits([row(1, 99, 100), row(1, 100, 101)]), []);
});

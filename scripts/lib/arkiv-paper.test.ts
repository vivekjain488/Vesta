import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { paperFill, selectReplaySnapshots } from './arkiv-paper';

test('uses valid published snapshots at least 30 seconds apart', () => {
  const row = (publishedAtMs: number, observedAtMs = publishedAtMs - 1000) => ({ publishedAtMs, data: { observedAtMs, sourceAtMs: observedAtMs - 1000, book: { bids: [['100','1']], asks: [['101','1']] } } });
  const result = selectReplaySnapshots([row(121000),row(110000),row(91000),row(61000),row(31000),row(120000,121000)]);
  assert.deepEqual(result.map(r => r.publishedAtMs), [31000,61000,91000,121000]);
});
test('fills buys at the later ask and sells at the later bid, respecting funds and fees', () => {
  const buy = paperFill('buy',100,1000,1,100,101)!;
  assert.equal(buy.price,101); assert.equal(buy.cash,899.9); assert.ok(Math.abs(buy.qty-(1+100/101))<1e-12);
  const sell = paperFill('sell',100,0,.5,100,101)!;
  assert.equal(sell.price,100); assert.equal(sell.amount,50); assert.equal(sell.cash,49.95); assert.equal(sell.qty,0);
  assert.equal(paperFill('hold',100,1000,1,100,101),null);
});

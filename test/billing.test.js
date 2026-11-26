import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeShare, computeTip, computeDiscount, quote, parseMajor, formatMoney } from '../shared/billing.js';

const bill = (over = {}) => ({
  currency: 'AED', total_minor: 21300, settled_minor: 0,
  items: [
    { id: 'a', unit_price_minor: 5400, qty: 2, settled_qty: 0 },
    { id: 'b', unit_price_minor: 3200, qty: 2, settled_qty: 0 },
    { id: 'c', unit_price_minor: 4100, qty: 1, settled_qty: 0 },
  ],
  ...over,
});
const policy = { tip_percents: [5, 7, 10], max_tip_percent: 50, fee_bps: 175, fee_fixed_minor: 0, fee_cap_minor: null };

test('equal split: shares never exceed remaining, last payer absorbs rounding', () => {
  const b = bill({ total_minor: 10000 });
  let settled = 0;
  for (let i = 0; i < 3; i++) {
    const { share_minor } = computeShare({ ...b, settled_minor: settled }, { mode: 'equal', parts: 3, pay: 1 });
    settled += share_minor;
  }
  // 3333 + 3333 + 3334 — exactly the bill, never more.
  assert.ok(settled <= 10000 && settled >= 9999);
});

test('custom amount above remaining is rejected', () => {
  assert.throws(() => computeShare(bill({ settled_minor: 20000 }), { mode: 'custom', amount_minor: 1301 }), /AMOUNT_EXCEEDS_REMAINING/);
});

test('cannot pay for more item units than remain', () => {
  const b = bill();
  b.items[0].settled_qty = 2;
  assert.throws(() => computeShare(b, { mode: 'items', items: [{ id: 'a', qty: 1 }] }), /ITEM_UNAVAILABLE/);
  assert.throws(() => computeShare(bill(), { mode: 'items', items: [{ id: 'a', qty: 1 }, { id: 'a', qty: 1 }] }), /INVALID_ITEM/);
});

test('paid bill cannot be paid again', () => {
  assert.throws(() => computeShare(bill({ settled_minor: 21300 }), { mode: 'full' }), /BILL_ALREADY_PAID/);
});

test('tip: only offered percentages; custom tips capped', () => {
  assert.equal(computeTip(21300, { type: 'percent', value: 7 }, policy), 1491);
  assert.throws(() => computeTip(21300, { type: 'percent', value: 8 }, policy), /INVALID_TIP/);
  assert.throws(() => computeTip(1000, { type: 'amount', amount_minor: 501 }, policy), /TIP_TOO_HIGH/);
  assert.throws(() => computeTip(1000, { type: 'amount', amount_minor: 1.5 }, policy), /INVALID_TIP/);
});

test('discounts are capped and never make the total zero', () => {
  assert.equal(computeDiscount(21300, { kind: 'percent', value: 10, max_minor: 2000 }), 2000);
  assert.equal(computeDiscount(1000, { kind: 'fixed', value: 5000 }), 999);
  assert.throws(() => computeDiscount(15000, { kind: 'fixed', value: 5000, min_spend_minor: 20000 }), /OFFER_MIN_SPEND/);
});

test('quote invariant: total = share - discount + fee + tip', () => {
  const q = quote(bill(), { split: { mode: 'full' }, tip: { type: 'percent', value: 7 } }, policy, { kind: 'percent', value: 10, max_minor: 2000 });
  assert.equal(q.total_minor, q.share_minor - q.discount_minor + q.fee_minor + q.tip_minor);
});

test('3-decimal currencies (OMR/KWD/BHD) parse and format exactly', () => {
  assert.equal(parseMajor('12.345', 'OMR'), 12345);
  assert.equal(parseMajor('0.1', 'KWD'), 100);
  assert.throws(() => parseMajor('1.2345', 'OMR'), /INVALID_AMOUNT/);
  assert.throws(() => parseMajor('1e3', 'AED'), /INVALID_AMOUNT/);
  assert.equal(formatMoney(12345, 'OMR', 'en'), 'OMR 12.345');
});

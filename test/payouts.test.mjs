// Checks the JavaScript payout maths against results the real contract produced.
import { test } from "node:test";
import assert from "node:assert/strict";
import { settle, weight } from "../shared/payouts.js";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("matches the contract's weights: seconds on the wheel, at least 1", () => {
  close(weight(0), 1);
  close(weight(60), 60);
  close(weight(120), 120);
  close(weight(3600), 3600);
});

test("matches the contract's payouts", () => {
  // 3 players at 100 SQK; exits at +33 s and +83 s; last movement at +90 s; 3 SQK bounty (1% cap).
  // Net 297: the jackpot (59.4) goes to the last winner; the curve pool (237.6) splits 33 : 83.
  const r = settle({ buyIn: 100, inPot: 3, exits: [{ id: "a", t: 33 }, { id: "b", t: 83 }], lastMove: 90 });
  close(r.bounty, 3);
  close(r.payouts.get("a").total, (237.6 * 33) / 116, 1e-9);
  close(r.payouts.get("b").total, (237.6 * 83) / 116 + 59.4, 1e-9);
  assert.equal(r.payouts.has("c"), false);
});

test("an exit 13 s after the last movement is caught, and everyone caught rolls over", () => {
  const r = settle({ buyIn: 100, inPot: 2, exits: [{ id: "a", t: 103 }], lastMove: 90 });
  assert.equal(r.rolledOver, true);
});

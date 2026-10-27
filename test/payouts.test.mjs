// Checks the JavaScript payout maths against results the real contract produced.
import { test } from "node:test";
import assert from "node:assert/strict";
import { settle, weight } from "../shared/payouts.js";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("matches the contract's weights", () => {
  close(weight(0), 1);
  close(weight(60), 1.125);
  close(weight(120), 1.25);
  close(weight(240), 1.5625);
});

test("matches the contract on the local end-to-end game", () => {
  // 3 players at 100 SQK; exits at +33 s and +83 s; last movement at +90 s. The contract paid
  // 113.27955390334572494 and 183.720446096654275059 SQK, with a 3 SQK bounty (1% cap).
  const r = settle({ buyIn: 100, inPot: 3, exits: [{ id: "a", t: 33 }, { id: "b", t: 83 }], lastMove: 90 });
  close(r.bounty, 3);
  close(r.payouts.get("a").total, 113.27955390334572494, 1e-9);
  close(r.payouts.get("b").total, 183.720446096654275059, 1e-9);
  assert.equal(r.payouts.has("c"), false);
});

test("an exit 13 s after the last movement is caught, and everyone caught rolls over", () => {
  const r = settle({ buyIn: 100, inPot: 2, exits: [{ id: "a", t: 103 }], lastMove: 90 });
  assert.equal(r.rolledOver, true);
});

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

test("matches the contract's payouts with a late entry, weighted from its own join time", () => {
  // 4 players at 100 (one joined 50 s in); exits at +80 s and +100 s; 4 SQK bounty. Net 396: jackpot 79.2 to
  // the last winner; curve pool 316.8 split 80 : 50 (the late player was on from +50 s to +100 s).
  const r = settle({ buyIn: 100, inPot: 4, exits: [{ id: "a", t: 80 }, { id: "late", t: 100, from: 50 }], lastMove: 110 });
  close(r.payouts.get("a").total, (316.8 * 80) / 130, 1e-9);
  close(r.payouts.get("late").total, (316.8 * 50) / 130 + 79.2, 1e-9);
});

test("an exit 13 s after the last movement is caught, and everyone caught rolls over", () => {
  const r = settle({ buyIn: 100, inPot: 2, exits: [{ id: "a", t: 103 }], lastMove: 90 });
  assert.equal(r.rolledOver, true);
});

test("counts late entries in the pot the way the contract does", async () => {
  const { countsInPot } = await import("../shared/payouts.js");
  const g = { startTime: 1000, lateEntryWindow: 120, firstExitTime: 0 };
  assert.equal(countsInPot({ enteredAt: 900, exitTime: 0 }, g), true);
  assert.equal(countsInPot({ enteredAt: 1120, exitTime: 0 }, g), true); // the last second of the window
  assert.equal(countsInPot({ enteredAt: 1121, exitTime: 0 }, g), false);
  assert.equal(countsInPot({ enteredAt: 1050, exitTime: 0 }, { ...g, firstExitTime: 1050 }), false); // same block as the first exit
  assert.equal(countsInPot({ enteredAt: 1049, exitTime: 0 }, { ...g, firstExitTime: 1050 }), true);
  assert.equal(countsInPot({ enteredAt: 900, exitTime: 950 }, g), false); // got off before the start: refunded
  assert.equal(countsInPot({ enteredAt: 900, exitTime: 0, left: true }, g), false);
});

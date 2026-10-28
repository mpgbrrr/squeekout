// Replays the live feed recorded on the night of 26-27 Oct 2026 through the shared rules,
// one tick per second, and checks the decisions against what the hamster actually did.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULTS, newGameState, step, trackRun } from "../shared/rules.js";

const rows = readFileSync(new URL("./fixtures/feed-2026-10-26-night.jsonl", import.meta.url), "utf8")
  .trim().split("\n").map((l) => JSON.parse(l))
  .map(([seenAt, observedAt, counter, fresh, coreStatus, epoch]) => ({ seenAt, observedAt, counter, fresh, coreStatus, epoch, rpm: 0 }));
const utc = (s) => Math.floor(Date.parse(s) / 1000);

function replay(earliestStart, until, overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides };
  let state = newGameState(earliestStart);
  const decisions = [];
  let i = 0, latest = null;
  for (let now = rows[0].seenAt; now <= until; now++) {
    while (i < rows.length && rows[i].seenAt <= now) latest = rows[i++];
    const r = step(state, latest, now, cfg);
    state = r.state;
    if (r.decision) decisions.push({ ...r.decision, at: now });
    if (state.phase === "done") break;
  }
  return decisions;
}

const within = (t, from, to) => assert.ok(t >= utc(from) && t <= utc(to), `${new Date(t * 1000).toISOString()} not in ${from}..${to}`);

test("22:00 game starts when the feed returns at 22:07 and ends at the 4-minute break", () => {
  const d = replay(utc("2026-10-26T22:00:00Z"), utc("2026-10-26T23:00:00Z"));
  assert.equal(d[0].type, "start");
  within(d[0].startTime, "2026-10-26T22:07:00Z", "2026-10-26T22:08:00Z");
  assert.equal(d[1].type, "end");
  within(d[1].lastMove, "2026-10-26T22:12:00Z", "2026-10-26T22:14:30Z");
});

test("21:10 game is voided 30 minutes into the 49-minute freeze", () => {
  const d = replay(utc("2026-10-26T21:10:00Z"), utc("2026-10-26T22:30:00Z"));
  assert.equal(d[0].type, "start");
  within(d[0].startTime, "2026-10-26T21:16:00Z", "2026-10-26T21:18:00Z");
  assert.equal(d[1].type, "void");
  assert.match(d[1].reason, /feed down for 30 minutes/);
  within(d[1].at, "2026-10-26T21:48:00Z", "2026-10-26T21:50:00Z");
});

test("a shorter freeze that hid running still voids the game when the feed returns", () => {
  const d = replay(utc("2026-10-26T21:10:00Z"), utc("2026-10-26T22:30:00Z"), { outageLimit: 3600 });
  assert.equal(d[1].type, "void");
  assert.match(d[1].reason, /ran during the gap/);
  within(d[1].at, "2026-10-26T22:07:00Z", "2026-10-26T22:08:00Z");
});

test("06:00 game rides through the short breaks and ends after the last run", () => {
  const d = replay(utc("2026-10-27T06:00:00Z"), utc("2026-10-27T07:30:00Z"));
  assert.equal(d[0].type, "start");
  within(d[0].startTime, "2026-10-27T06:10:00Z", "2026-10-27T06:12:00Z");
  assert.equal(d[1].type, "end");
  within(d[1].lastMove, "2026-10-27T06:54:00Z", "2026-10-27T06:56:30Z");
});

// trackRun: what a page opened mid-game is told about his last movement and this run.
const at = (t, counter) => ({ observedAt: t, counter, fresh: true, coreStatus: "ACTIVE", epoch: "e", rpm: 60, receivedAt: t });
function feedRun(readings) {
  let h = null;
  for (const r of readings) h = trackRun(h, r, r.observedAt);
  return h;
}

test("trackRun: a run already going when tracking starts is partial", () => {
  const h = feedRun([at(1000, 50), at(1010, 60), at(1020, 70)]);
  assert.equal(h.runSince, 1010);
  assert.equal(h.runPartial, true);
  assert.equal(h.lastMove, 1020);
});

// Readings every 10 s from `from` to `to`, with the counter going up by 10 each reading while `moving(t)`.
function readings(from, to, moving, counter = 50) {
  const out = [];
  for (let t = from; t <= to; t += 10) {
    if (moving(t)) counter += 10;
    out.push(at(t, counter));
  }
  return out;
}

test("trackRun: a run after a full still window has a known start, and short breaks don't end it", () => {
  // Still until 1200, runs 1200-1300, a 150 s break, runs again from 1450.
  const h = feedRun(readings(1000, 1500, (t) => (t >= 1200 && t < 1300) || t >= 1450));
  assert.equal(h.runPartial, false);
  assert.equal(h.runSince, 1200, "a 150 s break is part of the same run");
  assert.equal(h.lastMove, 1500);
  // Still until 1200, runs 1200-1300, a 200 s break (longer than the idle window), runs again from 1500.
  const h2 = feedRun(readings(1000, 1550, (t) => (t >= 1200 && t < 1300) || t >= 1500));
  assert.equal(h2.runSince, 1500, "a break longer than the idle window starts a new run");
  assert.equal(h2.runPartial, false);
});

test("trackRun: missed readings make the next run's start uncertain", () => {
  const still = Array.from({ length: 20 }, (_, i) => at(1000 + i * 10, 50));
  const h = feedRun([...still, at(1500, 90)]); // 310 s with no readings, and he moved
  assert.equal(h.runSince, 1500);
  assert.equal(h.runPartial, true);
});

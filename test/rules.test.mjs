// Replays the live feed recorded on the night of 26-27 Oct 2026 through the shared rules,
// one tick per second, and checks the decisions against what the hamster actually did.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULTS, newGameState, step } from "../shared/rules.js";

const rows = readFileSync(new URL("./fixtures/feed-2026-10-26-night.jsonl", import.meta.url), "utf8")
  .trim().split("\n").map((l) => JSON.parse(l))
  .map(([seenAt, observedAt, counter, fresh, coreStatus, epoch]) => ({ seenAt, observedAt, counter, fresh, coreStatus, epoch, rpm: 0 }));
const utc = (s) => Math.floor(Date.parse(s) / 1000);

function replay(lobbyClose, until, overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides };
  let state = newGameState(lobbyClose);
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

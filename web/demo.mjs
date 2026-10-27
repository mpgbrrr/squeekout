// Demo mode: one practice game in the browser with a simulated Squeektoshi and simulated players.
// The fake feed goes through the same rules as the watcher (shared/rules.js), and payouts use the
// contract's maths (shared/payouts.js). No wallet, no SQK, nothing on-chain.
import { display, newGameState, step } from "/shared/rules.js";
import { settle } from "/shared/payouts.js";

const BOTS = ["Nibbles", "Pip", "Captain Seed", "Whiskers", "Dash", "Pepper", "Sunflower", "Biscuit", "Hazel"];
const rand = (a, b) => a + Math.random() * (b - a);

// Runs and breaks shaped like the real Squeektoshi's nights: runs of 1–5 minutes, breaks of 15 s to
// 2¾ minutes (shorter than the 3-minute rule, so the game survives them), then the final stop.
function hamsterPlan() {
  const plan = [];
  const runs = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < runs; i++) {
    plan.push({ kind: "run", secs: rand(60, 300), rpm: rand(55, 105) });
    if (i < runs - 1) plan.push({ kind: "break", secs: rand(15, 165) });
  }
  return plan;
}

export function createDemo({ buyIn = 100, lobbySecs = 20 } = {}) {
  const plan = hamsterPlan();
  const players = [
    { id: "you", name: "You", you: true, exit: null, landsAt: null },
    ...BOTS.map((name, i) => {
      const style = i < 2 ? "greedy" : i < 6 ? "steady" : "jumpy";
      return {
        id: `bot${i}`, name, style, exit: null, landsAt: null,
        // How long a break they'll sit through, and how long they'll stay on at most.
        breakNerve: style === "jumpy" ? rand(8, 40) : style === "steady" ? rand(40, 140) : rand(150, 400),
        maxStay: style === "greedy" ? Infinity : rand(90, 900),
      };
    }),
  ];
  const s = {
    t: 0, phase: "lobby", start: null, lastMove: null, result: null,
    rules: newGameState(lobbySecs), reading: null, counter: 50_000, nextReading: 0, pausedSince: null,
  };

  // Where the hamster is in his plan at simulated second t (null before he starts or after he stops).
  function hamsterAt(t) {
    let at = t - lobbySecs;
    if (at < 0) return { running: false, rpm: 0 };
    for (const seg of plan) {
      if (at < seg.secs) return { running: seg.kind === "run", rpm: seg.kind === "run" ? seg.rpm : 0 };
      at -= seg.secs;
    }
    return { running: false, rpm: 0, stopped: true };
  }

  function requestExit(p) {
    if (p.exit != null || p.landsAt != null || s.phase !== "live") return;
    p.landsAt = s.t + rand(1, 12); // lands in a later Ethereum block, like a real transaction
  }

  function tick(dt) {
    if (s.phase === "ended") return;
    s.t += dt;
    const h = hamsterAt(s.t);
    if (h.running) s.counter += (h.rpm / 60) * dt;
    // Like the real device: one reading every 10 seconds.
    while (s.t >= s.nextReading) {
      s.reading = { observedAt: s.nextReading, counter: Math.floor(s.counter), fresh: true, coreStatus: h.running ? "ACTIVE" : "IDLE", epoch: "demo", rpm: h.rpm };
      s.nextReading += 10;
      const { state, decision } = step(s.rules, s.reading, s.reading.observedAt);
      s.rules = state;
      if (decision?.type === "start") { s.phase = "live"; s.start = decision.startTime; }
      if (decision?.type === "end") { s.lastMove = decision.lastMove; finish(); return; }
    }
    if (s.phase !== "live") return;
    const view = display(s.rules, s.reading, s.reading.observedAt);
    s.pausedSince = view.mode === "paused" ? (s.pausedSince ?? s.t) : null;
    for (const p of players) {
      if (p.landsAt != null && s.t >= p.landsAt && p.exit == null) { p.exit = p.landsAt - s.start; p.landsAt = null; }
      if (p.you || p.exit != null || p.landsAt != null) continue;
      const pausedFor = s.pausedSince == null ? 0 : s.t - s.pausedSince;
      if (pausedFor > p.breakNerve || s.t - s.start > p.maxStay) requestExit(p);
    }
  }

  function finish() {
    s.phase = "ended";
    const exits = players.filter((p) => p.exit != null).sort((a, b) => a.exit - b.exit).map((p) => ({ id: p.id, t: p.exit }));
    s.result = settle({ buyIn, inPot: players.length, exits, lastMove: s.lastMove - s.start });
  }

  /** What you'd get if your exit landed now and everyone still on were caught. */
  function ifYouGotOffNow() {
    if (s.phase !== "live") return null;
    const now = s.t - s.start;
    const exits = players.filter((p) => p.exit != null && !p.you).map((p) => ({ id: p.id, t: p.exit }));
    exits.push({ id: "you", t: now });
    exits.sort((a, b) => a.t - b.t);
    return settle({ buyIn, inPot: players.length, exits, lastMove: now }).payouts.get("you").total;
  }

  return {
    tick,
    exitYou: () => requestExit(players[0]),
    ifYouGotOffNow,
    get state() { return s; },
    get players() { return players; },
    buyIn,
    view: () => (s.reading ? display(s.rules, s.reading, s.reading.observedAt) : { mode: "asleep" }),
  };
}

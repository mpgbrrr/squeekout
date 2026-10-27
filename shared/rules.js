// Game rules for reading Squeekchain's live feed. Shared by the watcher (which posts decisions on-chain)
// and the web app (whose hamster animation must show exactly what the watcher will decide).
// Pure functions only: no network, no clock. All times are unix seconds.

export const DEFAULTS = {
  idleWindow: 180, // seconds without movement that end the game
  outageLimit: 1800, // a feed outage longer than this voids the game
  maxReadingAge: 30, // readings arrive every 10 s; older than this means the feed is down
};

/** Turns a GET /v1/status response into a reading, or null when it has no measurement. */
export function readingFromStatus(status, receivedAtSec) {
  const m = status && status.measurement;
  if (!m || !m.observedAt) return null;
  return {
    observedAt: Math.floor(Date.parse(m.observedAt) / 1000),
    counter: Number(m.cumulativeWorkUnits),
    fresh: m.freshness === "online",
    coreStatus: m.coreStatus,
    epoch: m.counterEpoch,
    rpm: (m.rpmMilli || 0) / 1000,
    receivedAt: receivedAtSec,
  };
}

/** A reading the rules can trust: fresh by the feed's own flag, recent, and with a healthy counter. */
export function isHealthy(reading, now, cfg = DEFAULTS) {
  return Boolean(
    reading && reading.fresh && reading.coreStatus !== "COUNTER_FAULT" && now - reading.observedAt <= cfg.maxReadingAge,
  );
}

/**
 * Starts tracking one game. `phase` is "waiting" until the start, "live" until the end, then "done".
 * lastMove/lastCounter describe the hamster's latest movement seen in healthy data.
 */
export function newGameState(lobbyClose) {
  return { phase: "waiting", lobbyClose, startTime: null, lastMove: null, lastCounter: null, epoch: null, outage: null };
}

/**
 * Advances a game by one tick. Returns { state, decision } where decision is null or one of
 *   { type: "start", startTime }
 *   { type: "end", lastMove, counter }
 *   { type: "void", reason }
 */
export function step(prev, reading, now, cfg = DEFAULTS) {
  const s = { ...prev, outage: prev.outage ? { ...prev.outage } : null };
  if (s.phase === "done") return { state: s, decision: null };
  const healthy = isHealthy(reading, now, cfg);

  // A reset counter history means totals before and after can't be compared.
  if (healthy && s.epoch && reading.epoch !== s.epoch) {
    if (s.phase === "live") return finish(s, { type: "void", reason: "counter history reset" });
    s.epoch = reading.epoch;
    s.lastCounter = reading.counter;
    s.lastMove = null;
  }

  if (!healthy) {
    if (!s.outage) s.outage = { since: now, counterBefore: s.lastCounter, lastMoveBefore: s.lastMove };
    if (s.phase === "live" && now - s.outage.since >= cfg.outageLimit) {
      return finish(s, { type: "void", reason: "feed down for 30 minutes" });
    }
    return { state: s, decision: null };
  }

  if (s.epoch == null) s.epoch = reading.epoch;

  if (s.outage) {
    const o = s.outage;
    s.outage = null;
    if (o.counterBefore == null) {
      // No healthy reading before the gap (for example the watcher just restarted). A live game's
      // history is unknown, so it is refunded; a game still waiting simply takes this as its baseline.
      if (s.phase === "live") return finish(s, { type: "void", reason: "no feed history for a live game" });
    } else if (reading.counter > o.counterBefore) {
      // The hamster ran while we couldn't see. If a full idle window could hide in the gap, nobody can
      // know whether the game should have ended, so everyone is refunded.
      const since = o.lastMoveBefore ?? s.startTime;
      if (s.phase === "live" && reading.observedAt - since >= cfg.idleWindow) {
        return finish(s, { type: "void", reason: "feed outage, the hamster ran during the gap" });
      }
      s.lastMove = reading.observedAt;
      s.lastCounter = reading.counter;
    }
    // Not moved: he stayed still during the gap, so his last movement time is still known exactly.
  }

  if (s.lastCounter == null) {
    s.lastCounter = reading.counter;
  } else if (reading.counter > s.lastCounter) {
    s.lastMove = reading.observedAt;
    s.lastCounter = reading.counter;
  }

  if (s.phase === "waiting") {
    if (reading.observedAt >= s.lobbyClose && s.lastMove != null && s.lastMove >= s.lobbyClose) {
      s.phase = "live";
      s.startTime = s.lastMove;
      return { state: s, decision: { type: "start", startTime: s.startTime } };
    }
    return { state: s, decision: null };
  }

  if (s.phase === "live" && reading.observedAt - s.lastMove >= cfg.idleWindow) {
    return finish(s, { type: "end", lastMove: s.lastMove, counter: s.lastCounter });
  }
  return { state: s, decision: null };
}

function finish(s, decision) {
  s.phase = "done";
  return { state: s, decision };
}

/** What the hamster animation should show, from the same state the rules use. */
export function display(state, reading, now, cfg = DEFAULTS) {
  if (!isHealthy(reading, now, cfg)) return { mode: "signal-lost" };
  const sinceMove = state.lastMove == null ? Infinity : reading.observedAt - state.lastMove;
  if (sinceMove <= 15) return { mode: "running", rpm: reading.rpm };
  if (sinceMove < cfg.idleWindow) return { mode: "paused", remaining: cfg.idleWindow - sinceMove };
  return { mode: "asleep" };
}

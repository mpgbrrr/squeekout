// Payout maths of the SqueekChicken contract, in plain JavaScript, for the demo game and estimates.
// Mirrors contracts/SqueekChicken.sol (finalize, _winners, _setJackpot, weight) using floats instead of
// integer base units, so results can differ from the contract in the last few decimal places.

export const RULES = {
  grace: 12, // seconds after the last movement an exit still wins
  jackpotBps: 2000, // 20% of the pot
  jackpotGroupBps: 1000, // shared by the last 10% of winners
  bountyFlat: 5, // SQK to whoever finalizes
  bountyCapBps: 100, // at most 1% of the pot
};

/** Weight of an exit `seconds` after the start: the seconds on the wheel (at least 1). */
export function weight(seconds) {
  return Math.max(1, Math.floor(seconds));
}

/**
 * Settles a game.
 * @param buyIn SQK per player; inPot players in the pot at the start; rollover SQK carried in
 * @param exits [{ id, t }] in the order they happened, t = seconds after the start
 * @param lastMove seconds after the start of the hamster's last movement
 * @returns { pot, bounty, net, rolledOver, payouts: Map(id -> { curve, jackpot, total }) }
 */
export function settle({ buyIn, inPot, rollover = 0, exits, lastMove }, r = RULES) {
  const pot = buyIn * inPot + rollover;
  const bounty = Math.min(r.bountyFlat, (pot * r.bountyCapBps) / 10_000);
  const net = pot - bounty;
  const winners = exits.filter((e) => e.t >= 0 && e.t <= lastMove + r.grace);
  const payouts = new Map();
  if (!winners.length) return { pot, bounty, net, rolledOver: true, payouts };
  const n = winners.length;
  const groupSize = Math.max(1, Math.floor((n * r.jackpotGroupBps + 5_000) / 10_000));
  const fromTime = winners[n - groupSize].t;
  const jackpotCount = winners.filter((w) => w.t >= fromTime).length; // ties with the boundary share too
  const jackpotPool = (net * r.jackpotBps) / 10_000;
  const curvePool = net - jackpotPool;
  const sumW = winners.reduce((a, w) => a + weight(w.t), 0);
  for (const w of winners) {
    const curve = (curvePool * weight(w.t)) / sumW;
    const jackpot = w.t >= fromTime ? jackpotPool / jackpotCount : 0;
    payouts.set(w.id, { curve, jackpot, total: curve + jackpot });
  }
  return { pot, bounty, net, rolledOver: false, payouts };
}

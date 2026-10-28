// Results page: every finished game read from the contract, with who got off when, who won what and who
// was caught. Payouts are computed exactly as the contract's claimable() does.
import { createPublicClient, http, formatUnits, parseAbi } from "https://esm.sh/viem@2.21.55";
import { hardhat, sepolia } from "https://esm.sh/viem@2.21.55/chains";
import { createNames, escapeHtml } from "/names.mjs";
import { quietAddress } from "/wallet.mjs";

const $ = (id) => document.getElementById(id);
const cfg = await (await fetch("/config.json")).json();
const abi = await (await fetch("/abi.json")).json();
const GAME = cfg.gameAddress;
const chain = cfg.chainId === hardhat.id ? hardhat : sepolia;
const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
const Status = ["None", "Lobby", "Live", "Ended", "Settled", "Voided", "RolledOver"];
const PAGE = 20;

const SQK = await pub.readContract({ address: GAME, abi, functionName: "sqk" });
const SYMBOL = await pub.readContract({ address: SQK, abi: parseAbi(["function symbol() view returns (string)"]), functionName: "symbol" }).catch(() => "SQK");
const amount = (v) => `${Number(formatUnits(v, 18)).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${SYMBOL}`;
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const when = (t) => new Date(t * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

// Highlight the visitor's own wallet if it's already connected to this site (no prompt).
const me = (await quietAddress())?.toLowerCase() ?? null;
const games = []; // loaded games, newest first
const names = createNames(cfg.bots || [], () => render());

async function many(calls) {
  if (!calls.length) return [];
  try {
    return await pub.multicall({ contracts: calls, allowFailure: false });
  } catch {
    return Promise.all(calls.map((c) => pub.readContract(c))); // chains without Multicall3
  }
}

async function load(fromId, toId) {
  const ids = [];
  for (let id = fromId; id >= toId; id--) ids.push(BigInt(id));
  const heads = await many(ids.flatMap((id) => [
    { address: GAME, abi, functionName: "getGame", args: [id] },
    { address: GAME, abi, functionName: "getPlayers", args: [id] },
  ]));
  const loaded = ids.map((id, i) => ({ id, g: heads[2 * i], players: heads[2 * i + 1].map((addr) => ({ addr })) }));
  const entries = await many(loaded.flatMap(({ id, players }) => players.map((p) => ({ address: GAME, abi, functionName: "entries", args: [id, p.addr] }))));
  let k = 0;
  for (const game of loaded) {
    for (const p of game.players) {
      const [entered, left, claimed, enteredAt, exitTime] = entries[k++];
      Object.assign(p, { entered, left, claimed, enteredAt: Number(enteredAt), exitTime: Number(exitTime) });
    }
  }
  // Winners' payouts, the same way the contract's claimable() works them out.
  const winners = loaded.flatMap((game) => Status[game.g.status] !== "Settled" ? [] : game.players
    .filter((p) => inPot(game, p) && p.exitTime && p.exitTime <= Number(game.g.lastMove) + game.g.p.grace)
    .map((p) => ({ game, p })));
  const weights = await many(winners.map(({ game, p }) => ({ address: GAME, abi, functionName: "weightAt", args: [game.id, BigInt(p.exitTime)] })));
  winners.forEach(({ game, p }, i) => {
    p.payout = (game.g.curvePool * weights[i]) / game.g.sumWeights;
    if (BigInt(p.exitTime) >= game.g.jackpotFromTime) { p.payout += game.g.jackpotEach; p.jackpot = true; }
  });
  games.push(...loaded);
}

// In the pot: joined before the start and didn't leave the lobby or get off before the start.
function inPot(game, p) {
  const start = Number(game.g.startTime);
  return p.entered && !p.left && (!start || (p.enteredAt <= start && !(p.exitTime && p.exitTime < start)));
}

const LABEL = {
  Lobby: ["Lobby open", "live"], Live: ["Live now", "live"], Ended: ["Finalizing", "live"],
  Settled: ["Paid out", "settled"], Voided: ["Voided", "voided"], RolledOver: ["Everyone caught", "rolled"],
};

function card({ id, g, players }) {
  const status = Status[g.status], start = Number(g.startTime), lastMove = Number(g.lastMove);
  const [label, cls] = LABEL[status] || [status, ""];
  const pot = g.p.buyIn * BigInt(players.filter((p) => inPot({ g }, p)).length) + g.rolloverIn;
  const name = (p) => escapeHtml(names.playerName(p.addr)) + (me && p.addr.toLowerCase() === me ? " (you)" : "");
  const youCls = (p) => (me && p.addr.toLowerCase() === me ? ' class="mine"' : "");
  const facts = [
    start ? `Started <b>${when(start)}</b>` : "",
    start && lastMove ? `Ran <b>${mmss(lastMove - start)}</b>` : "",
    `Players <b>${players.filter((p) => inPot({ g }, p)).length}</b>`,
    `Pot <b>${amount(pot)}</b>`,
  ].filter(Boolean).join("");
  let body = "";
  if (status === "Settled") {
    const won = players.filter((p) => p.payout != null).sort((a, b) => (b.payout > a.payout ? 1 : b.payout < a.payout ? -1 : 0));
    const caught = players.filter((p) => inPot({ g }, p) && p.payout == null);
    const medal = (i) => ["🥇", "🥈", "🥉"][i] ?? `#${i + 1}`;
    body = `<div class="tablewrap"><table><thead><tr><th></th><th>Player</th><th>Got off at</th><th>Payout</th></tr></thead><tbody>${
      won.map((p, i) => `<tr${youCls(p)}><td>${medal(i)}</td><td>${name(p)}</td><td>+${mmss(p.exitTime - start)}</td><td>${amount(p.payout)}${p.jackpot ? '<span class="tag">JACKPOT</span>' : ""}</td></tr>`).join("")
    }${caught.map((p) => `<tr${youCls(p)}><td></td><td>${name(p)}</td><td>${p.exitTime ? `+${mmss(p.exitTime - start)} (too late)` : "still on"}</td><td class="caught">caught</td></tr>`).join("")
    }</tbody></table></div>`;
  } else if (status === "RolledOver") {
    body = `<p class="muted">Everyone was still on the wheel when he stopped, so the pot rolled into the next game. Caught: ${
      players.filter((p) => inPot({ g }, p)).map(name).join(", ") || "nobody"}.</p>`;
  } else if (status === "Voided") {
    body = `<p class="muted">${players.length ? `Everyone got their buy-in back (${players.length} player${players.length === 1 ? "" : "s"}).` : "Nobody had joined."}</p>`;
  } else {
    body = `<p class="muted">${status === "Ended" ? "He has stopped; payouts are being finalized." : "In progress."} <a href="/">Watch on the game page</a>.</p>`;
  }
  return `<article class="panel result"><div class="result-head"><h2>Game #${id}</h2><span class="pill ${cls}">${label}</span></div>
    <div class="result-facts">${facts}</div>${body}</article>`;
}

function render() {
  const shown = games.filter((x) => !(Status[x.g.status] === "Voided" && x.players.length === 0)); // skip empty lobbies that never ran
  const hidden = games.length - shown.length;
  $("games").innerHTML = shown.map(card).join("") || '<p class="muted">No games played yet.</p>';
  const played = games.filter((x) => ["Settled", "RolledOver"].includes(Status[x.g.status]));
  const paid = played.flatMap((x) => x.players).reduce((a, p) => a + (p.payout ?? 0n), 0n);
  const best = played.flatMap((x) => x.players.map((p) => ({ p, id: x.id }))).filter(({ p }) => p.payout != null)
    .sort((a, b) => (b.p.payout > a.p.payout ? 1 : -1))[0];
  const longest = played.map((x) => Number(x.g.lastMove) - Number(x.g.startTime)).sort((a, b) => b - a)[0];
  $("sGames").textContent = String(played.length);
  $("sPaid").textContent = amount(paid);
  $("sBest").textContent = best ? `${amount(best.p.payout)}` : "—";
  $("sBest").title = best ? `${names.playerName(best.p.addr)}, game #${best.id}` : "";
  $("sLongest").textContent = longest != null ? mmss(longest) : "—";
  $("status").textContent = `${hidden ? `${hidden} empty lobb${hidden === 1 ? "y" : "ies"} that never ran ${hidden === 1 ? "is" : "are"} hidden. ` : ""}Figures are for the games loaded below.`;
}

let next = Number(await pub.readContract({ address: GAME, abi, functionName: "gameCount" }));
async function more() {
  if (next < 1) return;
  $("older").disabled = true;
  const to = Math.max(1, next - PAGE + 1);
  try {
    await load(next, to);
    next = to - 1;
    render();
  } catch (e) {
    $("status").textContent = `Couldn't load games: ${e.shortMessage || e.message}`;
  }
  $("older").disabled = false;
  $("older").hidden = next < 1;
}
$("older").onclick = more;
await more();

// Squeekchain Chicken web app: the hamster cam, the current game, and the player's actions.
import { createPublicClient, createWalletClient, custom, http, formatUnits, parseAbi } from "https://esm.sh/viem@2.21.55";
import { hardhat, sepolia } from "https://esm.sh/viem@2.21.55/chains";
import { display, newGameState, readingFromStatus, step } from "/shared/rules.js";
import { createHamster } from "/hamster.mjs";

const $ = (id) => document.getElementById(id);
const cfg = await (await fetch("/config.json")).json();
const abi = await (await fetch("/abi.json")).json();
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const GAME = cfg.gameAddress;
const chain = cfg.chainId === hardhat.id ? hardhat : sepolia;
const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
const SQK = await pub.readContract({ address: GAME, abi, functionName: "sqk" });
const Status = ["None", "Lobby", "Live", "Ended", "Settled", "Voided", "RolledOver"];

let wallet = null, me = null, game = null;
const sqk = (v) => `${Number(formatUnits(v, 18)).toLocaleString("en-US", { maximumFractionDigits: 2 })} SQK`;
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const clock = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

// ---------------------------------------------------------------- hamster cam

const cam = createHamster($("cam"));
let rules = newGameState(0);
let reading = null;

async function pollFeed() {
  try {
    const res = await fetch(`${cfg.squeekApi}/v1/status`, { cache: "no-store" });
    reading = readingFromStatus(await res.json(), Math.floor(Date.now() / 1000));
  } catch {
    // keep the last reading; it ages out and the cam shows the signal as lost
  }
  const now = Math.floor(Date.now() / 1000);
  rules = step({ ...rules, phase: rules.phase === "done" ? "live" : rules.phase }, reading, now).state;
  const view = display(rules, reading, now);
  cam.update(view);
  const live = game && Status[Number(game.status)] === "Live";
  const label = {
    running: `Running${view.rpm ? ` · ${Math.round(view.rpm)} rpm` : ""}`,
    paused: live ? "Paused · game ends in" : "Paused",
    asleep: live ? "Stopped · game over" : "Resting",
    "signal-lost": "Signal lost · clock paused",
  }[view.mode];
  $("mode").textContent = label;
  $("mode").className = `mode ${view.mode}`;
  $("countdown").textContent = view.mode === "paused" ? mmss(view.remaining) : "";
}
setInterval(pollFeed, 2000);
pollFeed();

// ---------------------------------------------------------------- game state

async function loadGame() {
  const count = await pub.readContract({ address: GAME, abi, functionName: "gameCount" });
  if (count === 0n) {
    $("gameTitle").textContent = "No game yet";
    $("gameStatus").textContent = "Waiting for the first game";
    return;
  }
  const id = count;
  const g = await pub.readContract({ address: GAME, abi, functionName: "getGame", args: [id] });
  const players = await pub.readContract({ address: GAME, abi, functionName: "getPlayers", args: [id] });
  const calls = players.flatMap((p) => [
    { address: GAME, abi, functionName: "entries", args: [id, p] },
    { address: GAME, abi, functionName: "claimable", args: [id, p] },
  ]);
  let results = [];
  try {
    results = calls.length ? await pub.multicall({ contracts: calls, allowFailure: false }) : [];
  } catch {
    results = await Promise.all(calls.map((c) => pub.readContract(c))); // chains without Multicall3
  }
  game = { id, ...g, players: players.map((p, i) => ({ addr: p, entry: results[2 * i], claimable: results[2 * i + 1] })) };
  if (rules.earliestStart !== Number(g.p.earliestStart)) rules = { ...rules, earliestStart: Number(g.p.earliestStart) };
  render();
}

function render() {
  const g = game, status = Status[Number(g.status)], now = Math.floor(Date.now() / 1000);
  const lobby = status === "Lobby";
  const started = ["Live", "Ended", "Settled", "RolledOver"].includes(status);
  const start = Number(g.startTime);
  const late = (e) => started && Number(e.enteredAt) > start;
  const leftEarly = (e) => started && Number(e.exitTime) && Number(e.exitTime) < start;
  $("gameTitle").textContent = `Game #${g.id}`;
  $("gameStatus").textContent = {
    Lobby: "Lobby open: entries close when Squeektoshi starts running",
    Live: "Live: the wheel is turning", Ended: "Game over: finalizing payouts", Settled: "Paid out",
    Voided: "Voided: everyone refunded", RolledOver: "Everyone caught: pot rolled over",
  }[status];
  const inPot = g.players.filter((p) => !p.entry.left && !late(p.entry) && !leftEarly(p.entry)).length;
  $("fBuyIn").textContent = sqk(g.p.buyIn);
  $("fPot").textContent = sqk(g.p.buyIn * BigInt(inPot) + g.rolloverIn);
  $("fPlayers").textContent = String(inPot);
  const earliest = Number(g.p.earliestStart);
  if (lobby && now < earliest) { $("fClockLbl").textContent = "Can start in"; $("fClock").textContent = mmss(earliest - now); }
  else if (lobby) { $("fClockLbl").textContent = "Starts"; $("fClock").textContent = "when he runs"; }
  else if (status === "Live") { $("fClockLbl").textContent = "Started at"; $("fClock").textContent = clock(start); }
  else if (Number(g.lastMove)) { $("fClockLbl").textContent = "Hamster stopped at"; $("fClock").textContent = clock(Number(g.lastMove)); }
  else { $("fClockLbl").textContent = "Started at"; $("fClock").textContent = start ? clock(start) : "—"; }

  const settled = status === "Settled";
  $("players").innerHTML = g.players.length ? g.players.map((p) => {
    const e = p.entry;
    const off = e.left ? "left the lobby" : late(e) ? "joined after the start (refunded)" : leftEarly(e) ? "left before the start (refunded)"
      : Number(e.exitTime) ? (start ? `+${mmss(Math.max(0, Number(e.exitTime) - start))}` : clock(Number(e.exitTime))) : "still on";
    const pay = e.claimed ? "claimed" : p.claimable > 0n ? sqk(p.claimable) : settled ? "caught" : "—";
    return `<tr><td>${short(p.addr)}${me && p.addr.toLowerCase() === me.toLowerCase() ? " (you)" : ""}</td><td>${off}</td><td>${pay}</td></tr>`;
  }).join("") : `<tr><td colspan="3" class="muted">No players yet.</td></tr>`;

  const mine = me && g.players.find((p) => p.addr.toLowerCase() === me.toLowerCase());
  const inLobby = mine && lobby && !mine.entry.left && !Number(mine.entry.exitTime);
  const btn = $("mainAction");
  $("leave").hidden = !inLobby;
  $("finalize").hidden = status !== "Ended";
  btn.disabled = false;
  if (!me) { btn.textContent = "Connect to play"; btn.onclick = connect; $("youStatus").textContent = "Connect your wallet to play."; return; }
  if (mine && mine.claimable > 0n) {
    btn.textContent = `Claim ${sqk(mine.claimable)}`; btn.onclick = () => tx("claim", [g.id]);
    $("youStatus").textContent = status === "Voided" ? "This game was voided, so your buy-in is refunded."
      : late(mine.entry) ? "Your entry landed after Squeektoshi started running, so it's refunded."
      : leftEarly(mine.entry) ? "You left before the start, so your buy-in is refunded." : "You got off in time.";
  } else if (lobby && (!mine || mine.entry.left)) {
    btn.textContent = `Enter for ${sqk(g.p.buyIn)}`; btn.onclick = () => enter(g);
    $("youStatus").textContent = "Buy in before Squeektoshi starts running. Then get off the wheel before he stops: the longer you stay, the more you win.";
  } else if (inLobby) {
    btn.textContent = "You're in"; btn.disabled = true;
    $("youStatus").textContent = now < earliest
      ? `You're in. The game starts at his first run after ${clock(earliest)}.`
      : "You're in. The game starts the moment Squeektoshi runs.";
  } else if (mine && status === "Live" && !Number(mine.entry.exitTime) && !late(mine.entry)) {
    btn.textContent = "Get off the wheel"; btn.onclick = () => tx("exit", [g.id]);
    $("youStatus").textContent = "You're on the wheel. Get off while he's still running.";
  } else {
    btn.textContent = mine ? (Number(mine.entry.exitTime) ? "You got off" : "Caught on the wheel") : "Watching";
    btn.disabled = true;
    $("youStatus").textContent = mine ? (settled && !mine.claimable && !mine.entry.claimed ? "You were still on when he stopped." : "Waiting for the game to finish.")
      : "A new game opens as soon as this one finishes.";
  }
}

// ---------------------------------------------------------------- wallet actions

async function connect() {
  if (!window.ethereum) { msg("Install a browser wallet such as MetaMask to play.", true); return; }
  wallet = createWalletClient({ chain, transport: custom(window.ethereum) });
  [me] = await wallet.requestAddresses();
  try { await wallet.switchChain({ id: chain.id }); } catch { msg("Switch your wallet to the Sepolia test network.", true); }
  $("account").textContent = short(me);
  $("connect").hidden = true;
  await loadGame();
}

async function tx(functionName, args, address = GAME, contractAbi = abi) {
  msg("Confirm in your wallet…");
  try {
    const { request } = await pub.simulateContract({ account: me, address, abi: contractAbi, functionName, args });
    const hash = await wallet.writeContract(request);
    msg("Waiting for the transaction to confirm…");
    await pub.waitForTransactionReceipt({ hash });
    msg("Done.");
  } catch (e) {
    msg(e.shortMessage || e.message || String(e), true);
    throw e;
  } finally {
    await loadGame();
  }
}

async function enter(g) {
  const [bal, allowance] = await Promise.all([
    pub.readContract({ address: SQK, abi: erc20, functionName: "balanceOf", args: [me] }),
    pub.readContract({ address: SQK, abi: erc20, functionName: "allowance", args: [me, GAME] }),
  ]);
  if (bal < g.p.buyIn) { msg(`You need ${sqk(g.p.buyIn)} on Sepolia; you have ${sqk(bal)}.`, true); return; }
  if (allowance < g.p.buyIn) await tx("approve", [GAME, g.p.buyIn], SQK, erc20);
  await tx("enter", [g.id]);
}

function msg(text, error = false) {
  $("msg").textContent = text;
  $("msg").className = error ? "msg error" : "msg";
}

$("connect").onclick = connect;
$("leave").onclick = () => tx("leaveLobby", [game.id]);
$("finalize").onclick = () => tx("finalize", [game.id]);

// ---------------------------------------------------------------- watcher log

async function loadLog() {
  try {
    const entries = await (await fetch("/log", { cache: "no-store" })).json();
    const shown = entries.filter((e) => ["decided", "posted", "finalized", "feed_error", "feed_recovered", "started"].includes(e.event)).slice(-30).reverse();
    $("log").innerHTML = shown.length ? shown.map((e) => {
      const what = e.type ? `${e.type}${e.reason ? `: ${e.reason}` : ""}` : e.event.replace("_", " ");
      return `<div>${new Date(e.at).toLocaleTimeString()} · <b>${what}</b>${typeof e.game === "number" ? ` · game #${e.game}` : ""}${e.tx ? ` · <a href="https://sepolia.etherscan.io/tx/${e.tx}" target="_blank" rel="noopener">tx</a>` : ""}</div>`;
    }).join("") : "<div>No decisions yet.</div>";
  } catch {
    $("log").innerHTML = "<div>The watcher log is unavailable.</div>";
  }
}

setInterval(loadGame, 6000);
setInterval(loadLog, 10000);
setInterval(() => game && render(), 1000);
loadGame();
loadLog();

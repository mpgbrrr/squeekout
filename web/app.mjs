// Squeekchain Chicken web app: the hamster cam, the current game, and the player's actions.
import { createPublicClient, createWalletClient, custom, http, formatUnits, parseAbi } from "https://esm.sh/viem@2.21.55";
import { hardhat, sepolia } from "https://esm.sh/viem@2.21.55/chains";
import { display, newGameState, readingFromStatus, step } from "/shared/rules.js";
import { createHamster } from "/hamster.mjs";
import { createDemo } from "/demo.mjs";

const $ = (id) => document.getElementById(id);
const cfg = await (await fetch("/config.json")).json();
const abi = await (await fetch("/abi.json")).json();
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function symbol() view returns (string)",
  "function MAX_MINT() view returns (uint256)", // only on TestSQK, the free-mint test token
  "function mint(address,uint256)",
]);
const GAME = cfg.gameAddress;
const chain = cfg.chainId === hardhat.id ? hardhat : sepolia;
const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
const SQK = await pub.readContract({ address: GAME, abi, functionName: "sqk" });
const SYMBOL = await pub.readContract({ address: SQK, abi: erc20, functionName: "symbol" }).catch(() => "SQK");
const TEST_TOKEN = await pub.readContract({ address: SQK, abi: erc20, functionName: "MAX_MINT" }).then(() => true, () => false);
const FAUCET = 1000n * 10n ** 18n;
const Status = ["None", "Lobby", "Live", "Ended", "Settled", "Voided", "RolledOver"];

let wallet = null, me = null, game = null;
let demo = null; // a practice game in progress takes over the cam and the game card
const sqk = (v) => `${Number(formatUnits(v, 18)).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${SYMBOL}`;
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const clock = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

// ---------------------------------------------------------------- hamster cam

// How long Squeektoshi has been running in his current run, from the readings this page has seen.
// A run that was already going when the page opened is marked partial ("at least this long").
// A run lasts from when he starts after a rest until he really stops: breaks shorter than the idle
// window (and feed drops) are part of the run. "+" means the run began before this page saw it.
function createRunClock() {
  let since = null, partial = false, prevMode = null;
  return {
    update(view, lastMove, now) {
      if (view.mode === "running" && since == null) {
        since = lastMove ?? now;
        partial = prevMode !== "asleep";
      }
      if (view.mode === "asleep") since = null;
      prevMode = view.mode;
    },
    text(now) {
      return since == null ? "" : `${mmss(Math.max(0, now - since))}${partial ? "+" : ""}`;
    },
  };
}

// ---------------------------------------------------------------- on-cam overlay

// Hamster moments (breaks, runs, feed drops) seen by this page, for the activity feed.
function createMoments() {
  const list = [];
  let prev = null;
  return {
    list,
    update(mode, t, live = false) {
      if (prev !== null && mode !== prev) {
        const text = {
          paused: ["Squeektoshi took a break", "ham"], running: [prev === "signal-lost" ? "Feed back" : "He's running again", "ham"],
          asleep: ["Squeektoshi stopped", "ham"], "signal-lost": [live ? "Feed lost: game clock paused" : "Feed lost: no word from the wheel", "bad"],
        }[mode];
        if (text) list.push({ t, text: text[0], kind: text[1] });
        if (list.length > 30) list.shift();
      }
      prev = mode;
    },
    reset() { list.length = 0; prev = null; },
  };
}
const liveMoments = createMoments();
let lastFeedKey = "";

// The game-over line goes on top of the feed.
function gameOver(events, stoppedAt, caught) {
  const t = Math.max(0, ...events.map((e) => e.t ?? 0)) + 1;
  return { t, when: "END", text: `Game over: he stopped at +${mmss(stoppedAt)}, ${caught} caught`, kind: "bad" };
}

// count: players still on (or in the lobby, or caught) out of total in the game (null in the lobby);
// events: [{ t, text, kind }]; fmt(t) labels a time.
function renderHud(count, total, label, events, fmt) {
  $("hudCount").hidden = count == null;
  if (count != null) {
    $("hudOn").textContent = String(count);
    $("hudOf").textContent = total == null ? "" : `/${total}`;
    $("hudLbl").textContent = label;
  }
  const latest = events.filter((e) => e.t != null).sort((a, b) => b.t - a.t).slice(0, 3);
  const key = latest.map((e) => `${e.t}|${e.text}`).join("/");
  $("hudFeed").hidden = latest.length === 0;
  if (key === lastFeedKey) return;
  const fresh = latest[0] && !lastFeedKey.startsWith(`${latest[0].t}|${latest[0].text}`);
  lastFeedKey = key;
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  $("hudFeed").innerHTML = latest.map((e, i) =>
    `<li class="${i === 0 && fresh ? "fresh" : ""}"><span class="when">${e.when ?? fmt(e.t)}</span><span class="${e.kind || ""}">${esc(e.text)}</span></li>`).join("");
}

function showTimer(view, runClock, now, counting) {
  if (view.mode === "running") {
    $("countdown").textContent = runClock.text(now);
    $("timerLbl").textContent = "this run";
  } else if (view.mode === "paused" && counting) {
    $("countdown").textContent = mmss(view.remaining);
    $("timerLbl").textContent = runClock.text(now) && `run ${runClock.text(now)}`;
  } else if (view.mode !== "asleep" && runClock.text(now)) {
    $("countdown").textContent = runClock.text(now);
    $("timerLbl").textContent = "this run";
  } else {
    $("countdown").textContent = "";
    $("timerLbl").textContent = "";
  }
}

const cam = createHamster($("cam"));
let rules = newGameState(0);
let reading = null;
let liveView = { mode: "asleep" };
const liveRun = createRunClock();

async function pollFeed() {
  try {
    const res = await fetch(`${cfg.squeekApi}/v1/status`, { cache: "no-store" });
    reading = readingFromStatus(await res.json(), Math.floor(Date.now() / 1000));
  } catch {
    // keep the last reading; it ages out and the cam shows the signal as lost
  }
  const now = Math.floor(Date.now() / 1000);
  rules = step({ ...rules, phase: rules.phase === "done" ? "live" : rules.phase }, reading, now).state;
  if (demo) return;
  const view = display(rules, reading, now);
  liveRun.update(view, rules.lastMove, now);
  liveView = view;
  cam.update(view);
  const live = game && Status[Number(game.status)] === "Live";
  const label = {
    running: `Running${view.rpm ? ` · ${Math.round(view.rpm)} rpm` : ""}`,
    paused: live ? "Paused · game ends in" : "Paused",
    asleep: live ? "Stopped · game over" : "Resting",
    "signal-lost": live ? "Signal lost · game clock paused" : "Signal lost · no word from the wheel",
  }[view.mode];
  $("mode").textContent = label;
  $("mode").className = `mode ${view.mode}`;
  showTimer(view, liveRun, now, true);
  liveMoments.update(view.mode, now, live);
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
  if (demo) return;
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
  else if (status === "Live") { $("fClockLbl").textContent = "Game time"; $("fClock").textContent = mmss(Math.max(0, now - start)); }
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

  // On-cam overlay: players still on, and the latest events.
  const who = (p) => (me && p.addr.toLowerCase() === me.toLowerCase() ? "You" : short(p.addr));
  const stillOn = g.players.filter((p) => !p.entry.left && !late(p.entry) && !leftEarly(p.entry) && !Number(p.entry.exitTime)).length;
  const lastMove = Number(g.lastMove);
  const caught = g.players.filter((p) => !p.entry.left && !late(p.entry) && !leftEarly(p.entry)
    && (!Number(p.entry.exitTime) || Number(p.entry.exitTime) > lastMove + Number(g.p.grace))).length;
  const hudCount = lobby ? g.players.filter((p) => !p.entry.left).length : status === "Live" ? stillOn : caught;
  const hudLabel = lobby ? "in the lobby" : status === "Live" ? "still on" : status === "Voided" ? "refunded" : "caught";
  const events = [...liveMoments.list];
  for (const p of g.players) {
    if (Number(p.entry.enteredAt)) events.push({ t: Number(p.entry.enteredAt), text: `${who(p)} joined` });
    const x = Number(p.entry.exitTime);
    const tooLate = lastMove && x > lastMove + Number(g.p.grace);
    if (x && start && x >= start) events.push({ t: x, text: `${who(p)} got off${tooLate ? " too late" : ""}`, kind: tooLate ? "bad" : "off" });
  }
  if (start) events.push({ t: start, text: "Game on! Entries closed", kind: "ham" });
  if (lastMove) events.push(gameOver(events, lastMove - start, caught));
  if (status === "Voided") events.push({ t: now, text: "Game voided: everyone refunded", kind: "bad" });
  renderHud(hudCount, lobby ? null : inPot, hudLabel, events, (t) => (start && t >= start ? `+${mmss(t - start)}` : new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })));

  const mine = me && g.players.find((p) => p.addr.toLowerCase() === me.toLowerCase());
  const inLobby = mine && lobby && !mine.entry.left && !Number(mine.entry.exitTime);
  const btn = $("mainAction");
  $("leave").hidden = !inLobby;
  $("faucet").hidden = !(TEST_TOKEN && me);
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

// ---------------------------------------------------------------- demo mode

let demoSpeed = 5, demoTimer = null, demoRun = null;
const demoMoments = createMoments();
const LIVE_HELP = `The cartoon follows Squeekchain's live wheel data. Watch the real hamster at <a href="https://squeekchain.com" target="_blank" rel="noopener">squeekchain.com</a>.`;
const demoSqk = (n) => `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} SQK`;

function startDemo() {
  demo = createDemo();
  demoRun = createRunClock();
  demoMoments.reset();
  lastFeedKey = "";
  $("demoBanner").hidden = false;
  $("speed").hidden = false;
  $("demoToggle").textContent = "Back to the real game";
  $("modeHelp").textContent = "Demo: this hamster is simulated, with random runs and breaks like the real Squeektoshi's.";
  $("leave").hidden = true;
  $("finalize").hidden = true;
  msg("");
  clearInterval(demoTimer);
  demoTimer = setInterval(() => { demo.tick(0.25 * demoSpeed); renderDemo(); }, 250);
  renderDemo();
}

function stopDemo() {
  clearInterval(demoTimer);
  demoTimer = null;
  demo = null;
  lastFeedKey = "";
  $("demoBanner").hidden = true;
  $("speed").hidden = true;
  $("demoToggle").textContent = "Play a demo game";
  $("modeHelp").innerHTML = LIVE_HELP;
  pollFeed();
  if (game) render(); else loadGame();
}

function renderDemo() {
  const s = demo.state, view = demo.view(), players = demo.players, you = players[0];
  const since = (t) => `+${mmss(Math.max(0, t))}`;
  demoRun.update(view, s.rules.lastMove, s.t);
  cam.update(view);
  $("mode").textContent = {
    running: `Running${view.rpm ? ` · ${Math.round(view.rpm)} rpm` : ""}`,
    paused: s.phase === "live" ? "Paused · game ends in" : "Resting",
    asleep: s.phase === "ended" ? "Stopped · game over" : "Resting",
    "signal-lost": "Signal lost · clock paused",
  }[view.mode];
  $("mode").className = `mode ${view.mode}`;
  showTimer(view, demoRun, s.t, s.phase === "live");
  if (s.phase !== "lobby") demoMoments.update(view.mode, s.t);
  const stillOn = players.filter((p) => p.exit == null).length;
  const events = [...demoMoments.list];
  if (s.start != null) events.push({ t: s.start, text: "Game on! Entries closed", kind: "ham" });
  for (const p of players) {
    if (p.exit == null) continue;
    const tooLate = s.result && !s.result.payouts.has(p.id);
    events.push({ t: s.start + p.exit, text: `${p.name} got off${tooLate ? " too late" : ""}`, kind: tooLate ? "bad" : "off" });
  }
  const caught = s.result ? players.filter((p) => !s.result.payouts.has(p.id)).length : stillOn;
  if (s.phase === "ended") events.push(gameOver(events, s.lastMove - s.start, caught));
  renderHud(s.phase === "lobby" ? players.length : s.phase === "live" ? stillOn : caught, s.phase === "lobby" ? null : players.length, s.phase === "lobby" ? "in the lobby" : s.phase === "live" ? "still on" : "caught",
    events, (t) => (s.start != null && t >= s.start ? `+${mmss(t - s.start)}` : "lobby"));

  $("gameTitle").textContent = "Demo game";
  $("gameStatus").textContent = { lobby: "Lobby open: entries close when he starts running", live: "Live: the wheel is turning", ended: "Game over" }[s.phase];
  $("fBuyIn").textContent = demoSqk(demo.buyIn);
  $("fPot").textContent = demoSqk(demo.buyIn * players.length);
  $("fPlayers").textContent = String(players.length);
  if (s.phase === "lobby") { $("fClockLbl").textContent = "Starts"; $("fClock").textContent = "when he runs"; }
  else if (s.phase === "live") { $("fClockLbl").textContent = "Game time"; $("fClock").textContent = mmss(s.t - s.start); }
  else { $("fClockLbl").textContent = "He stopped at"; $("fClock").textContent = since(s.lastMove - s.start); }

  const payout = (p) => s.result?.payouts.get(p.id)?.total;
  // Who got off first at the top, then anyone on their way off, then everyone still on.
  const order = (p) => (p.exit != null ? p.exit : p.landsAt != null ? 1e9 : 2e9);
  $("players").innerHTML = [...players].sort((a, b) => order(a) - order(b)).map((p) => {
    const off = p.exit != null ? since(p.exit) : p.landsAt != null ? "getting off…" : "still on";
    const pay = s.phase !== "ended" ? "—" : payout(p) ? demoSqk(payout(p)) : "caught";
    return `<tr><td>${p.name}</td><td>${off}</td><td>${pay}</td></tr>`;
  }).join("");

  const btn = $("mainAction");
  btn.disabled = false;
  if (s.phase === "lobby") {
    btn.textContent = "Waiting for him to run"; btn.disabled = true;
    $("youStatus").textContent = `You're in for ${demoSqk(demo.buyIn)} with ${players.length - 1} other players. The game starts the moment Squeektoshi runs.`;
  } else if (s.phase === "live" && you.exit == null && you.landsAt == null) {
    btn.textContent = "Get off the wheel"; btn.onclick = () => { demo.exitYou(); renderDemo(); };
    const est = demo.ifYouGotOffNow();
    $("youStatus").textContent = `If he stopped right now and you'd got off, you'd win about ${demoSqk(est)} (${(est / demo.buyIn).toFixed(2)}×). `
      + "Everyone who stays on longer than you will take a bigger share.";
  } else if (s.phase === "live") {
    btn.textContent = you.exit == null ? "Getting off…" : "You got off"; btn.disabled = true;
    $("youStatus").textContent = you.exit == null ? "Your exit is waiting for the next block." : `You got off at ${since(you.exit)}. Now see who gets caught.`;
  } else {
    btn.textContent = "Play again"; btn.onclick = startDemo;
    const won = payout(you), jackpot = s.result.payouts.get("you")?.jackpot;
    $("youStatus").textContent = s.result.rolledOver ? "Everyone was caught, so the pot rolls into the next game."
      : won ? `You got off at ${since(you.exit)} and won ${demoSqk(won)} (${(won / demo.buyIn).toFixed(2)}×)${jackpot ? ", including a jackpot share" : ""}.`
      : you.exit != null ? `Too late: you got off at ${since(you.exit)}, but he'd already stopped at ${since(s.lastMove - s.start)}. Caught.`
      : "Caught! You were still on the wheel when he stopped.";
  }
}

$("demoToggle").onclick = () => (demo ? stopDemo() : startDemo());
for (const b of $("speed").querySelectorAll("button")) {
  b.onclick = () => {
    demoSpeed = Number(b.dataset.speed);
    for (const o of $("speed").querySelectorAll("button")) o.setAttribute("aria-pressed", String(o === b));
  };
}

// ---------------------------------------------------------------- wallet actions

async function connect() {
  if (!window.ethereum) { msg("Install a browser wallet such as MetaMask to play.", true); return; }
  wallet = createWalletClient({ chain, transport: custom(window.ethereum) });
  [me] = await wallet.requestAddresses();
  try { await wallet.switchChain({ id: chain.id }); } catch { msg("Switch your wallet to the Sepolia test network.", true); }
  $("account").textContent = short(me);
  $("connect").hidden = true;
  $("faucet").hidden = !TEST_TOKEN;
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
  if (bal < g.p.buyIn) {
    msg(`You need ${sqk(g.p.buyIn)} on Sepolia; you have ${sqk(bal)}.${TEST_TOKEN ? ` Use "Get ${sqk(FAUCET)}" first.` : ""}`, true);
    return;
  }
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
$("faucet").textContent = `Get ${sqk(FAUCET)} (free test token)`;
$("faucet").onclick = () => tx("mint", [me, FAUCET], SQK, erc20);

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
setInterval(() => {
  if (game) render();
  // Keep the run clock ticking between feed readings.
  if (!demo) showTimer(liveView, liveRun, Math.floor(Date.now() / 1000), true);
}, 1000);
loadGame();
loadLog();

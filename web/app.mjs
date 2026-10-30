// Squeek Out web app: the hamster cam, the current game, and the player's actions.
import { createPublicClient, createWalletClient, custom, http, formatUnits, parseAbi } from "https://esm.sh/viem@2.21.55";
import { hardhat, sepolia } from "https://esm.sh/viem@2.21.55/chains";
import { DEFAULTS, display, newGameState, readingFromStatus, step } from "/shared/rules.js";
import { countsInPot, settle } from "/shared/payouts.js";
import { createHamster } from "/hamster.mjs";
import { createDemo } from "/demo.mjs";
import { signPermit } from "/permit.mjs";
import { createFinale } from "/finale.mjs";
import { createNames, escapeHtml, short } from "/names.mjs";
import { createWallet, installedWallets, walletErrorText } from "/wallet.mjs";
import { createAlerts } from "/alerts.mjs";

const $ = (id) => document.getElementById(id);
// Browser storage that never throws (private windows, blocked storage).
const store = (kind, key, value) => { try { return value === undefined ? window[kind].getItem(key) : window[kind].setItem(key, value); } catch { return null; } };
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
// When an ENS name arrives for the connected account, show it in the header.
const names = createNames(cfg.bots || [], () => { const n = me && names.ensName(me); if (n) $("account").textContent = n; });
const playerName = names.playerName;
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
    /** Starts from the watcher's record of this run, for a page opened mid-run. */
    seed(runSince, runPartial) {
      since = runSince;
      partial = runPartial;
      prevMode = "running";
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
const finale = createFinale();
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
  const stepped = step({ ...rules, phase: rules.phase === "done" ? "live" : rules.phase }, reading, now);
  rules = stepped.state;
  if (stepped.decision?.type === "end") celebrateLive(stepped.decision.lastMove);
  // He just started: if the open game is in its lobby with enough players, it's starting now.
  if (stepped.decision?.type === "start" && game && Status[Number(game.status)] === "Lobby"
    && game.players.filter((p) => !p.entry.left).length >= Number(game.p.minPlayers)) alertStart(game);
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
// Opened mid-game? Start from the watcher's record of his last movement and this run, so the break
// countdown and the run clock are right straight away instead of starting from when the page opened.
try {
  const h = await (await fetch("/hamster", { cache: "no-store" })).json();
  if (h.lastMove != null && Date.now() / 1000 - h.lastMove < (h.idleWindow ?? DEFAULTS.idleWindow)) {
    rules = { ...rules, epoch: h.epoch, lastCounter: h.lastCounter, lastMove: h.lastMove };
    if (h.runSince != null) liveRun.seed(h.runSince, h.runPartial);
  }
} catch {
  // No watcher record (for example a static preview): the clocks start from what this page sees.
}
setInterval(pollFeed, 2000);
pollFeed();

// ---------------------------------------------------------------- start alerts

// An alarm the moment a game starts, so nobody who joined while he slept misses it (toggle in the game card).
const alerts = createAlerts({
  vapidPublicKey: cfg.vapidPublicKey || null,
  getAddress: () => me,
  onChange({ on, note }) {
    const b = $("alertToggle");
    b.textContent = on ? "🔔 Start alerts: on" : "🔕 Start alerts: off";
    b.setAttribute("aria-pressed", String(on));
    $("alertNote").textContent = note || (on ? "" : "Get an alarm the moment Squeektoshi starts, so you never miss a game you joined.");
  },
});
$("alertToggle").onclick = () => alerts.toggle();
alerts.restore();

let alertBannerTimer = null;
function showAlertBanner(text) {
  const el = $("alertBanner");
  el.textContent = text;
  el.hidden = false;
  el.onclick = () => { el.hidden = true; };
  clearTimeout(alertBannerTimer);
  alertBannerTimer = setTimeout(() => { el.hidden = true; }, 20_000);
}

const startAlerted = new Set(); // game ids already alerted on this page
function alertStart(g) {
  if (demo || !g || startAlerted.has(g.id)) return;
  startAlerted.add(g.id);
  const mine = me && g.players.some((p) => p.addr.toLowerCase() === me.toLowerCase() && !p.entry.left);
  const lateWindow = Number(g.p.lateEntryWindow ?? 0);
  const join = lateWindow ? ` Jump on in the next ${Math.round(lateWindow / 60) || 1} min, before anyone gets off.` : "";
  showAlertBanner(mine ? `🐹 He's running! You're on the wheel in game #${g.id}` : `🐹 He's running! Game #${g.id} is on.${join}`);
  alerts.ring({
    title: mine ? "You're on the wheel!" : "Squeektoshi is running!",
    body: mine ? `Game #${g.id} is live. Get off before he stops.` : `Game #${g.id} just started.${join}`,
    tag: `squeekout-game-${g.id}`, // same as the watcher's push, so a phone shows one notification
  });
}

// ---------------------------------------------------------------- livestream

// The real Squeektoshi on X, instead of the cartoon. The player loads only when someone picks it. The
// broadcast is the one the watcher is configured with (STREAM_BROADCAST_ID).
const broadcastId = cfg.streamBroadcastId || null;
const LIVE_HELP = `The cartoon follows Squeekchain's live wheel data. Watch the real hamster at <a href="https://squeekchain.com" target="_blank" rel="noopener">squeekchain.com</a>.`;
const STREAM_HELP = "Live from Squeekchain's stream on X. The status and clocks follow Squeekchain's wheel data, which is what the game runs on.";
let camView = store("localStorage", "camView") === "live" ? "live" : "cartoon";

function setCamView(view) {
  if (demo) view = "cartoon"; // the demo plays on the cartoon
  camView = view;
  const live = view === "live", wrap = $("liveWrap");
  $("camwrap").classList.toggle("live", live);
  wrap.hidden = !live;
  for (const b of document.querySelectorAll(".view-toggle button")) b.setAttribute("aria-pressed", String(b.dataset.view === view));
  if (!demo) $("modeHelp").innerHTML = live ? STREAM_HELP : LIVE_HELP;
  if (!live) { wrap.replaceChildren(); return; } // stop the player when hidden
  const src = broadcastId ? `https://studio.x.com/embed/broadcast/${broadcastId}` : null;
  if (wrap.firstElementChild?.src === src) return;
  if (!src) { wrap.innerHTML = "<p>The livestream isn't available right now.</p>"; return; }
  const frame = Object.assign(document.createElement("iframe"), {
    src, title: "Squeektoshi live on X", allow: "autoplay; fullscreen; picture-in-picture", allowFullscreen: true, referrerPolicy: "strict-origin-when-cross-origin",
  });
  wrap.replaceChildren(frame);
}

for (const b of document.querySelectorAll(".view-toggle button")) {
  b.onclick = () => { setCamView(b.dataset.view); if (!demo) store("localStorage", "camView", b.dataset.view); };
}
setCamView(camView);

// ---------------------------------------------------------------- game state

const seenStatus = new Map(); // game id -> status last seen by this page

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
  // The entries getter returns a plain list; name its fields.
  const entry = ([entered, left, claimed, enteredAt, exitTime]) => ({ entered, left, claimed, enteredAt, exitTime });
  game = { id, ...g, players: players.map((p, i) => ({ addr: p, entry: entry(results[2 * i]), claimable: results[2 * i + 1] })) };
  // The game ended while this page was open: celebrate, if the feed didn't already trigger it.
  const status = Status[Number(g.status)], before = seenStatus.get(id);
  seenStatus.set(id, status);
  if (before === "Live" && ["Ended", "Settled", "RolledOver"].includes(status)) celebrateLive(Number(g.lastMove));
  if (before === "Lobby" && status === "Live") alertStart(game);
  updateFinaleClaim().catch(() => {});
  updateUnclaimed(id).catch(() => {});
  if (rules.earliestStart !== Number(g.p.earliestStart)) rules = { ...rules, earliestStart: Number(g.p.earliestStart) };
  render();
}

// The contract's in-pot rule for a game read from chain (entries are refunded if they don't count).
const potRules = (g) => ({ startTime: Number(g.startTime), lateEntryWindow: Number(g.p.lateEntryWindow ?? 0), firstExitTime: Number(g.firstExitTime ?? 0) });
const entryTimes = (e) => ({ entered: e.entered, left: e.left, enteredAt: Number(e.enteredAt), exitTime: Number(e.exitTime) });
// Seconds late entries stay open in a live game (they also close at the first exit), or null when closed.
function lateEntryLeft(g, now) {
  if (!g || Status[Number(g.status)] !== "Live" || Number(g.firstExitTime ?? 0)) return null;
  const left = Number(g.startTime) + Number(g.p.lateEntryWindow ?? 0) - now;
  return left >= 0 ? left : null;
}

function render() {
  if (demo) return;
  const g = game, status = Status[Number(g.status)], now = Math.floor(Date.now() / 1000);
  const lobby = status === "Lobby";
  const started = ["Live", "Ended", "Settled", "RolledOver"].includes(status);
  const start = Number(g.startTime);
  const late = (e) => started && Number(e.enteredAt) > start && !countsInPot(entryTimes(e), potRules(g)); // joined too late: refunded
  const lateLeft = lateEntryLeft(g, now);
  const leftEarly = (e) => started && Number(e.exitTime) && Number(e.exitTime) < start;
  $("gameTitle").textContent = `Game #${g.id}`;
  $("gameStatus").textContent = {
    Lobby: "Lobby open: the game starts when Squeektoshi runs",
    Live: lateLeft != null ? `Live: late entries open for ${mmss(lateLeft)}, or until someone gets off` : "Live: the wheel is turning", Ended: "Game over: finalizing payouts", Settled: "Paid out",
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
  const over = ["Ended", "Settled", "RolledOver"].includes(status); // he has stopped: anyone still on was caught
  $("players").innerHTML = g.players.length ? g.players.map((p) => {
    const e = p.entry;
    const joinedLate = started && Number(e.enteredAt) > start ? ` · joined +${mmss(Number(e.enteredAt) - start)}` : "";
    const off = e.left ? "left the lobby" : late(e) ? "joined too late (refunded)" : leftEarly(e) ? "left before the start (refunded)"
      : (Number(e.exitTime) ? (start ? `+${mmss(Math.max(0, Number(e.exitTime) - start))}` : clock(Number(e.exitTime)))
        + (over && Number(e.exitTime) > Number(g.lastMove) + Number(g.p.grace) ? " · too late" : "")
      : over ? "never got off" : "still on") + joinedLate;
    const pay = e.claimed ? "claimed" : p.claimable > 0n ? sqk(p.claimable) : settled || status === "RolledOver" ? "Caught" : "—";
    return `<tr><td>${escapeHtml(playerName(p.addr))}${me && p.addr.toLowerCase() === me.toLowerCase() ? " (you)" : ""}</td><td>${off}</td><td>${pay}</td></tr>`;
  }).join("") : `<tr><td colspan="3" class="muted">No players yet.</td></tr>`;

  // On-cam overlay: players still on, and the latest events.
  const who = (p) => (me && p.addr.toLowerCase() === me.toLowerCase() ? "You" : playerName(p.addr));
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
  const lateWindow = Number(g.p.lateEntryWindow ?? 0);
  if (start) events.push({ t: start, text: lateWindow ? `Game on! Late entries open ${mmss(lateWindow)}, until someone gets off` : "Game on! Entries closed", kind: "ham" });
  if (start && lateWindow && lateLeft == null && status !== "Voided") {
    const closedAt = Number(g.firstExitTime) || start + lateWindow;
    if (closedAt <= now) events.push({ t: closedAt + 0.5, text: "Entries closed", kind: "ham" });
  }
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
  } else if (lateLeft != null && (!mine || mine.entry.left)) {
    btn.textContent = `Jump on for ${sqk(g.p.buyIn)}`; btn.onclick = () => enter(g);
    $("youStatus").textContent = `He's running! Late entries are open for ${mmss(lateLeft)} more, or until someone gets off. Your time on the wheel counts from when you get on.`;
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
      : status === "Live" ? "Entries for this game have closed. The next lobby opens as soon as he stops."
      : "A new game opens as soon as this one finishes.";
  }
}

// ---------------------------------------------------------------- end of a game

// Seconds until a live game ends if he stays still, while he's on a break; otherwise null.
function liveSecondsLeft(now) {
  const live = game && Status[Number(game.status)] === "Live";
  return live && liveView.mode === "paused" && rules.lastMove != null ? rules.lastMove + DEFAULTS.idleWindow - now : null;
}

const celebrated = new Set(); // game ids already celebrated on this page
let finaleGame = null; // the celebrated game you won, while its celebration offers a claim

// The celebration's claim button: waits for the game to be finalized on chain, then claims.
async function updateFinaleClaim() {
  const btn = $("finaleClaim");
  const open = $("finale").open && finaleGame != null && me && !demo;
  btn.hidden = !open;
  $("finaleClose").className = open ? "secondary" : "primary"; // one main button at a time
  if (!open || btn.dataset.busy) return;
  const [g, owed] = await Promise.all([
    pub.readContract({ address: GAME, abi, functionName: "getGame", args: [finaleGame] }),
    pub.readContract({ address: GAME, abi, functionName: "claimable", args: [finaleGame, me] }),
  ]);
  if (owed > 0n) {
    btn.disabled = false;
    btn.textContent = `Claim ${sqk(owed)}`;
    btn.onclick = async () => {
      btn.dataset.busy = "1";
      btn.disabled = true;
      btn.textContent = "Claiming…";
      try { await tx("claim", [finaleGame]); btn.textContent = "Claimed ✓"; } catch { btn.disabled = false; btn.textContent = "Try the claim again"; }
      delete btn.dataset.busy;
    };
  } else {
    btn.disabled = true;
    btn.textContent = Status[Number(g.status)] === "Settled" ? "Claimed ✓" : "Claim unlocks when payouts are final…";
  }
}
$("finale").addEventListener("close", () => { finaleGame = null; });

// Winnings and refunds still waiting in recent games (the game card only shows the current one).
let unclaimedCheckedAt = 0;
// Earlier game contracts (after a redeploy) where players may still have refunds or winnings.
const PREVIOUS_GAMES = (cfg.previousGames || []).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));

async function updateUnclaimed(currentId) {
  if (!me || demo || Date.now() - unclaimedCheckedAt < 20_000) return;
  unclaimedCheckedAt = Date.now();
  // This contract's last 10 games before the current one, and each previous contract's last 10 games.
  const spots = [];
  for (let id = currentId - 1n; id >= 1n && spots.length < 10; id--) spots.push({ address: GAME, id });
  for (const address of PREVIOUS_GAMES) {
    const count = await pub.readContract({ address, abi, functionName: "gameCount" }).catch(() => 0n);
    for (let id = count; id >= 1n && id > count - 10n; id--) spots.push({ address, id, previous: true });
  }
  const calls = spots.map(({ address, id }) => ({ address, abi, functionName: "claimable", args: [id, me] }));
  let owed = [];
  try { owed = await pub.multicall({ contracts: calls, allowFailure: false }); } catch { owed = await Promise.all(calls.map((c) => pub.readContract(c).catch(() => 0n))); }
  const box = $("unclaimed");
  const items = spots.map((x, i) => ({ ...x, owed: owed[i] })).filter((x) => x.owed > 0n);
  box.hidden = !items.length;
  box.replaceChildren(...(items.length ? [Object.assign(document.createElement("p"), { textContent: "You have winnings to claim" })] : []),
    ...items.map(({ address, id, previous, owed: amt }) => {
      const b = Object.assign(document.createElement("button"), { className: "secondary",
        textContent: `Claim ${sqk(amt)} from game #${id}${previous ? " (previous contract)" : ""}` });
      b.onclick = async () => { b.disabled = true; try { await tx("claim", [id], address); } finally { unclaimedCheckedAt = 0; await updateUnclaimed(currentId); } };
      return b;
    }));
}
const caughtLine = (who, rolledOver, pot) => (rolledOver ? `Everyone was caught, so the ${pot} pot rolls into the next game.`
  : who.length ? `Caught on the wheel: ${who.join(", ")}` : "Nobody got caught!");

// A real game just ended. Payouts are estimated with the contract's maths until it's finalized on chain.
function celebrateLive(lastMove) {
  const g = game;
  if (demo || !g || !lastMove || celebrated.has(g.id) || !Number(g.startTime)) return;
  if (!["Live", "Ended", "Settled", "RolledOver"].includes(Status[Number(g.status)])) return;
  const start = Number(g.startTime);
  const inGame = g.players.filter((p) => countsInPot(entryTimes(p.entry), potRules(g)));
  if (!inGame.length) return;
  celebrated.add(g.id);
  const exits = inGame.filter((p) => Number(p.entry.exitTime)).sort((a, b) => Number(a.entry.exitTime) - Number(b.entry.exitTime))
    .map((p) => ({ id: p.addr.toLowerCase(), t: Number(p.entry.exitTime) - start, from: Math.max(0, Number(p.entry.enteredAt) - start) }));
  const r = settle({ buyIn: Number(formatUnits(g.p.buyIn, 18)), inPot: inGame.length, rollover: Number(formatUnits(g.rolloverIn, 18)), exits, lastMove: lastMove - start });
  const isMe = (p) => me && p.addr.toLowerCase() === me.toLowerCase();
  const name = (p) => (isMe(p) ? "You" : playerName(p.addr));
  const amount = (n) => `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${SYMBOL}`;
  const winners = inGame.filter((p) => r.payouts.has(p.addr.toLowerCase())).map((p) => {
    const pay = r.payouts.get(p.addr.toLowerCase());
    return { name: name(p), you: isMe(p), total: pay.total, amount: amount(pay.total), jackpot: pay.jackpot > 0, at: `+${mmss(Number(p.entry.exitTime) - start)}` };
  }).sort((a, b) => b.total - a.total);
  const mine = inGame.find(isMe), myPay = mine && r.payouts.get(mine.addr.toLowerCase());
  finaleGame = myPay ? g.id : null;
  finale.celebrate({
    kicker: `Game #${g.id}`,
    title: r.rolledOver ? "Everyone caught!" : "Game over!",
    subtitle: `Squeektoshi stopped at +${mmss(lastMove - start)}. ${winners.length} of ${inGame.length} got off in time.`,
    you: !mine ? null : myPay ? { kind: "won", text: `You won ${amount(myPay.total)}!` } : { kind: "caught", text: "You were still on the wheel: caught!" },
    winners,
    caught: caughtLine(inGame.filter((p) => !r.payouts.has(p.addr.toLowerCase())).map(name), r.rolledOver, amount(r.pot)),
    note: r.rolledOver ? "" : "Payouts are estimates until the game is finalized on chain, usually 5–20 minutes after he stops. Winners can then claim here or on the game card.",
  });
  updateFinaleClaim().catch(() => {});
}

function celebrateDemo() {
  const s = demo.state, r = s.result, players = demo.players;
  const name = (p) => (p.you ? "You" : p.name);
  const winners = players.filter((p) => r.payouts.has(p.id)).map((p) => {
    const pay = r.payouts.get(p.id);
    return { name: name(p), you: p.you, total: pay.total, amount: demoSqk(pay.total), jackpot: pay.jackpot > 0, at: `+${mmss(p.exit)}` };
  }).sort((a, b) => b.total - a.total);
  const mine = r.payouts.get("you");
  finaleGame = null;
  finale.celebrate({
    kicker: "Demo game",
    title: r.rolledOver ? "Everyone caught!" : "Game over!",
    subtitle: `Squeektoshi stopped at +${mmss(s.lastMove - s.start)}. ${winners.length} of ${players.length} got off in time.`,
    you: mine ? { kind: "won", text: `You won ${demoSqk(mine.total)}!` } : { kind: "caught", text: "You were still on the wheel: caught!" },
    winners,
    caught: caughtLine(players.filter((p) => !r.payouts.has(p.id)).map(name), r.rolledOver, demoSqk(r.pot)),
  });
}

// ---------------------------------------------------------------- demo mode

let demoSpeed = 5, demoTimer = null, demoRun = null, demoCelebrated = false, demoPhase = null;
const demoMoments = createMoments();
const demoSqk = (n) => `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} SQK`;

function startDemo() {
  demo = createDemo();
  demoRun = createRunClock();
  demoCelebrated = false;
  demoPhase = null;
  finale.close();
  setCamView("cartoon");
  $("unclaimed").hidden = true;
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
  finale.close();
  unclaimedCheckedAt = 0;
  setCamView(store("localStorage", "camView") === "live" ? "live" : "cartoon");
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
  finale.countdown(s.phase === "live" && view.mode === "paused" ? s.rules.lastMove + DEFAULTS.idleWindow - s.t : null);
  if (s.phase === "ended" && !demoCelebrated) { demoCelebrated = true; celebrateDemo(); }
  if (demoPhase === "lobby" && s.phase === "live") {
    showAlertBanner("🐹 Demo: he's running! Game on");
    alerts.ring({ title: "Demo: Squeektoshi is running!", body: "Your demo game just started.", tag: "squeekout-demo" });
  }
  demoPhase = s.phase;
  if (s.phase !== "lobby") demoMoments.update(view.mode, s.t);
  const stillOn = players.filter((p) => p.exit == null).length;
  const events = [...demoMoments.list];
  if (s.start != null) events.push({ t: s.start, text: `Game on! Late entries open ${mmss(demo.lateWindow)}, until someone gets off`, kind: "ham" });
  for (const p of players) if (p.from > 0) events.push({ t: s.start + p.from, text: `${p.name} jumped on late` });
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
  const lateLeft = demo.lateEntryLeft();
  $("gameStatus").textContent = { lobby: "Lobby open until he runs, then 2 more minutes until someone gets off",
    live: lateLeft != null ? `Live: late entries open for ${mmss(lateLeft)}, or until someone gets off` : "Live: the wheel is turning", ended: "Game over" }[s.phase];
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
    const off = (p.exit != null ? since(p.exit) : p.landsAt != null ? (s.phase === "ended" ? "too late" : "getting off…") : s.phase === "ended" ? "never got off" : "still on")
      + (p.from > 0 ? ` · joined ${since(p.from)}` : "");
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
      : you.landsAt != null ? `Too late: your exit hadn't landed when the game ended. He'd already stopped at ${since(s.lastMove - s.start)}, and getting off during a break only counts if he runs again. Caught.`
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

// ---------------------------------------------------------------- testing notice

// Shows the "still in testing" notice; resolves true if the visitor agrees to use a throwaway wallet.
function showBetaNotice() {
  const d = $("betaDialog");
  return new Promise((resolve) => {
    d.addEventListener("close", () => resolve(d.returnValue === "ok"), { once: true });
    if (!d.open) { d.returnValue = ""; d.showModal(); }
  });
}
$("betaMore").onclick = () => showBetaNotice();
if (!store("localStorage", "betaNoticeSeen")) {
  showBetaNotice().then((ok) => {
    store("localStorage", "betaNoticeSeen", "1");
    if (ok) store("sessionStorage", "betaAgreed", "1");
  });
}

// ---------------------------------------------------------------- wallet

// The connection follows the wallet: switching account or network there updates the page.
const conn = createWallet({
  chain,
  onChange({ address, wrongChain }) {
    const changed = (address ?? "").toLowerCase() !== (me ?? "").toLowerCase();
    me = address;
    wallet = address ? createWalletClient({ account: address, chain, transport: custom(conn.provider) }) : null;
    $("account").textContent = address ? names.ensName(address) ?? short(address) : "Not connected";
    $("account").title = address ? `${address} in ${conn.name}` : "";
    $("connect").hidden = !!address;
    $("disconnect").hidden = !address;
    $("switchNet").hidden = !wrongChain;
    if (!wrongChain && /wrong network/.test($("msg").textContent)) msg("");
    $("faucet").hidden = !(TEST_TOKEN && address);
    if (changed) {
      alerts.walletChanged();
      unclaimedCheckedAt = 0;
      $("unclaimed").hidden = true;
      if (game) loadGame().catch(() => {});
    }
  },
});

// Lets the player pick among installed wallets; resolves to the chosen one, or null.
function pickWallet(list) {
  const d = $("walletDialog");
  $("walletNone").hidden = list.length > 0;
  return new Promise((resolve) => {
    let chosen = null;
    $("walletList").replaceChildren(...list.map((w) => {
      const b = document.createElement("button");
      b.type = "button";
      if (w.info.icon) b.append(Object.assign(document.createElement("img"), { src: w.info.icon, alt: "" }));
      b.append(w.info.name);
      b.onclick = () => { chosen = w; d.close(); };
      return b;
    }));
    d.addEventListener("close", () => resolve(chosen), { once: true });
    d.showModal();
  });
}

async function connect() {
  // Ask once per visit before any wallet connects.
  if (!store("sessionStorage", "betaAgreed")) {
    if (!(await showBetaNotice())) return;
    store("sessionStorage", "betaAgreed", "1");
  }
  const list = await installedWallets();
  const w = list.length === 1 ? list[0] : await pickWallet(list);
  if (!w) return;
  try {
    msg(`Approve the connection in ${w.info.name}…`);
    if (!(await conn.connect(w))) { msg("No account was shared.", true); return; }
    msg("");
  } catch (e) {
    msg(walletErrorText(e), true);
    return;
  }
  try { await conn.ensureChain(); } catch (e) { msg(walletErrorText(e), true); }
}
$("disconnect").onclick = () => { conn.disconnect(); msg(""); };
$("switchNet").onclick = () => conn.ensureChain().then(() => msg(""), (e) => msg(walletErrorText(e), true));
conn.reconnect().catch(() => {}); // the wallet used last time, if it still allows this site: no prompt

async function tx(functionName, args, address = GAME, contractAbi = abi) {
  try {
    if (!me || !wallet) throw new Error("Connect a wallet first.");
    await conn.ensureChain();
    const { request } = await pub.simulateContract({ account: me, address, abi: contractAbi, functionName, args });
    msg(`Confirm in ${conn.name ?? "your wallet"}…`);
    const hash = await wallet.writeContract(request);
    msg("Waiting for the transaction to confirm…");
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("The transaction failed on chain, so nothing changed.");
    msg("Done.");
  } catch (e) {
    msg(walletErrorText(e), true);
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
  if (allowance >= g.p.buyIn) return tx("enter", [g.id]);
  try { await conn.ensureChain(); } catch (e) { msg(walletErrorText(e), true); return; } // the signature names the chain
  // One signature (free) plus one transaction. If the wallet can't sign permits, approve then enter.
  let permit = null;
  try {
    msg("Sign the buy-in in your wallet (a free signature, not a transaction)…");
    permit = await signPermit({
      pub, token: SQK, owner: me, spender: GAME, value: g.p.buyIn, chainId: chain.id,
      sign: (typedData) => wallet.signTypedData({ account: me, ...typedData }),
    });
  } catch (e) {
    if (walletErrorText(e) === "You cancelled it in your wallet.") { msg("Cancelled."); return; }
    console.warn("Permit signing failed; approving instead", e);
  }
  if (permit) return tx("enterWithPermit", [g.id, permit.deadline, permit.v, permit.r, permit.s]);
  await tx("approve", [GAME, g.p.buyIn], SQK, erc20);
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
  if (!demo) {
    const now = Math.floor(Date.now() / 1000), left = liveSecondsLeft(Date.now() / 1000);
    // Count the break down every second, not only when a reading arrives.
    showTimer(liveView.mode === "paused" && left != null ? { ...liveView, remaining: Math.max(0, Math.ceil(left)) } : liveView, liveRun, now, true);
    finale.countdown(left);
  }
}, 1000);
loadGame();
loadLog();

// The watcher: reads Squeekchain's live feed every second, applies the shared game rules, and posts
// start, end and void decisions to the SqueekChicken contract. It also finalizes ended games (earning
// the bounty) and serves the web app and a public log of its decisions.
//
// Environment:
//   GAME_ADDRESS          deployed SqueekChicken contract (required)
//   WATCHER_PRIVATE_KEY   key of the watcher address set in the contract (required)
//   RPC_URL               Sepolia RPC (default: public node)
//   SQUEEK_API            Squeekchain API base (default https://api.squeekchain.com)
//   STATE_FILE            where game state survives restarts (default /data/state.json; mount a volume)
//   PORT                  web server port (default 3000)
//   CHAIN                 "sepolia" (default) or "hardhat" for a local test chain

import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat, sepolia } from "viem/chains";
import { DEFAULTS, newGameState, readingFromStatus, step, trackRun } from "../shared/rules.js";
import { createBots, isTestToken } from "./bots.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const GAME = env.GAME_ADDRESS;
const RPC = env.RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const API = env.SQUEEK_API || "https://api.squeekchain.com";
const STATE_FILE = env.STATE_FILE || "/data/state.json";
const PORT = Number(env.PORT || 3000);
const chain = env.CHAIN === "hardhat" ? hardhat : sepolia;
if (!GAME || !env.WATCHER_PRIVATE_KEY) {
  console.error("Set GAME_ADDRESS and WATCHER_PRIVATE_KEY");
  process.exit(1);
}

const abi = JSON.parse(readFileSync(join(ROOT, "web", "abi.json"), "utf8"));
const account = privateKeyToAccount(env.WATCHER_PRIVATE_KEY);
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account, chain, transport: http(RPC) });
const Status = ["None", "Lobby", "Live", "Ended", "Settled", "Voided", "RolledOver"];

// Test players (BOTS, default 5; 0 turns them off). Only for games played with the free test token.
let bots = null;
try {
  const sqk = await pub.readContract({ address: GAME, abi, functionName: "sqk" });
  const count = Number(env.BOTS ?? 5);
  if (count > 0 && (await isTestToken(pub, sqk))) {
    bots = createBots({
      count, seedKey: env.WATCHER_PRIVATE_KEY, pub, chain, rpc: RPC, game: GAME, abi, sqk, log: (...a) => log(...a),
      fund: async (to, value) => {
        const hash = await wallet.sendTransaction({ to, value });
        await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
        return hash;
      },
    });
  }
} catch (e) {
  console.error("Test players are off: couldn't read the game's token", e);
}

// ---------------------------------------------------------------- public log

const recent = [];
function log(event, data = {}) {
  const entry = { at: new Date().toISOString(), event, ...data };
  console.log(JSON.stringify(entry));
  if (event !== "tick") {
    recent.push(entry);
    if (recent.length > 500) recent.shift();
  }
}

// ---------------------------------------------------------------- state that survives restarts

let saved = { game: GAME, savedAt: 0, games: {} }; // games: id -> { rules, queue of decisions not yet posted, chain status }
if (existsSync(STATE_FILE)) {
  try {
    const loaded = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    // Game ids restart at 1 on each contract, so state saved for another contract (or before the address
    // was recorded) doesn't apply here.
    if (loaded.game?.toLowerCase() === GAME.toLowerCase()) saved = loaded;
    else log("state_reset", { reason: "saved state belongs to another game contract", savedFor: loaded.game ?? null });
  } catch (e) {
    log("state_unreadable", { error: String(e) });
  }
}
// Time the watcher was down counts as a feed outage for any game it was tracking.
const bootGap = saved.savedAt ? Math.floor(Date.now() / 1000) - saved.savedAt : 0;
for (const g of Object.values(saved.games)) {
  if (bootGap > 5 && g.rules.phase !== "done" && !g.rules.outage) {
    g.rules.outage = { since: saved.savedAt, counterBefore: g.rules.lastCounter, lastMoveBefore: g.rules.lastMove };
  }
}
function persist() {
  saved.savedAt = Math.floor(Date.now() / 1000);
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(saved));
  } catch (e) {
    log("state_write_failed", { error: String(e) });
  }
}

// ---------------------------------------------------------------- feed

let latest = null;
let failingSince = null, lastFailureLog = 0;
async function pollFeed() {
  try {
    const res = await fetch(`${API}/v1/status`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      // Keep what the API said, so a block (for example by its CDN) can be reported to Squeekchain.
      const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
      const h = (name) => res.headers.get(name) || undefined;
      throw Object.assign(new Error(`HTTP ${res.status}`), {
        detail: { server: h("server"), cfRay: h("cf-ray"), cfMitigated: h("cf-mitigated"), requestId: h("x-request-id"), body },
      });
    }
    latest = readingFromStatus(await res.json(), Math.floor(Date.now() / 1000));
  } catch (e) {
    // Keep the last reading; it ages out and the rules then treat the feed as down.
    const now = Date.now();
    if (failingSince == null) failingSince = now;
    if (now - lastFailureLog >= 5 * 60_000) {
      log("feed_error", { error: String(e), ...e.detail, failingForSec: Math.round((now - failingSince) / 1000) });
      lastFailureLog = now;
    }
    return;
  }
  if (failingSince != null) log("feed_recovered", { downForSec: Math.round((Date.now() - failingSince) / 1000) });
  failingSince = null;
  lastFailureLog = 0;
}

// ---------------------------------------------------------------- chain

const chainGames = new Map(); // id -> { status, p, startTime, lastMove }, refreshed with every chain round
const RECENT = 6; // recent games kept in view (test players' claims, NFT bonuses)
async function refreshGames() {
  const count = Number(await pub.readContract({ address: GAME, abi, functionName: "gameCount" }));
  // Finished games barely change, so only read the games still being tracked and the latest few (test
  // players' claims and NFT bonuses look at those), not every game ever played.
  const from = Math.max(1, Math.min(count - RECENT + 1, ...Object.keys(saved.games).map(Number)));
  for (const id of chainGames.keys()) if (id < from) chainGames.delete(id);
  for (let id = from; id <= count; id++) {
    const g = await pub.readContract({ address: GAME, abi, functionName: "getGame", args: [BigInt(id)] });
    const status = Status[Number(g.status)];
    chainGames.set(id, { status, p: g.p, startTime: Number(g.startTime), lastMove: Number(g.lastMove) });
    const key = String(id);
    if (status === "Lobby" || status === "Live" || status === "Ended") {
      if (!saved.games[key]) {
        const rules = newGameState(Number(g.p.earliestStart));
        if (status !== "Lobby") {
          // Already started but we have no history for it (for example a fresh volume).
          rules.phase = status === "Live" ? "live" : "done";
          rules.startTime = Number(g.startTime);
          rules.outage = { since: Math.floor(Date.now() / 1000), counterBefore: null, lastMoveBefore: null };
        }
        saved.games[key] = { rules, queue: [], status };
        log("tracking", { game: id, status });
      }
      saved.games[key].status = status;
    } else if (saved.games[key]) {
      log("untracking", { game: id, status });
      delete saved.games[key];
    }
  }
}

async function send(functionName, args) {
  const { request } = await pub.simulateContract({ account, address: GAME, abi, functionName, args });
  const hash = await wallet.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted in ${hash}`);
  return hash;
}

// Posts queued decisions in order; a failure leaves the rest queued for the next round.
async function act(id, game) {
  while (game.queue.length) {
    const d = game.queue[0];
    try {
      let hash;
      if (d.type === "start") hash = await send("postStart", [BigInt(id), BigInt(d.startTime)]);
      if (d.type === "end") hash = await send("postEnd", [BigInt(id), BigInt(d.lastMove), BigInt(d.counter)]);
      if (d.type === "void") hash = await send("voidGame", [BigInt(id), d.reason]);
      log("posted", { game: Number(id), ...d, tx: hash });
      game.queue.shift();
    } catch (e) {
      // Most often the chain clock is a few seconds behind the device clock; try again next round.
      log("post_retry", { game: Number(id), ...d, error: String(e.shortMessage || e.message || e) });
      return;
    }
  }
}

async function tryFinalize(id) {
  try {
    const hash = await send("finalize", [BigInt(id)]);
    log("finalized", { game: Number(id), tx: hash });
  } catch (e) {
    const msg = String(e.shortMessage || e.message || e);
    if (!/RoundCheckPending/.test(msg)) log("finalize_retry", { game: Number(id), error: msg });
  }
}

// Keeps a game always open: when the latest game has finished (or there is none), open the next one
// with the contract's default rules. A no-op until the owner has set those defaults.
async function openNextIfIdle() {
  const count = Number(await pub.readContract({ address: GAME, abi, functionName: "gameCount" }));
  if (count > 0) {
    const g = await pub.readContract({ address: GAME, abi, functionName: "getGame", args: [BigInt(count)] });
    if (!["Settled", "Voided", "RolledOver"].includes(Status[Number(g.status)])) return;
  }
  const defaults = await pub.readContract({ address: GAME, abi, functionName: "defaults" });
  if (!defaults[0]) return; // buyIn 0: defaults not set yet
  try {
    const hash = await send("openNextGame", []);
    log("opened", { game: count + 1, tx: hash });
  } catch (e) {
    log("open_retry", { error: String(e.shortMessage || e.message || e) });
  }
}

// ---------------------------------------------------------------- NFT jackpot bonus

// Half of what the treasury's NFTs earn from a run goes to that game's jackpot. The rewards take a while to
// arrive, so each finished game's bonus is settled `bonusDelay` after the hamster's last movement, in order.
const hasBonus = abi.some((x) => x.name === "settleBonus");
async function settleBonuses() {
  if (!hasBonus) return;
  const [treasury, delay, last] = await Promise.all(["treasury", "bonusDelay", "lastBonusGame"]
    .map((functionName) => pub.readContract({ address: GAME, abi, functionName })));
  if (/^0x0+$/.test(treasury)) return;
  const now = Math.floor(Date.now() / 1000);
  const count = Math.max(0, ...chainGames.keys());
  for (let id = Math.max(Number(last) + 1, saved.bonusCursor ?? 1); id <= count; id++) {
    const g = chainGames.get(id);
    if (!g) continue; // older than the recent games in view
    if (g.status === "Voided") { saved.bonusCursor = id + 1; continue; } // no bonus; its rewards go to the next one
    if (g.status !== "Settled" && g.status !== "RolledOver") return;
    if (now < g.lastMove + Number(delay)) return; // later games settle later still
    try {
      const hash = await send("settleBonus", [BigInt(id)]);
      log("bonus_settled", { game: id, tx: hash });
    } catch (e) {
      log("bonus_retry", { game: id, error: String(e.shortMessage || e.message || e) });
    }
    return; // one a round, in order
  }
}

// ---------------------------------------------------------------- main loop

let busy = false;
async function tick() {
  await pollFeed();
  const now = Math.floor(Date.now() / 1000);
  saved.hamster = trackRun(saved.hamster, latest, now);
  for (const [id, game] of Object.entries(saved.games)) {
    if (game.rules.phase === "done") continue;
    const { state, decision } = step(game.rules, latest, now);
    game.rules = state;
    if (decision) {
      game.queue.push(decision);
      log("decided", { game: Number(id), ...decision });
    }
    if (bots && game.status === "Live" && game.rules.phase === "live") {
      bots.onSecond(Number(id), game.rules, latest, chainGames.get(Number(id))?.startTime ?? game.rules.startTime, now)
        .catch((e) => log("bot_error", { error: String(e.shortMessage || e.message || e) }));
    }
  }
  persist();
}

async function chainWork() {
  if (busy) return;
  busy = true;
  try {
    await refreshGames();
    for (const [id, game] of Object.entries(saved.games)) {
      if (game.queue.length) await act(id, game);
      if (game.status === "Ended" && !game.queue.length) await tryFinalize(id);
    }
    await openNextIfIdle();
    await settleBonuses();
    if (bots) await bots.chainWork(Math.max(0, ...chainGames.keys()), chainGames);
    persist();
  } catch (e) {
    log("chain_error", { error: String(e.shortMessage || e.message || e) });
  } finally {
    busy = false;
  }
}

// ---------------------------------------------------------------- web server

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/log") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(recent.slice(-200)));
  }
  if (url.pathname === "/hamster") {
    // When he last moved and when this run began, so a page opened mid-game shows the right clocks.
    const h = saved.hamster;
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(h ? { epoch: h.epoch, lastCounter: h.lastCounter, lastMove: h.lastMove, runSince: h.runSince,
      runPartial: h.runPartial, idleWindow: DEFAULTS.idleWindow } : {}));
  }
  if (url.pathname === "/config.json") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ gameAddress: GAME, chainId: chain.id, rpcUrl: RPC, squeekApi: API, watcher: account.address, bots: bots?.list() ?? [] }));
  }
  const rel = url.pathname === "/" ? "/web/index.html" : url.pathname.startsWith("/shared/") ? url.pathname : `/web${url.pathname}`;
  const file = normalize(join(ROOT, rel));
  if (!file.startsWith(join(ROOT, "web")) && !file.startsWith(join(ROOT, "shared"))) {
    res.writeHead(404);
    return res.end();
  }
  try {
    const body = readFileSync(file);
    // no-cache: browsers may keep a copy but must check for a newer one, so a deploy shows up on reload.
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}).listen(PORT, () => log("started", { port: PORT, game: GAME, watcher: account.address, bots: bots?.list() ?? [] }));

setInterval(tick, 1000);
setInterval(chainWork, 15_000);
chainWork();

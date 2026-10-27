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
import { newGameState, readingFromStatus, step } from "../shared/rules.js";

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

// ---------------------------------------------------------------- state that survives restarts

let saved = { savedAt: 0, games: {} }; // id -> { rules, queue of decisions not yet posted, chain status }
if (existsSync(STATE_FILE)) {
  try {
    saved = JSON.parse(readFileSync(STATE_FILE, "utf8"));
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

// ---------------------------------------------------------------- feed

let latest = null;
async function pollFeed() {
  try {
    const res = await fetch(`${API}/v1/status`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    latest = readingFromStatus(await res.json(), Math.floor(Date.now() / 1000));
  } catch (e) {
    // Keep the last reading; it ages out and the rules then treat the feed as down.
    if (!pollFeed.failing) log("feed_error", { error: String(e) });
    pollFeed.failing = true;
    return;
  }
  if (pollFeed.failing) log("feed_recovered");
  pollFeed.failing = false;
}

// ---------------------------------------------------------------- chain

async function refreshGames() {
  const count = Number(await pub.readContract({ address: GAME, abi, functionName: "gameCount" }));
  for (let id = 1; id <= count; id++) {
    const g = await pub.readContract({ address: GAME, abi, functionName: "getGame", args: [BigInt(id)] });
    const status = Status[Number(g.status)];
    const key = String(id);
    if (status === "Lobby" || status === "Live" || status === "Ended") {
      if (!saved.games[key]) {
        const rules = newGameState(Number(g.p.lobbyClose));
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

// ---------------------------------------------------------------- main loop

let busy = false;
async function tick() {
  await pollFeed();
  const now = Math.floor(Date.now() / 1000);
  for (const [id, game] of Object.entries(saved.games)) {
    if (game.rules.phase === "done") continue;
    const { state, decision } = step(game.rules, latest, now);
    game.rules = state;
    if (decision) {
      game.queue.push(decision);
      log("decided", { game: Number(id), ...decision });
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
  if (url.pathname === "/config.json") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ gameAddress: GAME, chainId: chain.id, rpcUrl: RPC, squeekApi: API, watcher: account.address }));
  }
  const rel = url.pathname === "/" ? "/web/index.html" : url.pathname.startsWith("/shared/") ? url.pathname : `/web${url.pathname}`;
  const file = normalize(join(ROOT, rel));
  if (!file.startsWith(join(ROOT, "web")) && !file.startsWith(join(ROOT, "shared"))) {
    res.writeHead(404);
    return res.end();
  }
  try {
    const body = readFileSync(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}).listen(PORT, () => log("started", { port: PORT, game: GAME, watcher: account.address }));

setInterval(tick, 1000);
setInterval(chainWork, 15_000);
chainWork();

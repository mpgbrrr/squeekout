// Scheduled exits ("auto-off"): a player signs "get me off N seconds into the run" (EIP-712, free), the page
// hands the signature to the watcher, and the watcher sends it to the contract once that moment comes. The
// watcher keeps signatures private until then, so nobody can see when a player plans to get off. A newer
// signature from the same player replaces the older one; one for afterSeconds = CANCEL cancels it.
// Exits are sent from their own wallet (derived from the watcher's key, topped up with gas by the watcher), so
// they never wait behind the watcher's own transactions.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createWalletClient, http, keccak256, nonceManager, parseEther, stringToHex, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const CANCEL = 4294967295; // the largest uint32: a time that never comes
export const TYPES = { ScheduledExit: [
  { name: "gameId", type: "uint256" }, { name: "player", type: "address" },
  { name: "afterSeconds", type: "uint32" }, { name: "issuedAt", type: "uint64" }] };
export const domainFor = (chainId, game) => ({ name: "Squeek Out", version: "1", chainId, verifyingContract: game });

const MAX_ORDERS = 5000;
const GAS_LOW = parseEther("0.0005"), GAS_TOP_UP = parseEther("0.003");
const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

/** A scheduled exit as the page sends it, with numbers checked, or null if it isn't one. */
export function cleanOrder(body) {
  const gameId = Number(body?.gameId), afterSeconds = Number(body?.afterSeconds), issuedAt = Number(body?.issuedAt);
  if (!Number.isSafeInteger(gameId) || gameId < 1 || !isAddress(body?.player)) return null;
  if (!Number.isInteger(afterSeconds) || afterSeconds < 0 || afterSeconds > CANCEL) return null;
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 1) return null;
  if (typeof body.signature !== "string" || !/^0x[0-9a-fA-F]{130,4000}$/.test(body.signature)) return null;
  return { gameId, player: body.player.toLowerCase(), afterSeconds, issuedAt, signature: body.signature };
}

/**
 * @param verify(order) whether the player signed it (viem's verifyTypedData by default; tests pass their own)
 * @param readEntry(gameId, player) → { entered, left, exitTime } from the contract
 * @param fund(address, wei) sends gas money from the watcher
 */
export function createScheduledExits({ file, chainId, game, abi, pub, chain, rpc, seedKey, fund, log, verify, readEntry }) {
  const domain = domainFor(chainId, game);
  verify ??= (o) => verifyTypedData({ address: o.player, domain, types: TYPES, primaryType: "ScheduledExit",
    message: { gameId: BigInt(o.gameId), player: o.player, afterSeconds: o.afterSeconds, issuedAt: BigInt(o.issuedAt) }, signature: o.signature });
  // The nonce manager lets several exits due at the same second go out together without clashing.
  const account = seedKey ? privateKeyToAccount(keccak256(stringToHex(`${seedKey}:squeek-out-scheduled-exits`)), { nonceManager }) : null;
  const wallet = account ? createWalletClient({ account, chain, transport: http(rpc) }) : null;
  let orders = {}; // "<gameId>:<player>" -> order
  if (existsSync(file)) {
    try { orders = JSON.parse(readFileSync(file, "utf8")); } catch (e) { log("scheduled_exits_unreadable", { error: String(e) }); }
  }
  const save = () => {
    try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(orders)); } catch (e) { log("scheduled_exits_store_failed", { error: String(e) }); }
  };
  const sending = new Set();
  const retryAt = new Map(); // order key -> when to try again after a failed send

  async function send(o) {
    const key = `${o.gameId}:${o.player}`;
    sending.add(key);
    try {
      const { request } = await pub.simulateContract({ account, address: game, abi, functionName: "exitScheduled",
        args: [BigInt(o.gameId), o.player, o.afterSeconds, BigInt(o.issuedAt), o.signature] });
      const hash = await wallet.writeContract(request);
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== "success") throw new Error(`reverted in ${hash}`);
      log("scheduled_exit_sent", { game: o.gameId, player: o.player, afterSeconds: o.afterSeconds, tx: hash });
      delete orders[key];
      save();
    } catch (e) {
      // The contract's reason (AlreadyExited, TooEarly, …) is in the error's details, not its short message.
      const msg = [e.cause?.data?.errorName, e.shortMessage, e.message].filter(Boolean).join(" · ") || String(e);
      // Already off (by hand), or the game is over: nothing left to do for this order.
      if (/AlreadyExited|NotEntered|LateEntry|WrongStatus|BadSignature/.test(msg)) {
        log("scheduled_exit_dropped", { game: o.gameId, player: o.player, reason: msg.slice(0, 160) });
        delete orders[key];
        save();
      } else {
        log("scheduled_exit_retry", { game: o.gameId, player: o.player, error: msg.slice(0, 200) });
        retryAt.set(key, Date.now() + 6_000); // the chain's clock can trail by a block: try again shortly
      }
    } finally {
      sending.delete(key);
    }
  }

  return {
    sender: account?.address ?? null,
    get count() { return Object.keys(orders).length; },

    /** Stores a player's signed exit, replacing any older one. Returns { ok } or { ok: false, error }. */
    async submit(body, gameStatus) {
      const o = cleanOrder(body);
      if (!o) return { ok: false, error: "That isn't a scheduled exit." };
      if (!["Lobby", "Live"].includes(gameStatus(o.gameId))) return { ok: false, error: "That game isn't open." };
      const key = `${o.gameId}:${o.player}`;
      if (orders[key] && orders[key].issuedAt >= o.issuedAt) return { ok: false, error: "A newer schedule is already saved." };
      if (!(await verify(o).catch(() => false))) return { ok: false, error: "The signature doesn't match the player." };
      const e = await readEntry(o.gameId, o.player);
      if (!e.entered || e.left || e.exitTime) return { ok: false, error: "That player isn't on the wheel in this game." };
      if (o.afterSeconds === CANCEL) {
        delete orders[key];
        save();
        return { ok: true, cancelled: true };
      }
      if (!orders[key] && Object.keys(orders).length >= MAX_ORDERS) return { ok: false, error: "Too many scheduled exits right now." };
      orders[key] = o;
      save();
      return { ok: true };
    },

    /** Every second: sends each live game's exits whose time has come. `games`: id -> { status, startTime }. */
    onSecond(games, now) {
      if (!wallet) return;
      for (const [key, o] of Object.entries(orders)) {
        const g = games.get(o.gameId);
        if (!g) continue;
        if (!["Lobby", "Live"].includes(g.status)) { delete orders[key]; save(); continue; } // game over
        if (g.status === "Live" && g.startTime && now >= g.startTime + o.afterSeconds && !sending.has(key)
          && Date.now() >= (retryAt.get(key) ?? 0)) send(o);
      }
    },

    /** From the watcher's chain work: keeps the sending wallet in gas. */
    async chainWork() {
      if (!account || !Object.keys(orders).length) return;
      if ((await pub.getBalance({ address: account.address })) < GAS_LOW) {
        const hash = await fund(account.address, GAS_TOP_UP);
        log("scheduled_exits_gas", { tx: hash });
      }
    },
  };
}

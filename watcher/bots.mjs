// Test players for testnet games played with the free test token (tSQK). Each has its own wallet, derived
// from the watcher's key, mints itself tSQK, joins every game at a random moment in the lobby (or now and then
// late, after he starts running), and gets off the wheel at a random moment in the style of the demo game's
// bots. The watcher tops up their gas.
// Only used when the game's token is TestSQK, never with real SQK.
import { createWalletClient, http, keccak256, maxUint256, parseAbi, parseEther, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { display } from "../shared/rules.js";

const NAMES = ["Nibbles", "Pip", "Captain Seed", "Whiskers", "Dash", "Pepper", "Sunflower", "Biscuit", "Hazel"];
const STYLES = ["greedy", "steady", "steady", "jumpy", "jumpy"];
const token = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function mint(address,uint256)",
  "function MAX_MINT() view returns (uint256)",
]);
const rand = (a, b) => a + Math.random() * (b - a);
const GAS_LOW = parseEther("0.0005"), GAS_TOP_UP = parseEther("0.002"), MINT = parseEther("1000");

/** Whether `sqk` is the free test token, so bots may play. */
export async function isTestToken(pub, sqk) {
  return pub.readContract({ address: sqk, abi: token, functionName: "MAX_MINT" }).then(() => true, () => false);
}

/**
 * @param seedKey the watcher's private key; each bot's key is derived from it
 * @param fund(address, wei) sends gas money from the watcher (called from the watcher's chain work)
 */
export function createBots({ count, seedKey, pub, chain, rpc, game, abi, sqk, fund, log, previousGames = [] }) {
  let previousCheckedAt = 0;
  const bots = Array.from({ length: count }, (_, i) => {
    const account = privateKeyToAccount(keccak256(stringToHex(`${seedKey}:squeek-chicken-bot:${i}`)));
    return {
      name: NAMES[i % NAMES.length], style: STYLES[i % STYLES.length], account,
      wallet: createWalletClient({ account, chain, transport: http(rpc) }),
      busy: false, plans: new Map(), // game id -> { enterAt, lateAt, joinedAt, breakNerve, maxStay, exitSent }
    };
  });

  async function send(bot, address, contractAbi, functionName, args) {
    const { request } = await pub.simulateContract({ account: bot.account, address, abi: contractAbi, functionName, args });
    const hash = await bot.wallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted in ${hash}`);
    return hash;
  }

  // One transaction at a time per bot; failures are logged and retried on a later round.
  function run(bot, what, fn) {
    if (bot.busy) return;
    bot.busy = true;
    fn().then((hash) => hash && log("bot", { bot: bot.name, what, tx: hash }))
      .catch((e) => log("bot_retry", { bot: bot.name, what, error: String(e.shortMessage || e.message || e) }))
      .finally(() => { bot.busy = false; });
  }

  // `canBeLate`: only a plan made in the lobby may have the bot join late (a plan made mid-game is for a bot
  // that's already in, for example after a restart).
  function planFor(bot, id, lobbyOpenFor, canBeLate = false) {
    if (!bot.plans.has(id)) {
      bot.plans.set(id, {
        enterAt: Date.now() / 1000 + rand(5, Math.max(10, lobbyOpenFor * 0.7)),
        lateAt: canBeLate && Math.random() < 0.2 ? rand(10, 100) : null, // seconds after the start
        joinedAt: null,
        // How long a break they'll sit through, and how long they'll stay on at most (like the demo's bots).
        breakNerve: bot.style === "jumpy" ? rand(8, 40) : bot.style === "steady" ? rand(40, 140) : rand(150, 400),
        maxStay: bot.style === "greedy" ? Infinity : bot.style === "steady" ? rand(300, 3600) : rand(60, 900),
        exitSent: false,
      });
      for (const old of bot.plans.keys()) if (old < id - 5) bot.plans.delete(old);
    }
    return bot.plans.get(id);
  }

  return {
    list: () => bots.map((b) => ({ address: b.account.address, name: b.name })),

    /** Every 15 s, from the watcher's chain work: gas top-ups, joining the open lobby, and claims. */
    async chainWork(gameCount, games) {
      // Every 5 minutes: refunds or winnings left in earlier game contracts (after a redeploy).
      if (previousGames.length && Date.now() - previousCheckedAt > 5 * 60_000) {
        previousCheckedAt = Date.now();
        for (const address of previousGames) {
          const last = Number(await pub.readContract({ address, abi, functionName: "gameCount" }).catch(() => 0n));
          for (let id = Math.max(1, last - 4); id <= last; id++) {
            for (const bot of bots) {
              if (bot.busy) continue;
              const owed = await pub.readContract({ address, abi, functionName: "claimable", args: [BigInt(id), bot.account.address] }).catch(() => 0n);
              if (owed > 0n) run(bot, `claim game #${id} on a previous contract`, () => send(bot, address, abi, "claim", [BigInt(id)]));
            }
          }
        }
      }
      const now = Date.now() / 1000;
      for (const bot of bots) {
        if ((await pub.getBalance({ address: bot.account.address })) < GAS_LOW) {
          const hash = await fund(bot.account.address, GAS_TOP_UP);
          log("bot", { bot: bot.name, what: "gas top-up", tx: hash });
        }
      }
      for (let id = Math.max(1, gameCount - 2); id <= gameCount; id++) {
        const g = games.get(id);
        if (!g) continue;
        for (const bot of bots) {
          if (bot.busy) continue;
          const e = await pub.readContract({ address: game, abi, functionName: "entries", args: [BigInt(id), bot.account.address] });
          const [entered, left, claimed] = [e[0], e[1], e[2]];
          const join = (what) => run(bot, what, async () => {
            const bal = await pub.readContract({ address: sqk, abi: token, functionName: "balanceOf", args: [bot.account.address] });
            if (bal < g.p.buyIn) await send(bot, sqk, token, "mint", [bot.account.address, MINT]);
            const allowed = await pub.readContract({ address: sqk, abi: token, functionName: "allowance", args: [bot.account.address, game] });
            if (allowed < g.p.buyIn) await send(bot, sqk, token, "approve", [game, maxUint256]);
            const hash = await send(bot, game, abi, "enter", [BigInt(id)]);
            planFor(bot, id, 0).joinedAt = Date.now() / 1000;
            return hash;
          });
          if (g.status === "Lobby" && !entered) {
            const plan = planFor(bot, id, Number(g.p.earliestStart) - now + 120, true);
            if (plan.lateAt == null && now >= plan.enterAt) join(`join game #${id}`);
          } else if (g.status === "Live" && !entered && bot.plans.get(id)?.lateAt != null) {
            const plan = bot.plans.get(id);
            if (plan.joinedAt || now < g.startTime + plan.lateAt) continue;
            if (!(await pub.readContract({ address: game, abi, functionName: "lateEntryOpen", args: [BigInt(id)] }))) continue;
            join(`jump on game #${id} late`);
          } else if (["Settled", "Voided", "RolledOver"].includes(g.status) && entered && !left && !claimed) {
            const owed = await pub.readContract({ address: game, abi, functionName: "claimable", args: [BigInt(id), bot.account.address] });
            if (owed > 0n) run(bot, `claim game #${id}`, () => send(bot, game, abi, "claim", [BigInt(id)]));
          }
        }
      }
    },

    /** Every second while a game is live: each bot gets off when a break outlasts its nerve or it has stayed long enough. */
    async onSecond(id, rules, reading, startTime, now) {
      if (!reading) return;
      const view = display(rules, reading, now);
      const pausedFor = view.mode === "paused" && rules.lastMove != null ? now - rules.lastMove : 0;
      for (const bot of bots) {
        const plan = bot.plans.get(id) ?? planFor(bot, id, 0);
        if (plan.exitSent || bot.busy) continue;
        if (plan.lateAt != null && !plan.joinedAt) continue; // hasn't jumped on (yet)
        if (pausedFor > plan.breakNerve || now - Math.max(startTime, plan.joinedAt ?? 0) > plan.maxStay) {
          plan.exitSent = true;
          run(bot, `get off game #${id}`, async () => {
            const e = await pub.readContract({ address: game, abi, functionName: "entries", args: [BigInt(id), bot.account.address] });
            if (!e[0] || e[1] || e[4] > 0n) return null; // not on the wheel
            // An entry that landed too late is refunded rather than on the wheel.
            return send(bot, game, abi, "exit", [BigInt(id)]).catch((err) => { if (/LateEntry/.test(String(err.message))) return null; throw err; });
          });
        }
      }
    },
  };
}

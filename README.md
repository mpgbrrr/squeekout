# Squeek Out

**Ride the wheel. Bail before he stops.** Play at **[squeekout.fun](https://squeekout.fun)**: a testnet game of nerve on [Squeekchain](https://docs.squeekchain.com/), the blockchain powered by Squeektoshi the hamster running on his wheel.

(The paid game's contract, `SqueekChicken`, and some internal names keep the game's working title, Squeekchain Chicken.)

Everyone buys in with SQK while the lobby is open. The game starts the moment the hamster starts running, and you're on the wheel; latecomers can still jump on for 2 minutes, until the first player gets off. Get off whenever you like: the longer you stay, the bigger your share. Once the wheel has been still for 3 minutes, the game ends at his last movement. Anyone still on, or who got off too late, is caught and gets nothing. As soon as a game ends, the next lobby opens.

**Sepolia testnet only.** Testnet SQK has no value.

## Rules

| Rule | Value |
|---|---|
| Lobby | Always one open. Enter, or leave with an immediate refund, until Squeektoshi starts running |
| Game starts | At his first movement once the lobby has been open at least **5 minutes** |
| Late entries | Open for **2 minutes** after his first movement, until the **first player gets off**. A late player's time on the wheel counts from when they got on. An entry that lands after that (including in the same block as the first exit) is refunded |
| Minimum players | Counted when the start is posted; too few voids the game and refunds everyone |
| Next game | Its lobby opens as soon as the previous game's end is posted, without waiting for its payouts |
| Game ends | When the wheel has been still for **3 minutes**, at his last movement |
| Grace | Exits up to **12 s** (one Ethereum block) after his last movement still win |
| Auto-off | Optional: schedule your exit for a set time into the run (say 8:23). You sign it for free; the watcher keeps it private and sends it at that moment, so it lands in the next block. Same rules as getting off by hand. Cancel or change it any time before then |
| Payout curve | Your weight is your **time on the wheel**, to the second, from the start (or from when you got on, if you joined late): stay twice as long, earn twice the share. (Until 29 Oct 2026 it was +25% per 2 minutes, which was nearly flat in short runs, so bailing first often paid.) |
| Jackpot | **20%** of the pot is shared by the **last 10%** of winners (at least one) |
| Everyone else who got off in time | Shares the other 80% by weight |
| Everyone caught | The pot rolls into the next game |
| Claiming | Winnings and refunds wait in the contract until you claim them. Several games on this contract are claimed together in one transaction (claim all) |
| House fee | None |
| Payout bounty | A flat SQK amount to whoever finalizes the game, capped at **1%** of the pot |
| Feed outage | If Squeekchain's live feed drops: the game can't end while it's down. When it returns, the game carries on if the hamster didn't run during the gap, or if the gap was too short to hide a 3-minute stop. Otherwise the game is **voided and everyone refunded**. An outage over **30 minutes** also voids it. |
| Backstop | If a game can't finish within 7 days of its earliest start, anyone can refund it |

## Free holders game

A second version of the game, `contracts/SqueekHolders.sol`, is free to play for Squeek holders. The paid game above stays as it is.

| Rule | Value |
|---|---|
| Entry | Free, one per wallet, for anyone holding an official Squeek in their wallet or staked in Squeekchain's staking. Each Squeek can enter only one wallet per game (so passing one Squeek around gets no extra entries; someone who spreads several Squeeks across wallets gets at most one entry per Squeek) |
| Collections | Genesis Squeeks from the start. The owner can add a collection without an upgrade (`setCollection`), but only one Squeekchain's staking recognizes, such as clones once they launch |
| Prize | The game's own Squeeks, staked through `ChickenTreasury`, earn SQK while he runs. Each game's prize is the prize share (50% by default; the treasury's owner can change it with `setGameShare` or from the treasury panel, from the next payout) of what they earned since the previous game paid out; the rest goes to the developer. It's paid out `prizeDelay` (40 min) after he stops, once the run's rewards have streamed in, and games pay out in order |
| Everything else | As the paid game: late entries, time-on-the-wheel payouts and the 20% jackpot, Auto-off, claim all, start alerts. Everyone caught or a voided game: the prize carries over. Minimum players: 1 while testing (`MIN_PLAYERS` on deploy) |

The watcher and the page detect which game `GAME_ADDRESS` is (`kind()`) and adapt. For the holders game the watcher also keeps an index of who holds and who has staked which Squeek (`watcher/squeek-index.mjs`: it reads the owner of every token, about 3 seconds for 10,000), so the page can pick a player's Squeek for them; the contract checks ownership itself. Test players play it once they hold a Squeek: the treasury owner's panel has a **Give selected to test players** button that sends Squeeks to bots without one. Bots without a Squeek sit out and get no gas.

To deploy it:

```sh
DEPLOYER_PRIVATE_KEY=<owner key> WATCHER_ADDRESS=<watcher address> npx hardhat run scripts/deploy-holders.js --network sepolia
DEPLOYER_PRIVATE_KEY=<owner key> TOKEN_IDS=12,345 npx hardhat run scripts/treasury-deposit.js --network sepolia
```

The first writes `deployments/sepolia-holders.json` (game, treasury, staking). Set `TREASURY_OWNER` to make another wallet own the treasury: the game page then shows that wallet a **Game treasury** panel to deposit its Squeeks, take them back and withdraw the developer's half, with no scripts. The second command stakes the owner's Squeeks for the game from the command line instead; the owner can take them back any time with the treasury's `withdrawNfts`, and withdraw the developer's half with `withdrawDev`. Then point the watcher's `GAME_ADDRESS` at the holders game. To move a live game to a new treasury (for example after the treasury contract changes), use `scripts/replace-treasury.js`, which explains the steps.

#### Growing the treasury's rewards

Squeekchain issues a fixed amount of SQK per Squeek block and shares it by power, so the treasury's share shrinks as other holders merge and stake. Its owner can keep up from the treasury panel:

| Lever | What it does | Call |
|---|---|---|
| Merge | Two staked Squeeks of the same level become one a level higher; the other is burned. The survivor is worth 10% more power than the pair (level power 1,000 × 2.2^(L−1)), and stays staked. Squeekchain enforces merges being open, matching levels and the cooldown | `mergeNfts(collection, survivor, donor)` |
| Stake SQK | Stakes the developer's share. Staked SQK earns `S/40 × (1 + Squeek power/1,000)` power, so each level-1 Squeek in the treasury adds one more times the base rate. Unstaking pays Squeekchain's exit fee (2%, up to 60% in a rush of exits), which is burned | `stakeDev(amount)`, `unstakeDev(amount, maxFee, deadline)` |
| Compound | Stakes the developer's share at every payout instead of holding it. If staking refuses (for example while paused), the share is held as before and the game still pays out | `setCompoundDev(true)` |

Prize money is never staked: the game's share of every harvest is paid out as before, and rewards earned by staked SQK are split at the next harvest like any other.

## How it works

```
Squeekchain live feed ──► watcher ──► SqueekChicken contract ◄── players (web app)
 (api.squeekchain.com)    posts start / end / void     holds SQK, pays winners
                          finalizes for the bounty
                          serves the web app + log
```

- **`watcher/scheduled-exits.mjs`**: auto-off. Players sign an EIP-712 "get me off N seconds into the run"; the watcher stores it (next to the game state) and sends it with `exitScheduled` once that moment comes, from its own wallet that the watcher keeps in gas. The contract checks the signature and the time, and a player can revoke every signed exit on chain with `revokeScheduledExits`.
- **`contracts/SqueekChicken.sol`**: holds the buy-ins and pays out. It sits behind a permanent proxy address (UUPS), so new rules can be added without moving to a new address; the owner can upgrade it only while no game is live or waiting for its payouts. The watcher can only post when the game started and when the hamster last moved, or void a game; it can't move money or pick winners. Optionally, `finalize` checks the watcher's end claim against Squeekchain's settled rounds (`SqueekCore`) before paying.
- **`shared/rules.js`**: the game rules for reading the feed. The watcher uses them to decide, and the web app uses the same file to animate the hamster, so what players see matches what the watcher decides.
- **`watcher/watcher.mjs`**: reads the feed every second, posts decisions, finalizes ended games, and serves the web app plus a public log at `/log`.
- **`web/`**: the web app.
  - `index.html` / `app.mjs`: the hamster cam with the players-still-on count and activity feed, the game card, and joining with a signed permit (one signature and one transaction).
  - `finale.mjs`: the end of a game. A big countdown over the wheel in the last 10 seconds of a break, then the celebration: winners, payouts, confetti and a claim button that unlocks once the game is finalized.
  - `history.html` / `history.mjs`: the results page, with every game's winners, payouts (worked out exactly as the contract's `claimable()` does) and who was caught.
  - `names.mjs`: players show by ENS name (looked up on Ethereum mainnet) or short address; the watcher's test players by name.
  - Winnings from earlier games can be claimed from the game card's "winnings to claim" list, since the card moves on to the next game as soon as one is finalized.

## Develop

```sh
npm install
npm run compile   # compiles and writes web/abi.json
npm test          # contract tests + a replay of a real night of feed data through the rules
```

`test/fixtures/feed-2026-10-26-night.jsonl` is Squeekchain's live feed as recorded on 26–27 Oct 2026, including a real 49-minute feed freeze.

### Local end-to-end run

Runs the real watcher against a local chain and a fake feed where the hamster runs for 90 seconds and then stops. The local chain only makes blocks when there are transactions, so mine one every few seconds (`evm_mine`) to mimic Sepolia.

```sh
npx hardhat node                                                     # terminal 1
CLOSE_IN=40 npx hardhat run scripts/e2e/setup.js --network localhost  # prints the game address and earliest start
node scripts/e2e/feed.mjs <run-from-unix> <run-to-unix>              # terminal 2: fake hamster
CHAIN=hardhat RPC_URL=http://127.0.0.1:8545 SQUEEK_API=http://127.0.0.1:8787 \
  GAME_ADDRESS=<game> WATCHER_PRIVATE_KEY=<hardhat account #1 key> STATE_FILE=./state.json \
  node watcher/watcher.mjs                                           # terminal 3, then open http://localhost:3000
PLAYER=0 GAME=<game> npx hardhat run scripts/e2e/exit.js --network localhost  # a player gets off
GAME=<game> npx hardhat run scripts/e2e/report.js --network localhost         # outcome and payouts
GAME=<game> npx hardhat run scripts/e2e/second-game.js --network localhost    # optional: a 2nd game on the same run (exit with GAME_ID=2)
```

## Deploy to Sepolia

1. **Keys.** Make fresh testnet-only keys and keep the file outside the repo:
   `node scripts/make-keys.mjs ~/squeek-chicken-keys.json`
   Fund both addresses with Sepolia ETH from a faucet. The deployer needs about 0.05 ETH; the watcher needs about 0.05 ETH to start, more if it runs many games.
2. **Deploy the contract.**
   `DEPLOYER_PRIVATE_KEY=<deployer key> WATCHER_ADDRESS=<watcher address> npm run deploy:sepolia`
   This writes `deployments/sepolia.json`; commit it. It uses Squeekchain's current Sepolia contracts (below) and switches the settled-round check on. Override with `SQK_ADDRESS` and `SQUEEK_CORE` (`SQUEEK_CORE=off` skips the check).
3. **Run the watcher** on an always-on host. The repo's `Dockerfile` builds it. On Railway:
   - New project → Deploy from GitHub repo → this repo.
   - Start alerts by push need `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (generate with `npx web-push generate-vapid-keys`; the private key is a secret). Without them, only the page's own alarm works. Subscriptions are kept on the volume, next to the game state.
   - Variables: `GAME_ADDRESS`, `WATCHER_PRIVATE_KEY`, and optionally `RPC_URL` (a dedicated Sepolia RPC is more reliable than the public default) and `STREAM_BROADCAST_ID` (the X broadcast the cam's "Live stream" view shows, from `x.com/i/broadcasts/<id>`; change it when the stream restarts).
   - Add a **volume** mounted at `/data`, so the watcher's game state survives restarts. Without it, a restart during a live game voids that game.
   - Generate a public domain: that URL is the web app. The live game also has a custom domain, `squeekout.fun` (bought through Railway, so its DNS records are managed in Railway's workspace Domains page; Settings → Networking → Custom Domain on the service). Link previews use whichever address the visitor came in on.
4. **Games open themselves.** Deploying saves the default rules (buy-in, bounty, minimum players, 5-minute minimum lobby), and the watcher opens the first game as soon as it starts, then a new one whenever a game finishes. To open an extra game by hand: `DEPLOYER_PRIVATE_KEY=<deployer key> EARLIEST_START=5 npm run game:sepolia`. Squeektoshi usually runs between about 21:00 and 06:00 UTC.

### Playing with a free test token

Without real SQK, deploy a game that takes **tSQK** instead: `contracts/TestSQK.sol`, a token anyone can mint (up to 10,000 per call). It has no value and isn't SQK. Everything else is real: the hamster feed, the watcher and the settled-round check.

```sh
npx hardhat run scripts/deploy-test-token.js --network sepolia
SQK_ADDRESS=<tSQK address> RECORD=sepolia-tsqk WATCHER_ADDRESS=<watcher address> npm run deploy:sepolia
```

`deploy.js` deploys the game behind an upgradeable proxy and records both addresses (`address` is the proxy, the one to use everywhere). To change the contract later, upgrade it in place between games:

```sh
DEPLOYER_PRIVATE_KEY=<owner key> RECORD=sepolia-tsqk npx hardhat run scripts/upgrade.js --network sepolia
```

The upgrade checks that the new version keeps the storage layout (new fields may only be added at the end), and the contract refuses it while a game is live or waiting for its payouts.

Point the watcher's `GAME_ADDRESS` at that game. The web app spots the test token and shows a **Get 1,000 tSQK** button to connected players. The watcher also runs 5 **test players** (`watcher/bots.mjs`; set `BOTS` to change how many, `0` for none): each has its own wallet derived from the watcher's key, mints its own tSQK, joins every game at a random moment in the lobby (about 1 in 5 times it jumps on late instead, after he starts), gets off at a random moment (greedy, steady or jumpy, like the demo) and claims what it's owed. The watcher tops up their gas with 0.002 ETH when they run low. They never play with real SQK. The current one is in `deployments/sepolia-tsqk.json` (game `0x6694d0F614D28d28b0718B7ac10FAa9650cb304E`, upgradeable, so this address stays; tSQK `0xD70d7248F309F3E33695b8582A2fE92DD8eDF233`); the real-SQK game in `deployments/sepolia.json` is still deployed.

If a deploy fails with "insufficient funds", set `SEPOLIA_GAS_PRICE` (in wei, e.g. `50000000`): Sepolia's fees are tiny, but the default 1 gwei tip makes Hardhat ask for more ETH than a test wallet holds.

### Squeekchain contracts

| Contract | Sepolia address |
|---|---|
| SqueekCore | `0x980b4424c007caf7a1f3670b48c8eaef7ebc3d44` |
| SQK | `0x5501e1fa81be1c3f49225fa7668da0245d07db60` |

This is Squeekchain's Sepolia deployment of 26 Oct 2026, confirmed by the Squeekchain team. It isn't in their published deployment record yet, so check it before deploying:

```sh
node scripts/verify-squeekchain.mjs 0x980b4424c007caf7a1f3670b48c8eaef7ebc3d44 0x5501e1fa81be1c3f49225fa7668da0245d07db60
```

It confirms SQK is the real token, that its only minter reads this SqueekCore, and that SqueekCore's settled work matches the live feed. The settled-round check relies on that last point: `finalize` waits until the round of the hamster's last movement has settled, then confirms the watcher's counter falls inside that round. On real data from 27 Oct it accepts the true 06:55 stop and catches a fake claim one round earlier. The previous deployment (`0x7466…119f`, SQK `0x6872…cc76`) was abandoned on 26 Oct 2026.

## Key security

On testnet the watcher's key is stored as a hosting environment variable. That is acceptable only because the key holds a little Sepolia ETH and can't move players' SQK: it can post a game's start and end or void a game, and the settled-round check rejects ends that contradict Squeekchain's record. Hosts can leak variables (Railway disclosed one such breach on 21 Oct 2026), so **before mainnet, move the watcher's signing into a cloud key vault** (Google Cloud KMS or AWS KMS) that the server reaches through its cloud identity, so there is no exportable key on the server. Keep the owner key off every server; it can replace a leaked watcher with `setWatcher`.

## Testnet admin powers

The deployer (owner) can create games, change the watcher address, configure the settled-round check and **upgrade the contract** (between games only). The watcher can post starts and ends, and void games; it can't take players' SQK. The owner can't either under the current code, but an upgrade replaces the code, so on testnet players trust the owner not to upgrade to something that does. Before mainnet, the upgrade right should sit with a multisig behind a timelock (so any upgrade is public days before it takes effect), or be renounced.

## Squeekchain project listing

Squeekchain's community page checks this line (keep it, it's rechecked daily), the `squeekchain-project` tag on the site's page and a `_squeekchain` TXT record on squeekout.fun.

squeekchain-project: 5708b48e-c059-4c99-84cb-fd24bfcd3fa5

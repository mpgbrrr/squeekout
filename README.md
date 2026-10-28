# Squeekchain Chicken

A testnet game of chicken on [Squeekchain](https://docs.squeekchain.com/), the blockchain powered by Squeektoshi the hamster running on his wheel.

Everyone buys in with SQK while the lobby is open. The lobby closes the moment the hamster starts running, and you're on the wheel. Get off whenever you like: the longer you stay, the bigger your share. Once the wheel has been still for 3 minutes, the game ends at his last movement. Anyone still on, or who got off too late, is caught and gets nothing. When a game finishes, the next one opens automatically.

**Sepolia testnet only.** Testnet SQK has no value.

## Rules

| Rule | Value |
|---|---|
| Lobby | Always one open. Enter, or leave with an immediate refund, until Squeektoshi starts running |
| Game starts | At his first movement once the lobby has been open at least **5 minutes** |
| Late entries | An entry that lands after his first movement (before the watcher posts the start) is refunded |
| Next game | Opens automatically as soon as the previous one finishes |
| Game ends | When the wheel has been still for **3 minutes**, at his last movement |
| Grace | Exits up to **12 s** (one Ethereum block) after his last movement still win |
| Payout curve | Your weight grows **+25% every 2 minutes** you stay in, smoothly to the second |
| Jackpot | **20%** of the pot is shared by the **last 10%** of winners (at least one) |
| Everyone else who got off in time | Shares the other 80% by weight |
| Everyone caught | The pot rolls into the next game |
| House fee | None |
| Payout bounty | A flat SQK amount to whoever finalizes the game, capped at **1%** of the pot |
| Feed outage | If Squeekchain's live feed drops: the game can't end while it's down. When it returns, the game carries on if the hamster didn't run during the gap, or if the gap was too short to hide a 3-minute stop. Otherwise the game is **voided and everyone refunded**. An outage over **30 minutes** also voids it. |
| Backstop | If a game can't finish within 7 days of its earliest start, anyone can refund it |

## How it works

```
Squeekchain live feed ──► watcher ──► SqueekChicken contract ◄── players (web app)
 (api.squeekchain.com)    posts start / end / void     holds SQK, pays winners
                          finalizes for the bounty
                          serves the web app + log
```

- **`contracts/SqueekChicken.sol`**: holds the buy-ins and pays out. The watcher can only post when the game started and when the hamster last moved, or void a game; it can't move money or pick winners. Optionally, `finalize` checks the watcher's end claim against Squeekchain's settled rounds (`SqueekCore`) before paying.
- **`shared/rules.js`**: the game rules for reading the feed. The watcher uses them to decide, and the web app uses the same file to animate the hamster, so what players see matches what the watcher decides.
- **`watcher/watcher.mjs`**: reads the feed every second, posts decisions, finalizes ended games, and serves the web app plus a public log at `/log`.
- **`web/`**: the web app, including the 8-bit hamster cam.

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
   - Variables: `GAME_ADDRESS`, `WATCHER_PRIVATE_KEY`, and optionally `RPC_URL` (a dedicated Sepolia RPC is more reliable than the public default).
   - Add a **volume** mounted at `/data`, so the watcher's game state survives restarts. Without it, a restart during a live game voids that game.
   - Generate a public domain: that URL is the web app.
4. **Games open themselves.** Deploying saves the default rules (buy-in, bounty, minimum players, 5-minute minimum lobby), and the watcher opens the first game as soon as it starts, then a new one whenever a game finishes. To open an extra game by hand: `DEPLOYER_PRIVATE_KEY=<deployer key> EARLIEST_START=5 npm run game:sepolia`. Squeektoshi usually runs between about 21:00 and 06:00 UTC.

### Playing with a free test token

Without real SQK, deploy a game that takes **tSQK** instead: `contracts/TestSQK.sol`, a token anyone can mint (up to 10,000 per call). It has no value and isn't SQK. Everything else is real: the hamster feed, the watcher and the settled-round check.

```sh
npx hardhat run scripts/deploy-test-token.js --network sepolia
SQK_ADDRESS=<tSQK address> RECORD=sepolia-tsqk WATCHER_ADDRESS=<watcher address> npm run deploy:sepolia
```

Point the watcher's `GAME_ADDRESS` at that game. The web app spots the test token and shows a **Get 1,000 tSQK** button to connected players. The current one is in `deployments/sepolia-tsqk.json` (game `0x6F170b3CBF48fe6444e4d7b75812b30F33fCc7cC`, tSQK `0xD70d7248F309F3E33695b8582A2fE92DD8eDF233`); the real-SQK game in `deployments/sepolia.json` is still deployed.

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

The deployer (owner) can create games, change the watcher address and configure the settled-round check. The watcher can post starts and ends, and void games. Neither can take players' SQK: refunds and winnings are paid only by the contract's rules.

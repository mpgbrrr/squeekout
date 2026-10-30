// Opens an extra game by hand with the agreed rules. Run by the contract owner. Usually unnecessary: the
// watcher opens a new game whenever the previous one finishes.
//   GAME_ADDRESS     deployed SqueekChicken (defaults to deployments/<network>.json)
//   EARLIEST_START   the game can't start before this: an ISO time (2026-10-28T21:00:00Z) or minutes from now (e.g. 5).
//                    Entries stay open until the hamster's first run after it.
//   BUY_IN           SQK per player (default 100)
//   BOUNTY           flat SQK paid to whoever finalizes (default 5; capped at 1% of the pot by the contract)
//   MIN_PLAYERS      default 2 on testnet, so you can play against yourself from two wallets
// Usage: EARLIEST_START=5 npx hardhat run scripts/create-game.js --network sepolia
const fs = require("node:fs");
const path = require("node:path");
const { ethers, network } = require("hardhat");

async function main() {
  const env = process.env;
  const address = env.GAME_ADDRESS || JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`))).address;
  const earliest = /^\d+$/.test(env.EARLIEST_START || "") ? Math.floor(Date.now() / 1000) + Number(env.EARLIEST_START) * 60
    : Math.floor(Date.parse(env.EARLIEST_START || "") / 1000);
  if (!earliest || Number.isNaN(earliest)) throw new Error("Set EARLIEST_START to an ISO time or a number of minutes from now");
  const params = {
    buyIn: ethers.parseEther(env.BUY_IN || "100"),
    earliestStart: earliest,
    idleWindow: 180, // the wheel still for 3 minutes ends the game
    grace: 12, // one Ethereum block
    jackpotBps: 2000, // 20% jackpot
    jackpotGroupBps: 1000, // shared by the last 10% of winners
    bountyFlat: ethers.parseEther(env.BOUNTY || "5"),
    minPlayers: Number(env.MIN_PLAYERS || 2),
    maxPlayers: 200,
    lateEntryWindow: 120, // entries stay open 2 minutes after the start, until the first exit
  };
  const game = await ethers.getContractAt("SqueekChicken", address);
  const tx = await game.createGame(params);
  await tx.wait();
  const id = await game.gameCount();
  console.log(`Created game #${id}: can start from ${new Date(earliest * 1000).toISOString()}, buy-in ${env.BUY_IN || 100} SQK (tx ${tx.hash})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

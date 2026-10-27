// Opens a new game with the agreed rules. Run by the contract owner.
//   GAME_ADDRESS   deployed SqueekChicken (defaults to deployments/<network>.json)
//   LOBBY_CLOSE    when entries close: an ISO time (2026-10-28T21:00:00Z) or minutes from now (e.g. 30)
//   BUY_IN         SQK per player (default 100)
//   BOUNTY         flat SQK paid to whoever finalizes (default 5; capped at 1% of the pot by the contract)
//   MIN_PLAYERS    default 2 on testnet, so you can play against yourself from two wallets
// Usage: LOBBY_CLOSE=30 npx hardhat run scripts/create-game.js --network sepolia
const fs = require("node:fs");
const path = require("node:path");
const { ethers, network } = require("hardhat");

async function main() {
  const env = process.env;
  const address = env.GAME_ADDRESS || JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`))).address;
  const close = /^\d+$/.test(env.LOBBY_CLOSE || "") ? Math.floor(Date.now() / 1000) + Number(env.LOBBY_CLOSE) * 60
    : Math.floor(Date.parse(env.LOBBY_CLOSE || "") / 1000);
  if (!close || Number.isNaN(close)) throw new Error("Set LOBBY_CLOSE to an ISO time or a number of minutes from now");
  const params = {
    buyIn: ethers.parseEther(env.BUY_IN || "100"),
    lobbyClose: close,
    idleWindow: 180, // the wheel still for 3 minutes ends the game
    grace: 12, // one Ethereum block
    curveStep: 120, // +25% weight per 2 minutes
    jackpotBps: 2000, // 20% jackpot
    jackpotGroupBps: 1000, // shared by the last 10% of winners
    bountyFlat: ethers.parseEther(env.BOUNTY || "5"),
    minPlayers: Number(env.MIN_PLAYERS || 2),
    maxPlayers: 200,
  };
  const game = await ethers.getContractAt("SqueekChicken", address);
  const tx = await game.createGame(params);
  await tx.wait();
  const id = await game.gameCount();
  console.log(`Created game #${id}: lobby closes ${new Date(close * 1000).toISOString()}, buy-in ${env.BUY_IN || 100} SQK (tx ${tx.hash})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

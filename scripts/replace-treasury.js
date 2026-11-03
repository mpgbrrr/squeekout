// Moves the holders game to a new treasury (for example one with an adjustable prize share). Run by the game's
// owner (the deployer), between runs, once the old treasury has no unpaid rewards (prize so far 0, which it is
// right after a game pays out). Steps:
//   1. The treasury owner withdraws the Squeeks and the developer share from the old treasury (treasury panel).
//   2. This script deploys the new treasury, hands it to TREASURY_OWNER and points the game at it.
//   3. The treasury owner deposits the Squeeks into the new treasury (the panel shows it once the page reloads).
//   DEPLOYER_PRIVATE_KEY  the game's owner
//   TREASURY_OWNER        the wallet that will own the new treasury (default: the old treasury's owner)
//   PRIZE_SHARE           optional starting prize share in percent (default 50)
//   RECORD                the record in deployments/ (default: <network>-holders)
// Usage: npx hardhat run scripts/replace-treasury.js --network sepolia
const fs = require("node:fs");
const path = require("node:path");
const { ethers, network } = require("hardhat");

async function main() {
  const env = process.env;
  const out = path.join(__dirname, "..", "deployments", `${env.RECORD || `${network.name}-holders`}.json`);
  const record = JSON.parse(fs.readFileSync(out, "utf8"));
  const game = await ethers.getContractAt("SqueekHolders", record.address);
  const old = await ethers.getContractAt("ChickenTreasury", await game.treasury());
  const pending = await old.pendingToGame();
  if (pending > 0n) throw new Error(`The old treasury still has ${ethers.formatEther(pending)} SQK of prize money on its way: switch right after a game pays out`);
  const owner = env.TREASURY_OWNER || (await old.owner());
  const treasury = await (await ethers.getContractFactory("ChickenTreasury")).deploy(await game.sqk(), record.staking);
  await treasury.waitForDeployment();
  await (await treasury.setGame(game.target)).wait();
  if (env.PRIZE_SHARE) await (await treasury.setGameShare(Math.round(Number(env.PRIZE_SHARE) * 100))).wait();
  await (await treasury.transferOwnership(owner)).wait();
  await (await game.setTreasury(treasury.target)).wait();
  console.log(`Game ${game.target} now uses treasury ${treasury.target} (owner ${owner}); the old one was ${old.target}`);
  record.previousTreasuries = [...(record.previousTreasuries ?? []), { address: old.target, replaced: new Date().toISOString().slice(0, 10) }];
  record.treasury = treasury.target;
  record.treasuryOwner = owner;
  fs.writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

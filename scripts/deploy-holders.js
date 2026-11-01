// Deploys the free holders game (SqueekHolders, behind an upgradeable proxy) and its treasury
// (ChickenTreasury), which stakes the game's Squeeks and sends half of what they earn to the game as prizes
// and keeps half for the developer (the deployer, who owns both).
//   DEPLOYER_PRIVATE_KEY  pays for the deploy; becomes the owner of the game and the treasury
//   WATCHER_ADDRESS       address of the watcher service's key
//   STAKING               Squeekchain's SqueekStaking (default: its Sepolia proxy). Its reward token is the prize
//                         token, and its genesis collection is the first collection whose holders may enter.
//   SQUEEK_CORE           the SqueekCore that the settled-round check reads (default: Sepolia's; "off" to skip)
//   MIN_PLAYERS (1 while testing: a game with a single player still runs), MIN_LOBBY seconds (300), BOUNTY SQK (5), PRIZE_DELAY seconds after he stops before the
//   prize is paid out (2400, so the run's rewards have streamed in)
//   RECORD                name of the record in deployments/ (default: <network>-holders)
// Then put the game's Squeeks in the treasury: scripts/treasury-deposit.js.
// Usage: npx hardhat run scripts/deploy-holders.js --network sepolia
const fs = require("node:fs");
const path = require("node:path");
const { ethers, network, upgrades } = require("hardhat");

const SEPOLIA_STAKING = "0x4b67b739dfd832f4eac67a7aa3bc244fb74cea4f";
const SEPOLIA_CORE = "0x980b4424c007caf7a1f3670b48c8eaef7ebc3d44";

async function main() {
  const env = process.env;
  const watcher = env.WATCHER_ADDRESS;
  if (!ethers.isAddress(watcher)) throw new Error("Set WATCHER_ADDRESS to the watcher's address");
  const staking = env.STAKING || SEPOLIA_STAKING;
  const core = env.SQUEEK_CORE || SEPOLIA_CORE;
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying from ${deployer.address} on ${network.name}`);
  const game = await upgrades.deployProxy(await ethers.getContractFactory("SqueekHolders"), [staking, watcher, deployer.address], { kind: "uups" });
  const receipt = await game.deploymentTransaction().wait();
  const implementation = await upgrades.erc1967.getImplementationAddress(game.target);
  const sqk = await game.sqk();
  const treasury = await (await ethers.getContractFactory("ChickenTreasury")).deploy(sqk, staking);
  await treasury.waitForDeployment();
  await (await treasury.setGame(game.target)).wait();
  await (await game.setTreasury(treasury.target)).wait();
  console.log(`Game (proxy) ${game.target}, implementation ${implementation}, treasury ${treasury.target}`);
  if (core !== "off") {
    await (await game.setRoundCheck(core, true)).wait();
    console.log(`Settled-round check on, reading SqueekCore ${core}`);
  }
  const minLobby = Number(env.MIN_LOBBY || 300);
  await (await game.setDefaults({
    earliestStart: 0, // set per game: opening time + minLobby
    idleWindow: 180, // the wheel still for 3 minutes ends the game
    grace: 12, // one Ethereum block
    jackpotBps: 2000, // 20% jackpot
    jackpotGroupBps: 1000, // shared by the last 10% of winners
    bountyFlat: ethers.parseEther(env.BOUNTY || "5"),
    minPlayers: Number(env.MIN_PLAYERS || 1),
    maxPlayers: 500,
    lateEntryWindow: 120, // entries stay open 2 minutes after the start, until the first exit
    prizeDelay: Number(env.PRIZE_DELAY || 2400),
  }, minLobby)).wait();
  const record = {
    network: network.name, chainId: Number(network.config.chainId || 31337), kind: "holders", address: game.target, proxy: "UUPS",
    implementation, treasury: treasury.target, staking, sqk, collections: await game.getCollections(), watcher,
    roundCheckCore: core === "off" ? null : core, owner: deployer.address, deployTx: receipt.hash, block: receipt.blockNumber,
    deployedAt: new Date().toISOString(), upgrades: [],
  };
  const out = path.join(__dirname, "..", "deployments", `${env.RECORD || `${network.name}-holders`}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
  console.log(JSON.stringify(record, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

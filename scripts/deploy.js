// Deploys SqueekChicken to Sepolia behind an upgradeable (UUPS) proxy: the proxy's address is the game's
// permanent address; later versions are installed with scripts/upgrade.js.
//   DEPLOYER_PRIVATE_KEY  pays for the deploy and becomes the owner (testnet admin)
//   WATCHER_ADDRESS       address of the watcher service's key
//   SQK_ADDRESS           optional; defaults to the SQK of Squeekchain's 26 Oct 2026 Sepolia deployment
//   SQUEEK_CORE           optional; the SqueekCore that the settled-round check reads (set "off" to skip)
//   BUY_IN, BOUNTY        default game settings in SQK (100 and 5); MIN_PLAYERS (2); MIN_LOBBY seconds (300)
//   RECORD                optional name of the record in deployments/ (default: the network name). A game
//                         already in that record moves to its "previous" list, so players can still claim there.
//   WHY                   optional note on why the previous game was replaced
// Usage: npx hardhat run scripts/deploy.js --network sepolia
const fs = require("node:fs");
const path = require("node:path");
const { ethers, network, upgrades } = require("hardhat");

// Squeekchain's Sepolia deployment of 26 Oct 2026, confirmed by the Squeekchain team and checked on-chain with
// scripts/verify-squeekchain.mjs (SQK's minter reads this SqueekCore; settled work matches the live feed).
// Not yet in the published record at https://docs.squeekchain.com/assets/deployments/sepolia.json.
const DEFAULT_SQK = "0x5501e1fa81be1c3f49225fa7668da0245d07db60";
const DEFAULT_CORE = "0x980b4424c007caf7a1f3670b48c8eaef7ebc3d44";

async function main() {
  const sqk = process.env.SQK_ADDRESS || DEFAULT_SQK;
  const core = process.env.SQUEEK_CORE || DEFAULT_CORE;
  const watcher = process.env.WATCHER_ADDRESS;
  if (!ethers.isAddress(watcher)) throw new Error("Set WATCHER_ADDRESS to the watcher's address");
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying from ${deployer.address} on ${network.name}`);
  const game = await upgrades.deployProxy(await ethers.getContractFactory("SqueekChicken"),
    [sqk, watcher, deployer.address], { kind: "uups" });
  const receipt = await game.deploymentTransaction().wait();
  const implementation = await upgrades.erc1967.getImplementationAddress(game.target);
  console.log(`Game (proxy) ${game.target}, implementation ${implementation}`);
  if (core !== "off") {
    await (await game.setRoundCheck(core, true)).wait();
    console.log(`Settled-round check on, reading SqueekCore ${core}`);
  }
  // The agreed rules. The watcher opens each new game with these as soon as the previous one finishes.
  const env = process.env;
  const minLobby = Number(env.MIN_LOBBY || 300);
  await (await game.setDefaults({
    buyIn: ethers.parseEther(env.BUY_IN || "100"),
    earliestStart: 0, // set per game: opening time + minLobby
    idleWindow: 180, // the wheel still for 3 minutes ends the game
    grace: 12, // one Ethereum block
    jackpotBps: 2000, // 20% jackpot
    jackpotGroupBps: 1000, // shared by the last 10% of winners
    bountyFlat: ethers.parseEther(env.BOUNTY || "5"),
    minPlayers: Number(env.MIN_PLAYERS || 2),
    maxPlayers: 200,
    lateEntryWindow: Number(env.LATE_ENTRY || 120), // entries stay open 2 minutes after the start, until the first exit
  }, minLobby)).wait();
  console.log(`Default game settings saved; lobbies stay open at least ${minLobby} s`);
  const out = path.join(__dirname, "..", "deployments", `${env.RECORD || network.name}.json`);
  const old = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : null;
  const previous = old ? [{ address: old.address, deployTx: old.deployTx, retired: new Date().toISOString().slice(0, 10),
    ...(env.WHY ? { why: env.WHY } : {}) }, ...(old.previous ?? [])] : [];
  const record = {
    network: network.name, chainId: Number(network.config.chainId || 31337), address: game.target, proxy: "UUPS", implementation, sqk, watcher,
    roundCheckCore: core === "off" ? null : core,
    owner: deployer.address, deployTx: receipt.hash, block: receipt.blockNumber, deployedAt: new Date().toISOString(),
    upgrades: [], previous,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
  console.log(JSON.stringify(record, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

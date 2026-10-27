// Deploys SqueekChicken to Sepolia.
//   DEPLOYER_PRIVATE_KEY  pays for the deploy and becomes the owner (testnet admin)
//   WATCHER_ADDRESS       address of the watcher service's key
//   SQK_ADDRESS           optional; defaults to SQK from Squeekchain's published Sepolia deployment record
// Usage: npx hardhat run scripts/deploy.js --network sepolia
const fs = require("node:fs");
const path = require("node:path");
const { ethers, network } = require("hardhat");

// From https://docs.squeekchain.com/assets/deployments/sepolia.json (SqueekToken is immutable).
const PUBLISHED_SQK = "0x6872bfa5ccc3e9e440c6c16e5ffdabb8dba4cc76";

async function main() {
  const sqk = process.env.SQK_ADDRESS || PUBLISHED_SQK;
  const watcher = process.env.WATCHER_ADDRESS;
  if (!ethers.isAddress(watcher)) throw new Error("Set WATCHER_ADDRESS to the watcher's address");
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying from ${deployer.address} on ${network.name}`);
  const game = await (await ethers.getContractFactory("SqueekChicken")).deploy(sqk, watcher);
  const receipt = await game.deploymentTransaction().wait();
  const record = {
    network: network.name, chainId: Number(network.config.chainId || 31337), address: game.target, sqk, watcher,
    owner: deployer.address, deployTx: receipt.hash, block: receipt.blockNumber, deployedAt: new Date().toISOString(),
  };
  const out = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
  console.log(JSON.stringify(record, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

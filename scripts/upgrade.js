// Upgrades the game in place to the current contracts/SqueekChicken.sol. Run by the owner, between games: the
// contract refuses while a game is live or waiting for its payouts. The plugin first checks that the new
// version keeps the storage layout (new fields only at the end), using the record in .openzeppelin/.
//   DEPLOYER_PRIVATE_KEY  the owner's key
//   RECORD                the record in deployments/ (default: the network name)
//   NOTE                  optional note on what changed, kept in the record
// Usage: RECORD=sepolia-tsqk npx hardhat run scripts/upgrade.js --network sepolia
const fs = require("node:fs");
const path = require("node:path");
const { ethers, network, upgrades } = require("hardhat");

async function main() {
  const out = path.join(__dirname, "..", "deployments", `${process.env.RECORD || network.name}.json`);
  const record = JSON.parse(fs.readFileSync(out, "utf8"));
  if (record.proxy !== "UUPS") throw new Error(`${record.address} isn't an upgradeable game; deploy a new one with scripts/deploy.js`);
  const game = await upgrades.upgradeProxy(record.address, await ethers.getContractFactory("SqueekChicken"), { kind: "uups" });
  // Public nodes can lag behind the upgrade transaction: wait until they report the new implementation.
  let implementation = record.implementation;
  for (let i = 0; i < 40 && implementation.toLowerCase() === record.implementation.toLowerCase(); i++) {
    await new Promise((r) => setTimeout(r, 3000));
    implementation = await upgrades.erc1967.getImplementationAddress(game.target);
  }
  console.log(`Game ${game.target} now runs version ${await game.version()} (implementation ${implementation})`);
  record.upgrades = [...(record.upgrades ?? []), { from: record.implementation, to: implementation, at: new Date().toISOString(), ...(process.env.NOTE ? { note: process.env.NOTE } : {}) }];
  record.implementation = implementation;
  fs.writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

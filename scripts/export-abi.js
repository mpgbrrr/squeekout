// Copies the compiled game ABIs to web/, which the watcher and the web app both load: web/abi.json for the paid
// game (SqueekChicken), web/abi-holders.json for the free holders game (SqueekHolders) and web/abi-treasury.json for
// its treasury (ChickenTreasury).
// Run after `npx hardhat compile`.
const fs = require("node:fs");
const path = require("node:path");

for (const [name, file] of [["SqueekChicken", "abi.json"], ["SqueekHolders", "abi-holders.json"], ["ChickenTreasury", "abi-treasury.json"]]) {
  const artifact = require(`../artifacts/contracts/${name}.sol/${name}.json`);
  const out = path.join(__dirname, "..", "web", file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(artifact.abi, null, 2) + "\n");
  console.log(`Wrote ${artifact.abi.length} ABI entries to web/${file}`);
}

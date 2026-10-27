// Copies the compiled SqueekChicken ABI to web/abi.json, which the watcher and the web app both load.
// Run after `npx hardhat compile`.
const fs = require("node:fs");
const path = require("node:path");

const artifact = require("../artifacts/contracts/SqueekChicken.sol/SqueekChicken.json");
const out = path.join(__dirname, "..", "web", "abi.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(artifact.abi, null, 2) + "\n");
console.log(`Wrote ${artifact.abi.length} ABI entries to web/abi.json`);

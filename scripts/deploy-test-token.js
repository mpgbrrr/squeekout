// Deploys TestSQK, a free-mint stand-in for $SQK, so games can be played on Sepolia without real SQK.
// Then deploy a game that uses it:
//   SQK_ADDRESS=<printed address> RECORD=sepolia-tsqk WATCHER_ADDRESS=... npx hardhat run scripts/deploy.js --network sepolia
// Usage: npx hardhat run scripts/deploy-test-token.js --network sepolia
const { ethers, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const token = await (await ethers.getContractFactory("TestSQK")).deploy();
  const receipt = await token.deploymentTransaction().wait();
  console.log(`TestSQK (tSQK) deployed on ${network.name} at ${token.target} by ${deployer.address} (block ${receipt.blockNumber})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Puts Squeeks from the owner's wallet into the holders game's treasury, which stakes them so their rewards
// fund the prizes (half) and the developer (half). The owner can take them back any time with the treasury's
// withdrawNfts. Run by the owner (the deployer of deploy-holders.js).
//   DEPLOYER_PRIVATE_KEY  the owner, holding the Squeeks
//   TOKEN_IDS             Squeek numbers, comma-separated (e.g. 12,345)
//   COLLECTION            optional; defaults to the game's first collection (the genesis Squeeks)
//   RECORD                the record in deployments/ (default: <network>-holders)
// Usage: TOKEN_IDS=12,345 npx hardhat run scripts/treasury-deposit.js --network sepolia
const fs = require("node:fs");
const path = require("node:path");
const { ethers, network } = require("hardhat");

async function main() {
  const env = process.env;
  const record = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${env.RECORD || `${network.name}-holders`}.json`)));
  const ids = (env.TOKEN_IDS || "").split(",").map((x) => x.trim()).filter(Boolean).map(BigInt);
  if (!ids.length) throw new Error("Set TOKEN_IDS to the Squeek numbers to deposit, e.g. TOKEN_IDS=12,345");
  const collection = env.COLLECTION || record.collections[0];
  const nft = new ethers.Contract(collection, ["function setApprovalForAll(address,bool)", "function isApprovedForAll(address,address) view returns (bool)"], (await ethers.getSigners())[0]);
  const [owner] = await ethers.getSigners();
  if (!(await nft.isApprovedForAll(owner.address, record.treasury))) await (await nft.setApprovalForAll(record.treasury, true)).wait();
  const treasury = await ethers.getContractAt("ChickenTreasury", record.treasury);
  const tx = await treasury.depositNfts(collection, ids);
  await tx.wait();
  console.log(`Staked Squeeks ${ids.join(", ")} for the game (tx ${tx.hash})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

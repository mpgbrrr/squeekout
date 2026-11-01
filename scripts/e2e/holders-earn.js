// Stands in for the hamster's reward stream: credits the holders game's treasury with AMOUNT SQK in staking.
const { ethers } = require("hardhat");
async function main() {
  const staking = await ethers.getContractAt("MockStaking", process.env.STAKING);
  await (await staking.accrue(process.env.TREASURY, ethers.parseEther(process.env.AMOUNT || "1000"))).wait();
  console.log(`treasury earned ${process.env.AMOUNT || 1000} SQK`);
}
main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });

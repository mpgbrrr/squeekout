// Local end-to-end: the treasury's Squeeks earn AMOUNT SQK (standing in for Squeekchain's reward stream).
const { ethers } = require("hardhat");
async function main() {
  const [owner] = await ethers.getSigners();
  const staking = await ethers.getContractAt("MockStaking", process.env.STAKING);
  const sqk = await ethers.getContractAt("MockSQK", await staking.token());
  const amount = ethers.parseEther(process.env.AMOUNT || "100");
  await (await sqk.mint(owner.address, amount)).wait();
  await (await sqk.approve(staking.target, amount)).wait();
  await (await staking.accrue(process.env.TREASURY, amount)).wait();
  console.log(`the treasury's Squeeks earned ${process.env.AMOUNT || 100} SQK`);
}
main().catch((e) => { console.error(e); process.exit(1); });

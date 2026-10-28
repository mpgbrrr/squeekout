// Local end-to-end: a stand-in staking contract and two Squeeks in a ChickenTreasury for game GAME.
// BONUS_DELAY seconds (default 60) after the hamster stops, the watcher settles the bonus.
const { ethers } = require("hardhat");
async function main() {
  const [owner] = await ethers.getSigners();
  const game = await ethers.getContractAt("SqueekChicken", process.env.GAME);
  const sqk = await game.sqk();
  const nft = await (await ethers.getContractFactory("MockNFT")).deploy();
  const staking = await (await ethers.getContractFactory("MockStaking")).deploy(sqk);
  const treasury = await (await ethers.getContractFactory("ChickenTreasury")).deploy(sqk, staking.target);
  await (await treasury.setGame(game.target)).wait();
  await (await game.setTreasury(treasury.target, Number(process.env.BONUS_DELAY || 60))).wait();
  for (const id of [1, 2]) await (await nft.mint(owner.address, id)).wait();
  await (await nft.setApprovalForAll(treasury.target, true)).wait();
  await (await treasury.depositNfts(nft.target, [1, 2])).wait();
  console.log(JSON.stringify({ treasury: treasury.target, staking: staking.target, nft: nft.target }));
}
main().catch((e) => { console.error(e); process.exit(1); });

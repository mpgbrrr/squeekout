// Local end-to-end setup for the holders game: stand-ins for SQK, the Squeek collection and Squeekchain's
// staking; the game behind its proxy with account #1 as watcher and a 60 s prize delay; a treasury staking
// Squeeks #100 and #101, owned (for the page's treasury panel) by account #7, which holds Squeeks #7 and #8.
// Accounts #2-#4 hold Squeeks #1-#3, #5 has staked #4, #6 holds none. #2 and #3 join.
const { ethers, upgrades } = require("hardhat");
async function main() {
  const [owner, watcher, a, b, c, staker] = await ethers.getSigners();
  const sqk = await (await ethers.getContractFactory("MockSQK")).deploy();
  const nft = await (await ethers.getContractFactory("MockNFT")).deploy();
  const staking = await (await ethers.getContractFactory("MockStaking")).deploy(sqk.target, nft.target);
  const game = await upgrades.deployProxy(await ethers.getContractFactory("SqueekHolders"), [staking.target, watcher.address, owner.address], { kind: "uups" });
  const treasury = await (await ethers.getContractFactory("ChickenTreasury")).deploy(sqk.target, staking.target);
  await (await treasury.setGame(game.target)).wait();
  await (await game.setTreasury(treasury.target)).wait();
  for (const id of [100, 101]) await (await nft.mint(owner.address, id)).wait();
  await (await nft.setApprovalForAll(treasury.target, true)).wait();
  await (await treasury.depositNfts(nft.target, [100, 101])).wait();
  for (const [p, id] of [[a, 1], [b, 2], [c, 3], [staker, 4]]) await (await nft.mint(p.address, id)).wait();
  const treasuryOwner = (await ethers.getSigners())[7];
  for (const id of [7, 8]) await (await nft.mint(treasuryOwner.address, id)).wait();
  await (await treasury.transferOwnership(treasuryOwner.address)).wait();
  await (await nft.connect(staker).setApprovalForAll(staking.target, true)).wait();
  await (await staking.connect(staker).deposit(nft.target, [4])).wait();
  const rules = { idleWindow: 180, grace: 12, jackpotBps: 2000, jackpotGroupBps: 1000, bountyFlat: ethers.parseEther("5"),
    minPlayers: 3, maxPlayers: 200, lateEntryWindow: 120, prizeDelay: 60 };
  const close = Math.floor(Date.now() / 1000) + Number(process.env.CLOSE_IN || 60);
  await (await game.setDefaults({ ...rules, earliestStart: 0 }, 300)).wait();
  await (await game.createGame({ ...rules, earliestStart: close })).wait();
  for (const [p, id] of [[a, 1], [b, 2]]) await (await game.connect(p).enter(1, nft.target, id)).wait();
  await (await sqk.mint(owner.address, ethers.parseEther("100000"))).wait();
  await (await sqk.approve(staking.target, ethers.MaxUint256)).wait();
  console.log(JSON.stringify({ game: game.target, staking: staking.target, treasury: treasury.target, nft: nft.target, earliestStart: close }));
}
main().catch((e) => { console.error(e); process.exit(1); });

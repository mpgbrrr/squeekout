// Local end-to-end setup: the free test token (so the watcher's test players play too), the game behind its
// upgradeable proxy with account #1 as watcher, and a game three players join.
// The game can start CLOSE_IN seconds from now, at the fake hamster's first movement after that.
const { ethers, upgrades } = require("hardhat");
async function main() {
  const [owner, watcher, a, b, c] = await ethers.getSigners();
  const sqk = await (await ethers.getContractFactory("TestSQK")).deploy();
  const game = await upgrades.deployProxy(await ethers.getContractFactory("SqueekChicken"), [sqk.target, watcher.address, owner.address], { kind: "uups" });
  const close = Math.floor(Date.now() / 1000) + Number(process.env.CLOSE_IN || 40);
  await (await game.createGame({ buyIn: ethers.parseEther("100"), earliestStart: close, idleWindow: 180, grace: 12,
    jackpotBps: 2000, jackpotGroupBps: 1000, bountyFlat: ethers.parseEther("5"), minPlayers: 2, maxPlayers: 200, lateEntryWindow: 120 })).wait();
  // Defaults let the watcher open the next game itself once this one finishes.
  await (await game.setDefaults({ buyIn: ethers.parseEther("100"), earliestStart: 0, idleWindow: 180, grace: 12,
    jackpotBps: 2000, jackpotGroupBps: 1000, bountyFlat: ethers.parseEther("5"), minPlayers: 2, maxPlayers: 200, lateEntryWindow: 120 }, 300)).wait();
  for (const p of [a, b, c]) {
    await (await sqk.mint(p.address, ethers.parseEther("1000"))).wait();
    await (await sqk.connect(p).approve(game.target, ethers.MaxUint256)).wait();
    await (await game.connect(p).enter(1)).wait();
  }
  console.log(JSON.stringify({ game: game.target, sqk: sqk.target, earliestStart: close }));
}
main().catch((e) => { console.error(e); process.exit(1); });

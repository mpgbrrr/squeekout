// Local end-to-end setup: test SQK, the game with account #1 as watcher, and a game three players join.
const { ethers } = require("hardhat");
async function main() {
  const [owner, watcher, a, b, c] = await ethers.getSigners();
  const sqk = await (await ethers.getContractFactory("MockSQK")).deploy();
  const game = await (await ethers.getContractFactory("SqueekChicken")).deploy(sqk.target, watcher.address);
  const close = Math.floor(Date.now() / 1000) + Number(process.env.CLOSE_IN || 40);
  await (await game.createGame({ buyIn: ethers.parseEther("100"), lobbyClose: close, idleWindow: 180, grace: 12, curveStep: 120,
    jackpotBps: 2000, jackpotGroupBps: 1000, bountyFlat: ethers.parseEther("5"), minPlayers: 2, maxPlayers: 200 })).wait();
  for (const p of [a, b, c]) {
    await (await sqk.mint(p.address, ethers.parseEther("1000"))).wait();
    await (await sqk.connect(p).approve(game.target, ethers.MaxUint256)).wait();
    await (await game.connect(p).enter(1)).wait();
  }
  console.log(JSON.stringify({ game: game.target, sqk: sqk.target, lobbyClose: close }));
}
main().catch((e) => { console.error(e); process.exit(1); });

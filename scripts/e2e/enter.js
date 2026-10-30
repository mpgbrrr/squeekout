// Player number PLAYER (accounts #2 up) mints test tokens and enters game GAME_ID (default 1), for example
// late, after the start. Prints the block time, or the contract's reason if the entry is refused.
const { ethers } = require("hardhat");
async function main() {
  const signers = await ethers.getSigners();
  const p = signers[2 + Number(process.env.PLAYER)];
  const game = await ethers.getContractAt("SqueekChicken", process.env.GAME);
  const sqk = await ethers.getContractAt("TestSQK", await game.sqk());
  await (await sqk.connect(p).mint(p.address, ethers.parseEther("1000"))).wait();
  await (await sqk.connect(p).approve(game.target, ethers.MaxUint256)).wait();
  const id = Number(process.env.GAME_ID || 1);
  const r = await (await game.connect(p).enter(id)).wait();
  console.log(`player ${process.env.PLAYER} entered game ${id} at block time ${(await ethers.provider.getBlock(r.blockNumber)).timestamp}`);
}
main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });

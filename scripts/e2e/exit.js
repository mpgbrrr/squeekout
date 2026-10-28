// Player number PLAYER (0-2 → accounts #2-#4) gets off the wheel in game GAME_ID (default 1).
const { ethers } = require("hardhat");
async function main() {
  const signers = await ethers.getSigners();
  const p = signers[2 + Number(process.env.PLAYER)];
  const game = await ethers.getContractAt("SqueekChicken", process.env.GAME);
  const tx = await game.connect(p).exit(Number(process.env.GAME_ID || 1));
  const r = await tx.wait();
  console.log(`player ${process.env.PLAYER} exited game ${process.env.GAME_ID || 1} at block time ${(await ethers.provider.getBlock(r.blockNumber)).timestamp}`);
}
main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });

// Opens a second game alongside game 1 with the same start window, and the same three players join it,
// so one hamster run plays both games (for testing winnings from several games stacking up).
const { ethers } = require("hardhat");
async function main() {
  const [, , a, b, c] = await ethers.getSigners();
  const game = await ethers.getContractAt("SqueekChicken", process.env.GAME);
  const g1 = await game.getGame(1);
  await (await game.createGame({ ...g1.p.toObject() })).wait();
  for (const p of [a, b, c]) await (await game.connect(p).enter(2)).wait();
  console.log("game 2 open with 3 players");
}
main().catch((e) => { console.error(e); process.exit(1); });

// Prints game 1's outcome on the local chain: status, end, and each player's payout (then claims it).
const { ethers } = require("hardhat");
async function main() {
  const signers = await ethers.getSigners();
  const game = await ethers.getContractAt("SqueekChicken", process.env.GAME);
  const sqk = await ethers.getContractAt("MockSQK", await game.sqk());
  const g = await game.getGame(1);
  const names = ["None", "Lobby", "Live", "Ended", "Settled", "Voided", "RolledOver"];
  console.log(`status ${names[Number(g.status)]}, start ${g.startTime}, last move ${g.lastMove} (+${g.lastMove - g.startTime}s)`);
  console.log(`watcher bounty balance: ${ethers.formatEther(await sqk.balanceOf(signers[1].address))} SQK`);
  for (let i = 0; i < 3; i++) {
    const p = signers[2 + i], e = await game.entries(1, p.address), c = await game.claimable(1, p.address);
    const off = e.exitTime ? `got off at +${e.exitTime - g.startTime}s` : "stayed on";
    let line = `player ${i}: ${off}, claimable ${ethers.formatEther(c)} SQK`;
    if (c > 0n) { await (await game.connect(p).claim(1)).wait(); line += " → claimed"; }
    console.log(line);
  }
  console.log(`left in contract: ${ethers.formatEther(await sqk.balanceOf(game.target))} SQK`);
}
main().catch((e) => { console.error(e); process.exit(1); });

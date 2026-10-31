// Player number PLAYER (accounts #2 up) schedules an auto-off AFTER seconds into game GAME_ID's run (default 1),
// through the local watcher on WATCHER_URL (default http://localhost:3311). AFTER=cancel cancels it.
const { ethers } = require("hardhat");
async function main() {
  const p = (await ethers.getSigners())[2 + Number(process.env.PLAYER)];
  const id = Number(process.env.GAME_ID || 1);
  const afterSeconds = process.env.AFTER === "cancel" ? 4294967295 : Number(process.env.AFTER);
  const issuedAt = Math.floor(Date.now() / 1000);
  const domain = { name: "Squeek Out", version: "1", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: process.env.GAME };
  const types = { ScheduledExit: [{ name: "gameId", type: "uint256" }, { name: "player", type: "address" },
    { name: "afterSeconds", type: "uint32" }, { name: "issuedAt", type: "uint64" }] };
  const signature = await p.signTypedData(domain, types, { gameId: id, player: p.address, afterSeconds, issuedAt });
  const res = await fetch(`${process.env.WATCHER_URL || "http://localhost:3311"}/scheduled-exit`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ gameId: id, player: p.address, afterSeconds, issuedAt, signature }) });
  console.log(`player ${process.env.PLAYER}: ${res.status} ${await res.text()}`);
}
main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });

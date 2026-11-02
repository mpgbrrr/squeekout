// Rehearsal on a private copy of Sepolia: the holders game and its treasury against Squeekchain's real staking,
// acting as a holder's wallet (W) with its real Squeeks. Nothing is sent to Sepolia. The free public node keeps
// recent state only, so a run can fail with "historical state is not available": run it again.
// Usage: npx hardhat run scripts/e2e/fork-rehearsal.js
const { ethers, upgrades, network } = require("hardhat");
const W = "0x1C7E5e9EA41bD25F666a0912c0A182ffB12E2013", N = "0xCB98349c134aB983dA5BfD80527dfe2552bDB70F", P = "0x4b67b739dfd832f4eac67a7aa3bc244fb74cea4f";
(async () => {
  await network.provider.request({ method: "hardhat_reset", params: [{ forking: { jsonRpcUrl: "https://ethereum-sepolia-rpc.publicnode.com" } }] });
  const [owner, watcher] = await ethers.getSigners();
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [W] });
  await owner.sendTransaction({ to: W, value: ethers.parseEther("1") });
  const you = await ethers.getSigner(W);
  const nft = new ethers.Contract(N, ["function transferFrom(address,address,uint256)", "function ownerOf(uint256) view returns (address)", "function setApprovalForAll(address,bool)"], you);
  const staking = new ethers.Contract(P, ["function depositor(address,uint256) view returns (address)", "function accountPower(address) view returns (uint256,uint256)",
    "function claimable(address) view returns (uint256)", "function deposit(address,uint256[])", "function withdraw(address,uint256[])", "function claimRecipient(address) view returns (address)"], you);
  const step = async (what, fn) => { try { const r = await fn(); console.log("ok  ", what, r ?? ""); return r; } catch (e) { console.log("FAIL", what, (e.shortMessage || e.message).slice(0, 220)); return null; } };

  const game = await upgrades.deployProxy(await ethers.getContractFactory("SqueekHolders"), [P, watcher.address, owner.address], { kind: "uups" });
  const treasury = await (await ethers.getContractFactory("ChickenTreasury")).deploy(await game.sqk(), P);
  await treasury.setGame(game.target); await game.setTreasury(treasury.target);
  console.log("game collections:", await game.getCollections(), "prize token:", await game.sqk());

  await step("you send #8962 to the owner; treasury stakes it", async () => { await (await nft.transferFrom(W, owner.address, 8962)).wait();
    await (await nft.connect(owner).setApprovalForAll(treasury.target, true)).wait(); await (await treasury.depositNfts(N, [8962])).wait(); return staking.depositor(N, 8962); });
  await network.provider.send("hardhat_mine", ["0x20"]); // let some rewards stream in
  await step("you stake #8961 yourself", async () => { await (await nft.setApprovalForAll(P, true)).wait(); await (await staking.deposit(N, [8961])).wait(); return staking.depositor(N, 8961); });

  const now = (await ethers.provider.getBlock("latest")).timestamp;
  await game.createGame({ earliestStart: now + 600, idleWindow: 180, grace: 12, jackpotBps: 2000, jackpotGroupBps: 1000, bountyFlat: ethers.parseEther("5"), minPlayers: 1, maxPlayers: 500, lateEntryWindow: 120, prizeDelay: 2400 });
  await step("you enter game 1 with your staked #8961", async () => { await (await game.connect(you).enter(1, N, 8961)).wait(); return "entered"; });
  await step("the treasury's staked #8962 can't be used by you", async () => game.connect(you).enter.staticCall(1, N, 8962).then(
    () => { throw new Error("it was allowed"); }, (e) => (/NotHolder/.test(e.message) ? "refused (NotHolder)" : Promise.reject(e))));
  await step("prize so far / treasury claimable", async () => `${ethers.formatEther(await game.prizeSoFar())} / ${ethers.formatEther(await staking.claimable(treasury.target))}`);
  await step("treasury claim path (harvest via the game) doesn't break", async () => { await network.provider.request({ method: "hardhat_impersonateAccount", params: [game.target] });
    await network.provider.send("hardhat_setBalance", [game.target, "0xDE0B6B3A7640000"]);
    const sqk = new ethers.Contract(await game.sqk(), ["function balanceOf(address) view returns (uint256)"], owner);
    await (await treasury.connect(await ethers.getSigner(game.target)).harvest()).wait();
    return `game got ${ethers.formatEther(await sqk.balanceOf(game.target))} SQK, developer half ${ethers.formatEther(await treasury.devBalance())} SQK, still claimable ${ethers.formatEther(await staking.claimable(treasury.target))}`; });
  await step("owner takes #8962 back out of staking", async () => { await (await treasury.withdrawNfts(N, [8962], owner.address)).wait(); return nft.ownerOf(8962); });
  await step("you unstake #8961", async () => { await (await staking.withdraw(N, [8961])).wait(); return nft.ownerOf(8961); });
})().catch((e) => { console.error(e); process.exit(1); });

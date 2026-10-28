// The NFT jackpot bonus: ChickenTreasury holds Squeeks in staking; each game's bonus is half of what they
// earned since the previous bonus, settled 40 minutes after the hamster's last movement and paid to the
// jackpot winners on top of their payout. The other half goes to the developer.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const BUY = ethers.parseEther("100");
const DELAY = 40 * 60;
const Status = { Settled: 4n, Voided: 5n, RolledOver: 6n };
const at = async (t, fn) => { await time.setNextBlockTimestamp(t); return fn(); };

async function deploy() {
  const [owner, watcher, keeper, funder, a, b, c, d, stranger] = await ethers.getSigners();
  const sqk = await (await ethers.getContractFactory("MockSQK")).deploy();
  const nft = await (await ethers.getContractFactory("MockNFT")).deploy();
  const staking = await (await ethers.getContractFactory("MockStaking")).deploy(sqk.target);
  const game = await (await ethers.getContractFactory("SqueekChicken")).deploy(sqk.target, watcher.address);
  const treasury = await (await ethers.getContractFactory("ChickenTreasury")).deploy(sqk.target, staking.target);
  await treasury.setGame(game.target);
  await game.setTreasury(treasury.target, DELAY);
  // The developer's two Squeeks go into the treasury and on into staking.
  for (const id of [1, 2]) await nft.mint(owner.address, id);
  await nft.setApprovalForAll(treasury.target, true);
  await treasury.depositNfts(nft.target, [1, 2]);
  for (const p of [a, b, c, d]) {
    await sqk.mint(p.address, BUY * 10n);
    await sqk.connect(p).approve(game.target, ethers.MaxUint256);
  }
  await sqk.mint(funder.address, ethers.parseEther("1000000"));
  await sqk.connect(funder).approve(staking.target, ethers.MaxUint256);
  // Rewards arriving from Squeekchain, as staking would credit them.
  const earn = (amount) => staking.connect(funder).accrue(treasury.target, ethers.parseEther(String(amount)));
  return { owner, watcher, keeper, stranger, players: [a, b, c, d], sqk, nft, staking, game, treasury, earn };
}

/** A 4-player game: a gets off at +1 min, b at +2, c at +3 (the jackpot winner), d is caught. */
async function playGame(f, { allCaught = false } = {}) {
  const { game, watcher, keeper, players } = f;
  const now = await time.latest();
  await game.createGame({ buyIn: BUY, earliestStart: now + 60, idleWindow: 180, grace: 12, curveStep: 120,
    jackpotBps: 2000, jackpotGroupBps: 1000, bountyFlat: 0, minPlayers: 2, maxPlayers: 200 });
  const id = await game.gameCount();
  for (const p of players) await game.connect(p).enter(id);
  const start = now + 120;
  await at(start + 2, () => game.connect(watcher).postStart(id, start));
  if (!allCaught) for (let i = 0; i < 3; i++) await at(start + 60 * (i + 1), () => game.connect(players[i]).exit(id));
  const lastMove = start + 300;
  await at(lastMove + 180, () => game.connect(watcher).postEnd(id, lastMove, 1));
  await game.connect(keeper).finalize(id);
  return { id, lastMove };
}

describe("NFT jackpot bonus", () => {
  it("splits the run's rewards 50/50 and pays the game's half to the jackpot winner, after the delay", async () => {
    const f = await loadFixture(deploy);
    const { game, treasury, sqk, players, keeper, earn } = f;
    const [a, , c] = players;
    await earn(300); // rewards from his run while the game is live...
    const { id, lastMove } = await playGame(f);
    await earn(100); // ...and the tail that arrives after it ended
    expect(await treasury.pendingToGame()).to.equal(ethers.parseEther("200"));

    const main = await game.claimable(id, c.address);
    const aBefore = await game.claimable(id, a.address);
    await expect(game.settleBonus(id)).to.be.revertedWithCustomError(game, "BadTime"); // too early
    await at(lastMove + DELAY, () => game.connect(keeper).settleBonus(id));
    const bonus = await game.bonuses(id);
    expect(bonus.each).to.equal(ethers.parseEther("200")); // one jackpot winner gets the whole half
    expect(await treasury.devBalance()).to.equal(ethers.parseEther("200"));
    expect(await game.claimable(id, c.address)).to.equal(main + ethers.parseEther("200"));
    expect(await game.claimable(id, a.address)).to.equal(aBefore); // no bonus for winners outside the jackpot
    const before = await sqk.balanceOf(c.address);
    await game.connect(c).claim(id);
    expect((await sqk.balanceOf(c.address)) - before).to.equal(main + ethers.parseEther("200"));
    await expect(game.connect(c).claim(id)).to.be.revertedWithCustomError(game, "NothingToClaim");
  });

  it("lets a winner claim the payout first and the bonus later, without paying anything twice", async () => {
    const f = await loadFixture(deploy);
    const { game, sqk, players, earn } = f;
    const c = players[2];
    const { id, lastMove } = await playGame(f);
    await earn(50);
    const main = await game.claimable(id, c.address);
    await game.connect(c).claim(id);
    expect(await game.claimable(id, c.address)).to.equal(0n);
    await at(lastMove + DELAY, () => game.settleBonus(id));
    expect(await game.claimable(id, c.address)).to.equal(ethers.parseEther("25"));
    const before = await sqk.balanceOf(c.address);
    await game.connect(c).claim(id);
    expect((await sqk.balanceOf(c.address)) - before).to.equal(ethers.parseEther("25"));
    await expect(game.connect(c).claim(id)).to.be.revertedWithCustomError(game, "NothingToClaim");
    expect(main).to.be.gt(0n);
  });

  it("rolls the bonus over when everyone was caught", async () => {
    const f = await loadFixture(deploy);
    const { game, earn } = f;
    await earn(80);
    const { id, lastMove } = await playGame(f, { allCaught: true });
    expect((await game.getGame(id)).status).to.equal(Status.RolledOver);
    const pool = await game.rolloverPool();
    await at(lastMove + DELAY, () => game.settleBonus(id));
    expect(await game.rolloverPool()).to.equal(pool + ethers.parseEther("40"));
  });

  it("settles in game order, once each, and carries rewards from voided games to the next bonus", async () => {
    const f = await loadFixture(deploy);
    const { game, watcher, earn } = f;
    const g1 = await playGame(f);
    // Game 2 opens and is voided; its rewards wait in the treasury.
    const now = await time.latest();
    await game.createGame({ buyIn: BUY, earliestStart: now + 60, idleWindow: 180, grace: 12, curveStep: 120,
      jackpotBps: 2000, jackpotGroupBps: 1000, bountyFlat: 0, minPlayers: 2, maxPlayers: 200 });
    await at(now + 61, () => game.connect(watcher).postStart(2, now + 60)); // no players: voided
    expect((await game.getGame(2)).status).to.equal(Status.Voided);
    await expect(game.settleBonus(2)).to.be.revertedWithCustomError(game, "WrongStatus");
    await earn(60);
    const g3 = await playGame(f);
    await earn(40);
    await at(Math.max(g3.lastMove, g1.lastMove) + DELAY, () => game.settleBonus(3));
    expect((await game.bonuses(3)).each).to.equal(ethers.parseEther("50")); // everything since the start: (60 + 40) / 2
    await expect(game.settleBonus(1)).to.be.revertedWithCustomError(game, "BonusAlreadySettled"); // out of order
    await expect(game.settleBonus(3)).to.be.revertedWithCustomError(game, "BonusAlreadySettled");
  });

  it("works with no rewards and with no treasury", async () => {
    const f = await loadFixture(deploy);
    const { game, players } = f;
    const { id, lastMove } = await playGame(f);
    const main = await game.claimable(id, players[2].address);
    await at(lastMove + DELAY, () => game.settleBonus(id));
    expect((await game.bonuses(id)).each).to.equal(0n);
    expect(await game.claimable(id, players[2].address)).to.equal(main);
    await game.setTreasury(ethers.ZeroAddress, DELAY);
    const g2 = await playGame(f);
    await at(g2.lastMove + DELAY, () => game.settleBonus(g2.id));
    expect((await game.bonuses(g2.id)).settled).to.equal(true);
  });

  it("keeps the treasury's powers with the right people", async () => {
    const f = await loadFixture(deploy);
    const { owner, stranger, treasury, staking, nft, sqk, earn } = f;
    await expect(treasury.connect(stranger).harvest()).to.be.revertedWithCustomError(treasury, "NotGame");
    await expect(staking.connect(stranger).claim(treasury.target)).to.be.revertedWithCustomError(staking, "Unauthorized");
    await expect(treasury.connect(stranger).withdrawNfts(nft.target, [1], stranger.address)).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
    await expect(treasury.connect(stranger).withdrawDev(stranger.address, 1)).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
    // The developer can take the NFTs back at any time.
    await treasury.withdrawNfts(nft.target, [1, 2], owner.address);
    expect(await nft.ownerOf(1)).to.equal(owner.address);
    // ...and withdraw their half, but no more.
    await earn(10);
    const { id, lastMove } = await playGame(f);
    await at(lastMove + DELAY, () => f.game.settleBonus(id));
    const dev = await treasury.devBalance();
    expect(dev).to.equal(ethers.parseEther("5"));
    await expect(treasury.withdrawDev(owner.address, dev + 1n)).to.be.revertedWithCustomError(treasury, "TooMuch");
    const before = await sqk.balanceOf(owner.address);
    await treasury.withdrawDev(owner.address, dev);
    expect((await sqk.balanceOf(owner.address)) - before).to.equal(dev);
  });
});

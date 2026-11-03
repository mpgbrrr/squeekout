const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const Status = { Lobby: 1n, Live: 2n, Ended: 3n, Settled: 4n, Voided: 5n, RolledOver: 6n };
const PRIZE_DELAY = 2400;
const SQK = (n) => ethers.parseEther(String(n));

// The holders game with stand-ins for SQK, the Squeek collection and Squeekchain's staking. The treasury
// stakes Squeeks #100-#102 for the game; players #1-#8 each hold Squeek #(i+1) in their wallet.
async function deploy() {
  const [owner, watcher, keeper, ...rest] = await ethers.getSigners();
  const players = rest.slice(0, 8);
  const sqk = await (await ethers.getContractFactory("MockSQK")).deploy();
  const nft = await (await ethers.getContractFactory("MockNFT")).deploy();
  const staking = await (await ethers.getContractFactory("MockStaking")).deploy(sqk.target, nft.target);
  const game = await upgrades.deployProxy(await ethers.getContractFactory("SqueekHolders"),
    [staking.target, watcher.address, owner.address], { kind: "uups" });
  const treasury = await (await ethers.getContractFactory("ChickenTreasury")).deploy(sqk.target, staking.target);
  await treasury.setGame(game.target);
  await game.setTreasury(treasury.target);
  for (const id of [100, 101, 102]) await nft.mint(owner.address, id);
  await nft.setApprovalForAll(treasury.target, true);
  await treasury.depositNfts(nft.target, [100, 101, 102]);
  for (let i = 0; i < players.length; i++) await nft.mint(players[i].address, i + 1);
  await sqk.mint(owner.address, SQK(1_000_000));
  await sqk.approve(staking.target, ethers.MaxUint256);
  return { owner, watcher, keeper, players, sqk, nft, staking, game, treasury };
}

async function createGame(game, over = {}) {
  const now = await time.latest();
  const p = { earliestStart: now + 3600, idleWindow: 180, grace: 12, jackpotBps: 2000, jackpotGroupBps: 1000,
    bountyFlat: SQK(5), minPlayers: 3, maxPlayers: 200, lateEntryWindow: 120, prizeDelay: PRIZE_DELAY, ...over };
  await game.createGame(p);
  return { id: await game.gameCount(), p };
}

async function at(t, fn) {
  await time.setNextBlockTimestamp(t);
  return fn();
}

const enter = (game, nft, player, tokenId, id) => game.connect(player).enter(id, nft.target, tokenId);

/** Three players in; the first gets off at +60 s, the second at +90 s, the third is caught; the treasury's
 * Squeeks earn `earned` SQK during the run. Returns once the end is posted. */
async function playedGame(f, earned = 1000) {
  const { game, watcher, players, nft, staking, treasury } = f;
  const { id, p } = await createGame(game);
  for (let i = 0; i < 3; i++) await enter(game, nft, players[i], i + 1, id);
  const start = p.earliestStart + 10;
  await at(start + 2, () => game.connect(watcher).postStart(id, start));
  await at(start + 60, () => game.connect(players[0]).exit(id));
  await at(start + 90, () => game.connect(players[1]).exit(id));
  if (earned) await staking.accrue(treasury.target, SQK(earned));
  const lastMove = start + 100;
  await at(lastMove + 180, () => game.connect(watcher).postEnd(id, lastMove, 1));
  return { id, start, lastMove };
}

describe("SqueekHolders", () => {
  describe("entry", () => {
    it("lets Squeek holders in for free, from their wallet or their stake, and nobody else", async () => {
      const { game, nft, staking, players, sqk } = await loadFixture(deploy);
      const { id } = await createGame(game);
      const [a, b, c] = players;
      const before = await sqk.balanceOf(a.address);
      await enter(game, nft, a, 1, id);
      expect(await sqk.balanceOf(a.address)).to.equal(before); // nothing paid
      await nft.connect(b).setApprovalForAll(staking.target, true);
      await staking.connect(b).deposit(nft.target, [2]); // b's Squeek is staked
      await enter(game, nft, b, 2, id);
      await expect(enter(game, nft, c, 1, id)).to.be.revertedWithCustomError(game, "NotHolder"); // a's Squeek
      await expect(enter(game, nft, c, 100, id)).to.be.revertedWithCustomError(game, "NotHolder"); // the treasury's
      const other = await (await ethers.getContractFactory("MockNFT")).deploy();
      await other.mint(c.address, 1);
      await expect(game.connect(c).enter(id, other.target, 1)).to.be.revertedWithCustomError(game, "NotOfficial");
      expect((await game.getGame(id)).entrants).to.equal(2n);
    });

    it("gives one entry per wallet, however many Squeeks it holds", async () => {
      const { game, nft, players } = await loadFixture(deploy);
      const { id } = await createGame(game);
      await nft.mint(players[0].address, 50);
      await enter(game, nft, players[0], 1, id);
      await expect(enter(game, nft, players[0], 50, id)).to.be.revertedWithCustomError(game, "AlreadyEntered");
    });

    it("lets each Squeek enter only one wallet per game, until its wallet leaves the lobby", async () => {
      const { game, nft, players } = await loadFixture(deploy);
      const { id } = await createGame(game);
      const [a, b] = players;
      await enter(game, nft, a, 1, id);
      await nft.connect(a).transferFrom(a.address, b.address, 1);
      await expect(enter(game, nft, b, 1, id)).to.be.revertedWithCustomError(game, "SqueekAlreadyUsed");
      await game.connect(a).leaveLobby(id);
      await enter(game, nft, b, 1, id);
      const next = await createGame(game, { earliestStart: (await time.latest()) + 7200 });
      await expect(enter(game, nft, a, 1, next.id)).to.be.revertedWithCustomError(game, "NotHolder"); // b holds it now
    });
  });

  describe("prize", () => {
    it("pays out half of what the game's Squeeks earned from the run, after the rewards have had time to arrive", async () => {
      const f = await loadFixture(deploy);
      const { game, treasury, keeper, players, sqk } = f;
      const { id, lastMove } = await playedGame(f, 1000);
      expect(await game.prizeSoFar()).to.equal(SQK(500));
      await time.setNextBlockTimestamp(lastMove + PRIZE_DELAY - 1);
      await expect(game.connect(keeper).finalize(id)).to.be.revertedWithCustomError(game, "BadTime");
      await at(lastMove + PRIZE_DELAY, () => game.connect(keeper).finalize(id));
      const g = await game.getGame(id);
      expect(g.status).to.equal(Status.Settled);
      expect(g.prize).to.equal(SQK(500));
      expect(await treasury.devBalance()).to.equal(SQK(500)); // the developer's half
      expect(await sqk.balanceOf(keeper.address)).to.equal(SQK(5)); // the bounty, 1% of 500
      // 495 left: jackpot 99 to the last winner; 396 split 60 : 90 by time on the wheel.
      const a = await game.claimable(id, players[0].address), b = await game.claimable(id, players[1].address);
      expect(a).to.be.closeTo(SQK(396) * 60n / 150n, 2n);
      expect(b).to.be.closeTo(SQK(396) * 90n / 150n + SQK(99), 2n);
      expect(await game.claimable(id, players[2].address)).to.equal(0n); // caught
      await game.connect(players[1]).claimAll([id]);
      expect(await sqk.balanceOf(players[1].address)).to.equal(b);
    });

    it("rolls the prize into the next game when everyone is caught, and games finalize in order", async () => {
      const f = await loadFixture(deploy);
      const { game, watcher, keeper, players, nft, staking, treasury } = f;
      // Game 1: everyone caught.
      const { id: g1, p } = await createGame(game);
      for (let i = 0; i < 3; i++) await enter(game, nft, players[i], i + 1, g1);
      const s1 = p.earliestStart;
      await at(s1 + 1, () => game.connect(watcher).postStart(g1, s1));
      await staking.accrue(treasury.target, SQK(200));
      await at(s1 + 400, () => game.connect(watcher).postEnd(g1, s1 + 100, 1));
      // Game 2 opens and ends before game 1's prize is due: it has to wait its turn.
      const { id: g2, p: p2 } = await createGame(game, { earliestStart: s1 + 500 });
      for (let i = 3; i < 6; i++) await enter(game, nft, players[i], i + 1, g2);
      const s2 = p2.earliestStart;
      await at(s2 + 1, () => game.connect(watcher).postStart(g2, s2));
      await at(s2 + 30, () => game.connect(players[3]).exit(g2));
      await staking.accrue(treasury.target, SQK(100));
      await at(s2 + 400, () => game.connect(watcher).postEnd(g2, s2 + 100, 1));
      await time.increaseTo(s2 + 100 + PRIZE_DELAY);
      await expect(game.connect(keeper).finalize(g2)).to.be.revertedWithCustomError(game, "EarlierGameFirst");
      await game.connect(keeper).finalize(g1); // takes 150 (half of 300 earned so far), bounty 1.5, all caught
      expect((await game.getGame(g1)).status).to.equal(Status.RolledOver);
      expect(await game.carried()).to.equal(SQK(148.5));
      await game.connect(keeper).finalize(g2); // the carried 148.5, nothing new, bounty 1.485; one winner
      expect(await game.claimable(g2, players[3].address)).to.be.closeTo(SQK(148.5) - SQK(1.485), 2n);
    });

    it("skips voided games when finalizing in order, and their run's rewards go to the next game", async () => {
      const f = await loadFixture(deploy);
      const { game, watcher, keeper, players, nft, staking, treasury } = f;
      const { id: g1 } = await createGame(game);
      await enter(game, nft, players[0], 1, g1);
      await staking.accrue(treasury.target, SQK(100));
      await game.connect(watcher).voidGame(g1, "feed outage");
      const { id: g2, lastMove } = await playedGame(f, 100);
      await at(lastMove + PRIZE_DELAY, () => game.connect(keeper).finalize(g2));
      expect((await game.getGame(g2)).prize).to.equal(SQK(100)); // half of 100 + 100
      expect(await game.claimable(g1, players[0].address)).to.equal(0n); // a void pays nothing: nothing was paid in
    });
  });

  describe("treasury split", () => {
    it("lets only the treasury's owner change the prize share, from the next payout", async () => {
      const f = await loadFixture(deploy);
      const { game, treasury, keeper, players } = f;
      await expect(treasury.connect(players[0]).setGameShare(7000)).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
      await expect(treasury.setGameShare(10_001)).to.be.revertedWithCustomError(treasury, "TooMuch");
      await treasury.setGameShare(7000); // 70% to prizes, 30% to the developer
      const { id, lastMove } = await playedGame(f, 1000);
      expect(await game.prizeSoFar()).to.equal(SQK(700));
      await at(lastMove + PRIZE_DELAY, () => game.connect(keeper).finalize(id));
      expect((await game.getGame(id)).prize).to.equal(SQK(700));
      expect(await treasury.devBalance()).to.equal(SQK(300));
    });
  });

  describe("collections and upgrades", () => {
    it("adds only collections Squeekchain's staking recognizes, without an upgrade", async () => {
      const { game, staking, players } = await loadFixture(deploy);
      const clones = await (await ethers.getContractFactory("MockNFT")).deploy();
      await expect(game.setCollection(clones.target, true)).to.be.revertedWithCustomError(game, "NotOfficial");
      await staking.setClones(clones.target); // the clones collection launches
      await expect(game.connect(players[0]).setCollection(clones.target, true)).to.be.revertedWithCustomError(game, "OwnableUnauthorizedAccount");
      await game.setCollection(clones.target, true);
      expect(await game.getCollections()).to.have.length(2);
      await clones.mint(players[0].address, 7);
      const { id } = await createGame(game);
      await game.connect(players[0]).enter(id, clones.target, 7);
    });

    it("refuses upgrades while a game is live", async () => {
      const f = await loadFixture(deploy);
      const { game, watcher, players, nft } = f;
      const { id, p } = await createGame(game);
      for (let i = 0; i < 3; i++) await enter(game, nft, players[i], i + 1, id);
      await at(p.earliestStart + 1, () => game.connect(watcher).postStart(id, p.earliestStart));
      const next = await (await ethers.getContractFactory("SqueekHolders")).deploy();
      await expect(game.upgradeToAndCall(next.target, "0x")).to.be.revertedWithCustomError(game, "GameInProgress");
    });
  });
});

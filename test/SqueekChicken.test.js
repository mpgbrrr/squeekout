const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const BUY = ethers.parseEther("1000");
const BOUNTY = ethers.parseEther("50");
const Status = { Lobby: 1n, Live: 2n, Ended: 3n, Settled: 4n, Voided: 5n, RolledOver: 6n };

async function deploy() {
  const [owner, watcher, keeper, ...rest] = await ethers.getSigners();
  const players = rest.slice(0, 12);
  const sqk = await (await ethers.getContractFactory("MockSQK")).deploy();
  const game = await (await ethers.getContractFactory("SqueekChicken")).deploy(sqk.target, watcher.address);
  for (const p of players) {
    await sqk.mint(p.address, BUY * 10n);
    await sqk.connect(p).approve(game.target, ethers.MaxUint256);
  }
  return { owner, watcher, keeper, players, sqk, game };
}

async function createGame(game, over = {}) {
  const now = await time.latest();
  const p = {
    buyIn: BUY, earliestStart: now + 3600, idleWindow: 180, grace: 12,
    jackpotBps: 2000, jackpotGroupBps: 1000, bountyFlat: BOUNTY, minPlayers: 3, maxPlayers: 200, ...over,
  };
  await game.createGame(p);
  return { id: await game.gameCount(), p };
}

// Sends the next transaction at exactly time t.
async function at(t, txPromiseFn) {
  await time.setNextBlockTimestamp(t);
  return txPromiseFn();
}

/** Runs a 10-player game: 7 exits through the game, one exactly at the grace edge, one just past it, two never exit. */
async function playedGame() {
  const f = await deploy();
  const { game, watcher, players } = f;
  const { id, p } = await createGame(game);
  const ten = players.slice(0, 10);
  for (const pl of ten) await game.connect(pl).enter(id);
  const start = p.earliestStart + 60;
  await at(start + 5, () => game.connect(watcher).postStart(id, start));
  const lastMove = start + 7 * 60 + 5;
  const exitTimes = [1, 2, 3, 4, 5, 6].map((m) => start + m * 60);
  for (let i = 0; i < 6; i++) await at(exitTimes[i], () => game.connect(ten[i]).exit(id));
  await at(lastMove + 12, () => game.connect(ten[6]).exit(id)); // last moment that still wins
  await at(lastMove + 13, () => game.connect(ten[7]).exit(id)); // one second too late
  await at(lastMove + 180, () => game.connect(watcher).postEnd(id, lastMove, 4242));
  return { ...f, id, p, ten, start, lastMove };
}

describe("SqueekChicken", () => {
  describe("a normal game", () => {
    it("pays winners by time survived, gives the jackpot to the last 10%, and pays the bounty", async () => {
      const { game, sqk, keeper, ten, id } = await loadFixture(playedGame);
      await expect(game.connect(keeper).finalize(id)).to.emit(game, "Settled");
      expect(await sqk.balanceOf(keeper.address)).to.equal(BOUNTY); // 50 is below 1% of 10,000

      const pot = BUY * 10n - BOUNTY;
      const g = await game.getGame(id);
      expect(g.status).to.equal(Status.Settled);
      expect(g.jackpotEach).to.equal((pot * 2000n) / 10000n); // 7 winners → group of 1

      const paid = [];
      for (let i = 0; i < 7; i++) paid.push(await game.claimable(id, ten[i].address));
      for (let i = 1; i < 7; i++) expect(paid[i]).to.be.gt(paid[i - 1]); // later exits earn more
      for (let i = 7; i < 10; i++) expect(await game.claimable(id, ten[i].address)).to.equal(0n); // caught

      let total = 0n;
      for (let i = 0; i < 7; i++) {
        await game.connect(ten[i]).claim(id);
        total += paid[i];
      }
      expect(pot - total).to.be.lt(10n); // only rounding dust stays behind
      await expect(game.connect(ten[0]).claim(id)).to.be.revertedWithCustomError(game, "NothingToClaim");
      await expect(game.connect(ten[8]).claim(id)).to.be.revertedWithCustomError(game, "NothingToClaim");
    });

    it("weights each exit by the seconds on the wheel (at least 1)", async () => {
      const { game, id, start } = await loadFixture(playedGame);
      expect(await game.weightAt(id, start)).to.equal(1n);
      expect(await game.weightAt(id, start + 60)).to.equal(60n);
      expect(await game.weightAt(id, start + 120)).to.equal(120n);
      expect(await game.weightAt(id, start + 3600)).to.equal(3600n);
    });

    it("pays twice the curve share for twice the time on the wheel", async () => {
      // Winners at +1 to +6 min, then one at the grace edge; the jackpot goes only to the last.
      const { game, ten, id } = await loadFixture(playedGame);
      await game.finalize(id);
      const at1 = await game.claimable(id, ten[0].address), at2 = await game.claimable(id, ten[1].address);
      const at4 = await game.claimable(id, ten[3].address);
      expect(at2).to.be.closeTo(at1 * 2n, 1n); // integer division can differ by 1 base unit
      expect(at4).to.be.closeTo(at2 * 2n, 1n);
    });

    it("pays exactly what the page's payout maths (shared/payouts.js) predicts", async () => {
      // 3 players at 100; exits at +33 s and +83 s; last movement at +90 s; 3 bounty (1% cap). Net 297:
      // jackpot 59.4 to the last winner, curve pool 237.6 split 33 : 83.
      const f = await deploy();
      const { game, watcher, players } = f;
      const { id, p } = await createGame(game, { buyIn: ethers.parseEther("100"), bountyFlat: ethers.parseEther("5"), minPlayers: 2 });
      for (const pl of players.slice(0, 3)) await game.connect(pl).enter(id);
      const start = p.earliestStart + 10;
      await at(start + 1, () => game.connect(watcher).postStart(id, start));
      await at(start + 33, () => game.connect(players[0]).exit(id));
      await at(start + 83, () => game.connect(players[1]).exit(id));
      await at(start + 90 + 180, () => game.connect(watcher).postEnd(id, start + 90, 1));
      await game.finalize(id);
      const a = await game.claimable(id, players[0].address), b = await game.claimable(id, players[1].address);
      expect(a).to.be.closeTo(ethers.parseEther("237.6") * 33n / 116n, 2n);
      expect(b).to.be.closeTo(ethers.parseEther("237.6") * 83n / 116n + ethers.parseEther("59.4"), 2n);
    });

    it("caps the bounty at 1% of the pot", async () => {
      const f = await deploy();
      const { game, watcher, keeper, players, sqk } = f;
      const { id, p } = await createGame(game, { bountyFlat: ethers.parseEther("500") });
      for (const pl of players.slice(0, 3)) await game.connect(pl).enter(id);
      const start = p.earliestStart;
      await at(start + 1, () => game.connect(watcher).postStart(id, start));
      await at(start + 30, () => game.connect(players[0]).exit(id));
      await at(start + 400, () => game.connect(watcher).postEnd(id, start + 100, 1));
      await game.connect(keeper).finalize(id);
      expect(await sqk.balanceOf(keeper.address)).to.equal((BUY * 3n) / 100n);
    });
  });

  describe("lobby and start", () => {
    it("refunds players who leave the lobby", async () => {
      const { game, sqk, players } = await loadFixture(deploy);
      const { id } = await createGame(game);
      await game.connect(players[0]).enter(id);
      const before = await sqk.balanceOf(players[0].address);
      await game.connect(players[0]).leaveLobby(id);
      expect(await sqk.balanceOf(players[0].address)).to.equal(before + BUY);
      expect((await game.getGame(id)).entrants).to.equal(0n);
    });

    it("refunds exits made before the hamster started", async () => {
      const { game, watcher, players, sqk } = await loadFixture(deploy);
      const { id, p } = await createGame(game);
      for (const pl of players.slice(0, 4)) await game.connect(pl).enter(id);
      await at(p.earliestStart + 10, () => game.connect(players[0]).exit(id));
      const start = p.earliestStart + 100;
      await at(start + 1, () => game.connect(watcher).postStart(id, start));
      const before = await sqk.balanceOf(players[0].address);
      await game.connect(players[0]).claim(id);
      expect(await sqk.balanceOf(players[0].address)).to.equal(before + BUY);
    });

    it("voids the game when fewer than the minimum are in at the start", async () => {
      const { game, watcher, players } = await loadFixture(deploy);
      const { id, p } = await createGame(game);
      for (const pl of players.slice(0, 2)) await game.connect(pl).enter(id);
      await at(p.earliestStart + 1, () => game.connect(watcher).postStart(id, p.earliestStart));
      expect((await game.getGame(id)).status).to.equal(Status.Voided);
      expect(await game.claimable(id, players[0].address)).to.equal(BUY);
    });

    it("lets a player approve and enter in one transaction with a permit", async () => {
      const { game, sqk, players } = await loadFixture(deploy);
      const { id } = await createGame(game);
      const pl = players[11];
      await sqk.connect(pl).approve(game.target, 0);
      const deadline = (await time.latest()) + 600;
      const domain = { name: "Squeek", version: "1", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: sqk.target };
      const types = { Permit: [
        { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] };
      const sig = ethers.Signature.from(await pl.signTypedData(domain, types,
        { owner: pl.address, spender: game.target, value: BUY, nonce: await sqk.nonces(pl.address), deadline }));
      await game.connect(pl).enterWithPermit(id, deadline, sig.v, sig.r, sig.s);
      expect((await game.entries(id, pl.address)).entered).to.equal(true);
    });
  });

  describe("outages, rollover and backstop", () => {
    it("refunds everyone when the watcher voids the game for an outage", async () => {
      const { game, watcher, players } = await loadFixture(deploy);
      const { id, p } = await createGame(game);
      for (const pl of players.slice(0, 3)) await game.connect(pl).enter(id);
      await at(p.earliestStart + 1, () => game.connect(watcher).postStart(id, p.earliestStart));
      await game.connect(players[0]).exit(id);
      await game.connect(watcher).voidGame(id, "feed outage, hamster ran during the gap");
      for (const pl of players.slice(0, 3)) expect(await game.claimable(id, pl.address)).to.equal(BUY);
    });

    it("rolls the pot into the next game when everyone is caught", async () => {
      const { game, watcher, keeper, players } = await loadFixture(deploy);
      const first = await createGame(game);
      for (const pl of players.slice(0, 3)) await game.connect(pl).enter(first.id);
      const s1 = first.p.earliestStart;
      await at(s1 + 1, () => game.connect(watcher).postStart(first.id, s1));
      await at(s1 + 400, () => game.connect(watcher).postEnd(first.id, s1 + 100, 1));
      await game.connect(keeper).finalize(first.id);
      const rolled = BUY * 3n - (BUY * 3n) / 100n; // the bounty is capped at 1% of a 3,000 SQK pot
      expect(await game.rolloverPool()).to.equal(rolled);

      const second = await createGame(game);
      expect((await game.getGame(second.id)).rolloverIn).to.equal(rolled);
      expect(await game.rolloverPool()).to.equal(0n);
      for (const pl of players.slice(3, 6)) await game.connect(pl).enter(second.id);
      const s2 = second.p.earliestStart;
      await at(s2 + 1, () => game.connect(watcher).postStart(second.id, s2));
      await at(s2 + 50, () => game.connect(players[3]).exit(second.id));
      await at(s2 + 400, () => game.connect(watcher).postEnd(second.id, s2 + 100, 1));
      await game.connect(keeper).finalize(second.id);
      const pot = BUY * 3n + rolled;
      expect(await game.claimable(second.id, players[3].address)).to.be.closeTo(pot - BOUNTY, 10n); // the only winner
    });

    it("lets anyone refund a game stuck for 7 days", async () => {
      const { game, players, keeper } = await loadFixture(deploy);
      const { id, p } = await createGame(game);
      for (const pl of players.slice(0, 3)) await game.connect(pl).enter(id);
      await expect(game.connect(keeper).backstop(id)).to.be.revertedWithCustomError(game, "BadTime");
      await time.increaseTo(p.earliestStart + 7 * 24 * 3600);
      await game.connect(keeper).backstop(id);
      expect(await game.claimable(id, players[1].address)).to.equal(BUY);
    });
  });

  describe("permissions and timing", () => {
    it("only lets the watcher post start, end and voids", async () => {
      const { game, players } = await loadFixture(deploy);
      const { id, p } = await createGame(game);
      await time.increaseTo(p.earliestStart + 1);
      await expect(game.connect(players[0]).postStart(id, p.earliestStart)).to.be.revertedWithCustomError(game, "NotWatcher");
      await expect(game.connect(players[0]).voidGame(id, "x")).to.be.revertedWithCustomError(game, "NotWatcher");
    });

    it("refuses an end before the wheel has been still for the idle window", async () => {
      const { game, watcher, players } = await loadFixture(deploy);
      const { id, p } = await createGame(game);
      for (const pl of players.slice(0, 3)) await game.connect(pl).enter(id);
      const start = p.earliestStart;
      await at(start + 1, () => game.connect(watcher).postStart(id, start));
      await at(start + 279, () => expect(game.connect(watcher).postEnd(id, start + 100, 1)).to.be.revertedWithCustomError(game, "BadTime"));
    });

    it("refuses exits after the end is posted", async () => {
      const { game, ten, id } = await loadFixture(playedGame);
      await expect(game.connect(ten[9]).exit(id)).to.be.revertedWithCustomError(game, "WrongStatus");
    });
  });

  describe("settled-round check", () => {
    async function checkedGame(counter) {
      const f = await playedGameWithCounter(counter);
      const genesis = f.p.earliestStart - 6000; // 10 rounds before the lobby closed
      const core = await (await ethers.getContractFactory("MockSqueekCore")).deploy(genesis);
      await f.game.setRoundCheck(core.target, true);
      const r = BigInt(Math.floor((f.lastMove - genesis) / 600) + 1);
      return { ...f, core, r };
    }
    async function playedGameWithCounter(counter) {
      const f = await deploy();
      const { game, watcher, players } = f;
      const { id, p } = await createGame(game);
      for (const pl of players.slice(0, 3)) await game.connect(pl).enter(id);
      const start = p.earliestStart;
      await at(start + 1, () => game.connect(watcher).postStart(id, start));
      await at(start + 50, () => game.connect(players[0]).exit(id));
      const lastMove = start + 100;
      await at(lastMove + 180, () => game.connect(watcher).postEnd(id, lastMove, counter));
      return { ...f, id, p, lastMove };
    }

    it("waits until the round of the last movement has settled", async () => {
      const { game, keeper, core, id, r } = await checkedGame(500);
      await core.setSettled(r - 1n);
      await expect(game.connect(keeper).finalize(id)).to.be.revertedWithCustomError(game, "RoundCheckPending");
    });

    it("settles when the counter fits the settled totals", async () => {
      const { game, keeper, core, id, r } = await checkedGame(500);
      await core.setSettled(r);
      await core.setWorkAfter(r - 1n, 400);
      await core.setWorkAfter(r, 600);
      await game.connect(keeper).finalize(id);
      expect((await game.getGame(id)).status).to.equal(Status.Settled);
    });

    it("voids the game when settled totals contradict the watcher", async () => {
      const { game, keeper, core, id, r } = await checkedGame(900);
      await core.setSettled(r);
      await core.setWorkAfter(r - 1n, 400);
      await core.setWorkAfter(r, 600);
      await game.connect(keeper).finalize(id);
      expect((await game.getGame(id)).status).to.equal(Status.Voided);
    });
  });

  describe("lobby open until the hamster runs", () => {
    it("accepts entries after the minimum lobby time, until the start is posted", async () => {
      const { game, watcher, players } = await loadFixture(deploy);
      const { id, p } = await createGame(game);
      for (const pl of players.slice(0, 2)) await game.connect(pl).enter(id);
      await at(p.earliestStart + 600, () => game.connect(players[2]).enter(id)); // 10 minutes after the minimum
      await at(p.earliestStart + 700, () => game.connect(watcher).postStart(id, p.earliestStart + 690));
      await expect(game.connect(players[3]).enter(id)).to.be.revertedWithCustomError(game, "WrongStatus");
      expect((await game.getGame(id)).status).to.equal(Status.Live);
    });

    it("refunds an entry that landed after his first movement and keeps it out of the pot and winners", async () => {
      const { game, watcher, keeper, players, sqk } = await loadFixture(deploy);
      const { id, p } = await createGame(game);
      const [a, b, c, late] = players;
      for (const pl of [a, b, c]) await game.connect(pl).enter(id);
      const start = p.earliestStart + 100; // his first movement
      await at(start + 4, () => game.connect(late).enter(id)); // saw him run and jumped in
      await at(start + 6, () => game.connect(late).exit(id)); // and out again before the watcher posted
      await at(start + 15, () => game.connect(watcher).postStart(id, start));
      await expect(game.connect(late).exit(id)).to.be.revertedWithCustomError(game, "AlreadyExited");
      expect(await game.claimable(id, late.address)).to.equal(BUY);
      await at(start + 60, () => game.connect(a).exit(id));
      await at(start + 400, () => game.connect(watcher).postEnd(id, start + 100, 1));
      await game.connect(keeper).finalize(id);
      const pot = BUY * 3n - (BUY * 3n) / 100n; // the late entry isn't in the pot; bounty capped at 1% of 3,000
      expect(await game.claimable(id, a.address)).to.be.closeTo(pot, 10n); // a is the only winner
      expect(await game.claimable(id, late.address)).to.equal(BUY); // refunded, not a winner
      const before = await sqk.balanceOf(late.address);
      await game.connect(late).claim(id);
      expect(await sqk.balanceOf(late.address)).to.equal(before + BUY);
    });

    it("stops a late entry from exiting once the start is posted", async () => {
      const { game, watcher, players } = await loadFixture(deploy);
      const { id, p } = await createGame(game);
      for (const pl of players.slice(0, 3)) await game.connect(pl).enter(id);
      const start = p.earliestStart + 100;
      await at(start + 4, () => game.connect(players[3]).enter(id));
      await at(start + 15, () => game.connect(watcher).postStart(id, start));
      await expect(game.connect(players[3]).exit(id)).to.be.revertedWithCustomError(game, "LateEntry");
    });

    it("lets players leave the lobby with a refund any time before the start", async () => {
      const { game, players, sqk } = await loadFixture(deploy);
      const { id, p } = await createGame(game);
      await game.connect(players[0]).enter(id);
      await time.increaseTo(p.earliestStart + 3600);
      const before = await sqk.balanceOf(players[0].address);
      await game.connect(players[0]).leaveLobby(id);
      expect(await sqk.balanceOf(players[0].address)).to.equal(before + BUY);
    });
  });

  describe("always-on games", () => {
    async function withDefaults() {
      const f = await deploy();
      const now = await time.latest();
      await f.game.setDefaults({
        buyIn: BUY, earliestStart: 0, idleWindow: 180, grace: 12, jackpotBps: 2000,
        jackpotGroupBps: 1000, bountyFlat: BOUNTY, minPlayers: 2, maxPlayers: 200 }, 300);
      return { ...f, now };
    }

    it("lets the watcher open a game with the default rules and a 5-minute minimum lobby", async () => {
      const { game, watcher, players } = await loadFixture(withDefaults);
      await expect(game.connect(players[0]).openNextGame()).to.be.revertedWithCustomError(game, "NotWatcher");
      await game.connect(watcher).openNextGame();
      const g = await game.getGame(1);
      expect(g.status).to.equal(Status.Lobby);
      expect(g.p.buyIn).to.equal(BUY);
      expect(g.p.earliestStart).to.equal(BigInt(await time.latest()) + 300n);
    });

    it("opens the next game only after the current one has finished", async () => {
      const { game, watcher, players } = await loadFixture(withDefaults);
      await game.connect(watcher).openNextGame();
      await expect(game.connect(watcher).openNextGame()).to.be.revertedWithCustomError(game, "GameInProgress");
      await game.connect(players[0]).enter(1);
      const g = await game.getGame(1);
      await at(Number(g.p.earliestStart) + 5, () => game.connect(watcher).postStart(1, g.p.earliestStart)); // 1 player: voided
      expect((await game.getGame(1)).status).to.equal(Status.Voided);
      await game.connect(watcher).openNextGame();
      expect(await game.gameCount()).to.equal(2n);
    });
  });
});

// The watcher's store of scheduled exits: real signatures accepted, forged ones refused, newest wins, cancel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CANCEL, TYPES, cleanOrder, createScheduledExits, domainFor } from "../watcher/scheduled-exits.mjs";

const GAME = "0x" + "12".repeat(20);
const player = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());

async function signed(account, afterSeconds, issuedAt, gameId = 3) {
  const signature = await account.signTypedData({ domain: domainFor(11155111, GAME), types: TYPES, primaryType: "ScheduledExit",
    message: { gameId: BigInt(gameId), player: account.address, afterSeconds, issuedAt: BigInt(issuedAt) } });
  return { gameId, player: account.address, afterSeconds, issuedAt, signature };
}

function setup(entry = { entered: true, left: false, exitTime: 0 }) {
  const file = join(mkdtempSync(join(tmpdir(), "exits-")), "scheduled-exits.json");
  const exits = createScheduledExits({ file, chainId: 11155111, game: GAME, log: () => {}, readEntry: async () => entry });
  return { exits, file, open: () => "Live" };
}

test("keeps a player's signed exit, refuses a forged one, and lets a newer one replace it", async () => {
  const { exits, file, open } = setup();
  assert.deepEqual(await exits.submit(await signed(player, 503, 100), open), { ok: true });
  assert.ok(existsSync(file));
  const forged = { ...(await signed(other, 60, 200)), player: player.address };
  assert.equal((await exits.submit(forged, open)).ok, false);
  assert.equal((await exits.submit(await signed(player, 700, 99), open)).ok, false); // older than the saved one
  assert.equal((await exits.submit(await signed(player, 700, 101), open)).ok, true);
  assert.equal(exits.count, 1);
});

test("cancels with a signed order for a time that never comes", async () => {
  const { exits, open } = setup();
  await exits.submit(await signed(player, 503, 100), open);
  assert.deepEqual(await exits.submit(await signed(player, CANCEL, 101), open), { ok: true, cancelled: true });
  assert.equal(exits.count, 0);
});

test("refuses players who aren't on the wheel, games that aren't open, and malformed orders", async () => {
  const off = setup({ entered: true, left: false, exitTime: 1234 });
  assert.equal((await off.exits.submit(await signed(player, 503, 100), off.open)).ok, false);
  const { exits } = setup();
  assert.equal((await exits.submit(await signed(player, 503, 100), () => "Ended")).ok, false);
  assert.equal(cleanOrder({ gameId: 1, player: "0x12", afterSeconds: 5, issuedAt: 1, signature: "0x00" }), null);
  assert.equal(cleanOrder({ gameId: 1, player: player.address, afterSeconds: -1, issuedAt: 1, signature: "0x" + "ab".repeat(65) }), null);
});

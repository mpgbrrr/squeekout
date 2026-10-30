// Start alerts by push: subscriptions, the confirmation, personal "you're in" messages and dropped browsers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPush, cleanSubscription } from "../watcher/push.mjs";

const sub = (n, address) => ({ subscription: { endpoint: `https://push.example/${n}`, keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) } }, address });
const setup = () => {
  const sent = [], gone = new Set();
  const file = join(mkdtempSync(join(tmpdir(), "push-")), "subs.json");
  const push = createPush({ file, publicKey: "pub", privateKey: "priv", log: () => {},
    send: async (s, payload) => { if (gone.has(s.endpoint)) throw Object.assign(new Error("gone"), { statusCode: 410 }); sent.push({ to: s.endpoint, ...JSON.parse(payload) }); } });
  return { push, sent, gone, file };
};

test("rejects anything that isn't a browser push subscription", () => {
  assert.equal(cleanSubscription({}), null);
  assert.equal(cleanSubscription({ subscription: { endpoint: "http://insecure", keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) } } }), null);
  assert.equal(cleanSubscription({ subscription: { endpoint: "https://x", keys: { p256dh: "<script>", auth: "a".repeat(22) } } }), null);
  assert.equal(cleanSubscription(sub(1, "not-an-address")).address, null);
});

test("confirms a new subscription once, and keeps it on disk", async () => {
  const { push, sent, file } = setup();
  assert.equal(await push.subscribe(sub(1)), true);
  assert.equal(await push.subscribe(sub(1, "0x" + "ab".repeat(20))), true); // same browser, now with a wallet
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /alerts are on/);
  assert.equal(push.count, 1);
  assert.ok(existsSync(file) && JSON.parse(readFileSync(file, "utf8"))[0].address === "0x" + "ab".repeat(20));
});

test("tells players in the game they're on the wheel, and everyone else that a game started", async () => {
  const { push, sent } = setup();
  const me = "0x" + "cd".repeat(20);
  await push.subscribe(sub(1, me));
  await push.subscribe(sub(2));
  sent.length = 0;
  assert.equal(await push.gameStarted({ id: 7, players: ["0x" + "CD".repeat(20), "0x" + "11".repeat(20)], lateEntryWindow: 120 }), 2);
  const mine = sent.find((m) => m.to.endsWith("/1")), other = sent.find((m) => m.to.endsWith("/2"));
  assert.match(mine.title, /You're on the wheel/);
  assert.match(other.title, /Squeektoshi is running/);
  assert.equal(mine.tag, "squeekout-game-7");
  assert.match(other.body, /Jump on in the next 2 min/);
});

test("forgets browsers that turned alerts off, and does nothing without keys", async () => {
  const { push, gone } = setup();
  await push.subscribe(sub(1));
  await push.subscribe(sub(2));
  gone.add("https://push.example/1");
  assert.equal(await push.gameStarted({ id: 1, players: [] }), 1);
  assert.equal(push.count, 1);
  assert.equal(push.unsubscribe({ endpoint: "https://push.example/2" }), true);
  assert.equal(push.count, 0);
  const off = createPush({ file: join(mkdtempSync(join(tmpdir(), "push-")), "s.json"), log: () => {} });
  assert.equal(off.enabled, false);
  assert.equal(await off.subscribe(sub(3)), false);
});

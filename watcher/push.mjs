// Start alerts by push notification: players opt in on the page, and the watcher alerts them the moment a
// game starts (Squeektoshi's first run after the lobby), even if the page is closed or the phone is locked.
// Subscriptions live in a file on the volume. Off unless VAPID keys are set.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import webpush from "web-push";

const MAX_SUBSCRIPTIONS = 5000;
const b64url = /^[A-Za-z0-9_-]{16,200}$/;

/** A browser's push subscription as the page sends it, or null if it isn't one. */
export function cleanSubscription(body) {
  const s = body?.subscription;
  if (typeof s?.endpoint !== "string" || s.endpoint.length > 1000 || !s.endpoint.startsWith("https://")) return null;
  if (!b64url.test(s.keys?.p256dh ?? "") || !b64url.test(s.keys?.auth ?? "")) return null;
  const address = /^0x[0-9a-fA-F]{40}$/.test(body.address ?? "") ? body.address.toLowerCase() : null;
  return { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, address };
}

/**
 * @param send(subscription, payloadString) delivers one notification (web-push by default; tests pass their own)
 */
export function createPush({ file, publicKey, privateKey, subject = "https://squeekout.fun", log, send }) {
  const enabled = Boolean(publicKey && privateKey);
  if (enabled && !send) webpush.setVapidDetails(subject, publicKey, privateKey);
  const deliver = send ?? ((sub, payload) => webpush.sendNotification(sub, payload, { TTL: 900, urgency: "high" }));
  let subs = [];
  if (existsSync(file)) {
    try { subs = JSON.parse(readFileSync(file, "utf8")); } catch (e) { log("push_store_unreadable", { error: String(e) }); }
  }
  const save = () => {
    try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(subs)); } catch (e) { log("push_store_failed", { error: String(e) }); }
  };

  async function notify(sub, message) {
    try {
      await deliver(sub, JSON.stringify(message));
      return true;
    } catch (e) {
      // 404/410: the browser dropped the subscription (alerts turned off, site data cleared).
      if (e.statusCode === 404 || e.statusCode === 410) { subs = subs.filter((s) => s.endpoint !== sub.endpoint); save(); }
      else log("push_failed", { status: e.statusCode ?? null, error: String(e.body || e.message || e).slice(0, 200) });
      return false;
    }
  }

  return {
    enabled,
    publicKey: enabled ? publicKey : null,
    get count() { return subs.length; },

    /** Adds or updates a subscription and sends a confirmation, so the player knows alerts work. */
    async subscribe(body) {
      const sub = cleanSubscription(body);
      if (!enabled || !sub) return false;
      const known = subs.find((s) => s.endpoint === sub.endpoint);
      if (known) known.address = sub.address;
      else {
        if (subs.length >= MAX_SUBSCRIPTIONS) return false;
        subs.push({ ...sub, addedAt: new Date().toISOString() });
      }
      save();
      if (!known) await notify(sub, { title: "Squeek Out alerts are on", body: "We'll ping you the moment Squeektoshi starts running.", tag: "squeekout-on", url: "/" });
      return true;
    },

    unsubscribe(body) {
      const endpoint = body?.endpoint;
      const before = subs.length;
      subs = subs.filter((s) => s.endpoint !== endpoint);
      if (subs.length !== before) save();
      return subs.length !== before;
    },

    /** Alerts everyone subscribed that game `id` just started; players in it get a personal message, and
     * everyone else hears they can still jump on while late entries are open. */
    async gameStarted({ id, players, lateEntryWindow = 0, free = false }) {
      if (!enabled || !subs.length) return 0;
      const inGame = new Set(players.map((p) => p.toLowerCase()));
      let sent = 0;
      for (const sub of [...subs]) {
        const mine = sub.address && inGame.has(sub.address);
        const ok = await notify(sub, mine
          ? { title: "🐹 You're on the wheel!", body: `Squeektoshi just started running: game #${id} is live. Get off before he stops.`, tag: `squeekout-game-${id}`, url: "/" }
          : { title: "🐹 Squeektoshi is running!", tag: `squeekout-game-${id}`, url: "/", body: lateEntryWindow
        ? `Game #${id} just started.${free ? " Free for Squeek holders:" : ""} Jump on in the next ${Math.round(lateEntryWindow / 60) || 1} min, before anyone gets off.`
        : `Game #${id} just started. Watch it live, and catch the next lobby.` });
        if (ok) sent++;
      }
      return sent;
    },
  };
}

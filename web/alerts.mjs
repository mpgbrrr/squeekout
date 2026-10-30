// Start alerts: an alarm when a game starts (Squeektoshi's first run after the lobby), so nobody who joined
// while he slept misses it. Two layers behind one toggle:
//  - on the page: an 8-bit alarm, a flashing tab title, vibration and a notification, while the page is open;
//  - push: the watcher sends a notification even when the page is closed or the phone is locked (needs the
//    server's VAPID key; on iPhone, only once the site is added to the Home Screen).

const PREF = "startAlerts";
const pref = {
  get: () => { try { return localStorage.getItem(PREF) === "on"; } catch { return false; } },
  set: (on) => { try { localStorage.setItem(PREF, on ? "on" : "off"); } catch {} },
};
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

const b64ToBytes = (b64) => {
  const s = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

/**
 * @param vapidPublicKey the server's push key, or null when push isn't set up there
 * @param getAddress() the connected wallet, so a push can say "you're in this game"
 * @param onChange({ on, note }) updates the toggle and its hint
 */
export function createAlerts({ vapidPublicKey, getAddress, onChange }) {
  let on = pref.get(), audio = null, flashTimer = null, note = "";

  async function serviceWorker() {
    return navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready);
  }

  async function subscribePush() {
    if (!vapidPublicKey) return "Alarm on: keep this page open. (Push alerts aren't set up on this server yet.)";
    if (isIOS && !standalone) return "Alarm on while this page is open. For alerts when it's closed: tap Share, then Add to Home Screen, and turn alerts on from there.";
    if (!pushSupported) return "Alarm on: keep this page open. (This browser can't receive push alerts.)";
    if (Notification.permission !== "granted" && (await Notification.requestPermission()) !== "granted") {
      return "Alarm on while this page is open. Notifications are blocked, so you won't be alerted when it's closed: allow them in your browser's site settings.";
    }
    try {
      const reg = await serviceWorker();
      const sub = (await reg.pushManager.getSubscription())
        ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(vapidPublicKey) }));
      const res = await fetch("/push/subscribe", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON(), address: getAddress() }) });
      if (!res.ok) throw new Error(`server said ${res.status}`);
      return "Alerts on: we'll notify you when he starts, even with this page closed.";
    } catch (e) {
      console.warn("Push subscription failed", e);
      return "Alarm on while this page is open. (Push alerts couldn't be set up in this browser.)";
    }
  }

  async function unsubscribePush() {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (!sub) return;
      await fetch("/push/unsubscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
      await sub.unsubscribe();
    } catch {}
  }

  // Browsers only allow sound after a tap, so the toggle tap unlocks it with a short blip.
  function unlockAudio() {
    try {
      audio ??= new (window.AudioContext || window.webkitAudioContext)();
      audio.resume();
      beep(audio.currentTime, 880, 0.06, 0.05);
    } catch {}
  }
  function beep(at, freq, len, vol = 0.12) {
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = "square";
    o.frequency.setValueAtTime(freq, at);
    g.gain.setValueAtTime(vol, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + len);
    o.connect(g).connect(audio.destination);
    o.start(at);
    o.stop(at + len + 0.02);
  }
  // An 8-bit "he's running!" alarm: rising arpeggios, repeated, about 6 seconds.
  function alarm() {
    if (!audio) return;
    audio.resume();
    const t0 = audio.currentTime + 0.05;
    for (let r = 0; r < 6; r++) [523, 659, 784, 1047].forEach((f, i) => beep(t0 + r * 1 + i * 0.11, f, 0.1));
  }

  function flashTitle(text) {
    clearInterval(flashTimer);
    const original = document.title;
    let n = 0;
    flashTimer = setInterval(() => {
      document.title = n++ % 2 ? original : text;
      if (n > 40 || (document.visibilityState === "visible" && document.hasFocus() && n > 6)) { clearInterval(flashTimer); document.title = original; }
    }, 800);
  }

  const emit = () => onChange({ on, note });

  return {
    get on() { return on; },

    /** Turns alerts on or off. Must be called from a tap, so sound and notifications may be allowed. */
    async toggle() {
      on = !on;
      pref.set(on);
      if (on) {
        unlockAudio();
        note = "Setting up alerts…";
        emit();
        note = await subscribePush();
      } else {
        note = "";
        await unsubscribePush();
      }
      emit();
    },

    /** After a reload: show the saved choice and keep the push subscription current (the wallet may have changed). */
    async restore() {
      if (!on) return emit();
      const tapHint = "Alerts on. Tap the page once so the alarm can play sound.";
      let status = "Alerts on.";
      note = tapHint;
      emit();
      const unlock = () => { unlockAudio(); window.removeEventListener("pointerdown", unlock); if (note === tapHint) { note = status; emit(); } };
      window.addEventListener("pointerdown", unlock);
      if (pushSupported && vapidPublicKey && Notification.permission === "granted" && !(isIOS && !standalone)) status = await subscribePush();
      if (note !== tapHint) { note = status; emit(); }
    },

    /** The connected wallet changed: tell the server, so a push can say "you're in this game". */
    async walletChanged() {
      if (on && pushSupported && vapidPublicKey && Notification.permission === "granted") await subscribePush();
    },

    /** A game just started. `tag` matches the watcher's push, so a phone shows one notification, not two. */
    async ring({ title, body, tag }) {
      if (!on) return false;
      alarm();
      flashTitle(`🐹 ${title}`);
      navigator.vibrate?.([300, 120, 300, 120, 600]);
      if (document.visibilityState !== "visible" && "Notification" in window && Notification.permission === "granted") {
        try {
          const reg = await navigator.serviceWorker?.getRegistration();
          if (reg) await reg.showNotification(title, { body, tag, renotify: true, icon: "/icon-192.png", badge: "/icon-192.png", data: { url: "/" } });
          else new Notification(title, { body, tag, icon: "/icon-192.png" });
        } catch {}
      }
      return true;
    },
  };
}

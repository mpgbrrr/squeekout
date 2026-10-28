// The end of a game, for the real game and the demo: a big countdown over the wheel in the last 10 seconds
// of a break, then a celebration with the winners, the payouts and pixel confetti when the game ends.

const $ = (id) => document.getElementById(id);
const COLORS = ["#f2c94c", "#e8913a", "#3ccf7a", "#eef0ff", "#7aa2ff", "#ef5d5d"];
const MEDALS = ["🥇", "🥈", "🥉"];

export function createFinale() {
  const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  let shown = null, confettiRun = 0;

  /** secondsLeft: time until the game ends if he stays still; shown when 10 or less, hidden when null. */
  function countdown(secondsLeft) {
    const el = $("finalCount");
    const show = secondsLeft != null && secondsLeft <= 10;
    el.hidden = !show;
    if (!show) { shown = null; return; }
    const n = Math.max(0, Math.ceil(secondsLeft));
    if (n === shown) return;
    shown = n;
    el.textContent = String(n);
    el.classList.toggle("last", n <= 3);
    el.classList.remove("tick");
    void el.offsetWidth; // restart the pop animation
    el.classList.add("tick");
  }

  /**
   * @param kicker small line above the title (e.g. "Game #3")
   * @param winners [{ name, amount, jackpot, you, at }] best paid first; amount is preformatted text
   * @param you { kind: "won" | "caught", text } or null when you weren't playing
   */
  function celebrate({ kicker, title, subtitle, you, winners, caught, note }) {
    countdown(null);
    $("finaleKicker").textContent = kicker;
    $("finaleTitle").textContent = title;
    $("finaleSub").textContent = subtitle;
    $("finaleYou").hidden = !you;
    if (you) { $("finaleYou").textContent = you.text; $("finaleYou").className = `finale-you ${you.kind}`; }
    const list = $("finaleWinners");
    list.replaceChildren(...winners.map((w, i) => {
      const li = document.createElement("li");
      if (w.you) li.className = "mine";
      li.style.animationDelay = `${0.25 + i * 0.12}s`;
      const badge = document.createElement("span");
      badge.className = i < 3 ? "medal" : "rank";
      badge.textContent = i < 3 ? MEDALS[i] : `#${i + 1}`;
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = w.name;
      if (w.jackpot) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = "JACKPOT";
        who.append(tag);
      }
      const at = document.createElement("small");
      at.textContent = `got off at ${w.at}`;
      who.append(at);
      const amt = document.createElement("span");
      amt.className = "amt";
      amt.textContent = w.amount;
      li.append(badge, who, amt);
      return li;
    }));
    list.hidden = winners.length === 0;
    $("finaleCaught").textContent = caught;
    $("finaleNote").textContent = note || "";
    $("finaleNote").hidden = !note;
    const d = $("finale");
    if (!d.open) d.showModal();
    if (!reducedMotion()) confetti(winners.length ? 220 : 60);
  }

  function confetti(count) {
    const canvas = $("confetti");
    // A popover sits above the dialog; without popover support, the confetti shows behind it.
    if (typeof canvas.showPopover === "function") { if (!canvas.matches(":popover-open")) canvas.showPopover(); } else canvas.hidden = false;
    const run = ++confettiRun;
    const scale = 3; // draw at a third of the size and let the browser scale it up: chunky pixels
    const w = Math.ceil(innerWidth / scale), h = Math.ceil(innerHeight / scale);
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    const bits = Array.from({ length: count }, () => ({
      x: w / 2 + (Math.random() - 0.5) * w * 0.3, y: h * 0.45,
      vx: (Math.random() - 0.5) * 3.2, vy: -2 - Math.random() * 3.5,
      size: 1 + Math.floor(Math.random() * 3), color: COLORS[Math.floor(Math.random() * COLORS.length)],
      spin: Math.random() * Math.PI * 2, spinRate: 0.1 + Math.random() * 0.25, delay: Math.random() * 25,
    }));
    let frame = 0;
    const draw = () => {
      if (run !== confettiRun) return;
      frame++;
      ctx.clearRect(0, 0, w, h);
      let alive = 0;
      for (const b of bits) {
        if (frame < b.delay) { alive++; continue; }
        b.vy += 0.06;
        b.vx *= 0.99;
        b.x += b.vx;
        b.y += b.vy;
        b.spin += b.spinRate;
        if (b.y > h + 4) continue;
        alive++;
        // A flat piece of confetti flipping over: its width shrinks and grows.
        const width = Math.max(1, Math.round(b.size * 2 * Math.abs(Math.cos(b.spin))));
        ctx.fillStyle = b.color;
        ctx.fillRect(Math.round(b.x), Math.round(b.y), width, b.size * 2);
      }
      if (alive && frame < 600) requestAnimationFrame(draw);
      else stopConfetti();
    };
    requestAnimationFrame(draw);
  }

  function stopConfetti() {
    confettiRun++;
    const canvas = $("confetti");
    if (typeof canvas.hidePopover === "function") { if (canvas.matches(":popover-open")) canvas.hidePopover(); } else canvas.hidden = true;
  }

  $("finale").addEventListener("close", stopConfetti);

  function close() {
    countdown(null);
    if ($("finale").open) $("finale").close();
  }

  return { countdown, celebrate, close };
}

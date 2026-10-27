// 8-bit Squeektoshi in his wheel, drawn on a small canvas and scaled up with crisp pixels.
// update(view) takes the shared rules' display() result: running, paused, asleep or signal-lost.

const W = 96, H = 72;
const COLORS = {
  sky: "#141a33", floor: "#2a2147", bedding: "#5b4a3a", stand: "#6e7aa8", rim: "#f2c94c", spoke: "#c99a2e",
  outline: "#2b1d16", orange: "#e8913a", white: "#f6efe4", pink: "#f2a3a8", eye: "#0b0b0b", zzz: "#9fb4ff",
};
const GREY = { orange: "#8a8a8a", white: "#c8c8c8", pink: "#a9a9a9", rim: "#9a9a9a", spoke: "#7a7a7a" };

export function createHamster(canvas) {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let view = { mode: "asleep" };
  let angle = 0, frame = 0, last = performance.now(), t = 0;

  const px = (x, y, c) => { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), 1, 1); };
  const blob = (cx, cy, rx, ry, c) => {
    for (let y = -ry; y <= ry; y++) for (let x = -rx; x <= rx; x++) {
      if ((x * x) / (rx * rx) + (y * y) / (ry * ry) <= 1) px(cx + x, cy + y, c);
    }
  };

  function wheel(cx, cy, r, pal) {
    for (let a = 0; a < 360; a += 2) {
      const rad = (a * Math.PI) / 180;
      px(cx + Math.cos(rad) * r, cy + Math.sin(rad) * r, pal.rim);
      px(cx + Math.cos(rad) * (r - 1), cy + Math.sin(rad) * (r - 1), pal.rim);
    }
    for (let s = 0; s < 6; s++) {
      const rad = angle + (s * Math.PI) / 3;
      for (let d = 2; d < r - 1; d++) px(cx + Math.cos(rad) * d, cy + Math.sin(rad) * d, pal.spoke);
    }
    blob(cx, cy, 2, 2, pal.rim);
  }

  function hamster(x, y, pose, pal) {
    // pose: run (legs alternate with frame), stand, sleep
    if (pose === "sleep") {
      blob(x, y + 1, 9, 4, COLORS.outline);
      blob(x, y + 1, 8, 3, pal.orange);
      blob(x + 3, y + 2, 5, 2, pal.white);
      blob(x - 6, y - 1, 2, 2, pal.pink);
      for (let i = -1; i <= 1; i++) px(x - 4 + i, y + 1, COLORS.outline); // closed eye
      return;
    }
    const legA = pose === "run" ? (frame % 2 ? 1 : -1) : 0;
    blob(x, y, 8, 5, COLORS.outline);
    blob(x, y, 7, 4, pal.orange);
    blob(x + 2, y + 1, 5, 3, pal.white);
    blob(x - 7, y - 2, 4, 4, COLORS.outline);
    blob(x - 7, y - 2, 3, 3, pal.white);
    blob(x - 6, y - 6, 1, 1, pal.pink); // ear
    const look = pose === "stand" && Math.floor(t / 900) % 2 ? 1 : 0; // glances around while paused
    px(x - 8 + look, y - 3, COLORS.eye);
    px(x - 10, y - 1, pal.pink); // nose
    for (const [lx, phase] of [[-4, legA], [4, -legA]]) {
      px(x + lx + phase, y + 5, COLORS.outline);
      px(x + lx + phase, y + 6, pal.pink);
    }
  }

  function noise() {
    for (let i = 0; i < 700; i++) {
      const v = Math.floor(Math.random() * 255);
      px(Math.random() * W, Math.random() * H, `rgb(${v},${v},${v})`);
    }
  }

  function draw(now) {
    const dt = Math.min(100, now - last);
    last = now;
    t += dt;
    const lost = view.mode === "signal-lost";
    const pal = lost ? { ...COLORS, ...GREY } : COLORS;
    if (view.mode === "running" && !reduced) {
      const rpm = Math.max(20, Math.min(140, view.rpm || 60));
      angle -= (rpm / 60) * 2 * Math.PI * (dt / 1000);
      frame = Math.floor(t / Math.max(60, 9000 / rpm));
    }
    ctx.fillStyle = pal.sky;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = COLORS.floor;
    ctx.fillRect(0, 60, W, 12);
    for (let x = 0; x < W; x += 3) px(x, 60 + ((x * 7) % 3), COLORS.bedding);
    // stand
    for (let d = 0; d < 26; d++) { px(48 - d * 0.45, 32 + d, COLORS.stand); px(48 + d * 0.45, 32 + d, COLORS.stand); }
    wheel(48, 32, 24, pal);
    const pose = view.mode === "running" ? "run" : view.mode === "asleep" ? "sleep" : "stand";
    hamster(48, 48, pose, pal);
    if (view.mode === "asleep" && !reduced) {
      const k = (t / 1200) % 1;
      ctx.fillStyle = COLORS.zzz;
      ctx.font = "7px monospace";
      ctx.fillText("z", 58 + k * 6, 40 - k * 10);
      ctx.fillText("Z", 63 + k * 5, 30 - k * 8);
    }
    if (lost) noise();
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);

  return { update(next) { view = next; } };
}

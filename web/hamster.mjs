// 8-bit Squeektoshi in his wheel, drawn on a small canvas and scaled up with crisp pixels.
// update(view) takes the shared rules' display() result: running, paused, asleep or signal-lost.

const W = 96, H = 72;
const COLORS = {
  sky: "#141a33", floor: "#2a2147", bedding: "#5b4a3a", stand: "#6e7aa8", rim: "#f2c94c", spoke: "#c99a2e", zzz: "#9fb4ff",
};

// Squeektoshi, a Syrian hamster in profile facing left, as 22 x 15 pixel sprites. One letter per pixel:
// . clear, k outline, o orange, O orange shade, w white, W cream shade, p pink, e eye, h eye highlight, c cheek blush
const SPRITES = {
  run1: [
    "......kk..............",
    ".....kook.............",
    "....koppokkkkkkkk.....",
    "...koooooooooooookk...",
    "..koheooooooooooooOk..",
    ".kwweeooooooooooooOOk.",
    ".pwwwwwwooooooooooOOk.",
    ".kwwwcwwoooooooOOOOOk.",
    ".kwwwwwwwwwwwwwwwwwwk.",
    "..kwwwwwwwwwwwwwwwwk..",
    "...kkwwwwWWWWWWWWwk...",
    ".....kkpkkWWWWWpkk....",
    ".......pk.kkkkkpk.....",
    "......................",
    "......................",
  ],
  run2: [
    ".....kook.............",
    "....koppokkkkkkkk.....",
    "...koooooooooooookk...",
    "..koheooooooooooooOk..",
    ".kwweeooooooooooooOOk.",
    ".pwwwwwwooooooooooOOk.",
    ".kwwwcwwoooooooOOOOOk.",
    ".kwwwwwwwwwwwwwwwwwwk.",
    "..kwwwwwwwwwwwwwwwwk..",
    "...kkwwwwWWWWWWWWwk...",
    ".....kkkpkWWWpWkkk....",
    "........pkkkkpk.......",
    "......................",
    "......................",
    "......................",
  ],
  run3: [
    "......kk..............",
    ".....kook.............",
    "....koppokkkkkkkk.....",
    "...koooooooooooookk...",
    "..koheooooooooooooOk..",
    ".kwweeooooooooooooOOk.",
    ".pwwwwwwooooooooooOOk.",
    ".kwwwcwwoooooooOOOOOk.",
    ".kwwwwwwwwwwwwwwwwwwk.",
    "..kwwwwwwwwwwwwwwwwk..",
    "...kkwwwwWWWWWWWWwk...",
    ".....kkkkkpWpWWkkk....",
    "..........pkpkk.......",
    "......................",
    "......................",
  ],
  run4: [
    ".....kook.............",
    "....koppokkkkkkkk.....",
    "...koooooooooooookk...",
    "..koheooooooooooooOk..",
    ".kwweeooooooooooooOOk.",
    ".pwwwwwwooooooooooOOk.",
    ".kwwwcwwoooooooOOOOOk.",
    ".kwwwwwwwwwwwwwwwwwwk.",
    "..kwwwwwwwwwwwwwwwwk..",
    "...kkwwwwWWWWWWWWwk...",
    ".....kkkpkWWWWpkkk....",
    "........pkkkkkpk......",
    "......................",
    "......................",
    "......................",
  ],
  stand: [
    "......kk..............",
    ".....kook.............",
    "....koppokkkkkkkk.....",
    "...koooooooooooookk...",
    "..koheooooooooooooOk..",
    ".kwweeooooooooooooOOk.",
    ".pwwwwwwooooooooooOOk.",
    ".kwwwcwwoooooooOOOOOk.",
    ".kwwwwwwwwwwwwwwwwwwk.",
    "..kwwwwwwwwwwwwwwwwk..",
    "...kkwwwwWWWWWWWWwk...",
    ".....kkpkkWWWWpkkk....",
    ".......pk.kkkkpk......",
    "......................",
    "......................",
  ],
  sniff: [
    "......kk..............",
    ".....kook.............",
    "....koppokkkkkkkk.....",
    "...koooooooooooookk...",
    "..koheooooooooooooOk..",
    "kpwweeooooooooooooOOk.",
    ".wwwwwwwooooooooooOOk.",
    ".kwwwcwwoooooooOOOOOk.",
    ".kwwwwwwwwwwwwwwwwwwk.",
    "..kwwwwwwwwwwwwwwwwk..",
    "...kkwwwwWWWWWWWWwk...",
    ".....kkpkkWWWWpkkk....",
    ".......pk.kkkkpk......",
    "......................",
    "......................",
  ],
  look: [
    "...k....k.............",
    "..kokkkkok............",
    ".kopkookpokkkkkkkk....",
    "..kooooookooooooook...",
    ".kooooooookoooooooOk..",
    ".kwhewwehwkoooooooOOk.",
    "kwweewweewwkooooooOOk.",
    ".kwwwppwwwkooooOOOOOk.",
    ".kcwwwwwwckwwwwwwwwwk.",
    "..kwwwwwwkwwwwwwwwwk..",
    "...kkwwkkWWWWWWWWwk...",
    ".....kkpkkkWWWpkkk....",
    ".......pk..kkkpk......",
    "......................",
    "......................",
  ],
  sleep: [
    "......................",
    "......................",
    "......................",
    "......................",
    "......kkkkkkkkkkk.....",
    ".....kooooooooooOkk...",
    "....kopoooooooooOOOk..",
    "...kooooooooooooOOOOk.",
    "..koookoooooooooOOOOk.",
    "..kwkkwoooooooooOOOOk.",
    "..kwwwwoooooooooOOOOk.",
    "..pwwwwoooooooooOOOk..",
    "...kwwWWWWWWWWWWWWk...",
    "....kkkkkkWWWWkkkk....",
    "..........kkkk........",
  ],
  sleep2: [
    "......................",
    "......................",
    "......................",
    "........kkkkkkkk......",
    "......kkooooooookk....",
    ".....kooooooooooOOk...",
    "....kopoooooooooOOOk..",
    "...kooooooooooooOOOOk.",
    "..koookoooooooooOOOOk.",
    "..kwkkwoooooooooOOOOk.",
    "..kwwwwoooooooooOOOOk.",
    "..pwwwwoooooooooOOOk..",
    "...kwwWWWWWWWWWWWkk...",
    "....kkkkkkWWWWkkk.....",
    "..........kkkk........",
  ],
};
const FUR = { k: "#2b1d16", o: "#e8913a", O: "#c4702a", w: "#f6efe4", W: "#e2d6c2", p: "#f2a3a8", e: "#0b0b0b", h: "#ffffff", c: "#f7b9a6" };
const GREY_FUR = { ...FUR, o: "#8a8a8a", O: "#6f6f6f", w: "#c8c8c8", W: "#b0b0b0", p: "#a9a9a9", c: "#b8b8b8" };
const GREY = { rim: "#9a9a9a", spoke: "#7a7a7a" };
const RUN = ["run1", "run2", "run3", "run4"];

export function createHamster(canvas) {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let view = { mode: "asleep" };
  let angle = 0, step = 0, last = performance.now(), t = 0;

  const px = (x, y, c) => { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), 1, 1); };

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
    for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) if (x * x + y * y <= 4) px(cx + x, cy + y, pal.rim);
  }

  function sprite(name, left, top, fur) {
    SPRITES[name].forEach((row, y) => {
      for (let x = 0; x < row.length; x++) if (row[x] !== ".") px(left + x, top + y, fur[row[x]]);
    });
  }

  function draw(now) {
    const dt = Math.max(0, Math.min(100, now - last)); // a frame's timestamp can predate creation
    last = now;
    t += dt;
    const lost = view.mode === "signal-lost";
    const pal = lost ? { ...COLORS, ...GREY } : COLORS;
    if (view.mode === "running" && !reduced) {
      const rpm = Math.max(20, Math.min(140, view.rpm || 60));
      angle -= (rpm / 60) * 2 * Math.PI * (dt / 1000);
      step = Math.floor(t / Math.max(55, 7000 / rpm)); // faster wheel, faster legs
    }
    ctx.fillStyle = pal.sky;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = COLORS.floor;
    ctx.fillRect(0, 60, W, 12);
    for (let x = 0; x < W; x += 3) px(x, 60 + ((x * 7) % 3), COLORS.bedding);
    // stand
    for (let d = 0; d < 26; d++) { px(48 - d * 0.45, 32 + d, COLORS.stand); px(48 + d * 0.45, 32 + d, COLORS.stand); }
    wheel(48, 32, 24, pal);
    // Feet rest on the inside of the rim at y 54; sleeping sprites sit two rows lower in their frame.
    const fur = lost ? GREY_FUR : FUR;
    if (view.mode === "running") sprite(reduced ? "stand" : RUN[step % 4], 37, 42, fur);
    else if (view.mode === "asleep") sprite(!reduced && Math.floor(t / 1300) % 2 ? "sleep2" : "sleep", 37, 40, fur);
    else {
      // Paused: a burst of sniffing, a still moment, then he turns and stares at the camera for a bit.
      // Signal lost: stands frozen.
      const beat = t % 6500;
      const looking = !lost && !reduced && beat >= 4600 && beat < 6100;
      const sniffing = !lost && !reduced && beat < 900 && Math.floor(t / 150) % 2;
      sprite(looking ? "look" : sniffing ? "sniff" : "stand", 37, 42, fur);
    }
    if (view.mode === "asleep" && !reduced) {
      const k = (t / 1200) % 1;
      ctx.fillStyle = COLORS.zzz;
      ctx.font = "7px monospace";
      ctx.fillText("z", 60 + k * 6, 42 - k * 10);
      ctx.fillText("Z", 65 + k * 5, 32 - k * 8);
    }
    if (lost) {
      for (let i = 0; i < 700; i++) {
        const v = Math.floor(Math.random() * 255);
        px(Math.random() * W, Math.random() * H, `rgb(${v},${v},${v})`);
      }
    }
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);

  return { update(next) { view = next; } };
}

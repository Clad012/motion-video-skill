#!/usr/bin/env node
/**
 * Draws the example's characters: six fruits with faces, arms and sneakers,
 * each a 2-second loop, rendered to media/<fruit>-full.mp4 (720x1280) and
 * media/<fruit>-avatar.mp4 (360x360 close-up). Original art, free to reuse.
 *
 *   node examples/smoothie-squad/make-media.mjs
 *
 * Your own project would use real footage, product shots, AI-generated
 * character loops, or anything else: any video or image works as media.
 */
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "media");
const FRAMES = 48, FPS = 24;

function findFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  if (spawnSync("ffmpeg", ["-version"]).status === 0) return "ffmpeg";
  for (const py of [process.env.PYTHON, join(HERE, "../../.venv/bin/python"), "python3"]) {
    if (!py) continue;
    const r = spawnSync(py, ["-c", "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"], { encoding: "utf8" });
    if (r.status === 0) return r.stdout.trim();
  }
  throw new Error("ffmpeg not found");
}
const FF = findFfmpeg();

const INK = "#2b1d14";
const FRUITS = {
  banana: {
    bg: ["#fff4c9", "#f6dc7a"], face: [45, -20], wave: 1,
    body: `<path d="M-30,-262 C62,-250 152,-120 152,22 C152,162 82,252 -8,266 C-70,274 -122,256 -132,240 C-60,200 -22,120 -22,20 C-22,-90 -62,-190 -96,-236 C-82,-256 -56,-264 -30,-262Z" fill="url(#g)"/>
           <path d="M-96,-236 C-104,-252 -92,-270 -76,-266 L-60,-252 Z" fill="#6b4a1f"/><circle cx="-128" cy="238" r="12" fill="#6b4a1f"/>`,
    grad: ["#ffe36b", "#f2c230"],
  },
  strawberry: {
    bg: ["#ffe1e6", "#f7a9b6"], face: [0, 10], wave: -1,
    body: `<path d="M0,-190 C130,-205 215,-120 200,10 C185,140 80,235 0,265 C-80,235 -185,140 -200,10 C-215,-120 -130,-205 0,-190Z" fill="url(#g)"/>
           ${[...Array(16)].map((_, i) => { const x = ((i * 73) % 300) - 150, y = ((i * 131) % 330) - 120; return Math.abs(x) < 190 - Math.max(0, y) * 0.5 && !(Math.abs(x) < 110 && y > -60 && y < 90) ? `<ellipse cx="${x}" cy="${y}" rx="6" ry="9" fill="#ffe082"/>` : ""; }).join("")}
           ${[0, 72, 144, 216, 288].map((a) => `<ellipse cx="0" cy="-205" rx="22" ry="62" fill="#3fa34d" transform="rotate(${a - 36} 0 -190)"/>`).join("")}`,
    grad: ["#ff5a6e", "#d9253f"],
  },
  kiwi: {
    bg: ["#e6f5d8", "#b7dd98"], face: [0, 0], wave: 1,
    body: `<ellipse rx="185" ry="215" fill="url(#g)"/>
           ${[...Array(34)].map((_, i) => { const a = (i / 34) * Math.PI * 2; const x = Math.cos(a) * 180, y = Math.sin(a) * 210; return `<line x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="${(x * 1.07).toFixed(1)}" y2="${(y * 1.06).toFixed(1)}" stroke="#a9794b" stroke-width="5" stroke-linecap="round"/>`; }).join("")}`,
    grad: ["#a0703f", "#7a5130"],
  },
  blueberry: {
    bg: ["#e2e8ff", "#aebcf5"], face: [0, 10], wave: -1,
    body: `<circle r="190" fill="url(#g)"/><ellipse cx="-70" cy="-90" rx="60" ry="34" fill="#fff" opacity=".18" transform="rotate(-30 -70 -90)"/>
           <path d="M0,-212 L14,-186 L42,-192 L28,-168 L48,-148 L20,-150 L0,-126 L-20,-150 L-48,-148 L-28,-168 L-42,-192 L-14,-186Z" fill="#2c3b86"/>`,
    grad: ["#6f87ee", "#3d55c4"],
  },
  mango: {
    bg: ["#ffeccf", "#ffc78a"], face: [0, 0], wave: 1,
    body: `<path d="M-20,-232 C122,-242 222,-120 206,40 C190,192 90,262 -30,246 C-160,228 -216,110 -202,-20 C-186,-150 -120,-226 -20,-232Z" fill="url(#g)"/>
           <ellipse cx="60" cy="-250" rx="70" ry="26" fill="#43a047" transform="rotate(-20 60 -250)"/><rect x="-6" y="-262" width="12" height="36" rx="6" fill="#6b4a1f"/>`,
    grad: ["#ffd24a", "#ff6f3c"],
  },
  orange: {
    bg: ["#fff0dc", "#ffcc8f"], face: [0, 10], wave: -1,
    body: `<circle r="200" fill="url(#g)"/>
           ${[...Array(40)].map((_, i) => { const a = i * 2.4, r = 40 + ((i * 37) % 150); return `<circle cx="${(Math.cos(a) * r).toFixed(1)}" cy="${(Math.sin(a) * r).toFixed(1)}" r="3.5" fill="#e0701c" opacity=".45"/>`; }).join("")}
           <rect x="-7" y="-222" width="14" height="34" rx="7" fill="#6b4a1f"/><ellipse cx="45" cy="-214" rx="56" ry="22" fill="#43a047" transform="rotate(-25 45 -214)"/>`,
    grad: ["#ffae42", "#f07a1c"],
  },
};

function character(name, f, view) {
  const fr = FRUITS[name];
  const ph = (f / FRAMES) * Math.PI * 2;
  const hop = (Math.sin(ph * 2) * 0.5 + 0.5) * 26;
  const sq = 0.035 * Math.cos(ph * 2);
  const blink = f % 24 >= 20 && f % 24 <= 22 ? 0.12 : 1;
  const look = Math.sin(ph) * 6;
  const [fx, fy] = fr.face;
  const cy = 690 - hop;
  const wave = -62 + 26 * Math.sin(ph * 4);
  const arm = (side, angle) => {
    const sx = side * 175, sy = 40;
    const a = (angle * Math.PI) / 180;
    const ex = sx + side * Math.cos(a) * 150, ey = sy + Math.sin(a) * 150;
    return `<path d="M${sx},${sy} Q${(sx + ex) / 2 + side * 10},${(sy + ey) / 2 + 20} ${ex.toFixed(1)},${ey.toFixed(1)}" stroke="${INK}" stroke-width="14" fill="none" stroke-linecap="round"/><circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="22" fill="#fff" stroke="${INK}" stroke-width="5"/>`;
  };
  const legs = [-1, 1].map((s) => `<path d="M${s * 60},${1085 - cy - 160} L${s * 62},${1080 - cy}" stroke="${INK}" stroke-width="14" stroke-linecap="round"/><ellipse cx="${s * 70}" cy="${1088 - cy}" rx="46" ry="22" fill="#fff" stroke="${INK}" stroke-width="5"/><rect x="${s * 70 - 30}" y="${1080 - cy}" width="60" height="7" rx="3" fill="${fr.grad[1]}"/>`).join("");
  const eye = (s) => `<g transform="translate(${fx + s * 48} ${fy - 22})"><ellipse rx="31" ry="${(37 * blink).toFixed(1)}" fill="#fff" stroke="${INK}" stroke-width="5"/>${blink > 0.5 ? `<circle cx="${(look).toFixed(1)}" cy="4" r="16" fill="${INK}"/><circle cx="${(look - 5).toFixed(1)}" cy="-3" r="5" fill="#fff"/>` : ""}</g>`;
  const brow = (s) => `<path d="M${fx + s * 48 - 22},${fy - 78 - hop * 0.2} Q${fx + s * 48},${fy - 92 - hop * 0.2} ${fx + s * 48 + 22},${fy - 78 - hop * 0.2}" stroke="${INK}" stroke-width="7" fill="none" stroke-linecap="round"/>`;
  const face = `${eye(-1)}${eye(1)}${brow(-1)}${brow(1)}
    <ellipse cx="${fx - 84}" cy="${fy + 28}" rx="24" ry="14" fill="#ff6f7f" opacity=".45"/><ellipse cx="${fx + 84}" cy="${fy + 28}" rx="24" ry="14" fill="#ff6f7f" opacity=".45"/>
    <path d="M${fx - 40},${fy + 26} Q${fx},${fy + 80} ${fx + 40},${fy + 26} Q${fx},${fy + 44} ${fx - 40},${fy + 26}Z" fill="#6a1f22" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
    <ellipse cx="${fx}" cy="${fy + 56}" rx="14" ry="7" fill="#ff8a95"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view}" width="100%" height="100%">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${fr.bg[0]}"/><stop offset="1" stop-color="${fr.bg[1]}"/></linearGradient>
    <radialGradient id="spot" cx="0.5" cy="0.05" r="0.75"><stop offset="0" stop-color="#fff" stop-opacity=".75"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <linearGradient id="g" x1="0.2" y1="0" x2="0.8" y2="1"><stop offset="0" stop-color="${fr.grad[0]}"/><stop offset="1" stop-color="${fr.grad[1]}"/></linearGradient>
  </defs>
  <rect x="-2000" y="-2000" width="5000" height="5000" fill="url(#bg)"/><rect width="720" height="1280" fill="url(#spot)"/>
  <ellipse cx="360" cy="1100" rx="270" ry="52" fill="#fff" opacity=".4"/>
  <ellipse cx="360" cy="1098" rx="${(150 - hop * 1.5).toFixed(1)}" ry="20" fill="#000" opacity=".13"/>
  <g transform="translate(360 ${cy.toFixed(1)})">
    ${legs}
    ${arm(-fr.wave, fr.wave < 0 ? wave : 30)}${arm(fr.wave, fr.wave > 0 ? wave : 30)}
    <g transform="scale(${(1 + sq).toFixed(3)} ${(1 - sq).toFixed(3)})">${fr.body}${face}</g>
  </g></svg>`;
}

const browser = await chromium.launch();
mkdirSync(OUT, { recursive: true });
for (const name of Object.keys(FRUITS)) {
  for (const [variant, w, h] of [["full", 720, 1280], ["avatar", 360, 360]]) {
    const tmp = join(HERE, "build", "media-frames", `${name}-${variant}`);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    const [fx, fy] = FRUITS[name].face;
    for (let f = 0; f < FRAMES; f++) {
      const view = variant === "full" ? "0 0 720 1280" : `${360 + fx - 240} ${690 + fy - 300} 480 480`;
      await page.setContent(`<body style="margin:0">${character(name, f, view)}</body>`);
      await page.screenshot({ path: join(tmp, `${String(f).padStart(3, "0")}.png`) });
    }
    await page.close();
    execFileSync(FF, ["-hide_banner", "-loglevel", "error", "-y", "-framerate", String(FPS), "-i", join(tmp, "%03d.png"), "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(OUT, `${name}-${variant}.mp4`)]);
    console.log(`› media/${name}-${variant}.mp4`);
  }
}
await browser.close();

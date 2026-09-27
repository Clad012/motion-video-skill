/*
 * motion-video-skill engine.
 *
 * A deterministic renderer: render(t) draws the exact frame at time t, so the
 * browser preview and the captured MP4 always match. The video is a list of
 * scenes described in story.json; the timeline, word sync, sound cues and the
 * music plan are all derived from it.
 *
 * Inputs (written by make.mjs into build/): window.STORY, window.VOICES,
 * window.MEDIA. Outputs for the pipeline: window.seek(t), window.cues,
 * window.meta, window.warnings, window.ready.
 */
(() => {
  "use strict";

  /* ---------------------------------------------------------------- setup */
  const S = window.STORY;
  const VO = window.VOICES || {};
  const MEDIA = window.MEDIA || {};
  // Notes: things the engine fixed by itself. Problems: things that block the render until fixed.
  const warnings = [], problems = [];
  const warn = (m) => { if (!warnings.includes(m)) warnings.push(m); };
  const problem = (m) => { if (!problems.includes(m)) problems.push(m); };

  const W = S.format?.width ?? 1080;
  const H = S.format?.height ?? 1920;
  const U = Math.min(W, H) / 1080; // one design unit
  const PORTRAIT = H > W;
  const style = S.style ?? {};
  const hex6 = (h) => (typeof h === "string" && /^#[0-9a-f]{3}$/i.test(h) ? "#" + [...h.slice(1)].map((c) => c + c).join("") : h);
  const PAPER = hex6(style.paper ?? "#f4f3ef");
  const INK = hex6(style.ink ?? "#1c1c1b");
  const PALETTE = {
    blue: "#5B8DEF", violet: "#7A5CD0", green: "#43B17A", amber: "#D9A441",
    rose: "#E4718A", teal: "#3FB3B0", copper: "#C4713D", slate: "#7C8798",
    ...(style.palette ?? {}),
  };
  const col = (c, fallback = style.accent ?? "violet") => hex6(PALETTE[c] ?? (typeof c === "string" && c.startsWith("#") ? c : PALETTE[fallback] ?? fallback));
  const ACCENT = col(style.accent ?? "violet");
  const FONT = `"${style.font ?? "Geist"}", system-ui, sans-serif`;
  const STYLE_BPM = { playful: 100, lofi: 80, upbeat: 118, cinematic: 90, chiptune: 128, tropical: 102, corporate: 110, ambient: 72 };
  const BEAT = 60 / (S.music?.bpm ?? STYLE_BPM[S.music?.style] ?? 100);
  const labels = { now: "now", number: "No.", prompt: "PROMPT", assistant: "AI assistant", ...(S.labels ?? {}) };

  /* ---------------------------------------------------------------- maths */
  const TAU = Math.PI * 2;
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const prog = (t, a, b) => clamp((t - a) / (b - a));
  const lerp = (a, b, p) => a + (b - a) * p;
  const outCubic = (p) => 1 - Math.pow(1 - p, 3);
  const inCubic = (p) => p * p * p;
  const inQuad = (p) => p * p;
  const inOutCubic = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const outBack = (p, s = 1.70158) => 1 + (s + 1) * Math.pow(p - 1, 3) + s * Math.pow(p - 1, 2);
  const inBack = (p, s = 1.70158) => (s + 1) * p * p * p - s * p * p;
  const outElastic = (p) => (p <= 0 ? 0 : p >= 1 ? 1 : Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * (TAU / 3)) + 1);
  /** Squash-and-stretch after an impact: returns the x stretch, y is its mirror. */
  const wobble = (u, amp = 0.24, freq = 30, decay = 8) => (u < 0 ? 0 : amp * Math.exp(-u * decay) * Math.cos(u * freq));
  const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  const rgb = (h) => [1, 3, 5].map((o) => parseInt(h.slice(o, o + 2), 16));
  const mix = (a, b, p) => { const A = rgb(a), B = rgb(b); return "#" + A.map((v, i) => Math.round(lerp(v, B[i], clamp(p))).toString(16).padStart(2, "0")).join(""); };
  const tint = (c) => mix(col(c), PAPER, 0.72);
  const snapUp = (x) => Math.ceil(x / BEAT - 1e-6) * BEAT;
  const f1 = (v) => v.toFixed(1);

  /* ---------------------------------------------------------------- readability */
  // Every piece of text must reach this contrast with what it sits on (WCAG AA).
  const MIN_CONTRAST = 4.5;
  // Smallest text anything draws, and the smallest a title line may shrink to, in pixels at 1080 wide.
  const MIN_TEXT = 40, MIN_TITLE = 72;
  const relLum = (h) => {
    const [r, g, b] = rgb(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const la = relLum(a), lb = relLum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
  /** A text colour that reads on `bg`: itself, or darkened (lightened on a dark background) until it does. */
  function readable(fg, bg, what) {
    fg = hex6(fg); bg = hex6(bg);
    if (contrast(fg, bg) >= MIN_CONTRAST) return fg;
    const toward = relLum(bg) > 0.18 ? "#000000" : "#ffffff";
    let c = fg;
    for (let i = 1; i <= 20 && contrast(c, bg) < MIN_CONTRAST; i++) c = mix(fg, toward, i * 0.05);
    if (what) warn(`${what}: ${fg} on ${bg} is only ${contrast(fg, bg).toFixed(1)}:1, drawn as ${c} so it reads. Choose a darker colour.`);
    return c;
  }
  /** Colours for a filled shape with text on it: white or ink text, or a darker fill when neither reads. */
  function onFill(fill, what) {
    fill = hex6(fill);
    if (contrast("#ffffff", fill) >= MIN_CONTRAST) return { fill, text: "#ffffff" };
    if (contrast(INK, fill) >= MIN_CONTRAST) return { fill, text: INK };
    let f = fill;
    for (let i = 1; i <= 20 && contrast("#ffffff", f) < MIN_CONTRAST; i++) f = mix(fill, "#000000", i * 0.05);
    if (what) warn(`${what}: no text colour reads on ${fill}; filled with ${f} instead.`);
    return { fill: f, text: "#ffffff" };
  }
  if (contrast(INK, PAPER) < 7) problem(`style: ink ${INK} on paper ${PAPER} is only ${contrast(INK, PAPER).toFixed(1)}:1; body text needs 7:1. Use a darker ink or a lighter paper.`);
  /** How to show coloured words: in the colour when it reads on the background, else as a highlighter band with readable text on it. */
  function colouredText(c, bg) {
    c = hex6(c);
    if (contrast(c, bg) >= MIN_CONTRAST) return { text: c, marker: null };
    const o = onFill(c);
    return { text: o.text, marker: o.fill };
  }
  function marker(x0, width, base, size, fill, p, rot = -1.5) {
    if (p <= 0.001) return "";
    const pad = size * 0.16, h = size * 1.08, w = (width + pad * 2) * clamp(p);
    return `<rect x="${f1(x0 - pad)}" y="${f1(base - size * 0.84)}" width="${f1(w)}" height="${f1(h)}" rx="${f1(size * 0.2)}" fill="${fill}" transform="rotate(${rot} ${f1(x0)} ${f1(base)})"/>`;
  }
  /** The background of the scene on screen; set by render(). */
  let BG = PAPER;
  /** Warns when text lands where TikTok, Reels and Shorts draw their own buttons and captions. */
  function safe(sc, top, bottom, what) {
    if (!PORTRAIT) return;
    if (top < H * 0.065 || bottom > H * 0.86) problem(`scene ${sc.key}: ${what} reaches into the top 6.5% or bottom 14% of the frame, where the platform's buttons and caption sit.`);
  }

  /* ---------------------------------------------------------------- text */
  const mctx = document.createElement("canvas").getContext("2d");
  const measure = (str, weight, size) => { mctx.font = `${weight} ${size}px ${FONT}`; return mctx.measureText(str).width; };
  function layout(str, weight, size, track = 0) {
    const letters = [];
    for (let i = 0; i < str.length; i++) {
      const w = measure(str[i], weight, size);
      letters.push({ ch: str[i], x: measure(str.slice(0, i), weight, size) + track * size * i + w / 2 });
    }
    return { letters, width: measure(str, weight, size) + track * size * (str.length - 1), size, weight };
  }
  /** Largest size up to `max` at which the text fits `room` pixels on one line. */
  function fit(str, weight, max, room, track = -0.02, minSize = MIN_TEXT * U, what = null) {
    const size = Math.min(max, (max * room) / (measure(str, weight, max) + track * max * Math.max(0, str.length - 1)));
    if (what && size < minSize) problem(`${what}: "${str}" only fits at ${Math.round(size / U)}px; split it into two lines or shorten it.`);
    return layout(str, weight, size, track);
  }
  /** Words on up to `maxLines` lines at the largest size (≤ max, ≥ min) that fits `room`. */
  function wrap(str, weight, max, min, room, maxLines, what) {
    const words = String(str).split(/\s+/).filter(Boolean);
    const linesAt = (size) => {
      const lines = []; let cur = "";
      for (const w of words) { const t2 = cur ? cur + " " + w : w; if (!cur || measure(t2, weight, size) <= room) cur = t2; else { lines.push(cur); cur = w; } }
      if (cur) lines.push(cur);
      return lines;
    };
    for (let size = max; size >= min - 0.01; size = Math.max(min, size * 0.94)) {
      const lines = linesAt(size);
      if (lines.length <= maxLines && lines.every((l) => measure(l, weight, size) <= room)) return { size, lines };
      if (size === min) break;
    }
    const lines = linesAt(min);
    if (what) problem(`${what}: "${String(str).slice(0, 48)}…" needs ${lines.length} lines at the smallest readable size (max ${maxLines}); shorten it.`);
    return { size: min, lines };
  }
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  function letter(ch, x, y, size, weight, fill, { dy = 0, rot = 0, sx = 1, sy = 1, op = 1, stroke = null } = {}) {
    if (op <= 0.001 || ch === " ") return "";
    const st = stroke ? ` stroke="${stroke}" stroke-width="${f1(size * 0.12)}" stroke-linejoin="round" paint-order="stroke"` : "";
    return `<g transform="translate(${f1(x)} ${f1(y + dy)}) rotate(${rot.toFixed(2)}) scale(${sx.toFixed(3)} ${sy.toFixed(3)})" opacity="${op.toFixed(3)}"><text text-anchor="middle" font-family='${FONT}' font-weight="${weight}" font-size="${size.toFixed(1)}" fill="${fill}"${st}>${esc(ch)}</text></g>`;
  }
  /** One line whose letters pop in one by one from `t0`; `out` (0..1) throws them away. */
  function popLine(t, L, cx, base, fill, t0, { step = 0.03, dur = 0.34, from = 90, out = 0, spin = 30, seed = 0, stroke = null } = {}) {
    const x0 = cx - L.width / 2;
    let s = "";
    L.letters.forEach((l, j) => {
      const p = prog(t, t0 + j * step, t0 + j * step + dur);
      const b = outBack(p, 2.6);
      s += letter(l.ch, x0 + l.x, base, L.size, L.weight, fill, {
        dy: (1 - b) * from * U + out * 900 * U, sx: b, sy: b, stroke,
        rot: (1 - p) * (hash(j + seed) - 0.5) * spin + out * (hash(j + seed + 9) - 0.5) * 120,
        op: clamp(p * 3) * (1 - out),
      });
    });
    return s;
  }
  function pill(text, x, y, { size = 40, weight = 800, fill = INK, color = null, rot = 0, scale = 1, stroke = null, padX = 1.4, what = null } = {}) {
    if (scale <= 0.001) return "";
    if (!color) { const o = onFill(fill, what); fill = o.fill; color = o.text; }
    const w = measure(text, weight, size) + size * padX, h = size * 1.6;
    const st = stroke ? ` stroke="${stroke}" stroke-width="${f1(size * 0.18)}"` : "";
    return `<g transform="translate(${f1(x)} ${f1(y)}) rotate(${rot.toFixed(2)}) scale(${scale.toFixed(3)})">`
      + `<rect x="${f1(-w / 2)}" y="${f1(-h / 2 + size * 0.2)}" width="${f1(w)}" height="${f1(h)}" rx="${f1(h / 2)}" fill="${INK}" opacity=".14"/>`
      + `<rect x="${f1(-w / 2)}" y="${f1(-h / 2)}" width="${f1(w)}" height="${f1(h)}" rx="${f1(h / 2)}" fill="${fill}"${st}/>`
      + `<text text-anchor="middle" y="${f1(size * 0.35)}" font-family='${FONT}' font-weight="${weight}" font-size="${f1(size)}" fill="${color}">${esc(text)}</text></g>`;
  }

  /* ---------------------------------------------------------------- confetti */
  function burst(t, t0, cx, cy, seed, palette, count = 14, reach = 260, r0 = 0) {
    const u = t - t0;
    if (u < 0 || u > 0.9) return "";
    let s = "";
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU + hash(seed + i) * 0.6;
      const d = r0 + reach * U * (0.6 + hash(seed + i + 50) * 0.6) * outCubic(clamp(u / 0.7));
      const px = cx + Math.cos(a) * d, py = cy + Math.sin(a) * d + 300 * U * u * u;
      const r = (9 + hash(seed + i + 90) * 13) * U * (1 - prog(u, 0.45, 0.9));
      const c = palette[i % palette.length];
      if (r <= 0.3) continue;
      if (i % 3 === 0) s += `<rect x="${f1(px - r * 1.4)}" y="${f1(py - r * 0.5)}" width="${f1(r * 2.8)}" height="${f1(r)}" rx="${f1(r / 2)}" fill="${c}" transform="rotate(${f1(a * 57 + u * 400)} ${f1(px)} ${f1(py)})"/>`;
      else if (i % 5 === 1) s += `<path d="M${f1(px)} ${f1(py - r * 1.3)} L${f1(px + r * 0.4)} ${f1(py - r * 0.4)} L${f1(px + r * 1.3)} ${f1(py)} L${f1(px + r * 0.4)} ${f1(py + r * 0.4)} L${f1(px)} ${f1(py + r * 1.3)} L${f1(px - r * 0.4)} ${f1(py + r * 0.4)} L${f1(px - r * 1.3)} ${f1(py)} L${f1(px - r * 0.4)} ${f1(py - r * 0.4)}Z" fill="${c}"/>`;
      else s += `<circle cx="${f1(px)}" cy="${f1(py)}" r="${f1(r)}" fill="${c}"/>`;
    }
    return s;
  }
  const CONFETTI = Object.values(PALETTE);

  /* ---------------------------------------------------------------- media */
  const mediaInfo = (id, variant) => MEDIA[id]?.[variant] ?? MEDIA[id]?.full ?? MEDIA[id]?.avatar ?? null;
  function frameUrl(id, variant, t) {
    const m = mediaInfo(id, variant);
    if (!m) { problem(`media "${id}" is not declared in story.media`); return null; }
    const n = m.count > 1 ? ((Math.floor(t * m.fps) % m.count) + m.count) % m.count : 0;
    return `${m.dir}/${String(n + 1).padStart(4, "0")}.${m.ext ?? "jpg"}`;
  }

  /* ---------------------------------------------------------------- timeline */
  const DEFAULT_LEN = { pileup: 3, title: 2.4, fan: 3, card: 2.4, chat: 4.2, list: 3.6, grid: 4.2, logo: 3.6 };
  const DEFAULT_VOICE_AT = { card: 0.45, logo: 0.75 };
  const scenes = S.scenes.map((raw, index) => ({ ...raw, index, key: raw.id ?? `s${index + 1}` }));
  let cursor = 0;
  for (const sc of scenes) {
    if (!DEFAULT_LEN[sc.type]) problem(`scene ${sc.key}: unknown type "${sc.type}"`);
    sc.v = sc.voice ? VO[sc.key] : null;
    if (sc.voice && !sc.v) warn(`scene ${sc.key}: voice not generated yet (run the voices step)`);
    sc.voiceAt = sc.voice?.at ?? DEFAULT_VOICE_AT[sc.type] ?? 0.35;
    sc.speech = sc.v ? sc.v.speechEnd - sc.v.speechStart : 0;
    const needed = sc.v ? sc.voiceAt + sc.speech + (sc.pad ?? 0.55) + (sc.type === "logo" ? 1.0 : 0) : 0;
    sc.len = snapUp(Math.max(sc.duration ?? DEFAULT_LEN[sc.type] ?? 2.4, needed));
    sc.start = cursor;
    sc.end = cursor + sc.len;
    cursor = sc.end;
  }
  const DURATION = cursor;
  scenes.forEach((sc, i) => { sc.prev = scenes[i - 1] ?? null; sc.next = scenes[i + 1] ?? null; });

  const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}']/gu, "");
  /**
   * Absolute time of a moment inside a scene. `at` may be seconds from the
   * scene start, or a spoken word: "word", "word#2" (second match),
   * "word:end" (when it finishes). Words match by prefix, ignoring case and accents.
   */
  function when(sc, at, fallback = 0) {
    if (at == null) return sc.start + fallback;
    if (typeof at === "number") return sc.start + at;
    let [w, edge] = String(at).split(":");
    let n = 1;
    if (w.includes("#")) { n = Number(w.split("#")[1]) || 1; w = w.split("#")[0]; }
    if (!sc.v) return sc.start + fallback;
    const hits = sc.v.words.filter((x) => norm(x.w).startsWith(norm(w)));
    const hit = hits[n - 1];
    if (!hit) { problem(`scene ${sc.key}: word "${at}" not found in the voice line`); return sc.start + fallback; }
    return sc.start + sc.voiceAt + (edge === "end" ? hit.end : hit.start) - sc.v.speechStart;
  }
  /** The first scene shows at frame 0 what would appear in its first 0.8 s: frame 0 is the thumbnail. */
  const early = (sc, t0) => (sc.index === 0 && t0 - sc.start < 0.8 ? sc.start - 1.0 : t0);
  const speaking = (sc, t) => sc.v && t >= sc.start + sc.voiceAt && t <= sc.start + sc.voiceAt + sc.speech;

  /* ---------------------------------------------------------------- layout helpers */
  const CX = W / 2;
  /** Where a card scene's media card sits: smaller and higher when a prompt panel goes under it. */
  function cardBox(sc) {
    const withPrompt = sc?.type === "card" && Boolean(sc.prompt);
    const h = PORTRAIT ? H * (withPrompt ? 0.35 : 0.56) : H * 0.62;
    const y = PORTRAIT ? H * (withPrompt ? 0.36 : 0.43) : H * 0.47;
    const x = !PORTRAIT && withPrompt ? W * 0.28 : CX;
    return { x, y, w: h * 0.613, h };
  }
  const TEXT_ROOM = W * 0.89;

  /** Cards in a row share progress dots; returns [index, count] within the run. */
  function cardRun(sc) {
    let a = sc.index, b = sc.index;
    while (scenes[a - 1]?.type === "card") a--;
    while (scenes[b + 1]?.type === "card") b++;
    return [sc.index - a, b - a + 1, a];
  }

  /** Grid seats for a grid scene, so other scenes can fly into or out of them. */
  function gridSeats(sc) {
    const n = sc.members.length;
    const cols = sc.columns ?? (PORTRAIT ? (n <= 4 ? 2 : n <= 9 ? 3 : n <= 16 ? 4 : 5) : Math.min(n, n <= 6 ? n : n <= 12 ? 6 : 8));
    const rows = Math.ceil(n / cols);
    const areaTop = PORTRAIT ? H * 0.3 : H * 0.34, areaH = PORTRAIT ? H * 0.46 : H * 0.5;
    const d = Math.min((W * 0.9) / cols - 24 * U, areaH / rows - 28 * U, 300 * U);
    const gap = d + 24 * U;
    return sc.members.map((m, k) => {
      const row = Math.floor(k / cols), c = k % cols, inRow = Math.min(cols, n - row * cols);
      return { x: CX + (c - (inRow - 1) / 2) * gap, y: areaTop + (areaH - rows * (d + 28 * U)) / 2 + d / 2 + row * (d + 28 * U), d, row, col: c };
    });
  }

  /* ---------------------------------------------------------------- frame state */
  let back = "", front = "", media = [];

  /* ---------------------------------------------------------------- background */
  const sceneBg = (sc) => (!sc || sc.background == null || sc.background === "paper" ? PAPER : sc.tint === false ? col(sc.background) : tint(sc.background));
  function drawBackground(t) {
    const sc = sceneAt(t);
    const prevBg = sceneBg(sc.prev), bg = sceneBg(sc);
    const r = prevBg === bg ? 9999 : inOutCubic(prog(t, sc.start, sc.start + 0.5)) * Math.hypot(W, H);
    BG = bg;
    back = `<rect width="${W}" height="${H}" fill="${prevBg}"/><circle cx="${f1(CX)}" cy="${f1(H * 0.45)}" r="${f1(r)}" fill="${bg}"/>`;
    if (S.style?.decor !== false && sc.type !== "pileup") {
      [[0.14, 0.17, 120, 0], [0.88, 0.27, 170, 1], [0.11, 0.78, 190, 2], [0.89, 0.9, 110, 3], [0.81, 0.61, 70, 4]].forEach(([x, y, r2, k]) => {
        back += `<circle cx="${f1(x * W + Math.sin(t * 1.1 + k) * 30 * U)}" cy="${f1(y * H + Math.cos(t * 1.3 + k * 2) * 26 * U)}" r="${f1(r2 * U)}" fill="#fff" opacity=".28"/>`;
      });
    }
  }
  const sceneAt = (t) => scenes.find((s) => t >= s.start && t < s.end) ?? scenes[scenes.length - 1];

  /* ================================================================ scenes */
  const SCENES = {};

  /* ---- pileup: things pile up and shake, words slam in, then everything clears. */
  SCENES.pileup = {
    render(sc, t) {
      const items = sc.items ?? [];
      const clearAt = sc.end - 0.55;
      const amp = t >= clearAt ? 0 : (2 + 12 * prog(t, sc.start + 0.8, clearAt)) * U;
      const nw = Math.min(W * 0.8, 860 * U), nh = 132 * U;
      items.forEach((n, k) => {
        // The first card is already there at the very first frame (the thumbnail).
        const d = k === 0 ? sc.start - 0.3 : sc.start + 0.12 + (sc.len - 0.9) * Math.pow(k / Math.max(1, items.length - 1), 0.72);
        const fall = prog(t, d, d + 0.26);
        if (fall <= 0) return;
        const slotY = H * 0.88 - k * 62 * U * (PORTRAIT ? 1 : 0.55), slotX = CX + (hash(k + 2) - 0.5) * 150 * U;
        let y = lerp(-150 * U, slotY, inQuad(fall)), x = slotX, rot = (hash(k + 5) - 0.5) * 14 * fall + (1 - fall) * (k % 2 ? 20 : -20);
        const w = wobble(t - d - 0.26, 0.06, 30, 9);
        x += Math.sin(t * 43 + k * 1.7) * amp; y += Math.cos(t * 37 + k) * amp * 0.6; rot += Math.sin(t * 29 + k) * amp * 0.12 / U;
        const away = inQuad(prog(t, clearAt + hash(k) * 0.12, clearAt + 0.5 + hash(k) * 0.12));
        y -= away * H * 1.1; rot += away * (hash(k + 8) - 0.5) * 70; x += away * (hash(k + 3) - 0.5) * 600 * U;
        front += notification(n, x, y, rot, (1 + w) * lerp(1, 0.7, away), 1 - away * 0.7, nw, nh);
      });
      (sc.slams ?? []).forEach((sl, k) => {
        const t0 = when(sc, sl.at, 0.4 + k * 0.5);
        const p = prog(t, t0, t0 + 0.22);
        if (p <= 0) return;
        const spots = [[0.3, 0.17, -7], [0.71, 0.245, 6], [0.4, 0.318, -4], [0.68, 0.39, 5]];
        const [x, y, r] = spots[k % spots.length];
        const away = inBack(prog(t, clearAt + 0.05 * k, clearAt + 0.45 + 0.05 * k));
        const s = lerp(2.2, 1, outBack(p, 2)) * (1 + wobble(t - t0 - 0.22, 0.08)) * (1 - away * 0.3);
        front += `<g opacity="${clamp(p * 4).toFixed(3)}" transform="translate(0 ${f1(-away * H * 0.5)})">${pill(sl.text, x * W + Math.sin(t * 50 + k * 3) * amp * 0.5, y * H, { size: 88 * U, fill: sl.color ? col(sl.color) : INK, rot: r + away * 30, scale: s, what: `scene ${sc.key}: slam "${sl.text}"` })}</g>`;
      });
      if (sc.headline) {
        const t0 = when(sc, sc.headline.at, sc.len * 0.6);
        const L = fit(sc.headline.text, 800, 150 * U, TEXT_ROOM, -0.02, MIN_TITLE * U, `scene ${sc.key}: headline`);
        const out = inBack(prog(t, clearAt, clearAt + 0.25));
        front += popLine(t, L, CX + Math.sin(t * 60) * amp * 0.6, H * 0.43, readable(col(sc.headline.color ?? style.accent), BG, `scene ${sc.key}: headline colour`), t0, { step: 0.03, dur: 0.24, from: -60, out, seed: 5, stroke: "#fff" });
      }
    },
    cues(sc, add) {
      const items = sc.items ?? [];
      items.forEach((_, k) => k > 0 && add(sc.start + 0.12 + (sc.len - 0.9) * Math.pow(k / Math.max(1, items.length - 1), 0.72) + 0.24, "ding", { pitch: 1 + (k % 5) * 0.12, gain: 0.35 + (0.5 * k) / Math.max(1, items.length) }));
      (sc.slams ?? []).forEach((sl, k) => add(when(sc, sl.at, 0.4 + k * 0.5), "slam", { gain: 0.8 }));
      if (sc.headline) add(when(sc, sc.headline.at, sc.len * 0.6), "boing", { pitch: 0.7, gain: 0.7 });
      add(sc.end - 0.55, "whoosh", { dur: 0.8, gain: 0.5 });
    },
  };
  function notification(n, x, y, rot, sc, op, nw, nh) {
    const hw = nw / 2, hh = nh / 2, k = nh / 132;
    const c = onFill(col(n.color ?? "slate"));
    return `<g transform="translate(${f1(x)} ${f1(y)}) rotate(${rot.toFixed(2)}) scale(${sc.toFixed(3)})" opacity="${op.toFixed(3)}">`
      + `<rect x="${f1(-hw)}" y="${f1(-hh + 10 * k)}" width="${f1(nw)}" height="${f1(nh)}" rx="${f1(36 * k)}" fill="${INK}" opacity=".13"/>`
      + `<rect x="${f1(-hw)}" y="${f1(-hh)}" width="${f1(nw)}" height="${f1(nh)}" rx="${f1(36 * k)}" fill="#fff"/>`
      + `<rect x="${f1(-hw + 26 * k)}" y="${f1(-38 * k)}" width="${f1(76 * k)}" height="${f1(76 * k)}" rx="${f1(20 * k)}" fill="${c.fill}"/>`
      + `<text x="${f1(-hw + 64 * k)}" y="${f1(14 * k)}" text-anchor="middle" font-family='${FONT}' font-weight="800" font-size="${f1(40 * k)}" fill="${c.text}">${esc(n.icon ?? (n.title ?? "?")[0])}</text>`
      + `<text x="${f1(-hw + 128 * k)}" y="${f1(-8 * k)}" font-family='${FONT}' font-weight="800" font-size="${f1(36 * k)}" fill="${INK}">${esc(n.title ?? "")}</text>`
      + `<text x="${f1(-hw + 128 * k)}" y="${f1(36 * k)}" font-family='${FONT}' font-weight="500" font-size="${f1(32 * k)}" fill="#5d5c58">${esc(n.body ?? "")}</text>`
      + `<text x="${f1(hw - 30 * k)}" y="${f1(-14 * k)}" text-anchor="end" font-family='${FONT}' font-weight="500" font-size="${f1(26 * k)}" fill="#6b6a66">${esc(n.time ?? labels.now)}</text></g>`;
  }

  /* ---- title lines: shared by the title and fan scenes. */
  function titleLines(sc, t, area) {
    const lines = sc.lines ?? [];
    const out = inBack(prog(t, sc.end - 0.45, sc.end - 0.05));
    const layouts = lines.map((ln) => fit(ln.text, ln.weight ?? 800, (ln.size ?? (ln.big ? 240 : ln.breathe ? 170 : 130)) * U, TEXT_ROOM, -0.03, MIN_TITLE * U, `scene ${sc.key}: title line`));
    const gap = 30 * U;
    const total = layouts.reduce((a, L, k) => (lines[k].breathe ? a : a + L.size * 0.95 + gap), -gap);
    let y = area.center - total / 2;
    lines.forEach((ln, k) => {
      const L = layouts[k];
      if (!ln.breathe) y += L.size * 0.8;
      const t0 = early(sc, when(sc, ln.at, 0.15 + k * 0.4));
      const until = ln.until != null ? when(sc, ln.until, sc.len) - 0.1 : null;
      const lineOut = until != null ? inCubic(prog(t, until, until + 0.4)) : out;
      const ct = ln.color ? colouredText(col(ln.color), BG) : { text: readable(INK, BG), marker: null };
      const fill = ct.text;
      if (ln.breathe) {
        const p = outBack(prog(t, t0, t0 + 0.5), 1.5);
        const s = p * (1 + 0.08 * prog(t, t0, until ?? sc.end));
        if (p > 0 && lineOut < 1) front += `<g transform="translate(${f1(CX)} ${f1((ln.y ?? 0.45) * H - lineOut * 500 * U)}) scale(${s.toFixed(3)})" opacity="${(1 - lineOut).toFixed(3)}"><text text-anchor="middle" font-family='${FONT}' font-weight="${L.weight}" font-size="${L.size.toFixed(1)}" fill="${fill}">${esc(ln.text)}</text></g>`;
      } else {
        const base = ln.y != null ? ln.y * H : y;
        if (ct.marker && lineOut < 1) front += `<g opacity="${clamp(1 - lineOut).toFixed(3)}" transform="translate(0 ${f1(lineOut * 900 * U)})">${marker(CX - L.width / 2, L.width, base, L.size, ct.marker, outCubic(prog(t, t0, t0 + 0.3 + L.letters.length * 0.02)))}</g>`;
        front += popLine(t, L, CX, base, fill, t0, { step: ln.big ? 0.045 : 0.03, dur: ln.big ? 0.3 : 0.34, from: ln.big ? 180 : -110, out: lineOut, seed: 41 + k * 7, spin: ln.big ? 40 : 30 });
        if (ln.confetti) front += burst(t, t0 + 0.15, CX, y - L.size * 0.35, 610 + k, CONFETTI, 18, 380, 150 * U);
      }
      if (!ln.breathe) y += L.size * 0.15 + gap;
    });
    if (sc.badge) {
      const t0 = when(sc, sc.badge.at, 0.8);
      const p = outBack(prog(t, t0, t0 + 0.3), 2.4);
      if (p > 0 && out < 1) front += pill(sc.badge.text, CX, y + 20 * U - out * 400 * U, { size: 50 * U, rot: -3, scale: p * (1 - out), fill: sc.badge.color ? col(sc.badge.color) : INK, what: `scene ${sc.key}: badge` });
    }
  }
  function titleCues(sc, add) {
    (sc.lines ?? []).forEach((ln, k) => {
      const t0 = when(sc, ln.at, 0.15 + k * 0.4);
      if (ln.breathe) add(t0, "breath");
      else if (ln.big) { add(t0 + 0.1, "boing", { pitch: 1.1, gain: 0.6 }); if (ln.confetti) add(t0 + 0.15, "sparkle", { gain: 0.8 }); }
      else add(t0 + 0.05, "pop", { pitch: 1 + k * 0.1, gain: 0.5 });
    });
    if (sc.badge) add(when(sc, sc.badge.at, 0.8), "blip", { pitch: 1.3, gain: 0.6 });
  }

  /* ---- title: big kinetic lines, centred. */
  SCENES.title = {
    render(sc, t) { titleLines(sc, t, { center: H * 0.45 }); },
    cues: titleCues,
  };

  /* ---- fan: media cards fan in like a hand of cards, with title lines above. Always inside the frame. */
  function fanGeom(sc) {
    const n = sc.cards.length;
    const fw = Math.min(PORTRAIT ? H * 0.15 : H * 0.22, (W * 0.9) / (0.62 * n + 0.5));
    const fh = fw * 1.63;
    const R = PORTRAIT ? H * 0.9 : H * 1.3;
    const midY = PORTRAIT ? H * 0.64 : H * 0.66;
    const maxDx = W / 2 - fw * 0.65 - 24 * U;
    const aMax = Math.asin(Math.min(0.95, Math.max(0, maxDx) / R));
    const step = n > 1 ? Math.min((10 * Math.PI) / 180, (2 * aMax) / (n - 1)) : 0;
    return { fw, fh, R, py: midY + R, step, n };
  }
  const fanPose = (sc, i, t) => {
    const g = fanGeom(sc);
    const a = (i - (g.n - 1) / 2) * g.step;
    const t0 = when(sc, sc.cardsAt, 0.6) + i * 0.09;
    const p = outBack(prog(t, t0, t0 + 0.42), 1.6);
    return { x: CX + Math.sin(a) * g.R, y: lerp(H + g.fh, g.py - Math.cos(a) * g.R, p) + Math.sin((t - t0) * 3 + i) * 8 * U, rot: ((a * 180) / Math.PI) * p, p, t0 };
  };
  SCENES.fan = {
    render(sc, t) {
      titleLines(sc, t, { center: PORTRAIT ? H * 0.26 : H * 0.2 });
      const { fw, fh } = fanGeom(sc);
      const next = sc.next?.type === "card" && sc.next.media === sc.cards[0] ? sc.next : null;
      const B = cardBox(next);
      const collapse = prog(t, sc.end - 0.5, sc.end);
      sc.cards.forEach((id, i) => {
        const f = fanPose(sc, i, t);
        if (f.p <= 0) return;
        if (i === 0 && next) {
          const e = inOutCubic(collapse);
          media.push({ id, variant: "full", t: t - sc.start, x: lerp(f.x, B.x, e), y: lerp(f.y, B.y, e) - Math.sin(collapse * Math.PI) * 140 * U, w: lerp(fw, B.w, e), h: lerp(fh, B.h, e), rot: lerp(f.rot, -2.5, e), radius: lerp(26, 46, e) * U, border: lerp(8, 14, e) * U, z: 1 });
        } else {
          const drop = inBack(prog(t, sc.end - 0.5 + i * 0.03, sc.end - 0.1 + i * 0.03), 1.4);
          media.push({ id, variant: "full", t: t - sc.start + i, x: f.x, y: f.y + drop * H * 0.75, w: fw, h: fh, rot: f.rot + drop * (i < sc.cards.length / 2 ? -30 : 30), radius: 26 * U, border: 8 * U });
        }
      });
    },
    cues(sc, add) {
      titleCues(sc, add);
      sc.cards.forEach((_, i) => add(when(sc, sc.cardsAt, 0.6) + i * 0.09 + 0.1, "pop", { pitch: 0.9 + i * 0.1, gain: 0.7 }));
      add(sc.end - 0.5, "whoosh", { dur: 0.55, gain: 0.8 });
    },
  };

  /* ---- card: one media card, name sticker, caption, speech bubble, optional prompt panel. */
  const SIDES = [-1, 1];
  /** Multi-line text, left-aligned from x or centred on x. */
  function textBlock(lines, x, yFirst, size, weight, fill, { anchor = "middle", lh = 1.28, op = 1 } = {}) {
    return lines.map((l, k) => `<text x="${f1(x)}" y="${f1(yFirst + k * size * lh)}" text-anchor="${anchor}" font-family='${FONT}' font-weight="${weight}" font-size="${f1(size)}" fill="${fill}" opacity="${op.toFixed(3)}">${esc(l)}</text>`).join("");
  }
  SCENES.card = {
    render(sc, t) {
      const [ri, rn] = cardRun(sc);
      const u = t - sc.start;
      const side = SIDES[ri % 2];
      const c = col(sc.color);
      const B = cardBox(sc);
      const handedOver = sc.prev?.type === "fan" && sc.prev.cards[0] === sc.media && sc.prev.next === sc;
      // The previous card flies off while this one comes in.
      if (sc.prev?.type === "card" && u < 0.4) {
        const PB = cardBox(sc.prev);
        const p = inBack(prog(u, 0, 0.36), 1.4), ps = SIDES[(ri - 1) % 2] ?? 1;
        media.push({ id: sc.prev.media, variant: "full", t: t - sc.prev.start, x: PB.x - ps * p * W * 1.1, y: PB.y - p * 200 * U, w: PB.w, h: PB.h, rot: ps * -2.5 - ps * p * 35, border: 14 * U });
      }
      // A tiny squash on every spoken word.
      let talk = 0;
      if (sc.v) for (const w of sc.v.words) talk += wobble(u - sc.voiceAt - w.start + sc.v.speechStart, 0.016, 32, 11);
      let x = B.x, y = B.y, rot = -2.5 * side, sx = 1, sy = 1;
      if (handedOver) {
        const w = wobble(u, 0.07, 26, 7) + talk; sx = 1 + w; sy = 1 - w; rot = -2.5;
      } else {
        const enter = prog(u, 0, 0.34), e = outBack(enter, 1.5);
        x = lerp(B.x + side * W * 0.93, B.x, e);
        y = lerp(B.y + 260 * U, B.y, outCubic(enter)) - Math.sin(enter * Math.PI) * 120 * U;
        rot = lerp(side * 28, side * -2.5, e);
        const w = wobble(u - 0.34, 0.07, 26, 7) + talk, zoom = 1 + 0.03 * prog(u, 0.34, sc.len);
        sx = (1 + w) * zoom; sy = (1 - w) * zoom;
      }
      media.push({ id: sc.media, variant: "full", t: u, x, y, w: B.w, h: B.h, rot, sx, sy, border: 14 * U });
      if (!handedOver) front += burst(u, 0.34, B.x, B.y, sc.index * 31, [c, INK, "#fff"], 16, 260, B.h / 2);

      const out = (d = 0) => inBack(prog(u, sc.len - 0.14 + d, sc.len + 0.06 + d));
      const ts = handedOver ? 0.05 : 0.24;
      const bottom = B.y + B.h / 2;
      if (sc.number !== false) {
        const tag = outBack(prog(u, ts, ts + 0.2), 2.4) * (1 - out(0));
        const num = typeof sc.number === "string" ? sc.number : `${labels.number} ${String(ri + 1).padStart(2, "0")}`;
        front += pill(num, B.x - B.w / 2 + 40 * U, B.y - B.h / 2 + 30 * U, { size: 40 * U, rot: -8, scale: tag });
      }
      if (sc.name) {
        const st = outBack(prog(u, ts - 0.06, ts + 0.18), 2.2) * (1 - out(0.02));
        const size = Math.max(MIN_TEXT * U, Math.min(88 * U, (88 * U * B.w * 1.3) / measure(sc.name, 800, 88 * U)));
        front += pill(sc.name, B.x, bottom - 40 * U, { size, fill: c, stroke: "#fff", rot: -3 + (1 - clamp(st)) * 20, scale: st, padX: 1.0, what: `scene ${sc.key}: name sticker` });
      }
      let below = bottom + 58 * U;
      if (sc.caption) {
        const room = PORTRAIT ? TEXT_ROOM : W * 0.44;
        const cap = wrap(sc.caption, 700, (sc.prompt ? 46 : 54) * U, MIN_TEXT * U, room, 2, `scene ${sc.key}: caption`);
        const p = prog(u, ts + 0.1, ts + 0.4) * (1 - out(0.04));
        const fill = readable(INK, BG, `scene ${sc.key}: caption`);
        front += `<g transform="translate(0 ${f1((1 - outCubic(clamp(p))) * 30 * U)})">${textBlock(cap.lines, B.x, below + cap.size, cap.size, 700, fill, { op: clamp(p * 2) })}</g>`;
        below += cap.lines.length * cap.size * 1.28 + 20 * U;
        if (!sc.prompt) safe(sc, below - cap.size * 2, below, "the caption");
      }
      if (sc.prompt) drawPrompt(sc, t, u, B, c, below, out(0.04));
      if (sc.bubble) drawBubble(sc, t, u, B, c, out(-0.04));
      // Progress dots across a run of cards, above the platform's caption zone.
      if (rn > 1 && sc.progress !== false) {
        const run = scenes.slice(sc.index - ri, sc.index - ri + rn);
        const px = CX - ((rn - 1) * 40 * U) / 2;
        let s = "";
        run.forEach((r, k) => {
          const on = k === ri ? outBack(prog(u, 0, 0.3)) : k === ri - 1 ? 1 - prog(u, 0, 0.2) : 0;
          const wdt = (14 + on * 30) * U;
          s += `<rect x="${f1(px + k * 40 * U - wdt / 2)}" y="${f1(PORTRAIT ? H * 0.845 : H * 0.93)}" width="${f1(wdt)}" height="${f1(14 * U)}" rx="${f1(7 * U)}" fill="${k <= ri ? col(r.color) : INK}" opacity="${k <= ri ? 1 : 0.25}"/>`;
        });
        front += s;
      }
    },
    cues(sc, add) {
      const handedOver = sc.prev?.type === "fan" && sc.prev.cards[0] === sc.media;
      if (handedOver) add(sc.start, "thud");
      else {
        add(sc.start - 0.06, "whoosh", { dur: 0.38 });
        add(sc.start + 0.3, "thud");
        // High twinkles mask the first sibilants of a line starting right after: only without a voice.
        if (!sc.v) add(sc.start + 0.34, "sparkle", { gain: 0.3 });
      }
      if (sc.bubble) add(sc.start + (sc.v ? sc.voiceAt : 0.5) - 0.05, "bubble", { gain: 0.5 });
      if (sc.prompt) add(sc.start + promptStart(sc), "typing", { dur: promptTypeTime(sc), gain: 0.5 });
    },
  };
  function drawBubble(sc, t, u, B, c, out) {
    const vu = sc.v ? sc.voiceAt : 0.5;
    const b = outElastic(prog(u, vu - 0.05, vu + 0.55)) * (1 - out);
    if (b <= 0.001) return;
    const meter = sc.v ? 84 * U : 0;
    const wr = wrap(sc.bubble, 700, 46 * U, MIN_TEXT * U, W * 0.74 - meter, 2, `scene ${sc.key}: bubble`);
    const tw = Math.max(...wr.lines.map((l) => measure(l, 700, wr.size)));
    const bw = tw + meter + 72 * U, bh = wr.lines.length * wr.size * 1.28 + 44 * U;
    const by = B.y - B.h / 2 - bh / 2 - 34 * U;
    safe(sc, by - bh / 2, by + bh / 2, "the speech bubble");
    const talking = speaking(sc, t);
    let s = `<g transform="translate(${f1(B.x + 20 * U)} ${f1(by + Math.sin(u * 7) * 5 * U)}) scale(${b.toFixed(3)}) rotate(${((1 - clamp(b)) * -10 + 2).toFixed(2)})">`;
    s += `<rect x="${f1(-bw / 2)}" y="${f1(-bh / 2 + 8 * U)}" width="${f1(bw)}" height="${f1(bh)}" rx="${f1(Math.min(bh / 2, 48 * U))}" fill="${INK}" opacity=".14"/>`;
    s += `<rect x="${f1(-bw / 2)}" y="${f1(-bh / 2)}" width="${f1(bw)}" height="${f1(bh)}" rx="${f1(Math.min(bh / 2, 48 * U))}" fill="#fff"/>`;
    s += `<path d="M${f1(-120 * U)} ${f1(bh / 2 - 4 * U)} L${f1(-150 * U)} ${f1(bh / 2 + 34 * U)} L${f1(-80 * U)} ${f1(bh / 2 - 4 * U)} Z" fill="#fff"/>`;
    if (sc.v) {
      const mc = readable(c, "#ffffff");
      for (let k = 0; k < 4; k++) {
        const lv = talking ? 0.35 + 0.65 * Math.abs(Math.sin(t * (13 + k * 3.1) + k * 1.9)) : 0.3;
        s += `<rect x="${f1(-bw / 2 + 36 * U + k * 16 * U)}" y="${f1((-40 * U * lv) / 2)}" width="${f1(9 * U)}" height="${f1(40 * U * lv)}" rx="${f1(4.5 * U)}" fill="${mc}"/>`;
      }
    }
    const tx = -bw / 2 + 36 * U + meter;
    const y0 = -bh / 2 + 22 * U + wr.size * 0.9;
    s += textBlock(wr.lines, tx, y0, wr.size, 700, INK, { anchor: "start" });
    front += s + "</g>";
  }
  /** When the prompt starts typing, in seconds from the scene start, and how long it types. */
  const promptStart = (sc) => (sc.v ? sc.voiceAt : 0.5);
  const promptTypeTime = (sc) => Math.min(1.2, Math.max(0.4, String(sc.prompt).length / 70));
  function drawPrompt(sc, t, u, B, c, below, out) {
    const x = PORTRAIT ? CX : W * 0.7;
    const pw = PORTRAIT ? Math.min(W * 0.88, 960 * U) : W * 0.5;
    const top = PORTRAIT ? below + 10 * U : H * 0.16;
    const bottomLimit = PORTRAIT ? H * 0.83 : H * 0.84;
    const pad = 36 * U, labelH = 56 * U;
    const maxLines = Math.max(2, Math.floor((bottomLimit - top - pad * 2 - labelH) / (46 * U * 1.3)));
    const wr = wrap(sc.prompt, 600, 46 * U, MIN_TEXT * U, pw - pad * 2, maxLines, `scene ${sc.key}: prompt`);
    const ph = pad * 2 + labelH + wr.lines.length * wr.size * 1.3;
    safe(sc, top, top + ph, "the prompt panel");
    const appear = outBack(prog(u, promptStart(sc) - 0.25, promptStart(sc) + 0.05), 1.6) * (1 - out);
    if (appear <= 0.001) return;
    // Typed fast, so the whole prompt is readable for most of the scene.
    const shown = Math.floor(clamp((u - promptStart(sc)) / promptTypeTime(sc)) * String(sc.prompt).length);
    let left = shown;
    const lines = wr.lines.map((l, k) => { const take = Math.max(0, Math.min(l.length, left)); left -= l.length + (k < wr.lines.length - 1 ? 1 : 0); return l.slice(0, take); });
    const typing = shown < String(sc.prompt).length;
    const label = onFill(c, `scene ${sc.key}: prompt label`);
    let s = `<g transform="translate(${f1(x)} ${f1(top)}) scale(${appear.toFixed(3)})" >`;
    s += `<rect x="${f1(-pw / 2)}" y="${f1(8 * U)}" width="${f1(pw)}" height="${f1(ph)}" rx="${f1(34 * U)}" fill="${INK}" opacity=".14"/>`;
    s += `<rect x="${f1(-pw / 2)}" y="0" width="${f1(pw)}" height="${f1(ph)}" rx="${f1(34 * U)}" fill="#fff"/>`;
    const lw = measure(labels.prompt, 800, 30 * U) + 36 * U;
    s += `<rect x="${f1(-pw / 2 + pad)}" y="${f1(pad - 6 * U)}" width="${f1(lw)}" height="${f1(46 * U)}" rx="${f1(23 * U)}" fill="${label.fill}"/>`;
    s += `<text x="${f1(-pw / 2 + pad + lw / 2)}" y="${f1(pad + 27 * U)}" text-anchor="middle" font-family='${FONT}' font-weight="800" font-size="${f1(30 * U)}" fill="${label.text}">${esc(labels.prompt)}</text>`;
    const y0 = pad + labelH + wr.size * 0.95;
    s += textBlock(lines, -pw / 2 + pad, y0, wr.size, 600, INK, { anchor: "start", lh: 1.3 });
    if (typing && Math.floor(t * 3) % 2 === 0) {
      const li = lines.reduce((acc, l, k) => (l.length || k === 0 ? k : acc), 0);
      const cx2 = -pw / 2 + pad + measure(lines[li], 600, wr.size) + 6 * U;
      s += `<rect x="${f1(cx2)}" y="${f1(y0 + li * wr.size * 1.3 - wr.size * 0.8)}" width="${f1(5 * U)}" height="${f1(wr.size)}" fill="${readable(c, "#ffffff")}"/>`;
    }
    front += s + "</g>";
  }

  /* ---- chat: a chat window where messages appear, with an optional stamp slammed on top. */
  SCENES.chat = {
    render(sc, t) {
      titleLines(sc, t, { center: PORTRAIT ? H * 0.15 : H * 0.13 });
      const out = inBack(prog(t, sc.end - 0.35, sc.end));
      const pw = Math.min(W * 0.88, (PORTRAIT ? 960 : 1300) * U);
      const areaTop = PORTRAIT ? H * 0.27 : H * 0.26, areaBottom = PORTRAIT ? H * 0.82 : H * 0.9;
      const appear = outBack(prog(t, early(sc, sc.start + 0.05), early(sc, sc.start + 0.05) + 0.35), 1.4);
      if (appear <= 0.001) return;
      // The window is as tall as its messages, centred in the space under the title.
      const heights = (sc.messages ?? []).map((m) => { const w2 = wrap(m.text, 600, 46 * U, MIN_TEXT * U, pw * 0.7, 5); return w2.lines.length * w2.size * 1.3 + 40 * U; });
      const ph = Math.min(areaBottom - areaTop, Math.max(H * 0.22, 150 * U + heights.reduce((a2, h2) => a2 + h2 + 26 * U, 0) + (sc.stamp ? 190 * U : 20 * U)));
      const top = (areaTop + areaBottom) / 2 - ph / 2, bottom = top + ph;
      safe(sc, top, bottom, "the chat window");
      let s = `<g transform="translate(${f1(CX)} ${f1(top + ph / 2 + out * H * 0.7)}) scale(${appear.toFixed(3)}) translate(0 ${f1(-ph / 2)})">`;
      s += `<rect x="${f1(-pw / 2)}" y="${f1(10 * U)}" width="${f1(pw)}" height="${f1(ph)}" rx="${f1(40 * U)}" fill="${INK}" opacity=".14"/>`;
      s += `<rect x="${f1(-pw / 2)}" y="0" width="${f1(pw)}" height="${f1(ph)}" rx="${f1(40 * U)}" fill="#fff"/>`;
      const acc = col(sc.color ?? style.accent);
      s += `<circle cx="${f1(-pw / 2 + 60 * U)}" cy="${f1(56 * U)}" r="${f1(20 * U)}" fill="${acc}"/>`;
      s += `<text x="${f1(-pw / 2 + 96 * U)}" y="${f1(70 * U)}" font-family='${FONT}' font-weight="800" font-size="${f1(40 * U)}" fill="${INK}">${esc(sc.name ?? labels.assistant)}</text>`;
      s += `<rect x="${f1(-pw / 2)}" y="${f1(110 * U)}" width="${f1(pw)}" height="${f1(2 * U)}" fill="${INK}" opacity=".12"/>`;
      let cy = 150 * U;
      (sc.messages ?? []).forEach((m, i) => {
        const t0 = when(sc, m.at, 0.5 + i * 0.9);
        const p = outBack(prog(t, t0, t0 + 0.3), 1.8);
        const user = m.from === "user";
        const wr = wrap(m.text, 600, 46 * U, MIN_TEXT * U, pw * 0.7, 5, `scene ${sc.key}: message ${i + 1}`);
        const tw = Math.max(...wr.lines.map((l) => measure(l, 600, wr.size)));
        const bw = tw + 60 * U, bh = wr.lines.length * wr.size * 1.3 + 40 * U;
        if (p > 0) {
          const colors = user ? onFill(acc, `scene ${sc.key}: user message`) : { fill: "#eeede8", text: INK };
          const bx = user ? pw / 2 - 36 * U - bw : -pw / 2 + 36 * U;
          // Answers type out quickly; questions appear whole.
          let lines = wr.lines;
          if (!user) {
            let left = Math.floor(clamp((t - t0) / Math.min(1.2, Math.max(0.35, m.text.length / 80))) * m.text.length);
            lines = wr.lines.map((l, k) => { const take = Math.max(0, Math.min(l.length, left)); left -= l.length + 1; return l.slice(0, take); });
          }
          s += `<g transform="translate(${f1(bx + bw / 2)} ${f1(cy + bh / 2)}) scale(${clamp(p, 0, 1.2).toFixed(3)}) translate(${f1(-bw / 2)} ${f1(-bh / 2)})">`;
          s += `<rect width="${f1(bw)}" height="${f1(bh)}" rx="${f1(Math.min(bh / 2, 34 * U))}" fill="${colors.fill}"/>`;
          s += textBlock(lines, 30 * U, 20 * U + wr.size * 0.95, wr.size, 600, colors.text, { anchor: "start", lh: 1.3 });
          s += "</g>";
        }
        cy += bh + 26 * U;
      });
      if (cy > ph + 1) problem(`scene ${sc.key}: the messages do not fit in the chat window; use fewer or shorter messages.`);
      if (sc.stamp) {
        const t0 = when(sc, sc.stamp.at, sc.len * 0.6);
        const p = prog(t, t0, t0 + 0.2);
        if (p > 0) {
          const sc2 = lerp(2.4, 1, outBack(p, 2)) * (1 + wobble(t - t0 - 0.2, 0.1));
          const scol = readable(col(sc.stamp.color ?? "rose"), "#ffffff", `scene ${sc.key}: stamp`);
          const size = 130 * U, sw = measure(sc.stamp.text, 900, size) + 80 * U;
          // Under the last answer, overlapping only its bottom edge, so the answer stays readable.
          s += `<g transform="translate(${f1(pw * 0.12)} ${f1(cy + size * 0.28)}) rotate(-8) scale(${sc2.toFixed(3)})" opacity="${clamp(p * 3).toFixed(3)}">`;
          s += `<rect x="${f1(-sw / 2)}" y="${f1(-size * 0.72)}" width="${f1(sw)}" height="${f1(size * 1.2)}" rx="${f1(26 * U)}" fill="#fff" fill-opacity=".92" stroke="${scol}" stroke-width="${f1(14 * U)}"/>`;
          s += `<text text-anchor="middle" y="${f1(size * 0.3)}" font-family='${FONT}' font-weight="900" font-size="${f1(size)}" fill="${scol}">${esc(sc.stamp.text)}</text></g>`;
        }
      }
      front += s + "</g>";
    },
    cues(sc, add) {
      titleCues(sc, add);
      add(sc.start + 0.05, "pop", { pitch: 0.8, gain: 0.5 });
      (sc.messages ?? []).forEach((m, i) => {
        const t0 = when(sc, m.at, 0.5 + i * 0.9);
        if (m.from === "user") add(t0, "bubble", { gain: 0.6 });
        else add(t0, "typing", { dur: Math.min(1.2, Math.max(0.35, m.text.length / 80)), gain: 0.45 });
      });
      if (sc.stamp) { const t0 = when(sc, sc.stamp.at, sc.len * 0.6); add(t0, "slam", { gain: 0.9 }); add(t0 + 0.02, "boing", { pitch: 0.6, gain: 0.5 }); }
      add(sc.end - 0.35, "whoosh", { dur: 0.45, gain: 0.5 });
    },
  };

  /* ---- list: a title and items that pop in one by one (explainers, steps, tips). */
  SCENES.list = {
    render(sc, t) {
      const out = inBack(prog(t, sc.end - 0.3, sc.end));
      if (sc.title) front += popLine(t, fit(sc.title, 800, 120 * U, TEXT_ROOM, -0.03, MIN_TITLE * U, `scene ${sc.key}: title`), CX, H * 0.2, readable(sc.titleColor ? col(sc.titleColor) : INK, BG, `scene ${sc.key}: title`), when(sc, sc.titleAt, 0.1), { step: 0.025, from: -110, out, seed: 3 });
      const items = sc.items ?? [];
      const gap = Math.min(PORTRAIT ? H * 0.1 : H * 0.16, (PORTRAIT ? H * 0.52 : H * 0.62) / Math.max(1, items.length));
      const blockH = gap * Math.max(0, items.length - 1) + Math.min(gap * 0.8, 170 * U);
      const top = (PORTRAIT ? H * 0.54 : H * 0.6) - blockH / 2;
      const iw = Math.min(W * 0.88, (PORTRAIT ? 960 : 1400) * U), ih = Math.min(gap * 0.8, 170 * U);
      items.forEach((it, k) => {
        const t0 = when(sc, it.at, 0.5 + k * 0.6);
        const p = outBack(prog(t, t0, t0 + 0.4), 1.8);
        if (p <= 0) return;
        const side = k % 2 ? 1 : -1;
        const x = lerp(CX + side * W, CX, clamp(p, 0, 1.2)), y = top + gap * k + ih / 2 - out * H * 0.6 * (1 + k * 0.1);
        const c = col(it.color ?? sc.color ?? style.accent);
        const icon = onFill(c, `scene ${sc.key}: item ${k + 1} icon`);
        const wr = wrap(it.text, 700, 58 * U, MIN_TEXT * U, iw - ih - 70 * U, 2, `scene ${sc.key}: item ${k + 1}`);
        const rot = (1 - clamp(p)) * side * 12 + (k % 2 ? 1.2 : -1.2);
        if (k === items.length - 1) safe(sc, top, top + gap * k + ih, "the list");
        front += `<g transform="translate(${f1(x)} ${f1(y)}) rotate(${rot.toFixed(2)})">`
          + `<rect x="${f1(-iw / 2)}" y="${f1(-ih / 2 + 10 * U)}" width="${f1(iw)}" height="${f1(ih)}" rx="${f1(ih / 2)}" fill="${INK}" opacity=".12"/>`
          + `<rect x="${f1(-iw / 2)}" y="${f1(-ih / 2)}" width="${f1(iw)}" height="${f1(ih)}" rx="${f1(ih / 2)}" fill="#fff"/>`
          + `<circle cx="${f1(-iw / 2 + ih / 2)}" cy="0" r="${f1(ih * 0.36)}" fill="${icon.fill}"/>`
          + `<text x="${f1(-iw / 2 + ih / 2)}" y="${f1(ih * 0.13)}" text-anchor="middle" font-family='${FONT}' font-weight="800" font-size="${f1(ih * 0.38)}" fill="${icon.text}">${esc(it.icon ?? String(k + 1))}</text>`
          + textBlock(wr.lines, -iw / 2 + ih + 24 * U, wr.size * 0.35 - ((wr.lines.length - 1) * wr.size * 1.15) / 2, wr.size, 700, INK, { anchor: "start", lh: 1.15 }) + `</g>`;
        front += burst(t, t0 + 0.3, x - iw / 2 + ih / 2, y, 300 + k * 13, [c, INK], 8, 120, ih * 0.4);
      });
    },
    cues(sc, add) {
      if (sc.title) add(when(sc, sc.titleAt, 0.1) + 0.05, "pop", { pitch: 1, gain: 0.5 });
      (sc.items ?? []).forEach((it, k) => { const t0 = when(sc, it.at, 0.5 + k * 0.6); add(t0, "whoosh", { dur: 0.3, gain: 0.5 }); add(t0 + 0.28, "pop", { pitch: 0.9 + k * 0.15, gain: 0.7 }); });
      add(sc.end - 0.3, "whoosh", { dur: 0.45, gain: 0.5 });
    },
  };

  /* ---- grid: everyone pops into seats, does the wave; a following logo gathers them. */
  const gridStart = (sc, n) => sc.start + 0.15 + n * Math.min(0.07, 1.6 / Math.max(1, sc.members.length));
  const gridOrder = (sc) => sc.members.map((_, k) => k).sort((a, b) => hash(a + 3) - hash(b + 3));
  SCENES.grid = {
    render(sc, t) {
      const out = inBack(prog(t, sc.end - 0.2, sc.end + 0.1));
      titleLines(sc, t, { center: PORTRAIT ? H * 0.2 : H * 0.17 });
      if (sc.footer) {
        const wr = wrap(sc.footer.text, 700, 60 * U, MIN_TEXT * U, TEXT_ROOM, 2, `scene ${sc.key}: footer`);
        const fy = PORTRAIT ? H * 0.79 : H * 0.88;
        safe(sc, fy - wr.size, fy + wr.lines.length * wr.size * 1.25, "the footer");
        const p = prog(t, when(sc, sc.footer.at, 2.2), when(sc, sc.footer.at, 2.2) + 0.3) * (1 - out);
        front += `<g transform="translate(0 ${f1((1 - outCubic(clamp(p))) * 40 * U)})">${textBlock(wr.lines, CX, fy, wr.size, 700, readable(sc.footer.color ? col(sc.footer.color) : INK, BG, `scene ${sc.key}: footer`), { op: clamp(p * 2), lh: 1.25 })}</g>`;
      }
      drawGridMembers(sc, t);
    },
    cues(sc, add) {
      titleCues(sc, add);
      const scale = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28, 31, 33, 36, 38, 40, 43, 45];
      gridOrder(sc).forEach((k, n) => add(gridStart(sc, n) + 0.05, "marimba", { semis: scale[Math.min(n, scale.length - 1)] }));
      if (sc.footer) add(when(sc, sc.footer.at, 2.2), "pop", { pitch: 1.2, gain: 0.5 });
    },
  };
  function drawGridMembers(sc, t, gather = null) {
    const seats = gridSeats(sc);
    const order = gridOrder(sc);
    const allIn = gridStart(sc, sc.members.length) + 0.3;
    const fromCard = sc.prev?.type === "card" ? sc.members.findIndex((m) => m.media === sc.prev.media) : -1;
    sc.members.forEach((m, k) => {
      const seat = seats[k];
      let pop, start;
      if (k === fromCard) {
        // The previous card shrinks into its own seat.
        const go = prog(t, sc.start, sc.start + 0.5), e = inOutCubic(go);
        if (go < 1) {
          const PB = cardBox(sc.prev);
          media.push({ id: m.media, variant: go > 0.55 ? "avatar" : "full", t: t - sc.start, x: lerp(PB.x, seat.x, e), y: lerp(PB.y, seat.y, e) - Math.sin(go * Math.PI) * 180 * U, w: lerp(PB.w, seat.d, e), h: lerp(PB.h, seat.d, e), radius: lerp(46 * U, seat.d / 2, e), rot: lerp(-2.5, 0, e), border: go < 0.7 ? 14 * U : 0, ring: go >= 0.7 ? col(m.color) : null, ringW: 10 * U });
          return;
        }
        start = sc.start + 0.5; pop = 1;
      } else {
        start = gridStart(sc, order.indexOf(k));
        pop = outBack(prog(t, start, start + 0.3), 2.4);
      }
      if (pop <= 0) return;
      const waveT = t - allIn;
      const hop = waveT > 0 && !gather ? Math.max(0, Math.sin(waveT * 5.2 - seat.col * 0.6 - seat.row * 0.9)) * 30 * U : 0;
      const w = wobble(t - start - 0.3, 0.14);
      let x = seat.x, y = seat.y - hop, d = seat.d * clamp(pop, 0, 1.3), ring = col(m.color), ink = 0, rot = 0;
      if (gather) {
        const f0 = gather.start + (k % 6) * 0.03 + Math.floor(k / 6) * 0.02;
        const fly = prog(t, f0, f0 + 0.45), e = inOutCubic(fly);
        x = lerp(seat.x, gather.x, e); y = lerp(seat.y, gather.y, e) - Math.sin(fly * Math.PI) * (160 + hash(k) * 120) * U;
        d = lerp(seat.d, gather.d, e); ring = mix(col(m.color), gather.color, prog(fly, 0.2, 0.8)); ink = prog(fly, 0.45, 0.9) * gather.inkAmount;
        rot = Math.sin(fly * Math.PI) * 30 * (k % 2 ? 1 : -1);
        if (fly >= 1) return;
      }
      media.push({ id: m.media, variant: "avatar", t: t - sc.start + k * 0.37, x, y, w: d, h: d, circle: true, ring, ringW: 10 * U, sx: 1 + w, sy: 1 - w, rot, ink, inkColor: gather?.color });
    });
  }

  /* ---- logo: a mark (monogram or image) with name, tagline and URL. */
  SCENES.logo = {
    render(sc, t) {
      const u = t - sc.start;
      const settle = sc.start + (sc.prev?.type === "grid" ? 0.6 : 0.15);
      const markY = PORTRAIT ? H * 0.385 : H * 0.34, size = (sc.markSize ?? 300) * U;
      const mc = col(sc.color ?? style.accent);
      if (sc.prev?.type === "grid" && u < 0.7) {
        drawGridMembers(sc.prev, t, { start: sc.start, x: CX, y: markY, d: size * 0.3, color: mc, inkAmount: 0.6 });
      }
      if (t >= settle) {
        front += burst(t, settle, CX, markY, 900, CONFETTI, 26, 460, size * 0.4);
        const w = wobble(t - settle, 0.2, 26, 7), p = outBack(prog(t, settle, settle + 0.3), 2);
        if (sc.image) media.push({ id: sc.image, variant: "full", t: 0, x: CX, y: markY - size / 2 * (1 - w) + size / 2, w: size * p, h: size * p, sx: 1 + w, sy: 1 - w, contain: true, plain: true });
        else {
          const mono = sc.monogram ?? (sc.name ?? "?")[0];
          const mk = onFill(mc, `scene ${sc.key}: monogram`);
          front += `<g transform="translate(${f1(CX)} ${f1(markY + size / 2)}) scale(${((1 + w) * p).toFixed(3)} ${((1 - w) * p).toFixed(3)}) translate(0 ${f1(-size / 2)})"><rect x="${f1(-size / 2)}" y="${f1(-size / 2 + 14 * U)}" width="${f1(size)}" height="${f1(size)}" rx="${f1(size * 0.3)}" fill="${INK}" opacity=".15"/><rect x="${f1(-size / 2)}" y="${f1(-size / 2)}" width="${f1(size)}" height="${f1(size)}" rx="${f1(size * 0.3)}" fill="${mk.fill}"/><text text-anchor="middle" y="${f1(size * 0.2)}" font-family='${FONT}' font-weight="800" font-size="${f1(size * 0.56)}" fill="${mk.text}">${esc(mono)}</text></g>`;
        }
      }
      const nameY = markY + size / 2 + (PORTRAIT ? 200 : 150) * U;
      if (sc.name) front += popLine(t, fit(sc.name, 800, 190 * U, TEXT_ROOM, -0.035, MIN_TITLE * U, `scene ${sc.key}: name`), CX, nameY, readable(INK, BG), Math.max(settle - 0.02, when(sc, sc.nameAt, 0)), { step: 0.045, dur: 0.34, from: 130, spin: 20, seed: 31 });
      let y = nameY + 110 * U;
      (sc.tagline ?? []).forEach((part, k) => {
        // Parts share one line, each popping on its own word.
        const whole = sc.tagline.map((p2) => p2.text).join(" ");
        const L = fit(whole, 700, 64 * U, TEXT_ROOM, -0.01, MIN_TEXT * U, `scene ${sc.key}: tagline`);
        const offset = sc.tagline.slice(0, k).reduce((a, p2) => a + p2.text.length + 1, 0);
        const sub = { ...L, letters: L.letters.slice(offset, offset + part.text.length) };
        const ct = part.color ? colouredText(col(part.color), BG) : { text: readable(INK, BG), marker: null };
        if (ct.marker && sub.letters.length) {
          const x0 = CX - L.width / 2 + sub.letters[0].x - measure(part.text[0], 700, L.size) / 2;
          const t0 = when(sc, part.at, 0.4 + k * 0.5) - 0.05;
          front += marker(x0, measure(part.text, 700, L.size), y, L.size, ct.marker, outCubic(prog(t, t0, t0 + 0.35)));
        }
        front += popLine(t, { ...sub, width: L.width }, CX, y, ct.text, when(sc, part.at, 0.4 + k * 0.5) - 0.05, { step: 0.016, dur: 0.28, from: 50, spin: 8, seed: 37 + k });
      });
      if (sc.url) {
        const p = outCubic(prog(t, when(sc, sc.urlAt, sc.len - 1.2), when(sc, sc.urlAt, sc.len - 1.2) + 0.3));
        safe(sc, y + 40 * U, y + 90 * U, "the URL");
        front += `<text x="${f1(CX)}" y="${f1(y + 80 * U)}" text-anchor="middle" font-family='${FONT}' font-weight="600" font-size="${f1(44 * U)}" fill="${readable(mix(INK, BG, 0.3), BG)}" opacity="${p.toFixed(3)}">${esc(sc.url)}</text>`;
      }
    },
    cues(sc, add) {
      const gathered = sc.prev?.type === "grid";
      if (gathered) {
        add(sc.start - 0.6, "drumroll", { dur: 0.58, gain: 0.8 });
        add(sc.start, "slide", { from: 300, to: 1300, dur: 0.55 });
        add(sc.start + 0.05, "whoosh", { dur: 0.5 });
      }
      const settle = sc.start + (gathered ? 0.6 : 0.15);
      add(settle, "tada");
      add(settle + 0.02, "sparkle", { gain: 0.9 });
      if (sc.name) [...sc.name].forEach((_, j) => add(Math.max(settle, when(sc, sc.nameAt, 0)) + j * 0.045 + 0.1, "tick", { pitch: 1.1 + j * 0.05, gain: 0.4 }));
    },
  };

  /* ================================================================ render */
  const backEl = document.getElementById("back"), frontEl = document.getElementById("front");
  const canvas = document.getElementById("media");
  canvas.width = W; canvas.height = H;
  for (const el of [backEl, frontEl]) el.setAttribute("viewBox", `0 0 ${W} ${H}`);
  document.getElementById("frame").style.aspectRatio = `${W} / ${H}`;
  const ctx = canvas.getContext("2d");

  const images = new Map();
  function getImage(url) {
    let e = images.get(url);
    if (!e) {
      const img = new Image();
      img.src = url;
      e = { img, ready: img.decode().then(() => true, () => false) };
      images.set(url, e);
      if (images.size > 400) images.delete(images.keys().next().value);
    }
    return e;
  }
  function drawOp(op, img) {
    const { x, y, w, h, rot = 0, sx = 1, sy = 1 } = op;
    if (w < 1 || h < 1) return;
    ctx.save();
    ctx.translate(x, y + h / 2);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.scale(sx, sy);
    ctx.translate(0, -h / 2);
    const radius = op.circle ? w / 2 : op.radius ?? 46 * U;
    if (op.plain && img) {
      const k = Math.min(w / img.naturalWidth, h / img.naturalHeight);
      ctx.drawImage(img, (-img.naturalWidth * k) / 2, (-img.naturalHeight * k) / 2, img.naturalWidth * k, img.naturalHeight * k);
      ctx.restore();
      return;
    }
    if (op.border) {
      ctx.save();
      ctx.shadowColor = "rgba(28,28,27,0.28)"; ctx.shadowBlur = 50 * U; ctx.shadowOffsetY = 24 * U;
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.roundRect(-w / 2 - op.border, -h / 2 - op.border, w + op.border * 2, h + op.border * 2, radius + op.border); ctx.fill();
      ctx.restore();
    }
    if (op.ring) {
      ctx.save();
      ctx.shadowColor = "rgba(28,28,27,0.22)"; ctx.shadowBlur = 24 * U; ctx.shadowOffsetY = 10 * U;
      ctx.fillStyle = op.ring;
      ctx.beginPath();
      if (op.circle) ctx.arc(0, 0, w / 2 + op.ringW, 0, TAU); else ctx.roundRect(-w / 2 - op.ringW, -h / 2 - op.ringW, w + op.ringW * 2, h + op.ringW * 2, radius + op.ringW);
      ctx.fill();
      ctx.restore();
    }
    ctx.beginPath();
    if (op.circle) ctx.arc(0, 0, w / 2, 0, TAU); else ctx.roundRect(-w / 2, -h / 2, w, h, radius);
    ctx.clip();
    if (img) {
      const k = Math.max(w / img.naturalWidth, h / img.naturalHeight);
      const dw = img.naturalWidth * k, dh = img.naturalHeight * k;
      ctx.drawImage(img, -dw / 2, -h / 2 - (dh - h) * 0.42, dw, dh);
    } else { ctx.fillStyle = "#d9d7d0"; ctx.fillRect(-w / 2, -h / 2, w, h); }
    if (op.ink > 0) { ctx.globalAlpha = op.ink; ctx.fillStyle = op.inkColor ?? INK; ctx.fillRect(-w / 2, -h / 2, w, h); }
    ctx.restore();
  }

  const lastGood = new Map();
  async function render(t, wait) {
    t = clamp(t, 0, DURATION - 1e-6);
    back = ""; front = ""; media = [];
    drawBackground(t);
    // The scene on screen, plus its neighbours for overlapping hand-offs.
    const cur = sceneAt(t);
    SCENES[cur.type]?.render(cur, t);
    media.sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
    const ops = media.map((op) => { const url = frameUrl(op.id, op.variant, op.t); return { op, url, e: url ? getImage(url) : null }; });
    if (wait) await Promise.all(ops.map((o) => o.e?.ready));
    backEl.innerHTML = back;
    frontEl.innerHTML = front;
    ctx.clearRect(0, 0, W, H);
    for (const { op, e } of ops) {
      const img = e && e.img.complete && e.img.naturalWidth ? e.img : lastGood.get(op.id + op.variant);
      if (img) lastGood.set(op.id + op.variant, img);
      drawOp(op, img);
    }
  }

  /* ================================================================ cues + music plan */
  function buildCues() {
    const c = [];
    const add = (t, kind, extra = {}) => { if (t >= 0 && t < DURATION) c.push({ t: +t.toFixed(3), kind, ...extra }); };
    for (const sc of scenes) {
      if (sc.v) add(sc.start + sc.voiceAt - sc.v.speechStart, "voice", { key: sc.key, end: +(sc.start + sc.voiceAt + sc.speech).toFixed(3) });
      if (S.autoSfx !== false && sc.autoSfx !== false) SCENES[sc.type]?.cues(sc, add);
      // Sounds placed by hand: a library effect ("kind") or your own file ("file").
      for (const snd of sc.sounds ?? []) {
        const { at, ...rest } = snd;
        add(when(sc, at, 0), snd.file ? "file" : snd.kind ?? "pop", { ...rest, custom: true });
      }
    }
    return c.sort((a, b) => a.t - b.t);
  }
  const DEFAULT_MOOD = { pileup: "tension", title: "calm", fan: "calm", card: "groove", chat: "calm", list: "groove", grid: "run", logo: "outro" };
  function buildMeta() {
    return {
      duration: DURATION, beat: BEAT, bpm: 60 / BEAT, width: W, height: H,
      music: { enabled: S.music?.enabled !== false, style: S.music?.style ?? "playful", file: S.music?.file ?? null, key: S.music?.key ?? "C", volume: S.music?.volume ?? 0.55, sfx: S.music?.sfx !== false, progression: S.music?.progression ?? ["C", "Am", "F", "G"] },
      scenes: scenes.map((sc) => ({ key: sc.key, type: sc.type, start: sc.start, len: sc.len, mood: sc.mood ?? DEFAULT_MOOD[sc.type] ?? "groove" })),
    };
  }

  /* ================================================================ playback */
  const capture = new URLSearchParams(location.search).has("capture");
  if (capture) document.body.classList.add("capture");
  const playBtn = document.getElementById("play"), scrub = document.getElementById("scrub"), clock = document.getElementById("clock"), sound = document.getElementById("sound");
  let playing = false, clockStart = 0, current = 0;
  function show(t) { current = t; render(t, false); scrub.value = t; clock.textContent = `${t.toFixed(2)}s`; }
  function tick(now) {
    if (playing) {
      const t = (now - clockStart) / 1000;
      if (t >= DURATION) { playing = false; playBtn.textContent = "Replay"; show(DURATION); sound.pause(); } else show(t);
    }
    requestAnimationFrame(tick);
  }
  playBtn?.addEventListener("click", () => {
    playing = !playing;
    playBtn.textContent = playing ? "Pause" : "Play";
    if (playing) { if (current >= DURATION) current = 0; clockStart = performance.now() - current * 1000; sound.currentTime = current; sound.play().catch(() => {}); } else sound.pause();
  });
  scrub?.addEventListener("input", () => { playing = false; playBtn.textContent = "Play"; sound.pause(); show(parseFloat(scrub.value)); });

  window.seek = (t) => render(t, true);
  const weights = style.fontWeights ?? [500, 600, 700, 800];
  Promise.all(weights.map((w) => document.fonts.load(`${w} 100px ${FONT}`))).catch(() => {}).then(() => document.fonts.ready).then(async () => {
    // A dry pass over every scene, so notes and problems cover the whole video, not just frame 0.
    for (const sc of scenes) {
      for (const f of [0.15, 0.4, 0.7, 0.95]) {
        const tt = sc.start + sc.len * f;
        back = ""; front = ""; media = [];
        drawBackground(tt);
        SCENES[sc.type]?.render(sc, tt);
        for (const op of media) frameUrl(op.id, op.variant, op.t);
      }
    }
    window.cues = buildCues();
    window.meta = buildMeta();
    window.timeline = scenes.map((s) => ({ key: s.key, type: s.type, start: +s.start.toFixed(2), len: +s.len.toFixed(2), voice: s.v ? +s.speech.toFixed(2) : null }));
    window.warnings = warnings;
    window.problems = problems;
    scrub.max = DURATION;
    await render(0, true);
    window.ready = true;
    if (!capture) requestAnimationFrame(tick);
  });
})();

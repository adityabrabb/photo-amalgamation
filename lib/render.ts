// Renderer: draws a Plan at any pixel size, straight from the full-resolution source bitmaps.
// No grain, noise or dithering anywhere. Shard edges are anti-aliased but hard (clip paths);
// only Dreamscape layers carry a feather.
import { applyMat, mulMat, placeMatrix, shapeBox, shapeOutline, traceShape, type Mat } from "./geometry";
import { gradientLut, parseHex } from "./palette";
import type { Layer, Plan } from "./planner";
import { warpPass } from "./warp";

export type RenderOpts = {
  /** Assembly animation progress, 0..1. 1 = finished piece. */
  t?: number;
  stamp?: boolean;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function easeOutBack(x: number) {
  const c1 = 1.4, c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

function rgba(hexColor: string, a: number) {
  const [r, g, b] = parseHex(hexColor);
  return `rgba(${r},${g},${b},${a})`;
}

type Ctx = CanvasRenderingContext2D;

const scratch = new Map<string, HTMLCanvasElement>();
function scratchCanvas(key: string, w: number, h: number): HTMLCanvasElement {
  let c = scratch.get(key);
  if (!c) {
    c = document.createElement("canvas");
    scratch.set(key, c);
  }
  if (c.width < w || c.height < h) {
    c.width = Math.max(c.width, w);
    c.height = Math.max(c.height, h);
  }
  return c;
}

/** Layer placement at animation time t; null if the layer hasn't entered yet. */
function animated(l: Layer, t: number) {
  if (t >= 1) return { pos: l.pos, rot: l.rot, scale: l.scale, alpha: 1 };
  const p = clamp((t - l.enter.delay) / 0.32, 0, 1);
  if (p <= 0) return null;
  const e = easeOutBack(p);
  return {
    pos: [l.pos[0] + l.enter.dx * (1 - e), l.pos[1] + l.enter.dy * (1 - e)] as [number, number],
    rot: l.rot + l.enter.rot * (1 - e),
    scale: l.scale * lerp(l.enter.scale, 1, e),
    alpha: Math.min(1, p * 3),
  };
}

/** Paint a layer's content (image region or flat fill) in design coordinates under the current transform. */
function paintContent(ctx: Ctx, plan: Plan, l: Layer, sources: ImageBitmap[], devPerDesign: number, pad: number) {
  const b = shapeBox(l.shape);
  if (l.src < 0) {
    if (l.fill === "gold") {
      const g = ctx.createLinearGradient(b.x, b.y, b.x + b.w, b.y + b.h);
      ["#8a6a1f", "#f7dc8a", "#b8862b", "#fff1c1", "#9a7424"].forEach((c, i) => g.addColorStop(i / 4, c));
      ctx.fillStyle = g;
    } else ctx.fillStyle = l.fill ?? "#000";
    ctx.fillRect(b.x - pad, b.y - pad, b.w + 2 * pad, b.h + 2 * pad);
    return;
  }
  const bmp = sources[l.src];
  const fit = plan.fits[l.src];
  let sx = (b.x - pad - fit.x) / fit.s, sy = (b.y - pad - fit.y) / fit.s;
  let sw = (b.w + 2 * pad) / fit.s, sh = (b.h + 2 * pad) / fit.s;
  if (sx < 0) { sw += sx; sx = 0; }
  if (sy < 0) { sh += sy; sy = 0; }
  sw = Math.min(sw, bmp.width - sx);
  sh = Math.min(sh, bmp.height - sy);
  if (sw <= 0 || sh <= 0) return;
  // "high" smoothing only when downscaling.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = devPerDesign * fit.s < 1 ? "high" : "low";
  ctx.drawImage(bmp, sx, sy, sw, sh, fit.x + sx * fit.s, fit.y + sy * fit.s, sw * fit.s, sh * fit.s);
}

function drawLayer(ctx: Ctx, plan: Plan, l: Layer, sources: ImageBitmap[], S: number, t: number, lut?: Uint8ClampedArray) {
  const a = animated(l, t);
  if (!a) return;
  const m = mulMat([S, 0, 0, S, 0, 0], placeMatrix(a.pos, a.rot, a.scale, l.flip, l.home));
  const path = new Path2D();
  traceShape(path, l.shape);
  const alpha = l.alpha * a.alpha;
  const devPerDesign = S * a.scale;

  if (l.feather > 0 || lut) {
    drawBuffered(ctx, plan, l, sources, m, path, devPerDesign, alpha, lut);
    return;
  }

  ctx.save();
  ctx.setTransform(...m);
  ctx.globalCompositeOperation = l.blend;
  ctx.globalAlpha = alpha;
  ctx.clip(path);
  paintContent(ctx, plan, l, sources, devPerDesign, 0);
  if (l.tint) {
    ctx.globalCompositeOperation = "soft-light";
    ctx.globalAlpha = l.tint.alpha * alpha;
    ctx.fillStyle = l.tint.color;
    ctx.fill(path);
  }
  ctx.restore();
}

/** Feathered (Dreamscape) or duotoned (Brutal accent) layers go through an offscreen buffer. */
function drawBuffered(ctx: Ctx, plan: Plan, l: Layer, sources: ImageBitmap[], m: Mat, path: Path2D, devPerDesign: number, alpha: number, lut?: Uint8ClampedArray) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const featherPx = l.feather * devPerDesign;
  const outline = applyMat(m, shapeOutline(l.shape, 48));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < outline.length; i += 2) {
    x0 = Math.min(x0, outline[i]); x1 = Math.max(x1, outline[i]);
    y0 = Math.min(y0, outline[i + 1]); y1 = Math.max(y1, outline[i + 1]);
  }
  const grow = featherPx * 2 + 2;
  const bx = Math.max(0, Math.floor(x0 - grow)), by = Math.max(0, Math.floor(y0 - grow));
  const bw = Math.min(W, Math.ceil(x1 + grow)) - bx, bh = Math.min(H, Math.ceil(y1 + grow)) - by;
  if (bw <= 0 || bh <= 0) return;

  const buf = scratchCanvas("layer", bw, bh);
  const b = buf.getContext("2d")!;
  b.save();
  b.setTransform(1, 0, 0, 1, 0, 0);
  b.clearRect(0, 0, bw, bh);
  b.setTransform(m[0], m[1], m[2], m[3], m[4] - bx, m[5] - by);
  if (featherPx > 0) {
    paintContent(b, plan, l, sources, devPerDesign, l.feather * 2);
    if (l.tint) {
      b.globalCompositeOperation = "soft-light";
      b.globalAlpha = l.tint.alpha;
      b.fillStyle = l.tint.color;
      b.fill(path);
    }
    // Feathered alpha mask via an offset shadow (shadow blur is the only feather source, and only here).
    const mask = scratchCanvas("mask", bw, bh);
    const mc = mask.getContext("2d")!;
    const OFF = bw + featherPx * 4 + 16;
    mc.save();
    mc.setTransform(1, 0, 0, 1, 0, 0);
    mc.clearRect(0, 0, bw, bh);
    mc.setTransform(m[0], m[1], m[2], m[3], m[4] - bx - OFF, m[5] - by);
    mc.shadowColor = "#000";
    mc.shadowBlur = featherPx;
    mc.shadowOffsetX = OFF;
    mc.fillStyle = "#000";
    mc.fill(path);
    mc.restore();
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.globalAlpha = 1;
    b.globalCompositeOperation = "destination-in";
    b.drawImage(mask, 0, 0, bw, bh, 0, 0, bw, bh);
  } else {
    b.clip(path);
    paintContent(b, plan, l, sources, devPerDesign, 0);
  }
  b.restore();

  if (lut) {
    const img = b.getImageData(0, 0, bw, bh);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      const L = (d[i] * 54 + d[i + 1] * 183 + d[i + 2] * 19) >> 8;
      d[i] = lut[L * 3]; d[i + 1] = lut[L * 3 + 1]; d[i + 2] = lut[L * 3 + 2];
    }
    b.putImageData(img, 0, 0);
  }

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = l.blend;
  ctx.globalAlpha = alpha;
  ctx.drawImage(buf, 0, 0, bw, bh, bx, by, bw, bh);
  ctx.restore();
}

function drawBackground(ctx: Ctx, plan: Plan, W: number, H: number) {
  const { stops, angle } = plan.background;
  const len = Math.hypot(W, H) / 2, c = Math.cos(angle) * len, s = Math.sin(angle) * len;
  const g = ctx.createLinearGradient(W / 2 - c, H / 2 - s, W / 2 + c, H / 2 + s);
  stops.forEach((col, i) => g.addColorStop(i / Math.max(1, stops.length - 1), col));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

/** Process the canvas in row bands to keep memory bounded on big exports. */
function forEachBand(ctx: Ctx, W: number, H: number, fn: (d: Uint8ClampedArray, y0: number, rows: number) => void) {
  const band = Math.max(1, Math.floor(3_000_000 / W));
  for (let y = 0; y < H; y += band) {
    const rows = Math.min(band, H - y);
    const img = ctx.getImageData(0, y, W, rows);
    fn(img.data, y, rows);
    ctx.putImageData(img, 0, y);
  }
}

const lutCache = new Map<string, Uint8ClampedArray>();
function lutFor(stops: string[], contrast: number) {
  const key = stops.join() + contrast;
  let lut = lutCache.get(key);
  if (!lut) {
    lut = gradientLut(stops.map(parseHex), contrast);
    lutCache.set(key, lut);
  }
  return lut;
}

function gradientMapPass(ctx: Ctx, W: number, H: number, gm: NonNullable<Plan["gradientMap"]>) {
  const lut = lutFor(gm.stops, gm.contrast);
  const k = gm.amount;
  forEachBand(ctx, W, H, (d) => {
    for (let i = 0; i < d.length; i += 4) {
      const L = (d[i] * 54 + d[i + 1] * 183 + d[i + 2] * 19) >> 8;
      d[i] += (lut[L * 3] - d[i]) * k;
      d[i + 1] += (lut[L * 3 + 1] - d[i + 1]) * k;
      d[i + 2] += (lut[L * 3 + 2] - d[i + 2]) * k;
    }
  });
}

function glitchPass(ctx: Ctx, W: number, H: number, S: number, g: NonNullable<Plan["glitch"]>) {
  // Scan-line tears: horizontal slices shifted with wrap-around.
  const tmp = scratchCanvas("tear", W, Math.ceil(40 * S) + 2);
  const tc = tmp.getContext("2d")!;
  for (const tear of g.tears) {
    const y = Math.round(tear.y * S), dx = Math.round(tear.dx * S);
    const h = Math.min(Math.max(1, Math.round(tear.h * S)), H - y, tmp.height);
    if (h <= 0 || !dx) continue;
    tc.clearRect(0, 0, W, h);
    tc.drawImage(ctx.canvas, 0, y, W, h, 0, 0, W, h);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.drawImage(tmp, 0, 0, W, h, dx, y, W, h);
    ctx.drawImage(tmp, 0, 0, W, h, dx - Math.sign(dx) * W, y, W, h);
    ctx.restore();
  }

  const shift = Math.max(1, Math.round(g.rgb * S));
  const sorts = g.sorts.map((s) => ({ y0: Math.round(s.y * S), y1: Math.round((s.y + s.h) * S), lo: s.lo, hi: s.hi, reverse: s.reverse }));
  const row = new Uint8ClampedArray(W * 4);
  forEachBand(ctx, W, H, (d, y0, rows) => {
    for (let r = 0; r < rows; r++) {
      const off = r * W * 4;
      // RGB split: red pulled from the right, blue from the left.
      row.set(d.subarray(off, off + W * 4));
      for (let x = 0; x < W; x++) {
        const i = off + x * 4;
        d[i] = row[Math.min(W - 1, x + shift) * 4];
        d[i + 2] = row[Math.max(0, x - shift) * 4 + 2];
      }
      const y = y0 + r;
      for (const s of sorts) if (y >= s.y0 && y < s.y1) sortRow(d, off, W, s.lo, s.hi, s.reverse);
    }
  });
}

/** Pixel sorting: runs of pixels within a luminance window get sorted by luminance. */
function sortRow(d: Uint8ClampedArray, off: number, W: number, lo: number, hi: number, reverse: boolean) {
  const lum = (x: number) => {
    const i = off + x * 4;
    return (d[i] * 54 + d[i + 1] * 183 + d[i + 2] * 19) >> 8;
  };
  let x = 0;
  while (x < W) {
    while (x < W && (lum(x) < lo || lum(x) > hi)) x++;
    const s = x;
    while (x < W && lum(x) >= lo && lum(x) <= hi) x++;
    const len = x - s;
    if (len < 2) continue;
    const keys = new Float64Array(len);
    for (let k = 0; k < len; k++) {
      const i = off + (s + k) * 4;
      keys[k] = lum(s + k) * 16777216 + (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16));
    }
    keys.sort();
    if (reverse) keys.reverse();
    for (let k = 0; k < len; k++) {
      const rgb = keys[k] % 16777216;
      const i = off + (s + k) * 4;
      d[i] = rgb & 255; d[i + 1] = (rgb >> 8) & 255; d[i + 2] = (rgb >> 16) & 255;
    }
  }
}

const risoCache = new WeakMap<Plan, { w: number; h: number; cov: Float32Array[] }>();

/** Ink separation of the composite at a fixed design resolution (so dots match across export sizes). */
function risoCoverage(plan: Plan, sources: ImageBitmap[], t: number) {
  const cached = t >= 1 ? risoCache.get(plan) : undefined;
  if (cached) return cached;
  const riso = plan.riso!;
  const k = 0.3;
  const w = Math.round(plan.w * k), h = Math.round(plan.h * k);
  const c = scratchCanvas("riso", w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  // Neutral mid-light ground: open areas print as a light tint rather than bare paper.
  ctx.fillStyle = "#a8a39b";
  ctx.fillRect(0, 0, w, h);
  for (const l of plan.layers) if (!l.accent) drawLayer(ctx, plan, l, sources, k, t);
  ctx.restore();
  const d = ctx.getImageData(0, 0, w, h).data;

  const paper = parseHex(riso.paper);
  const inks = riso.inks.map((i) => parseHex(i).map((v, ch) => Math.max(0.02, 1 - v / paper[ch])));
  const n = inks.length;
  const cov = inks.map(() => new Float32Array(w * h));
  // Gram matrix for projected-gradient NNLS.
  let L = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) L += Math.abs(inks[i][0] * inks[j][0] + inks[i][1] * inks[j][1] + inks[i][2] * inks[j][2]);
  const step = 1 / Math.max(1e-3, L);
  const c2 = new Float32Array(n);
  for (let p = 0; p < w * h; p++) {
    const D = [0, 1, 2].map((ch) => clamp(1 - d[p * 4 + ch] / paper[ch], 0, 1));
    c2.fill(0.3);
    for (let it = 0; it < 14; it++) {
      const r = [0, 1, 2].map((ch) => {
        let s = -D[ch];
        for (let i = 0; i < n; i++) s += c2[i] * inks[i][ch];
        return s;
      });
      for (let i = 0; i < n; i++) c2[i] = clamp(c2[i] - step * (r[0] * inks[i][0] + r[1] * inks[i][1] + r[2] * inks[i][2]), 0, 1);
    }
    for (let i = 0; i < n; i++) cov[i][p] = c2[i];
  }
  const result = { w, h, cov };
  if (t >= 1) risoCache.set(plan, result);
  return result;
}

/** Risograph: paper + crisp vector halftone dots per ink, misregistered, multiplied. */
function drawRiso(ctx: Ctx, plan: Plan, sources: ImageBitmap[], S: number, t: number) {
  const riso = plan.riso!;
  const { w, h, cov } = risoCoverage(plan, sources, t);
  const W = plan.w, H = plan.h;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = riso.paper;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.globalCompositeOperation = "multiply";
  const sample = (map: Float32Array, x: number, y: number) => {
    const fx = clamp((x / W) * w - 0.5, 0, w - 1), fy = clamp((y / H) * h - 0.5, 0, h - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    return lerp(lerp(map[y0 * w + x0], map[y0 * w + x1], tx), lerp(map[y1 * w + x0], map[y1 * w + x1], tx), ty);
  };
  const cell = riso.cell;
  riso.inks.forEach((ink, i) => {
    const a = riso.angles[i], cos = Math.cos(a), sin = Math.sin(a);
    const [ox, oy] = riso.offsets[i];
    const R = Math.hypot(W, H);
    const path = new Path2D();
    for (let v = -R; v < R; v += cell) {
      for (let u = -R; u < R; u += cell) {
        const x = W / 2 + u * cos - v * sin, y = H / 2 + u * sin + v * cos;
        if (x < -cell || y < -cell || x > W + cell || y > H + cell) continue;
        const c = sample(cov[i], x, y);
        if (c < 0.03) continue;
        const r = cell * 0.72 * Math.sqrt(c) * S;
        const px = (x + ox) * S, py = (y + oy) * S;
        path.moveTo(px + r, py);
        path.arc(px, py, r, 0, Math.PI * 2);
      }
    }
    ctx.fillStyle = ink;
    ctx.fill(path);
  });
  ctx.restore();
}

function drawHaze(ctx: Ctx, S: number, haze: NonNullable<Plan["haze"]>) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const g = ctx.createRadialGradient(haze.cx * S, haze.cy * S, 0, haze.cx * S, haze.cy * S, haze.r * S);
  g.addColorStop(0, rgba(haze.color, haze.alpha));
  g.addColorStop(0.55, rgba(haze.color, haze.alpha * 0.35));
  g.addColorStop(1, rgba(haze.color, 0));
  ctx.globalCompositeOperation = "screen";
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
}

function drawVignette(ctx: Ctx, W: number, H: number, v: number) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const r = Math.hypot(W, H) / 2;
  const g = ctx.createRadialGradient(W / 2, H / 2, r * 0.45, W / 2, H / 2, r);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, `rgba(0,0,0,${v})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

/** The Seam: one thin glowing gold line, crisp core at least 1 device pixel wide. */
function drawSeam(ctx: Ctx, plan: Plan, S: number, t: number) {
  const p = t >= 1 ? 1 : clamp((t - 0.86) / 0.12, 0, 1);
  if (p <= 0) return;
  const total = plan.seam.length / 2;
  const count = Math.max(2, Math.round(total * p));
  const path = new Path2D();
  for (let i = 0; i < count; i++) {
    const x = plan.seam[2 * i] * S, y = plan.seam[2 * i + 1] * S;
    if (i === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
  }
  const width = Math.max(1, plan.seamWidth * S);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = width;
  // Glow.
  ctx.shadowColor = "rgba(255, 196, 80, 0.85)";
  ctx.shadowBlur = Math.max(3, 8 * S);
  ctx.strokeStyle = "#d9a83e";
  ctx.stroke(path);
  // Crisp core.
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  const xs = plan.seam.filter((_, i) => i % 2 === 0), ys = plan.seam.filter((_, i) => i % 2 === 1);
  const g = ctx.createLinearGradient(Math.min(...xs) * S, Math.min(...ys) * S, Math.max(...xs) * S + 1, Math.max(...ys) * S + 1);
  g.addColorStop(0, "#b8862b");
  g.addColorStop(0.45, "#ffe9a8");
  g.addColorStop(0.7, "#e2b650");
  g.addColorStop(1, "#c9973a");
  ctx.strokeStyle = g;
  ctx.stroke(path);
  ctx.restore();
}

/** Corner stamp: first 4 seed chars + a 5×5 mirrored glyph from the seed. Pixel-snapped. */
function drawStamp(ctx: Ctx, plan: Plan, W: number, H: number) {
  const unit = Math.min(W, H);
  const cell = Math.max(2, Math.round(unit * 0.0045));
  const glyph = cell * 5;
  const pad = Math.max(4, Math.round(unit * 0.022));
  const inner = Math.max(3, Math.round(cell * 1.5));
  const fontPx = Math.max(9, Math.round(glyph * 0.78));
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.font = `600 ${fontPx}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
  ctx.textBaseline = "middle";
  const textW = Math.ceil(ctx.measureText(plan.stamp.text).width);
  const bw = inner * 3 + glyph + textW, bh = inner * 2 + glyph;
  const x = W - pad - bw, y = H - pad - bh;
  ctx.fillStyle = "rgba(10,10,12,0.55)";
  ctx.beginPath();
  ctx.roundRect(x, y, bw, bh, Math.round(cell));
  ctx.fill();
  ctx.fillStyle = "#e9c46a";
  for (let r = 0; r < 5; r++)
    for (let c = 0; c < 3; c++) {
      if (!((plan.stamp.bits >> (r * 3 + c)) & 1)) continue;
      ctx.fillRect(x + inner + c * cell, y + inner + r * cell, cell, cell);
      if (c < 2) ctx.fillRect(x + inner + (4 - c) * cell, y + inner + r * cell, cell, cell);
    }
  ctx.fillStyle = "#f4f1ea";
  ctx.fillText(plan.stamp.text, x + inner * 2 + glyph, y + bh / 2 + 1);
  ctx.restore();
}

export function renderPiece(ctx: Ctx, plan: Plan, sources: ImageBitmap[], W: number, H: number, opts: RenderOpts = {}) {
  const t = opts.t ?? 1;
  const S = W / plan.w;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.shadowColor = "transparent";

  drawBackground(ctx, plan, W, H);
  if (plan.riso) {
    drawRiso(ctx, plan, sources, S, t);
  } else {
    for (const l of plan.layers) if (!l.accent) drawLayer(ctx, plan, l, sources, S, t);
    if (plan.gradientMap) gradientMapPass(ctx, W, H, plan.gradientMap);
    if (plan.glitch) glitchPass(ctx, W, H, S, plan.glitch);
  }
  if (plan.haze) drawHaze(ctx, S, plan.haze);
  if (plan.warp) warpPass(ctx, W, H, S, plan.warp);
  if (plan.accentColor) {
    const lut = lutFor(["#000000", plan.accentColor, "#ffffff"], 1.8);
    for (const l of plan.layers) if (l.accent) drawLayer(ctx, plan, l, sources, S, t, lut);
  }
  // Hero fragment: untouched — drawn after every global pass, source-over, full opacity.
  drawLayer(ctx, plan, plan.hero, sources, S, t);
  drawSeam(ctx, plan, S, t);
  if (plan.vignette > 0) drawVignette(ctx, W, H, plan.vignette);
  if (opts.stamp && t >= 1) drawStamp(ctx, plan, W, H);
  ctx.restore();
}

export function renderToCanvas(plan: Plan, sources: ImageBitmap[], W: number, H: number, opts: RenderOpts = {}): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas 2D not available");
  renderPiece(ctx, plan, sources, W, H, opts);
  return canvas;
}

/** 32×32 grayscale of the finished piece, for the perceptual hash. */
export function phashInput(plan: Plan, sources: ImageBitmap[]): Float32Array {
  const long = 160;
  const W = plan.w >= plan.h ? long : Math.round((long * plan.w) / plan.h);
  const H = plan.w >= plan.h ? Math.round((long * plan.h) / plan.w) : long;
  const piece = renderToCanvas(plan, sources, W, H);
  const small = document.createElement("canvas");
  small.width = small.height = 32;
  const sc = small.getContext("2d", { willReadFrequently: true })!;
  sc.imageSmoothingEnabled = true;
  sc.imageSmoothingQuality = "high";
  sc.drawImage(piece, 0, 0, 32, 32);
  const d = sc.getImageData(0, 0, 32, 32).data;
  const gray = new Float32Array(32 * 32);
  for (let i = 0; i < gray.length; i++) gray[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
  return gray;
}

// Renderer: draws a Plan at any pixel size, straight from the full-resolution source bitmaps.
// Photo passes are rasterised once per size (crop → treatment) and cached, so the assembly animation
// only composites. Halftone dots and type are vector, built in design units, sharp at every size.
import { fontCss } from "./fonts";
import { mulMat, shapeBox, traceShape, type Box, type Mat, type Shape } from "./geometry";
import { gradientLut, parseHex } from "./palette";
import type { El, Enter, Fit, ImageSpec, Plan, Tf, Treat } from "./planner";
import { warpPass } from "./warp";

export type RenderOpts = {
  /** Assembly animation progress, 0..1. 1 = finished piece. */
  t?: number;
  stamp?: boolean;
};

type Ctx = CanvasRenderingContext2D;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
function easeOutBack(x: number) {
  const c1 = 1.5, c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

// ---------------------------------------------------------------------------------------------------
// Caches. Rasters are per plan + output size (a few sizes kept: preview, thumbnail, pHash); vector paths
// and text layouts are per plan only. Very large renders (exports) use a throwaway cache.

type SizeCache = Map<string, HTMLCanvasElement>;
const rasterCache = new WeakMap<Plan, Map<string, SizeCache>>();
const pathCache = new WeakMap<Plan, Map<string, Path2D>>();
const layoutCache = new WeakMap<El, TextLayout>();

function sizeCache(plan: Plan, W: number, H: number): SizeCache {
  if (W * H > 4_000_000) return new Map();
  let bySize = rasterCache.get(plan);
  if (!bySize) rasterCache.set(plan, (bySize = new Map()));
  const key = `${W}x${H}`;
  let c = bySize.get(key);
  if (!c) {
    if (bySize.size >= 3) bySize.delete(bySize.keys().next().value!);
    bySize.set(key, (c = new Map()));
  }
  return c;
}

function cachedPath(plan: Plan, key: string, build: () => Path2D): Path2D {
  let m = pathCache.get(plan);
  if (!m) pathCache.set(plan, (m = new Map()));
  let p = m.get(key);
  if (!p) m.set(key, (p = build()));
  return p;
}

function makeCanvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

// ---------------------------------------------------------------------------------------------------
// Geometry helpers.

const IDENT: Mat = [1, 0, 0, 1, 0, 0];

function tfMat(tf: Tf | undefined): Mat {
  if (!tf) return IDENT;
  const s = tf.scale ?? 1, c = Math.cos(tf.rot) * s, n = Math.sin(tf.rot) * s;
  const tx = tf.cx + (tf.dx ?? 0), ty = tf.cy + (tf.dy ?? 0);
  return [c, n, -n, c, tx - c * tf.cx + n * tf.cy, ty - n * tf.cx - c * tf.cy];
}

function aroundMat(cx: number, cy: number, scale: number, rot: number, dx: number, dy: number): Mat {
  return tfMat({ cx, cy, rot, scale, dx, dy });
}

function unionBox(boxes: Box[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function shapesPath(shapes: Shape[]): Path2D {
  const p = new Path2D();
  for (const s of shapes) traceShape(p, s);
  return p;
}

function elBox(plan: Plan, el: El): Box {
  const full = { x: 0, y: 0, w: plan.w, h: plan.h };
  switch (el.k) {
    case "fill":
      return full;
    case "shape":
      return unionBox(el.shapes.map(shapeBox));
    case "image":
    case "dots":
      return el.clip ? unionBox(el.clip.map(shapeBox)) : full;
    case "text":
      return el.box;
  }
}

// ---------------------------------------------------------------------------------------------------
// Photo rasters: crop at output resolution, then treat.

/** Draw the visible part of a bitmap placed by `fit`, in design units under the current transform. */
function drawFitted(c: Ctx, bmp: ImageBitmap, fit: Fit, view: Box) {
  let sx = (view.x - fit.x) / fit.s, sy = (view.y - fit.y) / fit.s;
  let sw = view.w / fit.s, sh = view.h / fit.s;
  if (sx < 0) { sw += sx; sx = 0; }
  if (sy < 0) { sh += sy; sy = 0; }
  sw = Math.min(sw, bmp.width - sx);
  sh = Math.min(sh, bmp.height - sy);
  if (sw <= 0 || sh <= 0) return;
  c.drawImage(bmp, sx, sy, sw, sh, fit.x + sx * fit.s, fit.y + sy * fit.s, sw * fit.s, sh * fit.s);
}

const lutCache = new Map<string, Uint8ClampedArray>();
function lutFor(stops: string[], contrastAmt: number) {
  const key = stops.join() + contrastAmt;
  let lut = lutCache.get(key);
  if (!lut) lutCache.set(key, (lut = gradientLut(stops.map(parseHex), contrastAmt)));
  return lut;
}

/** Luma percentiles of a raster (sampled), for auto-levels. */
function rasterLevels(d: Uint8ClampedArray): [number, number] {
  const hist = new Uint32Array(256);
  let n = 0;
  const step = Math.max(4, Math.floor(d.length / 4 / 60000) * 4);
  for (let i = 0; i < d.length; i += step) {
    if (d[i + 3] < 8) continue;
    hist[(d[i] * 54 + d[i + 1] * 183 + d[i + 2] * 19) >> 8]++;
    n++;
  }
  const at = (q: number) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) if ((acc += hist[v]) >= q * n) return v;
    return 255;
  };
  const lo = at(0.015), hi = at(0.985);
  return [lo, Math.max(lo + 24, hi)];
}

function treatPixels(c: HTMLCanvasElement, treat: Treat) {
  const x = c.getContext("2d", { willReadFrequently: true })!;
  const img = x.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const [lo, hi] = rasterLevels(d);
  const k = 255 / (hi - lo);
  if (treat.k === "map") {
    const lut = lutFor(treat.stops, treat.contrast);
    const steps = treat.steps ?? 0;
    for (let i = 0; i < d.length; i += 4) {
      let l = clamp(((((d[i] * 54 + d[i + 1] * 183 + d[i + 2] * 19) >> 8) - lo) * k) | 0, 0, 255);
      if (steps > 1) l = Math.round(Math.round((l / 255) * (steps - 1)) * (255 / (steps - 1)));
      d[i] = lut[l * 3]; d[i + 1] = lut[l * 3 + 1]; d[i + 2] = lut[l * 3 + 2];
    }
  } else {
    const sat = 1 + treat.punch * 0.9, con = 1 + treat.punch * 0.35;
    const q = treat.posterize ?? 0, qs = q > 1 ? 255 / (q - 1) : 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = (d[i] * 54 + d[i + 1] * 183 + d[i + 2] * 19) >> 8;
      for (let ch = 0; ch < 3; ch++) {
        let v = (d[i + ch] - lo) * k;
        const lv = (l - lo) * k;
        v = lv + (v - lv) * sat;
        v = 128 + (v - 128) * con;
        if (qs) v = Math.round(clamp(v, 0, 255) / qs) * qs;
        d[i + ch] = v;
      }
    }
  }
  x.putImageData(img, 0, 0);
}

type ImageEl = Extract<El, { k: "image" }>;

/** Raster of an image spec over `box` (design units) at scale S, treated. */
function photoRaster(spec: ImageSpec & Partial<Pick<ImageEl, "smear" | "kaleido">>, box: Box, sources: ImageBitmap[], S: number): HTMLCanvasElement {
  const rw = Math.min(8192, Math.ceil(box.w * S)), rh = Math.min(8192, Math.ceil(box.h * S));
  const c = makeCanvas(rw, rh);
  const x = c.getContext("2d", { willReadFrequently: true })!;
  x.imageSmoothingEnabled = true;
  x.imageSmoothingQuality = "high";
  const bmp = sources[spec.src];
  const base: Mat = [rw / box.w, 0, 0, rh / box.h, (-box.x * rw) / box.w, (-box.y * rh) / box.h];
  if (spec.kaleido) {
    const { cx, cy, n, rot } = spec.kaleido;
    const wedge = (Math.PI * 2) / n;
    const R = Math.hypot(box.w, box.h) * 1.5;
    for (let i = 0; i < n; i++) {
      x.save();
      x.setTransform(...base);
      x.translate(cx, cy);
      x.rotate(rot + i * wedge);
      if (i % 2) {
        x.rotate(wedge);
        x.scale(1, -1);
      }
      x.beginPath();
      x.moveTo(0, 0);
      x.arc(0, 0, R, -0.012, wedge + 0.012);
      x.closePath();
      x.clip();
      x.rotate(-rot);
      x.translate(-cx, -cy);
      x.drawImage(bmp, spec.fit.x, spec.fit.y, bmp.width * spec.fit.s, bmp.height * spec.fit.s);
      x.restore();
    }
  } else {
    x.setTransform(...base);
    drawFitted(x, bmp, spec.fit, box);
  }
  if (spec.smear) {
    x.setTransform(1, 0, 0, 1, 0, 0);
    if (spec.smear.dir === "down") {
      const y = clamp(Math.round((spec.smear.at - box.y) * (rh / box.h)), 1, rh - 1);
      x.drawImage(c, 0, y - 1, rw, 1, 0, y, rw, rh - y);
    } else {
      const xx = clamp(Math.round((spec.smear.at - box.x) * (rw / box.w)), 1, rw - 1);
      x.drawImage(c, xx - 1, 0, 1, rh, xx, 0, rw - xx, rh);
    }
  }
  treatPixels(c, spec.treat);
  return c;
}

// ---------------------------------------------------------------------------------------------------
// Halftone: luma lookups on a small copy of each bitmap.

type LumaGrid = { w: number; h: number; d: Float32Array; lo: number; hi: number };
const lumaCache = new WeakMap<ImageBitmap, LumaGrid>();

function lumaGrid(bmp: ImageBitmap): LumaGrid {
  let g = lumaCache.get(bmp);
  if (g) return g;
  const k = Math.min(1, 480 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const c = makeCanvas(w, h);
  const x = c.getContext("2d", { willReadFrequently: true })!;
  x.imageSmoothingQuality = "high";
  x.drawImage(bmp, 0, 0, w, h);
  const px = x.getImageData(0, 0, w, h).data;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
  const [lo, hi] = rasterLevels(px);
  g = { w, h, d, lo, hi };
  lumaCache.set(bmp, g);
  return g;
}

function dotsPath(el: Extract<El, { k: "dots" }>, box: Box, sources: ImageBitmap[]): Path2D {
  const path = new Path2D();
  const grid = el.src >= 0 ? lumaGrid(sources[el.src]) : null;
  const bmp = el.src >= 0 ? sources[el.src] : null;
  const cos = Math.cos(el.angle), sin = Math.sin(el.angle);
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const R = Math.hypot(box.w, box.h) / 2 + el.cell;
  const sample = (X: number, Y: number) => {
    if (!grid || !bmp || !el.fit) return el.flat ?? 0.5;
    const ix = ((X - el.fit.x) / el.fit.s) * (grid.w / bmp.width), iy = ((Y - el.fit.y) / el.fit.s) * (grid.h / bmp.height);
    const fx = clamp(ix - 0.5, 0, grid.w - 1), fy = clamp(iy - 0.5, 0, grid.h - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(grid.w - 1, x0 + 1), y1 = Math.min(grid.h - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    const l =
      (grid.d[y0 * grid.w + x0] * (1 - tx) + grid.d[y0 * grid.w + x1] * tx) * (1 - ty) +
      (grid.d[y1 * grid.w + x0] * (1 - tx) + grid.d[y1 * grid.w + x1] * tx) * ty;
    return 1 - clamp((l - grid.lo) / (grid.hi - grid.lo), 0, 1);
  };
  for (let v = -R; v <= R; v += el.cell) {
    for (let u = -R; u <= R; u += el.cell) {
      const X = cx + u * cos - v * sin, Y = cy + u * sin + v * cos;
      if (X < box.x - el.cell || Y < box.y - el.cell || X > box.x + box.w + el.cell || Y > box.y + box.h + el.cell) continue;
      const cov = Math.pow(sample(X, Y), el.gamma);
      const r = el.cell * el.maxR * Math.sqrt(cov);
      if (r < el.cell * 0.05) continue;
      path.moveTo(X + r, Y);
      path.arc(X, Y, r, 0, Math.PI * 2);
    }
  }
  return path;
}

// ---------------------------------------------------------------------------------------------------
// Type: fit the word to its box — one line, a balanced break, a broken word or a letter stack, whichever
// sets it biggest. Layout is measured once at 100px and scaled.

type TextEl = Extract<El, { k: "text" }>;
type Line = { text: string; w: number; a: number; d: number };
/** `sy` stretches the block vertically ("fill" mode); blockH is the stretched height. */
type TextLayout = { lines: Line[]; size: number; lh: number; blockH: number; sy: number };

const measurer = (() => {
  let c: CanvasRenderingContext2D | null = null;
  return () => (c ??= makeCanvas(8, 8).getContext("2d")!);
})();

function setTracking(x: Ctx, el: TextEl, size: number) {
  const ls = (el.tracking ?? 0) * size;
  if ("letterSpacing" in x) (x as Ctx & { letterSpacing: string }).letterSpacing = `${ls}px`;
}

function measureLine(el: TextEl, text: string): Line {
  const x = measurer();
  x.font = fontCss(el.font, 100);
  setTracking(x, el, 100);
  const m = x.measureText(text);
  return { text, w: m.width, a: m.actualBoundingBoxAscent || 72, d: m.actualBoundingBoxDescent || 4 };
}

const SHY = "\u00ad";

function candidates(el: TextEl): string[][] {
  const t = el.text.replaceAll(SHY, "");
  const out: string[][] = [[t]];
  // Marked break points (soft hyphens) are the only places a single word may break.
  if (el.text.includes(SHY) && !el.text.includes(" ")) {
    const parts = el.text.split(SHY);
    for (let k = 1; k < parts.length; k++) out.push([parts.slice(0, k).join(""), parts.slice(k).join("")]);
    return out;
  }
  const words = t.split(" ").filter(Boolean);
  if (words.length > 1) {
    for (let k = 1; k < words.length; k++) out.push([words.slice(0, k).join(" "), words.slice(k).join(" ")]);
    if (words.length >= 3)
      for (let a = 1; a < words.length - 1; a++)
        for (let b = a + 1; b < words.length; b++) out.push([words.slice(0, a).join(" "), words.slice(a, b).join(" "), words.slice(b).join(" ")]);
  } else if (el.breakWord && /^[A-Z0-9!?&]+$/.test(t) && t.length >= 10) {
    for (let k = 3; k <= t.length - 3; k++) out.push([t.slice(0, k), t.slice(k)]);
  }
  if (el.stack && /^[A-Z0-9]+$/.test(t) && t.length <= 6) out.push([...t]);
  return out;
}

function layoutText(el: TextEl): TextLayout {
  const hit = layoutCache.get(el);
  if (hit) return hit;
  const lh = el.lh ?? 1;
  let best: TextLayout | null = null, bestScore = -1;
  for (const parts of el.size ? [[el.text.replaceAll(SHY, "")]] : candidates(el)) {
    const lines = parts.map((p) => measureLine(el, p));
    const w100 = Math.max(...lines.map((l) => l.w));
    const h100 = lines[0].a + (lines.length - 1) * lh * 100 + lines[lines.length - 1].d;
    let size: number;
    if (el.size) size = Math.min(el.size, (el.box.w / w100) * 100);
    else if (el.fit === "width") size = Math.min((el.box.w / w100) * 100, (el.box.h * 1.25 / h100) * 100);
    else if (el.fit === "fill") size = Math.min((el.box.w / w100) * 100, (el.box.h / h100) * 100);
    else size = Math.min((el.box.w / w100) * 100, (el.box.h / h100) * 100);
    const broken = parts.length > 1 && !el.text.includes(" ") && !el.text.includes(SHY);
    const h = (h100 * size) / 100;
    const sy = el.fit === "fill" ? clamp(el.box.h / h, 1, 2.6) : 1;
    // Fill mode rewards filling the box with the least stretch; the others reward size.
    const score = (el.fit === "fill" ? size * Math.min(1, (h * sy) / el.box.h) / Math.sqrt(sy) : size) * (broken ? (parts.length > 2 ? 0.86 : 0.9) : 1);
    if (score > bestScore) {
      bestScore = score;
      best = { lines, size, lh, blockH: h * sy, sy };
    }
  }
  layoutCache.set(el, best!);
  return best!;
}

/** Baseline positions of each line, design units. */
function linePlaces(el: TextEl, L: TextLayout) {
  const k = L.size / 100;
  const y0 = el.valign === "top" ? el.box.y : el.valign === "bottom" ? el.box.y + el.box.h - L.blockH : el.box.y + (el.box.h - L.blockH) / 2;
  return L.lines.map((ln, i) => {
    const w = ln.w * k;
    const x = el.align === "left" ? el.box.x : el.align === "right" ? el.box.x + el.box.w - w : el.box.x + (el.box.w - w) / 2;
    return { ln, x, y: y0 + (L.lines[0].a * k + i * L.lh * L.size) * L.sy, w };
  });
}

function drawTextRuns(x: Ctx, el: TextEl, L: TextLayout, style: { fill?: string; stroke?: { w: number; color: string }; dx?: number; dy?: number }, onlyX?: [number, number], onlyLine?: number) {
  x.font = fontCss(el.font, L.size);
  setTracking(x, el, L.size);
  x.textAlign = "left";
  x.textBaseline = "alphabetic";
  x.lineJoin = "round";
  const places = linePlaces(el, L);
  places.forEach((p, i) => {
    if (onlyLine !== undefined && i !== onlyLine) return;
    x.save();
    if (onlyX) {
      x.beginPath();
      x.rect(onlyX[0], el.box.y - L.size, onlyX[1] - onlyX[0], el.box.h + L.size * 2);
      x.clip();
    }
    const X = p.x + (style.dx ?? 0), Y = p.y + (style.dy ?? 0);
    if (L.sy !== 1) {
      x.translate(0, Y);
      x.scale(1, L.sy);
      x.translate(0, -Y);
    }
    if (style.stroke) {
      x.lineWidth = style.stroke.w * 2;
      x.strokeStyle = style.stroke.color;
      x.strokeText(p.ln.text, X, Y);
    }
    if (style.fill) {
      x.fillStyle = style.fill;
      x.fillText(p.ln.text, X, Y);
    }
    x.restore();
  });
}

/** The glyph the sandwich re-prints in front: the one straddling the sticker's chosen edge. */
function frontGlyph(el: TextEl, L: TextLayout): { line: number; span: [number, number] } | null {
  const f = el.front!;
  const x = measurer();
  x.font = fontCss(el.font, L.size);
  setTracking(x, el, L.size);
  const edge = f.side === "left" ? f.box.x + f.box.w * 0.08 : f.box.x + f.box.w * 0.92;
  let best: { line: number; span: [number, number]; d: number } | null = null;
  linePlaces(el, L).forEach((p, li) => {
    const top = p.y - p.ln.a * (L.size / 100) * L.sy, bottom = p.y;
    if (bottom < f.box.y + f.box.h * 0.04 || top > f.box.y + f.box.h) return;
    const chars = [...p.ln.text];
    chars.forEach((ch, ci) => {
      const w = x.measureText(ch).width;
      const x0 = p.x + x.measureText(chars.slice(0, ci).join("")).width;
      if (ch === " ") return;
      const d = Math.abs(x0 + w / 2 - edge);
      if (!best || d < best.d) best = { line: li, span: [x0 - w * 0.08, x0 + w * 1.08], d };
    });
  });
  const b = best as { line: number; span: [number, number]; d: number } | null;
  return b && b.d < L.size * 0.9 ? { line: b.line, span: b.span } : null;
}

// ---------------------------------------------------------------------------------------------------
// Elements.

function progress(e: Enter, t: number) {
  return t >= 1 ? 1 : clamp((t - e.at) / e.dur, 0, 1);
}

function drawElement(ctx: Ctx, plan: Plan, el: El, idx: number, sources: ImageBitmap[], S: number, t: number, cache: SizeCache) {
  const p = progress(el.enter, t);
  if (p <= 0) return;
  const box = elBox(plan, el);
  const bcx = box.x + box.w / 2, bcy = box.y + box.h / 2;

  // Entrance transform (design space, applied outside the element's own tf).
  let anim: Mat = IDENT;
  let alpha = el.alpha ?? 1;
  let wipe: Path2D | null = null;
  if (p < 1) {
    if (el.enter.kind === "slam") {
      const e = easeOut(p);
      anim = aroundMat(bcx, bcy, 1 + 0.4 * (1 - e), 0, 0, 0);
      alpha *= Math.min(1, p * 3);
    } else if (el.enter.kind === "drop") {
      const e = easeOutBack(p);
      anim = aroundMat(bcx, bcy, 1 + 0.08 * (1 - e), 0.3 * (1 - e), 0, -plan.h * 0.3 * (1 - e));
      alpha *= Math.min(1, p * 4);
    } else if (el.enter.kind === "fade") alpha *= p;
    else {
      const e = easeOut(p), dir = el.enter.dir ?? 0, D = Math.hypot(plan.w, plan.h);
      const c = Math.cos(dir), s = Math.sin(dir), cx = plan.w / 2, cy = plan.h / 2;
      const reach = -D / 2 + e * D;
      const pts = [[-D, -D], [reach, -D], [reach, D], [-D, D]].map(([u, v]) => [cx + u * c - v * s, cy + u * s + v * c]);
      wipe = new Path2D();
      wipe.moveTo(pts[0][0], pts[0][1]);
      pts.slice(1).forEach(([a, b]) => wipe!.lineTo(a, b));
      wipe.closePath();
    }
  }

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = el.blend ?? "source-over";
  const view: Mat = [S, 0, 0, S, 0, 0];
  if (wipe) {
    ctx.setTransform(...view);
    ctx.clip(wipe);
  }
  const m = mulMat(mulMat(view, anim), tfMat(el.tf));
  ctx.setTransform(...m);

  switch (el.k) {
    case "fill":
      ctx.fillStyle = el.color;
      ctx.fillRect(-2, -2, plan.w + 4, plan.h + 4);
      break;

    case "shape": {
      const path = cachedPath(plan, `s${idx}`, () => shapesPath(el.shapes));
      ctx.lineJoin = "round";
      if (el.shadow) {
        ctx.save();
        ctx.translate(el.shadow.dx, el.shadow.dy);
        ctx.fillStyle = el.shadow.color;
        ctx.fill(path);
        if (el.stroke) {
          ctx.lineWidth = el.stroke.w;
          ctx.strokeStyle = el.shadow.color;
          ctx.stroke(path);
        }
        ctx.restore();
      }
      if (el.fill) {
        ctx.fillStyle = el.fill;
        ctx.fill(path);
      }
      if (el.stroke) {
        ctx.lineWidth = el.stroke.w;
        ctx.strokeStyle = el.stroke.color;
        ctx.stroke(path);
      }
      break;
    }

    case "image": {
      const key = `i${idx}`;
      let r = cache.get(key);
      if (!r) cache.set(key, (r = photoRaster(el, box, sources, S)));
      const path = el.clip ? cachedPath(plan, `c${idx}`, () => shapesPath(el.clip!)) : null;
      ctx.lineJoin = "round";
      if (el.shadow && path) {
        ctx.save();
        ctx.translate(el.shadow.dx, el.shadow.dy);
        ctx.fillStyle = el.shadow.color;
        ctx.fill(path);
        if (el.border) {
          ctx.lineWidth = el.border.w * 2;
          ctx.strokeStyle = el.shadow.color;
          ctx.stroke(path);
        }
        ctx.restore();
      }
      if (el.border && path) {
        ctx.lineWidth = el.border.w * 2;
        ctx.strokeStyle = el.border.color;
        ctx.stroke(path);
      }
      if (path) ctx.clip(path);
      ctx.drawImage(r, box.x, box.y, box.w, box.h);
      break;
    }

    case "dots": {
      const path = cachedPath(plan, `d${idx}`, () => dotsPath(el, box, sources));
      if (el.clip) ctx.clip(cachedPath(plan, `c${idx}`, () => shapesPath(el.clip!)));
      ctx.fillStyle = el.color;
      ctx.fill(path);
      break;
    }

    case "text": {
      const L = layoutText(el);
      let only: [number, number] | undefined, line: number | undefined;
      if (el.front) {
        const g = frontGlyph(el, L);
        if (!g) break;
        only = g.span;
        line = g.line;
      }
      if (el.shadow) drawTextRuns(ctx, el, L, { fill: el.shadow.color, stroke: el.stroke && { w: el.stroke.w, color: el.shadow.color }, dx: el.shadow.dx, dy: el.shadow.dy }, only, line);
      if (el.stroke) drawTextRuns(ctx, el, L, { stroke: el.stroke }, only, line);
      if (el.image) {
        // Letters as windows: treated photo, masked by the glyphs, on its own layer.
        const key = `t${idx}`;
        let r = cache.get(key);
        if (!r) cache.set(key, (r = photoRaster(el.image, el.box, sources, S)));
        // All lines go into one mask first: a destination-in per line would erase the lines before it.
        const mask = makeCanvas(r.width, r.height);
        const mx = mask.getContext("2d")!;
        mx.setTransform(r.width / el.box.w, 0, 0, r.height / el.box.h, (-el.box.x * r.width) / el.box.w, (-el.box.y * r.height) / el.box.h);
        drawTextRuns(mx, el, L, { fill: "#000" }, only, line);
        const layer = makeCanvas(r.width, r.height);
        const lx = layer.getContext("2d")!;
        lx.drawImage(r, 0, 0);
        lx.globalCompositeOperation = "destination-in";
        lx.drawImage(mask, 0, 0);
        ctx.drawImage(layer, el.box.x, el.box.y, el.box.w, el.box.h);
      } else drawTextRuns(ctx, el, L, { fill: el.fill }, only, line);
      break;
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------------------------------
// Finishing: print texture and the edition mark.

function mulberry(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ink dropout (paper showing through) and toner specks, seeded, in design units. */
function drawTexture(ctx: Ctx, plan: Plan, S: number, alpha: number) {
  const tex = plan.texture!;
  const paths = cachedPath(plan, "tex-paper", () => {
    const r = mulberry(tex.seed);
    const p = new Path2D();
    const n = Math.round(tex.amount * 2600 * ((plan.w * plan.h) / 1e6));
    for (let i = 0; i < n; i++) {
      const x = r() * plan.w, y = r() * plan.h, rad = 0.35 + r() * r() * 1.8;
      p.moveTo(x + rad, y);
      p.arc(x, y, rad, 0, Math.PI * 2);
    }
    return p;
  });
  const specks = cachedPath(plan, "tex-ink", () => {
    const r = mulberry(tex.seed ^ 0x5bd1e995);
    const p = new Path2D();
    const n = Math.round(tex.amount * 900 * ((plan.w * plan.h) / 1e6));
    for (let i = 0; i < n; i++) {
      const x = r() * plan.w, y = r() * plan.h, rad = 0.3 + r() * 1.1;
      p.moveTo(x + rad, y);
      p.arc(x, y, rad, 0, Math.PI * 2);
    }
    return p;
  });
  ctx.save();
  ctx.setTransform(S, 0, 0, S, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = alpha * (0.45 + 0.4 * tex.amount);
  ctx.fillStyle = tex.paper;
  ctx.fill(paths);
  ctx.globalAlpha = alpha * (0.35 + 0.3 * tex.amount);
  ctx.fillStyle = tex.ink;
  ctx.fill(specks);
  ctx.restore();
}

/** Edition mark: a 5×5 mirrored glyph from the seed, in the plan's ink, in a free corner. */
function drawStamp(ctx: Ctx, plan: Plan, S: number) {
  const cell = Math.min(plan.w, plan.h) * 0.0065;
  const size = cell * 5;
  const pad = Math.min(plan.w, plan.h) * 0.05;
  const c = plan.stampCorner;
  const x = c === 1 || c === 2 ? plan.w - pad - size : pad;
  const y = c >= 2 ? plan.h - pad - size : pad;
  ctx.save();
  ctx.setTransform(S, 0, 0, S, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.fillStyle = plan.stampColor;
  for (let r = 0; r < 5; r++)
    for (let col = 0; col < 3; col++) {
      if (!((plan.stamp.bits >> (r * 3 + col)) & 1)) continue;
      ctx.fillRect(x + col * cell, y + r * cell, cell + 0.02, cell + 0.02);
      if (col < 2) ctx.fillRect(x + (4 - col) * cell, y + r * cell, cell + 0.02, cell + 0.02);
    }
  ctx.restore();
}

export function renderPiece(ctx: Ctx, plan: Plan, sources: ImageBitmap[], W: number, H: number, opts: RenderOpts = {}) {
  const t = opts.t ?? 1;
  const S = W / plan.w;
  const cache = sizeCache(plan, W, H);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  plan.els.forEach((el, i) => {
    if (i === plan.warpBefore && plan.warp) warpPass(ctx, W, H, S, plan.warp);
    drawElement(ctx, plan, el, i, sources, S, t, cache);
  });
  if (plan.warpBefore >= plan.els.length && plan.warp) warpPass(ctx, W, H, S, plan.warp);
  if (plan.texture) drawTexture(ctx, plan, S, t >= 1 ? 1 : clamp((t - 0.85) / 0.15, 0, 1));
  if (opts.stamp && t >= 1 && plan.stampCorner >= 0) drawStamp(ctx, plan, S);
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

// Color utilities, k-means palette extraction, preset palettes, gradient-map LUTs and color naming.
import { createRng, deriveSeed, type Rng } from "./prng";
import type { Mood, PaletteMode } from "./settings";

export type RGB = [number, number, number];
export type Swatch = { rgb: RGB; weight: number };

export const hex = (c: RGB) => "#" + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");

export function parseHex(h: string): RGB {
  let s = h.replace("#", "");
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

export const luma = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

export function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

export function hslToRgb(h: number, s: number, l: number): RGB {
  h = ((h % 360) + 360) % 360 / 360;
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}

export const mixRgb = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const dist2 = (a: RGB, b: RGB) => {
  // Weighted RGB distance — cheap and perceptually reasonable.
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return 2 * dr * dr + 4 * dg * dg + 3 * db * db;
};

/** Deterministic weighted k-means (k-means++ init). */
export function kmeans(points: RGB[], weights: number[], k: number, seedLabel: string): Swatch[] {
  if (!points.length) return [];
  k = Math.min(k, points.length);
  const rng = createRng(deriveSeed("00000000000000000000000000000000", seedLabel));
  const centers: RGB[] = [points[Math.floor(rng.next() * points.length)]];
  while (centers.length < k) {
    const d = points.map((p, i) => Math.min(...centers.map((c) => dist2(p, c))) * weights[i]);
    centers.push(rng.weighted(points, d.some((v) => v > 0) ? d : points.map(() => 1)));
  }
  const assign = new Int32Array(points.length);
  for (let iter = 0; iter < 12; iter++) {
    for (let i = 0; i < points.length; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const d = dist2(points[i], centers[c]);
        if (d < bd) { bd = d; best = c; }
      }
      assign[i] = best;
    }
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < points.length; i++) {
      const s = sums[assign[i]], w = weights[i];
      s[0] += points[i][0] * w; s[1] += points[i][1] * w; s[2] += points[i][2] * w; s[3] += w;
    }
    sums.forEach((s, c) => { if (s[3] > 0) centers[c] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
  }
  const w = centers.map(() => 0);
  for (let i = 0; i < points.length; i++) w[assign[i]] += weights[i];
  const total = w.reduce((a, b) => a + b, 0) || 1;
  return centers.map((rgb, i) => ({ rgb, weight: w[i] / total })).filter((s) => s.weight > 0).sort((a, b) => b.weight - a.weight);
}

/** Merge per-image palettes into one shared source palette. */
export function mergePalettes(palettes: Swatch[][], k = 6): Swatch[] {
  const pts: RGB[] = [], ws: number[] = [];
  palettes.forEach((p) => p.forEach((s) => { pts.push(s.rgb); ws.push(s.weight / palettes.length); }));
  return kmeans(pts, ws, k, "merge:" + pts.map((p) => p.map(Math.round).join(",")).join(";"));
}

const PRESETS: Record<Exclude<PaletteMode, "source">, string[]> = {
  warm: ["#2a1410", "#7a2e1f", "#c8553d", "#f28f3b", "#ffd5a5", "#fff3e2"],
  cold: ["#0b1626", "#1d3557", "#457b9d", "#7fb7d8", "#c9e4f2", "#f1faff"],
  mono: ["#0e0e0e", "#3a3a3a", "#777777", "#b5b5b5", "#e6e6e6", "#fafafa"],
  neon: ["#0a0014", "#3a0ca3", "#f72585", "#4cc9f0", "#b8ff3c", "#ffffff"],
};
export const BAUHAUS = ["#111111", "#1d4fa0", "#e63022", "#f5c518", "#f2efe6"];
const EARTHY = ["#1f2416", "#4a5a2f", "#7d8b4e", "#b5a26a", "#c97b4a", "#efe6d2"];

export const RISO_INKS: { name: string; hex: string }[] = [
  { name: "Fluorescent Pink", hex: "#ff48b0" },
  { name: "Blue", hex: "#0078bf" },
  { name: "Yellow", hex: "#ffe800" },
  { name: "Teal", hex: "#00838a" },
  { name: "Orange", hex: "#ff6c2f" },
  { name: "Purple", hex: "#765ba7" },
  { name: "Bright Red", hex: "#f15060" },
  { name: "Green", hex: "#00a95c" },
  { name: "Federal Blue", hex: "#3d5588" },
];
export const RISO_PAPER = "#f3ede2";

function saturation(c: RGB) {
  return rgbToHsl(c)[1] * (1 - Math.abs(luma(c) / 255 - 0.5));
}

export function mostSaturated(source: Swatch[]): RGB | null {
  const best = [...source].sort((a, b) => saturation(b.rgb) - saturation(a.rgb))[0];
  return best && saturation(best.rgb) > 0.18 ? best.rgb : null;
}

function rotateHue(c: RGB, deg: number): RGB {
  const [h, s, l] = rgbToHsl(c);
  return hslToRgb(h + deg, s, l);
}

/** Palette (dark → light) for a piece, from palette mode + mood, biased toward source colors. */
export function resolvePalette(mode: PaletteMode, mood: Mood, mood2: Mood | null, source: Swatch[], rng: Rng, remix: number): RGB[] {
  const src = source.length ? source.map((s) => s.rgb) : PRESETS.mono.map(parseHex);
  let colors: RGB[];
  if (mood === "bauhaus") colors = BAUHAUS.map(parseHex);
  else if (mood === "brutal") colors = [[0, 0, 0], [255, 255, 255], mostSaturated(source) ?? parseHex("#ff3b1f")];
  else if (mood === "botanical") colors = [...EARTHY.map(parseHex), ...(mode === "source" ? src.slice(0, 3) : PRESETS[mode].map(parseHex).slice(1, 4))];
  else colors = mode === "source" ? src : PRESETS[mode].map(parseHex).map((c, i) => mixRgb(c, src[i % src.length], 0.18));

  if (mood2 === "bauhaus") colors = [...colors, ...BAUHAUS.slice(1, 4).map(parseHex)];
  if (mood2 === "botanical") colors = [...colors, ...EARTHY.slice(1, 4).map(parseHex)];

  if (remix > 0 && mood !== "brutal") {
    const shift = rng.range(35, 160) * rng.sign();
    colors = colors.map((c) => rotateHue(c, shift));
  }
  return colors.sort((a, b) => luma(a) - luma(b));
}

/** 256-entry RGB LUT mapping luminance → color along the given stops. */
export function gradientLut(stops: RGB[], contrast = 1): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    let t = i / 255;
    if (contrast !== 1) {
      // Symmetric S-curve.
      const x = t * 2 - 1;
      t = (Math.sign(x) * Math.pow(Math.abs(x), 1 / contrast) + 1) / 2;
    }
    const f = t * (stops.length - 1);
    const j = Math.min(stops.length - 2, Math.floor(f));
    const c = mixRgb(stops[j], stops[j + 1], f - j);
    lut[i * 3] = c[0]; lut[i * 3 + 1] = c[1]; lut[i * 3 + 2] = c[2];
  }
  return lut;
}

/** Gradient-map stops from a palette: anchored to a deep dark and a clean light. */
export function gradientStops(palette: RGB[]): RGB[] {
  const sorted = [...palette].sort((a, b) => luma(a) - luma(b));
  const dark = mixRgb(sorted[0], [0, 0, 0], 0.65);
  const light = mixRgb(sorted[sorted.length - 1], [255, 255, 255], 0.6);
  // Keep at most 4 interior stops so the map stays legible.
  const step = Math.max(1, Math.ceil(sorted.length / 4));
  const interior = sorted.filter((_, i) => i % step === 0);
  return [dark, ...interior, light];
}

export function pickRisoInks(source: Swatch[], count: number, rng: Rng): RGB[] {
  const inks = RISO_INKS.map((i) => parseHex(i.hex));
  const chosen: RGB[] = [];
  for (const s of source) {
    if (chosen.length >= count) break;
    if (saturation(s.rgb) < 0.12) continue;
    const best = inks.filter((i) => !chosen.includes(i)).sort((a, b) => dist2(a, s.rgb) - dist2(b, s.rgb))[0];
    if (best) chosen.push(best);
  }
  while (chosen.length < count) {
    const rest = inks.filter((i) => !chosen.includes(i));
    chosen.push(rng.pick(rest));
  }
  return chosen;
}

const COLOR_NAMES: [string, string][] = [
  ["Orange", "#e8772e"], ["Ochre", "#c99a2e"], ["Rust", "#9c4a26"], ["Crimson", "#b0213a"], ["Rose", "#d9768a"],
  ["Coral", "#f0806a"], ["Amber", "#f0b23a"], ["Gold", "#d4a943"], ["Olive", "#7d7a3a"], ["Moss", "#5f7040"],
  ["Jade", "#3f9a77"], ["Teal", "#2a7f86"], ["Cobalt", "#2950a8"], ["Indigo", "#3b3a8c"], ["Violet", "#7a4fb0"],
  ["Plum", "#6e3159"], ["Ivory", "#f2ecd9"], ["Bone", "#ddd3bd"], ["Ash", "#9a9893"], ["Graphite", "#3c3d40"],
  ["Ink", "#14161c"], ["Sand", "#d6bf93"], ["Umber", "#5a4030"], ["Cerulean", "#3d8fc6"], ["Saffron", "#f4c430"],
  ["Sage", "#9cae8f"], ["Blush", "#e9b9b0"], ["Mauve", "#a7849b"], ["Lilac", "#b8a6d9"], ["Slate", "#5d6b7a"],
];

export function colorName(c: RGB): string {
  let best = COLOR_NAMES[0][0], bd = Infinity;
  for (const [name, h] of COLOR_NAMES) {
    const d = dist2(c, parseHex(h));
    if (d < bd) { bd = d; best = name; }
  }
  return best;
}

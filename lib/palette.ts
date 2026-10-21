// Color utilities, k-means palette extraction, the ink sets, gradient-map LUTs and color naming.
import { createRng, deriveSeed } from "./prng";
import type { PaletteMode } from "./settings";

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

const saturation = (c: RGB) => rgbToHsl(c)[1] * (1 - Math.abs(luma(c) / 255 - 0.5));

/**
 * Ink sets: paper (the ground), ink (darkest, carries small type), pop (the loud one), alt (a second loud
 * or light ink). Every set is built so ink-on-paper and pop-on-ink read from across a room.
 */
export type InkSet = {
  id: string;
  /** Printed on the piece, in order: paper, ink, pop, alt. */
  names: [string, string, string, string];
  paper: string;
  ink: string;
  pop: string;
  alt: string;
  families: readonly Exclude<PaletteMode, "source" | "loud">[];
};

export const INK_SETS: readonly InkSet[] = [
  { id: "pink-ultra", names: ["Cream", "Ultramarine", "Fluo Pink", "Yellow"], paper: "#f4efe4", ink: "#1b2a9e", pop: "#ff48b0", alt: "#ffe800", families: ["neon", "cold"] },
  { id: "acid-red", names: ["Acid", "Jet", "Signal Red", "Hot Pink"], paper: "#e4ff1a", ink: "#0d0c0b", pop: "#ff2e1f", alt: "#ff2d95", families: ["neon", "warm"] },
  { id: "tomato-teal", names: ["Bone", "Deep Teal", "Tomato", "Seafoam"], paper: "#f2e9dc", ink: "#0f3b3d", pop: "#ff5a36", alt: "#19b3a6", families: ["warm"] },
  { id: "night-fluo", names: ["Jet", "Bone", "Hot Pink", "Lime"], paper: "#0d0c0b", ink: "#f1ead8", pop: "#ff2d95", alt: "#d7ff1f", families: ["neon"] },
  { id: "klein-orange", names: ["Chalk", "Klein Blue", "Orange", "Sunflower"], paper: "#f1ede4", ink: "#002fa7", pop: "#ff6c2f", alt: "#ffd23f", families: ["cold", "warm"] },
  { id: "mint-burgundy", names: ["Mint", "Burgundy", "Coral Red", "Milk"], paper: "#c8eee4", ink: "#4a0f2e", pop: "#ff4f5e", alt: "#fff7e8", families: ["cold"] },
  { id: "sun-violet", names: ["Sunflower", "Deep Violet", "Rose", "Cream"], paper: "#ffb511", ink: "#2a0f57", pop: "#ff3d8b", alt: "#fff3d6", families: ["warm"] },
  { id: "kraft", names: ["Kraft", "Jet", "Poster Red", "Bone"], paper: "#c9a676", ink: "#141210", pop: "#e8202a", alt: "#f3ecdc", families: ["warm", "mono"] },
  { id: "ice-red", names: ["Ice", "Navy", "Signal Red", "Sky"], paper: "#e6f0f4", ink: "#0b1f3a", pop: "#ff3b30", alt: "#59c3e8", families: ["cold"] },
  { id: "forest-orange", names: ["Oat", "Forest", "Blaze Orange", "Lime"], paper: "#efe8d6", ink: "#11382a", pop: "#ff6a1f", alt: "#b5e03c", families: ["warm"] },
  { id: "xerox-red", names: ["Xerox White", "Toner Black", "Red", "Grey"], paper: "#ebe9e4", ink: "#111111", pop: "#e3261c", alt: "#9a9a9a", families: ["mono"] },
  { id: "lilac-lime", names: ["Lilac", "Ink Navy", "Lime", "Bubblegum"], paper: "#cbbcff", ink: "#17123d", pop: "#c8ff00", alt: "#ff4fa3", families: ["neon", "cold"] },
  { id: "gold-black", names: ["Jet", "Bone", "Gold", "Oxblood"], paper: "#0f0e0d", ink: "#f0e8d4", pop: "#d6a740", alt: "#8c2b1f", families: ["mono", "warm"] },
  { id: "cobalt-yellow", names: ["Paper", "Cobalt", "Chrome Yellow", "Pink"], paper: "#f6f1e6", ink: "#1238d6", pop: "#ffd400", alt: "#ff5c8a", families: ["cold"] },
  { id: "blood-cream", names: ["Poster Red", "Jet", "Cream", "Yellow"], paper: "#e8261c", ink: "#120c0b", pop: "#f4ecd8", alt: "#ffd400", families: ["warm"] },
  { id: "bubblegum", names: ["Bubblegum", "Aubergine", "Vermilion", "Lemon"], paper: "#ff8fc6", ink: "#1a1033", pop: "#ff4a1c", alt: "#fff36b", families: ["neon", "warm"] },
];

export function inkSet(id: string): InkSet {
  return INK_SETS.find((s) => s.id === id) ?? INK_SETS[0];
}

export const isDarkPaper = (s: InkSet) => luma(parseHex(s.paper)) < 90;

const hueDist = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b)) / 180;

/**
 * How well an ink set suits the photos: its loud inks should echo (or squarely oppose) the photos' most
 * saturated hues, so the print looks born from them rather than pasted over them.
 */
export function inkAffinity(set: InkSet, source: Swatch[]): number {
  const loud = source.filter((s) => saturation(s.rgb) > 0.12);
  if (!loud.length) return set.families.includes("mono") ? 1 : 0.5;
  let score = 0, wsum = 0;
  for (const s of loud) {
    const h = rgbToHsl(s.rgb)[0];
    const w = s.weight * saturation(s.rgb);
    const near = Math.max(...[set.pop, set.alt, set.ink, set.paper].map((c) => {
      const [ch, cs] = rgbToHsl(parseHex(c));
      return cs < 0.2 ? 0 : 1 - hueDist(h, ch);
    }));
    const opposite = Math.max(...[set.pop, set.alt].map((c) => 1 - Math.abs(hueDist(h, rgbToHsl(parseHex(c))[0]) - 1)));
    score += w * Math.max(near, opposite * 0.8);
    wsum += w;
  }
  return score / wsum;
}

export function inkCandidates(mode: PaletteMode): readonly InkSet[] {
  if (mode === "source" || mode === "loud") return INK_SETS;
  const pool = INK_SETS.filter((s) => s.families.includes(mode));
  return pool.length ? pool : INK_SETS;
}

/** Index of the most saturated swatch's hue, as a coarse family for picking words. */
export function hueFamily(source: Swatch[]): string {
  const best = [...source].sort((a, b) => saturation(b.rgb) * Math.sqrt(b.weight) - saturation(a.rgb) * Math.sqrt(a.weight))[0];
  if (!best || saturation(best.rgb) < 0.1) {
    const l = source.reduce((s, c) => s + luma(c.rgb) * c.weight, 0);
    return l < 110 ? "dark" : "light";
  }
  const h = rgbToHsl(best.rgb)[0];
  if (h < 15 || h >= 340) return "red";
  if (h < 42) return "orange";
  if (h < 68) return "yellow";
  if (h < 160) return "green";
  if (h < 200) return "teal";
  if (h < 255) return "blue";
  if (h < 300) return "purple";
  return "pink";
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

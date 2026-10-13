// Composition planner: a pure function of (spec, image analyses) → Plan. Runs in the worker.
// The plan is resolution-independent (design units), so preview and every export show the same piece.
import type { Analysis } from "./analysis";
import { cutShapes, type Fit } from "./cuts";
import {
  applyMat,
  placeMatrix,
  resampleClosed,
  shapeArea,
  shapeBox,
  shapeCentroid,
  shapeOutline,
  type Shape,
} from "./geometry";
import {
  BAUHAUS,
  RISO_PAPER,
  colorName,
  gradientStops,
  hex,
  luma,
  mergePalettes,
  mixRgb,
  pickRisoInks,
  resolvePalette,
} from "./palette";
import { forkRng, type Rng } from "./prng";
import { BLEND_SETS, designSize, type BlendSet, type Cut, type Layout, type Mood, type PieceSpec } from "./settings";

export type Layer = {
  /** Source image index, or -1 for a flat fill. */
  src: number;
  /** Flat fill color ("gold" = gold-leaf gradient). */
  fill: string | null;
  shape: Shape;
  home: [number, number];
  pos: [number, number];
  rot: number;
  scale: number;
  flip: boolean;
  blend: GlobalCompositeOperation;
  alpha: number;
  tint: { color: string; alpha: number } | null;
  /** Feather radius in design units. Non-zero only in Dreamscape. */
  feather: number;
  /** Brutal accent layer: duotone black → accent, drawn after the global pass. */
  accent: boolean;
  /** Assembly animation: offset the layer flies in from, and when (0..1 of the timeline). */
  enter: { dx: number; dy: number; rot: number; scale: number; delay: number };
};

export type Rarity = "Common" | "Rare" | "Legendary";

export type Plan = {
  w: number;
  h: number;
  background: { stops: string[]; angle: number };
  fits: Fit[];
  layers: Layer[];
  hero: Layer;
  seam: number[];
  seamWidth: number;
  palette: string[];
  gradientMap: { stops: string[]; amount: number; contrast: number } | null;
  accentColor: string | null;
  glitch: {
    sorts: { y: number; h: number; lo: number; hi: number; reverse: boolean }[];
    rgb: number;
    tears: { y: number; h: number; dx: number }[];
  } | null;
  riso: { paper: string; inks: string[]; cell: number; angles: number[]; offsets: [number, number][] } | null;
  haze: { color: string; alpha: number; cx: number; cy: number; r: number } | null;
  vignette: number;
  warp: { amp: number; f: [number, number, number, number]; p: [number, number, number, number] } | null;
  stamp: { text: string; bits: number };
  title: string;
  rarity: Rarity;
  score: number;
  traits: string[];
};

export type PlanImage = { width: number; height: number; analysis: Analysis };

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

type Target = { x: number; y: number; rot: number; size: number; z: number };

function layoutTargets(layout: Layout, rng: Rng, K: number, W: number, H: number, chaos: number, density: number, mood: Mood, u: number) {
  const rotJ = lerp(0.03, 0.9, chaos);
  const out: Target[] = [];
  let focal: [number, number] = [W / 2, H / 2];

  if (layout === "golden") {
    const g = rng.int(0, 3);
    focal = [(g & 1 ? 0.382 : 0.618) * W, (g & 2 ? 0.382 : 0.618) * H];
    const R = Math.hypot(W, H) * (0.42 + 0.3 * chaos);
    for (let i = 0; i < K; i++) {
      const r = Math.sqrt((i + 0.5) / K) * R * (1 + rng.gauss() * 0.12);
      const a = i * 2.39996 + rng.gauss() * 0.35 * chaos;
      out.push({ x: focal[0] + Math.cos(a) * r, y: focal[1] + Math.sin(a) * r, rot: rng.gauss() * rotJ, size: u * lerp(1.7, 0.65, clamp(r / R, 0, 1)) * rng.range(0.8, 1.2), z: -r });
    }
  } else if (layout === "radial") {
    focal = [W * (0.5 + rng.gauss() * 0.07), H * (0.5 + rng.gauss() * 0.07)];
    const R = Math.hypot(W, H) * 0.55;
    for (let i = 0; i < K; i++) {
      const a = (i / K) * Math.PI * 2 + rng.gauss() * 0.15;
      const r = R * (0.08 + 0.92 * Math.pow(rng.next(), 0.8));
      out.push({ x: focal[0] + Math.cos(a) * r, y: focal[1] + Math.sin(a) * r, rot: a + (rng.next() < 0.5 ? 0 : Math.PI / 2) + rng.gauss() * rotJ * 0.5, size: u * lerp(0.6, 1.5, r / R), z: rng.next() });
    }
  } else if (layout === "diagonal") {
    const flip = rng.next() < 0.5;
    const A = flip ? [0, 0] : [0, H], B = flip ? [W, H] : [W, 0];
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
    const dx = (B[0] - A[0]) / len, dy = (B[1] - A[1]) / len;
    const amp = Math.min(W, H) * rng.range(0.08, 0.2), k = rng.range(0.6, 1.6), ph = rng.next() * Math.PI * 2;
    const at = (t: number) => {
      const s = Math.sin(t * Math.PI * 2 * k + ph) * amp;
      return [A[0] + (B[0] - A[0]) * t - dy * s, A[1] + (B[1] - A[1]) * t + dx * s];
    };
    focal = at(0.5) as [number, number];
    for (let i = 0; i < K; i++) {
      const t = (i + rng.next()) / K;
      const [bx, by] = at(t);
      const [nx2, ny2] = at(Math.min(1, t + 0.01));
      const tangent = Math.atan2(ny2 - by, nx2 - bx);
      const off = rng.gauss() * Math.min(W, H) * (0.1 + 0.2 * chaos);
      out.push({ x: bx - dy * off, y: by + dx * off, rot: (rng.next() < 0.6 ? tangent : 0) + rng.gauss() * rotJ * 0.6, size: u * rng.range(0.7, 1.4), z: rng.next() });
    }
  } else if (layout === "grid") {
    const cols = Math.max(2, Math.round(lerp(3, 8, density) * Math.sqrt(W / H)));
    const rows = Math.max(2, Math.round((cols * H) / W));
    const cw = W / cols, ch = H / rows;
    const cells = rng.shuffle(Array.from({ length: cols * rows }, (_, i) => i));
    focal = [(Math.floor(cols / 2) + 0.5) * cw, (Math.floor(rows / 2) + 0.5) * ch];
    for (let i = 0; i < K; i++) {
      const c = cells[i % cells.length];
      let x = ((c % cols) + 0.5) * cw, y = (Math.floor(c / cols) + 0.5) * ch;
      if (rng.next() < 0.15 + 0.35 * chaos) {
        if (rng.next() < 0.5) x += (cw / 2) * rng.sign();
        else y += (ch / 2) * rng.sign();
      }
      const rot = mood === "bauhaus" ? rng.int(0, 3) * (Math.PI / 2) : rng.next() < 0.7 ? 0 : rng.gauss() * rotJ * 0.3;
      out.push({ x, y, rot, size: Math.min(cw, ch) * rng.range(0.85, 1.25) * (rng.next() < 0.12 ? 1.9 : 1), z: rng.next() });
    }
  } else {
    focal = [rng.range(0.3, 0.7) * W, rng.range(0.3, 0.7) * H];
    for (let i = 0; i < K; i++) {
      out.push({ x: rng.range(-0.05, 1.05) * W, y: rng.range(-0.05, 1.05) * H, rot: rng.range(-1, 1) * Math.PI * Math.max(0.35, chaos), size: u * rng.range(0.5, 1.5), z: rng.next() });
    }
  }
  return { targets: out, focal };
}

const GRADIENT_AMOUNT: Record<Mood, number> = { kintsugi: 0.22, riso: 0, dreamscape: 0.35, brutal: 1, glitch: 0.25, bauhaus: 0.55, botanical: 0.42 };
const VIGNETTE: Record<Mood, number> = { kintsugi: 0.38, riso: 0, dreamscape: 0.2, brutal: 0, glitch: 0.28, bauhaus: 0, botanical: 0.26 };
const BASE_PROB: Record<Mood, number> = { kintsugi: 1, riso: 0.5, dreamscape: 0.35, brutal: 0.55, glitch: 0.6, bauhaus: 0.3, botanical: 0.35 };

const MOOD_PTS: Record<Mood, number> = { kintsugi: 1, riso: 2, dreamscape: 1, brutal: 1, glitch: 2, bauhaus: 2, botanical: 1 };
const CUT_PTS: Record<Cut, number> = { voronoi: 0, strips: 0, polygons: 0, blobs: 1, circles: 1, triangles: 1, subject: 2 };
const LAYOUT_PTS: Record<Layout, number> = { golden: 0, diagonal: 0, chaos: 0, radial: 1, grid: 1 };
const BLEND_PTS: Record<BlendSet, number> = { calm: 0, ink: 0, luminous: 0, contrast: 1, mixed: 1, acid: 2 };

const PREFIXES = ["Untitled No.", "Untitled No.", "Untitled No.", "Study No.", "Composition No.", "Fragment No."];
const NOUNS = [
  "Silence", "Weather", "Memory", "Hymn", "Drift", "Orbit", "Fracture", "Tide", "Ember", "Hour", "Window", "Echo",
  "Garden", "Distance", "Lullaby", "Signal", "Season", "Room", "Thread", "Harbor", "Vigil", "Bloom", "Mirage",
  "Requiem", "Afterglow", "Meridian", "Reverie", "Monument", "Interval", "Threshold", "Psalm", "Shoreline",
];

export function planComposition(spec: PieceSpec, images: PlanImage[]): Plan {
  const { seed, settings, recipe } = spec;
  const { w: W, h: H } = designSize(settings.ratio);
  const N = images.length;
  const { density, chaos, blend } = settings;
  const mood = recipe.mood;

  const rFit = forkRng(seed, "fit");
  const rCut = forkRng(seed, `cut:${recipe.cut}:${recipe.remix}`);
  const rLay = forkRng(seed, "layout");
  const rSty = forkRng(seed, `style:${recipe.remix}`);
  const rTr = forkRng(seed, "traits");
  const rAnim = forkRng(seed, "anim");
  const rFx = forkRng(seed, "fx");

  // Cover-fit each image into the design rect, with a seeded zoom/offset.
  const fits: Fit[] = images.map((img) => {
    const s = Math.max(W / img.width, H / img.height) * rFit.range(1, 1.35);
    return { s, x: -(img.width * s - W) * rFit.next(), y: -(img.height * s - H) * rFit.next() };
  });

  const source = mergePalettes(images.map((i) => i.analysis.palette));
  const palette = resolvePalette(settings.palette, mood, recipe.mood2, source, rSty, recipe.remix);
  const paletteHex = palette.map(hex);

  // ---- Cut ----
  const n = Math.round(lerp(5, 46, density));
  type Piece = { img: number; shape: Shape; area: number; home: [number, number]; subject: boolean };
  const pieces: Piece[] = images.flatMap((img, i) =>
    cutShapes(recipe.cut, { rng: rCut, W, H, n, chaos, fit: fits[i], imgW: img.width, imgH: img.height, analysis: img.analysis }).map(
      (shape, j) => ({ img: i, shape, area: shapeArea(shape), home: shapeCentroid(shape), subject: recipe.cut === "subject" && j === 0 }),
    ),
  );

  const traits = {
    gilded: rTr.next() < 0.06,
    monolith: rTr.next() < 0.05,
    mirror: rTr.next() < 0.06,
    eclipse: rTr.next() < 0.04,
  };

  // ---- Hero fragment: one untouched, sharp, unblended piece ----
  const baseImg = rLay.int(0, N - 1);
  const targetArea = W * H * (traits.monolith ? 0.2 : 0.08);
  const heroCandidates = pieces.filter((p) => {
    const b = shapeBox(p.shape);
    return b.w < W * 0.8 && b.h < H * 0.8 && (N < 2 || p.img !== baseImg);
  });
  const heroScore = (p: Piece) => Math.abs(Math.log(p.area / targetArea)) - (p.subject ? 1.5 : 0) + rLay.next() * 0.4;
  const heroPiece = [...(heroCandidates.length ? heroCandidates : pieces)].map((p) => [p, heroScore(p)] as const).sort((a, b) => a[1] - b[1])[0][0];

  // ---- Layout ----
  const useBase = rLay.next() < BASE_PROB[mood];
  const K = Math.max(4, Math.round(lerp(7, 42, density) * (useBase ? 0.8 : 1.1)));
  const u = Math.sqrt((W * H) / K) * (useBase ? 0.95 : 1.25);
  const { targets, focal } = layoutTargets(recipe.layout, rLay, K, W, H, chaos, density, mood, u);

  const pool = [
    ...rLay.shuffle(pieces.filter((p) => p !== heroPiece && p.img !== baseImg)),
    ...rLay.shuffle(pieces.filter((p) => p !== heroPiece && p.img === baseImg)),
  ];
  const blendModes = BLEND_SETS[recipe.blendSet] as readonly GlobalCompositeOperation[];
  const feather = (rng: Rng) => (mood === "dreamscape" ? rng.range(6, 22) : 0);
  const maxDim = Math.max(W, H);

  const layers: Layer[] = [];

  if (useBase) {
    const shift = mood === "kintsugi" ? 2 + 10 * chaos : 1 + 6 * chaos;
    for (const p of pieces.filter((q) => q.img === baseImg && q !== heroPiece)) {
      layers.push({
        src: p.img, fill: null, shape: p.shape, home: p.home,
        pos: [p.home[0] + rLay.gauss() * shift, p.home[1] + rLay.gauss() * shift],
        rot: rLay.gauss() * (mood === "kintsugi" ? 0.01 + 0.04 * chaos : 0.02 * chaos),
        scale: mood === "kintsugi" ? rLay.range(0.965, 0.995) : rLay.range(0.985, 1),
        flip: false, blend: "source-over", alpha: 1, tint: null, feather: feather(rSty), accent: false,
        enter: { dx: rAnim.gauss() * 40, dy: rAnim.gauss() * 40, rot: rAnim.gauss() * 0.1, scale: 1.04, delay: rAnim.range(0, 0.15) },
      });
    }
  }

  if (traits.eclipse) {
    const r = Math.min(W, H) * 0.28;
    const c: [number, number] = [focal[0] + rLay.gauss() * r * 0.4, focal[1] + rLay.gauss() * r * 0.4];
    layers.push({
      src: -1, fill: paletteHex[0], shape: { k: "circle", cx: c[0], cy: c[1], r }, home: c, pos: c, rot: 0, scale: 1, flip: false,
      blend: "multiply", alpha: 0.9, tint: null, feather: 0, accent: false,
      enter: { dx: 0, dy: 0, rot: 0, scale: 0.2, delay: 0.1 },
    });
  }

  const order = targets.map((t, i) => [t, i] as const).sort((a, b) => a[0].z - b[0].z);
  order.forEach(([t], rank) => {
    if (!pool.length) return;
    const p = pool[rank % pool.length];
    const scale = clamp(t.size / Math.sqrt(p.area), 0.3, 2.6);
    const blended = rSty.next() < blend * 0.9;
    const mode = blended ? rSty.pick(blendModes) : "source-over";
    const flat = mood === "bauhaus" && rSty.next() < 0.3;
    const dir = Math.atan2(t.y - H / 2, t.x - W / 2) + rAnim.gauss() * 0.4;
    const dist = maxDim * rAnim.range(0.6, 1.0);
    layers.push({
      src: flat ? -1 : p.img,
      fill: flat ? rSty.pick(BAUHAUS.slice(1, 4)) : null,
      shape: p.shape, home: p.home, pos: [t.x, t.y], rot: t.rot, scale, flip: false,
      blend: mode, alpha: blended ? lerp(0.65, 1, blend) : 1,
      tint: mood !== "riso" && mood !== "brutal" && !flat && rSty.next() < 0.3 ? { color: rSty.pick(paletteHex), alpha: rSty.range(0.22, 0.5) } : null,
      feather: feather(rSty), accent: false,
      enter: { dx: Math.cos(dir) * dist, dy: Math.sin(dir) * dist, rot: rAnim.gauss() * 1.2, scale: rAnim.range(0.5, 1.6), delay: 0.12 + 0.5 * (rank / K) + rAnim.range(-0.04, 0.04) },
    });
  });

  // Brutal: 1–3 accent layers in black → accent duotone.
  const accentRgb = mood === "brutal" ? palette.find((c) => luma(c) > 10 && luma(c) < 245) ?? null : null;
  if (mood === "brutal") {
    const scattered = layers.filter((l) => l.src >= 0 && l.blend === "source-over");
    rFx.shuffle(scattered).slice(0, rFx.int(1, 3)).forEach((l) => (l.accent = true));
  }

  // Hero placement: at the layout's focal point, upright, kept inside the canvas.
  const hb = shapeBox(heroPiece.shape);
  let heroScale = clamp(Math.sqrt((W * H * 0.05) / heroPiece.area), 1, 1.8);
  heroScale = Math.min(heroScale, (W * 0.8) / hb.w, (H * 0.8) / hb.h);
  const margin = Math.min(W, H) * 0.04;
  const off = [(hb.x + hb.w / 2 - heroPiece.home[0]) * heroScale, (hb.y + hb.h / 2 - heroPiece.home[1]) * heroScale];
  const halfW = (hb.w * heroScale) / 2, halfH = (hb.h * heroScale) / 2;
  const heroPos: [number, number] = [
    clamp(focal[0], margin + halfW, W - margin - halfW) - off[0],
    clamp(focal[1], margin + halfH, H - margin - halfH) - off[1],
  ];
  const hero: Layer = {
    src: heroPiece.img, fill: null, shape: heroPiece.shape, home: heroPiece.home, pos: heroPos, rot: 0, scale: heroScale, flip: false,
    blend: "source-over", alpha: 1, tint: null, feather: 0, accent: false,
    enter: { dx: 0, dy: -maxDim * 0.8, rot: 0.4 * rAnim.sign(), scale: 1.15, delay: 0.66 },
  };

  if (traits.mirror) {
    layers.push({
      ...hero, flip: true, pos: [W - heroPos[0], H - heroPos[1]], rot: rLay.gauss() * 0.2,
      blend: rSty.pick(blendModes), alpha: 0.85, enter: { ...hero.enter, dy: maxDim * 0.8, delay: 0.55 },
    });
  }

  if (traits.gilded) {
    const small = [...pool].sort((a, b) => a.area - b.area)[Math.floor(pool.length * 0.3)] ?? heroPiece;
    const s = clamp((Math.min(W, H) * 0.09) / Math.sqrt(small.area), 0.3, 3);
    layers.push({
      src: -1, fill: "gold", shape: small.shape, home: small.home,
      pos: [clamp(heroPos[0] + halfW * rTr.sign(), 0, W), clamp(heroPos[1] + halfH * rTr.sign(), 0, H)],
      rot: rTr.gauss() * 0.5, scale: s, flip: false, blend: "source-over", alpha: 1, tint: null, feather: 0, accent: false,
      enter: { dx: 0, dy: 0, rot: 1, scale: 0.1, delay: 0.6 },
    });
  }

  // ---- The Seam: a gold line along part of the hero's edge, where it meets the shards beneath ----
  const outline = resampleClosed(applyMat(placeMatrix(hero.pos, 0, heroScale, false, hero.home), shapeOutline(hero.shape)), 180);
  const segPts = 180;
  const frac = mood === "kintsugi" ? rTr.range(0.55, 0.85) : rTr.range(0.3, 0.55);
  const start = rTr.int(0, segPts - 1);
  const seam: number[] = [];
  for (let i = 0; i <= Math.round(segPts * frac); i++) {
    const j = (start + i) % segPts;
    seam.push(outline[2 * j], outline[2 * j + 1]);
  }

  // ---- Fuse: palette pass, mood effects ----
  let amount = GRADIENT_AMOUNT[mood];
  if (settings.palette !== "source" && !["bauhaus", "brutal", "riso"].includes(mood)) amount = Math.min(1, amount + 0.2);
  const gradientMap =
    mood === "riso"
      ? null
      : mood === "brutal"
        ? { stops: ["#000000", "#ffffff"], amount: 1, contrast: 2.4 }
        : { stops: gradientStops(palette).map(hex), amount, contrast: 1 };

  const background =
    mood === "riso"
      ? { stops: [RISO_PAPER, RISO_PAPER], angle: 0 }
      : mood === "bauhaus"
        ? { stops: ["#f2efe6", "#e9e4d6"], angle: rFx.next() * Math.PI }
        : mood === "brutal"
          ? rFx.next() < 0.5 ? { stops: ["#0a0a0a", "#0a0a0a"], angle: 0 } : { stops: ["#f4f4f2", "#f4f4f2"], angle: 0 }
          : {
              stops: [hex(mixRgb(palette[0], [0, 0, 0], 0.5)), hex(mixRgb(palette[Math.min(1, palette.length - 1)], [0, 0, 0], mood === "dreamscape" ? 0.1 : 0.35))],
              angle: rFx.next() * Math.PI * 2,
            };

  const glitchK = mood === "glitch" ? 1 : recipe.mood2 === "glitch" ? 0.5 : 0;
  const glitch = glitchK
    ? {
        sorts: Array.from({ length: Math.round(rFx.int(2, 5) * glitchK) || 1 }, () => ({
          y: rFx.next() * H, h: rFx.range(15, 130), lo: rFx.range(20, 90), hi: rFx.range(150, 235), reverse: rFx.next() < 0.4,
        })),
        rgb: rFx.range(2, 6) * glitchK,
        tears: Array.from({ length: Math.round(rFx.int(4, 12) * glitchK) }, () => ({
          y: rFx.next() * H, h: rFx.range(3, 36), dx: rFx.range(10, 110) * rFx.sign() * glitchK,
        })),
      }
    : null;

  const riso =
    mood === "riso"
      ? (() => {
          const inks = pickRisoInks(source, rFx.int(2, 3), rFx).map(hex);
          return {
            paper: RISO_PAPER,
            inks,
            cell: rFx.range(6, 8),
            angles: [15, 75, 45].slice(0, inks.length).map((a) => ((a + rFx.range(-4, 4)) * Math.PI) / 180),
            offsets: inks.map((): [number, number] => [rFx.gauss() * 2.5, rFx.gauss() * 2.5]),
          };
        })()
      : null;

  const haze =
    mood === "dreamscape" || recipe.mood2 === "dreamscape"
      ? { color: paletteHex[paletteHex.length - 1], alpha: rFx.range(0.22, 0.4), cx: rFx.range(0.2, 0.8) * W, cy: rFx.range(0.1, 0.6) * H, r: maxDim * 0.85 }
      : null;

  const warp =
    settings.warp > 0.01
      ? {
          amp: settings.warp * 38,
          f: [rFx.range(0.004, 0.012), rFx.range(0.004, 0.012), rFx.range(0.003, 0.01), rFx.range(0.003, 0.01)] as [number, number, number, number],
          p: [rFx.next() * 6.28, rFx.next() * 6.28, rFx.next() * 6.28, rFx.next() * 6.28] as [number, number, number, number],
        }
      : null;

  // ---- Identity: title, stamp, rarity ----
  const rTitle = forkRng(seed, "title");
  const named = recipe.remix > 0 || !source.length ? palette.slice(1, -1) : source.slice(0, 4).map((s) => s.rgb);
  const colorWord = colorName(rTitle.pick(named.length ? named : palette));
  let title = `${rTitle.pick(PREFIXES)} ${rTitle.int(1000, 9999)} — ${colorWord} ${rTitle.pick(NOUNS)}`;
  if (recipe.remix > 0) title += ` (Variation ${recipe.remix})`;

  const traitNames = [
    traits.gilded && "Gilded Seam",
    traits.monolith && "Monolith",
    traits.mirror && "Mirror",
    traits.eclipse && "Eclipse",
    recipe.hybrid && "Hybrid",
    settings.warp > 0.3 && "Liquid",
  ].filter(Boolean) as string[];
  const score =
    MOOD_PTS[mood] + CUT_PTS[recipe.cut] + LAYOUT_PTS[recipe.layout] + BLEND_PTS[recipe.blendSet] +
    (traits.gilded ? 3 : 0) + (traits.monolith ? 2 : 0) + (traits.mirror ? 2 : 0) + (traits.eclipse ? 3 : 0) +
    (recipe.hybrid ? 2 : 0) + (recipe.mood2 ? 1 : 0) + (settings.warp > 0.3 ? 1 : 0);
  const rarity: Rarity = score >= 8 ? "Legendary" : score >= 5 ? "Rare" : "Common";

  return {
    w: W, h: H, background, fits, layers, hero, seam,
    seamWidth: traits.gilded ? 2.8 : 1.8,
    palette: paletteHex, gradientMap, accentColor: accentRgb ? hex(accentRgb) : null,
    glitch, riso, haze, vignette: VIGNETTE[mood], warp,
    stamp: { text: seed.slice(0, 4).toUpperCase(), bits: parseInt(seed.slice(4, 8), 16) & 0x7fff },
    title, rarity, score, traits: traitNames,
  };
}

// Composition planner: a pure function of (spec, image analyses) → Plan. Runs in the worker.
// Every piece is a print: one photo is the hero (its subject framed, cut or windowed), another is the
// ground it is printed on, both forced through one print process with three inks and one giant word.
// The plan is resolution-independent (design units, short side = 1000), so preview and exports match.
import type { Analysis } from "./analysis";
import { shapeBox, type Box, type Shape } from "./geometry";
import { colorName, hueFamily, inkSet, isDarkPaper, luma, mergePalettes, parseHex, rgbToHsl, type InkSet, type Swatch } from "./palette";
import { forkRng, type Rng } from "./prng";
import { designSize, type Format, type PieceSpec, type Style } from "./settings";

export type FontKey = "anton" | "unbounded" | "shrikhand" | "rozha" | "mono";

/** Image placement: design = (x, y) + imagePx * s. */
export type Fit = { x: number; y: number; s: number };

export type Treat =
  /** Original colour, contrast/saturation punched; `posterize` = levels per channel (comic print). */
  | { k: "color"; punch: number; posterize?: number }
  /** Luma → inks gradient map after auto-levels; `steps` posterizes (screen print). */
  | { k: "map"; stops: string[]; contrast: number; steps?: number };

/** Rotate/scale around (cx, cy), then translate. */
export type Tf = { cx: number; cy: number; rot: number; scale?: number; dx?: number; dy?: number };

/** Assembly animation, as a print run: when the pass starts (0..1 of the timeline) and how it lands. */
export type Enter = { at: number; dur: number; kind: "wipe" | "slam" | "drop" | "fade"; dir?: number };

type Stroke = { w: number; color: string };
type Shadow = { dx: number; dy: number; color: string };
type Common = { tf?: Tf; blend?: GlobalCompositeOperation; alpha?: number; enter: Enter };

export type ImageSpec = { src: number; fit: Fit; treat: Treat };

export type El =
  | (Common & { k: "fill"; color: string })
  | (Common & { k: "shape"; shapes: Shape[]; fill: string | null; stroke?: Stroke; shadow?: Shadow })
  | (Common &
      ImageSpec & {
        k: "image";
        clip: Shape[] | null;
        border?: Stroke;
        shadow?: Shadow;
        /** Stretch the pixel row/column at `at` (design units) out to the edge. */
        smear?: { at: number; dir: "down" | "right" };
        /** Mirror wedges around (cx, cy). */
        kaleido?: { cx: number; cy: number; n: number; rot: number };
      })
  | (Common & {
      k: "dots";
      /** Image whose darkness sets dot size; -1 = a flat field (Ben-Day). */
      src: number;
      fit: Fit | null;
      cell: number;
      angle: number;
      color: string;
      /** Largest dot radius as a fraction of the cell. */
      maxR: number;
      gamma: number;
      /** Coverage for flat fields. */
      flat?: number;
      clip: Shape[] | null;
    })
  | (Common & {
      k: "text";
      text: string;
      font: FontKey;
      box: Box;
      /**
       * "box": largest size that fits; "width": widest line fills the box width; "fill": fills the width,
       * then stretches tall to fill the box (name as monument). Fixed `size` = micro type.
       */
      fit: "box" | "width" | "fill";
      size?: number;
      align: "left" | "center" | "right";
      valign: "top" | "middle" | "bottom";
      fill: string;
      image?: ImageSpec;
      stroke?: Stroke;
      shadow?: Shadow;
      lh?: number;
      tracking?: number;
      /** Allow one long word to break over two lines / stack its letters. */
      breakWord?: boolean;
      stack?: boolean;
      /** Type sandwich: draw only the glyph that sits on this side of the box. */
      front?: { box: Box; side: "left" | "right" };
    });

export type Rarity = "Common" | "Rare" | "Legendary";

export type Plan = {
  w: number;
  h: number;
  style: Style;
  format: Format;
  els: El[];
  /** Liquid warp runs on everything drawn before els[warpBefore]; type after it stays crisp. */
  warpBefore: number;
  warp: { amp: number; f: [number, number, number, number]; p: [number, number, number, number] } | null;
  texture: { amount: number; paper: string; ink: string; seed: number } | null;
  stampColor: string;
  /** 0 TL, 1 TR, 2 BR, 3 BL; -1 = no free corner (the edition is already printed). */
  stampCorner: number;
  /** Inks used, dark → light. */
  palette: string[];
  stamp: { text: string; bits: number };
  title: string;
  rarity: Rarity;
  score: number;
  traits: string[];
};

export type PlanImage = { width: number; height: number; analysis: Analysis };

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const L = (h: string) => luma(parseHex(h));

/** WCAG contrast ratio between two hex colours. */
export function contrast(a: string, b: string) {
  const lin = (h: string) => {
    const [r, g, b2] = parseHex(h).map((c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const x = lin(a), y = lin(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const bestOn = (ground: string, cands: string[]) => cands.reduce((a, b) => (contrast(b, ground) > contrast(a, ground) ? b : a));
/** First candidate that reads on the ground (≥ min), else the best one. */
const loudOn = (ground: string, cands: string[], min = 3) => cands.find((c) => contrast(c, ground) >= min) ?? bestOn(ground, cands);

// ---------------------------------------------------------------------------------------------------
// Words. The word comes from the photos' colour family (or the user). Devanagari pairs for script-as-image.

const LEX: Record<string, [string, string][]> = {
  red: [["HEAT", "गर्मी"], ["FEVER", "बुख़ार"], ["RIOT", "हल्ला"], ["EMBER", "अंगार"], ["CRUSH", "फ़िदा"]],
  orange: [["SOLAR", "सूरज"], ["NEC\u00adTAR", "अमृत"], ["BLAZE", "ज्वाला"], ["DUSK", "साँझ"], ["ZEST", "तड़का"]],
  yellow: [["GLOW", "चमक"], ["HONEY", "शहद"], ["BUZZ", "भनभन"], ["GOLD", "सोना"], ["NOON", "दोपहर"]],
  green: [["FERAL", "जंगली"], ["WILD", "बेलगाम"], ["MOSS", "काई"], ["SPR\u00adOUT", "अंकुर"], ["CAN\u00adOPY", "छतरी"]],
  teal: [["TIDE", "ज्वार"], ["SALT", "नमक"], ["DRIFT", "बहाव"], ["COAST", "किनारा"], ["SURF", "लहर"]],
  blue: [["DEEP", "गहरा"], ["HUSH", "चुप"], ["ABYSS", "अथाह"], ["UNDER\u00adTOW", "भँवर"], ["COLD", "ठंड"]],
  purple: [["VEL\u00adVET", "मख़मल"], ["DREAM", "सपना"], ["OMEN", "शगुन"], ["MYS\u00adTIC", "जादू"], ["HAZE", "धुँध"]],
  pink: [["CANDY", "मिठाई"], ["BLOOM", "खिलना"], ["SUGAR", "चीनी"], ["BLUSH", "लाली"], ["CRUSH", "फ़िदा"]],
  dark: [["NIGHT", "रात"], ["SHA\u00adDOW", "छाया"], ["NOIR", "स्याह"], ["VOID", "शून्य"], ["HAUNT", "साया"]],
  light: [["AIR", "हवा"], ["HALO", "प्रभा"], ["SNOW", "बर्फ़"], ["BONE", "हड्डी"], ["MILK", "दूध"]],
};
const DEVA = /[ऀ-ॿ]/;
/** Soft hyphen: the only places a lexicon word may break across lines. */
const plain = (w: string) => w.replace(/\u00ad/g, "");

// ---------------------------------------------------------------------------------------------------
// Framing: put an image's subject where the layout wants it.

/**
 * The subject box with headroom: saliency finds the body (a bright coat, a blanket) more reliably than
 * the head above it, so the box is extended upward by a third.
 */
function subjectBox(a: Analysis) {
  const s = a.subject;
  const y = Math.max(0, s.y - s.h * 0.35);
  return { x: s.x, y, w: s.w, h: s.h + (s.y - y), cx: s.cx, cy: s.cy };
}

/** Framing point: centre of the subject (with headroom), pulled up toward its top. */
function subjectCentre(a: Analysis): [number, number] {
  const s = subjectBox(a);
  return [lerp(s.x + s.w / 2, s.cx, 0.5), lerp(s.y + s.h * 0.42, s.cy, 0.25)];
}

/**
 * Cover `rect` with the image, subject centre at `focus` (fractions of rect), subject height ≈ `zoom` × rect
 * height (never below cover, never past `maxZoom` × cover so pixels stay sharp).
 */
function frame(img: PlanImage, rect: Box, focus: [number, number] = [0.5, 0.5], zoom = 0, maxZoom = 2.2): Fit {
  const subj = subjectBox(img.analysis);
  const cover = Math.max(rect.w / img.width, rect.h / img.height);
  let s = cover;
  if (zoom > 0) s = clamp(Math.min((zoom * rect.h) / (subj.h * img.height), (zoom * 1.4 * rect.w) / (subj.w * img.width)), cover, cover * maxZoom);
  const [cx, cy] = subjectCentre(img.analysis);
  const x = rect.x + rect.w * focus[0] - cx * img.width * s;
  const y = rect.y + rect.h * focus[1] - cy * img.height * s;
  return {
    s,
    x: clamp(x, rect.x + rect.w - img.width * s, rect.x),
    y: clamp(y, rect.y + rect.h - img.height * s, rect.y),
  };
}

/** Image-normalized point → design units under a fit. */
const toDesign = (img: PlanImage, fit: Fit, nx: number, ny: number): [number, number] => [fit.x + nx * img.width * fit.s, fit.y + ny * img.height * fit.s];

/** Scissor-cut outline around the subject: rays over the saliency grid, padded, simplified, jittered. */
function cutOutline(img: PlanImage, fit: Fit, rng: Rng, pad: number, points: number, jitter: number): number[] {
  const { w: gw, h: gh, data } = img.analysis.saliency;
  const mean = data.reduce((a, b) => a + b, 0) / data.length;
  const thr = Math.min(0.8, mean + 0.16);
  const [cxn, cyn] = subjectCentre(img.analysis);
  const cx = cxn * gw, cy = cyn * gh;
  const at = (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    return xi < 0 || yi < 0 || xi >= gw || yi >= gh ? 0 : data[yi * gw + xi];
  };
  const rays = 48;
  const radii: number[] = [];
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2;
    let r = 1, last = 1;
    while (r < Math.max(gw, gh) * 1.2) {
      if (at(cx + Math.cos(a) * r, cy + Math.sin(a) * r) >= thr * 0.8) last = r;
      r += 0.5;
      if (r - last > 4) break;
    }
    radii.push(Math.max(2, last));
  }
  const smooth = radii.map((_, i) => {
    let s = 0;
    for (let d = -3; d <= 3; d++) s += radii[(i + d + rays) % rays];
    return s / 7;
  });
  const pts: number[] = [];
  const off = rng.next() * Math.PI * 2;
  for (let k = 0; k < points; k++) {
    const a = off + (k / points) * Math.PI * 2 + rng.gauss() * 0.06;
    const idx = Math.round(((((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)) * rays) % rays;
    // Heads live above the salient mass: rays pointing up reach further.
    const r = smooth[idx] * pad * (1 + Math.max(0, -Math.sin(a)) * 0.45) * (1 + rng.gauss() * jitter);
    pts.push(...toDesign(img, fit, (cx + Math.cos(a) * r) / gw, (cy + Math.sin(a) * r) / gh));
  }
  return pts;
}

/** A rectangle cut by hand: a few points per side, slightly off-square. */
function roughRect(b: Box, rng: Rng, j: number): number[] {
  const pts: number[] = [];
  const side = (x0: number, y0: number, x1: number, y1: number) => {
    const n = rng.int(1, 2);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      pts.push(lerp(x0, x1, t) + rng.gauss() * j, lerp(y0, y1, t) + rng.gauss() * j);
    }
  };
  side(b.x, b.y, b.x + b.w, b.y);
  side(b.x + b.w, b.y, b.x + b.w, b.y + b.h);
  side(b.x + b.w, b.y + b.h, b.x, b.y + b.h);
  side(b.x, b.y + b.h, b.x, b.y);
  return pts;
}

function burst(cx: number, cy: number, r0: number, r1: number, spikes: number, rng: Rng): Shape {
  const pts: number[] = [];
  const rot = rng.next() * Math.PI;
  for (let i = 0; i < spikes * 2; i++) {
    const a = rot + (i / (spikes * 2)) * Math.PI * 2;
    const r = (i % 2 ? r0 : r1) * rng.range(0.9, 1.1);
    pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return { k: "poly", pts };
}

function rotRect(cx: number, cy: number, w: number, h: number, a: number): number[] {
  const c = Math.cos(a), s = Math.sin(a);
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].flatMap(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
}

const rect = (x: number, y: number, w: number, h: number): Shape => ({ k: "poly", pts: [x, y, x + w, y, x + w, y + h, x, y + h] });

// ---------------------------------------------------------------------------------------------------
// The press: shared context for every style.

type Press = {
  W: number;
  H: number;
  /** Margin. */
  M: number;
  /** Micro type size. */
  u: number;
  wide: boolean;
  format: Format;
  inks: InkSet;
  /** Darkest / lightest of paper and ink. */
  dark: string;
  light: string;
  word: string;
  wordFont: FontKey;
  /** Second-language word for script-as-image moments (Devanagari or Latin), may be "". */
  echo: string;
  echoFont: FontKey;
  sub: string;
  meta: { edition: string; day: string; count: string; inks: string; ratio: string };
  imgs: PlanImage[];
  hero: number;
  ground: number;
  extras: number[];
  rng: Rng;
  energy: number;
  scale: number;
  els: El[];
  warpBefore: number;
  stampCorner: number;
  stampColor: string;
};

const ENTER = {
  ground: (): Enter => ({ at: 0, dur: 0.28, kind: "wipe", dir: 0 }),
  pass: (i: number, dir = Math.PI / 2): Enter => ({ at: 0.14 + i * 0.13, dur: 0.3, kind: "wipe", dir }),
  word: (d = 0): Enter => ({ at: 0.56 + d, dur: 0.2, kind: "slam" }),
  drop: (d = 0): Enter => ({ at: 0.46 + d, dur: 0.26, kind: "drop" }),
  micro: (d = 0): Enter => ({ at: 0.82 + d, dur: 0.12, kind: "fade" }),
};

/** Mark where the liquid warp stops (everything after stays crisp). */
const crispFromHere = (p: Press) => (p.warpBefore = Math.min(p.warpBefore, p.els.length));

function micro(p: Press, text: string, x: number, y: number, w: number, color: string, align: "left" | "center" | "right" = "left", size = p.u) {
  p.els.push({ k: "text", text: text.toUpperCase(), font: "mono", box: { x, y, w, h: size * 1.4 }, fit: "box", size, align, valign: "top", fill: color, tracking: 0.04, enter: ENTER.micro(rngJit(p)) });
}
const rngJit = (p: Press) => p.rng.range(0, 0.05);

/** Header row: three facts spread across the top (or wherever y says). */
function headerRow(p: Press, y: number, color: string, items = [p.meta.edition, p.sub, p.meta.day]) {
  const w = (p.W - 2 * p.M) / 3;
  micro(p, items[0], p.M, y, w, color, "left");
  micro(p, items[1], p.M + w, y, w, color, "center");
  micro(p, items[2], p.M + 2 * w, y, w, color, "right");
}

function word(p: Press, box: Box, fill: string, extra: Partial<Extract<El, { k: "text" }>> = {}) {
  const el: El = {
    k: "text", text: p.word, font: p.wordFont, box, fit: "box", align: "left", valign: "top", fill,
    lh: p.wordFont === "rozha" ? 1.08 : 0.88, breakWord: true, enter: ENTER.word(), ...extra,
  };
  p.els.push(el);
  return el;
}

/** Word box height for the poster headline: never under 16% of the canvas (poster rule). */
const wordH = (p: Press, lo = 0.17, hi = 0.36) => p.H * lerp(lo, hi, p.scale);

const triStops = (p: Press, mid: string) => [p.dark, mid, p.light];

// ---------------------------------------------------------------------------------------------------
// Styles. Each builds the poster / hero / wall version of one school.

function riso(p: Press) {
  const { W, H, M, wide, rng, energy } = p;
  // Riso needs light paper: dark sets print their inks on cream instead.
  const paper = isDarkPaper(p.inks) ? "#f3ede2" : p.inks.paper;
  const drumA = L(p.inks.ink) < 140 ? p.inks.ink : "#1b2a9e"; // the photo drum: dark enough to hold a picture
  const drumB = p.inks.pop !== paper ? p.inks.pop : p.inks.alt; // the loud drum
  const drumC = p.inks.alt;
  const mis = () => [rng.gauss() * (1 + 5 * energy), rng.gauss() * (1 + 5 * energy)] as const;
  const shift = (el: El) => {
    const [dx, dy] = mis();
    el.tf = { cx: W / 2, cy: H / 2, rot: rng.gauss() * 0.004 * energy, dx, dy };
    return el;
  };
  p.stampColor = drumA;
  p.els.push({ k: "fill", color: paper, enter: ENTER.ground() });
  const A = p.imgs[p.hero], B = p.imgs[p.ground];
  const fine = lerp(6.2, 8.5, rng.next()), coarse = lerp(15, 26, rng.next());

  if (p.format === "wall") {
    const fa = frame(A, { x: 0, y: 0, w: W, h: H }, [0.5, 0.5], 0.7);
    p.els.push(shift({ k: "dots", src: p.hero, fit: fa, cell: fine * 1.3, angle: 0.785, color: drumA, maxR: 0.62, gamma: 0.9, clip: null, blend: "multiply", enter: ENTER.pass(0) }));
    p.els.push(shift({ k: "dots", src: p.ground, fit: frame(B, { x: 0, y: 0, w: W, h: H }), cell: coarse * 1.4, angle: 0.26, color: drumB, maxR: 0.6, gamma: 1.2, clip: null, blend: "multiply", enter: ENTER.pass(1, 0) }));
    const third = p.extras[0] ?? p.hero;
    const band = wide ? rect(W * rng.range(0.5, 0.7), 0, W * 0.3, H) : rect(0, H * rng.range(0.55, 0.7), W, H * 0.24);
    p.els.push(shift({ k: "dots", src: third, fit: frame(p.imgs[third], { x: 0, y: 0, w: W, h: H }), cell: coarse * 0.9, angle: 1.3, color: drumC, maxR: 0.66, gamma: 1, clip: [band], blend: "multiply", enter: ENTER.pass(2) }));
    return;
  }

  // The photo block: hero in the dark drum, bleeding off one side.
  const side = rng.next() < 0.5 ? 0 : 1;
  const block: Box = wide
    ? { x: W * (side ? 0.4 : -0.02), y: -H * 0.02, w: W * 0.62, h: H * 1.04 }
    : { x: side ? W * 0.16 : -W * 0.02, y: M * 2.2 + wordH(p) * 0.8, w: W * 0.86, h: H - M * 4.4 - wordH(p) * 0.8 };
  const fa = frame(A, block, [0.5, 0.45], 0.85);
  p.els.push(shift({ k: "dots", src: p.hero, fit: fa, cell: fine, angle: 0.785, color: drumA, maxR: 0.66, gamma: 0.85, clip: [rect(block.x, block.y, block.w, block.h)], blend: "multiply", enter: ENTER.pass(0) }));

  // The loud drum: ground photo in coarse dots inside one bold shape that overlaps the block.
  const r = Math.min(W, H) * rng.range(0.3, 0.4);
  const sun: Shape = wide
    ? { k: "circle", cx: side ? W * 0.42 : W * 0.6, cy: H * rng.range(0.55, 0.7), r }
    : { k: "circle", cx: side ? W * 0.24 : W * 0.76, cy: H * rng.range(0.42, 0.5), r };
  const fb = frame(B, shapeBox(sun));
  p.els.push(shift({ k: "dots", src: p.ground, fit: fb, cell: coarse, angle: 0.26, color: drumB, maxR: 0.64, gamma: 0.8, clip: [sun], blend: "multiply", enter: ENTER.pass(1, 0) }));
  crispFromHere(p);

  // Word in the loud drum, overprinted (multiply), with a misregistered ghost in the third ink.
  const box: Box = wide ? { x: side ? M : W * 0.62, y: H * 0.2, w: W * 0.36, h: H * 0.5 } : { x: M, y: M * 2.2, w: W - 2 * M, h: wordH(p) };
  const align = wide && !side ? "right" : "left";
  const fit = wide ? "box" : "fill";
  const ghost = word(p, box, drumC, { blend: "multiply", align, fit, enter: ENTER.word(-0.04) });
  ghost.tf = { cx: W / 2, cy: H / 2, rot: 0, dx: 3 + 5 * energy, dy: 2 + 4 * energy };
  word(p, box, drumB, { blend: "multiply", align, fit });

  if (wide) {
    micro(p, p.sub, box.x, H * 0.74, box.w, drumA, align, p.u * 1.5);
    micro(p, p.meta.inks, box.x, H * 0.74 + p.u * 2.6, box.w, drumA, align);
  } else {
    const fy = H - M - p.u * 1.2;
    micro(p, p.sub, M, fy, W * 0.45, drumA, "left", p.u * 1.2);
    micro(p, p.meta.inks, W - M - W * 0.5, fy, W * 0.5, drumA, "right");
  }
  micro(p, p.meta.edition, M, M, W * 0.4, drumA);
  micro(p, p.meta.day, W - M - W * 0.4, M, W * 0.4, drumA, "right");
  p.stampCorner = wide ? (side ? 3 : 2) : -1;
}

function sandwich(p: Press) {
  const { W, H, M, wide, rng, energy } = p;
  const A = p.imgs[p.hero], B = p.imgs[p.ground];
  const mid = L(p.inks.alt) > 150 && p.inks.alt !== p.light ? p.inks.alt : p.inks.pop;
  const groundTreat: Treat = { k: "map", stops: [p.dark, mid], contrast: 1.15 };
  const sticker = L(p.inks.paper) > 200 ? p.inks.paper : "#f6f1e6";
  const wordInk = loudOn(mid, [p.inks.pop, p.inks.alt, p.light].filter((c) => c !== mid), 2.2);

  if (p.format === "wall") {
    // Sticker bomb: every photo cut up and slapped on a loud ground, stratified so nothing is left bare.
    p.els.push({ k: "fill", color: p.inks.pop, enter: ENTER.ground() });
    p.els.push({ k: "dots", src: -1, fit: null, cell: 18, angle: 0.4, color: p.dark, maxR: 0.5, gamma: 1, flat: 0.25, clip: null, blend: "source-over", alpha: 0.5, enter: ENTER.ground() });
    const g = Math.round(lerp(3, 5, energy));
    const gx = wide ? Math.round(g * 1.6) : g, gy = wide ? g : Math.round(g * 1.6);
    const cells = rng.shuffle(Array.from({ length: gx * gy }, (_, i) => i));
    cells.forEach((c, i) => {
      const src = i % p.imgs.length;
      const img = p.imgs[src];
      const size = (Math.max(W / gx, H / gy)) * rng.range(1.15, 1.6);
      const cx = ((c % gx) + rng.range(0.2, 0.8)) * (W / gx), cy = (Math.floor(c / gx) + rng.range(0.2, 0.8)) * (H / gy);
      const box: Box = { x: cx - size / 2, y: cy - size / 2, w: size, h: size * rng.range(0.75, 1.25) };
      const fit = frame(img, box, [0.5, 0.5], 0.8);
      const strong = img.analysis.subject.strength > 0.25 && rng.next() < 0.6;
      const pts = strong ? clampPts(cutOutline(img, fit, rng, 1.25, 14, 0.05), box) : roughRect(box, rng, size * 0.02);
      const treat: Treat = i % 3 === 2 ? { k: "map", stops: [p.dark, p.inks.alt], contrast: 1.2 } : { k: "color", punch: 0.5 };
      p.els.push({
        k: "image", src, fit, treat, clip: [{ k: "poly", pts }], border: { w: 9, color: sticker }, shadow: { dx: 7, dy: 9, color: p.dark },
        tf: { cx, cy, rot: rng.gauss() * 0.35 }, enter: { at: 0.1 + (i / cells.length) * 0.7, dur: 0.16, kind: "drop" },
      });
    });
    p.stampColor = p.dark;
    return;
  }

  // Ground: the second photo, duotoned dark → mid so the colour sticker owns the page.
  p.els.push({ k: "image", src: p.ground, fit: frame(B, { x: 0, y: 0, w: W, h: H }), treat: groundTreat, clip: null, enter: ENTER.ground() });
  crispFromHere(p);

  // Word behind; the sticker covers its lower part, one letter comes back in front.
  const wTop = M * 2.4;
  const wH = wide ? H * 0.5 : wordH(p, 0.2, 0.34);
  const wbox: Box = wide ? { x: M, y: H * 0.22, w: W * 0.6, h: wH } : { x: M * 0.8, y: wTop, w: W - M * 1.6, h: wH };
  const wEl = word(p, wbox, wordInk, { shadow: { dx: 6, dy: 7, color: p.dark }, align: wide ? "left" : "center", fit: wide ? "box" : "fill" });

  // The sticker: hero subject, scissor-cut, full colour, paper edge, hard shadow, bleeding off the bottom.
  const area: Box = wide
    ? { x: W * 0.5, y: H * 0.12, w: W * 0.44, h: H * 0.98 }
    : { x: W * 0.17, y: wTop + wH * 0.8, w: W * 0.66, h: H - (wTop + wH * 0.8) + H * 0.04 };
  const fa = frame(A, area, [0.5, 0.5], 0.55);
  const cut = A.analysis.subject.strength > 0.18 ? clampPts(cutOutline(A, fa, rng, 1.22, 15, 0.05), area) : roughRect(area, rng, 8);
  const cutShape: Shape = { k: "poly", pts: cut };
  const cb = shapeBox(cutShape);
  const rot = rng.gauss() * lerp(0.02, 0.08, energy);
  p.els.push({
    k: "image", src: p.hero, fit: fa, treat: { k: "color", punch: 0.45 }, clip: [cutShape], border: { w: 11, color: sticker }, shadow: { dx: 10, dy: 12, color: p.dark },
    tf: { cx: cb.x + cb.w / 2, cy: cb.y + cb.h / 2, rot }, enter: ENTER.drop(0.08),
  });

  // Sandwich: one letter re-printed in front at the sticker's edge, never over the face. Latin only —
  // Devanagari conjuncts can't be split by glyph.
  if (!DEVA.test(p.word)) p.els.push({ ...wEl, front: { box: cb, side: rng.next() < 0.5 ? "left" : "right" }, enter: ENTER.word(0.2) });

  // The echo runs up the bare strip of ground beside the sticker.
  if (p.echo && !wide) {
    const len = H * 0.36, thick = Math.min(W * 0.075, cb.x - M * 0.4);
    if (thick > W * 0.04) {
      const cx = M * 0.3 + thick / 2, cy = H - M * 1.5 - len / 2;
      p.els.push({ k: "text", text: p.echo, font: p.echoFont, box: { x: cx - len / 2, y: cy - thick / 2, w: len, h: thick }, fit: "box", align: "left", valign: "middle", fill: p.light, tf: { cx, cy, rot: -Math.PI / 2 }, enter: ENTER.word(0.12) });
    }
  } else if (p.echo) {
    p.els.push({ k: "text", text: p.echo, font: p.echoFont, box: { x: M, y: H * 0.76, w: W * 0.36, h: H * 0.11 }, fit: "box", align: "left", valign: "top", fill: p.light, enter: ENTER.word(0.12) });
  }
  micro(p, p.meta.edition, M, M, W * 0.3, p.light);
  micro(p, p.sub, W - M - W * 0.55, M, W * 0.55, p.light, "right");
  if (wide) micro(p, p.meta.inks, M, H - M - p.u, W * 0.45, p.light);
  p.stampCorner = wide ? 2 : -1;
  p.stampColor = p.light;
}

/** Keep a cut inside its area (plus a hair), so a diffuse subject can't swallow the page. */
function clampPts(pts: number[], b: Box): number[] {
  const px = b.w * 0.04, py = b.h * 0.04;
  return pts.map((v, i) => (i % 2 ? clamp(v, b.y - py, b.y + b.h + py) : clamp(v, b.x - px, b.x + b.w + px)));
}

function swiss(p: Press) {
  const { W, H, M, wide, rng } = p;
  const A = p.imgs[p.hero], B = p.imgs[p.ground];
  // Field: the loud ink if dark ink reads on it, else paper.
  const field = contrast(p.dark, p.inks.pop) >= 4 ? p.inks.pop : contrast(p.dark, p.inks.alt) >= 4 ? p.inks.alt : p.light;
  const ink = bestOn(field, [p.dark, p.light]);
  const second = [p.inks.pop, p.inks.alt, p.light].find((c) => c !== field && contrast(c, field) > 1.6) ?? p.light;
  p.els.push({ k: "fill", color: field, enter: ENTER.ground() });
  p.stampColor = ink;

  const cols = wide ? 12 : 6;
  const g = Math.min(W, H) * 0.014;
  const cw = (W - 2 * M - (cols - 1) * g) / cols;
  const colX = (i: number) => M + i * (cw + g);
  const span = (n: number) => n * cw + (n - 1) * g;

  if (p.format === "wall") {
    // Bauhaus tiles: a grid of primitives, some flat ink, some windows into the photos.
    const n = Math.round(lerp(4, 7, p.energy));
    const cell = Math.max(W, H) / n;
    const nx = Math.ceil(W / cell), ny = Math.ceil(H / cell);
    let k = 0;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const x = i * cell, y = j * cell, kind = rng.int(0, 4), rot = rng.int(0, 3) * (Math.PI / 2);
        const cxy = [x + cell / 2, y + cell / 2] as const;
        const bg = rng.pick([field, ink, second, field]);
        p.els.push({ k: "shape", shapes: [rect(x, y, cell + 0.5, cell + 0.5)], fill: bg, enter: { at: 0.05 + (k / (nx * ny)) * 0.5, dur: 0.12, kind: "fade" } });
        const shape: Shape =
          kind === 0 ? { k: "circle", cx: cxy[0], cy: cxy[1], r: cell / 2 }
          : kind === 1 ? { k: "arch", x, y: y + cell / 2, w: cell, h: cell / 2 }
          : kind === 2 ? { k: "poly", pts: [x, y + cell, x + cell, y + cell, x + cell, y] }
          : kind === 3 ? { k: "arch", x, y: y + cell, w: cell, h: 0 }
          : { k: "circle", cx: x, cy: y + cell, r: cell };
        const src = (k + j) % p.imgs.length;
        const useImg = rng.next() < 0.55;
        const tf: Tf = { cx: cxy[0], cy: cxy[1], rot };
        const enter: Enter = { at: 0.2 + (k / (nx * ny)) * 0.6, dur: 0.18, kind: "wipe", dir: rot };
        if (useImg) {
          const img = p.imgs[src];
          p.els.push({ k: "image", src, fit: frame(img, { x, y, w: cell, h: cell }, [0.5, 0.5], 0.9), treat: { k: "map", stops: [ink === p.dark ? p.dark : bg === p.dark ? p.light : p.dark, rng.pick([field, second, p.light].filter((c) => c !== bg))], contrast: 1.25 }, clip: [shape], tf, enter });
        } else p.els.push({ k: "shape", shapes: [shape], fill: rng.pick([field, ink, second].filter((c) => c !== bg)), tf, enter });
        k++;
      }
    return;
  }

  const left = rng.next() < 0.5;
  // Big arch window: hero photo as a one-ink duotone, base bleeding off the bottom.
  const aw = wide ? span(5) : span(4);
  const ax = wide ? colX(left ? 6 : 1) : colX(left ? 0 : 2);
  const aTop = wide ? H * 0.34 : H * 0.44;
  const arch: Shape = { k: "arch", x: ax, y: aTop, w: aw, h: H };
  const ab = shapeBox(arch);
  const archTreat: Treat = rng.next() < 0.6 ? { k: "map", stops: [ink, ink === p.dark ? p.light : p.dark], contrast: 1.3 } : { k: "color", punch: 0.35 };
  p.els.push({ k: "image", src: p.hero, fit: frame(A, { ...ab, h: Math.min(ab.h, H - ab.y) }, [0.5, 0.42], 0.8), treat: archTreat, clip: [arch], enter: ENTER.pass(0, -Math.PI / 2) });

  // Circle window: ground photo in the second ink, overlapping the arch's edge.
  const cr = wide ? span(2.6) / 2 + g : span(2.7) / 2;
  const ccx = left ? ax + aw + cr * 0.15 : ax - cr * 0.15;
  const ccy = aTop - cr * 0.15;
  const circ: Shape = { k: "circle", cx: clamp(ccx, cr * 0.6, W - cr * 0.6), cy: ccy, r: cr };
  p.els.push({ k: "image", src: p.ground, fit: frame(B, shapeBox(circ)), treat: { k: "map", stops: [ink === p.dark ? p.dark : p.light, second], contrast: 1.2 }, clip: [circ], enter: ENTER.pass(1, 0) });
  crispFromHere(p);

  // Word: flush left, set to fill the width (scale shock); type runs the full measure.
  headerRow(p, M, ink, [p.meta.edition, p.meta.ratio, p.meta.day]);
  const top = M + p.u * 2.4;
  if (wide) {
    const tx = left ? colX(0) : colX(7);
    word(p, { x: tx, y: H * 0.32, w: span(5) + g * 0.5, h: H * 0.42 }, ink);
    micro(p, p.sub, tx, H * 0.78, span(5), ink, "left", p.u * 1.5);
    micro(p, p.meta.inks, tx, H * 0.78 + p.u * 2.6, span(5), ink);
  } else {
    word(p, { x: M, y: top, w: W - 2 * M, h: aTop - cr - top - g * 2 }, ink);
    const subX = left ? colX(4) : colX(0);
    micro(p, p.sub, subX, H - M - p.u * 7, span(2), ink, left ? "right" : "left");
    micro(p, p.meta.inks, subX, H - M - p.u * 4.4, span(2), ink, left ? "right" : "left");
  }
  p.stampCorner = 2;
}

function pop(p: Press) {
  const { W, H, M, wide, rng, energy } = p;
  const B = p.imgs[p.ground];
  const field = L(p.inks.alt) > 120 ? p.inks.alt : p.light;
  const dotInk = contrast(p.inks.pop, field) > 1.4 ? p.inks.pop : p.dark;
  const ink = p.dark === "#f1ead8" || L(p.dark) > 100 ? "#0d0c0b" : p.dark;
  const outline = Math.min(W, H) * 0.012;
  p.els.push({ k: "fill", color: field, enter: ENTER.ground() });
  p.els.push({ k: "dots", src: -1, fit: null, cell: lerp(13, 20, rng.next()), angle: 0.785, color: dotInk, maxR: 0.5, gamma: 1, flat: 0.55, clip: null, enter: ENTER.ground() });
  p.stampColor = ink;

  const panel = (src: number, box: Box, rot: number, treat: Treat, at: number) => {
    const img = p.imgs[src];
    const shape = rect(box.x, box.y, box.w, box.h);
    p.els.push({
      k: "image", src, fit: frame(img, box, [0.5, 0.45], 0.8), treat, clip: [shape], border: { w: outline, color: ink }, shadow: { dx: outline * 1.1, dy: outline * 1.3, color: ink },
      tf: { cx: box.x + box.w / 2, cy: box.y + box.h / 2, rot }, enter: { at, dur: 0.24, kind: "drop" },
    });
  };
  const comic: Treat = { k: "color", punch: 0.7, posterize: 5 };

  if (p.format === "wall") {
    // Comic page: irregular panel grid, every photo in, bursts between.
    const rows = wide ? 2 : 3;
    let k = 0;
    for (let j = 0; j < rows; j++) {
      const cols = rng.int(2, 3);
      const cuts = Array.from({ length: cols - 1 }, () => rng.range(0.25, 0.75)).sort();
      const xs = [0, ...cuts, 1];
      for (let i = 0; i < cols; i++) {
        const gut = M * 0.6;
        const box: Box = { x: xs[i] * W + gut / 2, y: (j / rows) * H + gut / 2, w: (xs[i + 1] - xs[i]) * W - gut, h: H / rows - gut };
        panel(k % p.imgs.length, box, rng.gauss() * 0.02 * energy, k % 3 === 1 ? { k: "map", stops: [ink, p.inks.pop, field], contrast: 1.2, steps: 4 } : comic, 0.1 + k * 0.08);
        k++;
      }
    }
    const b = burst(rng.range(0.25, 0.75) * W, rng.range(0.25, 0.75) * H, Math.min(W, H) * 0.12, Math.min(W, H) * 0.22, rng.int(12, 18), rng);
    p.els.push({ k: "shape", shapes: [b], fill: p.inks.pop, stroke: { w: outline, color: ink }, enter: ENTER.word() });
    return;
  }

  // Burst behind the hero panel.
  const hb: Box = wide ? { x: W * 0.5, y: H * 0.12, w: W * 0.42, h: H * 0.7 } : { x: W * 0.12, y: H * 0.36, w: W * 0.76, h: H * 0.5 };
  const bb = burst(hb.x + hb.w * 0.5, hb.y + hb.h * 0.5, Math.max(hb.w, hb.h) * 0.52, Math.max(hb.w, hb.h) * 0.78, rng.int(14, 22), rng);
  p.els.push({ k: "shape", shapes: [bb], fill: p.inks.pop === field ? p.light : p.inks.pop, stroke: { w: outline, color: ink }, enter: ENTER.pass(0) });
  panel(p.hero, hb, rng.gauss() * lerp(0.02, 0.07, energy), comic, 0.3);

  // Second photo: small round inset in halftone, overlapping the panel corner.
  const r = Math.min(W, H) * 0.17;
  const c: Shape = { k: "circle", cx: wide ? hb.x + hb.w * 0.02 : hb.x + hb.w * (rng.next() < 0.5 ? 0.04 : 0.96), cy: hb.y + hb.h * 0.92, r };
  p.els.push({ k: "shape", shapes: [c], fill: p.light, stroke: { w: outline, color: ink }, shadow: { dx: outline, dy: outline * 1.2, color: ink }, enter: ENTER.drop(0.1) });
  p.els.push({ k: "image", src: p.ground, fit: frame(B, shapeBox(c), [0.5, 0.5], 0.7), treat: comic, clip: [c], enter: ENTER.drop(0.12) });
  crispFromHere(p);

  // Word: fat, outlined, shadowed, tilted.
  const wbox: Box = wide ? { x: M, y: H * 0.18, w: W * 0.44, h: H * 0.5 } : { x: M, y: M * 2, w: W - 2 * M, h: wordH(p, 0.18, 0.3) };
  const fill = loudOn(field, [p.inks.pop, p.light, p.inks.alt], 1.5);
  word(p, wbox, fill === field ? p.light : fill, {
    font: "shrikhand", lh: 1.0, stroke: { w: outline * 1.2, color: ink }, shadow: { dx: outline * 1.1, dy: outline * 1.4, color: ink }, align: wide ? "left" : "center",
    tf: { cx: wbox.x + wbox.w / 2, cy: wbox.y + wbox.h / 2, rot: -lerp(0.03, 0.09, energy) },
  });

  // Speech bubble carries the line.
  const bw = wide ? W * 0.3 : W * 0.5, bh = Math.min(W, H) * 0.1;
  const bx = wide ? M : W - M - bw, by = wide ? H * 0.74 : wbox.y + wbox.h + M * 0.8;
  const tailX = bx + bw * (wide ? 0.8 : 0.3);
  p.els.push({
    k: "shape",
    shapes: [{ k: "poly", smooth: true, pts: ellipsePts(bx + bw / 2, by + bh / 2, bw / 2, bh / 2, 28) }, { k: "poly", pts: [tailX - bw * 0.06, by + bh * 0.8, tailX + bw * 0.05, by + bh * 0.8, tailX + (wide ? bw * 0.3 : -bw * 0.02), by + bh * 1.6] }],
    fill: "#ffffff", stroke: { w: outline * 0.8, color: ink }, enter: ENTER.micro(-0.06),
  });
  p.els.push({ k: "text", text: p.sub, font: "anton", box: { x: bx + bw * 0.14, y: by + bh * 0.22, w: bw * 0.72, h: bh * 0.56 }, fit: "box", align: "center", valign: "middle", fill: ink, enter: ENTER.micro(-0.04) });
  micro(p, `${p.meta.edition} · ${p.meta.day}`, M, H - M - p.u, W * 0.6, ink);
  p.stampCorner = 2;
}

function ellipsePts(cx: number, cy: number, rx: number, ry: number, n: number) {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(cx + Math.cos((i / n) * Math.PI * 2) * rx, cy + Math.sin((i / n) * Math.PI * 2) * ry);
  return out;
}

function slices(p: Press) {
  const { W, H, M, wide, rng, energy } = p;
  const A = p.imgs[p.hero], B = p.imgs[p.ground];
  const full: Box = { x: 0, y: 0, w: W, h: H };
  const focus: [number, number] = [0.5, wide ? 0.5 : 0.4];
  const angle = p.format === "wall" ? rng.pick([0.4, -0.4, Math.PI / 2 + 0.3]) : rng.pick([0, 0, Math.PI / 2, rng.range(-0.45, 0.45)]);
  const tA: Treat = { k: "map", stops: triStops(p, p.inks.pop), contrast: 1.2 };
  const tB: Treat = rng.next() < 0.5 ? { k: "map", stops: triStops(p, p.inks.alt === p.light ? p.inks.pop : p.inks.alt), contrast: 1.2 } : { k: "color", punch: 0.4 };
  p.els.push({ k: "image", src: p.ground, fit: frame(B, full, focus, 0.75), treat: tB, clip: null, enter: ENTER.ground() });

  // Strips across the canvas at `angle`; in each, the hero takes a share that falls from 1 to 0.
  const n = Math.round(lerp(8, 22, energy));
  const D = Math.hypot(W, H);
  const step = D / n;
  const strips = (srcShare: (t: number) => number): Shape[] => {
    const out: Shape[] = [];
    const c = Math.cos(angle), s = Math.sin(angle);
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const share = srcShare(t);
      if (share <= 0.02) continue;
      const off = -D / 2 + i * step + (step * share) / 2;
      const cx = W / 2 + c * off, cy = H / 2 + s * off;
      out.push({ k: "poly", pts: rotRect(cx, cy, step * share, D * 1.2, angle) });
    }
    return out;
  };
  if (p.format === "wall" && p.imgs.length > 2) {
    const C = p.extras[0];
    p.els.push({ k: "image", src: p.hero, fit: frame(A, full, focus, 0.75), treat: tA, clip: strips((t) => (Math.floor(t * n) % 3 === 0 ? 0.9 : 0)), enter: ENTER.pass(0, angle) });
    p.els.push({ k: "image", src: C, fit: frame(p.imgs[C], full, focus, 0.75), treat: { k: "map", stops: triStops(p, p.inks.alt), contrast: 1.2 }, clip: strips((t) => (Math.floor(t * n) % 3 === 1 ? 0.9 : 0)), enter: ENTER.pass(1, angle) });
    return;
  }
  const curve = p.format === "wall" ? (t: number) => 0.5 + 0.45 * Math.sin(t * Math.PI * 3) : (t: number) => clamp(1.15 - t * 1.3, 0, 1);
  p.els.push({ k: "image", src: p.hero, fit: frame(A, full, focus, 0.75), treat: tA, clip: strips(curve), enter: ENTER.pass(0, angle) });
  if (p.format === "wall") return;
  crispFromHere(p);

  // A solid band holds the word, so it reads over the moiré.
  const bandInk = p.dark;
  const wordInk = loudOn(bandInk, [p.inks.pop, p.inks.alt, p.light], 3);
  if (wide) {
    const bw = W * 0.4, bx = rng.next() < 0.5 ? 0 : W - bw;
    p.els.push({ k: "shape", shapes: [rect(bx, 0, bw, H)], fill: bandInk, enter: { at: 0.45, dur: 0.2, kind: "wipe", dir: Math.PI / 2 } });
    word(p, { x: bx + M, y: H * 0.2, w: bw - 2 * M, h: H * 0.5 }, wordInk);
    micro(p, p.sub, bx + M, H * 0.76, bw - 2 * M, p.light, "left", p.u * 1.5);
    micro(p, p.meta.inks, bx + M, H * 0.76 + p.u * 2.6, bw - 2 * M, p.light);
    micro(p, `${p.meta.edition} · ${p.meta.day}`, bx + M, M, bw - 2 * M, p.light);
    p.stampCorner = bx ? 1 : 0;
  } else {
    const bh = wordH(p, 0.2, 0.34) + M * 2.4;
    const by = rng.next() < 0.6 ? H - bh : 0;
    p.els.push({ k: "shape", shapes: [rect(0, by, W, bh)], fill: bandInk, enter: { at: 0.45, dur: 0.2, kind: "wipe", dir: 0 } });
    word(p, { x: M, y: by + M * 0.8, w: W - 2 * M, h: bh - M * 2.2 }, wordInk, { fit: "width", align: "center", valign: "middle" });
    headerRow(p, by + bh - M * 0.6 - p.u, p.light, [p.meta.edition, p.sub, p.meta.day]);
    p.stampCorner = by ? 0 : 2;
  }
  p.stampColor = p.light;
}

function monument(p: Press) {
  const { W, H, M, wide, rng, energy } = p;
  const A = p.imgs[p.hero], B = p.imgs[p.ground];
  // Flat loud field; the photos live only inside the letters.
  const field = rng.pick([p.inks.pop, p.inks.alt].filter((c) => contrast(c, p.dark) >= 3).concat(p.light));
  const ink = bestOn(field, [p.dark, p.light]);
  p.els.push({ k: "fill", color: field, enter: ENTER.ground() });
  p.stampColor = ink;
  const punch: Treat = { k: "color", punch: 0.55 };

  if (p.format === "wall") {
    // Type wall: the word in tight stretched rows, each row a window into a different photo, offset like brick.
    const rows = wide ? 4 : 6;
    const rh = H / rows;
    for (let j = 0; j < rows; j++) {
      const src = j % p.imgs.length;
      const box: Box = { x: -W * (j % 2 ? 0.2 : 0.04), y: j * rh + rh * 0.04, w: W * 1.5, h: rh * 0.92 };
      p.els.push({
        k: "text", text: `${p.word} ${p.word} ${p.word}`, font: p.wordFont === "rozha" ? "rozha" : "anton", box, fit: "fill", align: "left", valign: "middle", fill: ink, lh: 0.9,
        image: { src, fit: frame(p.imgs[src], { x: 0, y: j * rh, w: W, h: rh }, [0.5, 0.5], 0.9), treat: punch },
        enter: { at: 0.15 + j * 0.08, dur: 0.2, kind: "wipe", dir: j % 2 ? Math.PI : 0 },
      });
    }
    return;
  }

  crispFromHere(p);
  const face: FontKey = p.wordFont === "rozha" ? "rozha" : "anton";
  const stroke = { w: lerp(2, 4, energy), color: ink };
  const top = M + p.u * 2.6;
  const foot = p.u * 5.5;
  // Two stretched lines fill the sheet: the word holds the hero, the second line holds the ground photo.
  const second = p.echo || p.sub;
  const secondFont: FontKey = DEVA.test(second) ? "rozha" : "anton";
  const avail = H - top - M - foot;
  const split = wide ? 0.62 : lerp(0.56, 0.66, p.scale);
  const g = M * 0.35;
  const b1: Box = { x: M * 0.5, y: top, w: W - M, h: avail * split - g / 2 };
  const b2: Box = { x: M * 0.5, y: top + avail * split + g / 2, w: W - M, h: avail * (1 - split) - g / 2 };
  word(p, b1, ink, { font: face, fit: "fill", align: "center", valign: "middle", lh: face === "rozha" ? 1.1 : 0.86, image: { src: p.hero, fit: frame(A, b1, [0.5, 0.45], 0.75), treat: punch }, stroke, enter: { at: 0.25, dur: 0.35, kind: "wipe", dir: Math.PI / 2 } });
  p.els.push({
    k: "text", text: second, font: secondFont, box: b2, fit: "fill", align: "center", valign: "middle", fill: ink, lh: 0.9,
    image: { src: p.ground, fit: frame(B, b2, [0.5, 0.5], 0.8), treat: punch }, stroke, enter: { at: 0.45, dur: 0.3, kind: "wipe", dir: -Math.PI / 2 },
  });
  headerRow(p, M, ink, [p.meta.edition, p.meta.count, p.meta.day]);
  micro(p, second === p.sub ? p.meta.ratio : p.sub, M, H - M - p.u * 1.2, W * 0.45, ink, "left", p.u * 1.2);
  micro(p, p.meta.inks, W - M - W * 0.5, H - M - p.u * 1.2, W * 0.5, ink, "right");
  p.stampCorner = -1;
}

function smear(p: Press) {
  const { W, H, M, wide, rng } = p;
  const A = p.imgs[p.hero], B = p.imgs[p.ground];
  const tA: Treat = rng.next() < 0.5 ? { k: "color", punch: 0.55 } : { k: "map", stops: triStops(p, p.inks.pop), contrast: 1.25 };

  if (p.format === "wall") {
    const bands = wide ? 3 : 4;
    for (let i = 0; i < bands; i++) {
      const src = i % p.imgs.length;
      const b: Box = wide ? { x: (i * W) / bands, y: 0, w: W / bands + 1, h: H } : { x: 0, y: (i * H) / bands, w: W, h: H / bands + 1 };
      const at = wide ? b.y + b.h * rng.range(0.25, 0.4) : b.x + b.w * rng.range(0.3, 0.5);
      p.els.push({ k: "image", src, fit: frame(p.imgs[src], b, [0.5, 0.5], 0.6), treat: i % 2 ? tA : { k: "color", punch: 0.5 }, clip: [rect(b.x, b.y, b.w, b.h)], smear: { at, dir: wide ? "down" : "right" }, enter: ENTER.pass(i * 0.6, wide ? Math.PI / 2 : 0) });
    }
    p.stampColor = "#ffffff";
    return;
  }

  // The hero holds the top (or left); one row of its pixels is dragged to the far edge.
  const cut = wide ? W * rng.range(0.42, 0.5) : H * rng.range(0.46, 0.55);
  const hold: Box = wide ? { x: 0, y: 0, w: cut, h: H } : { x: 0, y: 0, w: W, h: cut };
  p.els.push({ k: "image", src: p.hero, fit: frame(A, hold, [0.5, wide ? 0.5 : 0.55], 0.8), treat: tA, clip: null, smear: { at: cut, dir: wide ? "right" : "down" }, enter: ENTER.ground() });

  // The second photo: a sharp print laid on the smear.
  const ib: Box = wide ? { x: W * 0.56, y: H * 0.52, w: W * 0.2, h: H * 0.36 } : { x: M, y: H * 0.62, w: W * 0.36, h: H * 0.24 };
  p.els.push({ k: "image", src: p.ground, fit: frame(B, ib, [0.5, 0.5], 0.6), treat: { k: "map", stops: [p.dark, p.light], contrast: 1.3 }, clip: [rect(ib.x, ib.y, ib.w, ib.h)], border: { w: 8, color: p.light }, enter: ENTER.drop(0.05) });
  crispFromHere(p);

  // Word rides the smear: loud ink, dark outline, reads on any streak.
  const fill = loudOn(p.dark, [p.inks.pop, p.inks.alt, p.light], 3);
  const outline = { w: 4, color: p.dark };
  if (wide) {
    word(p, { x: W * 0.54, y: M * 1.5, w: W * 0.42, h: H * 0.42 }, fill, { align: "left", stroke: outline, shadow: { dx: 6, dy: 7, color: p.dark } });
    p.els.push({ k: "shape", shapes: [rect(ib.x + ib.w + M * 0.3, ib.y - M * 0.3, W - ib.x - ib.w - M * 1.0, p.u * 5.6)], fill: p.dark, enter: ENTER.micro(-0.04) });
    micro(p, p.sub, ib.x + ib.w + M * 0.6, ib.y, W - ib.x - ib.w - M * 1.6, p.light, "left", p.u * 1.5);
    micro(p, p.meta.inks, ib.x + ib.w + M * 0.6, ib.y + p.u * 2.6, W - ib.x - ib.w - M * 1.6, p.light);
  } else {
    // Vertical, up the right edge, the full height of the smear.
    const len = H - cut + H * 0.12 - M, thick = W * lerp(0.2, 0.3, p.scale);
    const bx = W - M - thick / 2, by = H - M - len / 2;
    p.els.push({
      k: "text", text: p.word, font: p.wordFont === "rozha" ? "rozha" : "anton", box: { x: bx - len / 2, y: by - thick / 2, w: len, h: thick }, fit: "box", align: "left", valign: "middle", fill,
      lh: 0.86, tf: { cx: bx, cy: by, rot: -Math.PI / 2 }, stroke: outline, shadow: { dx: 6, dy: 7, color: p.dark }, enter: ENTER.word(),
    });
    p.els.push({ k: "shape", shapes: [rect(ib.x - M * 0.3, ib.y + ib.h + M * 0.25, W * 0.5 + M * 0.6, p.u * 5.6)], fill: p.dark, enter: ENTER.micro(-0.04) });
    micro(p, p.sub, ib.x, ib.y + ib.h + M * 0.5, W * 0.5, p.light, "left", p.u * 1.5);
    micro(p, p.meta.inks, ib.x, ib.y + ib.h + M * 0.5 + p.u * 2.6, W * 0.5, p.light);
  }
  micro(p, `${p.meta.edition} · ${p.meta.day}`, M, M, W * 0.5, "#ffffff");
  p.stampCorner = wide ? 2 : -1;
  p.stampColor = fill;
}

function kaleido(p: Press) {
  const { W, H, M, wide, rng } = p;
  const A = p.imgs[p.hero], B = p.imgs[p.ground];
  const n = rng.pick([6, 8, 10, 12]);
  // The mirror's centre sits off-axis (a third in), so the pattern runs off two edges.
  const cx = W * rng.pick([0.36, 0.64]), cy = p.format === "wall" ? H * 0.5 : wide ? H * 0.42 : H * 0.34;
  // Mirrored wedges sample a full circle around the centre: cover the square that holds it.
  const R = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy));
  const fit = frame(A, { x: cx - R, y: cy - R, w: 2 * R, h: 2 * R }, [0.5, 0.5], 0.55, 2);
  const loud = [p.inks.pop, p.inks.alt].filter((c) => rgbToHsl(parseHex(c))[1] > 0.35 && c !== p.light);
  const t: Treat = { k: "map", stops: triStops(p, loud.length ? rng.pick(loud) : p.inks.pop), contrast: 1.3 };
  p.els.push({ k: "image", src: p.hero, fit, treat: t, clip: null, kaleido: { cx, cy, n, rot: rng.next() * Math.PI }, enter: ENTER.ground() });
  if (p.format === "wall") {
    // A second lens: the other photo's mirror, cropped off a corner, in the opposite inks.
    const lx = cx < W / 2 ? W * 0.92 : W * 0.08, ly = H * 0.86, lr = Math.min(W, H) * 0.62;
    const fb = frame(B, { x: lx - lr, y: ly - lr, w: 2 * lr, h: 2 * lr }, [0.5, 0.5], 0.5, 2);
    p.els.push({ k: "image", src: p.ground, fit: fb, treat: { k: "map", stops: [p.dark, loud.find((c) => c !== t.stops[1]) ?? p.light, p.light], contrast: 1.3 }, clip: [{ k: "circle", cx: lx, cy: ly, r: lr }], border: { w: 10, color: p.dark }, kaleido: { cx: lx, cy: ly, n: n + 2, rot: rng.next() }, enter: ENTER.pass(1) });
    p.stampColor = p.light;
    return;
  }
  crispFromHere(p);
  // A band of the second photo (dark duotone) carries the word.
  const bandTreat: Treat = { k: "map", stops: [p.dark, L(p.dark) < 128 ? "#3a3a3a" : "#c8c8c8"], contrast: 1.1 };
  const wordInk = loudOn(p.dark, [p.inks.pop, p.inks.alt, p.light], 3);
  const bh = wide ? H * 0.34 : wordH(p, 0.18, 0.28) + M * 3, by = H - bh;
  const band: Box = { x: 0, y: by, w: W, h: bh };
  p.els.push({ k: "image", src: p.ground, fit: frame(B, band), treat: bandTreat, clip: [rect(0, by, W, bh)], enter: { at: 0.45, dur: 0.2, kind: "wipe", dir: 0 } });
  if (wide) {
    word(p, { x: M, y: by + M * 0.6, w: W * 0.6, h: bh - M * 1.2 }, wordInk, { valign: "middle" });
    micro(p, p.sub, W * 0.62, by + M, W * 0.38 - M, p.light, "right", p.u * 1.5);
    micro(p, p.meta.inks, W * 0.5, by + M + p.u * 2.6, W * 0.5 - M, p.light, "right");
    micro(p, `${p.meta.edition} · ${p.meta.day}`, W * 0.5, H - M - p.u, W * 0.5 - M, p.light, "right");
  } else {
    word(p, { x: M, y: by + M * 0.8, w: W - 2 * M, h: bh - M * 2.6 }, wordInk, { fit: "width", align: "center", valign: "middle" });
    headerRow(p, H - M * 0.8 - p.u, p.light, [p.meta.edition, p.sub, p.meta.day]);
  }
  p.stampCorner = cx < W / 2 ? 1 : 0;
  p.stampColor = p.light;
}

const STYLE_FNS: Record<Style, (p: Press) => void> = { riso, sandwich, swiss, pop, slices, monument, smear, kaleido };

// ---------------------------------------------------------------------------------------------------

export function planComposition(spec: PieceSpec, images: PlanImage[]): Plan {
  const { seed, settings, recipe } = spec;
  const { w: W, h: H } = designSize(settings.ratio);
  const N = images.length;
  const inks = inkSet(recipe.inks);
  const rRole = forkRng(seed, "roles");
  const rWord = forkRng(seed, "word");
  const rLay = forkRng(seed, `layout:${recipe.variant}:${recipe.remix}`);
  const rFx = forkRng(seed, "fx");

  // Roles: the clearest subject is the hero; the most even, texture-like photo is the ground.
  const order = images
    .map((img, i) => ({ i, s: img.analysis.subject.strength * (1 - Math.abs(img.analysis.subject.w * img.analysis.subject.h - 0.22)) + rRole.next() * 0.25 }))
    .sort((a, b) => b.s - a.s);
  const hero = order[0].i;
  const ground = order[order.length - 1].i;
  const extras = rRole.shuffle(order.slice(1, -1).map((o) => o.i));

  // Words.
  const source = mergePalettes(images.map((i) => i.analysis.palette));
  const lex = LEX[hueFamily(source)];
  const [latin, deva] = rWord.pick(lex);
  const typed = settings.headline.trim();
  const devaHero = !typed && rWord.next() < 0.22 && ["sandwich", "monument", "smear"].includes(recipe.style);
  const wordText = typed ? typed.toUpperCase() : devaHero ? deva : latin;
  const wordFont: FontKey = DEVA.test(wordText) ? "rozha" : recipe.style === "swiss" && rWord.next() < 0.5 ? "unbounded" : "anton";
  const echo = typed ? "" : devaHero ? latin : rWord.next() < 0.5 ? deva : "";
  const echoFont: FontKey = DEVA.test(echo) ? "rozha" : "anton";

  const named = (img: PlanImage, not = "") => {
    const vivid = (c: Swatch) => {
      const [, sat, l] = rgbToHsl(c.rgb);
      return Math.sqrt(c.weight) * (0.25 + sat) * (1 - Math.abs(l - 0.5) * 1.2);
    };
    const names = [...img.analysis.palette].sort((a, b) => vivid(b) - vivid(a)).map((c) => colorName(c.rgb));
    const neutral = ["Ink", "Graphite", "Ash", "Ivory", "Bone", "Slate"];
    return names.find((n) => n !== not && !neutral.includes(n)) ?? names.find((n) => n !== not) ?? names[0] ?? "Ash";
  };
  const nameA = named(images[hero]), nameB = named(images[ground], nameA);
  const sub = `${nameA} × ${nameB}`;

  const dark = L(inks.paper) < L(inks.ink) ? inks.paper : inks.ink;
  const light = dark === inks.paper ? inks.ink : inks.paper;
  const usedInks = recipe.style === "riso" ? [inks.names[2], inks.names[1]] : [inks.names[2], inks.names[1], inks.names[0]];

  const p: Press = {
    W, H, M: Math.min(W, H) * 0.05, u: Math.min(W, H) * 0.015, wide: W > H * 1.15, format: recipe.format, inks, dark, light,
    word: wordText, wordFont, echo, echoFont, sub: sub.toUpperCase(),
    meta: {
      edition: `Nº ${seed.slice(0, 4).toUpperCase()}`,
      day: recipe.day,
      count: `${N} photos → 1 print`,
      inks: `Inks: ${usedInks.join(" + ")}`,
      ratio: settings.ratio,
    },
    imgs: images, hero, ground: ground === hero ? (hero + 1) % N : ground, extras: extras.length ? extras : [hero],
    rng: rLay, energy: settings.energy, scale: settings.scale, els: [], warpBefore: Infinity, stampCorner: 2, stampColor: dark,
  };
  STYLE_FNS[recipe.style](p);

  // Duel child: borrows its other parent's signature detail.
  if (recipe.style2 && recipe.style2 !== recipe.style && recipe.format !== "wall") {
    if (recipe.style2 === "pop" || recipe.style2 === "riso") {
      p.els.splice(Math.min(p.warpBefore, p.els.length), 0, { k: "dots", src: -1, fit: null, cell: 16, angle: 0.785, color: inks.pop, maxR: 0.5, gamma: 1, flat: 0.35, clip: [rect(0, 0, W, H * 0.12), rect(0, H * 0.88, W, H * 0.12)], blend: "multiply", enter: ENTER.micro(-0.1) });
    } else if (recipe.style2 === "sandwich" || recipe.style2 === "smear") {
      const r = Math.min(W, H) * 0.09;
      p.els.push({ k: "shape", shapes: [burst(W - p.M - r, H * 0.5, r * 0.7, r, 12, rFx)], fill: inks.pop, stroke: { w: 6, color: dark }, enter: ENTER.micro() });
    }
  }

  const warp =
    settings.warp > 0.01
      ? {
          amp: settings.warp * 38,
          f: [rFx.range(0.004, 0.012), rFx.range(0.004, 0.012), rFx.range(0.003, 0.01), rFx.range(0.003, 0.01)] as [number, number, number, number],
          p: [rFx.next() * 6.28, rFx.next() * 6.28, rFx.next() * 6.28, rFx.next() * 6.28] as [number, number, number, number],
        }
      : null;

  // ---- Identity: title, stamp, rarity ----
  const traits = [
    inks.id === "gold-black" && "Gold ink",
    DEVA.test(wordText) && "Devanagari",
    recipe.style === "riso" && settings.energy > 0.8 && "Misprint",
    recipe.hybrid && "Hybrid",
    settings.warp > 0.3 && "Melt",
    settings.scale > 0.9 && recipe.format !== "wall" && "Monumental",
    N >= 5 && recipe.format === "wall" && "Full house",
  ].filter(Boolean) as string[];
  const score = traits.length * 2 + (recipe.format === "wall" ? 1 : 0) + (["kaleido", "monument", "riso"].includes(recipe.style) ? 1 : 0) + (recipe.style2 ? 1 : 0);
  const rarity: Rarity = score >= 6 ? "Legendary" : score >= 3 ? "Rare" : "Common";
  let title = `${typed || plain(latin)} — ${nameA} × ${nameB}`;
  if (recipe.remix > 0) title += ` (Variation ${recipe.remix})`;

  return {
    w: W, h: H, style: recipe.style, format: recipe.format, els: p.els,
    warpBefore: Math.min(p.warpBefore, p.els.length), warp,
    texture: settings.texture > 0.01 ? { amount: settings.texture, paper: L(inks.paper) > 128 ? inks.paper : "#f3ede2", ink: dark, seed: parseInt(seed.slice(8, 16), 16) } : null,
    stampColor: p.stampColor, stampCorner: p.stampCorner,
    palette: [inks.paper, inks.ink, inks.pop, inks.alt].sort((a, b) => L(a) - L(b)),
    stamp: { text: seed.slice(0, 4).toUpperCase(), bits: parseInt(seed.slice(4, 8), 16) & 0x7fff },
    title, rarity, score, traits,
  };
}

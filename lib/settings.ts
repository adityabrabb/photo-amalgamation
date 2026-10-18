// Option lists, settings, recipes and the rules that tie moods to cuts / layouts / blend sets.

export const RATIOS = {
  "1:1": 1,
  "4:5": 4 / 5,
  "9:16": 9 / 16,
  "16:9": 16 / 9,
  "A-series": 1 / Math.SQRT2,
} as const;
export type Ratio = keyof typeof RATIOS;

export const MOODS = ["kintsugi", "riso", "dreamscape", "brutal", "glitch", "bauhaus", "botanical"] as const;
export type Mood = (typeof MOODS)[number];
export const MOOD_LABELS: Record<Mood, string> = {
  kintsugi: "Kintsugi",
  riso: "Risograph",
  dreamscape: "Dreamscape",
  brutal: "Brutal",
  glitch: "Glitch",
  bauhaus: "Bauhaus",
  botanical: "Botanical",
};

export const CUTS = ["voronoi", "strips", "blobs", "circles", "triangles", "polygons", "subject"] as const;
export type Cut = (typeof CUTS)[number];
export const CUT_LABELS: Record<Cut, string> = {
  voronoi: "Voronoi shards",
  strips: "Strips",
  blobs: "Torn blobs",
  circles: "Circles & arches",
  triangles: "Triangles",
  polygons: "Random polygons",
  subject: "Subject cut",
};

export const LAYOUTS = ["golden", "radial", "diagonal", "grid", "chaos"] as const;
export type Layout = (typeof LAYOUTS)[number];
export const LAYOUT_LABELS: Record<Layout, string> = {
  golden: "Golden focal",
  radial: "Radial burst",
  diagonal: "Flowing diagonal",
  grid: "Broken grid",
  chaos: "Pure chaos",
};

export const BLEND_SETS = {
  calm: ["soft-light", "multiply"],
  luminous: ["screen", "soft-light", "overlay"],
  contrast: ["overlay", "multiply", "difference"],
  acid: ["difference", "screen"],
  ink: ["multiply"],
  mixed: ["multiply", "screen", "overlay", "difference", "soft-light"],
} as const satisfies Record<string, readonly GlobalCompositeOperation[]>;
export type BlendSet = keyof typeof BLEND_SETS;
export const BLEND_SET_NAMES = Object.keys(BLEND_SETS) as BlendSet[];

export const PALETTE_MODES = ["source", "warm", "cold", "mono", "neon"] as const;
export type PaletteMode = (typeof PALETTE_MODES)[number];

export type Settings = {
  ratio: Ratio;
  mood: Mood | "auto";
  cut: Cut | "auto";
  /** 0 = few big pieces, 1 = many small pieces. */
  density: number;
  chaos: number;
  /** Blend intensity. */
  blend: number;
  palette: PaletteMode;
  /** Liquid warp amount (WebGL displacement). 0 = off. */
  warp: number;
};

export const DEFAULT_SETTINGS: Settings = {
  ratio: "4:5",
  mood: "auto",
  cut: "auto",
  density: 0.45,
  chaos: 0.4,
  blend: 0.55,
  palette: "source",
  warp: 0,
};

/** Fully resolved creative choices. seed + settings + recipe reproduces a piece exactly. */
export type Recipe = {
  mood: Mood;
  /** Secondary mood inherited in Duel mode. */
  mood2: Mood | null;
  cut: Cut;
  layout: Layout;
  blendSet: BlendSet;
  /** Remix generation; 0 = original. */
  remix: number;
  hybrid: boolean;
};

export type PieceKind = "fresh" | "locked" | "remix" | "seed" | "daily" | "duel" | "link";

export type PieceSpec = {
  seed: string;
  settings: Settings;
  recipe: Recipe;
  kind: PieceKind;
  label?: string;
  parents?: string[];
};

type MoodRule = { cuts: readonly Cut[]; layouts: readonly Layout[]; blendSets: readonly BlendSet[] };

export const MOOD_RULES: Record<Mood, MoodRule> = {
  kintsugi: { cuts: ["voronoi", "polygons", "triangles", "strips", "subject"], layouts: LAYOUTS, blendSets: ["calm", "mixed", "luminous"] },
  riso: { cuts: CUTS, layouts: LAYOUTS, blendSets: ["ink", "calm"] },
  dreamscape: { cuts: ["blobs", "circles", "voronoi", "subject", "strips"], layouts: ["golden", "radial", "diagonal", "chaos"], blendSets: ["luminous", "calm"] },
  brutal: { cuts: ["strips", "polygons", "triangles", "voronoi", "circles"], layouts: LAYOUTS, blendSets: ["contrast", "ink"] },
  glitch: { cuts: ["strips", "voronoi", "polygons", "triangles", "subject"], layouts: LAYOUTS, blendSets: ["acid", "contrast", "mixed"] },
  bauhaus: { cuts: ["circles", "triangles", "strips"], layouts: ["grid"], blendSets: ["ink", "calm"] },
  botanical: { cuts: ["blobs", "subject"], layouts: ["golden", "diagonal", "radial"], blendSets: ["calm", "ink", "luminous"] },
};

/** Long side of a 1x export, in pixels. 2x/4x multiply this. */
export const EXPORT_BASE_LONG_SIDE = 1200;

/** Pixel dimensions for a given long side and ratio (width / height). */
export function sizeFor(ratio: Ratio, longSide: number): { width: number; height: number } {
  const r = RATIOS[ratio];
  return r >= 1
    ? { width: longSide, height: Math.round(longSide / r) }
    : { width: Math.round(longSide * r), height: longSide };
}

/** Resolution-independent design space: short side = 1000 units. */
export function designSize(ratio: Ratio): { w: number; h: number } {
  const r = RATIOS[ratio];
  return r >= 1 ? { w: 1000 * r, h: 1000 } : { w: 1000, h: 1000 / r };
}

export function isSettings(v: unknown): v is Settings {
  const s = v as Settings;
  return (
    !!s &&
    typeof s.ratio === "string" &&
    Object.hasOwn(RATIOS, s.ratio) &&
    (s.mood === "auto" || MOODS.includes(s.mood)) &&
    (s.cut === "auto" || CUTS.includes(s.cut)) &&
    [s.density, s.chaos, s.blend, s.warp].every((n) => typeof n === "number" && n >= 0 && n <= 1) &&
    PALETTE_MODES.includes(s.palette)
  );
}

export function isRecipe(v: unknown): v is Recipe {
  const r = v as Recipe;
  return (
    !!r &&
    MOODS.includes(r.mood) &&
    (r.mood2 === null || MOODS.includes(r.mood2)) &&
    CUTS.includes(r.cut) &&
    LAYOUTS.includes(r.layout) &&
    typeof r.blendSet === "string" &&
    Object.hasOwn(BLEND_SETS, r.blendSet) &&
    Number.isInteger(r.remix) &&
    r.remix >= 0 &&
    typeof r.hybrid === "boolean"
  );
}

// Option lists, settings and recipes. A piece is a print: one style (a poster school / print process),
// one format (poster, hero section, background), one ink set, one word.

export const RATIOS = {
  "1:1": 1,
  "4:5": 4 / 5,
  "9:16": 9 / 16,
  "16:9": 16 / 9,
  "A-series": 1 / Math.SQRT2,
} as const;
export type Ratio = keyof typeof RATIOS;

export const STYLES = ["riso", "sandwich", "swiss", "pop", "slices", "monument", "smear", "kaleido"] as const;
export type Style = (typeof STYLES)[number];
export const STYLE_LABELS: Record<Style, string> = {
  riso: "Riso overprint",
  sandwich: "Sticker sandwich",
  swiss: "Swiss windows",
  pop: "Comic pop",
  slices: "Lenticular slices",
  monument: "Letters as windows",
  smear: "Pixel smear",
  kaleido: "Kaleidoscope",
};

export const FORMATS = ["poster", "hero", "wall"] as const;
export type Format = (typeof FORMATS)[number];
export const FORMAT_LABELS: Record<Format, string> = {
  poster: "Poster",
  hero: "Hero section",
  wall: "Background",
};

export const PALETTE_MODES = ["source", "loud", "warm", "cold", "neon", "mono"] as const;
export type PaletteMode = (typeof PALETTE_MODES)[number];
export const PALETTE_LABELS: Record<PaletteMode, string> = {
  source: "Match photos",
  loud: "Any loud set",
  warm: "Warm",
  cold: "Cold",
  neon: "Fluoro",
  mono: "Black + one",
};

export const HEADLINE_MAX = 24;

export type Settings = {
  ratio: Ratio;
  format: Format | "auto";
  style: Style | "auto";
  palette: PaletteMode;
  /** The word on the print. Empty = picked from the photos' colours. */
  headline: string;
  /** 0 = calm and square, 1 = tilted, misregistered, crowded. */
  energy: number;
  /** Size of the word: 0 = large, 1 = monumental (cropped by the edges). */
  scale: number;
  /** Print texture (ink dropout, toner specks). 0 = perfectly clean. */
  texture: number;
  /** Liquid warp amount on the images (type stays crisp). 0 = off. */
  warp: number;
};

export const DEFAULT_SETTINGS: Settings = {
  ratio: "4:5",
  format: "auto",
  style: "auto",
  palette: "source",
  headline: "",
  energy: 0.45,
  scale: 0.6,
  texture: 0.35,
  warp: 0,
};

/** Fully resolved creative choices. seed + settings + recipe reproduces a piece exactly. */
export type Recipe = {
  style: Style;
  format: Format;
  /** Ink set id (see palette.ts). */
  inks: string;
  /** Layout variant within the style. */
  variant: number;
  /** Secondary style inherited in Duel mode: borrows its signature detail. */
  style2: Style | null;
  /** Print date, YYYY.MM.DD — printed on the piece. */
  day: string;
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

export function cleanHeadline(s: string): string {
  return s.replace(/\s+/g, " ").trimStart().slice(0, HEADLINE_MAX);
}

export function isSettings(v: unknown): v is Settings {
  const s = v as Settings;
  return (
    !!s &&
    s.ratio in RATIOS &&
    (s.format === "auto" || FORMATS.includes(s.format)) &&
    (s.style === "auto" || STYLES.includes(s.style)) &&
    typeof s.headline === "string" &&
    s.headline.length <= HEADLINE_MAX &&
    [s.energy, s.scale, s.texture, s.warp].every((n) => typeof n === "number" && n >= 0 && n <= 1) &&
    PALETTE_MODES.includes(s.palette)
  );
}

export function isRecipe(v: unknown): v is Recipe {
  const r = v as Recipe;
  return (
    !!r &&
    STYLES.includes(r.style) &&
    FORMATS.includes(r.format) &&
    typeof r.inks === "string" &&
    Number.isInteger(r.variant) &&
    (r.style2 === null || STYLES.includes(r.style2)) &&
    typeof r.day === "string" &&
    Number.isInteger(r.remix) &&
    typeof r.hybrid === "boolean"
  );
}

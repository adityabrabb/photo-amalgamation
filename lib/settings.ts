export const RATIOS = {
  "1:1": 1,
  "4:5": 4 / 5,
  "9:16": 9 / 16,
  "16:9": 16 / 9,
  "A-series": 1 / Math.SQRT2,
} as const;

export type Ratio = keyof typeof RATIOS;

export type Settings = {
  ratio: Ratio;
};

export const DEFAULT_SETTINGS: Settings = { ratio: "4:5" };

/** Long side of a 1x export, in pixels. 2x/4x multiply this. */
export const EXPORT_BASE_LONG_SIDE = 1200;

/** Pixel dimensions for a given long side and ratio (width / height). */
export function sizeFor(ratio: Ratio, longSide: number): { width: number; height: number } {
  const r = RATIOS[ratio];
  return r >= 1
    ? { width: longSide, height: Math.round(longSide / r) }
    : { width: Math.round(longSide * r), height: longSide };
}

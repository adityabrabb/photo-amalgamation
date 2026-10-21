// Recipe resolution: turns "auto" settings into concrete choices.
// Variety bias ("unused first") and the recent-combo penalty apply only when usage stats are passed in;
// without stats the choice depends on the seed alone (used for Daily Fuse and pasted seeds).
import { inkAffinity, inkCandidates, type Swatch } from "./palette";
import { type Rng } from "./prng";
import { FORMATS, RATIOS, STYLES, type Format, type Recipe, type Settings, type Style } from "./settings";

export type Dim = "style" | "format" | "inks";

export type UsageStats = {
  counts: Record<Dim, Record<string, number>>;
  /** Combo keys of recent results, most recent first. */
  recent: string[];
};

export const RECENT_WINDOW = 24;

export function emptyStats(): UsageStats {
  return { counts: { style: {}, format: {}, inks: {} }, recent: [] };
}

export function comboKey(r: Pick<Recipe, "style" | "format" | "inks">): string {
  return `${r.style}|${r.format}|${r.inks}`;
}

export function addUsage(stats: UsageStats, r: Recipe): UsageStats {
  const counts = { ...stats.counts };
  for (const dim of ["style", "format", "inks"] as Dim[]) {
    counts[dim] = { ...counts[dim], [r[dim]]: (counts[dim][r[dim]] ?? 0) + 1 };
  }
  return { counts, recent: [comboKey(r), ...stats.recent].slice(0, RECENT_WINDOW) };
}

/** "Unused first": weight falls off with how much more an option was used than the least-used option. */
function varietyWeights(dim: Dim, options: readonly string[], stats: UsageStats | null): number[] {
  if (!stats) return options.map(() => 1);
  const counts = options.map((o) => stats.counts[dim][o] ?? 0);
  const min = Math.min(...counts);
  return counts.map((c) => 1 / Math.pow(1 + (c - min), 1.4));
}

function pickDim<T extends string>(dim: Dim, options: readonly T[], rng: Rng, stats: UsageStats | null, avoid?: T, bias?: number[]): T {
  const idx = options.map((_, i) => i).filter((i) => !(options.length > 1 && avoid && options[i] === avoid));
  const pool = idx.map((i) => options[i]);
  const w = varietyWeights(dim, pool, stats).map((v, k) => v * (bias ? bias[idx[k]] : 1));
  return rng.weighted(pool, w);
}

/** Wide canvases lean hero (never on tall ones), tall ones lean poster; backgrounds come up about a quarter of the time. */
function formatBias(settings: Settings): number[] {
  const wide = RATIOS[settings.ratio] > 1.2;
  return FORMATS.map((f) => (f === "wall" ? 0.45 : f === "hero" ? (wide ? 1.4 : 0) : wide ? 0.35 : 1.4));
}

/** Ink sets that suit the photos rank higher; "source" leans hard on the match. */
function pickInks(settings: Settings, source: Swatch[], rng: Rng, stats: UsageStats | null, avoid?: string): string {
  const sets = inkCandidates(settings.palette);
  const ids = sets.map((s) => s.id);
  const bias = sets.map((s) => (settings.palette === "source" ? Math.pow(0.05 + inkAffinity(s, source), 3) : 1));
  return pickDim("inks", ids, rng, stats, avoid, bias);
}

export function today(date = new Date()): string {
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * Resolve settings into a recipe. `keep` holds the previous recipe while the seed is locked, so auto
 * dimensions stay stable while sliders are tweaked.
 */
export function resolveRecipe(settings: Settings, rng: Rng, stats: UsageStats | null, source: Swatch[], keep?: Recipe, day = today()): Recipe {
  const draw = (): Recipe => {
    const style: Style = settings.style !== "auto" ? settings.style : keep ? keep.style : pickDim("style", STYLES, rng, stats);
    const format: Format = settings.format !== "auto" ? settings.format : keep ? keep.format : pickDim("format", FORMATS, rng, stats, undefined, formatBias(settings));
    const inksOk = keep && inkCandidates(settings.palette).some((s) => s.id === keep.inks);
    const inks = inksOk ? keep!.inks : pickInks(settings, source, rng, stats);
    return {
      style, format, inks,
      variant: keep?.variant ?? rng.int(0, 999),
      style2: keep?.style2 ?? null,
      day: keep?.day ?? day,
      remix: keep?.remix ?? 0,
      hybrid: keep?.hybrid ?? false,
    };
  };

  if (keep || !stats) return draw();

  // Recipe penalty: a combo used recently is down-weighted by rejection, harder the more recent it was.
  let recipe = draw();
  for (let attempt = 0; attempt < 10; attempt++) {
    const idx = stats.recent.indexOf(comboKey(recipe));
    if (idx < 0) break;
    const keepChance = 0.06 + 0.6 * (idx / RECENT_WINDOW);
    if (rng.next() < keepChance) break;
    recipe = draw();
  }
  return recipe;
}

/** Remix: same seed, style and format; new inks and a new layout variant. */
export function remixRecipe(r: Recipe, settings: Settings, rng: Rng, stats: UsageStats | null, source: Swatch[]): Recipe {
  return { ...r, inks: pickInks(settings, source, rng, stats, r.inks), variant: rng.int(0, 999), remix: r.remix + 1 };
}

/** Duel child: style from one parent, inks and format from either, the other parent's style as a borrowed detail. */
export function duelRecipe(a: Recipe, b: Recipe, rng: Rng): Recipe {
  const [p, q] = rng.next() < 0.5 ? [a, b] : [b, a];
  return {
    style: p.style,
    style2: q.style !== p.style ? q.style : (q.style2 ?? p.style2 ?? null),
    format: rng.next() < 0.5 ? p.format : q.format,
    inks: rng.next() < 0.5 ? p.inks : q.inks,
    variant: rng.int(0, 999),
    day: today(),
    remix: 0,
    hybrid: true,
  };
}

export function duelSettings(a: Settings, b: Settings, rng: Rng): Settings {
  const mix = (x: number, y: number) => Math.min(1, Math.max(0, (x + y) / 2 + rng.range(-0.08, 0.08)));
  return {
    ratio: rng.next() < 0.5 ? a.ratio : b.ratio,
    format: "auto",
    style: "auto",
    palette: rng.next() < 0.5 ? a.palette : b.palette,
    headline: rng.next() < 0.5 ? a.headline : b.headline,
    energy: mix(a.energy, b.energy),
    scale: mix(a.scale, b.scale),
    texture: mix(a.texture, b.texture),
    warp: mix(a.warp, b.warp),
  };
}

/** After repeated near-duplicates, nudge energy/scale to escape the neighbourhood. */
export function nudgeSettings(s: Settings, rng: Rng): Settings {
  const nudge = (v: number) => {
    const d = rng.range(0.1, 0.22) * rng.sign();
    const n = v + d;
    return Math.min(1, Math.max(0, n < 0 || n > 1 ? v - d : n));
  };
  return { ...s, energy: nudge(s.energy), scale: nudge(s.scale) };
}

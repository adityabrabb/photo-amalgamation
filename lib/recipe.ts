// Recipe resolution: turns "auto" settings into concrete choices.
// Variety bias ("unused first") and the recent-combo penalty apply only when usage stats are passed in;
// without stats the choice depends on the seed alone (used for Daily Fuse and pasted seeds).
import { type Rng } from "./prng";
import {
  MOODS,
  MOOD_RULES,
  type BlendSet,
  type Cut,
  type Layout,
  type Mood,
  type Recipe,
  type Settings,
} from "./settings";

export type Dim = "mood" | "cut" | "layout" | "blendSet";

export type UsageStats = {
  counts: Record<Dim, Record<string, number>>;
  /** Combo keys of recent results, most recent first. */
  recent: string[];
};

export const RECENT_WINDOW = 24;

export function emptyStats(): UsageStats {
  return { counts: { mood: {}, cut: {}, layout: {}, blendSet: {} }, recent: [] };
}

export function comboKey(r: Pick<Recipe, "mood" | "cut" | "layout" | "blendSet">): string {
  return `${r.mood}|${r.cut}|${r.layout}|${r.blendSet}`;
}

export function addUsage(stats: UsageStats, r: Recipe): UsageStats {
  const counts = { ...stats.counts };
  for (const dim of ["mood", "cut", "layout", "blendSet"] as Dim[]) {
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

function pickDim<T extends string>(dim: Dim, options: readonly T[], rng: Rng, stats: UsageStats | null, avoid?: T): T {
  const pool = options.length > 1 && avoid ? options.filter((o) => o !== avoid) : options;
  return rng.weighted(pool, varietyWeights(dim, pool, stats));
}

function allowedCuts(mood: Mood): readonly Cut[] {
  return MOOD_RULES[mood].cuts;
}

/**
 * Resolve settings into a recipe. `keep` holds the previous recipe while the seed is locked, so auto
 * dimensions stay stable while sliders are tweaked.
 */
export function resolveRecipe(settings: Settings, rng: Rng, stats: UsageStats | null, keep?: Recipe): Recipe {
  const draw = (): Recipe => {
    let moods: readonly Mood[] = settings.mood === "auto" ? MOODS : [settings.mood];
    if (settings.cut !== "auto") {
      const cut = settings.cut;
      const compatible = moods.filter((m) => allowedCuts(m).includes(cut));
      if (compatible.length) moods = compatible;
    }
    const mood =
      settings.mood !== "auto" ? settings.mood : keep && moods.includes(keep.mood) ? keep.mood : pickDim("mood", moods, rng, stats);
    const rule = MOOD_RULES[mood];

    const cut: Cut =
      settings.cut !== "auto"
        ? settings.cut
        : keep && rule.cuts.includes(keep.cut)
          ? keep.cut
          : pickDim("cut", rule.cuts, rng, stats);
    const layout: Layout = keep && rule.layouts.includes(keep.layout) ? keep.layout : pickDim("layout", rule.layouts, rng, stats);
    const blendSet: BlendSet =
      keep && rule.blendSets.includes(keep.blendSet) ? keep.blendSet : pickDim("blendSet", rule.blendSets, rng, stats);

    return { mood, mood2: keep?.mood2 ?? null, cut, layout, blendSet, remix: keep?.remix ?? 0, hybrid: keep?.hybrid ?? false };
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

/** Remix: same seed + layout, new cut (unless the user pinned one), new blend set and colors. */
export function remixRecipe(r: Recipe, settings: Settings, rng: Rng, stats: UsageStats | null): Recipe {
  const rule = MOOD_RULES[r.mood];
  return {
    ...r,
    cut: settings.cut !== "auto" ? r.cut : pickDim("cut", rule.cuts, rng, stats, r.cut),
    blendSet: pickDim("blendSet", rule.blendSets, rng, stats, r.blendSet),
    remix: r.remix + 1,
  };
}

/** Duel child: each trait inherited from one parent, the other parent's mood carried as a secondary mood. */
export function duelRecipe(a: Recipe, b: Recipe, rng: Rng): Recipe {
  const [p, q] = rng.next() < 0.5 ? [a, b] : [b, a];
  const mood = p.mood;
  const rule = MOOD_RULES[mood];
  const from = <T,>(x: T, y: T, ok: (v: T) => boolean): T => {
    const first = rng.next() < 0.5 ? x : y;
    const second = first === x ? y : x;
    return ok(first) ? first : ok(second) ? second : first;
  };
  return {
    mood,
    mood2: q.mood !== mood ? q.mood : (q.mood2 ?? p.mood2 ?? null),
    cut: from(p.cut, q.cut, (c) => rule.cuts.includes(c)),
    layout: from(p.layout, q.layout, (l) => rule.layouts.includes(l)),
    blendSet: from(p.blendSet, q.blendSet, (s) => rule.blendSets.includes(s)),
    remix: 0,
    hybrid: true,
  };
}

export function duelSettings(a: Settings, b: Settings, rng: Rng): Settings {
  const mix = (x: number, y: number) => Math.min(1, Math.max(0, (x + y) / 2 + rng.range(-0.08, 0.08)));
  return {
    ratio: rng.next() < 0.5 ? a.ratio : b.ratio,
    mood: "auto",
    cut: "auto",
    density: mix(a.density, b.density),
    chaos: mix(a.chaos, b.chaos),
    blend: mix(a.blend, b.blend),
    palette: rng.next() < 0.5 ? a.palette : b.palette,
    warp: mix(a.warp, b.warp),
  };
}

/** After repeated near-duplicates, nudge chaos/density to escape the neighbourhood. */
export function nudgeSettings(s: Settings, rng: Rng): Settings {
  const nudge = (v: number) => {
    const d = rng.range(0.1, 0.22) * rng.sign();
    const n = v + d;
    return Math.min(1, Math.max(0, n < 0 || n > 1 ? v - d : n));
  };
  return { ...s, density: nudge(s.density), chaos: nudge(s.chaos) };
}


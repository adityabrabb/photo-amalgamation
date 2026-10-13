// Recipe links + JSON. These carry seed + settings + recipe only — never the photos.
import { isValidSeed } from "./prng";
import { isRecipe, isSettings, type PieceSpec } from "./settings";

type RecipeFile = { app: "fusion"; v: 1; seed: string; settings: PieceSpec["settings"]; recipe: PieceSpec["recipe"]; title?: string };

function toB64Url(s: string) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64Url(s: string) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function specToJson(spec: PieceSpec, title?: string): string {
  const file: RecipeFile = { app: "fusion", v: 1, seed: spec.seed, settings: spec.settings, recipe: spec.recipe, title };
  return JSON.stringify(file, null, 2);
}

export function parseRecipe(text: string): Pick<PieceSpec, "seed" | "settings" | "recipe"> | null {
  try {
    const f = JSON.parse(text) as RecipeFile;
    if (f.app !== "fusion" || !isValidSeed(f.seed) || !isSettings(f.settings) || !isRecipe(f.recipe)) return null;
    return { seed: f.seed, settings: f.settings, recipe: f.recipe };
  } catch {
    return null;
  }
}

export function recipeLink(spec: PieceSpec): string {
  const compact = JSON.stringify({ app: "fusion", v: 1, seed: spec.seed, settings: spec.settings, recipe: spec.recipe });
  return `${location.origin}${location.pathname}#r=${toB64Url(compact)}`;
}

export function recipeFromHash(hash: string): Pick<PieceSpec, "seed" | "settings" | "recipe"> | null {
  const m = /[#&]r=([A-Za-z0-9_-]+)/.exec(hash);
  if (!m) return null;
  try {
    return parseRecipe(fromB64Url(m[1]));
  } catch {
    return null;
  }
}

/** Daily Fuse: one shared seed per (local) date. */
export async function dailySeed(date = new Date()): Promise<{ seed: string; day: string }> {
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`fusion-daily:${day}`));
  const seed = Array.from(new Uint8Array(digest).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  return { seed, day };
}

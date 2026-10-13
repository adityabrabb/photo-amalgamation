// Composition planning + rendering.
//
// The plan is computed from the seed in resolution-independent units, then drawn at any pixel size.
// Preview and exports therefore show the same piece, and every export is drawn straight from the
// full-resolution source bitmaps — never upscaled from the preview.
//
// Step 1 placeholder: rectangular fragments, random placement. Real cuts arrive in step 2.
import { createRng } from "./prng";
import type { Recipe } from "./ledger";

export type Fragment = {
  image: number;
  /** Source crop, as fractions of the source image. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Destination center, as fractions of canvas width / height. */
  cx: number;
  cy: number;
  /** Destination width, as a fraction of the canvas short side. Height follows the crop aspect. */
  w: number;
  rotation: number;
};

export type Plan = {
  background: string;
  fragments: Fragment[];
  recipe: Recipe;
};

type Dims = { width: number; height: number };

export function planComposition(seed: string, sources: Dims[]): Plan {
  const rng = createRng(seed);
  const n = sources.length;

  const background = `hsl(${rng.int(0, 359)} ${rng.int(8, 30)}% ${rng.int(6, 16)}%)`;

  const count = rng.int(Math.max(n, 7), Math.max(n, 7) + 8);
  // Each image appears at least once; the rest are random.
  const order = Array.from({ length: count }, (_, i) => (i < n ? i : rng.int(0, n - 1)));

  const fragments: Fragment[] = order.map((image) => {
    const sw = rng.range(0.3, 0.8);
    const sh = rng.range(0.3, 0.8);
    return {
      image,
      sx: rng.range(0, 1 - sw),
      sy: rng.range(0, 1 - sh),
      sw,
      sh,
      cx: rng.range(0.1, 0.9),
      cy: rng.range(0.1, 0.9),
      w: rng.range(0.22, 0.6),
      rotation: rng.range(-0.45, 0.45),
    };
  });

  return { background, fragments, recipe: { cut: "rect-placeholder", layout: "random" } };
}

export function renderPlan(
  ctx: CanvasRenderingContext2D,
  plan: Plan,
  sources: ImageBitmap[],
  width: number,
  height: number,
) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = plan.background;
  ctx.fillRect(0, 0, width, height);

  const unit = Math.min(width, height);

  for (const f of plan.fragments) {
    const src = sources[f.image];
    const sx = f.sx * src.width;
    const sy = f.sy * src.height;
    const sw = f.sw * src.width;
    const sh = f.sh * src.height;

    const dw = f.w * unit;
    const dh = dw * (sh / sw);

    // "high" smoothing only when downscaling; bilinear otherwise.
    const downscaling = dw < sw;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = downscaling ? "high" : "low";

    ctx.setTransform(1, 0, 0, 1, f.cx * width, f.cy * height);
    ctx.rotate(f.rotation);
    ctx.drawImage(src, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
  }

  ctx.restore();
}

/** Renders the plan at an exact pixel size into a fresh canvas and returns a PNG blob. */
export async function exportPng(
  plan: Plan,
  sources: ImageBitmap[],
  width: number,
  height: number,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas 2D not available");
  renderPlan(ctx, plan, sources, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error("PNG encoding failed (canvas may be too large for this browser)");
  return blob;
}

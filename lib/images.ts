// Image intake. Everything stays in the browser: files are decoded, hashed, analyzed and stored locally.
import type { Analysis } from "./analysis";
import { engine } from "./engine";
import type { PlanImage } from "./planner";

export type SourceImage = {
  id: string;
  name: string;
  /** SHA-256 of the file bytes, hex. The image's content identity in the ledger. */
  hash: string;
  /** Full-resolution decoded pixels. Never downscaled, so exports render from source. */
  bitmap: ImageBitmap;
  thumbUrl: string;
  analysis: Analysis;
};

export const MIN_IMAGES = 2;
export const MAX_IMAGES = 10;

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function analysisThumb(bitmap: ImageBitmap): ImageData {
  const max = 128;
  const k = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * k)), h = Math.max(1, Math.round(bitmap.height * k));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

export async function hashBlob(blob: Blob): Promise<string> {
  return sha256Hex(await blob.arrayBuffer());
}

export async function loadImage(blob: Blob, name: string, knownHash?: string): Promise<SourceImage> {
  const [hash, bitmap] = await Promise.all([
    knownHash ?? hashBlob(blob),
    createImageBitmap(blob, { imageOrientation: "from-image" }),
  ]);
  const analysis = await engine.analyze(analysisThumb(bitmap), hash);
  return { id: hash.slice(0, 16), name: name || "pasted image", hash, bitmap, thumbUrl: URL.createObjectURL(blob), analysis };
}

export function releaseImage(img: SourceImage) {
  // Bitmaps may still be referenced by the piece on screen; let GC reclaim them.
  URL.revokeObjectURL(img.thumbUrl);
}

export function planImages(images: SourceImage[]): PlanImage[] {
  return images.map((i) => ({ width: i.bitmap.width, height: i.bitmap.height, analysis: i.analysis }));
}

export function imageFilesFrom(list: FileList | DataTransferItemList | null | undefined): File[] {
  if (!list) return [];
  const files: File[] = [];
  const entries: (File | DataTransferItem)[] = Array.from(list as ArrayLike<File | DataTransferItem>);
  for (const entry of entries) {
    const file = entry instanceof File ? entry : entry.kind === "file" ? entry.getAsFile() : null;
    if (file && file.type.startsWith("image/")) files.push(file);
  }
  return files;
}

// Image intake. Everything stays in the browser: files are decoded locally and hashed locally.

export type SourceImage = {
  id: string;
  name: string;
  /** SHA-256 of the file bytes, hex. Used as the image's content identity in the ledger. */
  hash: string;
  /** Full-resolution decoded pixels. Never downscaled, so exports can render from source. */
  bitmap: ImageBitmap;
  thumbUrl: string;
};

export const MIN_IMAGES = 2;
export const MAX_IMAGES = 10;

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function loadImage(file: File): Promise<SourceImage> {
  const [hash, bitmap] = await Promise.all([
    file.arrayBuffer().then(sha256Hex),
    createImageBitmap(file, { imageOrientation: "from-image" }),
  ]);
  return {
    id: hash.slice(0, 16),
    name: file.name || "pasted image",
    hash,
    bitmap,
    thumbUrl: URL.createObjectURL(file),
  };
}

export function releaseImage(img: SourceImage) {
  img.bitmap.close();
  URL.revokeObjectURL(img.thumbUrl);
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

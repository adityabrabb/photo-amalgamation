// Exports: PNG (with frames), share cards, MP4 and GIF of the assembly animation.
// Every output renders the piece fresh at its exact target size from the source bitmaps, then places
// it 1:1 (integer offsets) — nothing is upscaled from the preview.
import { applyPalette, GIFEncoder, quantize } from "gifenc";
import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import type { Plan } from "./planner";
import { renderPiece, renderToCanvas } from "./render";
import { EXPORT_BASE_LONG_SIDE, type Ratio, sizeFor } from "./settings";

export const FRAMES = ["clean", "polaroid", "mat", "wallpaper"] as const;
export type FrameKind = (typeof FRAMES)[number];
export const FRAME_LABELS: Record<FrameKind, string> = { clean: "Clean", polaroid: "Polaroid", mat: "Gallery mat", wallpaper: "Phone wallpaper" };

const RARITY_COLORS = { Common: "#a3a7ad", Rare: "#4cc9f0", Legendary: "#e9c46a" } as const;

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("PNG encoding failed (canvas may be too large for this browser)");
  return blob;
}

function makeCanvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas 2D not available");
  return { c, ctx };
}

function fitText(ctx: CanvasRenderingContext2D, text: string, font: (px: number) => string, maxPx: number, maxWidth: number) {
  let px = maxPx;
  ctx.font = font(px);
  while (px > 8 && ctx.measureText(text).width > maxWidth) {
    px -= 1;
    ctx.font = font(px);
  }
  return px;
}

/** A piece rendered at the largest exact size that fits a box. */
function pieceInBox(plan: Plan, sources: ImageBitmap[], boxW: number, boxH: number, stamp: boolean) {
  const r = plan.w / plan.h;
  let w = boxW, h = Math.round(boxW / r);
  if (h > boxH) {
    h = boxH;
    w = Math.round(boxH * r);
  }
  return renderToCanvas(plan, sources, w, h, { stamp });
}

const serif = (px: number, style = "") => `${style} ${px}px "Iowan Old Style", "Palatino Linotype", Georgia, serif`;

export function renderFramed(plan: Plan, sources: ImageBitmap[], ratio: Ratio, scale: number, frame: FrameKind, stamp: boolean): HTMLCanvasElement {
  if (frame === "wallpaper") {
    const Ww = 1080 * scale, Hw = 1920 * scale;
    const { c, ctx } = makeCanvas(Ww, Hw);
    const g = ctx.createLinearGradient(0, 0, 0, Hw);
    g.addColorStop(0, plan.palette[0]);
    g.addColorStop(1, plan.palette[Math.min(1, plan.palette.length - 1)]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, Ww, Hw);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(0, 0, Ww, Hw);
    const piece = pieceInBox(plan, sources, Math.round(Ww * 0.84), Math.round(Hw * 0.62), stamp);
    const x = Math.round((Ww - piece.width) / 2), y = Math.round(Hw * 0.46 - piece.height / 2);
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 40 * scale;
    ctx.shadowOffsetY = 16 * scale;
    ctx.fillStyle = "#000";
    ctx.fillRect(x, y, piece.width, piece.height);
    ctx.restore();
    ctx.drawImage(piece, x, y);
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.textAlign = "center";
    fitText(ctx, plan.title, (px) => serif(px, "italic"), 30 * scale, Ww * 0.84);
    ctx.fillText(plan.title, Ww / 2, Math.round(Hw * 0.88));
    return c;
  }

  const { width: W, height: H } = sizeFor(ratio, EXPORT_BASE_LONG_SIDE * scale);
  const piece = renderToCanvas(plan, sources, W, H, { stamp });
  if (frame === "clean") return piece;

  if (frame === "polaroid") {
    const side = Math.round(W * 0.055), bottom = Math.round(W * 0.21);
    const { c, ctx } = makeCanvas(W + side * 2, H + side + bottom);
    ctx.fillStyle = "#fbfaf6";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(piece, side, side);
    ctx.fillStyle = "rgba(0,0,0,0.08)";
    ctx.fillRect(side, side + H, W, Math.max(1, Math.round(scale)));
    ctx.fillStyle = "#2b2a28";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    fitText(ctx, plan.title, (px) => serif(px, "italic"), Math.round(W * 0.042), W);
    ctx.fillText(plan.title, side, side + H + bottom / 2);
    return c;
  }

  // Gallery mat.
  const m = Math.round(Math.max(W, H) * 0.13);
  const caption = Math.round(m * 0.55);
  const { c, ctx } = makeCanvas(W + m * 2, H + m * 2 + caption);
  ctx.fillStyle = "#f1ede4";
  ctx.fillRect(0, 0, c.width, c.height);
  const bevel = Math.max(2, Math.round(W * 0.004));
  ctx.fillStyle = "#fdfcf9";
  ctx.fillRect(m - bevel, m - bevel, W + bevel * 2, H + bevel * 2);
  ctx.fillStyle = "#d9d3c6";
  ctx.fillRect(m - 1, m - 1, W + 2, H + 2);
  ctx.drawImage(piece, m, m);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#3a3733";
  fitText(ctx, plan.title, (px) => serif(px), Math.round(m * 0.2), W);
  ctx.fillText(plan.title, c.width / 2, m + H + m * 0.55);
  ctx.fillStyle = "#8a847a";
  ctx.font = `${Math.round(m * 0.12)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillText(`Fusion · ${plan.rarity} · ${plan.stamp.text}`, c.width / 2, m + H + m * 0.55 + m * 0.28);
  return c;
}

/** 9:16 story card: piece + title + rarity + stamp. */
export function renderShareCard(plan: Plan, sources: ImageBitmap[]): HTMLCanvasElement {
  const W = 1080, H = 1920;
  const { c, ctx } = makeCanvas(W, H);
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, "#0d0d10");
  g.addColorStop(1, "#16141a");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = "#e9c46a";
  ctx.font = `600 30px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.letterSpacing = "12px";
  ctx.fillText("FUSION", W / 2, 120);
  ctx.letterSpacing = "0px";

  const piece = pieceInBox(plan, sources, 920, 1180, true);
  const x = Math.round((W - piece.width) / 2), y = Math.round(200 + (1180 - piece.height) / 2);
  ctx.drawImage(piece, x, y);

  ctx.fillStyle = "#f4f1ea";
  fitText(ctx, plan.title, (px) => serif(px), 54, 940);
  ctx.fillText(plan.title, W / 2, 1490);

  // Rarity pill.
  const label = plan.rarity.toUpperCase();
  ctx.font = `700 28px ui-sans-serif, system-ui, sans-serif`;
  ctx.letterSpacing = "4px";
  const pw = Math.ceil(ctx.measureText(label).width) + 64, ph = 60;
  ctx.fillStyle = RARITY_COLORS[plan.rarity];
  ctx.beginPath();
  ctx.roundRect(Math.round(W / 2 - pw / 2), 1570, pw, ph, 30);
  ctx.fill();
  ctx.fillStyle = "#111";
  ctx.fillText(label, W / 2 + 2, 1570 + ph / 2 + 1);
  ctx.letterSpacing = "0px";

  if (plan.traits.length) {
    ctx.fillStyle = "#a3a7ad";
    ctx.font = `28px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText(plan.traits.join(" · "), W / 2, 1690);
  }
  ctx.fillStyle = "#6b6f76";
  ctx.font = `24px ui-monospace, Menlo, Consolas, monospace`;
  ctx.fillText(`seed ${plan.stamp.text}`, W / 2, 1800);
  return c;
}

// ---- Assembly animation video ----

const DURATION = 5;
const ASSEMBLE = 3.4;

function videoSize(plan: Plan, long: number) {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return plan.w >= plan.h ? { w: even(long), h: even((long * plan.h) / plan.w) } : { w: even((long * plan.w) / plan.h), h: even(long) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

export async function exportVideo(plan: Plan, sources: ImageBitmap[], stamp: boolean, onProgress: (p: number) => void): Promise<{ blob: Blob; ext: string }> {
  const { w, h } = videoSize(plan, 1080);
  const { c, ctx } = makeCanvas(w, h);
  const fps = 30, frames = DURATION * fps;

  if (typeof VideoEncoder !== "undefined") {
    const codecs = ["avc1.640028", "avc1.4d0028", "avc1.42003e", "avc1.42002a"];
    let config: VideoEncoderConfig | null = null;
    for (const codec of codecs) {
      const cfg: VideoEncoderConfig = { codec, width: w, height: h, bitrate: 12_000_000, framerate: fps };
      if ((await VideoEncoder.isConfigSupported(cfg)).supported) {
        config = cfg;
        break;
      }
    }
    if (config) {
      const target = new ArrayBufferTarget();
      const muxer = new Muxer({ target, video: { codec: "avc", width: w, height: h }, fastStart: "in-memory" });
      let failure: Error | null = null;
      const encoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: (e) => (failure = e as Error),
      });
      encoder.configure(config);
      for (let i = 0; i < frames; i++) {
        if (failure) throw failure;
        renderPiece(ctx, plan, sources, w, h, { t: Math.min(1, i / fps / ASSEMBLE), stamp });
        const frame = new VideoFrame(c, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
        encoder.encode(frame, { keyFrame: i % 60 === 0 });
        frame.close();
        onProgress((i + 1) / frames);
        if (encoder.encodeQueueSize > 4 || i % 4 === 0) await tick();
      }
      await encoder.flush();
      if (failure) throw failure;
      muxer.finalize();
      return { blob: new Blob([target.buffer], { type: "video/mp4" }), ext: "mp4" };
    }
  }

  // Fallback: real-time MediaRecorder capture.
  const mime = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) throw new Error("This browser cannot encode video");
  const stream = c.captureStream(fps);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise<void>((r) => (rec.onstop = () => r()));
  rec.start();
  const start = performance.now();
  await new Promise<void>((resolve) => {
    const frame = () => {
      const s = (performance.now() - start) / 1000;
      renderPiece(ctx, plan, sources, w, h, { t: Math.min(1, s / ASSEMBLE), stamp });
      onProgress(Math.min(1, s / DURATION));
      if (s < DURATION) requestAnimationFrame(frame);
      else resolve();
    };
    frame();
  });
  rec.stop();
  await done;
  const type = mime.split(";")[0];
  return { blob: new Blob(chunks, { type }), ext: type === "video/mp4" ? "mp4" : "webm" };
}

export async function exportGif(plan: Plan, sources: ImageBitmap[], stamp: boolean, onProgress: (p: number) => void): Promise<Blob> {
  const { w, h } = videoSize(plan, 540);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true, alpha: false })!;
  const fps = 15, frames = DURATION * fps;
  const gif = GIFEncoder();
  for (let i = 0; i < frames; i++) {
    renderPiece(ctx, plan, sources, w, h, { t: Math.min(1, i / fps / ASSEMBLE), stamp });
    const data = ctx.getImageData(0, 0, w, h).data;
    // Nearest-color palette mapping only: gifenc applies no dithering.
    const palette = quantize(data, 256);
    gif.writeFrame(applyPalette(data, palette), w, h, { palette, delay: Math.round(1000 / fps) });
    onProgress((i + 1) / frames);
    if (i % 2 === 0) await tick();
  }
  gif.finish();
  return new Blob([gif.bytes() as BlobPart], { type: "image/gif" });
}

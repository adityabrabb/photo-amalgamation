"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MAX_IMAGES, MIN_IMAGES, imageFilesFrom, loadImage, releaseImage, type SourceImage } from "@/lib/images";
import { ledgerCount, recentEntries, recordResult, type LedgerEntry } from "@/lib/ledger";
import { newSeed } from "@/lib/prng";
import { exportPng, planComposition, renderPlan } from "@/lib/render";
import { DEFAULT_SETTINGS, EXPORT_BASE_LONG_SIDE, RATIOS, sizeFor, type Ratio, type Settings } from "@/lib/settings";

const EXPORT_SCALES = [1, 2, 4] as const;

export default function Fusion() {
  const [images, setImages] = useState<SourceImage[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [seed, setSeed] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");
  const [dragging, setDragging] = useState(false);
  const [exporting, setExporting] = useState<number | null>(null);
  const [count, setCount] = useState(0);
  const [recent, setRecent] = useState<LedgerEntry[]>([]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imagesRef = useRef(images);
  imagesRef.current = images;

  const canFuse = images.length >= MIN_IMAGES;

  const plan = useMemo(
    () => (seed && canFuse ? planComposition(seed, images.map((i) => i.bitmap)) : null),
    [seed, images, canFuse],
  );

  const refreshLedger = useCallback(async () => {
    setCount(await ledgerCount());
    setRecent(await recentEntries(6));
  }, []);

  useEffect(() => {
    refreshLedger().catch((e) => setStatus(`Ledger unavailable: ${e}`));
  }, [refreshLedger]);

  // Release decoded bitmaps on unmount.
  useEffect(() => () => imagesRef.current.forEach(releaseImage), []);

  const addFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    const room = MAX_IMAGES - imagesRef.current.length;
    if (room <= 0) {
      setStatus(`Max ${MAX_IMAGES} images.`);
      return;
    }
    const accepted = files.slice(0, room);
    setStatus(`Loading ${accepted.length} image${accepted.length > 1 ? "s" : ""}…`);
    const loaded = (await Promise.allSettled(accepted.map(loadImage)))
      .flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const existing = new Set(imagesRef.current.map((i) => i.hash));
    const fresh = loaded.filter((img) => {
      if (existing.has(img.hash)) {
        releaseImage(img);
        return false;
      }
      existing.add(img.hash);
      return true;
    });
    setImages((prev) => [...prev, ...fresh]);
    const skipped = files.length - fresh.length;
    setStatus(skipped > 0 ? `Added ${fresh.length}; skipped ${skipped} (duplicate, unreadable, or over limit).` : "");
  }, []);

  const removeImage = (id: string) => {
    setImages((prev) => {
      const target = prev.find((i) => i.id === id);
      if (target) releaseImage(target);
      const next = prev.filter((i) => i.id !== id);
      if (next.length < MIN_IMAGES) setSeed(null);
      return next;
    });
  };

  // Paste anywhere on the page.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => addFiles(imageFilesFrom(e.clipboardData?.items));
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [addFiles]);

  // Every Fuse / Shuffle gets a fresh 128-bit crypto seed.
  const fuse = () => {
    if (!canFuse) return;
    setSeed(newSeed());
  };

  // Record each produced result in the ledger (key = image hashes + seed).
  useEffect(() => {
    if (!seed || !plan) return;
    recordResult({
      seed,
      settings,
      imageHashes: images.map((i) => i.hash),
      recipe: plan.recipe,
      phash: null,
    })
      .then(refreshLedger)
      .catch((e) => setStatus(`Ledger write failed: ${e}`));
  }, [seed, plan, settings, images, refreshLedger]);

  // Preview: backing store sized to CSS size × devicePixelRatio, re-rendered on resize / DPR change.
  useEffect(() => {
    const canvas = canvasRef.current;
    const frame = frameRef.current;
    if (!canvas || !frame) return;

    const draw = (pxW: number, pxH: number) => {
      if (canvas.width !== pxW) canvas.width = pxW;
      if (canvas.height !== pxH) canvas.height = pxH;
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) return;
      if (plan) {
        renderPlan(ctx, plan, images.map((i) => i.bitmap), pxW, pxH);
      } else {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = "#111114";
        ctx.fillRect(0, 0, pxW, pxH);
      }
    };

    const observer = new ResizeObserver(([entry]) => {
      const exact = entry.devicePixelContentBoxSize?.[0];
      if (exact) {
        draw(exact.inlineSize, exact.blockSize);
      } else {
        const dpr = window.devicePixelRatio || 1;
        draw(Math.round(entry.contentRect.width * dpr), Math.round(entry.contentRect.height * dpr));
      }
    });
    observer.observe(canvas, { box: "device-pixel-content-box" in ResizeObserverEntry.prototype ? "device-pixel-content-box" : "content-box" });
    return () => observer.disconnect();
  }, [plan, images, settings.ratio]);

  const download = async (scale: number) => {
    if (!plan || !seed) return;
    setExporting(scale);
    try {
      const { width, height } = sizeFor(settings.ratio, EXPORT_BASE_LONG_SIDE * scale);
      const blob = await exportPng(plan, images.map((i) => i.bitmap), width, height);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `fusion-${seed.slice(0, 8)}-${scale}x.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus(`Exported ${width}×${height} PNG.`);
    } catch (e) {
      setStatus(`Export failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setExporting(null);
    }
  };

  const ratio = RATIOS[settings.ratio];

  return (
    <main className="app">
      <header className="top">
        <h1>Fusion</h1>
        <span className="muted">Images never leave your browser.</span>
      </header>

      <div className="layout">
        <aside className="panel">
          <section
            className={`drop ${dragging ? "drag" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              addFiles(imageFilesFrom(e.dataTransfer.files));
            }}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && fileInputRef.current?.click()}
          >
            <strong>Drop images here</strong>
            <span className="muted">or click to choose · or paste · {MIN_IMAGES}–{MAX_IMAGES} images</span>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                addFiles(imageFilesFrom(e.target.files));
                e.target.value = "";
              }}
            />
          </section>

          {images.length > 0 && (
            <ul className="thumbs">
              {images.map((img) => (
                <li key={img.id}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img.thumbUrl} alt={img.name} />
                  <button className="remove" onClick={() => removeImage(img.id)} aria-label={`Remove ${img.name}`}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="muted small">{images.length}/{MAX_IMAGES} images</div>

          <label className="field">
            <span>Canvas ratio</span>
            <select
              value={settings.ratio}
              onChange={(e) => setSettings((s) => ({ ...s, ratio: e.target.value as Ratio }))}
            >
              {Object.keys(RATIOS).map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </label>

          <div className="row">
            <button className="primary" disabled={!canFuse} onClick={fuse}>
              {seed ? "Shuffle" : "Fuse"}
            </button>
          </div>

          <div className="field">
            <span>Seed</span>
            <code className="seed">{seed ?? "—"}</code>
          </div>

          <div className="field">
            <span>Export PNG</span>
            <div className="row">
              {EXPORT_SCALES.map((s) => {
                const { width, height } = sizeFor(settings.ratio, EXPORT_BASE_LONG_SIDE * s);
                return (
                  <button key={s} disabled={!plan || exporting !== null} onClick={() => download(s)} title={`${width}×${height}`}>
                    {exporting === s ? "…" : `${s}x`}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="field">
            <span>Ledger · {count} result{count === 1 ? "" : "s"}</span>
            <ul className="ledger">
              {recent.map((e) => (
                <li key={e.id}>
                  <code>{e.seed.slice(0, 8)}</code> {e.settings.ratio} · {e.imageHashes.length} img ·{" "}
                  {new Date(e.createdAt).toLocaleTimeString()}
                </li>
              ))}
            </ul>
          </div>

          {status && <p className="status">{status}</p>}
        </aside>

        <section className="stage">
          <div ref={frameRef} className="frame" style={{ aspectRatio: String(ratio), width: `min(100%, calc((100dvh - 96px) * ${ratio}))` }}>
            <canvas ref={canvasRef} />
            {!plan && (
              <div className="placeholder">{canFuse ? "Hit Fuse" : `Add at least ${MIN_IMAGES} images`}</div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

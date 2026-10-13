"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { hamming } from "@/lib/analysis";
import { engine } from "@/lib/engine";
import {
  FRAMES,
  FRAME_LABELS,
  canvasToPng,
  downloadBlob,
  exportGif,
  exportVideo,
  renderFramed,
  renderShareCard,
  type FrameKind,
} from "@/lib/exporters";
import {
  MAX_IMAGES,
  MIN_IMAGES,
  imageFilesFrom,
  loadImage,
  planImages,
  releaseImage,
  type SourceImage,
} from "@/lib/images";
import {
  getImage,
  ledgerSummary,
  putImage,
  recentEntries,
  recordResult,
  type LedgerEntry,
  type LedgerSummary,
} from "@/lib/ledger";
import type { Plan } from "@/lib/planner";
import { forkRng, isValidSeed, newSeed } from "@/lib/prng";
import { addUsage, duelRecipe, duelSettings, emptyStats, nudgeSettings, remixRecipe, resolveRecipe } from "@/lib/recipe";
import { phashInput, renderPiece, renderToCanvas } from "@/lib/render";
import {
  CUTS,
  CUT_LABELS,
  DEFAULT_SETTINGS,
  EXPORT_BASE_LONG_SIDE,
  LAYOUT_LABELS,
  MOODS,
  MOOD_LABELS,
  MOOD_RULES,
  PALETTE_MODES,
  RATIOS,
  sizeFor,
  type PieceSpec,
  type Ratio,
  type Settings,
} from "@/lib/settings";
import { dailySeed, parseRecipe, recipeFromHash, recipeLink, specToJson } from "@/lib/share";
import Gallery from "./Gallery";
import Thumb from "./Thumb";

type Current = { spec: PieceSpec; plan: Plan; sources: ImageBitmap[]; animate: boolean; key: number };
type RecipePart = Pick<PieceSpec, "seed" | "settings" | "recipe">;

/** Near-duplicate threshold (Hamming distance on the 64-bit pHash). */
const PHASH_THRESHOLD = 10;
const MAX_ATTEMPTS = 12;
const NUDGE_AFTER = 5;
const ANIM_MS = 1900;
const EXPORT_SCALES = [1, 2, 4] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function minHamming(ph: string, list: string[]) {
  let m = 64;
  for (const p of list) {
    const d = hamming(ph, p);
    if (d < m) m = d;
    if (!m) break;
  }
  return m;
}

async function makeThumb(plan: Plan, sources: ImageBitmap[]): Promise<Blob | undefined> {
  const long = 440;
  const w = plan.w >= plan.h ? long : Math.round((long * plan.w) / plan.h);
  const h = plan.w >= plan.h ? Math.round((long * plan.h) / plan.w) : long;
  const c = renderToCanvas(plan, sources, w, h);
  return new Promise((r) => c.toBlob((b) => r(b ?? undefined), "image/webp", 0.92));
}

function isTyping(el: EventTarget | null) {
  const t = el as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

export default function Fusion() {
  const [images, setImages] = useState<SourceImage[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [current, setCurrent] = useState<Current | null>(null);
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [count, setCount] = useState(0);
  const [history, setHistory] = useState<LedgerEntry[]>([]);
  const [dragging, setDragging] = useState(false);
  const [stamp, setStamp] = useState(true);
  const [frame, setFrame] = useState<FrameKind>("clean");
  const [animateOn, setAnimateOn] = useState(true);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [seedInput, setSeedInput] = useState("");
  const [pending, setPending] = useState<RecipePart | null>(null);
  const [scrambling, setScrambling] = useState(false);
  const [shake, setShake] = useState<"unsupported" | "available" | "on">("unsupported");

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const jsonInputRef = useRef<HTMLInputElement>(null);

  const imagesRef = useRef(images);
  const settingsRef = useRef(settings);
  const currentRef = useRef(current);
  const lockedRef = useRef(locked);
  const pendingRef = useRef(pending);
  const summaryRef = useRef<LedgerSummary>({ count: 0, phashes: [], stats: emptyStats() });
  const genRef = useRef(0);
  const keyRef = useRef(0);
  const animatedKeyRef = useRef(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrambleRef = useRef<{ active: boolean; last: { spec: PieceSpec; plan: Plan } | null; loop: Promise<void> | null }>({ active: false, last: null, loop: null });
  currentRef.current = current;
  lockedRef.current = locked;
  pendingRef.current = pending;

  const commitImages = (next: SourceImage[]) => {
    imagesRef.current = next;
    setImages(next);
  };
  const commitSettings = (next: Settings) => {
    settingsRef.current = next;
    setSettings(next);
  };

  const canFuse = images.length >= MIN_IMAGES;

  // ---- Ledger ----
  useEffect(() => {
    (async () => {
      summaryRef.current = await ledgerSummary();
      setCount(summaryRef.current.count);
      setHistory(await recentEntries(14));
    })().catch((e) => setStatus(`Ledger unavailable: ${e}`));
  }, []);

  const record = useCallback(async (spec: PieceSpec, plan: Plan, imgs: SourceImage[], phash?: string) => {
    const sources = imgs.map((i) => i.bitmap);
    const ph = phash ?? (await engine.phash(phashInput(plan, sources)));
    const entry = await recordResult({
      seed: spec.seed,
      settings: spec.settings,
      recipe: spec.recipe,
      kind: spec.kind,
      label: spec.label,
      parents: spec.parents,
      imageHashes: imgs.map((i) => i.hash),
      phash: ph,
      title: plan.title,
      rarity: plan.rarity,
      thumb: await makeThumb(plan, sources),
    });
    const s = summaryRef.current;
    summaryRef.current = { count: s.count + 1, phashes: [...s.phashes, ph], stats: addUsage(s.stats, spec.recipe) };
    setCount(summaryRef.current.count);
    setHistory((h) => [entry, ...h.filter((x) => x.id !== entry.id)].slice(0, 14));
  }, []);

  const show = (spec: PieceSpec, plan: Plan, imgs: SourceImage[], animate: boolean) => {
    setCurrent({ spec, plan, sources: imgs.map((i) => i.bitmap), animate, key: ++keyRef.current });
    setSeedInput(spec.seed);
  };

  const planFor = (spec: PieceSpec, imgs: SourceImage[]) => engine.plan(spec, planImages(imgs));

  const fail = (e: unknown) => {
    setBusy(null);
    setStatus(`Something went wrong: ${e instanceof Error ? e.message : e}`);
  };

  // ---- Fresh fuse with the no-repeat system ----
  const fuseFresh = useCallback(
    async (first?: { spec: PieceSpec; plan: Plan }) => {
      const imgs = imagesRef.current;
      if (imgs.length < MIN_IMAGES) return;
      const token = ++genRef.current;
      setBusy("Fusing…");
      try {
        let settings = settingsRef.current;
        let chosen: { spec: PieceSpec; plan: Plan; ph: string } | null = null;
        let nudged = false;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
          let spec: PieceSpec, plan: Plan;
          if (attempt === 0 && first) {
            ({ spec, plan } = first);
          } else {
            const seed = newSeed();
            if (attempt >= NUDGE_AFTER) {
              settings = nudgeSettings(settings, forkRng(seed, "nudge"));
              nudged = true;
            }
            const recipe = resolveRecipe(settings, forkRng(seed, "recipe"), summaryRef.current.stats);
            spec = { seed, settings, recipe, kind: "fresh" };
            plan = await planFor(spec, imgs);
          }
          if (token !== genRef.current) return;
          const ph = await engine.phash(phashInput(plan, imgs.map((i) => i.bitmap)));
          chosen = { spec, plan, ph };
          // Near-duplicate of anything in the ledger → silently discard and reroll.
          if (minHamming(ph, summaryRef.current.phashes) >= PHASH_THRESHOLD) break;
        }
        if (!chosen || token !== genRef.current) return;
        if (nudged) commitSettings({ ...settingsRef.current, density: settings.density, chaos: settings.chaos });
        show(chosen.spec, chosen.plan, imgs, true);
        setBusy(null);
        setStatus("");
        await record(chosen.spec, chosen.plan, imgs, chosen.ph);
      } catch (e) {
        fail(e);
      }
    },
    [record],
  );

  /** Same seed, new settings/images (Lock seed). Ledger write is debounced while sliders move. */
  const rerenderLocked = useCallback(async () => {
    const cur = currentRef.current;
    const imgs = imagesRef.current;
    if (!cur || imgs.length < MIN_IMAGES) return;
    const token = ++genRef.current;
    try {
      const settings = settingsRef.current;
      const recipe = resolveRecipe(settings, forkRng(cur.spec.seed, "recipe"), null, cur.spec.recipe);
      const spec: PieceSpec = { ...cur.spec, settings, recipe, kind: "locked" };
      const plan = await planFor(spec, imgs);
      if (token !== genRef.current) return;
      show(spec, plan, imgs, false);
      if (recordTimerRef.current) clearTimeout(recordTimerRef.current);
      recordTimerRef.current = setTimeout(() => record(spec, plan, imgs).catch(fail), 900);
    } catch (e) {
      fail(e);
    }
  }, [record]);

  /** After any settings/images change: locked → same seed; unlocked → fresh seed. */
  const scheduleUpdate = useCallback(() => {
    if (!currentRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => (lockedRef.current ? rerenderLocked() : fuseFresh()), lockedRef.current ? 30 : 450);
  }, [fuseFresh, rerenderLocked]);

  /** Explicit repeat / reproduction paths (Enter seed, links, JSON, Daily, Remix, Duel). */
  const renderExplicit = useCallback(
    async (spec: PieceSpec, imgs: SourceImage[], doRecord: boolean) => {
      const token = ++genRef.current;
      setBusy("Fusing…");
      try {
        const plan = await planFor(spec, imgs);
        if (token !== genRef.current) return;
        show(spec, plan, imgs, true);
        setBusy(null);
        if (doRecord) await record(spec, plan, imgs);
      } catch (e) {
        fail(e);
      }
    },
    [record],
  );

  const applyRecipe = useCallback(
    (part: RecipePart, label: string) => {
      commitSettings(part.settings);
      if (imagesRef.current.length < MIN_IMAGES) {
        setPending(part);
        setStatus(`${label} loaded. Add at least ${MIN_IMAGES} of your photos to see it.`);
        return;
      }
      setPending(null);
      setStatus(`${label} loaded.`);
      renderExplicit({ ...part, kind: "link", label }, imagesRef.current, true);
    },
    [renderExplicit],
  );

  // Recipe link in the URL hash (recipe only — photos never travel).
  useEffect(() => {
    const part = recipeFromHash(location.hash);
    if (part) applyRecipe(part, "Recipe from link");
  }, [applyRecipe]);

  // ---- Images ----
  const onImagesChanged = useCallback(() => {
    const p = pendingRef.current;
    if (p && imagesRef.current.length >= MIN_IMAGES) {
      setPending(null);
      renderExplicit({ ...p, kind: "link", label: "Recipe from link" }, imagesRef.current, true);
      return;
    }
    if (imagesRef.current.length < MIN_IMAGES) return;
    scheduleUpdate();
  }, [renderExplicit, scheduleUpdate]);

  const addFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      const room = MAX_IMAGES - imagesRef.current.length;
      if (room <= 0) {
        setStatus(`Max ${MAX_IMAGES} images.`);
        return;
      }
      const accepted = files.slice(0, room);
      setBusy(`Reading ${accepted.length} image${accepted.length > 1 ? "s" : ""}…`);
      const loaded = (await Promise.allSettled(accepted.map(async (file) => ({ file, img: await loadImage(file, file.name) })))).flatMap(
        (r) => (r.status === "fulfilled" ? [r.value] : []),
      );
      const existing = new Set(imagesRef.current.map((i) => i.hash));
      const fresh: SourceImage[] = [];
      const writes: Promise<void>[] = [];
      for (const { file, img } of loaded) {
        if (existing.has(img.hash)) {
          releaseImage(img);
          continue;
        }
        existing.add(img.hash);
        fresh.push(img);
        // Persist locally so ledger items can be recalled later (IndexedDB, never uploaded).
        writes.push(putImage(img.hash, file, img.name).catch(() => {}));
      }
      await Promise.all(writes);
      commitImages([...imagesRef.current, ...fresh]);
      setBusy(null);
      const skipped = files.length - fresh.length;
      setStatus(skipped > 0 ? `Added ${fresh.length}; skipped ${skipped} (duplicate, unreadable, or over limit).` : "");
      if (fresh.length) onImagesChanged();
    },
    [onImagesChanged],
  );

  const removeImage = (id: string) => {
    const target = imagesRef.current.find((i) => i.id === id);
    if (target) releaseImage(target);
    const next = imagesRef.current.filter((i) => i.id !== id);
    commitImages(next);
    if (next.length < MIN_IMAGES) {
      genRef.current++;
      setCurrent(null);
      return;
    }
    onImagesChanged();
  };

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e.target)) return;
      addFiles(imageFilesFrom(e.clipboardData?.items));
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [addFiles]);

  /** Load a set of images by content hash (from current set or IndexedDB). */
  const imagesByHash = async (hashes: string[]): Promise<SourceImage[] | null> => {
    const out: SourceImage[] = [];
    for (const h of hashes) {
      const have = imagesRef.current.find((i) => i.hash === h);
      if (have) {
        out.push(have);
        continue;
      }
      const stored = await getImage(h);
      if (!stored) return null;
      out.push(await loadImage(stored.blob, stored.name, h));
    }
    return out;
  };

  const swapImages = (next: SourceImage[]) => {
    for (const img of imagesRef.current) if (!next.includes(img)) releaseImage(img);
    commitImages(next);
  };

  // ---- Settings ----
  const updateSettings = (patch: Partial<Settings>) => {
    const next = { ...settingsRef.current, ...patch };
    if (patch.mood && patch.mood !== "auto" && next.cut !== "auto" && !MOOD_RULES[patch.mood].cuts.includes(next.cut)) next.cut = "auto";
    commitSettings(next);
    scheduleUpdate();
  };

  // ---- Actions ----
  const fuse = () => {
    if (!canFuse) return;
    if (lockedRef.current && currentRef.current) rerenderLocked();
    else fuseFresh();
  };

  const remix = () => {
    const cur = currentRef.current;
    if (!cur || !canFuse) return;
    const n = cur.spec.recipe.remix + 1;
    const recipe = remixRecipe(cur.spec.recipe, cur.spec.settings, forkRng(cur.spec.seed, `remix:${n}`), summaryRef.current.stats);
    renderExplicit({ ...cur.spec, recipe, kind: "remix", label: `Variation ${n} of ${cur.spec.seed.slice(0, 4).toUpperCase()}` }, imagesRef.current, true);
  };

  const applySeed = () => {
    const seed = seedInput.trim().toLowerCase();
    if (!isValidSeed(seed)) {
      setStatus("A seed is 32 hex characters.");
      return;
    }
    if (!canFuse) {
      setStatus(`Add at least ${MIN_IMAGES} images first.`);
      return;
    }
    const settings = settingsRef.current;
    const recipe = resolveRecipe(settings, forkRng(seed, "recipe"), null);
    renderExplicit({ seed, settings, recipe, kind: "seed", label: "Entered seed" }, imagesRef.current, true);
  };

  const daily = async () => {
    if (!canFuse) return;
    const { seed, day } = await dailySeed();
    const settings = settingsRef.current;
    const recipe = resolveRecipe(settings, forkRng(seed, "recipe"), null);
    renderExplicit({ seed, settings, recipe, kind: "daily", label: `Daily Fuse · ${day}` }, imagesRef.current, true);
  };

  const recall = async (e: LedgerEntry) => {
    setGalleryOpen(false);
    setBusy("Recalling…");
    try {
      const imgs = await imagesByHash(e.imageHashes);
      if (!imgs) {
        setBusy(null);
        setStatus("The photos for that piece are no longer stored in this browser.");
        return;
      }
      swapImages(imgs);
      commitSettings(e.settings);
      await renderExplicit({ seed: e.seed, settings: e.settings, recipe: e.recipe, kind: e.kind, label: e.label ?? "Recalled", parents: e.parents }, imgs, false);
      setStatus(`Recalled “${e.title}”.`);
    } catch (err) {
      fail(err);
    }
  };

  const duel = async (a: LedgerEntry, b: LedgerEntry) => {
    setGalleryOpen(false);
    setBusy("Breeding…");
    try {
      const hashes = [...new Set([...a.imageHashes, ...b.imageHashes])].slice(0, MAX_IMAGES);
      let imgs: SourceImage[] = [];
      for (const h of hashes) {
        const one = await imagesByHash([h]);
        if (one) imgs.push(...one);
      }
      if (imgs.length < MIN_IMAGES) imgs = imagesRef.current;
      if (imgs.length < MIN_IMAGES) {
        setBusy(null);
        setStatus("Duel needs at least two photos available.");
        return;
      }
      swapImages(imgs);
      const seed = newSeed();
      const rng = forkRng(seed, "duel");
      const recipe = duelRecipe(a.recipe, b.recipe, rng);
      const settings = duelSettings(a.settings, b.settings, rng);
      commitSettings(settings);
      await renderExplicit(
        { seed, settings, recipe, kind: "duel", label: `Child of ${a.seed.slice(0, 4).toUpperCase()} × ${b.seed.slice(0, 4).toUpperCase()}`, parents: [a.id, b.id] },
        imgs,
        true,
      );
    } catch (err) {
      fail(err);
    }
  };

  // ---- Hold Space: slot-machine scramble, locks in on release ----
  useEffect(() => {
    const start = () => {
      const s = scrambleRef.current;
      if (s.active || imagesRef.current.length < MIN_IMAGES) return;
      s.active = true;
      s.last = null;
      setScrambling(true);
      const token = ++genRef.current;
      s.loop = (async () => {
        while (s.active) {
          const seed = newSeed();
          const recipe = resolveRecipe(settingsRef.current, forkRng(seed, "recipe"), summaryRef.current.stats);
          const spec: PieceSpec = { seed, settings: settingsRef.current, recipe, kind: "fresh" };
          const plan = await planFor(spec, imagesRef.current);
          if (token !== genRef.current) return;
          s.last = { spec, plan };
          show(spec, plan, imagesRef.current, false);
          await sleep(60);
        }
      })();
    };
    const stop = async () => {
      const s = scrambleRef.current;
      if (!s.active) return;
      s.active = false;
      setScrambling(false);
      await s.loop;
      fuseFresh(s.last ?? undefined);
    };
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || isTyping(e.target) || e.target instanceof HTMLButtonElement) return;
      e.preventDefault();
      start();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      stop();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", stop);
    };
  }, [fuseFresh]);

  // ---- Shake to fuse (DeviceMotion) ----
  useEffect(() => {
    if (typeof window === "undefined" || !("DeviceMotionEvent" in window) || !matchMedia("(pointer: coarse)").matches) return;
    const needsPermission = typeof (DeviceMotionEvent as unknown as { requestPermission?: unknown }).requestPermission === "function";
    setShake(needsPermission ? "available" : "on");
  }, []);

  const fuseRef = useRef(fuse);
  fuseRef.current = fuse;
  useEffect(() => {
    if (shake !== "on") return;
    let last = 0;
    const onMotion = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity;
      if (!a) return;
      const mag = Math.hypot(a.x ?? 0, a.y ?? 0, a.z ?? 0);
      if (mag > 25 && performance.now() - last > 1500) {
        last = performance.now();
        fuseRef.current();
      }
    };
    window.addEventListener("devicemotion", onMotion);
    return () => window.removeEventListener("devicemotion", onMotion);
  }, [shake]);

  const enableShake = async () => {
    try {
      const req = (DeviceMotionEvent as unknown as { requestPermission: () => Promise<string> }).requestPermission;
      setShake((await req()) === "granted" ? "on" : "available");
    } catch {
      setStatus("Motion access was not granted.");
    }
  };

  // ---- Preview: canvas backing store = CSS size × devicePixelRatio ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;
    let animating = false;
    const ctx = () => canvas.getContext("2d", { alpha: false });

    const drawStatic = () => {
      const c = ctx();
      if (!c) return;
      if (current) renderPiece(c, current.plan, current.sources, canvas.width, canvas.height, { stamp });
      else {
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.fillStyle = "#111114";
        c.fillRect(0, 0, canvas.width, canvas.height);
      }
    };

    const runAnimation = () => {
      animating = true;
      const start = performance.now();
      const step = () => {
        const t = Math.min(1, (performance.now() - start) / ANIM_MS);
        const c = ctx();
        if (c && current) renderPiece(c, current.plan, current.sources, canvas.width, canvas.height, { t, stamp });
        if (t < 1) raf = requestAnimationFrame(step);
        else animating = false;
      };
      raf = requestAnimationFrame(step);
    };

    const resize = (pxW: number, pxH: number) => {
      if (!pxW || !pxH) return;
      const changed = canvas.width !== pxW || canvas.height !== pxH;
      if (changed) {
        canvas.width = pxW;
        canvas.height = pxH;
      }
      if (!animating) drawStatic();
    };

    const observer = new ResizeObserver(([entry]) => {
      const exact = entry.devicePixelContentBoxSize?.[0];
      if (exact) resize(exact.inlineSize, exact.blockSize);
      else {
        const dpr = window.devicePixelRatio || 1;
        resize(Math.round(entry.contentRect.width * dpr), Math.round(entry.contentRect.height * dpr));
      }
    });
    try {
      observer.observe(canvas, { box: "device-pixel-content-box" });
    } catch {
      observer.observe(canvas);
    }

    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (current?.animate && animateOn && !reduced && animatedKeyRef.current !== current.key && canvas.width > 0) {
      animatedKeyRef.current = current.key;
      runAnimation();
    }
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [current, stamp, animateOn]);

  // ---- Export ----
  const withProgress = async (label: string, fn: (p: (x: number) => void) => Promise<void>) => {
    setBusy(label);
    try {
      await fn((x) => setBusy(`${label} ${Math.round(x * 100)}%`));
      setBusy(null);
    } catch (e) {
      fail(e);
    }
  };

  const filename = (suffix: string) => `fusion-${current!.spec.seed.slice(0, 8)}-${suffix}`;

  const exportPng = (scale: number) =>
    current &&
    withProgress(`Rendering ${scale}x…`, async () => {
      await sleep(16);
      const canvas = renderFramed(current.plan, current.sources, current.spec.settings.ratio, scale, frame, stamp);
      const blob = await canvasToPng(canvas);
      downloadBlob(blob, filename(`${frame}-${scale}x.png`));
      setStatus(`Exported ${canvas.width}×${canvas.height} PNG.`);
      canvas.width = canvas.height = 0;
    });

  const exportShareCard = () =>
    current &&
    withProgress("Share card…", async () => {
      await sleep(16);
      const blob = await canvasToPng(renderShareCard(current.plan, current.sources));
      const file = new File([blob], filename("story.png"), { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: current.plan.title });
          return;
        } catch {
          // fall through to download
        }
      }
      downloadBlob(blob, file.name);
    });

  const exportMp4 = () =>
    current &&
    withProgress("Video", async (p) => {
      const { blob, ext } = await exportVideo(current.plan, current.sources, stamp, p);
      downloadBlob(blob, filename(`assembly.${ext}`));
    });

  const exportGifFile = () =>
    current &&
    withProgress("GIF", async (p) => {
      downloadBlob(await exportGif(current.plan, current.sources, stamp, p), filename("assembly.gif"));
    });

  const copyLink = async () => {
    if (!current) return;
    const link = recipeLink(current.spec);
    try {
      await navigator.clipboard.writeText(link);
      setStatus("Recipe link copied. It holds the seed + settings only — never your photos.");
    } catch {
      setStatus(link);
    }
  };

  const saveJson = () => {
    if (!current) return;
    downloadBlob(new Blob([specToJson(current.spec, current.plan.title)], { type: "application/json" }), filename("recipe.json"));
  };

  const loadJson = async (file: File) => {
    const part = parseRecipe(await file.text());
    if (!part) {
      setStatus("That file isn't a Fusion recipe.");
      return;
    }
    applyRecipe(part, `Recipe “${file.name}”`);
  };

  // ---- View ----
  const ratio = RATIOS[current?.spec.settings.ratio ?? settings.ratio];
  const moodRule = settings.mood !== "auto" ? MOOD_RULES[settings.mood] : null;
  const plan = current?.plan;
  const spec = current?.spec;

  const slider = (key: "density" | "chaos" | "blend" | "warp", label: string, left: string, right: string) => (
    <label className="field">
      <span>
        {label} <em>{Math.round(settings[key] * 100)}</em>
      </span>
      <input type="range" min={0} max={1} step={0.01} value={settings[key]} onChange={(e) => updateSettings({ [key]: Number(e.target.value) })} />
      <span className="range-ends">
        <i>{left}</i>
        <i>{right}</i>
      </span>
    </label>
  );

  return (
    <main className="app">
      <header className="top">
        <h1>
          Fusion<span className="seam-mark" aria-hidden />
        </h1>
        <span className="muted hide-sm">Images never leave your browser.</span>
        <div className="top-actions">
          <span className="muted small">{count} made</span>
          <button onClick={daily} disabled={!canFuse} title="One shared seed per day, applied to your photos">
            Daily Fuse
          </button>
          <button onClick={() => setGalleryOpen(true)}>Gallery</button>
        </div>
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
            <span className="muted">or click · or paste · {MIN_IMAGES}–{MAX_IMAGES} images</span>
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
          <div className="muted small">
            {images.length}/{MAX_IMAGES} images
          </div>

          <div className="grid2">
            <label className="field">
              <span>Mood</span>
              <select value={settings.mood} onChange={(e) => updateSettings({ mood: e.target.value as Settings["mood"] })}>
                <option value="auto">Auto (variety)</option>
                {MOODS.map((m) => (
                  <option key={m} value={m}>
                    {MOOD_LABELS[m]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Cut</span>
              <select value={settings.cut} onChange={(e) => updateSettings({ cut: e.target.value as Settings["cut"] })}>
                <option value="auto">Auto (variety)</option>
                {CUTS.map((c) => (
                  <option key={c} value={c} disabled={!!moodRule && !moodRule.cuts.includes(c)}>
                    {CUT_LABELS[c]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Palette</span>
              <select value={settings.palette} onChange={(e) => updateSettings({ palette: e.target.value as Settings["palette"] })}>
                {PALETTE_MODES.map((p) => (
                  <option key={p} value={p}>
                    {p === "source" ? "Source colors" : p[0].toUpperCase() + p.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Ratio</span>
              <select value={settings.ratio} onChange={(e) => updateSettings({ ratio: e.target.value as Ratio })}>
                {Object.keys(RATIOS).map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {slider("density", "Density", "few big", "many small")}
          {slider("chaos", "Chaos", "calm", "wild")}
          {slider("blend", "Blend intensity", "none", "full")}
          {slider("warp", "Liquid warp", "off", "melt")}

          <label className="check">
            <input type="checkbox" checked={animateOn} onChange={(e) => setAnimateOn(e.target.checked)} /> Assembly animation
          </label>
          {shake === "available" && (
            <button className="ghost" onClick={enableShake}>
              Enable shake to fuse
            </button>
          )}
          {shake === "on" && <div className="muted small">Shake your phone to fuse.</div>}
          <p className="muted small hint">Hold Space to scramble · release to lock in.</p>
        </aside>

        <section className="stage">
          <div className="actions">
            <button className="primary big" disabled={!canFuse || !!busy} onClick={fuse}>
              {current ? (locked ? "Re-render" : "Shuffle") : "Fuse"}
            </button>
            <button disabled={!current || !!busy} onClick={remix} title="Same seed + layout, new cut and colors">
              Remix
            </button>
            <button className={locked ? "on" : ""} disabled={!current} onClick={() => setLocked(!locked)} title="Keep this seed while tweaking">
              {locked ? "🔒 Seed locked" : "🔓 Lock seed"}
            </button>
            <form
              className="seed-form"
              onSubmit={(e) => {
                e.preventDefault();
                applySeed();
              }}
            >
              <input
                className="seed"
                value={seedInput}
                onChange={(e) => setSeedInput(e.target.value)}
                placeholder="seed (32 hex)"
                spellCheck={false}
                aria-label="Seed"
              />
              <button type="submit" disabled={!seedInput || seedInput === spec?.seed}>
                Use seed
              </button>
            </form>
          </div>

          <div className="canvas-wrap">
            <div className={`frame ${scrambling ? "scrambling" : ""}`} style={{ aspectRatio: String(ratio), width: `min(100%, calc((100dvh - 330px) * ${ratio}))` }}>
              <canvas ref={canvasRef} />
              {!current && <div className="placeholder">{canFuse ? "Hit Fuse" : `Add at least ${MIN_IMAGES} images`}</div>}
            </div>
          </div>

          {plan && spec && (
            <div className="caption">
              <div className="caption-main">
                <span className="title">{plan.title}</span>
                <span className={`badge r-${plan.rarity.toLowerCase()}`}>{plan.rarity}</span>
                {spec.label && <span className="tag">{spec.label}</span>}
              </div>
              <div className="muted small">
                {MOOD_LABELS[spec.recipe.mood]}
                {spec.recipe.mood2 ? ` + ${MOOD_LABELS[spec.recipe.mood2]}` : ""} · {CUT_LABELS[spec.recipe.cut]} · {LAYOUT_LABELS[spec.recipe.layout]} · {spec.recipe.blendSet} blends
                {plan.traits.length ? ` · ${plan.traits.join(" · ")}` : ""}
              </div>
            </div>
          )}

          <div className="export">
            <div className="row">
              {EXPORT_SCALES.map((s) => {
                const { width, height } = sizeFor(spec?.settings.ratio ?? settings.ratio, EXPORT_BASE_LONG_SIDE * s);
                return (
                  <button key={s} disabled={!current || !!busy} onClick={() => exportPng(s)} title={frame === "clean" ? `${width}×${height}` : undefined}>
                    PNG {s}x
                  </button>
                );
              })}
              <select value={frame} onChange={(e) => setFrame(e.target.value as FrameKind)} aria-label="Frame">
                {FRAMES.map((f) => (
                  <option key={f} value={f}>
                    {FRAME_LABELS[f]}
                  </option>
                ))}
              </select>
              <label className="check">
                <input type="checkbox" checked={stamp} onChange={(e) => setStamp(e.target.checked)} /> Stamp
              </label>
            </div>
            <div className="row">
              <button disabled={!current || !!busy} onClick={exportMp4}>MP4</button>
              <button disabled={!current || !!busy} onClick={exportGifFile}>GIF</button>
              <button disabled={!current || !!busy} onClick={exportShareCard}>Share card</button>
              <button disabled={!current} onClick={copyLink}>Copy link</button>
              <button disabled={!current} onClick={saveJson}>Save JSON</button>
              <button onClick={() => jsonInputRef.current?.click()}>Load JSON</button>
              <input
                ref={jsonInputRef}
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) loadJson(f);
                  e.target.value = "";
                }}
              />
            </div>
          </div>

          {(busy || status) && <p className="status">{busy ?? status}</p>}

          {history.length > 0 && (
            <div className="history" aria-label="Recent results">
              {history.map((e) => (
                <button key={e.id} className={spec?.seed === e.seed ? "active" : ""} onClick={() => recall(e)} title={`${e.title} — click to recall`}>
                  <Thumb blob={e.thumb} alt={e.title} />
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      {galleryOpen && <Gallery onClose={() => setGalleryOpen(false)} onRecall={recall} onDuel={duel} />}
    </main>
  );
}

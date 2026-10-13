// IndexedDB: the ledger of every result ever made, plus the uploaded images (kept locally so
// history/gallery items can be recalled exactly). Nothing here ever leaves the browser.
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { addUsage, emptyStats, type UsageStats } from "./recipe";
import type { Rarity } from "./planner";
import { isRecipe, type PieceKind, type Recipe, type Settings } from "./settings";

export type LedgerEntry = {
  /** sha256(sorted image hashes | seed | settings | recipe). */
  id: string;
  seed: string;
  settings: Settings;
  recipe: Recipe;
  kind: PieceKind;
  label?: string;
  parents?: string[];
  imageHashes: string[];
  /** 64-bit perceptual hash, hex. */
  phash: string | null;
  title: string;
  rarity: Rarity;
  thumb?: Blob;
  createdAt: number;
};

type StoredImage = { hash: string; blob: Blob; name: string; addedAt: number };

interface FusionDB extends DBSchema {
  ledger: { key: string; value: LedgerEntry; indexes: { byCreatedAt: number } };
  images: { key: string; value: StoredImage };
}

let dbPromise: Promise<IDBPDatabase<FusionDB>> | null = null;

function db() {
  dbPromise ??= openDB<FusionDB>("fusion", 2, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) {
        const store = database.createObjectStore("ledger", { keyPath: "id" });
        store.createIndex("byCreatedAt", "createdAt");
      }
      if (oldVersion < 2) database.createObjectStore("images", { keyPath: "hash" });
    },
  });
  return dbPromise;
}

/** Step-1 entries predate recipes; they stay in the store but are ignored. */
const isCurrent = (e: LedgerEntry) => isRecipe(e.recipe);

async function sha256Text(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function recordResult(entry: Omit<LedgerEntry, "id" | "createdAt">): Promise<LedgerEntry> {
  const id = await sha256Text(
    [[...entry.imageHashes].sort().join(","), entry.seed, JSON.stringify(entry.settings), JSON.stringify(entry.recipe)].join("|"),
  );
  const full: LedgerEntry = { ...entry, id, createdAt: Date.now() };
  await (await db()).put("ledger", full);
  return full;
}

export async function allEntries(): Promise<LedgerEntry[]> {
  const out: LedgerEntry[] = [];
  let cursor = await (await db()).transaction("ledger").store.index("byCreatedAt").openCursor(null, "prev");
  while (cursor) {
    if (isCurrent(cursor.value)) out.push(cursor.value);
    cursor = await cursor.continue();
  }
  return out;
}

export async function recentEntries(limit: number): Promise<LedgerEntry[]> {
  const out: LedgerEntry[] = [];
  let cursor = await (await db()).transaction("ledger").store.index("byCreatedAt").openCursor(null, "prev");
  while (cursor && out.length < limit) {
    if (isCurrent(cursor.value)) out.push(cursor.value);
    cursor = await cursor.continue();
  }
  return out;
}

export type LedgerSummary = { count: number; phashes: string[]; stats: UsageStats };

/** Everything the no-repeat system needs: all perceptual hashes + usage stats for variety bias. */
export async function ledgerSummary(): Promise<LedgerSummary> {
  const entries = await allEntries();
  let stats = emptyStats();
  for (const e of [...entries].reverse()) stats = addUsage(stats, e.recipe);
  return { count: entries.length, phashes: entries.flatMap((e) => (e.phash ? [e.phash] : [])), stats };
}

export async function putImage(hash: string, blob: Blob, name: string) {
  const d = await db();
  if (await d.getKey("images", hash)) return;
  await d.put("images", { hash, blob, name, addedAt: Date.now() });
}

export async function getImage(hash: string): Promise<StoredImage | undefined> {
  return (await db()).get("images", hash);
}

// IndexedDB ledger of every result ever made. Persists across reloads/sessions.
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Settings } from "./settings";

export type Recipe = {
  cut: string;
  layout: string;
};

export type LedgerEntry = {
  /** Ledger key = sorted image content hashes + seed. */
  id: string;
  seed: string;
  settings: Settings;
  imageHashes: string[];
  recipe: Recipe;
  /** 64-bit perceptual hash, hex. Filled in from step 4. */
  phash: string | null;
  createdAt: number;
};

interface FusionDB extends DBSchema {
  ledger: {
    key: string;
    value: LedgerEntry;
    indexes: { byCreatedAt: number };
  };
}

let dbPromise: Promise<IDBPDatabase<FusionDB>> | null = null;

function db() {
  dbPromise ??= openDB<FusionDB>("fusion", 1, {
    upgrade(database) {
      const store = database.createObjectStore("ledger", { keyPath: "id" });
      store.createIndex("byCreatedAt", "createdAt");
    },
  });
  return dbPromise;
}

async function sha256Text(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function ledgerKey(imageHashes: string[], seed: string): Promise<string> {
  return sha256Text([...imageHashes].sort().join(",") + "|" + seed);
}

export async function recordResult(entry: Omit<LedgerEntry, "id" | "createdAt">): Promise<LedgerEntry> {
  const full: LedgerEntry = {
    ...entry,
    id: await ledgerKey(entry.imageHashes, entry.seed),
    createdAt: Date.now(),
  };
  await (await db()).put("ledger", full);
  return full;
}

export async function ledgerCount(): Promise<number> {
  return (await db()).count("ledger");
}

export async function recentEntries(limit: number): Promise<LedgerEntry[]> {
  const out: LedgerEntry[] = [];
  let cursor = await (await db()).transaction("ledger").store.index("byCreatedAt").openCursor(null, "prev");
  while (cursor && out.length < limit) {
    out.push(cursor.value);
    cursor = await cursor.continue();
  }
  return out;
}

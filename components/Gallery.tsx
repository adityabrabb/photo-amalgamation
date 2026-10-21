"use client";

import { useEffect, useMemo, useState } from "react";
import { allEntries, type LedgerEntry } from "@/lib/ledger";
import { STYLE_LABELS, STYLES } from "@/lib/settings";
import Thumb from "./Thumb";

type Props = {
  onClose: () => void;
  onRecall: (e: LedgerEntry) => void;
  onDuel: (a: LedgerEntry, b: LedgerEntry) => void;
};

/** Museum-style wall of everything ever made, with stats and Duel selection. */
export default function Gallery({ onClose, onRecall, onDuel }: Props) {
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
  const [duel, setDuel] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);

  useEffect(() => {
    allEntries().then(setEntries).catch(() => setEntries([]));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const stats = useMemo(() => {
    const list = entries ?? [];
    const rarity = { Common: 0, Rare: 0, Legendary: 0 };
    const styles = Object.fromEntries(STYLES.map((m) => [m, 0])) as Record<string, number>;
    const images = new Set<string>();
    for (const e of list) {
      rarity[e.rarity]++;
      styles[e.recipe.style]++;
      e.imageHashes.forEach((h) => images.add(h));
    }
    return { total: list.length, rarity, styles, images: images.size, duels: list.filter((e) => e.kind === "duel").length };
  }, [entries]);

  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-2)));

  const pickedEntries = (entries ?? []).filter((e) => picked.includes(e.id));

  return (
    <div className="gallery" role="dialog" aria-modal="true" aria-label="Collection gallery">
      <header className="gallery-head">
        <div>
          <h2>Collection</h2>
          <div className="stats">
            <span><b>{stats.total}</b> pieces</span>
            <span className="r-legendary"><b>{stats.rarity.Legendary}</b> Legendary</span>
            <span className="r-rare"><b>{stats.rarity.Rare}</b> Rare</span>
            <span><b>{stats.rarity.Common}</b> Common</span>
            <span><b>{stats.images}</b> photos fused</span>
            <span><b>{stats.duels}</b> duel children</span>
          </div>
          <div className="stats muted">
            {STYLES.map((m) => (
              <span key={m}>{STYLE_LABELS[m]} {stats.styles[m]}</span>
            ))}
          </div>
        </div>
        <div className="gallery-actions">
          <button className={duel ? "on" : ""} onClick={() => { setDuel(!duel); setPicked([]); }}>
            {duel ? "Cancel duel" : "Duel mode"}
          </button>
          {duel && (
            <button className="primary" disabled={pickedEntries.length !== 2} onClick={() => onDuel(pickedEntries[0], pickedEntries[1])}>
              Fuse {pickedEntries.length}/2 →
            </button>
          )}
          <button onClick={onClose} aria-label="Close gallery">✕</button>
        </div>
      </header>
      {duel && <p className="muted duel-hint">Pick two pieces. Their child takes its style from one, inks and format from either, and borrows a detail from the other.</p>}
      {entries === null ? (
        <p className="muted center">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="muted center">Nothing yet. Fuse something.</p>
      ) : (
        <div className="wall">
          {entries.map((e) => (
            <button
              key={e.id}
              className={`work ${picked.includes(e.id) ? "picked" : ""}`}
              onClick={() => (duel ? toggle(e.id) : onRecall(e))}
              title={duel ? "Select for duel" : "Recall this piece exactly"}
            >
              <span className="frame-mat">
                <Thumb blob={e.thumb} alt={e.title} />
              </span>
              <span className="plaque">
                <span className="plaque-title">{e.title}</span>
                <span className={`badge r-${e.rarity.toLowerCase()}`}>{e.rarity}</span>
                <span className="muted small">
                  {STYLE_LABELS[e.recipe.style]} · {new Date(e.createdAt).toLocaleDateString()}
                  {e.label ? ` · ${e.label}` : ""}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

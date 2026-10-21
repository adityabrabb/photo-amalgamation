// Print faces, self-hosted by next/font (downloaded at build time; the browser never calls Google).
// Canvas can only draw a face once it has loaded, so everything that renders awaits fontsReady().
import { Anton, Rozha_One, Shrikhand, Space_Mono, Unbounded } from "next/font/google";
import type { FontKey } from "./planner";

const anton = Anton({ weight: "400", subsets: ["latin"], variable: "--f-anton" });
const unbounded = Unbounded({ weight: "900", subsets: ["latin"], variable: "--f-unbounded" });
const shrikhand = Shrikhand({ weight: "400", subsets: ["latin"], variable: "--f-shrikhand" });
const rozha = Rozha_One({ weight: "400", subsets: ["latin", "devanagari"], variable: "--f-rozha" });
const mono = Space_Mono({ weight: ["400", "700"], subsets: ["latin"], variable: "--f-mono" });

/** Put on <html> so every face is declared. */
export const FONT_VARIABLES = [anton, unbounded, shrikhand, rozha, mono].map((f) => f.variable).join(" ");

export const FACES: Record<FontKey, { family: string; weight: number }> = {
  anton: { family: anton.style.fontFamily, weight: 400 },
  unbounded: { family: unbounded.style.fontFamily, weight: 900 },
  shrikhand: { family: shrikhand.style.fontFamily, weight: 400 },
  rozha: { family: rozha.style.fontFamily, weight: 400 },
  mono: { family: mono.style.fontFamily, weight: 700 },
};

export function fontCss(key: FontKey, px: number) {
  const f = FACES[key];
  return `${f.weight} ${px}px ${f.family}`;
}

let ready: Promise<void> | null = null;
export function fontsReady(): Promise<void> {
  ready ??= Promise.all(
    (Object.keys(FACES) as FontKey[]).map((k) => document.fonts.load(fontCss(k, 100), k === "rozha" ? "Aक्" : "A")),
  ).then(
    () => undefined,
    () => undefined,
  );
  return ready;
}

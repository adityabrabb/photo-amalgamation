// Per-image analysis (runs in the worker): dominant colors + a coarse saliency grid for the subject cut.
// Also the 64-bit perceptual hash used by the no-repeat system.
import { kmeans, type RGB, type Swatch } from "./palette";

export type Analysis = {
  palette: Swatch[];
  /** Saliency grid, row-major, values 0..1. */
  saliency: { w: number; h: number; data: number[] };
};

export function analyzeImage(img: ImageData, hash: string): Analysis {
  const { width: w, height: h, data } = img;

  // Palette: k-means over (at most ~6k) sampled pixels.
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 6000)));
  const pts: RGB[] = [];
  for (let y = 0; y < h; y += step)
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      pts.push([data[i], data[i + 1], data[i + 2]]);
    }
  const palette = kmeans(pts, pts.map(() => 1), 5, "img:" + hash);

  // Saliency on a coarse grid: color distance from the border mean + edge energy, blurred.
  const gw = Math.min(40, w), gh = Math.max(1, Math.round((gw * h) / w));
  const cell = (gx: number, gy: number): RGB => {
    const x0 = Math.floor((gx / gw) * w), x1 = Math.max(x0 + 1, Math.floor(((gx + 1) / gw) * w));
    const y0 = Math.floor((gy / gh) * h), y1 = Math.max(y0 + 1, Math.floor(((gy + 1) / gh) * h));
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
      }
    return [r / n, g / n, b / n];
  };
  const grid: RGB[] = [];
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) grid.push(cell(gx, gy));

  let br = 0, bg = 0, bb = 0, bn = 0;
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++) {
      if (gx > 0 && gy > 0 && gx < gw - 1 && gy < gh - 1) continue;
      const c = grid[gy * gw + gx];
      br += c[0]; bg += c[1]; bb += c[2]; bn++;
    }
  const border: RGB = [br / bn, bg / bn, bb / bn];
  const lum = grid.map((c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]);
  const at = (x: number, y: number) => lum[Math.min(gh - 1, Math.max(0, y)) * gw + Math.min(gw - 1, Math.max(0, x))];

  const raw: number[] = [];
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++) {
      const c = grid[gy * gw + gx];
      const colorDist = Math.hypot(c[0] - border[0], c[1] - border[1], c[2] - border[2]) / 441;
      const sx = at(gx + 1, gy) - at(gx - 1, gy), sy = at(gx, gy + 1) - at(gx, gy - 1);
      const edge = Math.min(1, Math.hypot(sx, sy) / 120);
      // Mild center prior: subjects tend toward the middle.
      const cx = gx / gw - 0.5, cy = gy / gh - 0.5;
      const center = 1 - Math.min(1, Math.hypot(cx, cy) * 1.2);
      raw.push(colorDist * 0.6 + edge * 0.25 + center * 0.15);
    }

  // 2-pass box blur.
  let sal = raw;
  for (let pass = 0; pass < 2; pass++) {
    const out = new Array<number>(sal.length).fill(0);
    for (let gy = 0; gy < gh; gy++)
      for (let gx = 0; gx < gw; gx++) {
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const x = gx + dx, y = gy + dy;
            if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
            s += sal[y * gw + x]; n++;
          }
        out[gy * gw + gx] = s / n;
      }
    sal = out;
  }
  const max = Math.max(...sal), min = Math.min(...sal);
  const norm = sal.map((v) => (max > min ? (v - min) / (max - min) : 0));

  return { palette, saliency: { w: gw, h: gh, data: norm } };
}

/** 64-bit DCT perceptual hash of a 32×32 grayscale image, as 16 hex chars. */
export function pHash(gray: Float32Array): string {
  const N = 32, K = 8;
  const cos = new Float64Array(K * N);
  for (let u = 0; u < K; u++) for (let x = 0; x < N; x++) cos[u * N + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
  const coeffs: number[] = [];
  for (let u = 0; u < K; u++)
    for (let v = 0; v < K; v++) {
      let s = 0;
      for (let y = 0; y < N; y++) {
        const cy = cos[u * N + y];
        for (let x = 0; x < N; x++) s += gray[y * N + x] * cy * cos[v * N + x];
      }
      coeffs.push(s);
    }
  const ac = coeffs.slice(1).sort((a, b) => a - b);
  const median = ac[Math.floor(ac.length / 2)];
  let hi = 0, lo = 0;
  for (let i = 0; i < 64; i++) {
    const bit = coeffs[i] > median ? 1 : 0;
    if (i < 32) hi = (hi << 1) | bit;
    else lo = (lo << 1) | bit;
  }
  return (hi >>> 0).toString(16).padStart(8, "0") + (lo >>> 0).toString(16).padStart(8, "0");
}

function popcount(n: number) {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export function hamming(a: string, b: string): number {
  return (
    popcount((parseInt(a.slice(0, 8), 16) ^ parseInt(b.slice(0, 8), 16)) >>> 0) +
    popcount((parseInt(a.slice(8), 16) ^ parseInt(b.slice(8), 16)) >>> 0)
  );
}

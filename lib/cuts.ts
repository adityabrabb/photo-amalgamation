// Cut generators. Each returns shapes in design space; the shapes cut the image that is cover-fit
// into the design rect, so a shape's pixels are "where it came from" in that image.
import { Delaunay } from "d3-delaunay";
import type { Analysis } from "./analysis";
import { rectPoly, shapeArea, splitPolygon, polyCentroid, type Shape } from "./geometry";
import type { Rng } from "./prng";
import type { Cut } from "./settings";

export type Fit = { x: number; y: number; s: number };

type CutCtx = { rng: Rng; W: number; H: number; n: number; chaos: number; fit: Fit; imgW: number; imgH: number; analysis: Analysis };

function randomPoints(rng: Rng, W: number, H: number, n: number, chaos: number): number[] {
  // Blend of uniform and clustered points: chaos clusters them for more size variety.
  const clusters = Array.from({ length: 3 }, () => [rng.range(0.15, 0.85) * W, rng.range(0.15, 0.85) * H]);
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    if (rng.next() < chaos * 0.6) {
      const [cx, cy] = rng.pick(clusters);
      const r = Math.min(W, H) * 0.22;
      pts.push(Math.min(W, Math.max(0, cx + rng.gauss() * r)), Math.min(H, Math.max(0, cy + rng.gauss() * r)));
    } else {
      pts.push(rng.next() * W, rng.next() * H);
    }
  }
  return pts;
}

function voronoi({ rng, W, H, n, chaos }: CutCtx): Shape[] {
  const pts = randomPoints(rng, W, H, Math.max(3, n), chaos);
  const v = Delaunay.from(Array.from({ length: pts.length / 2 }, (_, i) => [pts[2 * i], pts[2 * i + 1]] as [number, number])).voronoi([0, 0, W, H]);
  const out: Shape[] = [];
  for (let i = 0; i < pts.length / 2; i++) {
    const cell = v.cellPolygon(i);
    if (!cell) continue;
    out.push({ k: "poly", pts: cell.slice(0, -1).flat() });
  }
  return out;
}

function triangles({ rng, W, H, n }: CutCtx): Shape[] {
  const count = Math.max(4, Math.round(n * 0.6));
  const pts: [number, number][] = [[0, 0], [W, 0], [W, H], [0, H]];
  for (let i = 0; i < count; i++) pts.push([rng.next() * W, rng.next() * H]);
  for (let i = 0; i < 4; i++) pts.push([rng.next() * W, 0], [rng.next() * W, H], [0, rng.next() * H], [W, rng.next() * H]);
  const d = Delaunay.from(pts);
  const out: Shape[] = [];
  for (let t = 0; t < d.triangles.length; t += 3) {
    const tri = [d.triangles[t], d.triangles[t + 1], d.triangles[t + 2]].flatMap((i) => pts[i]);
    out.push({ k: "poly", pts: tri });
  }
  return out;
}

/** Random polygons: recursive splits of the canvas by random lines (BSP). */
function polygons({ rng, W, H, n, chaos }: CutCtx): Shape[] {
  let polys = [rectPoly(0, 0, W, H)];
  const target = Math.max(3, n);
  let guard = 0;
  while (polys.length < target && guard++ < target * 6) {
    polys.sort((a, b) => shapeArea({ k: "poly", pts: b }) - shapeArea({ k: "poly", pts: a }));
    const idx = rng.next() < 0.7 ? 0 : rng.int(0, polys.length - 1);
    const p = polys[idx];
    const [cx, cy] = polyCentroid(p);
    const r = Math.sqrt(shapeArea({ k: "poly", pts: p })) * 0.25 * (0.3 + chaos);
    const halves = splitPolygon(p, cx + rng.gauss() * r, cy + rng.gauss() * r, rng.next() * Math.PI);
    if (halves.length === 2) polys.splice(idx, 1, ...halves);
  }
  return polys.map((pts) => ({ k: "poly", pts }));
}

function strips({ rng, W, H, n, chaos }: CutCtx): Shape[] {
  const count = Math.max(3, Math.round(n * 0.55));
  const base = rng.pick([0, Math.PI / 2, Math.PI / 2, rng.range(0.25, 0.6) * rng.sign()]);
  const angle = base + rng.gauss() * 0.05 * chaos;
  // Cut parallel lines across the canvas; widths vary.
  const nx = -Math.sin(angle), ny = Math.cos(angle);
  const corners = [[0, 0], [W, 0], [W, H], [0, H]].map(([x, y]) => x * nx + y * ny);
  const lo = Math.min(...corners), hi = Math.max(...corners);
  const widths = Array.from({ length: count }, () => Math.pow(rng.range(0.25, 1), 1 + chaos));
  const total = widths.reduce((a, b) => a + b, 0);
  let polys = [rectPoly(0, 0, W, H)];
  let acc = lo;
  for (let i = 0; i < count - 1; i++) {
    acc += (widths[i] / total) * (hi - lo);
    const px = nx * acc, py = ny * acc;
    const a = angle + rng.gauss() * 0.02 * chaos;
    polys = polys.flatMap((p) => splitPolygon(p, px, py, a));
  }
  return polys.map((pts) => ({ k: "poly", pts }));
}

/** Organic blobs; some edges torn (jagged geometry — not texture). */
function blob(rng: Rng, cx: number, cy: number, R: number, torn: boolean): Shape {
  const harmonics = Array.from({ length: 4 }, (_, i) => ({ k: i + 2, a: rng.range(0.03, 0.16) / (i + 1), p: rng.next() * Math.PI * 2 }));
  const count = torn ? 140 : 56;
  const tearStart = rng.next() * Math.PI * 2, tearLen = rng.range(0.6, 2.2);
  const pts: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = (i / count) * Math.PI * 2;
    let r = R * (1 + harmonics.reduce((s, h) => s + h.a * Math.sin(h.k * t + h.p), 0));
    const inTear = torn && ((t - tearStart + Math.PI * 4) % (Math.PI * 2)) < tearLen;
    if (inTear) r += R * rng.range(-0.035, 0.035) * (i % 2 ? 1 : -0.6);
    pts.push(cx + Math.cos(t) * r, cy + Math.sin(t) * r);
  }
  return { k: "poly", pts, smooth: !torn };
}

function blobs({ rng, W, H, n }: CutCtx): Shape[] {
  const count = Math.max(3, n);
  const R = Math.sqrt((W * H) / count) * 0.62;
  return Array.from({ length: count }, () =>
    blob(rng, rng.next() * W, rng.next() * H, R * rng.range(0.6, 1.4), rng.next() < 0.45),
  );
}

function circles({ rng, W, H, n }: CutCtx): Shape[] {
  const count = Math.max(3, n);
  const R = Math.sqrt((W * H) / count) * 0.55;
  return Array.from({ length: count }, (): Shape => {
    const r = R * rng.range(0.55, 1.45);
    const x = rng.next() * W, y = rng.next() * H;
    const kind = rng.next();
    if (kind < 0.5) return { k: "circle", cx: x, cy: y, r };
    if (kind < 0.8) return { k: "arch", x: x - r, y: y - r * 0.3, w: 2 * r, h: r * rng.range(0.6, 1.8) };
    return { k: "arch", x: x - r, y, w: 2 * r, h: 0 };
  });
}

/** Subject-ish cut: star-shaped region around the saliency mass, plus Voronoi background cells. */
function subject(ctx: CutCtx): Shape[] {
  const { analysis, fit, imgW, imgH } = ctx;
  const { w: gw, h: gh, data } = analysis.saliency;
  const mean = data.reduce((a, b) => a + b, 0) / data.length;
  const thr = Math.min(0.8, mean + 0.18);
  let sx = 0, sy = 0, sw = 0;
  data.forEach((v, i) => {
    if (v < thr) return;
    sx += (i % gw) * v; sy += Math.floor(i / gw) * v; sw += v;
  });
  const cx = sw ? sx / sw : gw / 2, cy = sw ? sy / sw : gh / 2;
  const at = (x: number, y: number) => {
    const xi = Math.round(x), yi = Math.round(y);
    return xi < 0 || yi < 0 || xi >= gw || yi >= gh ? 0 : data[yi * gw + xi];
  };
  const rays = 56;
  const radii: number[] = [];
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2;
    let r = 1;
    while (r < Math.max(gw, gh) && at(cx + Math.cos(a) * r, cy + Math.sin(a) * r) >= thr * 0.85) r += 0.5;
    radii.push(Math.max(2, r));
  }
  const smooth = radii.map((_, i) => {
    let s = 0;
    for (let d = -2; d <= 2; d++) s += radii[(i + d + rays) % rays];
    return s / 5;
  });
  // Grid coords → image px → design units.
  const pts: number[] = [];
  smooth.forEach((r, i) => {
    const a = (i / rays) * Math.PI * 2;
    const gx = cx + 0.5 + Math.cos(a) * r, gy = cy + 0.5 + Math.sin(a) * r;
    pts.push(fit.x + (gx / gw) * imgW * fit.s, fit.y + (gy / gh) * imgH * fit.s);
  });
  const subjectShape: Shape = { k: "poly", pts, smooth: true };
  return [subjectShape, ...voronoi({ ...ctx, n: Math.max(3, ctx.n - 1) })];
}

const CUT_FNS: Record<Cut, (ctx: CutCtx) => Shape[]> = { voronoi, strips, blobs, circles, triangles, polygons, subject };

export function cutShapes(cut: Cut, ctx: CutCtx): Shape[] {
  return CUT_FNS[cut](ctx).filter((s) => shapeArea(s) > 40);
}

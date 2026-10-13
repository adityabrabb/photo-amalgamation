// Shapes live in design space (short side = 1000 units). Polygons are flat [x0, y0, x1, y1, ...] arrays.

export type Shape =
  | { k: "poly"; pts: number[]; smooth?: boolean }
  | { k: "circle"; cx: number; cy: number; r: number }
  /** Rectangle (x, y, w, h) capped by a semicircle of radius w/2 on its top edge. h = 0 gives a half-disc. */
  | { k: "arch"; x: number; y: number; w: number; h: number };

export type Box = { x: number; y: number; w: number; h: number };

export function polyArea(pts: number[]): number {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i += 2) {
    const j = (i + 2) % n;
    a += pts[i] * pts[j + 1] - pts[j] * pts[i + 1];
  }
  return Math.abs(a) / 2;
}

export function polyCentroid(pts: number[]): [number, number] {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = pts.length; i < n; i += 2) {
    const j = (i + 2) % n;
    const cross = pts[i] * pts[j + 1] - pts[j] * pts[i + 1];
    a += cross;
    cx += (pts[i] + pts[j]) * cross;
    cy += (pts[i + 1] + pts[j + 1]) * cross;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sy = 0;
    for (let i = 0; i < pts.length; i += 2) {
      sx += pts[i];
      sy += pts[i + 1];
    }
    return [sx / (pts.length / 2), sy / (pts.length / 2)];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function shapeArea(s: Shape): number {
  switch (s.k) {
    case "poly":
      return polyArea(s.pts);
    case "circle":
      return Math.PI * s.r * s.r;
    case "arch":
      return s.w * s.h + (Math.PI * (s.w / 2) ** 2) / 2;
  }
}

export function shapeCentroid(s: Shape): [number, number] {
  switch (s.k) {
    case "poly":
      return polyCentroid(s.pts);
    case "circle":
      return [s.cx, s.cy];
    case "arch":
      return [s.x + s.w / 2, s.y + (s.h - s.w / 4) / 2];
  }
}

/** Closed outline as a polyline (curves sampled densely). */
export function shapeOutline(s: Shape, samples = 96): number[] {
  switch (s.k) {
    case "poly":
      return s.pts;
    case "circle": {
      const out: number[] = [];
      for (let i = 0; i < samples; i++) {
        const a = (i / samples) * Math.PI * 2;
        out.push(s.cx + Math.cos(a) * s.r, s.cy + Math.sin(a) * s.r);
      }
      return out;
    }
    case "arch": {
      const r = s.w / 2;
      const out: number[] = [s.x, s.y + s.h, s.x, s.y];
      const n = Math.max(8, samples / 2);
      for (let i = 0; i <= n; i++) {
        const a = Math.PI + (i / n) * Math.PI;
        out.push(s.x + r + Math.cos(a) * r, s.y + Math.sin(a) * r);
      }
      out.push(s.x + s.w, s.y + s.h);
      return out;
    }
  }
}

export function shapeBox(s: Shape): Box {
  if (s.k === "circle") return { x: s.cx - s.r, y: s.cy - s.r, w: 2 * s.r, h: 2 * s.r };
  if (s.k === "arch") return { x: s.x, y: s.y - s.w / 2, w: s.w, h: s.h + s.w / 2 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < s.pts.length; i += 2) {
    x0 = Math.min(x0, s.pts[i]);
    x1 = Math.max(x1, s.pts[i]);
    y0 = Math.min(y0, s.pts[i + 1]);
    y1 = Math.max(y1, s.pts[i + 1]);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Split a convex polygon by the line through (px, py) at angle a. Returns 0–2 non-empty halves. */
export function splitPolygon(pts: number[], px: number, py: number, a: number): number[][] {
  const nx = -Math.sin(a), ny = Math.cos(a);
  const side = (x: number, y: number) => (x - px) * nx + (y - py) * ny;
  const left: number[] = [], right: number[] = [];
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const ax = pts[2 * i], ay = pts[2 * i + 1];
    const j = (i + 1) % n;
    const bx = pts[2 * j], by = pts[2 * j + 1];
    const sa = side(ax, ay), sb = side(bx, by);
    if (sa >= 0) left.push(ax, ay);
    if (sa <= 0) right.push(ax, ay);
    if ((sa > 0 && sb < 0) || (sa < 0 && sb > 0)) {
      const t = sa / (sa - sb);
      const ix = ax + (bx - ax) * t, iy = ay + (by - ay) * t;
      left.push(ix, iy);
      right.push(ix, iy);
    }
  }
  return [left, right].filter((p) => p.length >= 6 && polyArea(p) > 1e-3);
}

export function rectPoly(x: number, y: number, w: number, h: number): number[] {
  return [x, y, x + w, y, x + w, y + h, x, y + h];
}

/** Resample a closed polyline to `count` points evenly spaced by arc length. */
export function resampleClosed(pts: number[], count: number): number[] {
  const n = pts.length / 2;
  const cum = [0];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    cum.push(cum[i] + Math.hypot(pts[2 * j] - pts[2 * i], pts[2 * j + 1] - pts[2 * i + 1]));
  }
  const total = cum[n];
  const out: number[] = [];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const d = (k / count) * total;
    while (seg < n - 1 && cum[seg + 1] < d) seg++;
    const j = (seg + 1) % n;
    const t = (d - cum[seg]) / Math.max(1e-9, cum[seg + 1] - cum[seg]);
    out.push(pts[2 * seg] + (pts[2 * j] - pts[2 * seg]) * t, pts[2 * seg + 1] + (pts[2 * j + 1] - pts[2 * seg + 1]) * t);
  }
  return out;
}

/** Build the shape outline onto a path (Path2D or a context). Curves stay true curves for crisp edges. */
export function traceShape(p: Path2D | CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, s: Shape) {
  switch (s.k) {
    case "circle":
      p.moveTo(s.cx + s.r, s.cy);
      p.arc(s.cx, s.cy, s.r, 0, Math.PI * 2);
      break;
    case "arch":
      p.moveTo(s.x, s.y + s.h);
      p.lineTo(s.x, s.y);
      p.arc(s.x + s.w / 2, s.y, s.w / 2, Math.PI, Math.PI * 2);
      p.lineTo(s.x + s.w, s.y + s.h);
      break;
    case "poly": {
      const pts = s.pts;
      const n = pts.length / 2;
      if (s.smooth) {
        // Quadratic curves through edge midpoints: a smooth closed outline.
        const mid = (i: number): [number, number] => {
          const j = (i + 1) % n;
          return [(pts[2 * i] + pts[2 * j]) / 2, (pts[2 * i + 1] + pts[2 * j + 1]) / 2];
        };
        const [mx, my] = mid(n - 1);
        p.moveTo(mx, my);
        for (let i = 0; i < n; i++) {
          const [ex, ey] = mid(i);
          p.quadraticCurveTo(pts[2 * i], pts[2 * i + 1], ex, ey);
        }
      } else {
        p.moveTo(pts[0], pts[1]);
        for (let i = 1; i < n; i++) p.lineTo(pts[2 * i], pts[2 * i + 1]);
      }
      break;
    }
  }
  p.closePath();
}

/** Affine transform as [a, b, c, d, e, f] (canvas setTransform order). */
export type Mat = [number, number, number, number, number, number];

export function placeMatrix(pos: [number, number], rot: number, scale: number, flip: boolean, home: [number, number]): Mat {
  const cos = Math.cos(rot) * scale, sin = Math.sin(rot) * scale;
  const fx = flip ? -1 : 1;
  const a = cos * fx, b = sin * fx, c = -sin, d = cos;
  return [a, b, c, d, pos[0] - a * home[0] - c * home[1], pos[1] - b * home[0] - d * home[1]];
}

export function mulMat(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function applyMat(m: Mat, pts: number[]): number[] {
  const out = new Array<number>(pts.length);
  for (let i = 0; i < pts.length; i += 2) {
    out[i] = m[0] * pts[i] + m[2] * pts[i + 1] + m[4];
    out[i + 1] = m[1] * pts[i] + m[3] * pts[i + 1] + m[5];
  }
  return out;
}

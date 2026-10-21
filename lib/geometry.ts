// Shapes live in design space (short side = 1000 units). Polygons are flat [x0, y0, x1, y1, ...] arrays.

export type Shape =
  | { k: "poly"; pts: number[]; smooth?: boolean }
  | { k: "circle"; cx: number; cy: number; r: number }
  /** Rectangle (x, y, w, h) capped by a semicircle of radius w/2 on its top edge. h = 0 gives a half-disc. */
  | { k: "arch"; x: number; y: number; w: number; h: number };

export type Box = { x: number; y: number; w: number; h: number };

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


// WebGL liquid warp: a smooth sinusoidal displacement field (no noise). Processed in tiles so large
// exports work within MAX_TEXTURE_SIZE. Zero displacement samples exact texel centers → identical pixels.
import type { Plan } from "./planner";

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_texOrigin;
uniform vec2 u_texSize;
uniform vec2 u_tileOrigin;
uniform vec2 u_tileSize;
uniform float u_S;
uniform float u_amp;
uniform vec4 u_f;
uniform vec4 u_p;
void main() {
  vec2 dev = u_tileOrigin + vec2(gl_FragCoord.x, u_tileSize.y - gl_FragCoord.y);
  vec2 d = dev / u_S;
  vec2 disp = u_amp * vec2(
    sin(d.y * u_f.x + u_p.x + 1.3 * sin(d.x * u_f.z + u_p.z)),
    cos(d.x * u_f.y + u_p.y + 1.3 * sin(d.y * u_f.w + u_p.w))
  );
  vec2 src = dev + disp * u_S;
  gl_FragColor = texture2D(u_tex, (src - u_texOrigin) / u_texSize);
}
`;

type GL = {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  prog: WebGLProgram;
  tex: WebGLTexture;
  maxTex: number;
  u: Record<string, WebGLUniformLocation | null>;
};

let cached: GL | null | undefined;

function init(): GL | null {
  if (cached !== undefined) return cached;
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl", { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
  if (!gl) return (cached = null);
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader error");
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "a_pos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const names = ["u_tex", "u_texOrigin", "u_texSize", "u_tileOrigin", "u_tileSize", "u_S", "u_amp", "u_f", "u_p"];
  const u = Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(prog, n)]));
  return (cached = { canvas, gl, prog, tex, maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, u });
}

/** Applies the warp in place. Returns false if WebGL is unavailable (piece renders unwarped). */
export function warpPass(ctx: CanvasRenderingContext2D, W: number, H: number, S: number, warp: NonNullable<Plan["warp"]>): boolean {
  let g: GL | null;
  try {
    g = init();
  } catch {
    g = cached = null;
  }
  if (!g) return false;
  const { gl, canvas, u } = g;

  // Snapshot so tiles read unwarped neighbours.
  const snap = document.createElement("canvas");
  snap.width = W;
  snap.height = H;
  snap.getContext("2d")!.drawImage(ctx.canvas, 0, 0);

  const margin = Math.ceil(warp.amp * S * 1.6) + 2;
  const tile = Math.max(256, Math.min(2048, g.maxTex - 2 * margin));
  const srcCanvas = document.createElement("canvas");
  const sctx = srcCanvas.getContext("2d")!;

  gl.uniform1i(u.u_tex, 0);
  gl.uniform1f(u.u_S, S);
  gl.uniform1f(u.u_amp, warp.amp);
  gl.uniform4fv(u.u_f, warp.f);
  gl.uniform4fv(u.u_p, warp.p);

  for (let ty = 0; ty < H; ty += tile) {
    for (let tx = 0; tx < W; tx += tile) {
      const tw = Math.min(tile, W - tx), th = Math.min(tile, H - ty);
      const sx = Math.max(0, tx - margin), sy = Math.max(0, ty - margin);
      const sw = Math.min(W, tx + tw + margin) - sx, sh = Math.min(H, ty + th + margin) - sy;
      srcCanvas.width = sw;
      srcCanvas.height = sh;
      sctx.drawImage(snap, sx, sy, sw, sh, 0, 0, sw, sh);

      canvas.width = tw;
      canvas.height = th;
      gl.viewport(0, 0, tw, th);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, srcCanvas);
      gl.uniform2f(u.u_texOrigin, sx, sy);
      gl.uniform2f(u.u_texSize, sw, sh);
      gl.uniform2f(u.u_tileOrigin, tx, ty);
      gl.uniform2f(u.u_tileSize, tw, th);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      ctx.beginPath();
      ctx.rect(tx, ty, tw, th);
      ctx.clip();
      ctx.drawImage(canvas, tx, ty);
      ctx.restore();
    }
  }
  snap.width = snap.height = srcCanvas.width = srcCanvas.height = 0;
  return true;
}

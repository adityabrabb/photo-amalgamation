// Promise wrapper around the engine worker.
import type { Analysis } from "./analysis";
import type { Plan, PlanImage } from "./planner";
import type { PieceSpec } from "./settings";

export type EngineRequest =
  | { type: "analyze"; image: ImageData; hash: string }
  | { type: "plan"; spec: PieceSpec; images: PlanImage[] }
  | { type: "phash"; gray: Float32Array };

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("../workers/engine.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) p.resolve(e.data.result);
    else p.reject(new Error(e.data.error));
  };
  worker.onerror = (e) => {
    pending.forEach((p) => p.reject(new Error(e.message || "Engine worker failed")));
    pending.clear();
  };
  return worker;
}

function call<T>(req: EngineRequest, transfer: Transferable[] = []): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    getWorker().postMessage({ ...req, id }, transfer);
  });
}

export const engine = {
  analyze: (image: ImageData, hash: string) => call<Analysis>({ type: "analyze", image, hash }, [image.data.buffer]),
  plan: (spec: PieceSpec, images: PlanImage[]) => call<Plan>({ type: "plan", spec, images }),
  phash: (gray: Float32Array) => call<string>({ type: "phash", gray }, [gray.buffer]),
};

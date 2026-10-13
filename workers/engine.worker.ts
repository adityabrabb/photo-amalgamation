// Heavy lifting off the main thread: image analysis (palette + saliency), cuts/planning, perceptual hashing.
import { analyzeImage, pHash } from "../lib/analysis";
import { planComposition } from "../lib/planner";
import type { EngineRequest } from "../lib/engine";

self.onmessage = (e: MessageEvent<EngineRequest & { id: number }>) => {
  const msg = e.data;
  try {
    let result: unknown;
    switch (msg.type) {
      case "analyze":
        result = analyzeImage(msg.image, msg.hash);
        break;
      case "plan":
        result = planComposition(msg.spec, msg.images);
        break;
      case "phash":
        result = pHash(msg.gray);
        break;
    }
    self.postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};

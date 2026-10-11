import * as ort from "onnxruntime-web/webgpu";

import type { Detection } from "./types.ts";

export type { Detection };

declare global {
  // we only ever check whether WebGPU exists, so the full @webgpu/types is overkill
  interface Navigator {
    readonly gpu?: unknown;
  }
}

// No `ort.env.wasm.wasmPaths` on purpose: the bundled build resolves its wasm
// through `import.meta.url`, which vite understands - it serves the file in dev
// and emits it as a hashed asset in the build. Pointing wasmPaths at a /public
// path instead breaks dev outright, because vite refuses to serve /public as a
// module and ort loads that file with a dynamic import.

/**
 * Multi-threaded WASM needs SharedArrayBuffer, which browsers only expose on a
 * cross-origin-isolated page (COOP + COEP headers). Asking for threads without
 * it does not degrade gracefully - the WASM bootstrap fails outright, and takes
 * the WebGPU provider down with it, because both are built on the same runtime.
 *
 * Single-threaded is slower but always available. Serve the app with COOP/COEP
 * if the extra frames per second are ever worth the cross-origin restrictions.
 */
const threadsAvailable = typeof SharedArrayBuffer !== "undefined";
ort.env.wasm.numThreads = threadsAvailable ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;

const IOU_THRESHOLD = 0.45;

export class Detector {
  private session!: ort.InferenceSession;
  private canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;
  private input!: Float32Array;
  backend = "";
  size = 416;

  async load(modelUrl: string): Promise<void> {
    // WebGPU is several times faster on modern Android; wasm is the fallback
    // that always works.
    const failures: string[] = [];
    // wasm only: two models on WebGPU at once hang some phones; wasm is slower but always runs
    const providers = ["wasm"] as const;

    for (const ep of providers) {
      try {
        this.session = await ort.InferenceSession.create(modelUrl, {
          executionProviders: [ep],
          graphOptimizationLevel: "all",
        });
        this.backend = ep;
        break;
      } catch (err) {
        console.warn(`[detector] ${ep} unavailable`, err);
        failures.push(`${ep}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!this.session) {
      // whatever went wrong here is invisible on a phone with no devtools, so
      // carry the environment along with the underlying errors
      throw new Error(
        `no ONNX execution provider available\n` +
          `[gpu=${!!navigator.gpu} threads=${threadsAvailable} isolated=${self.crossOriginIsolated}]\n` +
          failures.join("\n"),
      );
    }

    const meta = this.session.inputMetadata?.[0];
    const modelSize = meta && "shape" in meta ? meta.shape[2] : undefined;
    if (typeof modelSize === "number" && modelSize > 0) this.size = modelSize;
    this.canvas.width = this.canvas.height = this.size;
    this.input = new Float32Array(3 * this.size * this.size);
  }

  /**
   * Letterbox `source` into the square model input, preserving aspect ratio so
   * boxes can be mapped back to frame pixels without distortion.
   */
  private preprocess(source: CanvasImageSource, sw: number, sh: number) {
    const scale = Math.min(this.size / sw, this.size / sh);
    const dw = Math.round(sw * scale);
    const dh = Math.round(sh * scale);
    const padX = (this.size - dw) / 2;
    const padY = (this.size - dh) / 2;

    this.ctx.fillStyle = "#727272"; // neutral grey padding, as ultralytics uses
    this.ctx.fillRect(0, 0, this.size, this.size);
    this.ctx.drawImage(source, padX, padY, dw, dh);

    const { data } = this.ctx.getImageData(0, 0, this.size, this.size);
    const plane = this.size * this.size;
    for (let i = 0; i < plane; i++) {
      this.input[i] = data[i * 4] / 255;
      this.input[plane + i] = data[i * 4 + 1] / 255;
      this.input[2 * plane + i] = data[i * 4 + 2] / 255;
    }
    return { scale, padX, padY };
  }

  async detect(source: CanvasImageSource, sw: number, sh: number, minScore: number): Promise<Detection[]> {
    const { scale, padX, padY } = this.preprocess(source, sw, sh);
    const feeds = {
      [this.session.inputNames[0]]: new ort.Tensor("float32", this.input, [1, 3, this.size, this.size]),
    };
    const out = await this.session.run(feeds);
    return this.decode(out[this.session.outputNames[0]], scale, padX, padY, minScore);
  }

  /** YOLOv8 head: [1, 4 + numClasses, numAnchors], boxes as cx,cy,w,h. */
  private decode(tensor: ort.Tensor, scale: number, padX: number, padY: number, minScore: number): Detection[] {
    const [, channels, anchors] = tensor.dims as number[];
    const data = tensor.data as Float32Array;
    const numClasses = channels - 4;
    const raw: Detection[] = [];

    for (let a = 0; a < anchors; a++) {
      let best = 0;
      let bestCls = 0;
      for (let c = 0; c < numClasses; c++) {
        const score = data[(4 + c) * anchors + a];
        if (score > best) {
          best = score;
          bestCls = c;
        }
      }
      if (best < minScore) continue;

      const cx = data[a];
      const cy = data[anchors + a];
      const w = data[2 * anchors + a];
      const h = data[3 * anchors + a];
      raw.push({
        x: (cx - w / 2 - padX) / scale,
        y: (cy - h / 2 - padY) / scale,
        w: w / scale,
        h: h / scale,
        score: best,
        cls: bestCls,
      });
    }
    return nms(raw, IOU_THRESHOLD);
  }
}

export function iou(a: Detection, b: Detection): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const overlap = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - overlap;
  return union > 0 ? overlap / union : 0;
}

export function nms(boxes: Detection[], threshold: number): Detection[] {
  const kept: Detection[] = [];
  for (const box of [...boxes].sort((p, q) => q.score - p.score)) {
    if (kept.every((k) => k.cls !== box.cls || iou(k, box) < threshold)) kept.push(box);
  }
  return kept;
}

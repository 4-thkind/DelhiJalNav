/**
 * Runs the water segmentation model (SegFormer-b0, ADE20K) on a camera frame or
 * photo. Same ONNX runtime as the pothole detector; WebGPU when available.
 * Licence: NVIDIA SegFormer licence (research / non-commercial) - see PROVENANCE.md.
 */
import * as ort from "onnxruntime-web/webgpu";

import { waterFromLogits, type WaterFrame } from "./water.ts";

const SIZE = 256; // ~40 ms on a laptop CPU; plenty for a 1 Hz road check
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export class WaterModel {
  private session?: ort.InferenceSession;
  private canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;
  private input = new Float32Array(3 * SIZE * SIZE);
  backend = "";

  get ready(): boolean {
    return !!this.session;
  }

  async load(url: string): Promise<void> {
    for (const ep of ["wasm"] as const) { // see detector.ts: WebGPU with two models hangs some phones
      try {
        this.session = await ort.InferenceSession.create(url, { executionProviders: [ep] });
        this.backend = ep;
        break;
      } catch (err) {
        console.warn(`[water] ${ep} unavailable`, err);
      }
    }
    if (!this.session) throw new Error("water model could not load");
    this.canvas.width = this.canvas.height = SIZE;
  }

  /** Stretch the frame to the square input (as the model was trained), normalise, run. */
  async analyse(source: CanvasImageSource, horizonFrac: number): Promise<WaterFrame> {
    if (!this.session) return { fraction: 0, box: null };
    this.ctx.drawImage(source, 0, 0, SIZE, SIZE);
    const px = this.ctx.getImageData(0, 0, SIZE, SIZE).data;
    const plane = SIZE * SIZE;
    for (let i = 0; i < plane; i++) {
      for (let c = 0; c < 3; c++) this.input[c * plane + i] = (px[i * 4 + c] / 255 - MEAN[c]) / STD[c];
    }
    const feeds = { [this.session.inputNames[0]]: new ort.Tensor("float32", this.input, [1, 3, SIZE, SIZE]) };
    const out = (await this.session.run(feeds))[this.session.outputNames[0]];
    const [, classes, h, w] = out.dims as number[];
    return waterFromLogits(out.data as Float32Array, classes, h, w, horizonFrac);
  }
}

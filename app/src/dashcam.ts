/**
 * Rolling dashcam / digital black box, speed-adaptive.
 *
 * Frames are copied from the camera onto a canvas at a rate set by speed -
 * 2 fps stopped, 10 fps crawling, 20 fps cruising, 30 fps around a hazard -
 * with time, speed and position burned in, and the canvas stream is recorded.
 * That keeps storage and heat down in slow monsoon traffic while still giving
 * full detail when something happens.
 *
 * MediaRecorder emits timesliced chunks kept in a bounded in-memory ring.
 * Nothing touches disk until an incident is flagged, so a normal ride leaves no
 * footage behind - that is both the privacy story and the storage story.
 */
const SLICE_MS = 2000;
/** Hazard boost lasts this long after the last hazard. */
const BOOST_MS = 10_000;

export interface SavedClip {
  id: number;
  at: number;
  seconds: number;
  blob: Blob;
  lat?: number;
  lon?: number;
  reason: string;
}

/** Target frame rate for a speed, per the speed-to-frames table. */
export function targetFps(speedKmh: number, hazard: boolean): number {
  if (hazard) return 30;
  if (speedKmh < 5) return 2;
  if (speedKmh <= 25) return 10;
  return 20;
}

export class Dashcam {
  private recorder?: MediaRecorder;
  /** chunks[0] holds the container header; it is never dropped, or the clip will not play. */
  private chunks: Blob[] = [];
  private mimeType = "";
  private canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d")!;
  private timer?: ReturnType<typeof setTimeout>;
  private boostUntil = 0;
  private telemetry = { speedKmh: 0, lat: undefined as number | undefined, lon: undefined as number | undefined };
  /** Rolling window length in seconds. */
  bufferSeconds = 180;
  clips: SavedClip[] = [];
  fps = 0;

  get recording(): boolean {
    return this.recorder?.state === "recording";
  }

  get bufferedSeconds(): number {
    return (this.chunks.length * SLICE_MS) / 1000;
  }

  start(video: HTMLVideoElement): void {
    if (this.recording || !("captureStream" in this.canvas)) return;
    // half the camera resolution: enough to read a number plate near, light on a phone
    const scale = Math.min(1, 960 / (video.videoWidth || 960));
    this.canvas.width = Math.round((video.videoWidth || 960) * scale);
    this.canvas.height = Math.round((video.videoHeight || 540) * scale);
    const stream = this.canvas.captureStream(0); // frames are pushed by requestFrame below
    const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
    // WebM first: Chrome's MP4 recorder emits no timesliced chunks, so the ring stays empty. MP4 is for Safari.
    this.mimeType = ["video/webm;codecs=vp9", "video/webm", "video/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
    this.recorder = new MediaRecorder(stream, { ...(this.mimeType ? { mimeType: this.mimeType } : {}), videoBitsPerSecond: 1_200_000 });
    this.recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      this.chunks.push(event.data);
      const maxChunks = Math.ceil((this.bufferSeconds * 1000) / SLICE_MS);
      if (this.chunks.length > maxChunks) this.chunks.splice(1, this.chunks.length - maxChunks);
    };
    this.recorder.start(SLICE_MS);

    const draw = () => {
      if (!this.recording) return;
      this.fps = targetFps(this.telemetry.speedKmh, Date.now() < this.boostUntil);
      if (video.readyState >= 2) {
        const { ctx, canvas } = this;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const { speedKmh, lat, lon } = this.telemetry;
        const stamp = `${new Date().toLocaleString("en-IN")}  ${speedKmh.toFixed(0)} km/h  ${this.fps} fps` +
          (lat !== undefined ? `  ${lat.toFixed(5)}, ${lon!.toFixed(5)}` : "");
        ctx.font = "bold 16px monospace";
        ctx.fillStyle = "rgba(10, 51, 35, 0.75)";
        ctx.fillRect(8, canvas.height - 34, ctx.measureText(stamp).width + 16, 26);
        ctx.fillStyle = "#F7F4D5";
        ctx.fillText(stamp, 16, canvas.height - 15);
        track.requestFrame?.();
      }
      this.timer = setTimeout(draw, 1000 / this.fps);
    };
    draw();
  }

  /** Called on every GPS fix. */
  update(speedKmh: number, lat?: number, lon?: number): void {
    this.telemetry = { speedKmh, lat, lon };
  }

  /** Something dangerous ahead: record at full rate for the next few seconds. */
  boost(): void {
    this.boostUntil = Date.now() + BOOST_MS;
  }

  stop(): void {
    clearTimeout(this.timer);
    if (this.recording) this.recorder!.stop();
    this.chunks = [];
  }

  /** Freeze the current rolling window into a permanent local clip. */
  saveIncident(position?: GeolocationPosition, reason = "manual"): SavedClip | undefined {
    if (!this.chunks.length) return undefined;
    const clip: SavedClip = {
      id: Date.now(),
      at: Date.now(),
      seconds: Math.round(this.bufferedSeconds),
      blob: new Blob(this.chunks, { type: this.mimeType || "video/webm" }),
      lat: position?.coords.latitude,
      lon: position?.coords.longitude,
      reason,
    };
    this.clips.unshift(clip);
    this.clips.length = Math.min(this.clips.length, 6); // memory bound: older clips go
    return clip;
  }
}

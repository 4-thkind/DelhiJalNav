import type { Alert } from "./hazards.ts";

/**
 * Audio warnings. A rider's eyes belong on the road, so sound carries the
 * warning and the screen only confirms it.
 *
 * A short chime fires immediately (it is the part that actually buys reaction
 * time). Speech follows in a natural neural voice (server /v1/tts, Python
 * edge-tts) when that audio is already fetched or arrives within NEURAL_WAIT_MS;
 * otherwise the phone's built-in voice says it, so a slow network never delays
 * a warning. Fixed phrases and the route's turns are prefetched at ride start.
 */
const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const NEURAL_WAIT_MS = 1200;

export class AlertVoice {
  private ctx?: AudioContext;
  private clips = new Map<string, Promise<AudioBuffer | null>>();
  private playing?: AudioBufferSourceNode;
  private queue: Promise<void> = Promise.resolve();
  enabled = true;
  speech = true;
  /** Use the natural server voice when reachable. */
  neural = true;
  /** BCP-47 voice language, "en-IN" or "hi-IN". */
  lang = "en-IN";

  /** Must be called from a user gesture - browsers block audio otherwise. */
  unlock(): void {
    this.ctx ??= new AudioContext();
    void this.ctx.resume();
  }

  private chime(severity: number): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    // higher and louder the more severe, so urgency is audible without words
    osc.frequency.setValueAtTime(660 + 340 * Math.min(1, severity), now);
    osc.frequency.exponentialRampToValueAtTime(440, now + 0.18);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.25, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.36);
  }

  /** Fetch + decode neural audio for a phrase once; null when unavailable (offline, no server TTS). */
  private clip(text: string): Promise<AudioBuffer | null> {
    const key = this.lang + "|" + text;
    let hit = this.clips.get(key);
    if (!hit) {
      const lang = this.lang.startsWith("hi") ? "hi" : "en";
      hit = fetch(`${API_BASE}/v1/tts?${new URLSearchParams({ text, lang })}`)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error("tts " + r.status))))
        .then((bytes) => (this.ctx ??= new AudioContext()).decodeAudioData(bytes))
        .catch(() => {
          this.clips.delete(key); // try again on a later phrase, not in a loop now
          return null;
        });
      this.clips.set(key, hit);
    }
    return hit;
  }

  /**
   * Warm the cache so these phrases play instantly in the natural voice. Two at
   * a time: each takes seconds to synthesise, and a browser has only ~6
   * connections per host - a burst would stall route and report requests.
   */
  prefetch(texts: string[]): void {
    if (!this.neural || !navigator.onLine) return;
    const todo = [...new Set(texts)];
    const worker = async () => {
      for (let t = todo.shift(); t !== undefined; t = todo.shift()) await this.clip(t);
    };
    void worker();
    void worker();
  }

  private builtIn(text: string): Promise<void> {
    if (!("speechSynthesis" in window)) return Promise.resolve();
    return new Promise((done) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = this.lang;
      u.onend = u.onerror = () => done();
      speechSynthesis.speak(u);
    });
  }

  private async speakNow(text: string): Promise<void> {
    const buffer = this.neural
      ? await Promise.race([this.clip(text), new Promise<null>((r) => setTimeout(() => r(null), NEURAL_WAIT_MS))])
      : null;
    if (!buffer || !this.ctx) return this.builtIn(text);
    const node = this.ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(this.ctx.destination);
    this.playing = node;
    await new Promise<void>((done) => {
      node.onended = () => done();
      node.start();
    });
  }

  private stopAll(): void {
    try {
      this.playing?.stop();
    } catch {
      /* already stopped */
    }
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    this.queue = Promise.resolve();
  }

  announce(alert: Alert): void {
    if (!this.enabled) return;
    this.chime(alert.severity);
    if (alert.severity < 0.5) return;
    this.say(alert.spoken, true, false);
  }

  /** Urgent speech cuts off whatever is playing (a stale announcement is worse than none); the rest queues. */
  say(text: string, urgent = false, chime = urgent): void {
    if (!this.enabled) return;
    if (chime) this.chime(1);
    if (!this.speech) return;
    if (urgent) this.stopAll();
    this.queue = this.queue.then(() => this.speakNow(text)).catch(() => {});
  }
}

/** One voice for the whole app (planner previews and the ride share it). */
export const voice = new AlertVoice();

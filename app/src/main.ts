import "./style.css";
import { voice } from "./alerts.ts";
import { Dashcam } from "./dashcam.ts";
import { Detector } from "./detector.ts";
import {
  along,
  arrow,
  cumulative,
  formatDistance,
  haversine,
  MAX_GUIDANCE_ACCURACY_M,
  MAX_USABLE_ACCURACY_M,
  nextStep,
  project,
  smoothFix,
  type Fix,
} from "./flood/navcore.ts";
import { avoidWater, initPlanner, onPlanChange, ridePlan, type RidePlan } from "./flood/planner.ts";
import { alertText, type AlertKey } from "./flood/i18n.ts";
import { estimatePotholeDepth, type DepthResult } from "./potholeDepth.ts";
import { AlertEngine, corridorHalfWidth, type Alert, type Track } from "./hazards.ts";
import { Compass, HazardNetwork, ReportQueue, RideLocation, distanceM } from "./geo.ts";
import { className, type Detection } from "./types.ts";
import { WaterGate, type WaterBox } from "./water.ts";
import { WaterModel } from "./waterModel.ts";
import { createMap, type Circle, type HtmlMarker, type Layer, type MapView } from "./map/mapview.ts";
import { floodSpiral, potholePing, riderAvatar } from "./map/markers.ts";
import { ahead, loadPotholes, loadWater, logPothole, logWater } from "./potholeLog.ts";

/** Legacy pothole API (server/main.py). The flood route flow uses /v1 instead. */
const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const SETTINGS_KEY = "margsetu.cameraSettings";
const LEGACY_SETTINGS_KEY = "pathfinder.settings";
const MODEL_URL = "/models/pothole-yolov8n.onnx";
const WATER_MODEL_URL = "/models/water-segformer-b0-ade.onnx";
/** Run the water model about this often while riding. */
const WATER_EVERY_MS = 800;
/** Report to the network only when we are quite sure - false positives poison the map. */
const REPORT_CONFIDENCE = 0.55;
/** Further than this from the route line counts as off route. */
const OFF_ROUTE_M = 60;
/** Warn once when the rider is this close to a hotspot with reported water. */
const WATER_WARN_M = 400;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const detector = new Detector();
const engine = new AlertEngine();
const dashcam = new Dashcam();
const rider = new RideLocation();
const queue = new ReportQueue(API_BASE);
const network = new HazardNetwork(API_BASE);
const compass = new Compass();

const video = $<HTMLVideoElement>("cam");
const overlay = $<HTMLCanvasElement>("overlay");
const paint = overlay.getContext("2d")!;

let stream: MediaStream | undefined;
let wakeLock: WakeLockSentinel | undefined;
let running = false;
let cameraOn = false;
let detectorReady = false;
let detectorLoading: Promise<void> | undefined;
let ride = { startedAt: 0, metres: 0, hazards: 0, alerts: 0, water: [] as { time: number; at?: [number, number] }[] };
const waterModel = new WaterModel();
const waterGate = new WaterGate();
let waterLoading: Promise<void> | undefined;
let waterBox: WaterBox | null = null;
let waterAt = 0;
/** Depth estimate per pothole track, refreshed every few frames. */
const depthBy = new Map<number, DepthResult>();
const depthCanvas = document.createElement("canvas");
depthCanvas.width = depthCanvas.height = 48;
const depthCtx = depthCanvas.getContext("2d", { willReadFrequently: true })!;
let frameNo = 0;
const RIDE_MODE_KEY = "margsetu.rideMode";
type RideMode = "camera" | "pocket";
let rideMode: RideMode = "camera";
try {
  if (localStorage.getItem(RIDE_MODE_KEY) === "pocket") rideMode = "pocket";
} catch {
  /* default camera */
}
/** The turn instruction already spoken, so each is said once. */
let spokenStep = -1;
let lastFrameAt = 0;
let fps = 0;

// ---------------------------------------------------------------- settings
interface Settings {
  heightM: number;
  horizonFrac: number;
  vFovDeg: number;
  minScore: number;
  warnSeconds: number;
  bufferSeconds: number;
  speech: boolean;
  /** Natural neural voice from the server when online; built-in voice otherwise. */
  neuralVoice: boolean;
  upload: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  heightM: 1,
  horizonFrac: 0.45,
  vFovDeg: 55,
  minScore: 0.4,
  warnSeconds: 3.5,
  bufferSeconds: 180,
  speech: true,
  neuralVoice: true,
  // sharing is an explicit choice, never a default
  upload: false,
};

/**
 * Stored settings are untrusted: a corrupt or hand-edited value must not stop
 * the app from booting. Unknown keys and wrong types fall back to defaults.
 */
function loadSettings(): Settings {
  const merged = { ...DEFAULT_SETTINGS };
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? localStorage.getItem(LEGACY_SETTINGS_KEY) ?? "{}");
  } catch {
    raw = {};
  }
  if (raw && typeof raw === "object") {
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      const value = (raw as Record<string, unknown>)[key];
      if (typeof value === typeof DEFAULT_SETTINGS[key] && (typeof value !== "number" || Number.isFinite(value))) {
        (merged[key] as unknown) = value;
      }
    }
  }
  try {
    localStorage.removeItem(LEGACY_SETTINGS_KEY);
  } catch {
    /* ignore */
  }
  return merged;
}

const settings: Settings = loadSettings();

function applySettings(): void {
  engine.cam.heightM = settings.heightM;
  engine.cam.horizonFrac = settings.horizonFrac;
  engine.cam.vFovDeg = settings.vFovDeg;
  engine.cfg.minScore = settings.minScore;
  engine.cfg.warnSeconds = settings.warnSeconds;
  dashcam.bufferSeconds = settings.bufferSeconds;
  voice.speech = settings.speech;
  voice.neural = settings.neuralVoice;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage blocked: settings last for this session only */
  }
}

function bindSettings(): void {
  const bindRange = (inputId: string, outputId: string, key: keyof Settings, format: (v: number) => string) => {
    const input = $<HTMLInputElement>(inputId);
    const output = $<HTMLOutputElement>(outputId);
    input.value = String(settings[key]);
    output.textContent = format(Number(settings[key]));
    input.addEventListener("input", () => {
      (settings[key] as number) = Number(input.value);
      output.textContent = format(Number(input.value));
      applySettings();
    });
  };

  bindRange("in-height", "out-height", "heightM", (v) => v.toFixed(2) + " m");
  bindRange("in-horizon", "out-horizon", "horizonFrac", (v) => v.toFixed(2));
  bindRange("in-fov", "out-fov", "vFovDeg", (v) => v + "°");
  bindRange("in-score", "out-score", "minScore", (v) => v.toFixed(2));
  bindRange("in-warn", "out-warn", "warnSeconds", (v) => v.toFixed(1) + " s");
  bindRange("in-buffer", "out-buffer", "bufferSeconds", (v) => v + " s");

  for (const [id, key] of [["in-speech", "speech"], ["in-neural", "neuralVoice"], ["in-upload", "upload"]] as const) {
    const box = $<HTMLInputElement>(id);
    box.checked = settings[key];
    box.addEventListener("change", () => {
      settings[key] = box.checked;
      applySettings();
    });
  }
}

// ------------------------------------------------------------------ screens
const SCREENS = ["planner", "welcome", "place", "report", "evidence", "sos", "ride", "summary", "settings"] as const;
type ScreenName = (typeof SCREENS)[number];
/** Panels drawn over the planner map; the map stays visible (and keeps its state) underneath. */
const OVERLAYS: readonly ScreenName[] = ["welcome", "place", "report", "evidence", "sos"];

function show(target: ScreenName): void {
  const base = OVERLAYS.includes(target) ? "planner" : target;
  for (const name of SCREENS) $("screen-" + name).classList.toggle("hidden", name !== target && name !== base);
  if (!OVERLAYS.includes(target)) window.scrollTo(0, 0);
}

// ------------------------------------------------------------- ride map + route
let rideMap: MapView | undefined;
let rideMarker: HtmlMarker | undefined;
let rideTagLayer: Layer | undefined;
let rideRouteLayer: Layer | undefined;
const avatarEl = riderAvatar();
/** Where the avatar should be (latest fix) and where it is drawn (eased towards it every frame). */
let target: { lon: number; lat: number; heading: number } | undefined;
let shown: { lon: number; lat: number; heading: number } | undefined;
let lastFollowAt = 0;
let potholes = loadPotholes();
/** Camera water sightings, kept for a few hours so the spirals stay on both maps. */
let waterSeen = loadWater();
/** Detector tracks already put on the map this ride. */
const mappedTracks = new Set<number>();
/** Third-person camera: zoom, and how far ahead of the rider it looks so the avatar sits low on screen. */
const FOLLOW_ZOOM = 18;
const LOOK_AHEAD_M = 45;
let plan: RidePlan | undefined;
let accuracyCircle: Circle | undefined;
let estimate: Fix | undefined;
let planCum: number[] = [];
const warnedHotspots = new Set<string>();

let rideMapReady: Promise<void> | undefined;

/** The camera follows the rider unless the user dragged the map to look around. */
let rideFollow = true;
function setRideFollow(on: boolean): void {
  rideFollow = on;
  $("ride-recenter").hidden = on;
}

/** The in-ride map: dark HUD; it can be dragged to look ahead or back along the route. */
function initRideMap(): Promise<void> {
  rideMapReady ??= createMap($("ride-map"), { center: [77.224, 28.636], zoom: FOLLOW_ZOOM, interactive: true, dark: true, tpp: true }).then((m) => {
    rideRouteLayer = m.layer();
    rideTagLayer = m.layer();
    // drag to look along the route (ahead or back); the camera stops following until "Re-centre"
    m.onUserMove(() => setRideFollow(false));
    rideMap = m;
  });
  return rideMapReady;
}

/** The flood-checked route from the planner, drawn under the rider. */
function drawPlan(): void {
  rideRouteLayer?.clear();
  if (!rideMap || !rideRouteLayer || !plan) return;
  const pts = plan.route.geometry.coordinates;
  rideRouteLayer.line(pts, { color: "#F7F4D5", weight: 11, opacity: 0.95 });
  rideRouteLayer.line(pts, { color: plan.onOriginal ? "#8E3B2F" : "#839958", weight: 7 });
  rideRouteLayer.dot(pts[0], { radius: 8, color: "#F7F4D5", weight: 3, fill: "#839958", tooltip: "Start" });
  rideRouteLayer.dot(pts[pts.length - 1], { radius: 10, color: "#F7F4D5", weight: 3, fill: "#0A3323", tooltip: plan.destinationName });
  for (const h of plan.hotspots) {
    rideRouteLayer.area(h.ring, { color: h.restricts ? "#D3968C" : "#6E7B70", weight: 3, fillOpacity: h.restricts ? 0.5 : 0.1 });
  }
  // before the first fix: the avatar waits (dimmed) at the start of the route, facing along it
  if (!target) target = { lon: pts[0][0], lat: pts[0][1], heading: along(pts, planCum, 1).heading };
  drawTags();
  $("rg-dest").textContent = plan.destinationName;
  const water = plan.hotspots.filter((h) => h.restricts);
  $("ride-water").hidden = !water.length;
  $("ride-water").textContent = water.length
    ? plan.onOriginal
      ? `Your route passes ${water.map((h) => h.name).join(", ")} with reported water. Do not enter water.`
      : `Avoiding ${water.map((h) => h.name).join(", ")}: water reported.`
    : "";
}

/** Next maneuver and remaining distance, from the GPS fix snapped to the route. */
function updateGuide(lon: number, lat: number, accuracyM: number): void {
  if (!plan) {
    $("rg-text").textContent = "No route yet - set your destination in the planner to get directions";
    return;
  }
  const line = plan.route.geometry.coordinates;
  const { travelled, offM } = project(line, planCum, [lon, lat]);
  const left = Math.max(0, (planCum.at(-1) ?? 0) - travelled);
  $("rg-left").textContent = formatDistance(left);
  // never call "off route" on GPS noise alone: allow for the fix's own error
  if (offM > Math.max(OFF_ROUTE_M, accuracyM * 1.5)) {
    $("rg-arrow").textContent = "×";
    $("rg-dist").textContent = formatDistance(offM);
    $("rg-text").textContent = "Off route - head back to the highlighted road";
  } else if (plan.route.steps.length) {
    const { index, distanceToM } = nextStep(plan.route.steps, travelled);
    const step = plan.route.steps[index];
    $("rg-arrow").textContent = arrow(step.type, step.modifier);
    $("rg-dist").textContent = formatDistance(distanceToM);
    $("rg-text").textContent = step.instruction;
    // spoken turn-by-turn: the whole point of pocket mode, useful with the camera too
    if (index !== spokenStep && distanceToM <= 150) {
      spokenStep = index;
      // no distance in the sentence: the exact phrase was prefetched in the natural voice
      voice.say(step.type === "arrive" ? alertText("ARRIVED").spoken : step.instruction);
    }
  }
  // a hotspot with reported water nearby: one spoken warning per ride
  for (const h of plan.hotspots) {
    if (!h.restricts || warnedHotspots.has(h.id)) continue;
    if (haversine([lon, lat], h.centroid) <= WATER_WARN_M) {
      warnedHotspots.add(h.id);
      ride.alerts++;
      sayAlert("HOTSPOT_REPORTED", { name: h.name });
    }
  }
}

/** Fetch the natural-voice audio for everything this ride may say, before it needs saying. */
function prefetchVoice(): void {
  const fixed: AlertKey[] = ["WATER_AHEAD", "WATER_REROUTE", "DEEP_POTHOLE", "ROUTE_UPDATED", "RIDE_CAMERA", "RIDE_POCKET", "ARRIVED"];
  voice.lang = alertText("ARRIVED").voiceLang;
  voice.prefetch([
    ...fixed.map((k) => alertText(k).spoken),
    ...[5, 10, 15, 20, 25, 30, 35, 40].map((m) => alertText("POTHOLE", { m }).spoken),
    ...(plan?.hotspots.filter((h) => h.restricts).map((h) => alertText("HOTSPOT_REPORTED", { name: h.name }).spoken) ?? []),
    ...(plan?.route.steps.map((st) => st.instruction) ?? []),
  ]);
}

function setPlan(next: RidePlan | undefined): void {
  const changed = plan && next && plan.route.id !== next.route.id;
  plan = next;
  planCum = plan ? cumulative(plan.route.geometry.coordinates) : [];
  drawPlan();
  if (running) prefetchVoice(); // never while just planning: it competes with route requests
  if (running && changed) {
    spokenStep = -1;
    voice.say(alertText("ROUTE_UPDATED").spoken);
    showBanner(alertText("ROUTE_UPDATED").text, next!.route.label, true);
  }
}

/**
 * Tags on the ride map: a spiral where water is reported (people) or seen (this
 * camera), a ping over every pothole this phone logged or the legacy pothole map
 * holds. Legacy potholes never affect route decisions.
 */
function drawTags(): void {
  const layer = rideTagLayer;
  if (!layer) return;
  layer.clear();
  for (const h of plan?.hotspots ?? []) {
    if (h.restricts) layer.pin(h.centroid, floodSpiral(`Water reported · ${h.name}`, "reported"));
  }
  for (const w of waterSeen) layer.pin(w.at, floodSpiral(`Possible water · camera · ${new Date(w.seen).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`, "camera"));
  for (const p of potholes) {
    layer.pin(p.at, potholePing(p.depthM ? `Pothole · ~${p.depthM.toFixed(2)} m` : "Pothole", p.severe));
  }
  for (const hz of network.hazards) layer.pin([hz.lon, hz.lat], potholePing("Reported pothole", hz.score >= 0.6));
}

/** A pothole the camera is sure about goes on the map: GPS position + its distance along the heading. */
function mapPothole(track: Track): void {
  if (mappedTracks.has(track.id) || !shown || !estimate || !Number.isFinite(track.distanceM)) return;
  mappedTracks.add(track.id);
  const depth = depthBy.get(track.id);
  potholes = logPothole(potholes, {
    at: ahead([estimate.lon, estimate.lat], shown.heading, track.distanceM),
    depthM: depth?.depthM,
    severe: depth?.severity === "CRITICAL",
    seen: Date.now(),
  });
  drawTags();
}

/** Heading for the follow camera: GPS course while moving, else the route direction, else the compass. */
function headingFor(snappedTravelled: number | undefined): number | undefined {
  if (rider.speedMps > 1.5) return rider.headingDeg;
  if (plan && snappedTravelled !== undefined) return along(plan.route.geometry.coordinates, planCum, snappedTravelled).heading;
  return compass.headingDeg;
}

/**
 * Third-person follow camera. GPS arrives about once a second; easing the drawn
 * position and heading towards the latest fix every frame makes the avatar
 * glide instead of jump, and the tilted map turns so the road ahead is "up".
 */
function follow(now: number): void {
  if (!running) return;
  requestAnimationFrame(follow);
  if (!rideMap || !target || $("screen-ride").classList.contains("pocket")) return;
  const dt = Math.min(0.5, (now - (lastFollowAt || now)) / 1000);
  lastFollowAt = now;
  const k = shown ? 1 - Math.exp(-dt / 0.35) : 1;
  const turn = ((((target.heading - (shown?.heading ?? target.heading)) % 360) + 540) % 360) - 180; // shortest way round
  shown = {
    lon: (shown?.lon ?? target.lon) + (target.lon - (shown?.lon ?? target.lon)) * k,
    lat: (shown?.lat ?? target.lat) + (target.lat - (shown?.lat ?? target.lat)) * k,
    heading: ((((shown?.heading ?? target.heading) + turn * k) % 360) + 360) % 360,
  };
  const at: [number, number] = [shown.lon, shown.lat];
  rideMarker ??= rideMap.marker(at, avatarEl);
  rideMarker.move(at);
  for (const el of avatarEl.querySelectorAll<SVGElement>(".ra-cone, .ra-arrow")) el.style.transform = `rotate(${shown.heading}deg)`; // flat maps; the 3D map turns itself
  if (rideFollow) rideMap.camera(rideMap.tilted ? ahead(at, shown.heading, LOOK_AHEAD_M) : at, shown.heading, FOLLOW_ZOOM);
}

/** Tell the rider why the map is not moving, with the fix, instead of a silent console warning. */
function gpsProblem(err: GeolocationPositionError): void {
  const box = $("gps-status");
  box.hidden = false;
  avatarEl.classList.add("weak");
  if (!isSecureContext) {
    box.textContent = "Location needs a secure link. Open the https:// link (scan the QR code from python run.py).";
  } else if (err.code === err.PERMISSION_DENIED) {
    box.textContent =
      "Location is off or blocked, so the map cannot follow you. iPhone: Settings > Privacy & Security > Location Services: On, " +
      "then Safari Websites: While Using the App. Android: turn Location on and allow it for this browser. Then start the ride again.";
  } else if (err.code === err.POSITION_UNAVAILABLE) {
    box.textContent = "No GPS signal yet. Move to open sky; the map starts following you as soon as a fix arrives.";
  } else {
    box.textContent = "Still waiting for GPS…";
  }
}

// ------------------------------------------------------------------ overlay
/**
 * The video is displayed with `object-fit: contain` (see style.css), so
 * detections in video pixels are scaled down to fit and centred in the pane.
 * Must stay in step with that CSS or the boxes drift off their hazards.
 */
function videoToScreen() {
  const scale = Math.min(overlay.width / video.videoWidth, overlay.height / video.videoHeight);
  return {
    scale,
    dx: (overlay.width - video.videoWidth * scale) / 2,
    dy: (overlay.height - video.videoHeight * scale) / 2,
  };
}

function render(tracks: Track[]): void {
  const dpr = window.devicePixelRatio || 1;
  const targetW = Math.round(overlay.clientWidth * dpr);
  const targetH = Math.round(overlay.clientHeight * dpr);
  if (overlay.width !== targetW || overlay.height !== targetH) {
    overlay.width = targetW;
    overlay.height = targetH;
  }
  paint.clearRect(0, 0, overlay.width, overlay.height);
  if (!video.videoWidth) return;
  const { scale, dx, dy } = videoToScreen();

  // The corridor the alert engine treats as "the rider's path" - built in
  // video pixels first (so it lines up with isInPath's own maths), then mapped
  // through the same scale/offset as the detections, so it always sits inside
  // the visible frame regardless of object-fit or aspect ratio.
  const horizonYVid = engine.cam.horizonFrac * video.videoHeight;
  const bottomHalf = corridorHalfWidth(1) * video.videoWidth;
  const horizonHalf = corridorHalfWidth(0) * video.videoWidth;
  const midX = video.videoWidth / 2;

  const toScreen = (vx: number, vy: number): [number, number] => [vx * scale + dx, vy * scale + dy];
  const [lx1, ly1] = toScreen(midX - horizonHalf, horizonYVid);
  const [lx2, ly2] = toScreen(midX - bottomHalf, video.videoHeight);
  const [rx1, ry1] = toScreen(midX + horizonHalf, horizonYVid);
  const [rx2, ry2] = toScreen(midX + bottomHalf, video.videoHeight);

  paint.strokeStyle = "rgba(53, 208, 165, 0.4)";
  paint.lineWidth = 2 * dpr;
  paint.beginPath();
  paint.moveTo(lx1, ly1);
  paint.lineTo(lx2, ly2);
  paint.moveTo(rx1, ry1);
  paint.lineTo(rx2, ry2);
  paint.stroke();

  for (const track of tracks) {
    const x = track.box.x * scale + dx;
    const y = track.box.y * scale + dy;
    const w = track.box.w * scale;
    const h = track.box.h * scale;
    const hot = track.inPath && track.severity >= engine.cfg.alertSeverity;

    // A glow flattened into an ellipse reads as something lying ON the road,
    // where a plain rectangle reads as a floating label. Purely presentation -
    // the detector outputs boxes, this just draws them like a hazard.
    if (track.inPath) {
      const midX = x + w / 2;
      const midY = y + h / 2;
      const radius = Math.max(w, h) * 0.8;
      const glow = paint.createRadialGradient(midX, midY, 0, midX, midY, radius);
      glow.addColorStop(0, hot ? "rgba(255, 45, 45, 0.85)" : "rgba(255, 176, 32, 0.7)");
      glow.addColorStop(0.45, hot ? "rgba(255, 70, 70, 0.38)" : "rgba(255, 176, 32, 0.26)");
      glow.addColorStop(1, "rgba(255, 90, 40, 0)");
      paint.fillStyle = glow;
      paint.beginPath();
      paint.ellipse(midX, midY, radius, radius * 0.62, 0, 0, Math.PI * 2);
      paint.fill();
    }

    paint.strokeStyle = hot ? "#ff4d4d" : track.inPath ? "#ffb020" : "rgba(232, 238, 244, 0.5)";
    paint.lineWidth = (hot ? 3 : 2) * dpr;
    paint.beginPath();
    paint.roundRect(x, y, w, h, 8 * dpr);
    paint.stroke();

    if (!track.inPath) continue;
    const depth = depthBy.get(track.id);
    drawPing(x + w / 2, y, dpr, hot || depth?.severity === "CRITICAL");
    const distance = Number.isFinite(track.distanceM) ? track.distanceM.toFixed(0) + " m" : "far";
    const label = className(track.cls).replace(/_/g, " ") + " · " + distance + (depth ? ` · ~${depth.depthM.toFixed(2)} m deep est.` : "");
    paint.font = 13 * dpr + "px system-ui, sans-serif";
    const pad = 6 * dpr;
    const textW = paint.measureText(label).width;
    paint.fillStyle = hot ? "#ff4d4d" : "#ffb020";
    paint.fillRect(x, y + h + 4 * dpr, textW + pad * 2, 20 * dpr);
    paint.fillStyle = "#12060a";
    paint.fillText(label, x + pad, y + h + 18 * dpr);
  }
}

/** Camera tag over a pothole: a round ping on a stem, bobbing just above the box (same look as the map). */
function drawPing(cx: number, top: number, dpr: number, severe: boolean): void {
  const bob = Math.sin(performance.now() / 260) * 3 * dpr;
  const r = 11 * dpr;
  const cy = top - 30 * dpr + bob;
  paint.strokeStyle = "rgba(247, 244, 213, 0.9)";
  paint.lineWidth = 2 * dpr;
  paint.beginPath();
  paint.moveTo(cx, top);
  paint.lineTo(cx, cy + r);
  paint.stroke();
  paint.beginPath();
  paint.arc(cx, cy, r, 0, Math.PI * 2);
  paint.fillStyle = severe ? "#8E3B2F" : "#D3968C";
  paint.fill();
  paint.lineWidth = 3 * dpr;
  paint.strokeStyle = "#F7F4D5";
  paint.stroke();
  paint.beginPath();
  paint.arc(cx, cy, r * 0.42, 0, Math.PI * 2);
  paint.fillStyle = "#0A3323";
  paint.fill();
}

/** Camera tag where the water model sees water: a swirling spiral over the water, as on the map. */
function drawWater(box: WaterBox | null): void {
  if (!box || !video.videoWidth) return;
  const dpr = window.devicePixelRatio || 1;
  const { scale, dx, dy } = videoToScreen();
  const x = box.x * video.videoWidth * scale + dx;
  const y = box.y * video.videoHeight * scale + dy;
  const w = box.w * video.videoWidth * scale;
  const h = box.h * video.videoHeight * scale;
  const cx = x + w / 2, cy = y + h / 2;
  const R = Math.max(20 * dpr, Math.min(80 * dpr, Math.min(w, h) / 2));
  const spin = performance.now() / 500;
  paint.save();
  // a light wash over the water area, flattened like the road
  paint.fillStyle = "rgba(16, 86, 102, 0.28)";
  paint.beginPath();
  paint.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
  paint.fill();
  paint.strokeStyle = "#F7F4D5";
  paint.lineWidth = 3 * dpr;
  paint.lineCap = "round";
  paint.beginPath();
  for (let i = 0; i <= 120; i++) {
    const t = (i / 120) * 3 * 2 * Math.PI;
    const r = R * (0.08 + 0.92 * (i / 120));
    const px = cx + r * Math.cos(t + spin), py = cy + r * Math.sin(t + spin) * 0.55; // flattened onto the road
    if (i) paint.lineTo(px, py);
    else paint.moveTo(px, py);
  }
  paint.stroke();
  const label = "water (model)";
  paint.font = 12 * dpr + "px system-ui, sans-serif";
  const tw = paint.measureText(label).width + 12 * dpr;
  paint.fillStyle = "#D3968C";
  paint.fillRect(cx - tw / 2, cy + R * 0.55 + 6 * dpr, tw, 18 * dpr);
  paint.fillStyle = "#0A3323";
  paint.fillText(label, cx - tw / 2 + 6 * dpr, cy + R * 0.55 + 19 * dpr);
  paint.restore();
}

let bannerTimer: ReturnType<typeof setTimeout> | undefined;

function showBanner(title: string, sub: string, severe = false): void {
  $("alert-title").textContent = title;
  $("alert-sub").textContent = sub;
  $("alert-banner").classList.toggle("severe", severe);
  $("alert-banner").classList.remove("hidden");
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => $("alert-banner").classList.add("hidden"), 2600);
}

/** Speak and show one bilingual alert. Urgent ones chime first and cut off older speech. */
function sayAlert(key: AlertKey, vars: Record<string, string | number> = {}, sub = ""): void {
  const a = alertText(key, vars);
  voice.say(a.spoken, true);
  showBanner(a.text, sub, true);
}

/**
 * Depth tiers (potholeDepth.ts): MINOR is logged only, MODERATE gets the usual
 * warning, CRITICAL gets the urgent alert and saves a dashcam clip.
 */
function handleAlert(alert: Alert): void {
  mapPothole(alert.track);
  const depth = depthBy.get(alert.track.id);
  const sub = `${alert.distanceM.toFixed(0)} m` + (depth ? ` · ~${depth.depthM.toFixed(2)} m deep (estimate)` : "");
  if (depth?.severity === "MINOR") return;
  ride.alerts++;
  if (depth?.severity === "CRITICAL") {
    sayAlert("DEEP_POTHOLE", {}, sub);
    flagIncident("deep pothole");
    return;
  }
  voice.announce({ ...alert, spoken: alertText("POTHOLE", { m: Math.max(5, Math.round(alert.distanceM / 5) * 5) }).spoken });
  showBanner(alertText("POTHOLE").text, sub, alert.severity >= 0.6);
}

/** Record at full rate now and keep the clip a few seconds later, so it shows the hazard itself. */
function flagIncident(reason: string): void {
  dashcam.boost();
  const position = rider.position;
  setTimeout(() => {
    if (dashcam.saveIncident(position, reason)) $("hud-buffer").textContent = "saved";
  }, 5000);
}

/** Crop around a pothole box (half a box of road on each side) into a small luminance patch. */
function measureDepth(track: Track): void {
  const { x, y, w, h } = track.box;
  depthCtx.drawImage(video, x - w / 2, y - h / 2, w * 2, h * 2, 0, 0, 48, 48);
  const rgba = depthCtx.getImageData(0, 0, 48, 48).data;
  const lum = new Uint8ClampedArray(48 * 48);
  for (let i = 0; i < lum.length; i++) lum[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  const depth = estimatePotholeDepth(track.box, video.videoWidth, video.videoHeight, engine.cam, { lum, w: 48, h: 48, margin: 0.5 });
  if (depth) depthBy.set(track.id, depth);
}

/** Where the water probably is: ~20 m ahead on the route, from the smoothed GPS position. */
function waterAhead(): { at: [number, number]; from: [number, number] } | undefined {
  if (!estimate || !plan) return undefined;
  const here: [number, number] = [estimate.lon, estimate.lat];
  const line = plan.route.geometry.coordinates;
  return { at: along(line, planCum, project(line, planCum, here).travelled + 20).point, from: here };
}

function reportHazard(alert: Alert): void {
  const position = rider.position;
  if (!settings.upload || !position || alert.track.box.score < REPORT_CONFIDENCE) return;
  queue.add({
    lat: position.coords.latitude,
    lon: position.coords.longitude,
    type: className(alert.track.cls),
    confidence: alert.track.box.score,
    at: Date.now(),
  });
  $("st-queue").textContent = String(queue.pending);
}

// -------------------------------------------------------------------- ride
/**
 * Start a ride on the planner's flood-checked route: camera on top (pothole
 * detection, dashcam), route + turn guidance below from real GPS. Without a
 * camera (denied, or no HTTPS) the ride continues map-only.
 */
async function startRide(): Promise<void> {
  voice.unlock();
  void compass.start();
  setupRide();
  target = shown = undefined;
  // the 3D map renderer only starts in a visible container, so show the ride screen first
  show("ride");
  await initRideMap();
  avatarEl.classList.add("weak");
  $("gps-status").hidden = true;
  setPlan(ridePlan());
  cameraOn = false;
  voice.lang = alertText("RIDE_CAMERA").voiceLang;
  const pocket = rideMode === "pocket";
  $("screen-ride").classList.toggle("pocket", pocket);
  $("pocket-note").hidden = !pocket;
  if (!pocket) try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    cameraOn = true;
  } catch (err) {
    console.warn("[camera]", err);
    stream = undefined;
  }
  $("screen-ride").classList.toggle("no-camera", !cameraOn);
  $("cam-off").hidden = cameraOn || pocket;

  engine.reset();
  network.reset();
  warnedHotspots.clear();
  depthBy.clear();
  mappedTracks.clear();
  spokenStep = -1;
  estimate = undefined;
  if (stream) dashcam.start(video);
  rider.start();
  ride = { startedAt: Date.now(), metres: 0, hazards: 0, alerts: 0, water: [] };
  waterSeen = loadWater(); // drop sightings that have faded since the last ride
  potholes = loadPotholes(); // include any logged since the page opened
  potholes = loadPotholes(); // include any logged since the page opened
  setRideFollow(true);
  waterGate.reset();
  waterBox = null;
  waterAt = 0;
  running = true;
  show("ride");
  requestAnimationFrame(follow);
  if (!("geolocation" in navigator) || !isSecureContext) gpsProblem({ code: 1, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message: "insecure" } as GeolocationPositionError);

  // the map was created while hidden; let it measure its container now
  setTimeout(() => {
    rideMap?.resize();
    drawPlan();
  }, 50);

  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {
    /* not fatal - the rider can keep the screen on manually */
  }

  voice.say(alertText(pocket ? "RIDE_POCKET" : "RIDE_CAMERA").spoken);
  prefetchVoice();
  if (cameraOn) {
    // one model at a time: loading both together stalls phones
    void ensureDetector().then(ensureWaterModel);
    void loop();
  }
}

async function loop(): Promise<void> {
  const seen = new Set<number>();
  while (running) {
    if (video.readyState < 2) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      continue;
    }

    let dets: Detection[] = [];
    if (detectorReady) {
      try {
        dets = await detector.detect(video, video.videoWidth, video.videoHeight, Math.min(engine.cfg.keepScore, engine.cfg.minScore));
      } catch (err) {
        console.error("[detect]", err);
        await new Promise((resolve) => setTimeout(resolve, 300));
        continue;
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, 120)); // the water model keeps running while this one loads
    }

    // water segmentation, about once a second: water on the road ahead
    let waterAlert = false;
    if (waterModel.ready && performance.now() - waterAt >= WATER_EVERY_MS) {
      waterAt = performance.now();
      try {
        const water = await waterModel.analyse(video, engine.cam.horizonFrac);
        waterBox = water.fraction >= waterGate.cfg.minFraction ? water.box : null;
        $("hud-water").textContent = `water ${(water.fraction * 100).toFixed(0)}%`;
        waterAlert = waterGate.update(water.fraction, waterAt);
      } catch (err) {
        console.error("[water]", err);
      }
    }
    if (waterAlert) {
      ride.alerts++;
      const spot = waterAhead();
      const at = spot?.at ?? (shown ? ([shown.lon, shown.lat] as [number, number]) : undefined);
      ride.water.push({ time: Date.now(), at });
      if (at) waterSeen = logWater(waterSeen, { at, seen: Date.now() });
      drawTags();
      sayAlert(spot ? "WATER_REROUTE" : "WATER_AHEAD", {}, "Experimental camera cue - do not ride into water");
      flagIncident("possible water");
      if (spot) avoidWater(spot.at, spot.from); // personal reroute; the server decides the route
    }

    const now = performance.now();
    fps = lastFrameAt ? 0.8 * fps + 0.2 * (1000 / (now - lastFrameAt)) : 0;
    lastFrameAt = now;

    for (const alert of engine.update(dets, video.videoWidth, video.videoHeight, rider.speedMps, now)) {
      handleAlert(alert);
      reportHazard(alert);
    }

    const tracks = engine.active;
    frameNo++;
    for (const track of tracks) {
      if (!seen.has(track.id)) {
        seen.add(track.id);
        ride.hazards++;
      }
      // depth matters only for what is in the lane; every 5th frame is plenty
      if (track.inPath && (frameNo % 5 === 0 || !depthBy.has(track.id))) measureDepth(track);
    }
    render(tracks);
    drawWater(waterBox);

    $("hud-fps").textContent = fps.toFixed(0);
    $("hud-speed").textContent = (rider.speedMps * 3.6).toFixed(0);
    $("hud-hazards").textContent = String(ride.hazards);
    $("hud-buffer").textContent = `${dashcam.bufferedSeconds.toFixed(0)}s · ${dashcam.fps} fps`;

    // yield to the compositor so the camera preview stays smooth
    await new Promise(requestAnimationFrame);
  }
}

async function endRide(): Promise<void> {
  running = false;
  cameraOn = false;
  dashcam.stop();
  rider.stop();
  compass.stop();
  stream?.getTracks().forEach((track) => track.stop());
  stream = undefined;
  video.srcObject = null;
  try {
    await wakeLock?.release();
  } catch {
    /* already released */
  }
  wakeLock = undefined;

  const minutes = (Date.now() - ride.startedAt) / 60000;
  $("sum-duration").textContent = minutes.toFixed(0) + " min";
  $("sum-distance").textContent = (ride.metres / 1000).toFixed(2) + " km";
  $("sum-hazards").textContent = String(ride.hazards);
  $("sum-alerts").textContent = String(ride.alerts);
  $("sum-water").textContent = String(ride.water.length);
  $("sum-water-ask").hidden = ride.water.length === 0;
  renderClips();
  show("summary");

  await queue.flush();
  $("st-queue").textContent = String(queue.pending);
}

function renderClips(): void {
  const list = $("clip-list");
  list.innerHTML = "";
  if (!dashcam.clips.length) {
    const empty = document.createElement("p");
    empty.className = "fineprint";
    empty.textContent = "No incidents saved this ride.";
    list.append(empty);
    return;
  }
  for (const clip of dashcam.clips) {
    const url = URL.createObjectURL(clip.blob);
    const card = document.createElement("div");
    card.className = "clip";

    const player = document.createElement("video");
    player.src = url;
    player.controls = true;
    player.playsInline = true;

    const meta = document.createElement("div");
    meta.className = "fineprint";
    meta.textContent =
      new Date(clip.at).toLocaleString() + " · " + clip.reason + " · last " + clip.seconds + "s" +
      (clip.lat !== undefined ? " · " + clip.lat.toFixed(5) + ", " + clip.lon!.toFixed(5) : "");

    const link = document.createElement("a");
    link.href = url;
    link.download = "margsetu-clip-" + clip.id + (clip.blob.type.includes("mp4") ? ".mp4" : ".webm");
    link.textContent = "Download clip";

    card.append(player, meta, link);
    list.append(card);
  }
}

// ------------------------------------------------------------- ride setup
let rideSetup = false;

/** GPS wiring for the ride. Runs once; the planner never needs a permission. */
function setupRide(): void {
  if (rideSetup) return;
  rideSetup = true;

  let lastFix: GeolocationPosition | undefined;
  // where the legacy pothole layer was last downloaded
  let refreshedAt: { lat: number; lon: number } | undefined;

  async function refreshNetworkAround(lat: number, lon: number): Promise<void> {
    refreshedAt = { lat, lon };
    await network.refresh(lat, lon);
    drawTags();
    await queue.flush();
    $("st-queue").textContent = String(queue.pending);
  }

  rider.onError = gpsProblem;
  rider.onUpdate = (position) => {
    const raw = position.coords;
    $("gps-status").hidden = true;
    $("hud-gps").textContent = `GPS ±${Math.round(raw.accuracy)} m`;
    $("hud-gps").parentElement!.classList.toggle("hud-weak", raw.accuracy > MAX_USABLE_ACCURACY_M);
    // a cell-tower / Wi-Fi fix hundreds of metres off must not drive the guidance;
    // the avatar still shows roughly where you are, dimmed, so the map is never frozen
    avatarEl.classList.toggle("weak", raw.accuracy > MAX_USABLE_ACCURACY_M);
    if (raw.accuracy > MAX_GUIDANCE_ACCURACY_M) {
      target = { lon: raw.longitude, lat: raw.latitude, heading: target?.heading ?? compass.headingDeg ?? 0 };
      if (running) $("rg-text").textContent = `Weak GPS (±${Math.round(raw.accuracy)} m) - waiting for a better fix`;
      return;
    }
    estimate = smoothFix(estimate, { lon: raw.longitude, lat: raw.latitude, accuracyM: raw.accuracy, t: position.timestamp });
    let { lon, lat } = estimate;
    let snappedTravelled: number | undefined;
    // on the route: show the rider on the road, not in the building next to it
    if (plan) {
      const snap = project(plan.route.geometry.coordinates, planCum, [lon, lat]);
      if (snap.offM <= Math.max(25, estimate.accuracyM)) {
        snappedTravelled = snap.travelled;
        [lon, lat] = along(plan.route.geometry.coordinates, planCum, snap.travelled).point;
      }
    }
    const latitude = lat;
    const longitude = lon;
    target = { lon, lat, heading: headingFor(snappedTravelled) ?? target?.heading ?? 0 };
    if (rideMap) {
      accuracyCircle ??= rideMap.circle("#839958");
      accuracyCircle.set([estimate.lon, estimate.lat], estimate.accuracyM);
    }

    dashcam.update(rider.speedMps * 3.6, latitude, longitude);
    if (running) {
      if (lastFix) {
        const step = distanceM(lastFix.coords.latitude, lastFix.coords.longitude, raw.latitude, raw.longitude);
        if (step < 200) ride.metres += step; // ignore GPS jumps
      }
      updateGuide(longitude, latitude, estimate.accuracyM);
      // a mapped pothole round the corner, warned about before the camera can see it
      const upcoming = network.upcoming(latitude, longitude, rider.headingDeg);
      if (upcoming) {
        ride.alerts++;
        const label = "Reported " + upcoming.type.replace(/_/g, " ");
        voice.say(label + " ahead");
        showBanner(
          label + " ahead",
          "DISTANCE: " + distanceM(latitude, longitude, upcoming.lat, upcoming.lon).toFixed(0) + " m",
        );
      }
    }
    lastFix = position;

    if (!refreshedAt || distanceM(refreshedAt.lat, refreshedAt.lon, latitude, longitude) > 1500) {
      void refreshNetworkAround(latitude, longitude);
    }
  };
}

/** Load the water model once, in the background. */
function ensureWaterModel(): Promise<void> {
  waterLoading ??= waterModel.load(WATER_MODEL_URL).catch((err) => {
    console.error(err);
    $("hud-water").textContent = "water model failed";
  });
  return waterLoading;
}

/** Settings: run both models on a photo the user picks, to see what the camera would see. */
async function testPhoto(file: File): Promise<void> {
  const out = $("photo-result");
  out.textContent = "Loading models…";
  const img = new Image();
  img.src = URL.createObjectURL(file);
  await img.decode();
  await Promise.all([ensureDetector(), ensureWaterModel()]);
  const water = await waterModel.analyse(img, 0.3);
  const dets = detectorReady ? await detector.detect(img, img.naturalWidth, img.naturalHeight, engine.cfg.minScore) : [];
  const verdict = water.fraction >= waterGate.cfg.minFraction ? "WATER ON THE ROAD" : "no water on the road";
  out.textContent = `${verdict} · water ${(water.fraction * 100).toFixed(0)}% of the road area · potholes found: ${dets.length}`;
  URL.revokeObjectURL(img.src);
}

/** Load the pothole model once, in the background; the ride works before it is ready. */
function ensureDetector(): Promise<void> {
  detectorLoading ??= detector
    .load(MODEL_URL)
    .then(() => {
      detectorReady = true;
      const label = "potholes only · " + detector.backend + " · " + detector.size + "px";
      $("hud-model").textContent = label;
      $("st-model").textContent = label;
    })
    .catch((err) => {
      console.error(err);
      const msg = "detector failed: " + (err instanceof Error ? err.message : String(err));
      $("hud-model").textContent = msg;
      $("st-model").textContent = msg;
    });
  return detectorLoading;
}

// -------------------------------------------------------------------- boot
async function boot(): Promise<void> {
  applySettings();
  bindSettings();

  $("btn-end").addEventListener("click", endRide);
  $("ride-recenter").addEventListener("click", () => setRideFollow(true));
  $("btn-home").addEventListener("click", () => show("planner"));
  $("btn-sum-report").addEventListener("click", () => {
    show("planner");
    $("btn-report").click();
    const radio = document.querySelector<HTMLInputElement>('input[name="rep-kind"][value="WATER_OBSERVED"]');
    if (radio) radio.checked = true;
  });
  $("btn-planner-camera").addEventListener("click", () => void startRide());
  $<HTMLInputElement>("photo-test").addEventListener("change", (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) void testPhoto(file).catch((err) => ($("photo-result").textContent = String(err)));
  });
  const setMode = (mode: RideMode) => {
    rideMode = mode;
    try {
      localStorage.setItem(RIDE_MODE_KEY, mode);
    } catch {
      /* this session only */
    }
    $("mode-camera").setAttribute("aria-pressed", String(mode === "camera"));
    $("mode-pocket").setAttribute("aria-pressed", String(mode === "pocket"));
    $("btn-planner-camera").textContent = mode === "pocket" ? "Pocket ride" : "Camera ride";
  };
  $("mode-camera").addEventListener("click", () => setMode("camera"));
  $("mode-pocket").addEventListener("click", () => setMode("pocket"));
  setMode(rideMode);
  $("btn-camera").addEventListener("click", () => {
    void ensureDetector();
    show("settings");
  });
  $("btn-ride-settings").addEventListener("click", () => show("settings"));
  $("btn-settings-back").addEventListener("click", () => show(running ? "ride" : "planner"));
  $("btn-incident").addEventListener("click", () => {
    const clip = dashcam.saveIncident(rider.position, "saved by rider");
    showBanner(clip ? "Incident saved" : "Nothing buffered yet", clip ? clip.seconds + "s of footage" : "");
    voice.say(clip ? "Footage saved" : "Nothing recorded yet");
  });
  $("btn-mute").addEventListener("click", () => {
    voice.enabled = !voice.enabled;
    $("btn-mute").textContent = voice.enabled ? "Mute" : "Unmute";
  });
  // a double tap anywhere on the camera view also flags an incident, for gloved hands
  overlay.addEventListener("dblclick", () => $("btn-incident").click());

  addEventListener("online", async () => {
    await queue.flush();
    $("st-queue").textContent = String(queue.pending);
  });

  if ("serviceWorker" in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  onPlanChange(setPlan);
  await initPlanner({ show: (name) => show(name as ScreenName), startRide: () => void startRide() });
}

void boot();

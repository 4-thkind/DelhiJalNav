/**
 * Map-first route planner (MAP_UI_SPECIFICATION.md): full-screen map, navigation
 * puck, guidance banner + cue sheet, reroute notice, vehicle selector, report
 * sheet with voice + auto-fill, evidence drawer, share and SOS.
 *
 * The UI never decides whether a route is admissible - it renders the server's
 * RouteDecision. Demo, saved, offline and simulated states are always labelled.
 */
import { api, ApiFailure } from "./api.ts";
import type {
  CompareRequest,
  DepthLevel,
  EvidenceView,
  HazardItem,
  HazardStateName,
  HazardsSnapshot,
  HotspotsView,
  ObservationKind,
  ObservationRequest,
  RouteDecision,
  RouteOption,
  Status,
  Vehicle,
  Weather,
} from "./contracts.ts";
import {
  age,
  alertText,
  DEPTH_LABEL,
  getLang,
  KIND_LABEL,
  pick,
  REASON_LABEL,
  setLang,
  STATE_EXPLAIN,
  STATE_LABEL,
  t,
  VEHICLE_BADGE,
  VEHICLE_LABEL,
  type Lang,
} from "./i18n.ts";
import { along, arrow, cumulative, formatDistance, haversine, nextStep, segmentInside } from "./navcore.ts";
import { locateBest } from "./locate.ts";
import { voice } from "../alerts.ts";
import { floodSpiral, potholePing } from "../map/markers.ts";
import { loadPotholes } from "../potholeLog.ts";
import { createMap, type HtmlMarker, type Layer, type MapView } from "../map/mapview.ts";
import { openStorage, Outbox, type Outcome } from "./queue.ts";

const CACHE_KEY = "dillijalnav.snapshot.v2";
const PREFS_KEY = "dillijalnav.prefs";
const CONTRIBUTOR_KEY = "dillijalnav.demoContributor";
const MAX_BACKOFF_MS = 60_000;
/** Simulated drive runs this many times faster than the OSRM estimate. Labelled in the UI. */
const SIM_SPEEDUP = 6;
const RECENTER_SECONDS = 7;
/** A camera water flag steers this rider's routes for this long. */
const AVOID_MS = 20 * 60_000;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Build DOM without innerHTML, so server and user text is always text. */
function h(tag: string, props: Record<string, string> = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

function button(label: string, cls: string, onClick: () => void, attrs: Record<string, string> = {}): HTMLButtonElement {
  const b = h("button", { class: cls, type: "button", ...attrs }, label) as HTMLButtonElement;
  b.addEventListener("click", onClick);
  return b;
}

/** Palette: dark green #0A3323, moss #839958, beige #F7F4D5, rosy brown #D3968C, midnight green #105666. */
const STATE_COLOR: Record<HazardStateName, string> = {
  UNKNOWN: "#6E7B70",
  REPORTED: "#B8735F",
  CORROBORATED: "#8E3B2F",
  CONFLICTED: "#8E3B2F",
  STALE: "#8A6A3A",
  RECENTLY_CLEAR_REPORTED: "#105666",
};
const ROUTE_ACTIVE = "#105666";
const ROUTE_CASING = "#F7F4D5";
const ROUTE_OTHER = "#839958";
const WATER_A = "#8E3B2F";
const WATER_B = "#D3968C";

export type Role = "rider" | "driver" | "auto" | "commuter" | "reporter";
const ROLE_VEHICLE: Record<Role, Vehicle> = {
  rider: "two_wheeler",
  driver: "car",
  auto: "auto",
  commuter: "car",
  reporter: "two_wheeler",
};
const ROLE_LABEL: Record<Role, string> = {
  rider: "Two-wheeler rider",
  driver: "Car or cab driver",
  auto: "Auto-rickshaw driver",
  commuter: "Commuter planning a trip",
  reporter: "Community reporter",
};

/** What the camera ride needs from the planner: the route to follow and the hotspots to watch. */
export interface RidePlan {
  route: RouteOption;
  onOriginal: boolean;
  hotspots: { id: string; name: string; ring: [number, number][]; centroid: [number, number]; state: HazardStateName; restricts: boolean }[];
  destinationName: string;
}
let planListener: ((plan: RidePlan | undefined) => void) | undefined;
export function onPlanChange(cb: (plan: RidePlan | undefined) => void): void {
  planListener = cb;
}

interface Cached {
  schema: 2;
  status: Status;
  view: HotspotsView;
  snapshot: HazardsSnapshot;
  decision: RouteDecision | null;
  fetchedAt: number;
}

interface Prefs {
  vehicle: Vehicle;
  voice: boolean;
  role?: Role;
}

const s = {
  status: undefined as Status | undefined,
  view: undefined as HotspotsView | undefined,
  snapshot: undefined as HazardsSnapshot | undefined,
  decision: undefined as RouteDecision | undefined,
  weather: undefined as Weather | undefined,
  decisionNote: "",
  decisionStale: false,
  offline: false,
  lastSync: undefined as number | undefined,
  skewMs: 0,
  fingerprint: "",
  compareSeq: 0,
  pollDelay: 15_000,
  pairId: "",
  origin: undefined as [number, number] | undefined,
  destination: undefined as [number, number] | undefined,
  originName: "",
  destName: "",
  /** Which end the next map tap sets, or null when the map is just a map. */
  pickMode: null as "from" | "to" | null,
  editing: "to" as "from" | "to",
  keepOriginal: false,
  noticeDismissedFor: "",
  announcedFor: "",
  pendingDraft: undefined as ObservationRequest | undefined,
  /** Water this rider's camera flagged: personal reroute input, never a report. */
  avoid: [] as { at: [number, number]; until: number }[],
  outcomes: [] as Outcome[],
  prefs: { vehicle: "two_wheeler", voice: true } as Prefs,
  nav: {
    active: false,
    routeId: "",
    travelled: 0,
    follow: true,
    lastFrame: 0,
    recenterAt: 0,
    line: [] as [number, number][],
    cum: [] as number[],
  },
};

let outbox: Outbox;
let durableQueue = true;
let map: MapView | undefined;
let routeLayer: Layer;
let hotspotLayer: Layer;
let markerLayer: Layer;
let tagLayer: Layer;
let puck: HtmlMarker | undefined;
let puckEl: HTMLElement | undefined;
let fittedFor = "";

const serverNow = () => Date.now() + s.skewMs;

// ------------------------------------------------------------------ prefs + cache
function loadPrefs(): void {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
    if (raw.vehicle && raw.vehicle in VEHICLE_LABEL) s.prefs.vehicle = raw.vehicle;
    if (raw.role && raw.role in ROLE_VEHICLE) s.prefs.role = raw.role;
    if (typeof raw.voice === "boolean") s.prefs.voice = raw.voice;
  } catch {
    /* defaults */
  }
}

function savePrefs(): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(s.prefs));
  } catch {
    /* not fatal */
  }
}

function readCache(): Cached | undefined {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as Cached | null;
    if (raw && raw.schema === 2 && raw.status?.clientMode && raw.view?.pairs && raw.snapshot?.hazards) return raw;
  } catch {
    /* corrupt cache: rebuild */
  }
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
  return undefined;
}

function writeCache(): void {
  if (!s.status || !s.view || !s.snapshot) return;
  const cached: Cached = {
    schema: 2,
    status: s.status,
    view: s.view,
    snapshot: s.snapshot,
    decision: s.decision ?? null,
    fetchedAt: s.lastSync ?? Date.now(),
  };
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cached));
  } catch {
    /* quota */
  }
}

// --------------------------------------------------------------------- helpers
function fmtDuration(sec: number): string {
  return `${Math.max(1, Math.round(sec / 60))} min`;
}

function fmtDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

function selectedRoute(): RouteOption | undefined {
  const d = s.decision;
  if (!d) return undefined;
  return d.routes.find((r) => r.id === d.selectedRouteId);
}

function baselineRoute(): RouteOption | undefined {
  const d = s.decision;
  return d?.routes.find((r) => r.id === d.baselineRouteId);
}

/** The route the user is actually following: the server's pick, unless they explicitly kept the original. */
function activeRoute(): RouteOption | undefined {
  if (s.keepOriginal) return baselineRoute() ?? selectedRoute();
  return selectedRoute();
}

function rerouted(): boolean {
  const d = s.decision;
  return !!d && !!d.selectedRouteId && d.selectedRouteId !== d.baselineRouteId;
}

function hazard(): HazardItem | undefined {
  return s.snapshot?.hazards[0];
}

function speak(text: string): void {
  if (!s.prefs.voice) return;
  voice.lang = getLang() === "hi" ? "hi-IN" : "en-IN";
  voice.say(text, true, false); // never queue overlapping announcements
}

// --------------------------------------------------------------------- the puck
function puckElement(): HTMLElement {
  const el = h("div", { class: "puck" });
  el.innerHTML = // static markup only; the street name is set as text below
    '<div class="puck-rot"><div class="puck-beam"></div></div>' +
    '<div class="puck-base"><div class="puck-rot"><svg class="puck-arrow" viewBox="0 0 24 24" aria-hidden="true">' +
    '<defs><linearGradient id="pg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#105666"/><stop offset="1" stop-color="#0A3323"/></linearGradient></defs>' +
    '<path d="M12 2 L20 21 L12 16.5 L4 21 Z" fill="url(#pg)"/></svg></div></div><div class="street-tag"></div>';
  return el;
}

function placePuck(point: [number, number], heading: number, street: string): void {
  if (!map) return;
  if (!puck) {
    puckEl = puckElement();
    puck = map.marker(point, puckEl);
  } else {
    puck.move(point);
  }
  const tag = puckEl!.querySelector(".street-tag")!;
  if (tag.textContent !== street) tag.textContent = street;
  puckEl!.querySelectorAll<HTMLElement>(".puck-rot").forEach((el) => (el.style.transform = `rotate(${heading}deg)`));
}

// ---------------------------------------------------------------------- rendering
function renderTop(): void {
  const badge = $("mode-badge");
  if (s.offline) {
    const when = s.lastSync ? new Date(s.lastSync).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : t("neverSynced");
    badge.textContent = `${t("offline")} ${when}`;
    badge.className = "chip chip-offline";
  } else {
    badge.textContent = s.status?.modeLabel ?? "…";
    badge.className = "chip " + (s.status?.clientMode === "LIVE_PILOT" ? "chip-live" : "chip-demo");
  }
  const demo = s.status?.demo;
  $("demo-clock").textContent = demo && demo.clockOffsetMinutes ? `Demo clock +${demo.clockOffsetMinutes} min` : "";
  const w = s.weather;
  const wx = $("weather-chip");
  if (w?.available) {
    wx.textContent = `${t("rainContext")} ${w.currentPrecipitationMm ?? 0} mm${w.provider?.startsWith("SIMULATED") ? " · simulated" : ""}`;
    wx.className = "chip" + (w.advisory ? " chip-amber" : "");
  } else {
    wx.textContent = "";
    wx.className = "chip";
  }
  $("btn-voice-toggle").textContent = s.prefs.voice ? "Sound on" : "Sound off";
  $("btn-voice-toggle").setAttribute("aria-pressed", String(s.prefs.voice));
  $("role-label").textContent = s.prefs.role ? ROLE_LABEL[s.prefs.role] : "";
}

function renderMap(): void {
  if (!map || !s.view) return;
  hotspotLayer.clear();
  routeLayer.clear();
  markerLayer.clear();
  tagLayer.clear();

  const states = new Map(s.snapshot?.hazards.map((x) => [x.hotspotId, x]) ?? []);
  for (const f of s.view.hotspots.features) {
    const st = states.get(f.id)?.state ?? "UNKNOWN";
    hotspotLayer.area(f.geometry.coordinates[0], {
      color: STATE_COLOR[st],
      weight: 3,
      fillOpacity: st === "UNKNOWN" ? 0.12 : 0.5,
      pulse: st !== "UNKNOWN",
      tooltip: `${getLang() === "hi" ? f.properties.displayNameHi : f.properties.displayName}: ${pick(STATE_LABEL, st)}`,
    });
    // water reported (or not yet cleared): the flood spiral stands on the hotspot
    if (st !== "UNKNOWN" && st !== "RECENTLY_CLEAR_REPORTED") {
      tagLayer.pin(f.properties.centroid, floodSpiral(`${getLang() === "hi" ? f.properties.displayNameHi : f.properties.displayName} · ${pick(STATE_LABEL, st)}`, "reported"));
    }
  }

  // potholes this phone's camera logged on earlier rides
  for (const p of loadPotholes()) tagLayer.pin(p.at, potholePing(p.depthM ? `Pothole · ~${p.depthM.toFixed(2)} m` : "Pothole", p.severe));

  const d = s.decision;
  if (d) {
    const active = activeRoute();
    const ordered = [...d.routes].sort((a, b) => Number(a.id === active?.id) - Number(b.id === active?.id));
    for (const r of ordered) {
      const pts = r.geometry.coordinates;
      const isActive = r.id === active?.id && !s.decisionStale;
      if (isActive) routeLayer.line(pts, { color: ROUTE_CASING, weight: 11, opacity: 0.95 }); // casing
      routeLayer.line(pts, {
        color: isActive ? (r.admissible ? ROUTE_ACTIVE : WATER_A) : ROUTE_OTHER,
        weight: isActive ? 7 : 5,
        opacity: isActive ? 1 : 0.8,
        dash: !(r.admissible || isActive),
        tooltip: r.label,
      });
      // striped cyan/red where a route runs through a restricted hotspot
      for (const reason of r.rejectionReasons) {
        const f = s.view.hotspots.features.find((x) => x.id === reason.hotspotId);
        if (!f) continue;
        const seg = segmentInside(r.geometry.coordinates, f.geometry.coordinates[0]);
        if (seg.length < 2) continue;
        routeLayer.line(seg, { color: WATER_A, weight: 9 });
        routeLayer.line(seg, { color: WATER_B, weight: 9, dash: true });
      }
    }
    const pair = s.view.pairs.find((p) => p.id === d.pairId);
    const o = s.origin ?? pair?.origin.coordinates ?? d.routes[0]?.geometry.coordinates[0];
    const dest = s.destination ?? pair?.destination.coordinates ?? d.routes[0]?.geometry.coordinates.at(-1);
    if (o) markerLayer.dot(o, { radius: 8, color: "#F7F4D5", weight: 3, fill: "#839958", tooltip: "Start" });
    if (dest) markerLayer.dot(dest, { radius: 9, color: "#F7F4D5", weight: 3, fill: "#0A3323", tooltip: "Destination" });

    if (fittedFor !== d.pairId + (s.origin ?? "") + (s.destination ?? "") && !s.nav.active) {
      map.fit(d.routes.flatMap((r) => r.geometry.coordinates), 40);
      fittedFor = d.pairId + (s.origin ?? "") + (s.destination ?? "");
    }
    if (!s.nav.active && active) {
      const c = active.geometry.coordinates;
      placePuck(c[0], c.length > 1 ? (along(c, cumulative(c), 1).heading) : 0, active.steps[0]?.name || active.roadNames[0] || "");
    }
  }
}

function renderVehicles(): void {
  const row = $("vehicle-row");
  row.replaceChildren();
  for (const v of Object.keys(VEHICLE_LABEL) as Vehicle[]) {
    row.append(button(pick(VEHICLE_LABEL, v), "vchip", () => {
      s.prefs.vehicle = v;
      savePrefs();
      void compare();
    }, { "aria-pressed": String(v === s.prefs.vehicle) }));
  }
}

function hazardSummary(hz: HazardItem): string {
  const parts = [pick(STATE_LABEL, hz.state), `${hz.freshSources.positive} ${t("sources")}`, age(hz.latestObservationAt, serverNow())];
  if (hz.claims?.highestDepthClaim) parts.push(`${pick(DEPTH_LABEL, hz.claims.highestDepthClaim)} (claimed)`);
  if (hz.claims?.stalledVehiclesClaimedMax) parts.push(`${hz.claims.stalledVehiclesClaimedMax} stalled (claimed)`);
  return parts.join(" · ");
}

function renderNotice(): void {
  const box = $("reroute-notice");
  box.replaceChildren();
  const d = s.decision;
  const hz = hazard();
  const show = d && rerouted() && hz && s.noticeDismissedFor !== d.decisionId + s.keepOriginal && !s.decisionStale;
  box.hidden = !show;
  if (!show || !d || !hz) return;
  const extra = d.extraSeconds ? ` (+${fmtDuration(d.extraSeconds)})` : "";
  box.append(
    h("p", { class: "notice-title" }, `${t("rerouteNotice")}: ${hz.displayName} ${t("bypassed")}`),
    h("p", {}, `${pick(STATE_EXPLAIN, hz.state)}`),
    h("p", { class: "muted" }, hazardSummary(hz)),
    s.keepOriginal ? h("p", { class: "danger-text" }, t("keptWarning")) : "",
    h("div", { class: "notice-actions" },
      button(t("keepOriginal"), "secondary", () => {
        s.keepOriginal = true;
        planListener?.(ridePlan());
        renderAll();
      }),
      button(t("acceptBypass") + extra, "primary", () => {
        s.keepOriginal = false;
        s.noticeDismissedFor = d.decisionId + false;
        planListener?.(ridePlan());
        renderAll();
      })),
  );
}

function renderDecision(): void {
  const card = $("decision-card");
  card.replaceChildren();
  const d = s.decision;
  if (!d) {
    card.append(h("p", { class: "muted" }, s.decisionNote || "…"));
    return;
  }
  const active = activeRoute();
  const hz = hazard();
  if (s.decisionStale) card.append(h("p", { class: "banner banner-gray", role: "status" }, s.decisionNote || t("savedRoute")));
  if (!d.selectedRouteId) {
    card.append(h("h2", { class: "headline danger-text" }, t("noAlternative")));
  } else if (active) {
    const eta = new Date(serverNow() + active.durationS * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    $("dock-eta").textContent = `· ${fmtDuration(active.durationS)}${rerouted() && !s.keepOriginal ? " · bypass" : ""}`;
    card.append(
      h("div", { class: "eta-row" },
        h("span", { class: "eta-big" }, fmtDuration(active.durationS)),
        h("span", { class: "eta-sub" }, `${fmtDistance(active.distanceM)} · ETA ${eta}`)),
      h("p", { class: "route-name" }, (s.keepOriginal ? "Original route (not recommended): " : "") + active.label),
    );
    if (rerouted() && d.extraSeconds && !s.keepOriginal) {
      card.append(h("p", { class: "muted" }, `${t("extra")} ${fmtDuration(d.extraSeconds)} · ${fmtDistance(d.extraMetres ?? 0)}`));
    }
  }
  if (hz && hz.restricts) card.append(h("p", { class: "vbadge" }, pick(VEHICLE_BADGE, s.prefs.vehicle)));
  if (liveAvoid().length) {
    card.append(h("p", { class: "banner banner-amber" }, t("cameraAvoid") + " ",
      button(t("clear"), "link", () => {
        s.avoid = [];
        void compare();
      })));
  }
  if (d.explanationCodes.includes("NO_CURRENT_REPORTS_ON_ASSESSED_SEGMENTS")) card.append(h("p", { class: "banner banner-gray" }, t("noReports")));
  if (d.explanationCodes.includes("STALE_EVIDENCE_KEPT_CAUTIOUS")) card.append(h("p", { class: "banner banner-amber" }, t("staleWarning")));
  if (s.weather?.advisory && hz?.state === "UNKNOWN") card.append(h("p", { class: "banner banner-amber" }, t("rainAdvisory")));
  if (hz) {
    card.append(h("p", { class: "hazard-line" },
      h("span", { class: `dot dot-${hz.state.toLowerCase()}`, "aria-hidden": "true" }),
      h("b", {}, hz.displayName + ": "), hazardSummary(hz)));
  }
  card.append(h("p", { class: "fineprint" }, t("notSafetyClaim")));
}

function renderRoutes(): void {
  const list = $("route-cards");
  list.replaceChildren();
  const d = s.decision;
  if (!d) return;
  const active = activeRoute();
  for (const r of [...d.routes].sort((a, b) => a.durationS - b.durationS)) {
    const chosen = r.id === d.selectedRouteId;
    const tag = chosen ? t("take") : r.admissible ? t("available") : t("avoid");
    const reasons = r.rejectionReasons
      .map((x) => `${pick(REASON_LABEL, x.code)}${x.state ? ` (${pick(STATE_LABEL, x.state)})` : ""}`)
      .join("; ");
    list.append(
      h("li", { class: "route-card" + (r.id === active?.id ? " chosen" : "") + (r.admissible ? "" : " rejected") },
        h("div", { class: "route-top" },
          h("b", {}, r.label),
          h("span", { class: "tag" + (chosen ? " tag-blue" : r.admissible ? "" : " tag-red") }, tag)),
        h("span", { class: "muted" }, `${fmtDuration(r.durationS)} · ${fmtDistance(r.distanceM)} · ${r.roadNames.join(" → ")}`),
        reasons ? h("span", { class: "reason" }, reasons) : null),
    );
  }
  const pair = s.view?.pairs[0];
  $("od-from").textContent = s.originName || pair?.origin.name || "…";
  $("od-to").textContent = s.destName || pair?.destination.name || "…";
  $("btn-preset").hidden = !s.origin && !s.destination;
  $("btn-demo-water").hidden = !s.status?.demo;
  const pickBanner = $("pick-banner");
  pickBanner.hidden = !s.pickMode;
  $("pick-text").textContent = s.pickMode === "from" ? t("tapStartHint") : t("tapHint");
  $<HTMLButtonElement>("btn-nav").textContent = s.nav.active ? t("stopNav") : t("startNav");
  $<HTMLButtonElement>("btn-nav").disabled = !active && !s.nav.active;
}

function renderGuidance(): void {
  const banner = $("guidance");
  const r = activeRoute();
  banner.hidden = !s.nav.active || !r;
  $("sim-label").hidden = !s.nav.active;
  if (!s.nav.active || !r) return;
  const steps = r.steps;
  if (!steps.length) {
    $("g-arrow").textContent = "↑";
    $("g-dist").textContent = formatDistance(Math.max(0, r.distanceM - s.nav.travelled));
    $("g-text").textContent = r.label;
    return;
  }
  const { index, distanceToM } = nextStep(steps, s.nav.travelled);
  const step = steps[index];
  $("g-arrow").textContent = arrow(step.type, step.modifier);
  $("g-dist").textContent = formatDistance(distanceToM);
  $("g-text").textContent = step.instruction;
  const then = steps[index + 1];
  $("g-then").textContent = then ? `Then ${arrow(then.type, then.modifier)} ${then.instruction}` : "";
  const lanes = $("lanes");
  lanes.replaceChildren();
  lanes.hidden = !step.lanes?.length;
  for (const lane of step.lanes ?? []) {
    const glyph = lane.indications.includes("left") ? "↰" : lane.indications.includes("right") ? "↱" : "↑";
    lanes.append(h("span", { class: "lane" + (lane.valid ? " lane-on" : "") }, glyph));
  }
  const cue = $("cue-list");
  cue.replaceChildren();
  let acc = 0;
  steps.forEach((st, i) => {
    acc += i > 0 ? steps[i - 1].distanceM : 0;
    const li = h("li", { class: i === index ? "cue-now" : i < index ? "cue-done" : "" },
      h("span", { class: "cue-arrow" }, arrow(st.type, st.modifier)),
      h("span", {}, st.instruction),
      h("span", { class: "muted" }, formatDistance(acc)));
    li.addEventListener("click", () => {
      s.nav.follow = false;
      s.nav.recenterAt = Date.now() + RECENTER_SECONDS * 1000;
      map?.view(st.location, 18);
    });
    cue.append(li);
  });
}

function renderRecenter(): void {
  const pill = $("btn-recenter");
  const waiting = s.nav.active && !s.nav.follow;
  pill.hidden = !waiting;
  if (waiting) {
    const left = Math.max(0, Math.ceil((s.nav.recenterAt - Date.now()) / 1000));
    pill.textContent = `⌖ ${t("recenter")} (${left}s)`;
  }
}

function renderAll(): void {
  renderTop();
  renderMap();
  renderVehicles();
  renderNotice();
  renderDecision();
  renderRoutes();
  renderGuidance();
  void renderQueue();
}

export function ridePlan(): RidePlan | undefined {
  const route = activeRoute();
  if (!route || !s.view) return undefined;
  const states = new Map(s.snapshot?.hazards.map((x) => [x.hotspotId, x]) ?? []);
  const pair = s.view.pairs.find((p) => p.id === s.decision?.pairId);
  return {
    route,
    onOriginal: s.keepOriginal,
    destinationName: s.destName || pair?.destination.name || "Destination",
    hotspots: s.view.hotspots.features.map((f) => ({
      id: f.id,
      name: getLang() === "hi" ? f.properties.displayNameHi : f.properties.displayName,
      ring: f.geometry.coordinates[0],
      centroid: f.properties.centroid,
      state: states.get(f.id)?.state ?? "UNKNOWN",
      restricts: states.get(f.id)?.restricts ?? false,
    })),
  };
}

// ---------------------------------------------------------------------- data flow
function fingerprint(snapshot: HazardsSnapshot): string {
  return snapshot.hazards.map((x) => `${x.hotspotId}:${x.revision}:${x.state}`).join("|");
}

/** Unexpired camera flags inside the pilot area (the server rejects any outside it). */
function liveAvoid(): [number, number][] {
  const centre = s.view?.hotspots.features[0]?.properties.centroid;
  const radius = s.view?.pilotRadiusM ?? 8000;
  s.avoid = s.avoid.filter((a) => a.until > Date.now());
  return centre ? s.avoid.map((a) => a.at).filter((p) => haversine(p, centre) <= radius) : [];
}

function compareRequest(): CompareRequest {
  const vehicle = s.prefs.vehicle;
  const avoid = liveAvoid();
  const extra = { lang: getLang(), ...(avoid.length ? { avoid } : {}) };
  if (s.origin || s.destination) {
    const pair = s.view?.pairs[0];
    return { origin: s.origin ?? pair?.origin.coordinates, destination: s.destination ?? pair?.destination.coordinates, vehicle, ...extra };
  }
  return { routePairId: s.pairId, vehicle, ...extra };
}

/**
 * The rider's camera flagged possible water at `at`. Ask the server for a route
 * around it, from where the rider is now. Only this rider's route changes - the
 * shared hazard map needs a human report (the ride summary asks for one).
 */
export function avoidWater(at: [number, number], from?: [number, number]): void {
  s.avoid = [...s.avoid, { at, until: Date.now() + AVOID_MS }].slice(-3);
  if (from) {
    s.origin = from;
    s.originName = getLang() === "hi" ? "आपकी जगह" : "Your position";
  }
  s.keepOriginal = false;
  void compare(getLang() === "hi" ? "कैमरे ने पानी देखा" : "Camera flagged water");
}

/** Demo only: what a camera sighting inside the first basin on the current route does. */
function demoCameraWater(): void {
  const route = activeRoute() ?? baselineRoute();
  for (const f of s.view?.hotspots.features ?? []) {
    for (const r of [route, baselineRoute()]) {
      const inside = r ? segmentInside(r.geometry.coordinates, f.geometry.coordinates[0]) : [];
      if (inside.length) {
        speak(alertText("WATER_REROUTE").spoken);
        return avoidWater(inside[inside.length >> 1]);
      }
    }
  }
}

async function compare(note?: string): Promise<void> {
  if (!s.pairId && !s.destination && !s.origin) return;
  const seq = ++s.compareSeq;
  $("update-note").textContent = note ?? "";
  try {
    const decision = await api.compare(compareRequest());
    if (seq !== s.compareSeq) return; // a newer comparison is in flight (R10)
    const wasActive = activeRoute()?.id;
    s.decision = decision;
    s.decisionStale = false;
    s.decisionNote = "";
    if (s.keepOriginal && !rerouted()) s.keepOriginal = false;
    if (note) $("update-note").textContent = `${note} · ${t("recalculated")} ${new Date().toLocaleTimeString()}`;
    if (rerouted() && s.announcedFor !== decision.snapshotId) {
      s.announcedFor = decision.snapshotId;
      speak(t("savdhaan"));
    }
    if (s.nav.active && activeRoute()?.id !== wasActive) switchNavRoute();
    planListener?.(ridePlan());
    writeCache();
  } catch (err) {
    if (seq !== s.compareSeq) return;
    const f = err as ApiFailure;
    if (s.decision) {
      s.decisionStale = true; // previous route stays visibly outdated, never current
      s.decisionNote = `${t("outdated")}: ${f.message}${f.requestId ? " · " + f.requestId : ""}`;
    } else {
      s.decisionNote = f.code === "OUTSIDE_PILOT_COVERAGE" ? `${t("outside")} ${f.message}` : `${t("providerDown")} (${f.code})`;
    }
  }
  renderAll();
}

async function refresh(forceCompare = false): Promise<boolean> {
  try {
    const status = await api.status();
    s.status = status;
    s.skewMs = Date.parse(status.serverTime) - Date.now();
    s.view ??= await api.hotspots();
    if (!s.pairId) s.pairId = s.view.pairs[0]?.id ?? "";
    const [snapshot, weather] = await Promise.all([api.hazards(), api.weather().catch(() => ({ available: false }) as Weather)]);
    s.weather = weather;
    const changed = fingerprint(snapshot) !== s.fingerprint;
    const hadSnapshot = !!s.fingerprint;
    s.snapshot = snapshot;
    s.fingerprint = fingerprint(snapshot);
    s.offline = false;
    s.lastSync = Date.now();
    if (changed || forceCompare || s.decisionStale || !s.decision) {
      await compare(changed && hadSnapshot ? t("newReport") : undefined);
    } else {
      renderAll();
      writeCache();
    }
    return true;
  } catch (err) {
    s.offline = (err as ApiFailure).status === 0;
    if (s.decision) {
      s.decisionStale = true;
      s.decisionNote = s.offline ? t("savedRoute") : `${t("outdated")}: ${(err as ApiFailure).message}`;
    } else {
      s.decisionNote = (err as ApiFailure).message;
    }
    renderAll();
    return false;
  }
}

function schedulePoll(): void {
  const base = (s.status?.pollSeconds ?? 15) * 1000;
  setTimeout(async () => {
    if (document.hidden) return schedulePoll();
    const ok = await refresh();
    if (ok) {
      s.pollDelay = base;
      await flushQueue();
    } else {
      s.pollDelay = Math.min(MAX_BACKOFF_MS, Math.max(base, s.pollDelay * 2));
    }
    schedulePoll();
  }, s.pollDelay * (0.8 + 0.4 * Math.random()));
}

// ---------------------------------------------------------------------- navigation
function startNav(): void {
  const r = activeRoute();
  if (!r) return;
  s.nav.active = true;
  s.nav.routeId = r.id;
  s.nav.line = r.geometry.coordinates;
  s.nav.cum = cumulative(s.nav.line);
  s.nav.travelled = 0;
  s.nav.follow = true;
  s.nav.lastFrame = performance.now();
  document.body.classList.add("navigating");
  document.body.classList.remove("dock-is-open");
  if (rerouted() && !s.keepOriginal) speak(t("savdhaan"));
  requestAnimationFrame(tick);
  renderAll();
}

function stopNav(): void {
  s.nav.active = false;
  document.body.classList.remove("navigating");
  document.body.classList.add("dock-is-open");
  fittedFor = "";
  renderAll();
}

/** A reroute arrived mid-drive: continue from the closest point on the new route. */
function switchNavRoute(): void {
  const r = activeRoute();
  if (!r) return stopNav();
  const here = along(s.nav.line, s.nav.cum, s.nav.travelled).point;
  const line = r.geometry.coordinates;
  const cum = cumulative(line);
  let best = 0;
  line.forEach((p, i) => {
    if (haversine(p, here) < haversine(line[best], here)) best = i;
  });
  s.nav.routeId = r.id;
  s.nav.line = line;
  s.nav.cum = cum;
  s.nav.travelled = cum[best];
}

function tick(now: number): void {
  if (!s.nav.active) return;
  const r = activeRoute();
  if (!r) return stopNav();
  const dt = Math.min(0.25, (now - s.nav.lastFrame) / 1000);
  s.nav.lastFrame = now;
  const speed = (r.distanceM / Math.max(1, r.durationS)) * SIM_SPEEDUP;
  s.nav.travelled = Math.min(s.nav.cum.at(-1) ?? 0, s.nav.travelled + speed * dt);
  const { point, heading } = along(s.nav.line, s.nav.cum, s.nav.travelled);
  const step = r.steps.length ? r.steps[Math.max(0, nextStep(r.steps, s.nav.travelled).index - 1)] : undefined;
  placePuck(point, heading, step?.name || r.roadNames[0] || "");
  if (!s.nav.follow && Date.now() >= s.nav.recenterAt) s.nav.follow = true;
  if (s.nav.follow) map?.view(point, Math.max(map.zoom(), 17));
  renderGuidance();
  renderRecenter();
  if (s.nav.travelled >= (s.nav.cum.at(-1) ?? 0) - 0.5) {
    speak(alertText("ARRIVED").spoken);
    stopNav();
    return;
  }
  requestAnimationFrame(tick);
}

function userMovedMap(): void {
  if (!s.nav.active) return;
  s.nav.follow = false;
  s.nav.recenterAt = Date.now() + RECENTER_SECONDS * 1000;
  renderRecenter();
}

// ---------------------------------------------------------------------- report
function contributor(): string {
  return $<HTMLSelectElement>("rep-contributor").value;
}

function draftFromForm(): ObservationRequest | string {
  const kind = document.querySelector<HTMLInputElement>('input[name="rep-kind"]:checked')?.value as ObservationKind | undefined;
  if (!kind) return "Choose what you saw.";
  if (!s.status) return "Not connected yet - the report form needs the server mode once.";
  const text = $<HTMLTextAreaElement>("rep-text").value.trim();
  const level = $<HTMLSelectElement>("rep-depth").value as DepthLevel | "";
  const stalledRaw = $<HTMLInputElement>("rep-stalled").value;
  const stalled = stalledRaw === "" ? null : Math.max(0, Math.min(50, Math.round(Number(stalledRaw))));
  return {
    schemaVersion: "1.0",
    eventId: crypto.randomUUID(),
    hotspotId: $<HTMLSelectElement>("rep-hotspot").value,
    kind,
    observedAt: new Date(serverNow()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    location: { source: "selected_hotspot", accuracyM: null },
    description: text || null,
    depthClaim: level ? { level, sourcePhrase: $("rep-depth").dataset.phrase || DEPTH_LABEL[level].en } : null,
    stalledVehicles: Number.isFinite(stalled) ? stalled : null,
    clientMode: s.status.clientMode,
  };
}

function showReview(draft: ObservationRequest): void {
  const place = s.view?.hotspots.features.find((f) => f.id === draft.hotspotId);
  const box = $("rep-review-body");
  const depth = draft.depthClaim && "level" in draft.depthClaim ? pick(DEPTH_LABEL, draft.depthClaim.level) : null;
  box.replaceChildren(
    h("p", {}, h("b", {}, t("reviewTitle") + ": ")),
    h("ul", {},
      h("li", {}, (getLang() === "hi" ? place?.properties.displayNameHi : place?.properties.displayName) ?? draft.hotspotId),
      h("li", {}, pick(KIND_LABEL, draft.kind)),
      h("li", {}, new Date(draft.observedAt).toLocaleTimeString() + " (" + t("justNow") + ")"),
      depth ? h("li", {}, `${t("depth")}: ${depth}`) : null,
      draft.stalledVehicles ? h("li", {}, `${t("stalled")}: ${draft.stalledVehicles}`) : null,
      draft.description ? h("li", {}, "“" + draft.description + "”") : null,
      h("li", { class: "muted" }, `${s.status?.provenance ?? ""} · ${contributor()}`)),
  );
  $("rep-form").hidden = true;
  $("rep-review").hidden = false;
}

async function autofill(): Promise<void> {
  const text = $<HTMLTextAreaElement>("rep-text").value.trim();
  const info = $("rep-draft-info");
  if (!text) {
    info.textContent = "Type or speak a description first.";
    return;
  }
  info.textContent = "…";
  try {
    const d = await api.draft(text, contributor());
    if (d.inPilot && d.location_matched) $<HTMLSelectElement>("rep-hotspot").value = d.location_matched;
    const radio = document.querySelector<HTMLInputElement>(`input[name="rep-kind"][value="${d.suggestedKind}"]`);
    if (radio) radio.checked = true;
    const depthSel = $<HTMLSelectElement>("rep-depth");
    depthSel.value = d.user_claimed_depth?.level ?? "";
    depthSel.dataset.phrase = d.user_claimed_depth?.phrase ?? "";
    const how = d.method === "bedrock" ? `Amazon Bedrock (${d.modelId})` : `rules${d.fallbackReason ? ` - Bedrock fallback: ${d.fallbackReason}` : ""}`;
    const notes = [
      `Draft by ${how}. Check every field.`,
      d.location_matched && !d.inPilot ? `"${d.location_matched}" is not in this pilot - pick a pilot place.` : "",
      ...d.clarificationReasons,
    ].filter(Boolean);
    info.replaceChildren(...notes.map((n) => h("span", { class: "draft-note" }, n)));
  } catch (err) {
    info.textContent = `Auto-fill unavailable (${(err as ApiFailure).code}). Fill the fields yourself.`;
  }
}

function startVoice(): void {
  const Ctor = (window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec })
    .SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => SpeechRec }).webkitSpeechRecognition;
  const info = $("rep-draft-info");
  if (!Ctor) {
    info.textContent = "Voice input is not supported in this browser. Type instead.";
    return;
  }
  const rec = new Ctor();
  rec.lang = getLang() === "hi" ? "hi-IN" : "en-IN";
  rec.interimResults = false;
  rec.onresult = (e) => {
    const said = e.results[0]?.[0]?.transcript ?? "";
    const box = $<HTMLTextAreaElement>("rep-text");
    box.value = (box.value + " " + said).trim();
    void autofill();
  };
  rec.onerror = (e) => (info.textContent = `Voice error: ${e.error}. Type instead.`);
  info.textContent = "Listening… (speech is processed by your browser's provider)";
  rec.start();
}

interface SpeechRec {
  lang: string;
  interimResults: boolean;
  onresult: (e: { results: { [i: number]: { [j: number]: { transcript: string } } } }) => void;
  onerror: (e: { error: string }) => void;
  start(): void;
}

async function flushQueue(): Promise<void> {
  const outcomes = await outbox.flush();
  if (outcomes.length) {
    s.outcomes = [...outcomes, ...s.outcomes].slice(0, 8);
    await refresh(true);
  }
  await renderQueue();
}

async function renderQueue(): Promise<void> {
  if (!outbox) return;
  const pending = await outbox.pending();
  $("queue-count").textContent = `${t("queued")}: ${pending.length}${durableQueue ? "" : " (memory only)"}`;
  const list = $("rep-results");
  list.replaceChildren();
  for (const p of pending) {
    const del = button("Delete", "secondary small", async () => {
      await outbox.remove(p.eventId);
      await renderQueue();
    });
    const label = p.status === "needs_sign_in" ? "needs sign-in" : p.status === "waiting_retry" ? `retrying (${p.lastError})` : p.status;
    list.append(h("li", { class: "result" }, `${pick(KIND_LABEL, p.body.kind)} · ${label} `, del));
  }
  for (const o of s.outcomes) {
    const text =
      o.kind === "rejected"
        ? `Rejected: ${o.code}`
        : `${o.kind === "duplicate" ? "Already received" : "Accepted"} · ${pick(STATE_LABEL, o.result.state)} · revision ${o.result.revision}`;
    list.append(h("li", { class: "result result-" + o.kind }, text));
  }
}

// ---------------------------------------------------------------------- evidence
async function openEvidence(hotspotId: string): Promise<void> {
  show("evidence");
  const body = $("evidence-body");
  body.replaceChildren(h("p", { class: "muted" }, "…"));
  let ev: EvidenceView | HazardItem | undefined;
  let live = true;
  try {
    ev = await api.evidence(hotspotId);
  } catch {
    live = false;
    ev = s.snapshot?.hazards.find((x) => x.hotspotId === hotspotId);
  }
  if (!ev) {
    body.replaceChildren(h("p", {}, "Evidence unavailable offline."));
    return;
  }
  const now = serverNow();
  const claims = s.snapshot?.hazards.find((x) => x.hotspotId === hotspotId)?.claims;
  const scale = h("div", { class: "depth-scale", role: "img", "aria-label": "Claimed depth scale" },
    ...(["ankle", "knee", "waist", "submerged"] as DepthLevel[]).map((lv) =>
      h("span", { class: `depth-step depth-${lv}` + (claims?.highestDepthClaim === lv ? " depth-on" : "") }, pick(DEPTH_LABEL, lv))));
  body.replaceChildren(
    h("p", {}, h("span", { class: `tag tag-state-${ev.state.toLowerCase()}` }, pick(STATE_LABEL, ev.state))),
    h("p", {}, pick(STATE_EXPLAIN, ev.state)),
    h("dl", { class: "facts" },
      h("dt", {}, "Fresh reports (distinct sources)"), h("dd", {}, `${ev.freshSources.positive} water/blocked · ${ev.freshSources.negative} no-water`),
      h("dt", {}, "Latest report"), h("dd", {}, age(ev.latestObservationAt, now)),
      h("dt", {}, "Last water report"), h("dd", {}, age(ev.lastKnownPositiveAt, now)),
      h("dt", {}, "Stalled vehicles (claimed)"), h("dd", {}, claims?.stalledVehiclesClaimedMax != null ? String(claims.stalledVehiclesClaimedMax) : "—"),
      h("dt", {}, "Policy"), h("dd", {}, `${ev.policyVersion} · ${ev.reasonCode} · freshness ${s.status?.freshnessMinutes ?? 30} min`),
      h("dt", {}, "Evaluated"), h("dd", {}, new Date(ev.evaluatedAt).toLocaleTimeString() + (live ? "" : " (saved copy)"))),
    h("h3", {}, "Depth claimed by contributors"),
    scale,
    h("p", { class: "fineprint" }, "Depth is what people reported, not a measurement. No vehicle is cleared through reported water."),
  );
  if (s.weather?.available) {
    body.append(h("p", { class: "fineprint" },
      `Rain context (${s.weather.provider}): ${s.weather.currentPrecipitationMm} mm in the last ${Math.round((s.weather.currentIntervalS ?? 900) / 60)} min; next 3 h ${s.weather.next3hPrecipitationMm?.join(" / ")} mm. ${s.weather.note}`));
  }
  if ("observations" in ev) {
    if (ev.clearReview) body.append(h("p", { class: "banner banner-blue" }, `Community review (${ev.clearReview.reviewer}): ${ev.clearReview.reason}`));
    const rows = ev.observations.map((o) =>
      h("li", { class: o.effective ? "obs effective" : "obs" },
        h("b", {}, `${o.source} · ${pick(KIND_LABEL, o.kind)}`),
        h("span", { class: "muted" }, ` · observed ${age(o.observedAt, now)} · ${o.fresh ? "fresh" : "aged out"} · ${o.provenance}`),
        o.description ? h("q", {}, o.description) : null),
    );
    body.append(h("h3", {}, "Reports (newest first)"), rows.length ? h("ul", { class: "obs-list" }, ...rows) : h("p", { class: "muted" }, "No reports in the last 6 hours."));
  }
  const f = s.view?.hotspots.features.find((x) => x.id === hotspotId);
  if (f) {
    body.append(
      h("h3", {}, "Limits"),
      h("p", { class: "fineprint" }, `Geometry: ${f.properties.verification}. ${f.properties.reviewNotes} ${f.properties.geometrySource}`),
      h("p", { class: "fineprint" }, "Reports are claims, counted once per source. Map data © OpenStreetMap contributors."),
    );
  }
}

// ---------------------------------------------------------------------- share / SOS
async function shareTrip(): Promise<void> {
  const r = activeRoute();
  const hz = hazard();
  const eta = r ? new Date(serverNow() + r.durationS * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
  const text = `DilliJalNav Edge: I'm taking "${r?.label ?? "my route"}", ETA ${eta}.` +
    (hz?.restricts ? ` ${hz.displayName}: ${pick(STATE_LABEL, hz.state)} - avoiding it.` : "") +
    ` (${s.status?.modeLabel ?? ""})`;
  if (navigator.share) {
    try {
      await navigator.share({ title: "DilliJalNav Edge", text, url: location.origin });
      return;
    } catch {
      /* cancelled: fall through to WhatsApp */
    }
  }
  window.open(`https://wa.me/?text=${encodeURIComponent(text + " " + location.origin)}`, "_blank", "noopener");
}

// ---------------------------------------------------------------------- screens
let showScreen: (name: string) => void = () => {};
function show(name: "planner" | "report" | "evidence" | "sos" | "welcome" | "place"): void {
  showScreen(name);
}

function chooseRole(role: Role): void {
  s.prefs.role = role;
  s.prefs.vehicle = ROLE_VEHICLE[role];
  savePrefs();
  show("planner");
  void compare();
  if (role === "reporter") $("btn-report").click();
}

function applyLanguage(): void {
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n as Parameters<typeof t>[0]);
  });
  document.querySelectorAll<HTMLElement>("[data-kind]").forEach((el) => {
    el.textContent = pick(KIND_LABEL, el.dataset.kind!);
  });
  document.querySelectorAll<HTMLOptionElement>("[data-depth]").forEach((el) => {
    el.textContent = pick(DEPTH_LABEL, el.dataset.depth!);
  });
  $("btn-lang").textContent = getLang() === "hi" ? "EN" : "हिं";
  renderAll();
}

function setEnd(which: "from" | "to", point: [number, number], name: string): void {
  if (which === "from") {
    s.origin = point;
    s.originName = name;
  } else {
    s.destination = point;
    s.destName = name;
  }
  s.pickMode = null;
  s.keepOriginal = false;
  fittedFor = "";
  show("planner");
  void compare();
}

function openPlace(which: "from" | "to"): void {
  s.editing = which;
  $("place-title").textContent = which === "from" ? "Change start" : "Change destination";
  $<HTMLInputElement>("place-q").value = "";
  $("place-status").textContent = "";
  $("place-results").replaceChildren();
  const marks = $("place-landmarks");
  marks.replaceChildren();
  for (const m of s.view?.landmarks ?? []) {
    marks.append(button(getLang() === "hi" ? m.nameHi : m.name, "place-chip", () => setEnd(which, m.coordinates, m.name)));
  }
  show("place");
  setTimeout(() => $<HTMLInputElement>("place-q").focus(), 50);
}

async function searchPlace(): Promise<void> {
  const q = $<HTMLInputElement>("place-q").value.trim();
  const status = $("place-status");
  const list = $("place-results");
  list.replaceChildren();
  if (q.length < 2) {
    status.textContent = "Type at least 2 letters.";
    return;
  }
  status.textContent = "Searching…";
  try {
    const { results } = await api.geocode(q);
    status.textContent = results.length ? "" : `No match within ${((s.view?.pilotRadiusM ?? 8000) / 1000).toFixed(0)} km of the pilot. Try a landmark or pick on the map.`;
    for (const r of results) {
      const li = h("li", {}, h("b", {}, r.name), h("span", { class: "muted" }, r.address));
      li.tabIndex = 0;
      const pickIt = () => setEnd(s.editing, r.coordinates, r.name);
      li.addEventListener("click", pickIt);
      li.addEventListener("keydown", (e) => (e.key === "Enter" ? pickIt() : undefined));
      list.append(li);
    }
  } catch (err) {
    status.textContent = (err as ApiFailure).message;
  }
}

async function useMyLocation(): Promise<void> {
  const which = s.editing;
  const status = $("place-status");
  status.textContent = "Getting an accurate GPS fix…";
  try {
    const fix = await locateBest((acc) => (status.textContent = `Getting an accurate GPS fix… best so far ±${Math.round(acc)} m`));
    if (fix.accuracyM > 150) {
      status.textContent = `GPS is weak (±${Math.round(fix.accuracyM)} m). Go outdoors, or pick the point on the map.`;
      return;
    }
    setEnd(which, [fix.lon, fix.lat], `My location (±${Math.round(fix.accuracyM)} m)`);
  } catch (err) {
    status.textContent = (err as Error).message;
  }
}

export async function initPlanner(screens: { show: (name: string) => void; startRide: () => void }): Promise<void> {
  showScreen = screens.show;
  loadPrefs();
  // the map loads in the background (Google Maps script, or Leaflet straight away); nothing below waits for it
  const mapReady = createMap($("plan-map"), { center: [77.224, 28.636], zoom: 15, interactive: true }).then((m) => {
    hotspotLayer = m.layer();
    routeLayer = m.layer();
    markerLayer = m.layer();
    tagLayer = m.layer();
    m.onUserMove(userMovedMap);
    m.onClick((p) => {
      if (!s.nav.active && s.pickMode) setEnd(s.pickMode, p, "Point on map");
    });
    map = m;
    renderMap();
  });

  const { storage, durable } = await openStorage();
  durableQueue = durable;
  outbox = new Outbox(storage, (record) => api.submit(record.body, record.contributor));

  try {
    const saved = sessionStorage.getItem(CONTRIBUTOR_KEY);
    if (saved) $<HTMLSelectElement>("rep-contributor").value = saved;
  } catch {
    /* ignore */
  }

  const cached = readCache();
  if (cached) {
    s.status = cached.status;
    s.view = cached.view;
    s.snapshot = cached.snapshot;
    s.fingerprint = fingerprint(cached.snapshot);
    s.decision = cached.decision ?? undefined;
    s.lastSync = cached.fetchedAt;
    s.pairId = cached.view.pairs[0]?.id ?? "";
    s.decisionStale = true;
    s.decisionNote = t("savedRoute");
  }
  applyLanguage();

  $("btn-lang").addEventListener("click", () => {
    setLang(getLang() === "hi" ? "en" : ("hi" as Lang));
    applyLanguage();
  });
  $("btn-voice-toggle").addEventListener("click", () => {
    s.prefs.voice = !s.prefs.voice;
    savePrefs();
    if (!s.prefs.voice) speechSynthesis?.cancel();
    renderTop();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-role]").forEach((b) =>
    b.addEventListener("click", () => chooseRole(b.dataset.role as Role)));
  $("btn-role").addEventListener("click", () => show("welcome"));
  $("btn-ride").addEventListener("click", () => screens.startRide());
  const setDock = (open: boolean) => {
    document.body.classList.toggle("dock-is-open", open);
    $("dock-open").setAttribute("aria-expanded", String(open));
    setTimeout(() => map?.resize(), 320);
  };
  $("dock-open").addEventListener("click", () => setDock(true));
  $("dock-hide").addEventListener("click", () => setDock(false));
  setDock(true);
  $("btn-compare").addEventListener("click", () => void refresh(true));
  $("btn-nav").addEventListener("click", () => (s.nav.active ? stopNav() : startNav()));
  $("btn-recenter").addEventListener("click", () => {
    s.nav.follow = true;
    renderRecenter();
  });
  $("guidance").addEventListener("click", () => $("cue-sheet").toggleAttribute("hidden"));
  $("btn-why").addEventListener("click", () => {
    const id = s.view?.hotspots.features[0]?.id;
    if (id) void openEvidence(id);
  });
  $("btn-share").addEventListener("click", () => void shareTrip());
  $("btn-demo-water").addEventListener("click", demoCameraWater);
  $("btn-sos").addEventListener("click", () => show("sos"));
  $("od-from").addEventListener("click", () => openPlace("from"));
  $("od-to").addEventListener("click", () => openPlace("to"));
  $("od-swap").addEventListener("click", () => {
    const pair = s.view?.pairs[0];
    const [o, on] = [s.origin ?? pair?.origin.coordinates, s.originName || pair?.origin.name || ""];
    const [d, dn] = [s.destination ?? pair?.destination.coordinates, s.destName || pair?.destination.name || ""];
    [s.origin, s.originName, s.destination, s.destName] = [d, dn, o, on];
    fittedFor = "";
    void compare();
  });
  $("btn-preset").addEventListener("click", () => {
    s.avoid = [];
    s.origin = s.destination = undefined;
    s.originName = s.destName = "";
    s.pickMode = null;
    fittedFor = "";
    void compare();
  });
  $("place-form").addEventListener("submit", (e) => {
    e.preventDefault();
    void searchPlace();
  });
  $("place-mine").addEventListener("click", () => void useMyLocation());
  $("place-pick").addEventListener("click", () => {
    s.pickMode = s.editing;
    show("planner");
    document.body.classList.remove("dock-is-open");
    renderRoutes();
  });
  $("place-back").addEventListener("click", () => show("planner"));
  $("pick-cancel").addEventListener("click", () => {
    s.pickMode = null;
    renderRoutes();
  });
  for (const id of ["btn-report", "fab-report"]) {
    $(id).addEventListener("click", () => {
      $("rep-form").hidden = false;
      $("rep-review").hidden = true;
      $("rep-error").textContent = "";
      show("report");
    });
  }
  $("rep-contributor").addEventListener("change", () => {
    try {
      sessionStorage.setItem(CONTRIBUTOR_KEY, contributor());
    } catch {
      /* ignore */
    }
  });
  $("btn-autofill").addEventListener("click", () => void autofill());
  $("btn-mic").addEventListener("click", startVoice);
  $("btn-rep-next").addEventListener("click", () => {
    const draft = draftFromForm();
    if (typeof draft === "string") {
      $("rep-error").textContent = draft;
      return;
    }
    $("rep-error").textContent = "";
    s.pendingDraft = draft;
    showReview(draft);
  });
  $("btn-rep-edit").addEventListener("click", () => {
    $("rep-form").hidden = false;
    $("rep-review").hidden = true;
  });
  $("btn-rep-submit").addEventListener("click", async () => {
    if (!s.pendingDraft) return;
    try {
      await outbox.add(s.pendingDraft, contributor());
    } catch (err) {
      $("rep-error").textContent = (err as Error).message === "OUTBOX_FULL" ? "Too many unsent reports. Delete some first." : "Could not queue report.";
      return;
    }
    s.pendingDraft = undefined;
    $<HTMLTextAreaElement>("rep-text").value = "";
    $<HTMLSelectElement>("rep-depth").value = "";
    $<HTMLInputElement>("rep-stalled").value = "";
    $("rep-draft-info").textContent = "";
    $("rep-form").hidden = false;
    $("rep-review").hidden = true;
    await renderQueue();
    await flushQueue();
  });
  for (const id of ["btn-rep-back", "btn-ev-back", "btn-sos-back"]) $(id).addEventListener("click", () => show("planner"));

  addEventListener("online", () => void refresh().then(flushQueue));
  addEventListener("offline", () => {
    s.offline = true;
    renderTop();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refresh();
  });
  setInterval(renderRecenter, 1000);

  const fillHotspots = () => {
    const select = $<HTMLSelectElement>("rep-hotspot");
    if (!s.view || select.options.length) return;
    for (const f of s.view.hotspots.features) select.append(new Option(`${f.properties.displayName} · ${f.properties.displayNameHi}`, f.id));
  };
  fillHotspots();
  if (!s.prefs.role) show("welcome");
  await Promise.all([mapReady, refresh(true)]);
  fillHotspots();
  planListener?.(ridePlan());
  await flushQueue();
  schedulePoll();
}

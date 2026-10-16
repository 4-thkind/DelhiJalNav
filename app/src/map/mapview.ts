/// <reference types="google.maps" />
/**
 * One small map surface for the planner and the ride screen.
 *
 * Google Maps (JS API) when VITE_GOOGLE_MAPS_KEY is set and loads; Leaflet +
 * OpenStreetMap otherwise (no key, offline, script blocked, or the key is
 * rejected). Callers only see LonLat and this interface, so both engines draw
 * the same hotspots, routes and pucks.
 *
 * The ride map can be third-person (`tpp`): a Google vector map tilted 60
 * degrees, turned heading-up and following the rider, with 3D buildings. That
 * needs WebGL; without it (or without Google) the same map stays flat.
 */
import L from "leaflet";
import "leaflet/dist/leaflet.css";

import { untint } from "./tint.ts";

export type LonLat = [number, number];
export interface LineStyle { color: string; weight: number; opacity?: number; dash?: boolean; tooltip?: string }
export interface AreaStyle { color: string; weight: number; fillOpacity: number; tooltip?: string; pulse?: boolean }
export interface DotStyle { radius: number; color: string; weight: number; fill: string; tooltip?: string }

export interface Layer {
  line(pts: LonLat[], s: LineStyle): void;
  area(ring: LonLat[], s: AreaStyle): void;
  dot(p: LonLat, s: DotStyle): void;
  /** HTML tag (markers.ts) standing on the point; removed by clear(). */
  pin(p: LonLat, el: HTMLElement): void;
  clear(): void;
}
export interface HtmlMarker { move(p: LonLat): void }
export interface Circle { set(p: LonLat, radiusM: number): void }

export interface MapView {
  readonly engine: "google" | "osm";
  /** True when the map really is tilted and turns with the heading (Google vector). */
  readonly tilted: boolean;
  layer(): Layer;
  /** `el` is centred on the point. */
  marker(p: LonLat, el: HTMLElement): HtmlMarker;
  circle(color: string): Circle;
  fit(pts: LonLat[], padPx: number): void;
  view(p: LonLat, zoom: number): void;
  /** Follow camera: centre, heading (degrees from north; ignored on flat maps) and zoom. */
  camera(p: LonLat, headingDeg: number, zoom: number): void;
  zoom(): number;
  onClick(cb: (p: LonLat) => void): void;
  onUserMove(cb: () => void): void;
  resize(): void;
}

export interface MapOptions {
  center: LonLat;
  zoom: number;
  /** false = no pan/zoom gestures (the in-ride map). */
  interactive: boolean;
  /** Ride map: always the dark HUD style. */
  dark?: boolean;
  /** Ride map: third-person, tilted and heading-up where the device can draw it. */
  tpp?: boolean;
}

/** Tilt of the third-person ride camera, degrees. */
export const TPP_TILT = 60;

const KEY: string = import.meta.env.VITE_GOOGLE_MAPS_KEY ?? "";
const FAILED_FLAG = "margsetu.googleMapsFailed";
const DARK_QUERY = "(prefers-color-scheme: dark), (min-width: 900px) and (max-height: 640px) and (orientation: landscape)";

let loading: Promise<boolean> | undefined;

/** Load the Maps JS API once. Resolves false (never throws) so the caller can fall back. */
function loadGoogle(): Promise<boolean> {
  loading ??= new Promise<boolean>((resolve) => {
    let failed = false;
    try {
      failed = sessionStorage.getItem(FAILED_FLAG) === "1";
    } catch {
      /* ignore */
    }
    if (!KEY || failed || !navigator.onLine) return resolve(false);
    const w = window as unknown as Record<string, unknown>;
    // a rejected key only shows up after a map is drawn: remember it and reload onto OSM
    w.gm_authFailure = () => {
      try {
        sessionStorage.setItem(FAILED_FLAG, "1");
      } catch {
        /* ignore */
      }
      location.reload();
    };
    const timer = setTimeout(() => resolve(false), 8000);
    w.__margsetuMapsReady = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const script = document.createElement("script");
    script.src =
      "https://maps.googleapis.com/maps/api/js?" +
      new URLSearchParams({ key: KEY, v: "weekly", loading: "async", callback: "__margsetuMapsReady", language: "en", region: "IN" });
    script.async = true;
    script.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
    document.head.append(script);
  });
  return loading;
}

/** Palette-tinted styles: beige land and green water/parks by day, a dark green HUD by night. */
const LIGHT: google.maps.MapTypeStyle[] = [
  { elementType: "geometry", stylers: [{ color: "#F2EFD9" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#3D4A3F" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#F7F4D5" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "poi.park", stylers: [{ visibility: "on" }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#DDE5C8" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#FFFFFF" }] },
  { featureType: "road.arterial", elementType: "geometry", stylers: [{ color: "#FBF9EC" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#E9DFB8" }] },
  { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#D6D0A8" }] },
  { featureType: "transit", stylers: [{ visibility: "simplified" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#B9CFC6" }] },
];
const DARK: google.maps.MapTypeStyle[] = [
  { elementType: "geometry", stylers: [{ color: "#0F2A1F" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#BFC7A8" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#0A3323" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "poi.park", stylers: [{ visibility: "on" }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#163A2A" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#24493A" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#3A5E45" }] },
  { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#0A3323" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0B2E2E" }] },
];

/** Wrapper sized 0x0 at the point; the child is centred on it by CSS (.map-pin > *). */
function pin(el: HTMLElement): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "map-pin";
  wrap.append(el);
  return wrap;
}

function googleView(container: HTMLElement, o: MapOptions, vector: boolean): MapView & { vectorReady: Promise<boolean> } {
  const g = google.maps;
  const dark = o.dark || matchMedia(DARK_QUERY).matches;
  const map = new g.Map(container, {
    center: { lat: o.center[1], lng: o.center[0] },
    zoom: o.zoom,
    disableDefaultUI: true,
    zoomControl: o.interactive,
    zoomControlOptions: { position: g.ControlPosition.RIGHT_TOP },
    gestureHandling: o.interactive ? "greedy" : "none",
    keyboardShortcuts: o.interactive,
    clickableIcons: false,
    backgroundColor: dark ? "#0A3323" : "#F2EFD9",
    ...(vector
      ? {
          // DEMO_MAP_ID: Google's map ID for development; create a project Map ID before production
          mapId: "DEMO_MAP_ID",
          renderingType: g.RenderingType.VECTOR,
          colorScheme: "DARK",
          tilt: TPP_TILT,
          heading: 0,
        }
      : { styles: dark ? DARK : LIGHT }),
  } as google.maps.MapOptions);
  // The vector renderer needs WebGL. Without it the map first reports VECTOR and then
  // quietly falls back to RASTER (no tilt, no heading), so the answer counts only once
  // the first tiles are drawn - and a later fallback still switches the 3D mode off.
  let tilted = false;
  const isVector = () => map.getRenderingType() === g.RenderingType.VECTOR;
  const vectorReady = !vector
    ? Promise.resolve(false)
    : new Promise<boolean>((resolve) => {
        g.event.addListenerOnce(map, "tilesloaded", () => resolve(isVector()));
        setTimeout(() => resolve(false), 8000);
      });
  void vectorReady.then((ok) => {
    tilted = ok && isVector();
    container.classList.toggle("map-tpp", tilted);
    map.addListener("renderingtype_changed", () => {
      tilted = isVector();
      container.classList.toggle("map-tpp", tilted);
    });
  });
  const colour = (hex: string) => (vector ? untint(hex) : hex);
  const ll = ([lon, lat]: LonLat) => ({ lat, lng: lon });
  const info = new g.InfoWindow();
  let clickCb: ((p: LonLat) => void) | undefined;
  // shapes swallow map clicks in Google Maps; forward them so "tap to set a point" works anywhere
  const forward = (shape: google.maps.MVCObject, tooltip?: string) =>
    shape.addListener("click", (e: google.maps.MapMouseEvent) => {
      if (!e.latLng) return;
      clickCb?.([e.latLng.lng(), e.latLng.lat()]);
      if (tooltip) {
        info.setContent(tooltip.replace(/[<>&"]/g, ""));
        info.setPosition(e.latLng);
        info.open({ map });
      }
    });

  /** HTML element pinned to a point (Marker is deprecated, AdvancedMarker needs a map ID). */
  const overlay = (p: LonLat, el: HTMLElement) => {
    const wrap = pin(el);
    let at = new g.LatLng(p[1], p[0]);
    class Overlay extends g.OverlayView {
      onAdd() {
        this.getPanes()!.floatPane.append(wrap);
      }
      draw() {
        const px = this.getProjection()?.fromLatLngToDivPixel(at);
        if (px) wrap.style.transform = `translate(${px.x}px, ${px.y}px)`;
      }
      onRemove() {
        wrap.remove();
      }
    }
    const o = new Overlay();
    o.setMap(map);
    return {
      o,
      move(next: LonLat) {
        at = new g.LatLng(next[1], next[0]);
        o.draw();
      },
    };
  };

  return {
    engine: "google",
    vectorReady,
    get tilted() {
      return tilted;
    },
    layer() {
      const shapes: { setMap(m: google.maps.Map | null): void }[] = [];
      return {
        line(pts, s) {
          const dash = s.dash
            ? { strokeOpacity: 0, icons: [{ icon: { path: "M 0,-1 0,1", strokeOpacity: s.opacity ?? 1, scale: s.weight / 2 }, offset: "0", repeat: `${s.weight * 3}px` }] }
            : { strokeOpacity: s.opacity ?? 1 };
          const p = new g.Polyline({ map, path: pts.map(ll), strokeColor: colour(s.color), strokeWeight: s.weight, clickable: !!s.tooltip, ...dash });
          forward(p, s.tooltip);
          shapes.push(p);
        },
        area(ring, s) {
          const p = new g.Polygon({ map, paths: ring.map(ll), strokeColor: colour(s.color), strokeWeight: s.weight, fillColor: colour(s.color), fillOpacity: s.fillOpacity });
          forward(p, s.tooltip);
          shapes.push(p);
        },
        dot(pt, s) {
          const el = document.createElement("div");
          el.className = "map-dot";
          el.title = s.tooltip ?? "";
          Object.assign(el.style, { width: `${s.radius * 2}px`, height: `${s.radius * 2}px`, background: s.fill, border: `${s.weight}px solid ${s.color}` });
          shapes.push(overlay(pt, el).o);
        },
        pin(pt, el) {
          shapes.push(overlay(pt, el).o);
        },
        clear() {
          shapes.splice(0).forEach((x) => x.setMap(null));
        },
      };
    },
    marker: (p, el) => overlay(p, el),
    circle(color) {
      const c = new g.Circle({ map, strokeColor: colour(color), strokeWeight: 1, fillColor: colour(color), fillOpacity: 0.12, clickable: false, radius: 10 });
      return { set: (p, r) => (c.setCenter(ll(p)), c.setRadius(r)) };
    },
    fit(pts, pad) {
      if (!pts.length) return;
      const b = new g.LatLngBounds();
      pts.forEach((p) => b.extend(ll(p)));
      map.fitBounds(b, pad);
    },
    view: (p, zoom) => map.moveCamera({ center: ll(p), zoom }),
    camera(p, heading, zoom) {
      map.moveCamera(tilted ? { center: ll(p), heading, tilt: TPP_TILT, zoom } : { center: ll(p), zoom });
      // what the map really shows - read by the browser test and handy when debugging on a phone
      container.dataset.heading = String(Math.round(map.getHeading() ?? 0));
      container.dataset.tilt = String(Math.round(map.getTilt() ?? 0));
    },
    zoom: () => map.getZoom() ?? 15,
    onClick(cb) {
      clickCb = cb;
      map.addListener("click", (e: google.maps.MapMouseEvent) => e.latLng && cb([e.latLng.lng(), e.latLng.lat()]));
    },
    onUserMove(cb) {
      map.addListener("dragstart", cb);
      container.addEventListener("wheel", cb, { passive: true });
    },
    resize() {
      /* the JS API watches its container size itself */
    },
  };
}

function leafletView(container: HTMLElement, o: MapOptions): MapView {
  const map = L.map(container, {
    zoomControl: false,
    dragging: o.interactive,
    scrollWheelZoom: o.interactive,
    doubleClickZoom: o.interactive,
    touchZoom: o.interactive,
    keyboard: o.interactive,
  }).setView([o.center[1], o.center[0]], o.zoom);
  if (o.interactive) L.control.zoom({ position: "topright" }).addTo(map);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" }).addTo(map);
  const ll = ([lon, lat]: LonLat): [number, number] => [lat, lon];
  return {
    engine: "osm",
    tilted: false,
    layer() {
      const group = L.layerGroup().addTo(map);
      const tip = <T extends L.Layer>(layer: T, text?: string) => (text ? layer.bindTooltip(text) : layer).addTo(group);
      return {
        line: (pts, s) => tip(L.polyline(pts.map(ll), { color: s.color, weight: s.weight, opacity: s.opacity ?? 1, dashArray: s.dash ? "8 8" : undefined }), s.tooltip),
        area: (ring, s) => tip(L.polygon(ring.map(ll), { color: s.color, weight: s.weight, fillOpacity: s.fillOpacity, className: s.pulse ? "hazard-pulse" : "" }), s.tooltip),
        dot: (p, s) => tip(L.circleMarker(ll(p), { radius: s.radius, color: s.color, weight: s.weight, fillColor: s.fill, fillOpacity: 1 }), s.tooltip),
        pin: (p, el) => L.marker(ll(p), { icon: L.divIcon({ className: "", html: pin(el), iconSize: [0, 0] }), interactive: false }).addTo(group),
        clear: () => group.clearLayers(),
      };
    },
    marker(p, el) {
      const m = L.marker(ll(p), { icon: L.divIcon({ className: "", html: pin(el), iconSize: [0, 0] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
      return { move: (next) => m.setLatLng(ll(next)) };
    },
    circle(color) {
      const c = L.circle([o.center[1], o.center[0]], { radius: 10, color, weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
      return { set: (p, r) => c.setLatLng(ll(p)).setRadius(r) };
    },
    fit: (pts, pad) => pts.length && map.fitBounds(L.latLngBounds(pts.map(ll)), { padding: [pad, pad] }),
    view: (p, zoom) => map.setView(ll(p), zoom, { animate: false }),
    camera: (p, _heading, zoom) => map.setView(ll(p), zoom, { animate: false }),
    zoom: () => map.getZoom(),
    onClick: (cb) => map.on("click", (e: L.LeafletMouseEvent) => cb([e.latlng.lng, e.latlng.lat])),
    onUserMove(cb) {
      map.on("dragstart", cb);
      container.addEventListener("wheel", cb, { passive: true });
    },
    resize: () => map.invalidateSize(),
  };
}

/** Google's vector (3D) map needs WebGL2 with a real context; don't ask for it where it cannot work. */
function hasWebGL2(): boolean {
  try {
    const gl = document.createElement("canvas").getContext("webgl2", { failIfMajorPerformanceCaveat: true });
    return !!gl;
  } catch {
    return false;
  }
}

export async function createMap(container: HTMLElement, o: MapOptions): Promise<MapView> {
  const google = await loadGoogle();
  document.body.dataset.map = google ? "google" : "osm";
  if (!google) return leafletView(container, o);
  if (o.tpp && hasWebGL2()) {
    const tpp = googleView(container, o, true);
    if (await tpp.vectorReady) return tpp;
    container.replaceChildren(); // no WebGL: a flat, palette-styled map instead
  }
  return googleView(container, o, false);
}

/**
 * Map tags, drawn as HTML so they stand upright (billboards) on the tilted
 * ride map and look the same on every map engine:
 * - rider: third-person avatar seen from behind, on a pulsing ground ring;
 * - flood / waterlogging: an upright swirling spiral disc on a short stand;
 * - pothole: a round "ping" floating above the road, bobbing over its shadow.
 * Static markup only; label text is always set with textContent.
 */

function el(cls: string, html: string, label?: string): HTMLElement {
  const root = document.createElement("div");
  root.className = cls;
  root.innerHTML = html;
  if (label) {
    const tag = document.createElement("span");
    tag.className = "tag-label";
    tag.textContent = label;
    root.append(tag);
  }
  return root;
}

/** Rider from behind on a two-wheeler: helmet, jacket, scooter tail with a rose tail-light. */
export function riderAvatar(): HTMLElement {
  return el(
    "rider-avatar",
    '<div class="ra-ring"></div><div class="ra-shadow"></div>' +
      '<svg class="ra-cone" viewBox="0 0 120 120" aria-hidden="true"><path d="M60 8 L80 52 A24 24 0 0 0 40 52 Z" fill="#839958" opacity=".55"/></svg>' +
      '<svg class="ra-figure" viewBox="0 0 64 88" aria-hidden="true">' +
      '<rect x="27" y="64" width="10" height="22" rx="4" fill="#1b1b1b"/>' + // rear wheel
      '<path d="M14 58 Q32 50 50 58 L46 72 Q32 76 18 72 Z" fill="#F7F4D5" stroke="#0A3323" stroke-width="2"/>' + // scooter tail
      '<rect x="26" y="62" width="12" height="5" rx="2" fill="#D3968C"/>' + // tail light
      '<path d="M18 30 Q32 22 46 30 L49 56 Q32 62 15 56 Z" fill="#0A3323"/>' + // jacket
      '<path d="M30 30 L34 30 L34 56 L30 56 Z" fill="#839958"/>' + // jacket stripe
      '<path d="M18 34 L6 48 M46 34 L58 48" stroke="#0A3323" stroke-width="6" stroke-linecap="round"/>' + // arms to bars
      '<path d="M3 48 L61 48" stroke="#2c2c2c" stroke-width="3" stroke-linecap="round"/>' + // handlebar
      '<circle cx="32" cy="17" r="12" fill="#839958" stroke="#0A3323" stroke-width="2.5"/>' + // helmet
      '<path d="M22 19 Q32 24 42 19" stroke="#0A3323" stroke-width="2" fill="none"/>' +
      "</svg>",
  );
}

/** Archimedean spiral, 3.5 turns, radius 3 -> 31 around (40, 40), as an SVG path. */
const SPIRAL = (() => {
  const pts: string[] = [];
  const turns = 3.5, steps = 140;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * turns * 2 * Math.PI;
    const r = 3 + (28 * i) / steps;
    pts.push(`${(40 + r * Math.cos(t)).toFixed(1)} ${(40 + r * Math.sin(t)).toFixed(1)}`);
  }
  return "M" + pts.join(" L");
})();

/** Flood / waterlogging. `kind`: reported by people (solid) or a camera sighting (dashed, "possible"). */
export function floodSpiral(label: string, kind: "reported" | "camera"): HTMLElement {
  return el(
    `flood-spiral flood-${kind}`,
    '<div class="fs-shadow"></div><div class="fs-stem"></div>' +
      '<svg class="fs-disc" viewBox="0 0 80 80" aria-hidden="true">' +
      '<circle cx="40" cy="40" r="36" class="fs-rim"/>' +
      `<g class="fs-swirl"><path d="${SPIRAL}"/></g>` +
      "</svg>",
    label,
  );
}

/** Pothole ping. `severe` = estimated deep (or a confirmed alert). */
export function potholePing(label: string, severe: boolean): HTMLElement {
  return el(
    `pothole-ping${severe ? " ping-severe" : ""}`,
    '<div class="pp-shadow"></div><div class="pp-stem"></div><div class="pp-ball"><div class="pp-core"></div></div>',
    label,
  );
}

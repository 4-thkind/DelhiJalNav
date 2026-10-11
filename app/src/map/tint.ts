/**
 * The tilted map is Google's dark vector style (navy) turned to the palette by a
 * CSS filter on its canvas (style.css: hue-rotate(-70deg) saturate(.75)). Shapes
 * drawn in that canvas are filtered too, so their colours go through the exact
 * inverse of the filter matrix first (Filter Effects spec matrices; checked
 * against rendered pixels). HTML tags are not filtered and need nothing.
 */
/** Forward filter matrix (saturate . hue-rotate), for the check. */
export const TINT_FORWARD: number[][] = [];
const TINT_INVERSE = (() => {
  const a = (-70 * Math.PI) / 180, c = Math.cos(a), n = Math.sin(a), k = 0.75;
  const h = [
    [0.213 + c * 0.787 - n * 0.213, 0.715 - c * 0.715 - n * 0.715, 0.072 - c * 0.072 + n * 0.928],
    [0.213 - c * 0.213 + n * 0.143, 0.715 + c * 0.285 + n * 0.14, 0.072 - c * 0.072 - n * 0.283],
    [0.213 - c * 0.213 - n * 0.787, 0.715 - c * 0.715 + n * 0.715, 0.072 + c * 0.928 + n * 0.072],
  ];
  const sat = [
    [0.213 + 0.787 * k, 0.715 - 0.715 * k, 0.072 - 0.072 * k],
    [0.213 - 0.213 * k, 0.715 + 0.285 * k, 0.072 - 0.072 * k],
    [0.213 - 0.213 * k, 0.715 - 0.715 * k, 0.072 + 0.928 * k],
  ];
  const m = sat.map((row) => [0, 1, 2].map((j) => row.reduce((acc, v, i) => acc + v * h[i][j], 0))); // saturate . hue
  TINT_FORWARD.push(...m);
  const [[a1, b1, c1], [a2, b2, c2], [a3, b3, c3]] = m;
  const det = a1 * (b2 * c3 - c2 * b3) - b1 * (a2 * c3 - c2 * a3) + c1 * (a2 * b3 - b2 * a3);
  return [
    [(b2 * c3 - c2 * b3) / det, (c1 * b3 - b1 * c3) / det, (b1 * c2 - c1 * b2) / det],
    [(c2 * a3 - a2 * c3) / det, (a1 * c3 - c1 * a3) / det, (c1 * a2 - a1 * c2) / det],
    [(a2 * b3 - b2 * a3) / det, (b1 * a3 - a1 * b3) / det, (a1 * b2 - b1 * a2) / det],
  ];
})();

/** The colour to draw so that, after the canvas filter, `hex` is what shows. */
export function untint(hex: string): string {
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return "#" + TINT_INVERSE.map((row) => {
    const v = Math.round(Math.min(1, Math.max(0, row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2])) * 255);
    return v.toString(16).padStart(2, "0");
  }).join("");
}

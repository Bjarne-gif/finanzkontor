/* ============================================================
   KI — gemeinsame Bausteine für Reaktor (SVG) und Münze (WebGL).
   Bereiche, Farben und die Leiterbahn-Formen je Bereich.
   ============================================================ */

/* Bereiche. soon = im Backend noch nicht vorhanden: wird angezeigt,
   aber ausgegraut und nicht schaltbar (kommt mit dem Datenabzug). */
export const AREAS = [
  { id: "haushalt",  nm: "Haushalt",        ds: "Einnahmen, Kosten, Überschuss, Töpfe",            color: "#43b6ff" },
  { id: "vermoegen", nm: "Vermögen",        ds: "Besitz, Schulden, Netto, Rücklagen",              color: "#4fe08a" },
  { id: "vertraege", nm: "Verträge",        ds: "Abos, Kosten, Kündigungsfristen",                 color: "#e0b24a" },
  { id: "partner",   nm: "Vertragspartner", ds: "Kontakt, Kündigungs-E-Mail, Adressen",            color: "#b58cff" },
  { id: "dokumente", nm: "Dokumente",       ds: "Inhalt der Vertragsdokumente, auch Scans",        color: "#ff7a95" },
];

export const R_DIM = "#5a4f38", R_BLOCK_OFF = "#4a4231", R_SEPIA = "#cdbb90", R_NSEG = 16;

/* Design-Koordinaten wie das SVG: 0..100, Mitte 50/50, Winkel im Uhrzeigersinn */
export const rPol = (r, deg) => { const a = deg * Math.PI / 180; return [50 + Math.cos(a) * r, 50 + Math.sin(a) * r]; };
export const angleOf = (i) => -90 + i * (360 / AREAS.length);
export const modelLabel = (m) => (m || "").replace(/:latest$/, "");

/* Leiterbahn-Formen: fünf Module, eines je Bereich. Lokale Koordinaten:
   y = nach außen, x = seitlich. Je Strang reicht ein Ende an den Goldring
   (ring = 1), die übrigen enden innen als Via. Geprüft: keine Überschneidung. */
const STRAND_DESIGNS = [{"lines": [[[0, 5.8], [0, 12]], [[0, 12], [-4, 16], [-4, 23.867]], [[0, 12], [4, 16], [4, 20]]], "pads": [[[-4, 23.867], 1], [[4, 20], 0]], "flow": [[-4, 23.867], [-4, 16], [0, 12], [0, 5.8]]}, {"lines": [[[0, 5.8], [0, 11]], [[0, 11], [0, 24.2]], [[0, 11], [4, 15], [4, 19]], [[0, 15], [-3.5, 18.5]]], "pads": [[[0, 24.2], 1], [[4, 19], 0], [[-3.5, 18.5], 0]], "flow": [[0, 24.2], [0, 11], [0, 5.8]]}, {"lines": [[[0, 5.8], [0, 10]], [[0, 10], [-3, 13], [-3, 24.013]], [[0, 10], [3, 13], [3, 17]], [[3, 17], [1, 19], [1, 21.5]], [[3, 17], [6, 20]]], "pads": [[[-3, 24.013], 1], [[1, 21.5], 0], [[6, 20], 0]], "flow": [[-3, 24.013], [-3, 13], [0, 10], [0, 5.8]]}, {"lines": [[[0, 5.8], [0, 13]], [[0, 13], [0, 24.2]], [[0, 13], [-4, 17], [-4, 20]]], "pads": [[[0, 24.2], 1], [[-4, 20], 0]], "flow": [[0, 24.2], [0, 13], [0, 5.8]]}, {"lines": [[[0, 5.8], [0, 9]], [[0, 9], [2.5, 11.5], [2.5, 24.071]], [[0, 9], [-3, 12], [-3, 17], [-6, 20]]], "pads": [[[2.5, 24.071], 1], [[-6, 20], 0]], "flow": [[2.5, 24.071], [2.5, 11.5], [0, 9], [0, 5.8]]}];
const strandVariant = (i) => STRAND_DESIGNS[i % STRAND_DESIGNS.length];
const toPolar = ([x, y]) => [Math.hypot(x, y), Math.atan2(x, y) * 180 / Math.PI];
const localPt = (p, angle) => { const [r, o] = toPolar(p); return rPol(r, angle + o); };

export function branchLines(angle, i = 0) {
  return strandVariant(i).lines.map((l, k) => ({ kind: k === 0 ? "stem" : "branch", p: l.map((p) => localPt(p, angle)) }));
}
/* Endpunkte als [Radius, Winkel, amRing] */
export const PADS = (angle, i = 0) => strandVariant(i).pads.map(([p, ring]) => { const [r, o] = toPolar(p); return [r, angle + o, ring]; });
export const FLOW = (angle, i = 0) => strandVariant(i).flow.map((p) => localPt(p, angle));
/* neutrale Füll-Bahnen zwischen den Bereichen */
export const FILLER = (a) => [rPol(8, a), rPol(13, a)];

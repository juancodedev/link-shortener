import { matrixToPath, qrMatrix } from "../api/qr";

// ---------------------------------------------------------------------------
// The 10×10 cm review card, as SVG (odd/tasks/print-queue-cards.md S4)
//
// A port of the generator the operator designed: two designs ("official", the
// Google-coloured arc, and "minimal", the clean glass card) in three variants
// (QR + NFC, QR only, NFC only). Geometry is in millimetres on a 100×100
// viewBox, so the same string is the screen preview and the printed card.
//
// What changed from the original is only the QR: it comes from the server's
// generator (src/api/qr.ts) and always encodes the link's SHORT URL. The short
// URL is what keeps a printed card re-pointable; a destination printed into a
// QR could never be corrected.
//
// Mirror mode and crop guides are not drawn here: they are presentation of the
// sheet (a CSS transform and an outline) and the dashboard applies them.
// ---------------------------------------------------------------------------

export const CARD_DESIGNS = ["official", "minimal"] as const;
export const CARD_VARIANTS = ["hybrid", "qr", "nfc"] as const;
export type CardDesign = (typeof CARD_DESIGNS)[number];
export type CardVariant = (typeof CARD_VARIANTS)[number];

export function isCardDesign(v: string): v is CardDesign {
  return (CARD_DESIGNS as readonly string[]).includes(v);
}
export function isCardVariant(v: string): v is CardVariant {
  return (CARD_VARIANTS as readonly string[]).includes(v);
}

const FONT = "'Google Sans','Product Sans','Outfit','Inter',sans-serif";
const FONT_MIN = "'Inter','Google Sans',sans-serif";
const INK = "#202124";
const SLATE = "#2c3e50";
const SLATE_L = "#3b5168";
const GOLD = "#E8A317";

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/** Annular sector between two angles (SVG: 0° = right, clockwise). */
function sector(cx: number, cy: number, r1: number, r2: number, a1: number, a2: number): string {
  const [x1, y1] = polar(cx, cy, r2, a1);
  const [x2, y2] = polar(cx, cy, r2, a2);
  const [x3, y3] = polar(cx, cy, r1, a2);
  const [x4, y4] = polar(cx, cy, r1, a1);
  const large = Math.abs(a2 - a1) > 180 ? 1 : 0;
  const sw = a2 > a1 ? 1 : 0;
  return `M${x1} ${y1} A${r2} ${r2} 0 ${large} ${sw} ${x2} ${y2} L${x3} ${y3} A${r1} ${r1} 0 ${large} ${1 - sw} ${x4} ${y4}Z`;
}

function star(cx: number, cy: number, r: number, colour = "#FBBC04"): string {
  const p: string[] = [];
  for (let i = 0; i < 10; i++) {
    const [x, y] = polar(cx, cy, i % 2 ? r * 0.45 : r, -90 + i * 36);
    p.push(`${x.toFixed(3)},${y.toFixed(3)}`);
  }
  return `<polygon points="${p.join(" ")}" fill="${colour}" stroke="${colour}" stroke-width="0.5" stroke-linejoin="round"/>`;
}

// --- official design --------------------------------------------------------

/** The arc: two concentric bands. Outer blue | green, inner yellow | red. */
function googleArc(): string {
  const cx = 50, cy = -9.4, R = 29.7, band = 4.9, mid = R - band, inner = R - 2 * band, split = 134;
  return `<path d="${sector(cx, cy, mid, R, split, 200)}" fill="#4285F4"/>
    <path d="${sector(cx, cy, inner, mid, split, 200)}" fill="#FBBC05"/>
    <path d="${sector(cx, cy, mid, R, -20, split)}" fill="#34A853"/>
    <path d="${sector(cx, cy, inner, mid, -20, split)}" fill="#EA4335"/>`;
}

/** A square-module QR fitted into a `size`-mm box at (x, y). Pure black. */
function squareQr(url: string, x: number, y: number, size: number): string {
  const matrix = qrMatrix(url);
  const d = matrixToPath(matrix, { x, y }, size / matrix.length);
  return `<path d="${d}" fill="#000000" shape-rendering="crispEdges"/>`;
}

/** A phone with NFC waves, centred on (cx, cy), scale k. */
function nfcIcon(cx: number, cy: number, k: number): string {
  const w = 10 * k, h = 15 * k, sw = 0.75 * k;
  const wave = (dir: number, r: number) => {
    const x = cx + dir * (w / 2 + (r === 1 ? 2.6 : 5.2) * k);
    const dy = (r === 1 ? 2.6 : 4.4) * k;
    return `<path d="M${x} ${cy - dy} Q${x + dir * 1.8 * k} ${cy} ${x} ${cy + dy}" fill="none" stroke="${INK}" stroke-width="${0.7 * k}" stroke-linecap="round"/>`;
  };
  return `${wave(-1, 1)}${wave(-1, 2)}${wave(1, 1)}${wave(1, 2)}
    <rect x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" rx="${1.6 * k}" fill="#fff" stroke="${INK}" stroke-width="${sw}"/>
    <rect x="${cx - w / 2 + 1.5 * k}" y="${cy - h / 2 + 2.6 * k}" width="${w - 3 * k}" height="${6.4 * k}" rx="${0.5 * k}" fill="none" stroke="${INK}" stroke-width="${0.3 * k}"/>
    <text x="${cx}" y="${cy - h / 2 + 6.8 * k}" font-size="${2.9 * k}" font-weight="700" text-anchor="middle" font-family="${FONT}" fill="${INK}">NFC</text>
    <circle r="${0.5 * k}" cx="${cx}" cy="${cy + h / 2 - 2 * k}" fill="${INK}"/>`;
}

function label(x: number, y: number, txt: string, size = 4.4, weight = 600): string {
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" text-anchor="middle" dominant-baseline="central" font-family="${FONT}" fill="${INK}">${txt}</text>`;
}

function officialCard(variant: CardVariant, url: string): string {
  const stars = [0, 1, 2, 3, 4].map((i) => star(28.2 + i * 10.9, 54, 3.8)).join("");
  let body: string;
  if (variant === "hybrid") {
    body = `<line x1="50" y1="64" x2="50" y2="93" stroke="#9aa0a6" stroke-width="0.25"/>
      ${squareQr(url, 17, 64, 21)}
      ${label(27.5, 91.8, "Escanea")}
      ${nfcIcon(70.7, 73, 1.25)}
      ${label(70.7, 87.3, "Acerca tu")}${label(70.7, 91.8, "celular aquí")}`;
  } else if (variant === "qr") {
    body = `${squareQr(url, 37, 64, 26)}${label(50, 92, "Escanea con tu cámara")}`;
  } else {
    body = `${nfcIcon(50, 75, 1.7)}${label(50, 92.5, "Acerca tu celular aquí", 4.6)}`;
  }
  return `<rect width="100" height="100" fill="#fff"/>
    ${googleArc()}
    ${label(50, 28.5, "Califícanos en", 8, 400)}
    <text x="50" y="41" font-size="19" font-weight="500" text-anchor="middle" dominant-baseline="central" font-family="${FONT}" textLength="57" lengthAdjust="spacingAndGlyphs"><tspan fill="#4285F4">G</tspan><tspan fill="#EA4335">o</tspan><tspan fill="#FBBC05">o</tspan><tspan fill="#4285F4">g</tspan><tspan fill="#34A853">l</tspan><tspan fill="#EA4335">e</tspan></text>
    ${stars}
    <line x1="8.7" y1="61" x2="91.3" y2="61" stroke="#9aa0a6" stroke-width="0.25"/>
    ${body}`;
}

// --- minimal design ---------------------------------------------------------

function googleG(cx: number, cy: number, R: number): string {
  const band = R * 0.42, r1 = R - band;
  return `<g transform="translate(${cx} ${cy})">
    <path d="${sector(0, 0, r1, R, -140, -45)}" fill="#EA4335"/>
    <path d="${sector(0, 0, r1, R, -205, -140)}" fill="#FBBC05"/>
    <path d="${sector(0, 0, r1, R, 50, 155)}" fill="#34A853"/>
    <path d="${sector(0, 0, r1, R, 0, 50)}" fill="#4285F4"/>
    <rect x="0" y="${-band * 0.2}" width="${R}" height="${band * 0.9}" fill="#4285F4"/>
  </g>`;
}

/** Dotted QR: round modules and rounded finder rings, at level H. */
function dottedQr(url: string, x: number, y: number, size: number): string {
  const matrix = qrMatrix(url, "H");
  const n = matrix.length, m = size / n;
  const inFinder = (r: number, c: number) =>
    (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
  let dots = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (inFinder(r, c) || !matrix[r]![c]) continue;
      dots += `<circle cx="${(x + (c + 0.5) * m).toFixed(3)}" cy="${(y + (r + 0.5) * m).toFixed(3)}" r="${(m * 0.46).toFixed(3)}"/>`;
    }
  }
  const finder = (r0: number, c0: number) => {
    const fx = x + c0 * m, fy = y + r0 * m;
    return `<rect x="${fx + m / 2}" y="${fy + m / 2}" width="${6 * m}" height="${6 * m}" rx="${m * 0.9}" fill="none" stroke="#000000" stroke-width="${m}"/>
      <rect x="${fx + 2 * m}" y="${fy + 2 * m}" width="${3 * m}" height="${3 * m}" rx="${m * 0.5}" fill="#000000"/>`;
  };
  return `<g fill="#000000">${dots}</g>${finder(0, 0)}${finder(0, n - 7)}${finder(n - 7, 0)}`;
}

function brackets(x: number, y: number, w: number, h: number, len = 7): string {
  const p = (px: number, py: number, dx: number, dy: number) =>
    `M${px + dx * len} ${py} L${px} ${py} L${px} ${py + dy * len}`;
  return `<path d="${p(x, y, 1, 1)} ${p(x + w, y, -1, 1)} ${p(x + w, y + h, -1, -1)} ${p(x, y + h, 1, -1)}" fill="none" stroke="${SLATE_L}" stroke-width="0.4" stroke-linecap="round" stroke-linejoin="round"/>`;
}

/** Phone with "NFC" and two waves per side; waves reach ±10·k from cx. */
function nfcPhone(cx: number, cy: number, k: number): string {
  const arc = (r: number, dir: number) => {
    const [x1, y1] = polar(0, 0, r, dir > 0 ? -35 : 215);
    const [x2, y2] = polar(0, 0, r, dir > 0 ? 35 : 145);
    return `<path d="M${x1} ${y1} A${r} ${r} 0 0 ${dir > 0 ? 1 : 0} ${x2} ${y2}"/>`;
  };
  return `<g transform="translate(${cx} ${cy}) scale(${k})" fill="none" stroke="#2b2b2b" stroke-linecap="round" stroke-linejoin="round">
    <g stroke-width="0.6">${arc(7.4, 1)}${arc(10, 1)}${arc(7.4, -1)}${arc(10, -1)}</g>
    <rect x="-5" y="-8" width="10" height="16" rx="1.8" fill="#fff" stroke-width="0.7"/>
    <path d="M-1.6 -6.3 H1.6 M-1.6 6.3 H1.6" stroke-width="0.6"/>
    <rect x="-3.2" y="-3.2" width="6.4" height="6.4" rx="0.8" stroke-width="0.25" stroke="#666"/>
    <text x="0" y="0.2" font-size="2.5" font-weight="500" text-anchor="middle" dominant-baseline="central" font-family="${FONT_MIN}" fill="#2b2b2b" stroke="none">NFC</text>
  </g>`;
}

function txt(x: number, y: number, t: string, size: number, weight: number, colour: string): string {
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" text-anchor="middle" dominant-baseline="central" font-family="${FONT_MIN}" fill="${colour}">${t}</text>`;
}

function minimalCard(variant: CardVariant, url: string): string {
  const head = `${googleG(50, 11.5, 4.6)}
    <text x="50" y="24.5" font-size="6.2" font-weight="700" text-anchor="middle" dominant-baseline="central" font-family="${FONT_MIN}" fill="${SLATE}" textLength="80" lengthAdjust="spacingAndGlyphs">Valoraciones &amp; Reseñas</text>
    <line x1="8" y1="33.2" x2="34" y2="33.2" stroke="${SLATE_L}" stroke-width="0.3"/>
    <line x1="66" y1="33.2" x2="92" y2="33.2" stroke="${SLATE_L}" stroke-width="0.3"/>
    ${[0, 1, 2, 3, 4].map((i) => star(39.2 + i * 5.4, 33.2, 2.2, GOLD)).join("")}`;
  let body: string;
  if (variant === "hybrid") {
    body = `${brackets(6.5, 40.5, 47, 47)}${dottedQr(url, 10, 44, 40)}
      ${txt(80, 46.5, "Tap", 5, 400, "#2b2b2b")}${nfcPhone(80, 58.5, 1)}
      ${txt(80, 75, "Gracias por apoyar", 2.8, 400, "#2b2b2b")}${txt(80, 78.8, "a nuestro equipo", 2.8, 400, "#2b2b2b")}`;
  } else if (variant === "qr") {
    body = `${brackets(25.5, 37, 49, 49)}${dottedQr(url, 29, 40.5, 42)}
      ${txt(50, 91, "Escanea con tu cámara", 4.2, 700, SLATE_L)}${txt(50, 95.8, "Gracias por apoyar a nuestro equipo", 3.2, 600, SLATE_L)}`;
  } else {
    body = `${txt(50, 43.5, "Tap", 6.5, 400, "#2b2b2b")}${nfcPhone(50, 66.5, 1.8)}${txt(50, 87.5, "Gracias por apoyar", 4.4, 400, "#2b2b2b")}${txt(50, 93, "a nuestro equipo", 4.4, 400, "#2b2b2b")}`;
  }
  return `<rect width="100" height="100" fill="#fff"/>${head}${body}`;
}

/**
 * One review card as an SVG element, 100×100 mm. Fixed Spanish copy only:
 * nothing the caller supplies is printed as text, and the URL only reaches the
 * QR matrix.
 */
export function renderReviewCard(params: {
  shortUrl: string;
  design: CardDesign;
  variant: CardVariant;
}): string {
  const inner =
    params.design === "official"
      ? officialCard(params.variant, params.shortUrl)
      : minimalCard(params.variant, params.shortUrl);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm" style="display:block">${inner}</svg>`;
}

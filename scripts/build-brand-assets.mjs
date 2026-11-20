#!/usr/bin/env node
/**
 * Builds the brand assets in web/public: favicon.svg, favicon-32.png,
 * apple-touch-icon.png and og.png (src/handlers/brand-head.ts links them).
 *
 * Run from the repo root after changing the mark, the palette or the review
 * card's design, and commit the output:
 *
 *   node scripts/build-brand-assets.mjs [debug-dir]
 *
 * Pass a debug directory to also get og-source.svg there; it never goes in
 * web/public, whose contents the tests pin. Uses the sharp that wrangler
 * already installs and Vite's SSR loader to draw the real card from
 * src/cards/render.ts, so the OG image shows exactly what the product prints.
 */
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const require = createRequire(resolve(root, "package.json"));
const sharpDir = readdirSync(resolve(root, "node_modules/.pnpm")).find((d) => d.startsWith("sharp@"));
const sharp = require(resolve(root, "node_modules/.pnpm", sharpDir, "node_modules/sharp"));
const { createServer } = await import(resolve(root, "node_modules/vite/dist/node/index.js"));

const out = resolve(root, "web/public");
mkdirSync(out, { recursive: true });

const PIZARRA = "#1f3b34";
const PAPEL = "#fbfaf6";
const ESTRELLA = "#f2b01e";
const SOBRE = "#e9efe9";

function starPoints(cx, cy, R, r) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? R : r;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(`${(cx + rad * Math.cos(a)).toFixed(2)},${(cy + rad * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(" ");
}

// The mark: a slate tile holding one gold star, the thing every card asks for.
// The star sits slightly low so it reads optically centred.
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="${PIZARRA}"/>
  <polygon points="${starPoints(32, 34, 22, 9.4)}" fill="${ESTRELLA}" stroke="${ESTRELLA}" stroke-width="2.5" stroke-linejoin="round"/>
</svg>
`;
writeFileSync(resolve(out, "favicon.svg"), favicon);

// Apple touch icon: full-bleed (iOS rounds the corners itself).
const touch = favicon.replace('rx="14"', 'rx="0"');
await sharp(Buffer.from(touch), { density: 600 }).resize(180, 180).png().toFile(resolve(out, "apple-touch-icon.png"));

// A PNG for browsers without SVG favicons. No /favicon.ico on purpose: the
// customer-facing pages carry the business's name, not ours, and browsers
// fetch /favicon.ico on their own when a page links no icon.
await sharp(Buffer.from(favicon), { density: 600 }).resize(32, 32).png().toFile(resolve(out, "favicon-32.png"));

// OG image, 1200×630: the real card the product prints, beside the promise.
const vite = await createServer({ root, logLevel: "silent", server: { middlewareMode: true }, appType: "custom" });
const { renderReviewCard } = await vite.ssrLoadModule("/src/cards/render.ts");
await vite.close();
const card = renderReviewCard({ shortUrl: "https://masresenas.cl/signup", design: "official", variant: "hybrid" })
  // A nested <svg> clips to the card, as the printed card does.
  .replace(/^<svg[^>]*>/, '<svg width="100" height="100" viewBox="0 0 100 100" overflow="hidden">');

const SERIF = "'Iowan Old Style','Palatino',Georgia,serif";
const SANS = "'Helvetica Neue',Arial,sans-serif";
const stars = [0, 1, 2, 3, 4].map((i) => `<polygon points="${starPoints(96 + i * 38, 170, 15, 6.4)}" fill="${ESTRELLA}"/>`).join("");
const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#000" flood-opacity="0.35"/>
    </filter>
  </defs>
  <rect width="1200" height="630" fill="${PIZARRA}"/>
  ${stars}
  <text x="80" y="300" font-family="${SERIF}" font-size="104" font-weight="600" fill="${PAPEL}">Más Reseñas</text>
  <text x="82" y="380" font-family="${SANS}" font-size="34" fill="${SOBRE}">Una tarjeta con QR y NFC en cada mesa.</text>
  <text x="82" y="428" font-family="${SANS}" font-size="34" fill="${SOBRE}">Tus clientes te califican en Google.</text>
  <text x="82" y="550" font-family="${SANS}" font-size="28" font-weight="700" fill="${ESTRELLA}">masresenas.cl</text>
  <g transform="translate(745 118) rotate(4 50 50) scale(4)" filter="url(#shadow)">${card}</g>
</svg>`;
if (process.argv[2]) writeFileSync(resolve(process.argv[2], "og-source.svg"), og);
await sharp(Buffer.from(og), { density: 144 }).resize(1200, 630).png({ compressionLevel: 9 }).toFile(resolve(out, "og.png"));
console.log("ok");

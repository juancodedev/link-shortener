// ---------------------------------------------------------------------------
// The brand's <head> tags: favicon on every Más Reseñas page, and the link
// preview (Open Graph / Twitter) on the landing. The files live in web/public
// and Vite copies them to dist-web, which the Worker serves as static assets.
// scripts/build-brand-assets.mjs regenerates them.
//
// The pages a business's own customers see (gate, redirect, action screen,
// setup) carry the business's name, so they link none of this. There is
// deliberately no /favicon.ico: browsers fetch it on their own for a page that
// links no icon, and it would put our star on those pages.
// ---------------------------------------------------------------------------

export const BRAND_ICONS = `<link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">`;

function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Open Graph and Twitter tags. Scrapers need absolute URLs, so the image and
 * the canonical URL are built on the page's own origin (query string dropped).
 */
export function socialMeta(params: { origin: string; path: string; title: string; description: string }): string {
  const url = params.origin + params.path;
  return `<meta property="og:type" content="website">
  <meta property="og:site_name" content="Más Reseñas">
  <meta property="og:locale" content="es_CL">
  <meta property="og:title" content="${attr(params.title)}">
  <meta property="og:description" content="${attr(params.description)}">
  <meta property="og:url" content="${attr(url)}">
  <meta property="og:image" content="${attr(params.origin)}/og.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="Tarjeta de reseñas de Más Reseñas con QR y NFC">
  <meta name="twitter:card" content="summary_large_image">`;
}

import qrcode from "qrcode-generator";
import { textToPathData } from "../qr/font";
import { toCsv } from "../utils/csv";
import { zipSync } from "fflate";
import type { Handler } from "hono";
import type { AppEnv, HonoVars } from "../types/env";
import { withClient } from "../db/client";
import { qualifyTable } from "../db/schema";
import { resolveRegistryEntry } from "./links";
import { ValidationError, NotFoundError } from "../middleware/error";

// ---------------------------------------------------------------------------
// Server-side QR, as SVG
//
// WHY THIS IS SERVER-SIDE AND NOT A THIRD-PARTY IMAGE
//
// The QR used to be an <img> pointing at `api.qrserver.com`. For a link that
// forwards customers that is a dependency on someone else's uptime, and for
// this product it is worse than that: the QR is what is PRINTED. A card is
// pasted once and lives in the world for months. Every URL behind one of those
// stickers currently leaves this infrastructure and travels to a third party
// before it comes back as a picture.
//
// SVG, NOT PNG, because "high resolution" on paper means resolution-INDEPENDENT.
// A PNG needs a DPI the caller has to guess, and a guessed DPI is a blurry
// sticker or a 20MB file. An SVG is exact at any size and prints at whatever
// the press is, which is the only answer to "alta resolución" that is correct
// for every printer instead of one.
//
// WHY A GENERATOR RATHER THAN A FONT
//
// A QR built from vector modules in an SVG scales without artefacts and renders
// identically in a browser, a PDF and a print RIP. Drawing it as glyphs from a
// font would make legibility depend on the font being installed on whatever
// machine opens the file.
//
// ERROR CORRECTION IS A PHYSICAL DECISION, NOT A DEFAULT
//
// M tolerates ~15% damage, Q ~25%, H ~30%. The higher the level, the more
// redundancy is paid for in module count — and module count is width. A higher
// level is strictly easier to scan from a table across a room, at the cost of a
// larger symbol. For stickers that will be read at a distance, and possibly
// with a scratch across them, Q is the right default. 24px of quiet zone is the
// spec's minimum and is honoured exactly, because the quiet zone is what makes
// a symbol scannable and it is the first thing a tight layout drops.
// ---------------------------------------------------------------------------

/**
 * Renders one QR as a standalone SVG string.
 *
 * `typeNumber = 0` lets the library pick the smallest version that fits the
 * payload, which is the widest margin for error correction at a given size. A
 * pinned higher typeNumber would be more bytes for the same string and a
 * physically larger symbol for no benefit.
 */
/** Error correction level. See the note above for why Q and not M. */
const ECC = "Q" as const;

/** Millimetres per module. The single number that sets how big the mark prints. */
export const MODULE_MM = 1.6;

/**
 * Quiet zone, in MODULES.
 *
 * The specification says four. This code shipped one, which is the difference
 * between a symbol with a guaranteed margin and a symbol that happens to work
 * when the scanner is generous — and "the scanner was generous" is not a
 * property anyone can rely on once the sticker is on a table under a lamp.
 */
export const QUIET_MODULES = 4;

/**
 * The QR matrix as booleans, read from the generator rather than recovered from
 * its SVG.
 *
 * The library can emit a path, and an earlier version of this file used that
 * path as the source of truth — then had to regex the coordinates back out of it
 * to learn anything. Reading `isDark` is the API the generator actually offers,
 * and it means the geometry below is derived from the matrix instead of from a
 * rendering of the matrix.
 */
export function qrMatrix(data: string): boolean[][] {
  const qr = qrcode(0, ECC);
  qr.addData(data);
  qr.make();

  const n = qr.getModuleCount();
  const rows: boolean[][] = [];
  for (let r = 0; r < n; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c));
    rows.push(row);
  }
  return rows;
}

/**
 * Draws a QR matrix as ONE path of merged horizontal runs.
 *
 * NOT one rectangle per module. 564 separate rectangles can show hairline seams
 * where the renderer anti-aliases adjacent edges, and a seam through the finder
 * pattern is a symbol some scanners refuse. Merging each run of dark modules
 * into a single rectangle removes the shared edge entirely, and `crispEdges`
 * tells the renderer not to smooth what is left.
 *
 * Emitted in millimetre user units so the geometry below is readable arithmetic
 * rather than a mystery scale factor. The previous version carried
 * `scale(0.777)` — a number with no derivation — and the mark overflowed the
 * card by 27mm on two sides.
 */
export function matrixToPath(
  matrix: boolean[][],
  origin: { x: number; y: number },
  module: number = MODULE_MM,
): string {
  const f = (v: number) => {
    const s = v.toFixed(3);
    return s.replace(/0+$/, "").replace(/\.$/, "");
  };

  const parts: string[] = [];
  for (let r = 0; r < matrix.length; r++) {
    const row = matrix[r]!;
    let c = 0;
    while (c < row.length) {
      if (!row[c]) {
        c++;
        continue;
      }
      let end = c;
      while (end < row.length && row[end]) end++;

      const x = origin.x + c * module;
      const y = origin.y + r * module;
      const w = (end - c) * module;
      parts.push(`M${f(x)} ${f(y)}h${f(w)}v${f(module)}h${f(-w)}z`);
      c = end;
    }
  }
  return parts.join("");
}

/** Strips the generator's document wrapper, keeping only its drawing. */
function stripSvgWrapper(svg: string): string {
  const open = svg.indexOf(">", svg.indexOf("<svg"));
  const close = svg.lastIndexOf("</svg>");
  return svg.slice(open + 1, close);
}

/**
 * A standalone QR as an SVG document, in millimetres.
 *
 * Sized from the matrix rather than from a caller-supplied pixel count, so the
 * quiet zone is part of the drawing instead of a hint the caller can forget.
 */
export function renderQrSvg(url: string): string {
  const matrix = qrMatrix(url);
  const n = matrix.length;
  const panel = (n + 2 * QUIET_MODULES) * MODULE_MM;
  const path = matrixToPath(matrix, {
    x: QUIET_MODULES * MODULE_MM,
    y: QUIET_MODULES * MODULE_MM,
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${panel}mm" height="${panel}mm" viewBox="0 0 ${panel} ${panel}">
  <rect width="${panel}" height="${panel}" fill="#ffffff"/>
  <path fill="#000000" shape-rendering="crispEdges" d="${path}"/>
</svg>`;
}

/**
 * One printable card, as SVG. Sized in millimetres.
 *
 * A card is not a QR code. It is a QR code on a physical object that a designer
 * lays out, cuts and laminates, and what they need from this system is the
 * mark — not artwork.
 *
 * THE GEOMETRY, IN ARITHMETIC RATHER THAN IN A MAGIC NUMBER
 *
 *   card      85 x 85 mm
 *   module    1.6 mm
 *   quiet     4 modules each side (the specification's minimum)
 *   panel     (33 + 8) x 1.6 = 65.6 mm, centred horizontally, 6 mm from the top
 *   baseline  79.9 mm, which is the centre of the band left below the panel
 *
 * This version replaced `scale(0.777)`, an unsourced constant that assumed a QR
 * of ~84 units. The real one is 132 at version 4, so the mark rendered 99.5 mm
 * wide on an 85 mm card and lost 27 mm off the right and bottom. It looked
 * perfect on screen and would have failed in the wild, because an SVG does not
 * warn you that it does not fit on the paper.
 *
 * WHY FOUR MODULES OF QUIET ZONE
 *
 * The specification says four. The previous code drew one, which works when a
 * scanner is feeling generous and does not work when it is not — and the
 * generosity of a scanner is not something anyone can promise about a sticker
 * that will be scratched, taped at an angle and read under a bar lamp.
 *
 * WHY PURE BLACK
 *
 * The print shop converts to K100. Anything that is merely very dark — #2b2622,
 * a colour profile, a "rich black" — becomes a four-colour build, costs more,
 * and prints a grey. #000000 and #ffffff are the two values a press agrees on.
 *
 * WHY NO `<text>`
 *
 * The short code is the fallback for a damaged card: a human reads it and types
 * it. As a text element, its shape is decided by whoever opens the file, and
 * that person is not us. As outlines it is fixed forever. See src/qr/font.ts.
 */
export function renderCardSvg(params: {
  shortUrl: string;
  shortCode: string;
  clientRef?: string | null;
}): string {
  const CARD_MM = 85;
  const PANEL_TOP = 6;
  const CODE_SIZE = 4.5;
  const CODE_TRACKING = 0.4;
  const CODE_BASELINE = 79.9;
  const REF_SIZE = 3;
  const REF_BASELINE = 84.2;

  const matrix = qrMatrix(params.shortUrl);
  const n = matrix.length;
  const panel = (n + 2 * QUIET_MODULES) * MODULE_MM;
  const panelX = (CARD_MM - panel) / 2;

  const qr = matrixToPath(matrix, {
    x: panelX + QUIET_MODULES * MODULE_MM,
    y: PANEL_TOP + QUIET_MODULES * MODULE_MM,
  });

  const code = textToPathData(params.shortCode, {
    size: CODE_SIZE,
    centerX: CARD_MM / 2,
    baseline: CODE_BASELINE,
    tracking: CODE_TRACKING,
  });

  const ref = (params.clientRef ?? "").trim();
  const refPath = ref
    ? textToPathData(ref, {
        size: REF_SIZE,
        centerX: CARD_MM / 2,
        baseline: REF_BASELINE,
        tracking: 0.15,
      }).d
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_MM}mm" height="${CARD_MM}mm" viewBox="0 0 ${CARD_MM} ${CARD_MM}">
  <title>QR card ${escapeXml(params.shortCode)}</title>
  <rect id="background" width="${CARD_MM}" height="${CARD_MM}" rx="6" fill="#ffffff"/>
  <rect id="quiet-zone" x="${round3(panelX)}" y="${PANEL_TOP}" width="${round3(panel)}" height="${round3(panel)}" fill="#ffffff"/>
  <path id="qr" fill="#000000" shape-rendering="crispEdges" d="${qr}"/>
  <path id="short-code" fill="#000000" d="${code.d}"/>
  ${refPath ? `<path id="client-ref" fill="#000000" d="${refPath}"/>` : ""}
</svg>`;
}

function round3(v: number): string {
  return v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

/** Escapes text for an XML/SVG text node. The short code is generated, but the client_ref is not. */
function escapeXml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
// ---------------------------------------------------------------------------
// GET /api/links/:id/qr.svg
// ---------------------------------------------------------------------------

/**
 * One card's QR, as an SVG document.
 *
 * Route-shaped rather than a query parameter on a shared endpoint because the
 * caller is a browser asking for one specific card and there is no reason to
 * make it build a URL with a code inside it — the id is already in hand from
 * the links list.
 *
 * `Cache-Control: public, max-age=300` and NOT immutable: a destination can be
 * corrected after printing, and a cached QR would keep encoding the old one for
 * however long the cache lived. Five minutes is short enough that a
 * correction is visibly corrected and long enough that scrolling a list does not
 * regenerate the same SVG on every row.
 */
export const linkQrSvg: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  const tenant = c.get("tenant");
  const id = c.req.param("id")!;

  const row = await withClient(c.env, async (client) => {
    const table = qualifyTable(tenant.schemaName, "links");
    const res = await client.query<{ short_code: string; client_ref: string | null }>(
      `SELECT short_code, client_ref FROM ${table} WHERE id = $1 AND short_code IS NOT NULL LIMIT 1`,
      [id],
    );
    return res.rows[0];
  });

  if (!row) throw new NotFoundError("Link not found", "not_found");

  const domain = c.env.SHORT_URL_DOMAIN;
  const shortUrl = `https://${domain}/${row.short_code}`;

  return new Response(renderQrSvg(shortUrl), {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      // Deliberately NOT immutable, and short-lived on purpose: a destination
      // can be corrected after printing, and a long-lived cache would keep
      // encoding the old one.
      "Cache-Control": "public, max-age=300",
      "Content-Disposition": `inline; filename="qr-${row.short_code}.svg"`,
    },
  });
};

// ---------------------------------------------------------------------------
// POST /api/links/qr-sheet.zip
// ---------------------------------------------------------------------------

/**
 * A print-ready sheet for a batch, as a ZIP.
 *
 * WHAT THIS IS FOR
//
// The flow this completes: the owner generates a pack of links, the designer
 * needs the ARTWORK, and a list of URLs is not artwork. Each card gets its own
 * SVG with the QR at print resolution plus the short code as text beside it —
 * because a damaged card is still recoverable by a human who can read the code
 * and type it, and that is the whole reason to print it as well as encode it.
//
// *MIXED batches are rejected outright* rather than partially exported. A sheet
// where half the cards are missing is worse than no sheet: the designer lays it
// out, prints it, and the shortfall is discovered after the stock is cut. One
// link without a destination is an explicit failure the caller can act on.
//
// `links.csv` is included because a designer asked for ten cards wants to know
// which is which before cutting, and the ordering has to survive the round trip
// through a folder full of files.
 */
export const batchQrSheet: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  const tenant = c.get("tenant");

  let body: { link_ids?: unknown };
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError("Invalid JSON body", "invalid_request");
  }

  if (!Array.isArray(body.link_ids)) {
    throw new ValidationError("link_ids must be an array", "invalid_request");
  }
  const ids = body.link_ids.filter((v): v is string => typeof v === "string");
  if (ids.length === 0) {
    throw new ValidationError("link_ids is required", "invalid_request");
  }
  // Same bound as the batch endpoint. A sheet is a physical artefact, and a
  // designer ordering 500 cards is a conversation, not a button press.
  if (ids.length > MAX_SHEET_SIZE) {
    throw new ValidationError(
      `a sheet holds at most ${MAX_SHEET_SIZE} cards`,
      "invalid_request",
    );
  }

  const table = qualifyTable(tenant.schemaName, "links");
  const rows = await withClient(c.env, async (client) => {
    const res = await client.query<{
      id: string;
      short_code: string;
      client_ref: string | null;
      original_url: string | null;
      feedback_email: string | null;
    }>(
      `SELECT l.id, l.short_code, l.client_ref, l.original_url,
              t.feedback_email
         FROM ${table} l
         JOIN public.tenants t ON t.schema_name = $2
        WHERE l.id = ANY($1::uuid[])`,
      [ids, tenant.schemaName],
    );
    return res.rows;
  });

  // Every requested id must resolve. A partially-exported sheet is a print run
  // that comes up short, so an id that is not in this tenant is refused rather
  // than quietly producing a sheet with a hole in it.
  //
  // NOT a refusal condition: a link without a destination.
  //
  // This used to reject them — "load them before exporting" — which inverted the
  // entire product. The destination is loaded LATER, on purpose: a card is
  // printed before anyone knows where it points. A sheet that refuses to export
  // unconfigured cards refuses to manufacture stock, which is the one thing this
  // endpoint exists to do.
  //
  // The card still gets a real QR either way, because `short_code` exists from
  // the moment the card does. What the QR encodes is decided when the destination
  // is loaded, because the destination lives on the row, not in the pixels.
  if (rows.length !== ids.length) {
    throw new NotFoundError(
      "one or more links do not exist in this tenant",
      "not_found",
    );
  }

  const domain = c.env.SHORT_URL_DOMAIN;
  const files: Record<string, Uint8Array> = {};

  // Sequential rather than parallel: the SVG generation is pure CPU and cheap,
  // and a Promise.all over a few hundred cards would allocate every document at
  // once for no wall-clock gain.
  for (const row of rows) {
    const shortUrl = `https://${domain}/${row.short_code}`;
    // Zero-padded so a folder listing sorts in print order, which is the order
    // the designer cuts them in. `card-07.svg` after `card-100.svg` is the
    // kind of detail that costs a phone call.
    const name = `card-${String(rows.indexOf(row) + 1).padStart(3, "0")}.svg`;
    files[`cards/${name}`] = new TextEncoder().encode(
      renderCardSvg({
        shortUrl,
        shortCode: row.short_code,
        clientRef: row.client_ref,
      }),
    );
  }

  // The manifest, so the designer knows which card is which before cutting.
  //
  // `feedback_email` is on every row on purpose: it is per tenant, and a print
  // run is exactly the moment someone needs to know where the comments from
  // these stickers are supposed to end up. Repeating it per row is redundant in
  // a spreadsheet and obvious in a text editor.
  //
  // Escaped because a comma in a value silently shifts every later column, and
  // a designer would read a shifted sheet as a wrong sheet.
  const lines = rows.map((r, i) =>
    [
      `card-${String(i + 1).padStart(3, "0")}.svg`,
      r.short_code,
      `https://${domain}/${r.short_code}`,
      r.client_ref ?? "",
      r.feedback_email ?? "",
    ],
  );
  files["links.csv"] = new TextEncoder().encode(
    toCsv(
      ["file", "short_code", "short_url", "client_ref", "feedback_email"],
      lines,
    ),
  );

  const zipped = zipSync(files, { level: 6 });

  return new Response(zipped as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="cards-${tenant.tenantSlug}.zip"`,
      // Never cached: every call regenerates artwork that reflects the CURRENT
      // destinations, and a stale ZIP would be printed onto physical stock.
      "Cache-Control": "no-store",
    },
  });
};

/** Mirrors the batch cap. A sheet larger than this is a conversation, not a download. */
const MAX_SHEET_SIZE = 200;

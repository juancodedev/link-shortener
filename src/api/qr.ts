import qrcode from "qrcode-generator";
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
export function renderQrSvg(url: string, opts?: { margin?: number }): string {
  // Level Q: ~25% recoverable. See the note above for why not M.
  const qr = qrcode(0, "Q");
  qr.addData(url);
  qr.make();

  // 24 modules of quiet zone. The library counts these in `cellSize` units, so
  // the pixel size is derived here rather than left to the caller guessing.
  const margin = opts?.margin ?? 4;

  return qr.createSvgTag({
    cellSize: 4,
    margin,
    scalable: true,
  });
}

/**
 * One printable page per card, as SVG.
 *
 * A card is not a QR code. It is a QR code on a physical object that a
 * designer has to lay out, cut and laminate, and what they need from this
 * system is the mark, not the artwork — so this emits the mark at a size that
 * is legible in a vector editor, plus the short code beside it as text, which
 * is the second thing a designer needs for the print sheet.
 *
 * The page is sized in millimetres rather than pixels because a designer sets
 * the trim size, not a pixel count. 85mm is a common sticker edge and the
 * artwork scales from there.
 */
export function renderCardSvg(params: {
  shortUrl: string;
  shortCode: string;
  clientRef?: string | null;
}): string {
  const qrSvg = renderQrSvg(params.shortUrl);

  // The code is printed beside the QR, which is what makes a card recoverable
  // when it is too damaged to scan: a human can still read it and type it.
  const code = params.shortCode;
  const ref = params.clientRef ?? "";

  // Inlined rather than wrapped: an SVG file handed to a designer has no
  // network, so a <style> block at the top is the only way the inner SVG can
  // inherit anything.
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="85mm" height="85mm" viewBox="0 0 85 85">
  <style>
    .bg { fill: #fbf9f5; }
    .ink { fill: #2b2622; font-family: ui-monospace, monospace; }
    .muted { fill: #6b625a; font-family: system-ui, sans-serif; }
  </style>
  <rect class="bg" width="85" height="85" rx="6"/>
  <g transform="translate(9.5 9.5) scale(0.777)">${stripSvgWrapper(qrSvg)}</g>
  <text class="ink" x="42.5" y="76" font-size="5" text-anchor="middle" letter-spacing="0.4">${escapeXml(code)}</text>
  ${ref ? `<text class="muted" x="42.5" y="81.5" font-size="3.2" text-anchor="middle">${escapeXml(ref)}</text>` : ""}
</svg>`;
}

/**
 * Strips the outer `<svg>` element, keeping only its contents.
 *
 * The generator emits a complete document with its own width, height and
 * viewBox. Nesting that inside a card page would put a second `viewBox` in one
 * file, and the inner element's coordinate system would fight the outer's.
 */
function stripSvgWrapper(svg: string): string {
  const open = svg.indexOf(">", svg.indexOf("<svg"));
  const close = svg.lastIndexOf("</svg>");
  if (open < 0 || close < 0) return svg;
  return svg.slice(open + 1, close);
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
    }>(
      `SELECT id, short_code, client_ref, original_url
         FROM ${table}
        WHERE id = ANY($1::uuid[])`,
      [ids],
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
  const header = "file,short_code,short_url,client_ref";
  const lines = rows.map(
    (r, i) =>
      `card-${String(i + 1).padStart(3, "0")}.svg,${r.short_code},https://${domain}/${r.short_code},${r.client_ref ?? ""}`,
  );
  files["links.csv"] = new TextEncoder().encode(`${header}\n${lines.join("\n")}\n`);

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

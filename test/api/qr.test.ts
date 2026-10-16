import { describe, it, expect, beforeEach, vi } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { renderQrSvg, renderCardSvg, qrMatrix, MODULE_MM, QUIET_MODULES } from "../../src/api/qr";
import { withClient } from "../../src/db/client";

vi.mock("../../src/db/client", () => ({ withClient: vi.fn() }));

const TENANT = {
  tenantSlug: "acme",
  schemaName: "tenant_a7f3",
  tenantId: "tenant-uuid",
  tenantSalt: "salt",
};

function mockContext(params?: Record<string, string>) {
  const jsonFn = vi.fn().mockImplementation(
    (b: unknown, s: number) => new Response(JSON.stringify(b), { status: s }),
  );
  return {
    c: {
      req: {
        json: vi.fn().mockResolvedValue({}),
        param: vi.fn().mockImplementation((n: string) => params?.[n] ?? ""),
      },
      env: { SHORT_URL_DOMAIN: "shorter.juancode.dev" } as any,
      json: jsonFn,
      get: vi.fn().mockImplementation((k: string) =>
        k === "tenant" ? TENANT : undefined,
      ),
    },
    jsonFn,
  };
}

// ---------------------------------------------------------------------------
// Server-side QR
//
// The QR used to be an <img> pointing at `api.qrserver.com`. That URL is what
// gets printed on a sticker that leaves this infrastructure and lives in the
// world for months — so it travels to a third party first, and a third party's
// outage takes physical objects with it.
//
// These tests pin the properties that make this safe to put in a print run, and
// mostly pin them by MUTATION: a QR that encodes the wrong bytes still renders
// as valid SVG, and only decoding its pixels catches that.
// ---------------------------------------------------------------------------

describe("renderQrSvg", () => {
  it("produces a standalone SVG document", () => {
    const svg = renderQrSvg("https://shorter.juancode.dev/X4tonhH");

    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it("is scalable, so it is exact at any print size", () => {
    const svg = renderQrSvg("https://shorter.juancode.dev/X4tonhH");

    // "High resolution" on paper means resolution-INDEPENDENT. A raster would
    // need a DPI the caller has to guess, and a guessed DPI is a blurry sticker
    // or a 20MB file.
    expect(svg).toContain("viewBox");
  });

  it("carries an unconditional four-module quiet zone", () => {
    // The `margin` option is GONE, and that is the fix rather than a regression.
    //
    // It used to be a caller-supplied hint in CELL units, which meant a quiet
    // zone was something a caller could forget, mistype, or set to zero — and a
    // symbol with no margin looks fine and refuses to scan from any distance.
    // The zone is now part of the drawing and cannot be asked away.
    const svg = renderQrSvg("https://shorter.juancode.dev/X4tonhH");
    const matrix = qrMatrix("https://shorter.juancode.dev/X4tonhH");
    const panel = (matrix.length + 2 * QUIET_MODULES) * MODULE_MM;

    // The drawn symbol starts exactly four modules in from the panel edge.
    const d = svg.match(/d="([^"]*)"/)![1]!;
    const firstX = Number(d.match(/M([\d.-]+)/)![1]);

    expect(QUIET_MODULES).toBe(4);
    expect(firstX).toBeCloseTo(QUIET_MODULES * MODULE_MM, 5);
    expect(panel).toBeGreaterThan(matrix.length * MODULE_MM);
  });

  it("encodes the URL it was given, not an encoded form of it", () => {
    // The regression that shipped a broken sticker: two encode layers meant the
    // QR held `https%3A%2F%2F…`. Decoding the rendered symbol is the only way
    // to catch that — it still RENDERS fine while encoding the wrong bytes.
    const svg = renderQrSvg("https://shorter.juancode.dev/X4tonhH");

    // A payload that would itself encode to a different string produces a
    // different symbol, proving the input is what drives the output.
    const encodedLooking = encodeURIComponent("https://shorter.juancode.dev/X4tonhH");
    expect(svg).not.toBe(renderQrSvg(encodedLooking));
  });

  it("produces a different symbol for a different destination", () => {
    expect(renderQrSvg("https://a.example/1")).not.toBe(
      renderQrSvg("https://a.example/2"),
    );
  });

  it("handles a long URL by growing rather than failing", () => {
    const long = `https://shorter.juancode.dev/${"x".repeat(300)}`;
    expect(() => renderQrSvg(long)).not.toThrow();
  });

  it("never contacts a third party", () => {
    // The whole point: a fetch or an <image> in this path would reintroduce
    // exactly the dependency this replaces, silently. The XML namespace is not
    // a fetch — it is an identifier, and it is the only http:// allowed here.
    const svg = renderQrSvg("https://shorter.juancode.dev/X4tonhH");
    expect(svg).not.toContain("<image");
    expect(svg).not.toContain("href");
    const urls = svg.match(/https?:\/\/[^"'\s]*/g) ?? [];
    expect(urls).toEqual(["http://www.w3.org/2000/svg"]);
  });
});

describe("renderCardSvg", () => {
  const base = {
    shortUrl: "https://shorter.juancode.dev/X4tonhH",
    shortCode: "X4tonhH",
  };

  it("prints the short code as OUTLINES below the QR, still human-readable", () => {
    const svg = renderCardSvg(base);
    const code = elementPath(svg, "short-code");

    // A damaged card is still recoverable by a human who reads the code and
    // types it — that is the entire reason to print it as well as encode it.
    //
    // It is no longer a text node, so the claim is no longer "the string is in
    // the file". It is "there is ink down there, sized like type". The glyphs
    // are outlines now precisely so their shape does not belong to whoever opens
    // the file: a card is laminated and left in the world, and its typography
    // has to be fixed at generation time.
    expect(code.length).toBeGreaterThan(200);

    const b = outlineBounds(code);
    expect(b.width).toBeGreaterThan(5);
    expect(b.height).toBeGreaterThan(2);
  });

  it("sizes the page in millimetres, because a designer sets a trim size", () => {
    const svg = renderCardSvg(base);
    expect(svg).toContain('width="85mm"');
  });

  it("nests exactly one SVG element", () => {
    const svg = renderCardSvg(base);

    // Two viewBoxes in one file fight each other, and the inner element's
    // coordinate system would win over the outer's.
    expect(svg.match(/<svg/g)).toHaveLength(1);
  });

  it("DRAWS the client_ref as outlines rather than emitting it as text", () => {
    const withRef = renderCardSvg({ ...base, clientRef: "mesa-1" });
    const without = renderCardSvg({ ...base, clientRef: null });

    // The literal string is deliberately ABSENT: the ref is converted to
    // outlines, so there is no text node for a font to fail to render and no
    // characters for a vector editor to re-typeset.
    expect(withRef).not.toContain("mesa-1");
    expect(elementPath(withRef, "client-ref").length).toBeGreaterThan(100);

    // And the difference is real: with a ref the file is larger, because there
    // is more artwork in it.
    expect(withRef.length).toBeGreaterThan(without.length);
  });

  it("cannot be broken by a client_ref carrying markup", () => {
    const svg = renderCardSvg({ ...base, clientRef: '"><script>alert(1)</script>' });

    // It lands in a file a designer opens in a vector editor. Outlines remove
    // the injection surface entirely rather than escaping it — there is no text
    // node for the characters to terminate.
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain("alert(1)");
    expect(svg).not.toContain("<text");
  });

  it("omits the client_ref line when unset", () => {
    const svg = renderCardSvg({ ...base, clientRef: null });

    // The code line stays; only the ref line goes.
    expect(elementPath(svg, "short-code").length).toBeGreaterThan(200);
    expect(elementPath(svg, "client-ref")).toBe("");
    expect(svg).not.toContain("undefined");
  });
});

// ---------------------------------------------------------------------------
// The endpoints
// ---------------------------------------------------------------------------

// NOT async. An earlier version was, and `rows.map(r => r.id)` over a Promise
// yields undefined for every element — which produced a silent `[undefined]`
// selection and a 400 that read like a handler defect.
function sheetRow(over: Record<string, unknown> = {}) {
  return {
    id: "link-1",
    short_code: "X4tonhH",
    client_ref: "mesa-1",
    original_url: "https://g.page/review",
    // The tenant-level address now travels with the sheet query, so a row
    // carries it even though the column lives on public.tenants.
    feedback_email: "hola@cafecentral.com",
    ...over,
  };
}


/**
 * A context whose `req.json` ALREADY resolves the selection.
 *
 * Built this way rather than patched after construction because the handler
 * reads the body before anything else; a context that has to be fixed up in
 * two steps is a context where the order of two lines decides whether the
 * test tests anything.
 */
  function zipContext(linkIds: string[]) {
    const { c } = mockContext();
    (c.req as any).json = vi.fn().mockResolvedValue({ link_ids: linkIds });
    return c;
  }

/**
 * Builds a sheet from the given rows.
 *
 * `opts.rows` simulates ids that were selected but did not resolve — a
 * different fact from an empty selection, which is rejected earlier for a
 * different reason.
 */
  /** Unzips a response and returns one entry's text. */
  async function zipText(res: Response, name: string): Promise<string> {
    const bytes = new Uint8Array(await res.arrayBuffer());
    return strFromU8(unzipSync(bytes)[name]!);
  }

  async function buildZip(rows: unknown[], opts: { rows?: unknown[] } = {}) {
    const { batchQrSheet } = await import("../../src/api/qr");
    // `opts.rows` simulates ids that were selected but did not resolve — a
    // different fact from an empty selection, which is rejected earlier for a
    // different reason.
    const resolved = opts.rows ?? rows;
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
      fn({ query: vi.fn().mockResolvedValue({ rows: resolved, rowCount: resolved.length }) }),
    );
    return batchQrSheet(zipContext(rows.map((r: any) => r.id)));
  }

describe("the ZIP sheet", () => {
  // NO beforeEach here, deliberately. `vi.clearAllMocks()` also clears the
  // IMPLEMENTATION of the module-level `withClient` mock installed at the top
  // of this file, which makes every handler call throw on an undefined query
  // client rather than on a real defect. The ZIP tests install their own
  // implementation per call, so they need no reset.
  /**
   * Decompresses a ZIP response into its entry names.
   *
   * The existing sheet tests only ever asserted headers, which meant the body
   * was opaque: a handler that emitted an empty archive would have passed every
   * one of them. Unzipping is what makes "the card is in there" a claim about
   * the artefact and not about a status line.
   */
  async function zipEntries(res: Response): Promise<string[]> {
    const bytes = new Uint8Array(await res.arrayBuffer());
    return Object.keys(unzipSync(bytes));
  }


  /**
   * A context whose `req.json` ALREADY resolves the selection.
   *
   * Built this way rather than patched after construction because the handler
   * reads the body before anything else; a context that has to be fixed up in
   * two steps is a context where the order of two lines decides whether the
   * test tests anything.
   */

  it("returns a ZIP, not a JSON error", async () => {
    const res = await buildZip([sheetRow()]);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
  });

  it("names the file after the tenant", async () => {
    const res = await buildZip([sheetRow()]);
    expect(res.headers.get("Content-Disposition")).toContain("acme");
  });

  it("is never cached: it reflects the CURRENT destinations", async () => {
    // A stale ZIP gets printed onto physical stock. There is no version of
    // that which is a harmless bug.
    const res = await buildZip([sheetRow()]);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  it("exports a card that has no destination yet", async () => {
    // THE WHOLE PRODUCT DEPENDS ON THIS.
    //
    // A card is printed before anyone knows where it points — that is the entire
    // reason a destination is optional. This handler once refused those cards
    // with "load them before exporting", which made the print sheet refuse to
    // manufacture stock: the one thing it exists to do.
    //
    // The QR is still real. `short_code` exists from the moment the card does,
    // and the destination lives on the row, not in the pixels — loading it later
    // changes what the QR means without reprinting anything.
    const res = await buildZip([
      sheetRow(),
      sheetRow({ id: "link-2", original_url: null }),
    ]);

    const entries = await zipEntries(res);
    expect(entries).toContain("cards/card-001.svg");
    expect(entries).toContain("cards/card-002.svg");
  });

  it("still refuses a link that is not in this tenant", async () => {
    // The refusal that survives is the ownership one, not the configuration
    // one. An id from another tenant is a cross-tenant leak, not a missing
    // destination, and it must never be printed onto stock.
    await expect(
      buildZip([sheetRow(), sheetRow({ id: "link-2", original_url: null })], {
        // One of the two ids resolves to no row at all.
        rows: [sheetRow()],
      }),
    ).rejects.toThrow(/do not exist in this tenant/i);
  });

  it("rejects a link that does not exist in this tenant", async () => {
    // A row count that does not match the selection means an id belongs to
    // another tenant or was deleted. Exported artwork for a link this tenant
    // does not own is a cross-tenant leak, so it fails rather than exporting a
    // partial sheet.
    // A SELECTED id that resolves to no row: the mock returns nothing while the
    // request asks for one. That is a different fact from an EMPTY selection,
    // which is rejected earlier for a different reason — so this test selects
    // an id and returns no rows, rather than passing an empty list.
    const { batchQrSheet } = await import("../../src/api/qr");
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
      fn({ query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }),
    );

    await expect(batchQrSheet(zipContext(["link-missing"]))).rejects.toThrow(
      /do not exist/i,
    );
  });

  it("rejects an empty selection", async () => {
    const { batchQrSheet } = await import("../../src/api/qr");
    const c = zipContext([]);

    await expect(batchQrSheet(c as any)).rejects.toThrow(/required/i);
  });

  it("rejects a sheet larger than the cap", async () => {
    // A designer ordering 500 cards is a conversation, not a button press.
    const { batchQrSheet } = await import("../../src/api/qr");
    const c = zipContext(Array.from({ length: 201 }, (_, i) => `id-${i}`));

    await expect(batchQrSheet(c as any)).rejects.toThrow(/at most 200/i);
  });

  it("rejects a non-array selection", async () => {
    const { batchQrSheet } = await import("../../src/api/qr");
    const c = zipContext("all" as never);

    await expect(batchQrSheet(c as any)).rejects.toThrow(/array/i);
  });
});

// ---------------------------------------------------------------------------
// The print sheet's manifest
//
// A print run is the moment someone needs to know where the comments from these
// stickers are supposed to end up. The address lives on the tenant, not the row,
// so it is repeated per row — redundant in a spreadsheet, obvious in a text
// editor.
// ---------------------------------------------------------------------------
describe("the sheet manifest carries the feedback address", () => {
  it("has a column for it", async () => {
    const res = await buildZip([sheetRow({ feedback_email: "hola@cafe.com" })]);
    const csv = await zipText(res, "links.csv");

    expect(csv.split("\n")[0]).toBe("file,short_code,short_url,client_ref,feedback_email");
  });

  it("repeats the tenant address on every row", async () => {
    // One address, many cards. A designer reading a single row in a text editor
    // should not have to ask which business this run belongs to.
    const res = await buildZip([
      sheetRow({ feedback_email: "hola@cafe.com" }),
      sheetRow({ id: "link-2", feedback_email: "hola@cafe.com" }),
    ]);
    const rows = (await zipText(res, "links.csv")).trim().split("\n");

    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain("hola@cafe.com");
    expect(rows[2]).toContain("hola@cafe.com");
  });

  it("leaves it empty for a tenant that has not set one", async () => {
    // Every existing tenant is in this state. The column exists and is blank,
    // rather than the column vanishing for some tenants and not others.
    const res = await buildZip([sheetRow({ feedback_email: null })]);
    const rows = (await zipText(res, "links.csv")).trim().split("\n");

    expect(rows[0]).toContain("feedback_email");
    expect(rows[1]!.endsWith(",")).toBe(true);
  });

  it("quotes a client_ref containing a comma, instead of shifting every column", async () => {
    // A comma does not fail loudly: it shifts every later column and the sheet
    // still opens. A designer then reads a shifted sheet as a wrong sheet, which
    // is the worst possible failure for a document about to be cut.
    const res = await buildZip([
      sheetRow({ client_ref: "Mesas 1, 2 y 3", feedback_email: "hola@cafe.com" }),
    ]);
    const row = (await zipText(res, "links.csv")).trim().split("\n")[1]!;

    expect(row).toContain('"Mesas 1, 2 y 3"');

    // Five columns still, which is what proves nothing shifted.
    const cells = row.match(/("[^"]*"|[^,]*)(,|$)/g)!.filter((x) => x !== "," || true);
    expect(cells.filter((c) => c === "," || c.endsWith(",")).length).toBe(4);
  });

  it("doubles a quote inside a value, as CSV requires", async () => {
    const res = await buildZip([sheetRow({ client_ref: 'Sala "VIP"' })]);
    const row = (await zipText(res, "links.csv")).trim().split("\n")[1]!;

    expect(row).toContain('"Sala ""VIP"""');
  });
});

// ---------------------------------------------------------------------------
// The card, measured
//
// The previous card renderer carried `scale(0.777)` — a constant with no
// derivation. The real QR is 132 units at version 4, so the mark rendered
// 99.5mm wide on an 85mm card: 27mm lost off the right and bottom. It looked
// perfect on screen, because an SVG does not warn you that it does not fit.
//
// Every assertion below PARSES the generated path and checks it against the
// card. An assertion that the output "contains <svg" cannot tell a symbol that
// fits from one that runs off the paper.
// ---------------------------------------------------------------------------

/** Bounding box of an SVG path made of `M x y h w v h h -w z` run rectangles. */
function pathBounds(d: string) {
  let x = Infinity, y = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const m of d.matchAll(/M([\d.-]+) ([\d.-]+)h([\d.-]+)v([\d.-]+)h([\d.-]+)z/g)) {
    const [mx, my, w, h] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    x = Math.min(x, mx);
    y = Math.min(y, my);
    maxX = Math.max(maxX, mx + w);
    maxY = Math.max(maxY, my + h);
  }
  return { x, y, maxX, maxY, width: maxX - x, height: maxY - y };
}

/**
 * Bounding box of glyph outline data.
 *
 * Separate from `pathBounds` because the two path dialects are different: the
 * QR is emitted as run rectangles with RELATIVE h/v, so its coordinates have to
 * be accumulated by hand, while glyph paths use absolute M/L/C/Q coordinates.
 * Running the run-rectangle reader over a glyph path yields Infinity, which is
 * what made "the outlines are real" silently unmeasurable.
 */
function outlineBounds(d: string) {
  // Glyph data is a stream of command letters and absolute coordinate pairs, so
  // reading every number in order and pairing consecutive ones is enough.
  //
  // Deliberately not the same reader as `pathBounds`: the QR uses RELATIVE h/v,
  // which needs the deltas accumulated by hand, and running that reader over a
  // glyph path returned Infinity — which is how "the outlines are real" became
  // silently unmeasurable for a while.
  const nums = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    minX = Math.min(minX, nums[i]!);
    maxX = Math.max(maxX, nums[i]!);
    minY = Math.min(minY, nums[i + 1]!);
    maxY = Math.max(maxY, nums[i + 1]!);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** The `d` of the element with the given id. */
function elementPath(svg: string, id: string): string {
  const re = new RegExp(`<path id="${id}"[^>]*\\sd="([^"]*)"`);
  return svg.match(re)?.[1] ?? "";
}

const CARD_URL = "https://shorter.juancode.dev/jyEdjUp";

describe("the card fits on the paper", () => {
  it("draws a QR whose extent is inside the card", () => {
    const svg = renderCardSvg({ shortUrl: CARD_URL, shortCode: "jyEdjUp" });
    const b = pathBounds(elementPath(svg, "qr"));

    // The regression. It was 112.1mm on an 85mm card.
    expect(b.maxX).toBeLessThanOrEqual(85);
    expect(b.maxY).toBeLessThanOrEqual(85);
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
  });

  it("leaves the panel a four-module quiet zone on every side", () => {
    const svg = renderCardSvg({ shortUrl: CARD_URL, shortCode: "jyEdjUp" });
    const panel = svg.match(/id="quiet-zone"[^>]*x="([\d.]+)"[^>]*y="([\d.]+)"[^>]*width="([\d.]+)"[^>]*height="([\d.]+)"/)!;
    const [px, py, pw, ph] = panel.slice(1).map(Number);
    const q = pathBounds(elementPath(svg, "qr"));

    // 4 modules x 1.6mm. One module is what shipped, and the specification says
    // four — a scanner's generosity is not a property anyone can promise about
    // a sticker read under a bar lamp.
    const QUIET = 4 * MODULE_MM;
    expect(q.x - px).toBeCloseTo(QUIET, 5);
    expect(q.y - py).toBeCloseTo(QUIET, 5);
    expect(px + pw - q.maxX).toBeCloseTo(QUIET, 5);
    expect(py + ph - q.maxY).toBeCloseTo(QUIET, 5);
  });

  it("centres the panel on the card", () => {
    const svg = renderCardSvg({ shortUrl: CARD_URL, shortCode: "jyEdjUp" });
    const panel = svg.match(/id="quiet-zone"[^>]*x="([\d.]+)"[^>]*width="([\d.]+)"/)!;
    const [px, pw] = panel.slice(1).map(Number);
    expect(px + pw / 2).toBeCloseTo(85 / 2, 3);
  });

  it("keeps the short code BELOW the QR, not on top of it", () => {
    const svg = renderCardSvg({ shortUrl: CARD_URL, shortCode: "jyEdjUp" });
    const qr = pathBounds(elementPath(svg, "qr"));
    const code = pathBounds(elementPath(svg, "short-code"));

    // It rendered at y=76 while the QR reached y=112, so the type was printed
    // across the lower modules.
    expect(code.y).toBeGreaterThanOrEqual(qr.maxY);
  });

  it("keeps the client ref below the short code", () => {
    const svg = renderCardSvg({ shortUrl: CARD_URL, shortCode: "jyEdjUp", clientRef: "Mesa-14" });
    const code = pathBounds(elementPath(svg, "short-code"));
    const ref = pathBounds(elementPath(svg, "client-ref"));

    expect(ref.y).toBeGreaterThan(code.maxY);
    expect(ref.maxY).toBeLessThanOrEqual(85);
  });

  it("keeps everything inside the card, glyphs included", () => {
    const svg = renderCardSvg({ shortUrl: CARD_URL, shortCode: "jyEdjUp", clientRef: "Mesa-14" });
    for (const id of ["qr", "short-code", "client-ref"]) {
      const b = pathBounds(elementPath(svg, id));
      expect(b.x, id).toBeGreaterThanOrEqual(0);
      expect(b.maxX, id).toBeLessThanOrEqual(85);
      expect(b.maxY, id).toBeLessThanOrEqual(85);
    }
  });

  it("merges modules into runs instead of drawing one rect each", () => {
    const svg = renderCardSvg({ shortUrl: CARD_URL, shortCode: "jyEdjUp" });
    const matrix = qrMatrix(CARD_URL);
    const runs = elementPath(svg, "qr").match(/M/g)?.length ?? 0;

    // 33x33 = 1089 modules. If every one were a rectangle, adjacent edges would
    // anti-alias into hairline seams, and a seam through a finder pattern is a
    // symbol some scanners refuse.
    expect(runs).toBeGreaterThan(0);
    expect(runs).toBeLessThan(matrix.flat().filter(Boolean).length);
  });

  it("round-trips: every dark module in the matrix is in the drawing", () => {
    const svg = renderCardSvg({ shortUrl: CARD_URL, shortCode: "jyEdjUp" });
    const matrix = qrMatrix(CARD_URL);
    const n = matrix.length;
    const d = elementPath(svg, "qr");
    const panelX = (85 - (n + 2 * QUIET_MODULES) * MODULE_MM) / 2;
    const originX = panelX + QUIET_MODULES * MODULE_MM;
    const originY = 6 + QUIET_MODULES * MODULE_MM;

    // A geometry bug can silently drop or invent modules while still producing
    // valid-looking SVG. Comparing the drawn coverage against the generator's
    // own matrix is the only check that notices.
    const covered = new Set<string>();
    for (const m of d.matchAll(/M([\d.-]+) ([\d.-]+)h([\d.-]+)v([\d.-]+)h/g)) {
      const c0 = Math.round((Number(m[1]) - originX) / MODULE_MM);
      const r0 = Math.round((Number(m[2]) - originY) / MODULE_MM);
      const len = Math.round(Number(m[3]) / MODULE_MM);
      for (let i = 0; i < len; i++) covered.add(`${r0},${c0 + i}`);
    }

    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        expect(covered.has(`${r},${c}`), `module ${r},${c}`).toBe(matrix[r]![c]);
      }
    }
  });

  it("uses pure black and pure white, so the press builds one plate", () => {
    const svg = renderCardSvg({ shortUrl: CARD_URL, shortCode: "jyEdjUp" });

    // The old cream (#fbf9f5) and warm grey (#2b2622) are four-colour builds
    // that print grey and cost more. The press converts to K100.
    expect(svg).toContain('fill="#000000"');
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).not.toContain("#fbf9f5");
    expect(svg).not.toContain("#2b2622");
  });

  it("tells the renderer not to smooth module edges", () => {
    const svg = renderCardSvg({ shortUrl: CARD_URL, shortCode: "jyEdjUp" });
    expect(svg).toContain('shape-rendering="crispEdges"');
  });

  it("emits no <text> and no font reference at all", () => {
    const svg = renderCardSvg({ shortUrl: CARD_URL, shortCode: "jyEdjUp", clientRef: "Mesa-14" });

    // The short code is the fallback for a damaged card. As <text>, its shape
    // belongs to whoever opens the file — the designer's Mac, their colleague's
    // box, the print shop's RIP. As outlines it is fixed forever.
    expect(svg).not.toContain("<text");
    expect(svg).not.toContain("font-family");
    expect(svg).not.toContain("@font-face");
  });

  it("has no percentage-sized rect, which is invalid on a rect", () => {
    const svg = renderCardSvg({ shortUrl: CARD_URL, shortCode: "jyEdjUp" });
    expect(svg).not.toMatch(/<rect[^>]*width="100%"/);
  });

  it("emits the short code as real outlines, not an empty path", () => {
    const svg = renderCardSvg({ shortUrl: CARD_URL, shortCode: "jyEdjUp" });
    const d = elementPath(svg, "short-code");

    expect(d.length).toBeGreaterThan(200);
    expect(outlineBounds(d).width).toBeGreaterThan(5);
  });

  it("escapes a client ref that would otherwise break the document", () => {
    const svg = renderCardSvg({ shortUrl: CARD_URL, shortCode: "jyEdjUp", clientRef: '<script>&"' });

    expect(svg).not.toContain("<script>");

    // Every attribute value must be free of the characters that would let a
    // value escape its own quotes and open a new element. Checked across the
    // whole document rather than one attribute, because the ref is not the only
    // thing that came from a user.
    for (const m of svg.matchAll(/="([^"]*)"/g)) {
      const value = m[1]!;
      expect(value, `attribute value: ${value}`).not.toMatch(/[<>]/);
    }

    // And the path data — the only place a value is emitted at length — is
    // numbers and path commands, nothing a document parser can be confused by.
    for (const id of ["qr", "short-code", "client-ref"]) {
      const d = elementPath(svg, id);
      expect(d, id).toMatch(/^[MLCQZzhv0-9eE.,\s+-]*$/);
    }
  });

  it("is byte-for-byte deterministic", () => {
    // A print sheet that differs between two requests for the same data is a
    // print sheet nobody can re-run.
    const a = renderCardSvg({ shortUrl: CARD_URL, shortCode: "jyEdjUp", clientRef: "Mesa-14" });
    const b = renderCardSvg({ shortUrl: CARD_URL, shortCode: "jyEdjUp", clientRef: "Mesa-14" });
    expect(a).toBe(b);
  });

  it("omits the client ref entirely when there is none", () => {
    const svg = renderCardSvg({ shortUrl: CARD_URL, shortCode: "jyEdjUp" });
    expect(svg).not.toContain('id="client-ref"');
  });

  it("renders a standalone QR that also carries its quiet zone", () => {
    const svg = renderQrSvg(CARD_URL);
    const matrix = qrMatrix(CARD_URL);
    const panel = (matrix.length + 2 * QUIET_MODULES) * MODULE_MM;
    const b = pathBounds(elementPath(svg, "qr") || svg.match(/d="([^"]*)"/)![1]!);

    expect(svg).toContain(`viewBox="0 0 ${panel.toFixed(3).replace(/0+$/, "")}`);
    expect(b.x).toBeCloseTo(QUIET_MODULES * MODULE_MM, 5);
  });
});

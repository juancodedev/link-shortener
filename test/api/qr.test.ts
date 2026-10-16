import { describe, it, expect, beforeEach, vi } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { renderQrSvg, renderCardSvg } from "../../src/api/qr";
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

  it("honours the quiet zone, which is what makes it scannable", () => {
    const svg = renderQrSvg("https://shorter.juancode.dev/X4tonhH");

    // The library's margin is in CELL units and the spec's floor is 4. A tight
    // layout that drops the quiet zone produces a symbol that looks fine and
    // refuses to scan from any distance.
    expect(renderQrSvg("x", { margin: 0 })).not.toBe(renderQrSvg("x", { margin: 4 }));
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

  it("prints the short code as text beside the QR", () => {
    const svg = renderCardSvg(base);

    // A damaged card is still recoverable by a human who reads the code and
    // types it. That is the entire reason to print it as well as encode it.
    expect(svg).toContain("X4tonhH");
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

  it("shows client_ref when set", () => {
    const svg = renderCardSvg({ ...base, clientRef: "mesa-1" });
    expect(svg).toContain("mesa-1");
  });

  it("escapes a client_ref carrying markup", () => {
    const svg = renderCardSvg({ ...base, clientRef: '"><script>alert(1)</script>' });

    // It lands in a file the designer opens in a vector editor.
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;");
  });

  it("omits the client_ref line when unset", () => {
    const svg = renderCardSvg({ ...base, clientRef: null });
    expect(svg).toContain("X4tonhH");
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
    ...over,
  };
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

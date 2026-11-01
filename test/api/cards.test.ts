import { describe, it, expect, vi, beforeEach } from "vitest";

// GET /api/links/:id/card.svg (odd/tasks/print-queue-cards.md S4)

vi.mock("../../src/db/client", () => ({
  withClient: vi.fn(),
}));

import { withClient } from "../../src/db/client";
import { linkCardSvg } from "../../src/api/cards";
import { renderReviewCard } from "../../src/cards/render";
import { NotFoundError, ValidationError } from "../../src/middleware/error";

function mockContext(query: Record<string, string>) {
  return {
    req: {
      param: vi.fn().mockReturnValue("link-uuid"),
      query: vi.fn().mockImplementation((k: string) => query[k]),
    },
    env: { SHORT_URL_DOMAIN: "masresenas.cl" },
    get: vi.fn().mockReturnValue({ tenantSlug: "acme", schemaName: "tenant_a7f3", tenantId: "t" }),
  };
}

function mockDb(rows: unknown[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
    fn({
      query: vi.fn().mockImplementation(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { rows, rowCount: rows.length };
      }),
    }),
  );
  return calls;
}

describe("GET /api/links/:id/card.svg", () => {
  beforeEach(() => vi.resetAllMocks());

  it("renders the chosen design and variant for the link's short URL", async () => {
    const calls = mockDb([{ short_code: "Kp2mZrQ" }]);

    const res = (await linkCardSvg(mockContext({ design: "minimal", variant: "hybrid" }) as any, vi.fn())) as Response;

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml; charset=utf-8");
    expect(await res.text()).toBe(
      renderReviewCard({ shortUrl: "https://masresenas.cl/Kp2mZrQ", design: "minimal", variant: "hybrid" }),
    );
    expect(calls[0]!.sql).toContain('"tenant_a7f3"."links"');
    expect(calls[0]!.params).toEqual(["link-uuid"]);
  });

  it("defaults to the official design with QR + NFC", async () => {
    mockDb([{ short_code: "Kp2mZrQ" }]);

    const res = (await linkCardSvg(mockContext({}) as any, vi.fn())) as Response;

    expect(await res.text()).toBe(
      renderReviewCard({ shortUrl: "https://masresenas.cl/Kp2mZrQ", design: "official", variant: "hybrid" }),
    );
  });

  it.each([
    [{ design: "fancy" }],
    [{ variant: "barcode" }],
  ])("rejects an unknown option %o before touching the database", async (query) => {
    await expect(linkCardSvg(mockContext(query) as any, vi.fn())).rejects.toThrow(ValidationError);
    expect(withClient).not.toHaveBeenCalled();
  });

  it("answers 404 for a link that does not exist", async () => {
    mockDb([]);

    await expect(linkCardSvg(mockContext({}) as any, vi.fn())).rejects.toThrow(NotFoundError);
  });
});

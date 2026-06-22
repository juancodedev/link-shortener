import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock db/client
// ---------------------------------------------------------------------------

vi.mock("../../src/db/client", () => ({
  withClient: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock cache modules
// ---------------------------------------------------------------------------

vi.mock("../../src/cache/shortcode", () => ({
  setCachedUrl: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mock short-code generator
// ---------------------------------------------------------------------------

vi.mock("../../src/utils/short-code", () => ({
  generateShortCode: vi.fn(),
}));

import { withClient } from "../../src/db/client";
import { setCachedUrl } from "../../src/cache/shortcode";
import { generateShortCode } from "../../src/utils/short-code";
import { createLink } from "../../src/api/links";

// ---------------------------------------------------------------------------
// Helper: mock Hono context
// ---------------------------------------------------------------------------

function mockContext(overrides: {
  tenant?: { tenantSlug: string; schemaName: string; tenantId: string };
  body?: object;
  jsonParseError?: boolean;
} = {}) {
  const waitUntilFn = vi.fn();
  const jsonFn = vi.fn().mockImplementation(
    (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
  );
  const redirectFn = vi.fn().mockImplementation(
    (url: string, status: number) =>
      new Response(null, { status, headers: { Location: url } }),
  );

  const c = {
    req: {
      json: overrides.jsonParseError
        ? vi.fn().mockRejectedValue(new Error("Invalid JSON"))
        : vi.fn().mockResolvedValue(overrides.body ?? {}),
    },
    env: {
      SHORT_URL_DOMAIN: "short.link",
      SUPABASE_JWT_SECRET: "test-secret",
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_ANON_KEY: "test-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
      SHORT_URL_CACHE: {} as any,
    },
    json: jsonFn,
    redirect: redirectFn,
    get: vi.fn().mockImplementation((key: string) => {
      if (key === "tenant") return overrides.tenant ?? {
        tenantSlug: "acme",
        schemaName: "tenant_a7f3",
        tenantId: "tenant-uuid",
      };
      return undefined;
    }),
    executionCtx: {
      waitUntil: waitUntilFn,
    },
  };

  return { c, jsonFn, redirectFn, waitUntilFn };
}

// ---------------------------------------------------------------------------
// Helper: mock a DB client for withClient
// ---------------------------------------------------------------------------

function mockDbClient(queryResult: any) {
  return vi.mocked(withClient).mockImplementationOnce(async (_env: any, fn: any) => {
    return fn({
      query: vi.fn().mockResolvedValueOnce(queryResult),
    });
  });
}

// ---------------------------------------------------------------------------
// Links API tests (REQ-L001, REQ-L002, REQ-S002)
// ---------------------------------------------------------------------------

describe("createLink handler", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(generateShortCode).mockReturnValue("abc1234");
    vi.mocked(setCachedUrl).mockResolvedValue(undefined);
  });

  it("returns 201 with the created link resource (happy path)", async () => {
    let callCount = 0;
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) => {
      callCount++;
      if (callCount === 1) {
        // COUNT query: 5 active links
        return fn({
          query: vi.fn().mockResolvedValueOnce({ rows: [{ count: "5" }], rowCount: 1 }),
        });
      }
      // INSERT query: success
      return fn({
        query: vi.fn().mockResolvedValueOnce({
          rows: [
            {
              id: "link-uuid",
              short_code: "abc1234",
              original_url: "https://example.com",
              title: null,
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
          rowCount: 1,
        }),
      });
    });

    const { c, jsonFn, waitUntilFn } = mockContext({
      body: { original_url: "https://example.com" },
    });

    await createLink(c as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "link-uuid",
        short_code: "abc1234",
        original_url: "https://example.com",
        short_url: "https://short.link/r/acme/abc1234",
        title: null,
        expires_at: null,
      }),
      201,
    );
    // KV cache warm via waitUntil
    expect(waitUntilFn).toHaveBeenCalled();
    expect(setCachedUrl).toHaveBeenCalled();
  });

  it("returns 400 for invalid URL", async () => {
    // validateUrl runs before withClient, so DB is never reached

    const { c } = mockContext({
      body: { original_url: "not-a-url" },
    });

    // The handler throws ValidationError (before using withClient)
    await expect(createLink(c as any)).rejects.toThrow();
    expect(withClient).not.toHaveBeenCalled();
  });

  it("returns 429 when at 30 active links limit", async () => {
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) => {
      return fn({
        query: vi.fn().mockResolvedValueOnce({ rows: [{ count: "30" }], rowCount: 1 }),
      });
    });

    const { c } = mockContext({
      body: { original_url: "https://example.com" },
    });

    await expect(createLink(c as any)).rejects.toThrow("limit");
  });

  it("retries on short code collision and succeeds on 2nd attempt", async () => {
    let callCount = 0;

    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) => {
      callCount++;
      if (callCount === 1) {
        // COUNT query: 10 active links
        return fn({
          query: vi.fn().mockResolvedValueOnce({ rows: [{ count: "10" }], rowCount: 1 }),
        });
      }
      if (callCount === 2) {
        // First INSERT: collision (rowCount 0)
        return fn({
          query: vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 }),
        });
      }
      // callCount === 3: Second INSERT: success
      return fn({
        query: vi.fn().mockResolvedValueOnce({
          rows: [
            {
              id: "link-uuid",
              short_code: "xyz5678",
              original_url: "https://example.com",
              title: null,
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
          rowCount: 1,
        }),
      });
    });

    // First short code: collision, second: success
    vi.mocked(generateShortCode)
      .mockReturnValueOnce("abc1234")
      .mockReturnValueOnce("xyz5678");

    const { c, jsonFn } = mockContext({
      body: { original_url: "https://example.com" },
    });

    await createLink(c as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({ short_code: "xyz5678" }),
      201,
    );
    expect(callCount).toBe(3);
  });

  it("returns 500 after 3 exhausted retries", async () => {
    let callCount = 0;

    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) => {
      callCount++;
      if (callCount === 1) {
        // COUNT query
        return fn({
          query: vi.fn().mockResolvedValueOnce({ rows: [{ count: "10" }], rowCount: 1 }),
        });
      }
      // All 3 INSERT attempts: collision (rowCount 0)
      return fn({
        query: vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 }),
      });
    });

    const { c } = mockContext({
      body: { original_url: "https://example.com" },
    });

    await expect(createLink(c as any)).rejects.toThrow("link_creation_failed");
    expect(callCount).toBe(4); // COUNT + 3 inserts
  });

  it("accepts optional title and expires_at", async () => {
    let callCount = 0;
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) => {
      callCount++;
      if (callCount === 1) {
        return fn({
          query: vi.fn().mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 }),
        });
      }
      return fn({
        query: vi.fn().mockResolvedValueOnce({
          rows: [
            {
              id: "link-uuid",
              short_code: "abc1234",
              original_url: "https://example.com",
              title: "My Link",
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
          rowCount: 1,
        }),
      });
    });

    const { c, jsonFn } = mockContext({
      body: {
        original_url: "https://example.com",
        title: "My Link",
        expires_at: "2026-12-31T23:59:59Z",
      },
    });

    await createLink(c as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "My Link",
        expires_at: "2026-12-31T23:59:59Z",
      }),
      201,
    );
  });

  it("counts only active links (inactive excluded)", async () => {
    let callCount = 0;
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) => {
      callCount++;
      if (callCount === 1) {
        // COUNT query: 29 active links (under limit)
        return fn({
          query: vi.fn().mockResolvedValueOnce({ rows: [{ count: "29" }], rowCount: 1 }),
        });
      }
      return fn({
        query: vi.fn().mockResolvedValueOnce({
          rows: [
            {
              id: "link-uuid",
              short_code: "abc1234",
              original_url: "https://example.com",
              title: null,
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
          rowCount: 1,
        }),
      });
    });

    const { c, jsonFn } = mockContext({
      body: { original_url: "https://example.com" },
    });

    await createLink(c as any);

    expect(jsonFn).toHaveBeenCalledWith(expect.any(Object), 201);
  });
});

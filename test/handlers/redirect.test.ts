import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock db/client
// ---------------------------------------------------------------------------

vi.mock("../../src/db/client", () => ({
  withClient: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock cache/shortcode
// ---------------------------------------------------------------------------

vi.mock("../../src/cache/shortcode", () => ({
  getCachedUrl: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock cache/tenant
// ---------------------------------------------------------------------------

vi.mock("../../src/cache/tenant", () => ({
  getCachedSchema: vi.fn(),
  setCachedSchema: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mock analytics/tracker
// ---------------------------------------------------------------------------

vi.mock("../../src/analytics/tracker", () => ({
  trackClick: vi.fn(),
}));

import { withClient } from "../../src/db/client";
import { getCachedUrl } from "../../src/cache/shortcode";
import { getCachedSchema, setCachedSchema } from "../../src/cache/tenant";
import { trackClick } from "../../src/analytics/tracker";
import { redirectHandler } from "../../src/handlers/redirect";

// ---------------------------------------------------------------------------
// Helper: mock Hono context
// ---------------------------------------------------------------------------

function mockContext(overrides: { slug?: string; code?: string } = {}) {
  const jsonFn = vi.fn().mockImplementation(
    (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
  );
  const redirectFn = vi.fn().mockImplementation(
    (url: string, status: number) =>
      new Response(null, { status, headers: { Location: url } }),
  );
  const waitUntilFn = vi.fn();
  const paramFn = vi.fn().mockImplementation((name: string) => {
    if (name === "tenant") return overrides.slug ?? "acme";
    if (name === "code") return overrides.code ?? "abc123";
    return "";
  });

  const c = {
    req: {
      param: paramFn,
      raw: new Request("https://short.link/r/acme/abc123"),
    },
    env: {
      SHORT_URL_DOMAIN: "short.link",
      SUPABASE_JWT_SECRET: "test-secret",
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_ANON_KEY: "test-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
      SHORT_URL_CACHE: {} as any,
      TENANT_CACHE: {} as any,
    },
    json: jsonFn,
    redirect: redirectFn,
    get: vi.fn(),
    executionCtx: {
      waitUntil: waitUntilFn,
    },
  };

  return { c, jsonFn, redirectFn, waitUntilFn };
}

// ---------------------------------------------------------------------------
// Redirect handler tests (REQ-R001, REQ-L003, REQ-O002)
// ---------------------------------------------------------------------------

describe("redirectHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCachedSchema).mockResolvedValue("tenant_a7f3");
    vi.mocked(getCachedUrl).mockResolvedValue(null);
    vi.mocked(trackClick).mockResolvedValue(undefined);
  });

  it("returns 301 on full KV cache hit with JSON blob", async () => {
    vi.mocked(getCachedUrl).mockResolvedValueOnce(
      JSON.stringify({ url: "https://example.com", isActive: true, expiresAt: null }),
    );

    const { c, redirectFn, waitUntilFn } = mockContext();

    await redirectHandler(c as any);

    expect(redirectFn).toHaveBeenCalledWith("https://example.com", 301);
    expect(waitUntilFn).toHaveBeenCalled();
  });

  it("returns 410 for inactive link in KV cache", async () => {
    vi.mocked(getCachedUrl).mockResolvedValueOnce(
      JSON.stringify({ url: "https://example.com", isActive: false, expiresAt: null }),
    );

    const { c, jsonFn } = mockContext();

    await redirectHandler(c as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "link_inactive" }, 410);
  });

  it("returns 410 for expired link in KV cache", async () => {
    vi.mocked(getCachedUrl).mockResolvedValueOnce(
      JSON.stringify({
        url: "https://example.com",
        isActive: true,
        expiresAt: "2020-01-01T00:00:00Z", // In the past
      }),
    );

    const { c, jsonFn } = mockContext();

    await redirectHandler(c as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "link_expired" }, 410);
  });

  it("returns 301 on KV miss + DB hit, and populates KV cache", async () => {
    vi.mocked(getCachedUrl).mockResolvedValueOnce(null); // KV miss

    vi.mocked(withClient).mockImplementationOnce(async (_env: any, fn: any) => {
      return fn({
        query: vi.fn().mockResolvedValueOnce({
          rows: [
            {
              id: "link-uuid",
              original_url: "https://example.com",
              is_active: true,
              expires_at: null,
            },
          ],
        }),
      });
    });

    const { c, redirectFn, waitUntilFn } = mockContext();

    await redirectHandler(c as any);

    expect(redirectFn).toHaveBeenCalledWith("https://example.com", 301);
    expect(waitUntilFn).toHaveBeenCalledTimes(2); // KV cache populate + trackClick
  });

  it("returns 404 when code is not found", async () => {
    vi.mocked(getCachedUrl).mockResolvedValueOnce(null);

    vi.mocked(withClient).mockImplementationOnce(async (_env: any, fn: any) => {
      return fn({
        query: vi.fn().mockResolvedValueOnce({ rows: [] }),
      });
    });

    const { c, jsonFn } = mockContext();

    await redirectHandler(c as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "not_found" }, 404);
  });

  it("returns 410 for inactive link from database", async () => {
    vi.mocked(getCachedUrl).mockResolvedValueOnce(null);

    vi.mocked(withClient).mockImplementationOnce(async (_env: any, fn: any) => {
      return fn({
        query: vi.fn().mockResolvedValueOnce({
          rows: [
            {
              id: "link-uuid",
              original_url: "https://example.com",
              is_active: false,
              expires_at: null,
            },
          ],
        }),
      });
    });

    const { c, jsonFn } = mockContext();

    await redirectHandler(c as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "link_inactive" }, 410);
  });

  it("returns 410 for expired link from database", async () => {
    vi.mocked(getCachedUrl).mockResolvedValueOnce(null);

    vi.mocked(withClient).mockImplementationOnce(async (_env: any, fn: any) => {
      return fn({
        query: vi.fn().mockResolvedValueOnce({
          rows: [
            {
              id: "link-uuid",
              original_url: "https://example.com",
              is_active: true,
              expires_at: "2020-01-01T00:00:00Z",
            },
          ],
        }),
      });
    });

    const { c, jsonFn } = mockContext();

    await redirectHandler(c as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "link_expired" }, 410);
  });

  it("returns 503 on database failure", async () => {
    vi.mocked(getCachedUrl).mockResolvedValueOnce(null);

    vi.mocked(withClient).mockRejectedValueOnce(new Error("connection refused"));

    const { c, jsonFn } = mockContext();

    await redirectHandler(c as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "service_unavailable" }, 503);
  });

  it("resolves tenant schema from KV cache first", async () => {
    vi.mocked(getCachedSchema).mockResolvedValueOnce("tenant_x");
    vi.mocked(getCachedUrl).mockResolvedValueOnce(
      JSON.stringify({ url: "https://target.com", isActive: true, expiresAt: null }),
    );

    const { c, redirectFn } = mockContext();

    await redirectHandler(c as any);

    // Should have used the cached schema
    expect(getCachedSchema).toHaveBeenCalled();
    expect(redirectFn).toHaveBeenCalledWith("https://target.com", 301);
  });

  it("resolves tenant from database when KV miss", async () => {
    vi.mocked(getCachedSchema).mockResolvedValueOnce(null); // KV miss

    vi.mocked(withClient).mockImplementationOnce(async (_env: any, fn: any) => {
      return fn({
        query: vi.fn().mockResolvedValueOnce({
          rows: [{ id: "tenant-uuid", schema_name: "tenant_db1" }],
        }),
      });
    });

    // Then short code KV miss + DB hit
    vi.mocked(getCachedUrl).mockResolvedValueOnce(null);
    vi.mocked(withClient).mockImplementationOnce(async (_env: any, fn: any) => {
      return fn({
        query: vi.fn().mockResolvedValueOnce({
          rows: [
            {
              id: "link-uuid",
              original_url: "https://db-target.com",
              is_active: true,
              expires_at: null,
            },
          ],
        }),
      });
    });

    const { c, redirectFn } = mockContext();

    await redirectHandler(c as any);

    expect(redirectFn).toHaveBeenCalledWith("https://db-target.com", 301);
  });

  it("handles legacy plain-URL cache format (not JSON)", async () => {
    vi.mocked(getCachedUrl).mockResolvedValueOnce("https://legacy-url.com");

    const { c, redirectFn } = mockContext();

    await redirectHandler(c as any);

    expect(redirectFn).toHaveBeenCalledWith("https://legacy-url.com", 301);
  });
});

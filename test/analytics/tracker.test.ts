import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock db/client
// ---------------------------------------------------------------------------

vi.mock("../../src/db/client", () => ({
  withClient: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock db/schema
// ---------------------------------------------------------------------------

vi.mock("../../src/db/schema", () => ({
  validateSchemaName: vi.fn().mockImplementation((s: string) => s),
  qualifyTable: vi.fn().mockImplementation(
    (schema: string, table: string) => `"${schema}"."${table}"`,
  ),
  buildQuery: vi.fn().mockImplementation(
    (schema: string, template: string) => template.replace("{schema}", `"${schema}"`),
  ),
}));

import { withClient } from "../../src/db/client";
import { trackClick } from "../../src/analytics/tracker";

// ---------------------------------------------------------------------------
// Helper: create a mock Request with custom headers
// ---------------------------------------------------------------------------

function mockRequest(headers: Record<string, string> = {}) {
  return new Request("https://short.link/r/acme/abc123", {
    headers: {
      "CF-Connecting-IP": "1.2.3.4",
      "CF-IPCountry": "US",
      "CF-Device-Type": "desktop",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36",
      Referer: "https://google.com/search?q=test&page=1",
      ...headers,
    },
  });
}

// ---------------------------------------------------------------------------
// Tracker tests (REQ-A001, REQ-A002)
// ---------------------------------------------------------------------------

describe("trackClick", () => {
  const params = {
    tenantId: "tenant-uuid",
    schemaName: "tenant_a7f3",
    linkId: "link-uuid",
    shortCode: "abc123",
    request: mockRequest(),
  };

  const env = {
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_ANON_KEY: "test-salt",
    SUPABASE_JWT_SECRET: "test-secret",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
    SHORT_URL_DOMAIN: "short.link",
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("successfully inserts into analytics.link_clicks and updates clicks_count", async () => {
    const queryFn = vi.fn()
      .mockResolvedValueOnce(undefined) // INSERT analytics
      .mockResolvedValueOnce(undefined); // UPDATE clicks_count

    vi.mocked(withClient).mockImplementationOnce(async (_e: any, fn: any) => {
      return fn({ query: queryFn });
    });

    await trackClick(env, params);

    expect(withClient).toHaveBeenCalled();
    expect(queryFn).toHaveBeenCalledTimes(2);

    // First call: INSERT
    const insertCall = queryFn.mock.calls[0];
    expect(insertCall[0]).toContain("INSERT INTO analytics.link_clicks");

    // Second call: UPDATE
    const updateCall = queryFn.mock.calls[1];
    expect(updateCall[0]).toContain("UPDATE");
    expect(updateCall[0]).toContain("clicks_count = clicks_count + 1");
  });

  it("stores NULL for ip_hash when CF-Connecting-IP is missing", async () => {
    const reqWithoutIp = mockRequest();
    // Remove the CF-Connecting-IP header (we can't remove, so create without it)
    const req = new Request("https://short.link/r/acme/abc123", {
      headers: {
        "CF-IPCountry": "US",
        "User-Agent": "Chrome/125",
      },
    });

    const queryFn = vi.fn().mockResolvedValue(undefined);
    vi.mocked(withClient).mockImplementationOnce(async (_e: any, fn: any) => {
      return fn({ query: queryFn });
    });

    await trackClick(env, { ...params, request: req });

    const insertArgs = queryFn.mock.calls[0];
    // The ip_hash should be null (3rd param)
    expect(insertArgs[1][2]).toBeNull();
  });

  it("swallows database errors gracefully (no throw)", async () => {
    vi.mocked(withClient).mockRejectedValueOnce(new Error("DB connection lost"));

    // Should not throw
    await expect(trackClick(env, params)).resolves.toBeUndefined();
  });

  it("strips query parameters from referrer", async () => {
    const queryFn = vi.fn().mockResolvedValue(undefined);
    vi.mocked(withClient).mockImplementationOnce(async (_e: any, fn: any) => {
      return fn({ query: queryFn });
    });

    await trackClick(env, params);

    const insertArgs = queryFn.mock.calls[0];
    const args = insertArgs[1] as unknown[];
    // Referrer should not contain query parameters
    const referrerArg = args[6]; // 7th param
    expect(referrerArg).toBe("https://google.com/search");
    expect(referrerArg).not.toContain("q=test");
  });

  it("parses User-Agent into summary string", async () => {
    const queryFn = vi.fn().mockResolvedValue(undefined);
    vi.mocked(withClient).mockImplementationOnce(async (_e: any, fn: any) => {
      return fn({ query: queryFn });
    });

    await trackClick(env, params);

    const insertArgs = queryFn.mock.calls[0];
    const args = insertArgs[1] as unknown[];
    const uaSummary = args[3]; // 4th param: user_agent_summary
    // Should not be raw UA string
    expect(uaSummary).toContain("Chrome");
    expect(uaSummary).toContain("Windows");
    expect(uaSummary).not.toContain("Mozilla/5.0"); // Not raw
  });

  it("handles missing User-Agent header", async () => {
    const req = new Request("https://short.link/r/acme/abc123");
    const queryFn = vi.fn().mockResolvedValue(undefined);
    vi.mocked(withClient).mockImplementationOnce(async (_e: any, fn: any) => {
      return fn({ query: queryFn });
    });

    await trackClick(env, { ...params, request: req });

    const insertArgs = queryFn.mock.calls[0];
    const args = insertArgs[1] as unknown[];
    // user_agent_summary should be null when no UA header
    expect(args[3]).toBeNull();
  });

  it("never propagates errors to the caller", async () => {
    // Simulate error within the withClient callback
    vi.mocked(withClient).mockImplementationOnce(async (_e: any, _fn: any) => {
      throw new Error("unexpected");
    });

    await expect(trackClick(env, params)).resolves.toBeUndefined();
  });
});

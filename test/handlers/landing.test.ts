import { describe, it, expect } from "vitest";
import { landingHandler } from "../../src/handlers/landing";

// ---------------------------------------------------------------------------
// Helper: mock Hono context for landing handler
// ---------------------------------------------------------------------------

function mockContext(supabaseUrl = "https://test.supabase.co") {
  return {
    env: {
      SUPABASE_URL: supabaseUrl,
    },
    req: {},
  } as any;
}

// ---------------------------------------------------------------------------
// Landing page handler tests (REQ-LP001)
// ---------------------------------------------------------------------------

describe("landingHandler", () => {
  it("returns HTTP 200 with text/html content type", async () => {
    const c = mockContext();
    const response = await landingHandler(c);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
  });

  it("response body contains the service name 'Link Shortener'", async () => {
    const c = mockContext();
    const response = await landingHandler(c);
    const text = await response.text();

    expect(text).toContain("Link Shortener");
  });

  it("response body contains Create Tenant link and SUPABASE_URL", async () => {
    const c = mockContext("https://myapp.supabase.co");
    const response = await landingHandler(c);
    const text = await response.text();

    expect(text).toContain("https://myapp.supabase.co");
    expect(text).toContain("Create Tenant");
    expect(text).toContain("/api/tenants");
  });

  it("response body contains Supabase Project link", async () => {
    const c = mockContext("https://myapp.supabase.co");
    const response = await landingHandler(c);
    const text = await response.text();

    expect(text).toContain("Supabase Project");
    expect(text).toContain("Authentication is handled via our API");
  });

  it("response body contains tagline", async () => {
    const c = mockContext();
    const response = await landingHandler(c);
    const text = await response.text();

    expect(text).toContain("Short links with analytics");
  });

  it("contains no <script> tags", async () => {
    const c = mockContext();
    const response = await landingHandler(c);
    const text = await response.text();

    expect(text).not.toContain("<script");
  });

  it("contains no external CSS links", async () => {
    const c = mockContext();
    const response = await landingHandler(c);
    const text = await response.text();

    // No <link rel="stylesheet"> to external URLs
    expect(text).not.toMatch(/<link[^>]*stylesheet[^>]*href="https?:\/\//i);
  });

  it("includes viewport meta tag for responsiveness", async () => {
    const c = mockContext();
    const response = await landingHandler(c);
    const text = await response.text();

    expect(text).toContain('viewport');
    expect(text).toContain('width=device-width');
  });

  it("starts with DOCTYPE html declaration", async () => {
    const c = mockContext();
    const response = await landingHandler(c);
    const text = await response.text();

    expect(text.trimStart()).toMatch(/^<!DOCTYPE html>/i);
  });

  it("includes how-it-works section with 3 steps", async () => {
    const c = mockContext();
    const response = await landingHandler(c);
    const text = await response.text();

    expect(text).toContain("How It Works");
    expect(text).toContain("Create Account");
    expect(text).toContain("Shorten Links");
    expect(text).toContain("Track Clicks");
  });

  it("includes a footer with attribution", async () => {
    const c = mockContext();
    const response = await landingHandler(c);
    const text = await response.text();

    expect(text).toContain("<footer");
    expect(text).toContain("Cloudflare Workers");
    expect(text).toContain("Supabase");
  });
});

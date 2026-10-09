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

  it("response body contains sign-up and login links", async () => {
    const c = mockContext("https://myapp.supabase.co");
    const response = await landingHandler(c);
    const text = await response.text();

    expect(text).toContain('href="/signup"');
    expect(text).toContain("Sign Up");
    expect(text).toContain('href="/login"');
    expect(text).toContain("Log In");
  });

  it("response body contains tagline and how-it-works", async () => {
    const c = mockContext("https://myapp.supabase.co");
    const response = await landingHandler(c);
    const text = await response.text();

    expect(text).toContain("30 links");
    expect(text).toContain("click analytics");
  });

  it("response body contains tagline", async () => {
    const c = mockContext();
    const response = await landingHandler(c);
    const text = await response.text();

    expect(text).toContain("Short links with analytics");
  });

  it("loads only the Supabase browser client as an external script", async () => {
    const c = mockContext();
    const response = await landingHandler(c);
    const text = await response.text();

    // The page is not script-free: it deliberately loads the Supabase browser
    // client to read the session and swap between the guest and signed-in
    // views. What matters is that this is the *only* third-party script — no
    // analytics, tag managers, or CSS frameworks.
    const externalScripts = [...text.matchAll(/<script[^>]*\ssrc="([^"]+)"/gi)].map(
      (m) => m[1],
    );

    expect(externalScripts).toEqual([
      "https://unpkg.com/@supabase/supabase-js@2",
    ]);
  });

  it("bootstraps the signed-in view from the Supabase session", async () => {
    const c = mockContext();
    const response = await landingHandler(c);
    const text = await response.text();

    // The inline script is the session bootstrap, and it must be handed the
    // runtime env values rather than hardcoded placeholders.
    expect(text).toContain("sb.auth.getSession()");
    expect(text).toContain("sb.auth.onAuthStateChange");
    expect(text).toContain("https://test.supabase.co");
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

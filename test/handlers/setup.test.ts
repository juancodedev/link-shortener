import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { setupHandler } from "../../src/handlers/setup";
import { loginHandler, SAFE_NEXT_PATH } from "../../src/handlers/auth";

// ---------------------------------------------------------------------------
// GET /setup/:code — card quick setup
//
// The owner has just scanned an unconfigured card. Everything interactive
// happens in the browser (auth is a client-side Supabase session), so what is
// testable here is what the server renders: the headers, the escaping, the
// form contract, and the script's wiring. The one rule that matters most is
// the loop rule: a missing session goes to the login page with a return path
// to /setup/:code, never to /:code — /:code is the page that sent it here.
// ---------------------------------------------------------------------------

const env = {
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_ANON_KEY: "test-anon-key",
};

function app() {
  const a = new Hono();
  a.get("/setup/:code", setupHandler as any);
  a.get("/login", loginHandler as any);
  return a;
}

async function render(code: string) {
  const res = await app().request(`/setup/${encodeURIComponent(code)}`, {}, env);
  return { res, html: await res.text() };
}

describe("setup page response", () => {
  it("renders an HTML page that is never cached and never indexed", async () => {
    const { res, html } = await render("ywaoSiE");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain('<html lang="es">');
  });

  it("shows the code it is setting up", async () => {
    const { html } = await render("ywaoSiE");
    expect(html).toContain("<code>ywaoSiE</code>");
  });

  it("escapes the code in markup", async () => {
    const { html } = await render('<img src=x onerror="alert(1)">');

    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("cannot be broken out of the script by the code", async () => {
    const { html } = await render("</script><script>alert(1)</script>");

    // The only closing script tags are the page's own.
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script>");
  });
});

describe("setup form", () => {
  it("asks for the destination as a required, autofocused URL", async () => {
    const { html } = await render("ywaoSiE");
    expect(html).toMatch(/<input[^>]*id="original_url"[^>]*type="url"[^>]*required[^>]*autofocus/);
  });

  it("bounds the client ref at the server's limit", async () => {
    const { html } = await render("ywaoSiE");
    expect(html).toMatch(/<input[^>]*id="client_ref"[^>]*maxlength="200"/);
  });
});

describe("setup script", () => {
  it("reads the Supabase session the way the dashboard does", async () => {
    const { html } = await render("ywaoSiE");
    expect(html).toContain("createClient(");
    expect(html).toContain("auth.getSession()");
  });

  it("sends a missing session to login with a return path to /setup/:code, not /:code", async () => {
    const { html } = await render("ywaoSiE");

    expect(html).toContain('"/login?next=" + encodeURIComponent("/setup/" + encodeURIComponent(CODE))');
  });

  it("looks the link up by code and saves through PATCH /api/links/:id with the tenant header", async () => {
    const { html } = await render("ywaoSiE");

    expect(html).toContain('"/api/links/by-code/" + encodeURIComponent(CODE)');
    expect(html).toContain('"/api/links/" + encodeURIComponent(link.id)');
    expect(html).toContain('method: "PATCH"');
    expect(html).toContain('"X-Tenant-Slug": link.tenant_slug');
    expect(html).toContain('"Authorization": "Bearer " + token');
  });

  it("returns to the card after a successful save", async () => {
    const { html } = await render("ywaoSiE");
    expect(html).toContain('location.replace("/" + encodeURIComponent(CODE))');
  });
});

// ---------------------------------------------------------------------------
// The login page's return path
//
// Only a /setup/:code path is honoured. Anything else — another site, a
// protocol-relative URL, the short link itself — falls back to the default, so
// the parameter can be neither an open redirect nor the start of a loop.
// ---------------------------------------------------------------------------

describe("login return path", () => {
  it.each(["/setup/ywaoSiE", "/setup/my-card_01"])("accepts %s", (next) => {
    expect(SAFE_NEXT_PATH.test(next)).toBe(true);
  });

  it.each([
    "/ywaoSiE",
    "//evil.example/setup/x",
    "https://evil.example/setup/x",
    "/setup/",
    "/setup/x/../../dashboard",
    "/setup/x?y=1",
    "javascript:alert(1)",
  ])("rejects %s", (next) => {
    expect(SAFE_NEXT_PATH.test(next)).toBe(false);
  });

  it("ships the same guard to the login page script", async () => {
    const res = await app().request("/login", {}, env);
    const html = await res.text();

    expect(html).toContain(SAFE_NEXT_PATH.source);
    expect(html).toContain('searchParams.get("next")');
  });
});

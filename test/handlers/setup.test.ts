import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { renderSetupPage, setupHandler } from "../../src/handlers/setup";
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
    expect(html).toContain('"Authorization": "Bearer " + accessToken');
  });

  it("falls back to the card, never anywhere else, when the save names no destination", async () => {
    const { html } = await render("ywaoSiE");
    // Behaviour is covered in "after a successful save"; this pins the
    // rendered regex, which a template literal can silently unescape.
    expect(html).toContain(': "/" + encodeURIComponent(CODE)');
    expect(html).toContain("/^https?:\\/\\//i.test(saved.original_url)");
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

// ---------------------------------------------------------------------------
// Running the setup script
//
// The page's behaviour lives in its inline script, so these tests execute it
// against fake browser globals: a Supabase client, the form elements, fetch,
// location and sessionStorage. What they hold is the save path's handling of
// an access token that expired while the form was open.
// ---------------------------------------------------------------------------

interface FakeEl {
  textContent: string;
  hidden: boolean;
  disabled: boolean;
  value: string;
  focus: () => void;
  checkValidity: () => boolean;
  addEventListener: (type: string, fn: (e: unknown) => Promise<void>) => void;
}

interface BrowserOpts {
  /** Access tokens getSession hands out, one per call; null means no session. */
  sessions: (string | null)[];
  /** Access token refreshSession hands out; null means the refresh failed. */
  refreshed?: string | null;
  /** HTTP status of each PATCH, in order. */
  patchStatuses?: number[];
  link?: { original_url: string | null; client_ref: string | null };
  /** Initial sessionStorage contents, or "throws" for blocked storage. */
  storage?: Record<string, string> | "throws";
  /** Body of a successful PATCH response. */
  patchBody?: unknown;
}

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

async function runSetupPage(code: string, opts: BrowserOpts) {
  const html = renderSetupPage({ code, supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon" });
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);

  const els: Record<string, FakeEl> = {};
  let onSubmit: ((e: unknown) => Promise<void>) | undefined;
  const el = (id: string): FakeEl =>
    (els[id] ??= {
      textContent: "",
      hidden: id === "setup-form" || id === "form-error",
      disabled: false,
      value: "",
      focus: () => {},
      checkValidity: () => true,
      addEventListener: (_t, fn) => {
        onSubmit = fn;
      },
    });
  const document = { getElementById: el };

  const sessions = [...opts.sessions];
  const getSession = vi.fn(async () => {
    const token = sessions.length > 1 ? sessions.shift()! : sessions[0]!;
    return { data: { session: token ? { access_token: token } : null } };
  });
  const refreshSession = vi.fn(async () => ({
    data: { session: opts.refreshed ? { access_token: opts.refreshed } : null },
  }));
  const window = {
    supabase: { createClient: () => ({ auth: { getSession, refreshSession } }) },
  };

  const patchStatuses = [...(opts.patchStatuses ?? [200])];
  const patches: { token: string; body: unknown }[] = [];
  const fetch = vi.fn(async (url: string, init: any = {}) => {
    if (init.method === "PATCH") {
      patches.push({
        token: init.headers.Authorization,
        body: JSON.parse(init.body),
      });
      const status = patchStatuses.shift() ?? 200;
      const ok = opts.patchBody ?? { ok: true };
      return new Response(JSON.stringify(status === 200 ? ok : { error: "nope" }), { status });
    }
    return new Response(
      JSON.stringify({
        id: "link-uuid",
        short_code: code,
        tenant_slug: "acme",
        ...(opts.link ?? { original_url: null, client_ref: "MESA-7" }),
      }),
      { status: 200 },
    );
  });

  const store: Record<string, string> = opts.storage === "throws" ? {} : { ...(opts.storage ?? {}) };
  const sessionStorage =
    opts.storage === "throws"
      ? new Proxy({}, { get() { throw new Error("SecurityError: storage blocked"); } })
      : {
          getItem: (k: string) => (k in store ? store[k]! : null),
          setItem: (k: string, v: string) => { store[k] = String(v); },
          removeItem: (k: string) => { delete store[k]; },
        };

  const replace = vi.fn();
  // Runs the confirmation delay immediately, recording the order of events.
  const setTimeout = (fn: () => void) => fn();
  for (const src of inline) {
    new Function("window", "document", "location", "fetch", "sessionStorage", "setTimeout", src)(
      window, document, { replace }, fetch, sessionStorage, setTimeout,
    );
  }
  await settle();

  return {
    els,
    store,
    replace,
    patches,
    getSession,
    refreshSession,
    async submit() {
      await onSubmit!({ preventDefault: () => {} });
    },
  };
}

const LOGIN = "/login?next=" + encodeURIComponent("/setup/ywaoSiE");

describe("saving with an access token that expired while the form was open", () => {
  it("reads the session again at save time instead of reusing the load-time token", async () => {
    const page = await runSetupPage("ywaoSiE", { sessions: ["load-token", "fresh-token"] });
    page.els.original_url!.value = "https://example.com";

    await page.submit();

    expect(page.patches).toHaveLength(1);
    expect(page.patches[0]!.token).toBe("Bearer fresh-token");
  });

  it("refreshes once and retries once when the save is refused as unauthenticated", async () => {
    const page = await runSetupPage("ywaoSiE", {
      sessions: ["load-token", "stale-token"],
      refreshed: "refreshed-token",
      patchStatuses: [401, 200],
    });
    page.els.original_url!.value = "https://example.com";

    await page.submit();

    expect(page.refreshSession).toHaveBeenCalledTimes(1);
    expect(page.patches.map((p) => p.token)).toEqual(["Bearer stale-token", "Bearer refreshed-token"]);
    expect(page.replace).not.toHaveBeenCalledWith(LOGIN);
  });

  it("keeps the input as a draft and goes to login when the retry is refused too", async () => {
    const page = await runSetupPage("ywaoSiE", {
      sessions: ["load-token", "stale-token"],
      refreshed: "refreshed-token",
      patchStatuses: [401, 401],
    });
    page.els.original_url!.value = "https://example.com/menu";
    page.els.client_ref!.value = "MESA-9";

    await page.submit();

    // Exactly one retry: no loop between refresh and save.
    expect(page.patches).toHaveLength(2);
    expect(page.refreshSession).toHaveBeenCalledTimes(1);
    expect(JSON.parse(page.store["setup-draft:ywaoSiE"]!)).toEqual({
      original_url: "https://example.com/menu",
      client_ref: "MESA-9",
    });
    expect(page.replace).toHaveBeenCalledWith(LOGIN);
  });

  it("keeps the draft and goes to login when the session is gone and cannot be refreshed", async () => {
    const page = await runSetupPage("ywaoSiE", {
      sessions: ["load-token", null],
      refreshed: null,
    });
    page.els.original_url!.value = "https://example.com";

    await page.submit();

    expect(page.patches).toHaveLength(0);
    expect(page.store["setup-draft:ywaoSiE"]).toBeDefined();
    expect(page.replace).toHaveBeenCalledWith(LOGIN);
  });

  it("still goes to login when sessionStorage is blocked", async () => {
    const page = await runSetupPage("ywaoSiE", {
      sessions: ["load-token", "stale-token"],
      refreshed: null,
      patchStatuses: [401],
      storage: "throws",
    });
    page.els.original_url!.value = "https://example.com";

    await page.submit();

    expect(page.replace).toHaveBeenCalledWith(LOGIN);
  });
});

describe("coming back from login with a draft", () => {
  it("restores the draft over the stored values and clears it", async () => {
    const page = await runSetupPage("ywaoSiE", {
      sessions: ["token"],
      link: { original_url: "https://old.example", client_ref: "MESA-7" },
      storage: {
        "setup-draft:ywaoSiE": JSON.stringify({
          original_url: "https://example.com/menu",
          client_ref: "MESA-9",
        }),
      },
    });

    expect(page.els.original_url!.value).toBe("https://example.com/menu");
    expect(page.els.client_ref!.value).toBe("MESA-9");
    expect(page.store["setup-draft:ywaoSiE"]).toBeUndefined();
  });

  it("ignores another card's draft", async () => {
    const page = await runSetupPage("ywaoSiE", {
      sessions: ["token"],
      storage: { "setup-draft:other": JSON.stringify({ original_url: "https://x.example", client_ref: "X" }) },
    });

    expect(page.els.original_url!.value).toBe("");
    expect(page.els.client_ref!.value).toBe("MESA-7");
    expect(page.store["setup-draft:other"]).toBeDefined();
  });

  it("falls back to the stored values when the draft is unreadable", async () => {
    const page = await runSetupPage("ywaoSiE", {
      sessions: ["token"],
      storage: { "setup-draft:ywaoSiE": "{not json" },
    });

    expect(page.els.client_ref!.value).toBe("MESA-7");
  });
});

// ---------------------------------------------------------------------------
// After a successful save
//
// /:code serves a cached destination that the PATCH only clears after it has
// answered, so returning through /:code right away can show the OLD destination
// when an existing one was edited. The page goes straight to the destination
// the server saved instead, after a brief confirmation.
// ---------------------------------------------------------------------------

describe("after a successful save", () => {
  it("confirms and goes straight to the destination the server saved", async () => {
    const page = await runSetupPage("ywaoSiE", {
      sessions: ["token"],
      patchBody: { ok: true, original_url: "https://example.com/menu" },
    });
    page.els.original_url!.value = "HTTPS://Example.com/menu";

    await page.submit();

    expect(page.els.save!.textContent).toBe("Guardado");
    expect(page.replace).toHaveBeenCalledWith("https://example.com/menu");
  });

  it("falls back to /:code when the response carries no destination", async () => {
    const page = await runSetupPage("ywaoSiE", { sessions: ["token"], patchBody: { ok: true } });
    page.els.original_url!.value = "https://example.com";

    await page.submit();

    expect(page.replace).toHaveBeenCalledWith("/ywaoSiE");
  });

  it("never navigates to a non-http destination from the response", async () => {
    const page = await runSetupPage("ywaoSiE", {
      sessions: ["token"],
      patchBody: { ok: true, original_url: "javascript:alert(1)" },
    });
    page.els.original_url!.value = "https://example.com";

    await page.submit();

    expect(page.replace).toHaveBeenCalledWith("/ywaoSiE");
  });
});

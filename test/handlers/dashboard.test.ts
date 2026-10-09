import { describe, it, expect } from "vitest";
import { dashboardHandler } from "../../src/handlers/dashboard";

// ---------------------------------------------------------------------------
// Stored-XSS regression tests for the dashboard.
//
// The links table is built client-side: the handler serves an HTML shell whose
// inline <script> assigns a template string to `tbody.innerHTML`. The server
// never renders a row itself, so these tests extract the real row template out
// of the SERVED output and execute it. Asserting against a hand-copied copy of
// the template would pass while the shipped code stayed vulnerable, which is
// exactly the regression this file exists to prevent.
// ---------------------------------------------------------------------------

const XSS_URL = '<img src=x onerror=alert(1)>';
// Escapes a JS string literal inside an inline onclick="..." handler.
const XSS_CODE = "');alert(1)//";
const XSS_ATTR = '"><img src=x onerror=alert(1)>';
const ESCAPED_ATTR = "&quot;&gt;&lt;img src=x onerror=alert(1)&gt;";

// ---------------------------------------------------------------------------
// Helpers: mock Hono context
// ---------------------------------------------------------------------------

function mockContext() {
  return {
    env: {
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_ANON_KEY: "test-anon-key",
    },
    html: (body: string) =>
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
  } as any;
}

/** Serves `GET /dashboard` and returns the raw response body. */
async function serve(): Promise<string> {
  const response = await dashboardHandler(mockContext());
  return response.text();
}

/**
 * Returns the inline <script> block that owns the links table. The shell's
 * other inline block is the Supabase auth bootstrap and is not a `<script>` with
 * no attributes, so `<script>` matches only the dashboard body.
 */
async function clientScript(): Promise<string> {
  const html = await serve();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script || !script.includes("links-body")) {
    throw new Error("dashboard client script not found in served HTML");
  }
  return script;
}

/** Extracts a named `function foo(...) {...}` by brace matching. */
function extractFunction(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name}() not found`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}()`);
}

/** Compiles the served `esc()` helper and returns it as a callable. */
async function loadEsc(): Promise<(v: unknown) => string> {
  const src = extractFunction(await clientScript(), "esc");
  return new Function(`${src}\nreturn esc;`)() as (v: unknown) => string;
}

/**
 * Compiles the arrow function that `loadLinks` hands to `links.map(...)` and
 * returns a row renderer bound to the served `esc()`.
 */
async function loadRowRenderer(): Promise<(l: Record<string, unknown>) => string> {
  const script = await clientScript();
  const anchor = "links.map((l) => {";
  const start = script.indexOf(anchor);
  if (start < 0) throw new Error("links.map row template not found");
  const from = start + "links.map(".length;
  const to = script.indexOf('}).join("")', from);
  if (to < 0) throw new Error("end of links.map row template not found");
  const arrow = script.slice(from, to + 1);
  const esc = await loadEsc();
  return new Function("esc", `return (${arrow});`)(esc) as (
    l: Record<string, unknown>,
  ) => string;
}

/** Renders one links-table row through the shipped template. */
async function renderRow(over: Record<string, unknown> = {}): Promise<string> {
  const link = {
    id: "link-uuid",
    short_code: "abc1234",
    short_url: "https://short.link/abc1234",
    original_url: "https://example.com",
    title: null,
    client_ref: null,
    clicks_count: 5,
    is_active: true,
    expires_at: null,
    ...over,
  };
  return (await loadRowRenderer())(link);
}

/**
 * Compiles the `([k, v]) => ...` mapper used by the metric breakdown
 * renderers. All three renderers (country/device/source) share its shape; the
 * tests assert on the shared source plus the number of call sites.
 */
async function loadMetricMapper(): Promise<(entry: [string, number]) => string> {
  const script = await clientScript();
  const match = script.match(/\.map\(\(\[k, v\]\) => (`[\s\S]*?`)\)/);
  if (!match) throw new Error("metric breakdown mapper not found");
  const esc = await loadEsc();
  return new Function("esc", `return (([k, v]) => ${match[1]});`)(esc) as (
    entry: [string, number],
  ) => string;
}

// ---------------------------------------------------------------------------
// Shell contract
// ---------------------------------------------------------------------------

describe("dashboardHandler shell", () => {
  it("serves HTML with a text/html content type", async () => {
    const response = await dashboardHandler(mockContext());

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
  });

  it("serves the dashboard markup and the empty table body", async () => {
    const html = await serve();

    expect(html).toContain('<tbody id="links-body"></tbody>');
    expect(html).toContain("Your Links");
  });
});

// ---------------------------------------------------------------------------
// Class A — HTML context: escaping
// ---------------------------------------------------------------------------

describe("links table — HTML-context escaping", () => {
  it("never emits a raw <img when original_url carries markup", async () => {
    const row = await renderRow({ original_url: XSS_URL });

    // The `<` is neutralised, so no element is ever created. The literal text
    // "onerror=" legitimately survives as escaped text content — asserting its
    // absence would be asserting an escaping artifact, not the invariant.
    expect(row).not.toContain("<img");
    expect(row).toContain("&lt;img");
  });

  it("escapes the URL in the title attribute as well as the text node", async () => {
    // XSS_ATTR opens with a quote: unescaped it would close the title
    // attribute early and let the attacker add attributes of their own.
    const row = await renderRow({ original_url: XSS_ATTR });

    expect(row).not.toContain('"><img');
    // Both render positions — the title attribute and the text node — escaped.
    expect(row.split(`title="${ESCAPED_ATTR}"`).length - 1).toBe(1);
    expect(row.split(ESCAPED_ATTR).length - 1).toBe(2);
  });

  it("escapes client_ref in the input value", async () => {
    const row = await renderRow({ client_ref: XSS_ATTR });

    expect(row).not.toContain('<img src=x');
    expect(row).toContain("&quot;&gt;&lt;img");
  });

  it("renders null and undefined fields as empty rather than 'null'", async () => {
    const esc = await loadEsc();

    expect(esc(null)).toBe("");
    expect(esc(undefined)).toBe("");
    const row = await renderRow({ client_ref: null, original_url: "https://example.com" });
    expect(row).not.toContain("null");
  });
});

// ---------------------------------------------------------------------------
// Class B — JavaScript context: no inline handlers at all
// ---------------------------------------------------------------------------

describe("links table — no inline event handlers", () => {
  it("the row template source contains no onclick attribute", async () => {
    const script = await clientScript();
    const anchor = "links.map((l) => {";
    const start = script.indexOf(anchor);
    const to = script.indexOf('}).join("")', start);
    const template = script.slice(start, to);

    expect(template).not.toContain("onclick");
    expect(template).not.toMatch(/\bon[a-z]+\s*=/);
  });

  it("renders rows with no inline handler attribute at all", async () => {
    const row = await renderRow();

    expect(row).not.toContain("onclick");
    expect(row).not.toMatch(/\son[a-z]+\s*=\s*["']/);
  });

  it("delivers short_code only via data-* attributes, never into a handler", async () => {
    const row = await renderRow({ short_code: XSS_CODE });

    expect(row).not.toContain("onclick");
    // Escaped in the attribute, so the payload cannot reopen a JS string.
    expect(row).not.toContain(XSS_CODE);
    expect(row).toContain("data-code=");
  });

  it("marks every interactive control with a data-action for delegation", async () => {
    const row = await renderRow();

    const actions = [...row.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]);
    expect(actions.sort()).toEqual(
      ["copy", "delete", "metrics", "qr", "save-client-ref", "toggle"].sort(),
    );
  });

  it("binds one delegated click listener on the stable #links-body ancestor", async () => {
    const script = await clientScript();

    expect(script).toMatch(/getElementById\("links-body"\)\s*\n?\s*\.addEventListener\("click"/);
    expect(script).toContain('closest("[data-action]")');
    // Every action is dispatched from the dataset, never from a string literal.
    for (const action of ["copy", "qr", "metrics", "save-client-ref", "toggle", "delete"]) {
      expect(script).toMatch(new RegExp(`case "${action}":`));
    }
  });

  it("keeps the existing client-side function signatures intact", async () => {
    const script = await clientScript();

    expect(script).toMatch(/function copyUrl\(url, el\)/);
    expect(script).toMatch(/function showQR\(url, e\)/);
    expect(script).toMatch(/async function toggleLink\(id, active\)/);
    expect(script).toMatch(/async function saveClientRef\(id\)/);
    expect(script).toMatch(/async function showMetrics\(linkId, code, e\)/);
    expect(script).toMatch(/async function deleteLink\(id\)/);
  });

  it("preserves the copy-to-clipboard visual feedback via dataset.code", async () => {
    const script = await clientScript();

    expect(script).toContain("el.textContent = \"Copied!\"");
    expect(script).toContain("el.textContent = el.dataset.code");
  });
});

// ---------------------------------------------------------------------------
// Metric breakdown renderers
// ---------------------------------------------------------------------------

describe("metric breakdown renderers", () => {
  it("escapes the breakdown key before it reaches innerHTML", async () => {
    const row = (await loadMetricMapper())([XSS_URL, 3]);

    expect(row).not.toContain("<img");
    expect(row).toContain("&lt;img");
  });

  it("escapes the breakdown value as well as the key", async () => {
    const mapper = await loadMetricMapper();
    const row = mapper(["US", XSS_URL]);

    expect(row).not.toContain("<img");
    expect(row).toContain("&lt;img");
  });

  it("routes all three breakdown panels through the escaping mapper", async () => {
    const script = await clientScript();

    // by_country, by_device, by_source — three call sites, one mapper shape.
    expect(script.match(/\.map\(\(\[k, v\]\) => `[\s\S]*?`\)/g)).toHaveLength(3);
    for (const field of ["by_country", "by_device", "by_source"]) {
      // by_source is read defensively as `data.by_source || {}`
      expect(script).toContain(`Object.entries(data.${field}`);
    }
  });

  it("escapes err.message before it is concatenated into innerHTML", async () => {
    const script = await clientScript();
    const render = script.match(
      /countryDiv\.innerHTML = "<div class='metric-row'>Error: "[\s\S]*?<\/div>";/,
    )?.[0];

    expect(render).toBeDefined();
    expect(render).toContain("esc(");
  });
});

// ---------------------------------------------------------------------------
// The esc() helper itself
// ---------------------------------------------------------------------------

describe("esc() helper", () => {
  const PAYLOADS: [string, string][] = [
    ["<script>alert(1)</script>", "&lt;script&gt;alert(1)&lt;/script&gt;"],
    ['"><img src=x onerror=alert(1)>', "&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"],
    ["' onmouseover='alert(1)", "&#39; onmouseover=&#39;alert(1)"],
    ["a & b", "a &amp; b"],
    ["</textarea><script>", "&lt;/textarea&gt;&lt;script&gt;"],
  ];

  for (const [input, expected] of PAYLOADS) {
    it(`neutralises ${JSON.stringify(input)}`, async () => {
      const esc = await loadEsc();
      expect(esc(input)).toBe(expected);
    });
  }

  it("escapes ampersands before the entities it introduces", async () => {
    const esc = await loadEsc();
    // Escaping & last would double-encode every entity produced above.
    expect(esc("&lt;")).toBe("&amp;lt;");
  });

  it("coerces non-string input", async () => {
    const esc = await loadEsc();

    expect(esc(42)).toBe("42");
    expect(esc(0)).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// landing.ts — confirm rather than assume
// ---------------------------------------------------------------------------

describe("landing handler (confirmation)", () => {
  it("interpolates no request-scoped or user data into the page", async () => {
    const { landingHandler } = await import("../../src/handlers/landing");
    const response = await landingHandler({
      env: { SUPABASE_URL: "https://test.supabase.co", SUPABASE_ANON_KEY: "k" },
      req: {},
    } as any);
    const html = await response.text();

    // The only interpolations are deployment config (Supabase URL/key).
    // No stored record, header value, or query parameter reaches this page.
    const interpolations = [...html.matchAll(/\$\{[^}]*\}/g)].map((m) => m[0]);
    expect(interpolations).toEqual([]);
    expect(html).not.toMatch(/\bon(click|error|load)\s*=\s*["'][^"']*\$/);
  });
});
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

/**
 * Compiles a named client-side function out of the SERVED script, bound to the
 * served `esc()`. Used for the Phase 2 renderers, which are deliberately their
 * own functions rather than the shared breakdown mapper.
 */
async function loadClientFunction<T>(name: string): Promise<T> {
  const src = extractFunction(await clientScript(), name);
  const esc = await loadEsc();
  return new Function("esc", `${src}\nreturn ${name};`)(esc) as T;
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
// ---------------------------------------------------------------------------
// Phase 2 — visitor figures, and the caveat that qualifies them
//
// Two independent requirements, deliberately tested separately:
//
//   1. `unique_visitors` and `sessions` are rendered with EQUAL WEIGHT. The
//      user rejected a hierarchy between them, and a hierarchy is exactly the
//      kind of thing that sneaks back in through styling, so the assertion is
//      on the markup shape rather than on a class name.
//   2. The caveat is visible in the RENDERED MARKUP. Not in a comment, not in
//      the README, not behind a tooltip. If it were only in the source it
//      would be true of nobody who reads the page.
// ---------------------------------------------------------------------------

import { VISITOR_ESTIMATE_CAVEAT } from "../../src/analytics/metrics";

/**
 * The part of the served page that exists WITHOUT any script running.
 *
 * Every server-rendered element sits ahead of the dashboard's inline <script>
 * — nav, the create form, the links card and the clients card. Note the
 * boundary is the inline `<script>`, NOT `<script src=`: the dashboard's own
 * script (which carries the row template, and a second copy of the caveat) is
 * rendered INSIDE the container, ahead of the shell's Supabase loader. Cutting
 * at `<script src=` therefore included script content and made every caveat
 * assertion satisfiable by text a script produces — which is precisely the
 * failure this function exists to prevent.
 */
async function staticRegion(): Promise<string> {
  const html = await serve();
  const cut = html.indexOf("<script>");
  if (cut < 0) throw new Error("inline script boundary not found in served HTML");
  return html.slice(0, cut);
}

/** The static "About visitor figures" note's text, or undefined if absent. */
async function staticCaveatText(): Promise<string | undefined> {
  return (await staticRegion()).match(
    /<p class="estimate-note"><strong>About visitor figures:<\/strong>([\s\S]*?)<\/p>/,
  )?.[1];
}

describe("visitor figures — the caveat is in the rendered markup", () => {
  it("serves the caveat as static markup, visible before any script runs", async () => {
    const text = await staticCaveatText();

    // Static server-rendered text, not something a script injects after a
    // fetch. This is the copy a store owner sees on page load.
    expect(text).toBeDefined();
    expect(text).toContain(VISITOR_ESTIMATE_CAVEAT);
  });

  it("states the actual limitation rather than gesturing at one", async () => {
    const text = await staticCaveatText();

    // A caveat that says only "figures are approximate" tells the reader
    // nothing they can act on. It has to name the cause — people sharing an
    // address — and the direction of the error — under-reporting.
    expect(text).toMatch(/same Wi-Fi or mobile network/);
    expect(text).toMatch(/counted as one visitor/i);
    expect(text).toMatch(/UNDER-report/i);
  });

  it("repeats the caveat inside each link's metrics panel, next to the numbers", async () => {
    // The static note is above the table; the numbers are inside the expander.
    // Someone who expands a row without scrolling up must still meet the caveat.
    const row = await renderRow();

    expect(row).toContain(VISITOR_ESTIMATE_CAVEAT);
    // It sits in the same panel as the two figures, not somewhere off in a footer.
    const panel = row.slice(row.indexOf("Visitors (estimate)"));
    expect(panel).toContain("visitors-");
    expect(panel).toContain(VISITOR_ESTIMATE_CAVEAT);
  });

  it("labels the panel as an estimate in its own heading", async () => {
    const row = await renderRow();

    // The heading is what is visible at a glance; the caveat is the detail.
    expect(row).toContain("Visitors (estimate)");
  });

  it("shows the store-level rollup behind the same caveat", async () => {
    const region = await staticRegion();

    expect(region).toContain('id="clients-card"');
    expect(region).toContain('id="clients-body"');
    // Bounded by the static region, so this cannot be satisfied by the copy
    // that lives inside the inline script.
    const card = region.slice(region.indexOf('id="clients-card"'));
    expect(card).toContain(VISITOR_ESTIMATE_CAVEAT);
  });
});

describe("renderVisitors", () => {
  type Render = (data: Record<string, unknown>) => string;

  it("renders both figures when the API supplies them", async () => {
    const render = await loadClientFunction<Render>("renderVisitors");

    const html = render({
      unique_visitors: 30,
      sessions: 42,
      unique_window: "1 day",
      session_window: "30 minutes",
    });

    expect(html).toContain("30");
    expect(html).toContain("42");
  });

  it("gives the two figures identical markup — no hierarchy between them", async () => {
    const render = await loadClientFunction<Render>("renderVisitors");

    const html = render({
      unique_visitors: 30,
      sessions: 42,
      unique_window: "1 day",
      session_window: "30 minutes",
    });

    const rows = [...html.matchAll(/<div class="metric-row">[\s\S]*?<\/div>/g)].map((m) => m[0]);
    expect(rows).toHaveLength(2);

    // Same container, same label element, same value element, same ordering of
    // label-then-value. If one figure were ever rendered as <h4> and the other
    // as <strong>, or given its own class, this fails.
    for (const row of rows) {
      expect(row).toContain('<span>');
      expect(row).toContain("<strong>");
      expect(row).toContain('class="metric-row"');
    }
    // Neither is marked up as primary, secondary, or a footnote.
    expect(html).not.toMatch(/class="[^"]*(primary|secondary|highlight|subtle)/i);
  });

  it("labels each figure with the window the API actually used", async () => {
    const render = await loadClientFunction<Render>("renderVisitors");

    const html = render({
      unique_visitors: 30,
      sessions: 42,
      unique_window: "7 days",
      session_window: "15 minutes",
    });

    // Read from the response, not hardcoded here — otherwise the label can
    // describe a window the SQL no longer uses.
    expect(html).toContain("7 days");
    expect(html).toContain("15 minutes");
  });

  it("reports zero rather than undefined when a figure is absent", async () => {
    const render = await loadClientFunction<Render>("renderVisitors");

    const html = render({});

    // "undefined" next to a real number reads as a measurement.
    expect(html).not.toContain("undefined");
    expect(html.match(/<strong>0<\/strong>/g)).toHaveLength(2);
  });

  it("escapes the window labels it interpolates", async () => {
    const render = await loadClientFunction<Render>("renderVisitors");

    const html = render({
      unique_visitors: 1,
      sessions: 1,
      unique_window: XSS_URL,
      session_window: XSS_URL,
    });

    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("renderClients", () => {
  type Render = (clients: unknown) => string;

  it("renders one row per client with both figures", async () => {
    const render = await loadClientFunction<Render>("renderClients");

    const html = render([
      { client_ref: "ACME-0042", unique_visitors: 30, sessions: 42 },
    ]);

    expect(html).toContain("ACME-0042");
    expect(html).toContain("30");
    expect(html).toContain("42");
    expect([...html.matchAll(/<tr>/g)]).toHaveLength(1);
  });

  it("escapes client_ref, which is user-supplied free text", async () => {
    const render = await loadClientFunction<Render>("renderClients");

    const html = render([
      { client_ref: XSS_ATTR, unique_visitors: 1, sessions: 1 },
    ]);

    expect(html).not.toContain('"><img');
    expect(html).toContain("&quot;&gt;&lt;img");
  });

  it("explains the empty state instead of rendering a bare table", async () => {
    const render = await loadClientFunction<Render>("renderClients");

    const html = render([]);

    expect(html).toContain("No client identifiers");
  });
});

describe("Phase 2 markup did not regress the escaping and delegation guards", () => {
  it("keeps the metrics row free of inline event handlers", async () => {
    // The visitors box was added inside the row template — the exact place
    // Phase 1.5 removed the injected-JS vulnerability from.
    const row = await renderRow();

    expect(row).not.toContain("onclick");
    expect(row).not.toMatch(/\son[a-z]+\s*=\s*["']/);
  });

  it("adds no new delegated actions to the links table", async () => {
    const row = await renderRow();

    const actions = [...row.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]);
    expect(actions.sort()).toEqual(
      ["copy", "delete", "metrics", "qr", "save-client-ref", "toggle"].sort(),
    );
  });

  it("keeps exactly three breakdown panels on the shared mapper", async () => {
    const script = await clientScript();

    // The visitor pair has its own renderer precisely so it does not inflate
    // this count.
    expect(script.match(/\.map\(\(\[k, v\]\) => `[\s\S]*?`\)/g)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// The loadLinks / auth-bootstrap ordering
//
// The dashboard serves TWO inline scripts and they do not run in a
// cooperative order:
//
//   <script>  (container)   defines loadLinks, wires the create form
//   <script src=...supabase>
//   <script>  (shell)       async IIFE -> await sb.auth.getSession()
//                           -> defines window.__api -> loadLinks()
//
// The shell bootstrap suspends on a network round-trip, so anything the
// container script does at parse time runs while window.__api does not yet
// exist. A parse-time `loadLinks()` there therefore reached
// `window.__api("GET", ...)` and threw a TypeError that loadLinks' own catch
// turned into "Could not load links. window.__api is not a function".
//
// There is no DOM in the workers pool, so these tests do not simulate clicks or
// run a live page. They work on the SERVED script two ways: the ordering
// behaviour is exercised by executing the shipped `loadLinks` against a stub
// `window`/`document` — which is where the real defect lived, inside the
// function rather than in a click handler — and the parse-time wiring is
// asserted on the served source, because that part genuinely is about the
// order of statements in the document.
// ---------------------------------------------------------------------------

type ElementStub = {
  style: { display: string };
  textContent: string;
  innerHTML: string;
  dataset: Record<string, unknown>;
  addEventListener: (type: string, handler: unknown) => void;
};

type Request = { method: string; path: string };

interface Harness {
  /** The shipped loadLinks, bound to the stubs below. */
  loadLinks: () => Promise<void>;
  /** Exactly what the shell bootstrap calls once window.__api exists. */
  resolveGate: () => void;
  requests: Request[];
  el: (id: string) => ElementStub;
  win: Record<string, any>;
}

function stubElement(): ElementStub {
  return {
    style: { display: "" },
    textContent: "",
    innerHTML: "",
    dataset: {},
    addEventListener: () => {},
  };
}

/**
 * The elements this page serves already hidden, per its own inline styles:
 * #links-table, #links-empty and #clients-card all carry display:none and are
 * revealed by loadLinks once it has something to show. Without seeding that, a
 * stub that starts blank could not tell "loadLinks revealed nothing" apart from
 * "loadLinks revealed the empty state" — which is the whole assertion.
 */
const SERVED_HIDDEN_IDS = ["links-table", "links-empty", "clients-card"];

/**
 * Compiles the served `loadLinks()` against a stub DOM and an EMPTY window.
 *
 * The stub document returns a fresh element per id, so loadLinks runs its real
 * body — real assignments, real try/catch — without a browser. `window.__api`
 * is deliberately left undefined: that is exactly the state the container
 * script sees while the shell bootstrap is still awaiting getSession().
 */
async function mountDashboard(): Promise<Harness> {
  const script = await clientScript();
  const esc = await loadEsc();
  const renderClients = await loadClientFunction<(c: unknown) => string>("renderClients");

  // The gate statement is served source, not a stand-in. It is applied only if
  // the page actually creates one: on the pre-fix page there is no gate, and
  // the harness must still be able to run loadLinks so the test fails on its
  // own assertion — the rendered production error — instead of on a missing
  // fixture. That keeps the RED evidence about the defect rather than the rig.
  const gateSrc = script.match(/\n\s*(window\.__apiReady = new Promise\(.*\);)\n/)?.[1];

  const elements: Record<string, ElementStub> = {};
  const el = (id: string): ElementStub => {
    if (!elements[id]) {
      elements[id] = stubElement();
      if (SERVED_HIDDEN_IDS.includes(id)) elements[id].style.display = "none";
    }
    return elements[id];
  };
  const win: Record<string, any> = {};
  const requests: Request[] = [];

  if (gateSrc) new Function("window", gateSrc)(win);

  // extractFunction() matches on `function loadLinks(`, which drops the `async`
  // keyword, so the prefix is restored here — the shipped function is async and
  // its body awaits.
  const loadLinks = new Function(
    "window",
    "document",
    "esc",
    "renderClients",
    `return async ${extractFunction(script, "loadLinks")}`,
  )(win, { getElementById: el }, esc, renderClients) as () => Promise<void>;

  return {
    loadLinks,
    // Optional call: a page without a gate must not hang this harness.
    resolveGate: () => win.__apiReadyResolve?.(),
    requests,
    el,
    win,
  };
}

/** A window.__api that records its calls and answers with empty collections. */
function recordingApi(requests: Request[]) {
  return async (method: string, path: string) => {
    requests.push({ method, path });
    return { ok: true, json: async () => [] };
  };
}

/**
 * Executes the served shell auth bootstrap against a stub window, so the
 * redirect path and the resolve ordering are observed rather than assumed.
 * `session: null` is the unauthenticated visitor.
 */
async function runAuthBootstrap(session: unknown) {
  const html = await serve();
  const start = html.indexOf("<script src=");
  if (start < 0) throw new Error("auth bootstrap not found in served HTML");
  const end = html.indexOf("})();", start);
  if (end < 0) throw new Error("auth bootstrap is not terminated in served HTML");
  const iife = html.slice(html.indexOf("(async () => {", start), end + 5);

  let resolveCalls = 0;
  let apiTypeAtResolve = "<never called>";
  const win: Record<string, any> = {
    location: { href: "" },
    supabase: {
      createClient: () => ({ auth: { getSession: async () => ({ data: { session } }) } }),
    },
  };
  // Pre-installed so the bootstrap finds one whichever order it is written in.
  // The bootstrap itself never defines it — only the container script does.
  win.__apiReadyResolve = () => {
    resolveCalls++;
    apiTypeAtResolve = typeof win.__api;
  };

  await new Function("window", "document", `return ${iife}`)(win, {
    getElementById: stubElement,
  });

  return {
    win,
    resolveCalls: () => resolveCalls,
    apiTypeAtResolve: () => apiTypeAtResolve,
  };
}

describe("loadLinks ordering against the auth bootstrap", () => {
  it("does not throw or request anything when invoked before the session resolves", async () => {
    const dash = await mountDashboard();

    // Parse-time ordering: loadLinks runs, window.__api does not exist yet.
    const pending = dash.loadLinks();

    // The defect surfaced as a rendered error, because loadLinks swallows the
    // TypeError into the empty state. That message is the production symptom.
    expect(dash.requests).toHaveLength(0);
    expect(dash.el("links-empty").textContent).toBe("");
    expect(dash.el("links-empty").style.display).toBe("none");

    // And it is still waiting rather than having silently failed.
    dash.win.__api = recordingApi(dash.requests);
    dash.resolveGate();
    await pending;

    // The load it deferred actually happens, once the API is available.
    //
    // Asserted by SHAPE rather than by endpoint list, because the property
    // under test is the ordering and not the number of requests: the same
    // invariant has to hold for the one-request form of loadLinks that predates
    // the client_ref rollup getting its own URL. The shipped endpoint set is
    // pinned separately below.
    expect(dash.requests.length).toBeGreaterThan(0);
    for (const request of dash.requests) {
      expect(request.method).toBe("GET");
      expect(request.path).toMatch(/^\/api\//);
    }
    // The load ran to completion rather than parking half-rendered.
    expect(dash.el("link-count").textContent).toBe(0);
    expect(dash.el("links-loading").style.display).toBe("none");
  });

  it("uses whatever window.__api is bound at resolve time, not one captured early", async () => {
    const dash = await mountDashboard();

    const pending = dash.loadLinks();
    // Bound AFTER loadLinks was invoked and while it was suspended.
    dash.win.__api = recordingApi(dash.requests);
    dash.resolveGate();
    await pending;

    // Nothing is requested until the late-bound helper is actually called, so
    // a request here can only have come through the binding made after the
    // invocation. Zero would mean the deferred load never ran.
    expect(dash.requests.length).toBeGreaterThan(0);
    expect(dash.el("links-empty").textContent).toBe("");
  });

  it("loads normally for a caller that runs after the gate is already open", async () => {
    const dash = await mountDashboard();
    dash.win.__api = recordingApi(dash.requests);
    dash.resolveGate();
    await Promise.resolve();

    await dash.loadLinks();

    // The gate adds a microtask to an already-open path; it does not swallow
    // the load. This is the case the four in-handler refreshes depend on.
    expect(dash.requests.length).toBeGreaterThan(0);
    expect(dash.el("links-loading").style.display).toBe("none");
  });

  it("issues the shipped endpoint set once the gate opens", async () => {
    // The contract itself: the links collection, the client_ref rollup, and
    // the review-gate panel, fetched together. Pinned here rather than inside
    // the ordering tests so those stay independent of how many endpoints
    // loadLinks asks for.
    const dash = await mountDashboard();
    dash.win.__api = recordingApi(dash.requests);

    const pending = dash.loadLinks();
    dash.resolveGate();
    await pending;

    expect(dash.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/links",
      "GET /api/clients/metrics",
      "GET /api/review-gate/metrics",
    ]);
  });

  it("waits on the gate before the first request, whatever the endpoint count", async () => {
    const src = extractFunction(await clientScript(), "loadLinks");

    const gateAt = src.indexOf("__apiReady");
    const firstRequestAt = src.indexOf("window.__api(");

    expect(gateAt).toBeGreaterThan(-1);
    expect(firstRequestAt).toBeGreaterThan(-1);
    // The gate is awaited once, ahead of every request in the function. That
    // ordering — not a particular number of endpoints — is what makes the fix
    // hold for BOTH the one-request form of loadLinks (links only, pre-Phase 2)
    // and the two-request form shipped today.
    expect(gateAt).toBeLessThan(firstRequestAt);
    // Guarded, so loadLinks stays safe if it is ever invoked in a context where
    // the container script did not create the gate.
    expect(src).toMatch(/if \(window\.__apiReady\) await window\.__apiReady;/);
  });
});

describe("the dashboard script never triggers a load at parse time", () => {
  it("never calls loadLinks from the script's top-level wiring", async () => {
    const script = await clientScript();

    // Matched as whole STATEMENTS at line start, so the prose beside the gate
    // is free to name loadLinks() while explaining why it no longer calls it.
    //
    // Indentation carries the information here: this served script indents its
    // top-level statements by exactly six spaces, and every call that lives
    // inside a function or an event handler sits deeper. A bare loadLinks()
    // statement at the parse-time indentation is exactly the regression — it
    // ran before the session resolved and before window.__api existed.
    const TOP_LEVEL_INDENT = 6;
    const statements = [...script.matchAll(/^([ \t]*)loadLinks\(\);[ \t]*$/gm)].map(
      (m) => m[1].length,
    );

    // One call per handler: create form submit, toggle, client-ref save,
    // delete. A parse-time call anywhere pushes this to five.
    expect(statements).toHaveLength(4);
    expect(statements.every((indent) => indent > TOP_LEVEL_INDENT)).toBe(true);
  });

  it("creates the readiness gate in the container script, before the auth script", async () => {
    const html = await serve();

    const gateAt = html.indexOf("window.__apiReady = new Promise");
    const authAt = html.indexOf("<script src=");
    expect(gateAt).toBeGreaterThan(-1);
    // If the gate were created after the bootstrap script, a parse-time caller
    // would find it undefined and the race would come straight back.
    expect(gateAt).toBeLessThan(authAt);
  });
});

describe("the auth bootstrap gates its own load", () => {
  it("resolves the gate only after window.__api exists", async () => {
    const { resolveCalls, apiTypeAtResolve, win } = await runAuthBootstrap({
      access_token: "tok",
      user: { email: "owner@example.com" },
    });

    expect(win.location.href).toBe("");
    expect(typeof win.__api).toBe("function");
    expect(resolveCalls()).toBe(1);
    // Ordering, observed: a resolver that ran before __api existed would
    // release every waiter onto the same race.
    expect(apiTypeAtResolve()).toBe("function");
  });

  it("keeps its guarded loadLinks call after the resolve", async () => {
    const html = await serve();
    const auth = html.slice(html.indexOf("<script src="));

    // Matched as the whole statement, so the explanatory comment above it
    // cannot satisfy — or break — the ordering assertion.
    const call = 'if (typeof loadLinks === "function") loadLinks();';
    const callAt = auth.indexOf(call);
    const resolveAt = auth.indexOf("window.__apiReadyResolve?.()");
    const helperAt = auth.indexOf("window.__api = async");

    expect(callAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeGreaterThan(-1);
    // The gate opens after the helper exists, not merely after the session.
    expect(helperAt).toBeLessThan(resolveAt);
    // And before the bootstrap's own load, so nothing is left waiting.
    expect(resolveAt).toBeLessThan(callAt);
  });

  it("redirects without opening the gate or defining the api helper", async () => {
    const { win, resolveCalls } = await runAuthBootstrap(null);

    expect(win.location.href).toBe("/login");
    expect(win.__api).toBeUndefined();
    // The page is navigating away. Releasing the gate here would only start a
    // load that cannot succeed, so the unauthenticated path leaves every waiter
    // parked — nothing to render, nothing to fetch.
    expect(resolveCalls()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Multi-location switcher
//
// The API answers 409 tenant_required when a user holds several memberships and
// names none — it refuses rather than guessing, because guessing was the bug
// Phase 4 removed. Until this shipped, such a user got an error instead of a
// dashboard. It is the last known broken path in the product.
// ---------------------------------------------------------------------------

describe("dashboard — tenant switcher", () => {
  // Read the HTML the server actually serves, not the handler's source: these
  // assertions are about what the browser receives.
  async function script(): Promise<string> {
    return serve();
  }

  it("sends the selected location on every API call", async () => {
    expect(await script()).toContain("X-Tenant-Slug");
  });

  it("remembers the choice, so a refresh does not fall back to 409", async () => {
    // The failure mode this exists to prevent: the user picks a location, the
    // page reloads, the selection is gone, and they are back at an error.
    expect(await script()).toContain('localStorage.setItem("tenant"');
    expect(await script()).toContain('localStorage.getItem("tenant")');
  });

  // A shared dashboard link should open the store it names, without the user
  // re-picking it on every visit.
  it("prefers a tenant named in the URL over the remembered one", async () => {
    expect(await script()).toContain("URLSearchParams");
  });

  it("handles 409 and renders the picker", async () => {
    const src = await script();
    expect(src).toContain("res.status === 409");
    expect(src).toContain("tenant_required");
    expect(src).toContain("__showTenantPicker");
  });

  it("shows which role the user holds in that location", async () => {
    // Admin and viewer mean different permissions. A switcher showing only
    // names would let someone pick a store they can see but not manage, and
    // then find out at the worst moment.
    expect(await script()).toContain("t.role");
  });

  // __api calls the picker synchronously on a 409, and loadLinks runs at the end
  // of the same IIFE. Defined later, it is undefined at the moment of call.
  it("defines the picker before any API call can reach it", async () => {
    const src = await script();
    expect(src.indexOf("__showTenantPicker = function")).toBeGreaterThan(-1);
    // Both markers are asserted to exist by the tests above, so this compares
    // two real offsets rather than two -1s.
    const defined = src.indexOf("__showTenantPicker = function");
    const called = src.indexOf("__showTenantPicker(payload.available)");
    expect(defined).toBeGreaterThan(-1);
    expect(called).toBeGreaterThan(-1);
    expect(defined).toBeLessThan(called);
  });

  // The business name comes from the API, so it is untrusted markup.
  it("escapes a location name that contains markup", async () => {
    expect(await script()).toContain('.replace(/[<>&]/g, "")');
  });

  it("does not break the single-location user who never sees the picker", async () => {
    // One membership resolves server-side with no header, so nothing here may
    // become a precondition for the dashboard loading at all.
    expect(await script()).toContain("if (q) headers[");
  });
});

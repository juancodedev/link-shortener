import { describe, it, expect } from "vitest";
import { dashboardHandler } from "../../src/handlers/dashboard";

// ---------------------------------------------------------------------------
// The served dashboard page.
//
// The dashboard is built client-side by the React bundle (web/); this
// handler serves the document it runs in. These tests assert against the
// SERVED output, not the handler's source.
//
// Sections that moved to React islands (odd/tasks/dashboard-react.md) are
// tested as components in web/test instead: the Links section (table, create
// form, bulk cards, QR modal) and the print queue in web/test/links and
// web/test/print-queue.test.ts (T3a/T3b); the Overview section (print
// button, satisfaction panel, busy hours, client rollup) in web/test/overview
// (T4); Businesses, Comments and Settings, with the branches store they
// share, in web/test/businesses, web/test/comments, web/test/settings and
// web/test/branches (T5); the shell (auth bootstrap, API helper, tenant
// picker, sidebar routing) in web/test/shell and web/test/api.test.ts (T6a).
// What stays here is the served document: the mount points, the first paint,
// the stylesheet, the config block and the bundle tag.
// ---------------------------------------------------------------------------

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

/** Markup with its HTML comments removed, so a test reads only the elements. */
function codeOnlyHtml(html: string): string {
  let previous: string;
  let current = html;
  do {
    previous = current;
    current = current.replace(/<!--[\s\S]*?-->/g, "");
  } while (current !== previous);
  return current;
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

  it("serves the Links section's content as the React island's mount point, titled before the bundle runs", async () => {
    const html = await serve();

    // The <section> stays server-rendered (showSection and the print rules
    // act on it); everything inside it is the island's.
    expect(html).toMatch(
      /<section class="dash-section" data-section="links">\s*<!--[\s\S]*?-->\s*<div id="links-root" data-island="links" data-link-limit="\d+">\s*<div class="card no-print" id="links-card">/,
    );
    expect(html).toContain("Your Links");
    // The table itself is the island's (web/src/links); the server ships none.
    expect(html).not.toContain('id="links-table"');
    expect(html).not.toContain('id="links-body"');
  });

  it("serves no Links markup the island now draws: no create form, no bulk or QR modal", async () => {
    const html = await serve();

    // web/test/links/create.test.tsx, bulk.test.tsx and qr.test.tsx pin them.
    for (const id of ["create-form", "url", "slug", "gated", "create-msg", "result", "short-url", "open-bulk", "bulk-modal", "bulk-count", "bulk-label", "bulk-gated", "qr-modal", "qr-img", "qr-url", "copy-print-sheet"]) {
      expect(html, id).not.toContain(`id="${id}"`);
    }
    // And with them went the last inline handlers: an attribute body is
    // handed to the JS engine, where HTML entities terminate nothing.
    expect(html).not.toMatch(/<[^>]+\sonclick=/i);
  });
});

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
 * Every server-rendered element sits ahead of the page's first <script>
 * element (the config block, then the bundle). The cut is at that first
 * <script, so no caveat assertion can be satisfied by text a script carries
 * — the failure this function exists to prevent.
 */
async function staticRegion(): Promise<string> {
  const html = await serve();
  const cut = html.indexOf("<script");
  if (cut < 0) throw new Error("script boundary not found in served HTML");
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


  it("leaves the store-level rollup and its caveat to the Overview island", async () => {
    const region = await staticRegion();

    // The rollup card, with the same caveat beside it, is drawn by the island
    // (web/test/overview/overview.test.tsx pins the caveat there). The server
    // serves only the mount point inside the overview section.
    expect(region).not.toContain('id="clients-card"');
    expect(region).toMatch(
      /<section class="dash-section" data-section="overview" hidden>[\s\S]*?<div id="overview-root" data-island="overview"><\/div>\s*<\/section>/,
    );
  });
});

describe("printable report", () => {
  async function printCss(): Promise<string> {
    const html = await serve();
    const start = html.indexOf("@media print {");
    expect(start).toBeGreaterThan(-1);
    // The block ends at the first line that closes it at the same indentation.
    return html.slice(start, html.indexOf("\n    }\n", start));
  }

  it("hides navigation, the admin column, controls and the links table when printed", async () => {
    const css = await printCss();

    expect(css).toContain(".topbar,");
    expect(css).toContain(".sidebar,");
    expect(css).toContain('.dash-section:not([data-section="overview"]),');
    expect(css).toContain(".no-print,");
    expect(css).toContain("button,");
    expect(css).toContain("select,");
    expect(css).toContain("display: none !important;");
  });

  it("keeps each card on one page and prints the bar colours", async () => {
    const css = await printCss();

    expect(css).toContain("break-inside: avoid;");
    expect(css).toContain("print-color-adjust: exact;");
  });

  it("marks the links table as not part of the report", async () => {
    const html = await serve();

    // The print button is the Overview island's (web/test/overview).
    expect(html).toMatch(/<div class="card no-print" id="links-card"[^>]*>/);
  });

  it("keeps the report keyed on the server-rendered overview section the island mounts inside", async () => {
    const html = await serve();
    const css = await printCss();

    expect(css).toContain('.dash-section[data-section="overview"] { display: block !important; }');
    expect(css).toContain('body.printing-cards .dash-section[data-section="overview"] { display: none !important; }');
    expect(html).toMatch(/data-section="overview" hidden>[\s\S]*?<div id="overview-root" data-island="overview">/);
  });
});

// ---------------------------------------------------------------------------
// The served document (odd/tasks/dashboard-react.md T6a)
//
// The shell's behaviour is the React bundle's now, pinned in web/test:
//   - the auth bootstrap (session check, /login redirect, nav email, logout,
//     the readiness gate and its ordering): web/test/shell/auth.test.ts
//   - the API helper (Bearer token, X-Tenant-Slug from the URL then storage,
//     401 -> /login, 409 tenant_required, error text): web/test/api.test.ts
//   - the tenant picker: web/test/shell/tenant-picker.test.tsx
//   - the sidebar routing (sectionFromHash, showSection, hashchange):
//     web/test/shell/routing.test.ts
// What the Worker still owns is the document: the stylesheet, the markup the
// bundle drives, the config block it reads, and the bundle tag.
// ---------------------------------------------------------------------------

const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi;

/** Every <script> element of the served page: its attributes and its body. */
function scripts(html: string): Array<{ attrs: string; body: string }> {
  return [...html.matchAll(SCRIPT_TAG)].map((m) => ({ attrs: m[1] ?? "", body: m[2] ?? "" }));
}

function contextWith(env: Record<string, string>) {
  const c = mockContext();
  c.env = { ...c.env, ...env };
  return c;
}

/** The parsed body of the config block. */
function config(html: string): unknown {
  const block = html.match(/<script type="application\/json" id="dashboard-config">([\s\S]*?)<\/script>/);
  if (!block) throw new Error("no config block in served HTML");
  return JSON.parse(block[1]!);
}

describe("the served document", () => {
  it("hands the bundle the Supabase URL and anon key from env, and nothing else", async () => {
    const html = await serve();

    expect(config(html)).toEqual({ supabaseUrl: "https://test.supabase.co", supabaseAnonKey: "test-anon-key" });
  });

  it("keeps a config value from closing the block or opening markup", async () => {
    const response = await dashboardHandler(contextWith({ SUPABASE_ANON_KEY: 'k</script><img src=x onerror="alert(1)">' }));
    const html = await response.text();

    expect(html).not.toContain("<img src=x");
    expect(config(html)).toEqual({
      supabaseUrl: "https://test.supabase.co",
      supabaseAnonKey: 'k</script><img src=x onerror="alert(1)">',
    });
  });

  it("escapes U+2028 and U+2029 in config values and still round-trips them", async () => {
    const key = "a\u2028b\u2029c<!--d";
    const html = await (await dashboardHandler(contextWith({ SUPABASE_ANON_KEY: key }))).text();
    const block = html.match(/<script type="application\/json" id="dashboard-config">([\s\S]*?)<\/script>/)![1]!;

    expect(block).not.toMatch(/[\u2028\u2029<]/);
    expect(config(html)).toEqual({ supabaseUrl: "https://test.supabase.co", supabaseAnonKey: key });
  });

  it("serves no inline executable script: only the JSON config block and the bundle", async () => {
    const html = await serve();
    const all = scripts(html);

    expect(all.map((s) => s.attrs.trim())).toEqual([
      'type="application/json" id="dashboard-config"',
      'type="module" src="/assets/dashboard.js"',
    ]);
    expect(all[1]!.body).toBe("");
    expect(html).not.toMatch(/<[^>]+\son[a-z]+=/i);
  });

  it("loads Supabase from the bundle, not from a CDN", async () => {
    const html = await serve();

    expect(html).not.toContain("unpkg.com");
    expect(html).not.toContain("supabase-js");
    expect(html).not.toContain("jsdelivr");
  });

  it("loads the bundle as a module, last, after the config block it reads", async () => {
    const html = await serve();
    const tag = '<script type="module" src="/assets/dashboard.js"></script>';

    expect(html).toContain(tag);
    expect(html.indexOf(tag)).toBeGreaterThan(html.indexOf('id="dashboard-config"'));
    expect(html.indexOf(tag)).toBeLessThan(html.indexOf("</body>"));
    expect(html.slice(html.indexOf(tag) + tag.length).trim()).toBe("</body>\n</html>");
  });

  it("lends nothing on window: no api helper, gate, token, client or picker global", async () => {
    const html = codeOnlyHtml(await serve());

    for (const name of ["__api", "__apiReady", "__token", "__sb", "__showTenantPicker", "window.supabase"]) {
      expect(html, name).not.toContain(name);
    }
  });

  it("keeps the topbar the bundle drives: the nav email, logout and home link", async () => {
    const html = await serve();
    const nav = html.slice(html.indexOf('<nav class="topbar">'), html.indexOf("</nav>"));

    expect(nav).toContain('<span id="nav-email" class="nav-email"></span>');
    expect(nav).toMatch(/<button id="logout-nav">[\s\S]*?<span>Log Out<\/span><\/button>/);
    expect(nav).toContain('<a href="/">Home</a>');
  });

  it("still serves the stylesheet the tenant bar and the sidebar use", async () => {
    const html = await serve();

    expect(html).toMatch(/<style>[\s\S]*\.tenant-bar \{[\s\S]*<\/style>/);
    expect(html).toMatch(/<style>[\s\S]*\.side-nav a\.is-active \{[\s\S]*<\/style>/);
  });
});

// ---------------------------------------------------------------------------
// The review-screen checkbox (odd/tasks/review-screen-refresh.md, S1)
//
// `is_gated` decides whether a scan shows the review screen or goes straight
// to the destination. Unchecked is the default everywhere.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Full-width layout (odd/tasks/review-screen-refresh.md, S5)
//
// The page used to be a single 720px column centred in the window. It now uses
// the width: a main column for what the owner reads, a side column for what
// they configure, stacked on a phone.
// ---------------------------------------------------------------------------

describe("sidebar sections (odd/tasks/print-queue-cards.md S1)", () => {
  /** The markup of one <section data-section="..."> block. */
  function section(html: string, name: string): string {
    const start = html.indexOf(`<section class="dash-section" data-section="${name}"`);
    expect(start, `${name} section is missing`).toBeGreaterThan(-1);
    return html.slice(start, html.indexOf("</section>", start));
  }

  it("no longer caps the page at a 720px column", async () => {
    const html = await serve();
    expect(html).not.toContain("max-width: 720px");
    expect(html).toMatch(/\.container\s*\{[^}]*max-width:\s*1440px/);
  });

  it("lists the six sections in the sidebar, in order", async () => {
    const html = await serve();
    const nav = html.slice(html.indexOf('<aside class="sidebar'), html.indexOf("</aside>"));
    // Each link is an icon followed by its label in a <span>.
    const links = [...nav.matchAll(/<a href="#([a-z]+)" data-section-link="\1"[^>]*>[^]*?<span>([^<]+)<\/span>/g)].map((m) => [m[1], m[2]!.trim()]);
    expect(links).toEqual([
      ["overview", "Overview"],
      ["links", "Links"],
      ["cards", "Cards"],
      ["businesses", "Businesses and branches"],
      ["comments", "Comments"],
      ["settings", "Settings"],
    ]);
  });

  it("puts the sidebar beside the sections on a wide screen", async () => {
    const html = await serve();
    expect(html).toMatch(/@media \(min-width: 1024px\)\s*\{\s*\.app\s*\{[^}]*grid-template-columns/);
  });

  it("groups the existing cards into their sections", async () => {
    const html = await serve();
    // The Overview's print button and report cards are its island's
    // (web/test/overview); the server serves the mount point.
    expect(section(html, "overview")).toContain('<div id="overview-root" data-island="overview">');
    const links = section(html, "links");
    // The whole section's content is the Links island's (create form, bulk
    // cards, table, QR modal); the server paints the table card first.
    expect(links).toContain('<div id="links-root" data-island="links"');
    expect(links).toContain('id="links-card"');
    expect(section(html, "cards")).toContain('id="cards-root"');
    // Their cards (#businesses-card, #feedback-card, #feedback-email-card)
    // are the islands' (web/test/businesses, comments, settings).
    expect(section(html, "businesses")).toContain('<div id="businesses-root" data-island="businesses">');
    expect(section(html, "comments")).toContain('<div id="comments-root" data-island="comments">');
    expect(section(html, "settings")).toContain('<div id="settings-root" data-island="settings">');
  });

  it("shows only one section at a time, starting hidden except Links", async () => {
    const html = await serve();
    const tags = [...html.matchAll(/<section class="dash-section" data-section="([a-z]+)"( hidden)?>/g)].map(
      (m) => [m[1], Boolean(m[2])],
    );
    expect(tags).toEqual([
      ["overview", true],
      ["links", false],
      ["cards", true],
      ["businesses", true],
      ["comments", true],
      ["settings", true],
    ]);
  });
});

// ---------------------------------------------------------------------------
// The Cards section (odd/tasks/print-queue-cards.md S4-S6); the print queue
// itself is pinned in web/test/print-queue.test.ts.
// ---------------------------------------------------------------------------

describe("cards section", () => {
  function cardsSection(html: string): string {
    const start = html.indexOf('<section class="dash-section" data-section="cards"');
    return html.slice(start, html.indexOf("</section>", start));
  }

  it("hands the section to the React island (web/src/cards), with no server-rendered controls", async () => {
    const html = await serve();
    const section = cardsSection(html);

    expect(section).toContain('<div class="card" id="cards-root" data-island="cards"></div>');
    for (const id of ["card-sheet", "card-sheets", "cards-controls", "cards-export", "cards-mark-printed"]) {
      expect(section).not.toContain(`id="${id}"`);
    }
    for (const fn of ["renderCardSheets", "exportCards", "markCardsPrinted", "cardOptions", "computeSheetLayout"]) {
      expect(html).not.toContain(`function ${fn}(`);
    }
  });

  it("starts the grid at the top-left margin instead of centring it", async () => {
    const html = await serve();

    expect(html).toMatch(/\.card-sheet\s*\{[^}]*justify-content:\s*start;[^}]*align-content:\s*start;/);
    expect(html).not.toMatch(/\.card-sheet\s*\{[^}]*justify-content:\s*center/);
  });

  it("zooms only the sheets, so the empty-queue message keeps its normal size", async () => {
    const html = await serve();

    expect(html).toMatch(/\.card-sheet\s*\{[^}]*zoom:\s*var\(--card-zoom\);/);
    expect(html).not.toMatch(/#card-sheets\s*\{[^}]*zoom:\s*var\(--card-zoom\)/);
    expect(html).toMatch(/body\.printing-cards \.card-sheet\s*\{[^}]*zoom:\s*1 !important;/);
  });

  it("draws the cut guides above the card, so a mirrored card cannot hide them", async () => {
    const html = await serve();

    // An outline on the card sits under the SVG's own composited layer once
    // the mirror transform promotes it; the guides are an overlay instead.
    expect(html).toMatch(/\.print-card\s*\{[^}]*position:\s*relative;/);
    expect(html).toMatch(/\.print-card\.is-crop::after\s*\{[^}]*position:\s*absolute;/);
    expect(html).toMatch(/\.print-card\.is-crop::after\s*\{[^}]*z-index:\s*2;/);
    expect(html).toMatch(/\.print-card\.is-crop::after\s*\{[^}]*border:\s*0\.25mm dashed var\(--ink-faint\);/);
    expect(html).not.toMatch(/\.print-card\.is-crop\s*\{[^}]*outline:/);
  });

  it("takes the card size from the layout, so no sheet can grow a card past 10×10 cm", async () => {
    const html = await serve();

    expect(html).toMatch(/\.print-card\s*\{[^}]*width:\s*var\(--card-size\);/);
    expect(html).toMatch(/\.print-card\s*\{[^}]*height:\s*var\(--card-size\);/);
    expect(html).toMatch(/:root\s*\{[^}]*--card-size:\s*100mm;/);
  });

  it("lines radio options up like the checkboxes", async () => {
    const html = await serve();

    expect(html).toMatch(/\.check-row input\[type="checkbox"\],\s*\.check-row input\[type="radio"\]\s*\{[^}]*width:\s*1\.125rem;/);
  });

  it("greys out a disabled outline button instead of red text on grey", async () => {
    const html = await serve();

    expect(html).toMatch(/\.btn-outline:disabled\s*\{[^}]*background:\s*transparent;[^}]*color:\s*var\(--ink-faint\);/);
  });

  it("prints only the sheets, at the sheet size, without the preview zoom", async () => {
    const html = await serve();

    expect(html).toContain("body.printing-cards");
    expect(html).toMatch(/body\.printing-cards #card-sheets\s*\{[^}]*zoom:\s*1 !important;/);
    expect(html).toMatch(/\.card-sheet \+ \.card-sheet\s*\{[^}]*break-before:\s*page;/);
  });

  it("keeps the queue itself in the page", async () => {
    const script = codeOnlyHtml(await serve());

    expect(script).not.toContain("/api/links/print-queue");
    expect(script).not.toContain("/api/links/printed");
    expect(script).not.toContain("print_queued: queued");
  });

  it("loads the fonts the cards are drawn with, so the PDF embeds what the preview shows", async () => {
    const html = await serve();

    expect(html).toContain('href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&amp;family=Outfit:wght@400;500;600;700&amp;display=swap"');
  });
});

// ---------------------------------------------------------------------------
// The Links island handoff (odd/tasks/dashboard-react.md T3a)
//
// The table, its row actions and the print queue are React now; their
// behaviour is pinned in web/test/links and web/test/print-queue.test.ts.
// These pin the served side of the seam: the legacy code is gone, and the
// bridges the island calls exist and do what it relies on.
// ---------------------------------------------------------------------------

describe("Links island handoff", () => {
  // The legacy Links functions, the record-action switch and the window
  // print-queue setters went with the page's inline script: the page has none
  // left ("the served document" above).
  it("keeps the queue in the page: the page never calls the print-queue endpoints", async () => {
    const html = codeOnlyHtml(await serve());

    expect(html).not.toContain("/api/links/print-queue");
    expect(html).not.toContain("/api/links/printed");
  });

  it("lends no Links bridge", async () => {
    const html = codeOnlyHtml(await serve());

    // The QR modal is the island's (web/test/links/qr.test.tsx); Cards and
    // Businesses reload the table in-bundle (web/src/links/reload.ts).
    for (const name of ["__showQR", "__loadLinks", "__setPrintQueued", "__clearPrintQueue", "__syncPrintQueue"]) {
      expect(html, name).not.toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// The Overview island handoff (odd/tasks/dashboard-react.md T4, L13)
//
// The print button and the three report cards are React now, each loading its
// own data; their behaviour is pinned in web/test/overview. These pin the
// served side: the mount point, and that nothing of the legacy cards is left.
// ---------------------------------------------------------------------------

describe("Overview island handoff", () => {
  it("serves the overview section as the island's empty mount point", async () => {
    const html = await serve();
    const section = html.slice(
      html.indexOf('<section class="dash-section" data-section="overview" hidden>'),
      html.indexOf('<section class="dash-section" data-section="links">'),
    );

    expect(codeOnlyHtml(section)).toMatch(/^<section[^>]*>\s*<div id="overview-root" data-island="overview"><\/div>\s*<\/section>\s*$/);
    for (const id of ["print-report", "gate-card", "gate-body", "traffic-card", "traffic-body", "clients-card", "clients-body"]) {
      expect(html, id).not.toContain(`id="${id}"`);
    }
  });

  it("lends no Overview bridge and fetches nothing itself", async () => {
    const html = codeOnlyHtml(await serve());

    expect(html).not.toContain("__renderOverviewCards");
    expect(html).not.toContain("__refreshClientsCard");
    // The island fetches these itself (web/test/overview/overview.test.tsx).
    expect(html).not.toContain("/api/traffic/hourly");
    expect(html).not.toContain("/api/clients/metrics");
    expect(html).not.toContain('"/api/review-gate/metrics"');
  });
});

// ---------------------------------------------------------------------------
// The Businesses, Comments and Settings island handoff
// (odd/tasks/dashboard-react.md T5)
//
// The businesses card, the feedback inbox with its filter and CSV export, and
// the feedback email card are React now, and the branches they share are an
// in-bundle store; their behaviour is pinned in web/test/businesses,
// web/test/comments, web/test/settings and web/test/branches. These pin the
// served side: three empty mount points, and nothing of the legacy code or
// its window bridges left.
// ---------------------------------------------------------------------------

describe("Businesses, Comments and Settings island handoff", () => {
  it.each(["businesses", "comments", "settings"])("serves the %s section as the island's empty mount point", async (name) => {
    const html = codeOnlyHtml(await serve());
    const start = html.indexOf(`<section class="dash-section" data-section="${name}" hidden>`);
    expect(start).toBeGreaterThan(-1);
    const section = html.slice(start, html.indexOf("</section>", start) + "</section>".length);

    expect(section).toMatch(
      new RegExp(`^<section[^>]*>\\s*<div id="${name}-root" data-island="${name}"><\\/div>\\s*<\\/section>$`),
    );
  });

  it("serves none of the cards the islands draw", async () => {
    const html = await serve();
    for (const id of [
      "businesses-card", "new-business-name", "add-business", "businesses-msg", "businesses-body",
      "feedback-card", "feedback-export", "feedback-filter", "feedback-export-msg", "feedback-body",
      "feedback-email-card", "feedback-email", "feedback-email-msg", "feedback-email-save",
    ]) {
      expect(html, id).not.toContain(`id="${id}"`);
    }
  });

  it("leaves the endpoints to the islands", async () => {
    const html = codeOnlyHtml(await serve());

    for (const path of ["/api/locations", "/api/businesses", "/api/review-gate/feedback", "/api/tenant/feedback-email"]) {
      expect(html, path).not.toContain(path);
    }
    expect(html).not.toContain("innerHTML");
  });

  it("lends no branches bridge: the lists are the bundle's store", async () => {
    const html = codeOnlyHtml(await serve());

    expect(html).not.toContain("__branches");
    expect(html).not.toContain("__businesses");
    expect(html).not.toContain("brancheschange");
    expect(html).not.toContain("__loadLinks");
  });
});

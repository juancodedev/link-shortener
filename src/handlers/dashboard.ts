import type { Handler } from "hono";
import type { AppEnv, HonoVars } from "../types/env";
import { VISITOR_ESTIMATE_CAVEAT } from "../analytics/metrics";
import { renderGatePanel } from "./gate-panel";
import { resolveMaxActiveLinks } from "../api/links";

// ---------------------------------------------------------------------------
// Shared shell
// ---------------------------------------------------------------------------

function shell(title: string, body: string, supabaseUrl: string, supabaseAnonKey: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Link Shortener</title>
  <style>
    /* ------------------------------------------------------------------
       TOKENS — the single place a literal colour is allowed.

       Values come from the physical world this product lives in: uncoated
       kraft, espresso ink on matte laminate, a terracotta storefront, the
       green "open" light on a chalkboard, amber for the printer that is out.
       Names come from the same place, not from a scale. A person reading only
       --kraft, --sticker, --tag, --live, --retired should be able to guess
       what this is: printed tags mounted in venues, and the states they can be
       in. See odd/analysis/dashboard-directions.md.

       Every value here was checked for contrast against the surface it sits
       on. Warm colours darken faster than cool ones, so that was measured
       rather than eyeballed — see odd/tasks/dashboard-physical-palette.md.
       ------------------------------------------------------------------ */
    :root {
      /* Surfaces — what the tags are physically resting on */
      --kraft: #f4f1ea;        /* the page: uncoated paper */
      --kraft-deep: #ece7dd;   /* inset panels, hover wash, row rules */
      --sticker: #fbf9f5;      /* the printed tag itself: nav, cards, tiles */

      /* Edges — where one surface meets another */
      --edge: #ddd6c8;         /* a cut edge of board, not a cold grey rule */
      --edge-strong: #c4bba9;  /* form fields, outlined buttons */

      /* Ink — five steps, from a heading down to a placeholder */
      --ink: #2b2622;          /* espresso */
      --ink-strong: #1a1613;   /* ink on matte laminate */
      --ink-soft: #6b625a;     /* secondary text, table headers */
      --ink-label: #544c44;    /* form labels */
      --ink-faint: #8d847a;    /* placeholders, disabled, empty states */

      /* The tag — terracotta, the colour of a storefront */
      --tag: #a8482a;
      --tag-deep: #8a3a1f;
      --tag-wash: rgba(168, 72, 42, 0.12);

      /* Lifecycle — a mounted tag is live, stale, or retired */
      --live: #2f6b3a;         /* the green "open" light, seen on a chalkboard */
      --live-wash: #e2eee0;
      --live-edge: #bcd6b8;
      --stale: #8a5a12;        /* amber: the light that means the printer is out */
      --stale-wash: #f7ecd4;
      --retired: #a13325;      /* oxblood: destructive fill */
      --retired-deep: #7d2519;
      --retired-ink: #8c2f21;
      --retired-wash: #f6e4df;
      --retired-edge: #e0b8ae;

      /* Chrome — the location bar that sits above everything */
      --chrome: #241f1b;
      --chrome-ink: #f4f1ea;

      /* Depth — a shadow on a warm surface picks up that surface's colour,
         so these are tinted espresso rather than the neutral black they were. */
      --shadow-card: rgba(43, 38, 34, 0.06);
      --shadow-modal: rgba(43, 38, 34, 0.18);
      --veil: rgba(36, 31, 27, 0.45);

      /* Peak chart — the two segments of each scan bucket */
      --peak-public: #9c8d74;  /* brass */
      --peak-private: var(--ink);
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: var(--kraft);
      color: var(--ink);
      line-height: 1.6;
      min-height: 100dvh;
    }
    .container {
      max-width: 720px;
      margin: 0 auto;
      padding: 1rem;
    }
    @media (min-width: 768px) {
      .container { padding: 1.5rem; }
    }
    nav {
      background: var(--sticker);
      border-bottom: 1px solid var(--edge);
      padding: 0.5rem 1rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.25rem;
    }
    @media (min-width: 768px) {
      nav { padding: 0.75rem 1.5rem; }
    }
    nav h2 { font-size: 1.125rem; color: var(--ink-strong); }
    nav a, nav button {
      font-size: 0.813rem;
      color: var(--ink-soft);
      text-decoration: none;
      background: none;
      border: none;
      cursor: pointer;
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
    }
    nav a:hover, nav button:hover { color: var(--tag); background: var(--kraft-deep); }
    .card {
      background: var(--sticker);
      border: 1px solid var(--edge);
      border-radius: 0.75rem;
      padding: 1.5rem;
      margin-top: 1.5rem;
      box-shadow: 0 1px 3px var(--shadow-card);
    }
    h3 {
      font-size: 1rem;
      font-weight: 700;
      color: var(--ink-strong);
      margin-bottom: 1rem;
    }
    label {
      display: block;
      font-size: 0.813rem;
      font-weight: 600;
      color: var(--ink-label);
      margin-bottom: 0.25rem;
    }
    /* Qualifies the field above it, in the token layer's own faint ink — the
       same step the placeholders use, because it is the same register: a hint,
       not content. */
    .field-help {
      margin: -0.5rem 0 1rem;
      font-size: 0.813rem;
      line-height: 1.5;
      color: var(--ink-faint);
    }
    input, select {
      width: 100%;
      padding: 0.5rem 0.75rem;
      border: 1.5px solid var(--edge-strong);
      border-radius: 0.5rem;
      font-size: 0.875rem;
      margin-bottom: 1rem;
    }
    input:focus, select:focus {
      outline: none;
      border-color: var(--tag);
      box-shadow: 0 0 0 3px var(--tag-wash);
    }
    button {
      padding: 0.625rem 1.25rem;
      background: var(--tag);
      color: var(--sticker);
      border: none;
      border-radius: 0.5rem;
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { background: var(--tag-deep); }
    button:disabled { background: var(--ink-faint); cursor: not-allowed; }
    .btn-sm {
      padding: 0.25rem 0.75rem;
      font-size: 0.75rem;
      border-radius: 0.375rem;
    }
    .btn-danger { background: var(--retired); }
    .btn-danger:hover { background: var(--retired-deep); }
    .btn-outline {
      background: transparent;
      color: var(--tag);
      border: 1px solid var(--edge-strong);
    }
    .btn-outline:hover { background: var(--kraft-deep); }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.813rem;
    }
    th {
      text-align: left;
      color: var(--ink-soft);
      font-weight: 600;
      padding: 0.5rem 0.75rem;
      border-bottom: 1px solid var(--edge);
    }
    td {
      padding: 0.5rem 0.75rem;
      border-bottom: 1px solid var(--kraft-deep);
      vertical-align: middle;
    }
    tr:hover td { background: var(--kraft); }
    .code {
      font-family: "SF Mono", "Fira Code", monospace;
      color: var(--tag);
      font-weight: 600;
      cursor: pointer;
    }
    .url-trunc {
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      display: inline-block;
    }
    .badge {
      display: inline-block;
      padding: 0.125rem 0.5rem;
      border-radius: 9999px;
      font-size: 0.688rem;
      font-weight: 600;
    }
    .badge-active { background: var(--live-wash); color: var(--live); }
    .badge-inactive { background: var(--retired-wash); color: var(--retired-ink); }
    .badge-expired { background: var(--stale-wash); color: var(--stale); }
    .table-wrap {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      margin: 0 -1rem;
      padding: 0 1rem;

      /* Scroll affordance.
         This container scrolls, but on a platform with overlay scrollbars
         there is nothing on screen saying so — which is how Disable and Del
         ended up off-screen with no hint. At narrow widths a five-column table
         still needs more room than a phone has, and that is Direction B's job
         to fix; what this layer fixes is that the overflow is now DISCOVERABLE.

         Four layers. The two local ones scroll WITH the content, so they
         cover the two scroll ones once you reach that end — so each fade
         only appears while there is more table in that direction. */
      background-image:
        linear-gradient(to right, var(--sticker), transparent),
        linear-gradient(to left, var(--sticker), transparent),
        linear-gradient(to right, var(--shadow-card), transparent),
        linear-gradient(to left, var(--shadow-card), transparent);
      background-position: left center, right center, left center, right center;
      background-repeat: no-repeat;
      background-size: 24px 100%, 24px 100%, 14px 100%, 14px 100%;
      background-attachment: local, local, scroll, scroll;
    }
    @media (min-width: 768px) {
      .table-wrap { margin: 0; padding: 0; }
    }
    .message {
      font-size: 0.813rem;
      padding: 0.5rem 0.75rem;
      border-radius: 0.375rem;
      margin: 1rem 0;
      display: none;
    }
    .message.success { display: block; background: var(--live-wash); color: var(--live); border: 1px solid var(--live-edge); }
    .message.error { display: block; background: var(--retired-wash); color: var(--retired-ink); border: 1px solid var(--retired-edge); }
    .row-actions { display: flex; gap: 0.25rem; flex-wrap: wrap; }
    @media (min-width: 768px) { .row-actions { gap: 0.375rem; } }
    .empty { text-align: center; color: var(--ink-faint); padding: 2rem; }
    .empty-cell { color: var(--ink-faint); text-align: center; }
    .loading { text-align: center; color: var(--ink-faint); padding: 1rem; }
    .metrics-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 0.5rem;
      margin-top: 0.5rem;
    }
    @media (min-width: 768px) {
      .metrics-grid { grid-template-columns: 1fr 1fr 1fr; gap: 1rem; }
    }
    .metric-box {
      background: var(--kraft);
      border: 1px solid var(--edge);
      border-radius: 0.5rem;
      padding: 0.75rem;
    }
    .metric-box h4 {
      font-size: 0.688rem;
      text-transform: uppercase;
      color: var(--ink-faint);
      margin-bottom: 0.5rem;
    }
    .metric-row {
      display: flex;
      justify-content: space-between;
      font-size: 0.75rem;
      padding: 0.125rem 0;
    }
    .estimate-note {
      font-size: 0.688rem;
      line-height: 1.5;
      color: var(--ink-soft);
      margin-top: 0.625rem;
      padding-top: 0.5rem;
      border-top: 1px dashed var(--edge);
    }
    .visitors-box { margin-bottom: 1rem; }
    .visitors-pair {
      display: grid;
      grid-template-columns: 1fr;
      gap: 0.25rem 1rem;
    }
    @media (min-width: 768px) {
      .visitors-pair { grid-template-columns: 1fr 1fr; }
    }

    /* Review-gate panel: stat tiles + a CSS bar chart. Bars rather than a
       charting library because this screen is screenshotted and forwarded as
       the monthly report — a canvas or SVG chart renders as a blank box in a
       headless screenshot, and self-contained DOM bars do not. */
    .stat-tiles {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr));
      gap: 0.625rem;
      margin-bottom: 1rem;
    }
    .stat-tile {
      border: 1px solid var(--edge);
      border-radius: 0.5rem;
      padding: 0.625rem 0.75rem;
      background: var(--sticker);
    }
    .stat-tile .label {
      font-size: 0.688rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--ink-soft);
      margin-bottom: 0.125rem;
    }
    .stat-tile .value {
      font-size: 1.5rem;
      font-weight: 600;
      line-height: 1.2;
      color: var(--ink);
    }
    .stat-tile .sub {
      font-size: 0.688rem;
      color: var(--ink-soft);
      margin-top: 0.125rem;
    }
    .stat-tile .value.withheld {
      font-size: 0.938rem;
      font-weight: 500;
      color: var(--ink-faint);
    }
    .peak-chart {
      display: flex;
      align-items: flex-end;
      gap: 2px;
      height: 5rem;
      padding-top: 0.5rem;
      border-bottom: 1px solid var(--edge);
    }
    .peak-bar {
      flex: 1 1 0;
      min-width: 2px;
      background: transparent;
      border-radius: 1px 1px 0 0;
      position: relative;
    }
    .peak-seg {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
    }
    .peak-seg-rest { background: var(--peak-private); }
    .peak-seg-public { background: var(--peak-public); }
    .peak-axis {
      display: flex;
      justify-content: space-between;
      font-size: 0.688rem;
      color: var(--ink-faint);
      margin-top: 0.25rem;
    }

    /* Gate panel sub-headings and empty state. Shared with
       src/handlers/gate-panel.ts, which emits these classes. */
    .gate-h {
      margin: 1.25rem 0 0.5rem;
      font-size: 0.875rem;
      color: var(--ink-soft);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .gate-h:first-child { margin-top: 0; }
    .gate-empty { color: var(--ink-soft); font-size: 0.875rem; }
    .gate-empty-note { border-top: 0; padding-top: 0; margin-top: 0; }
    .rating-of { font-size: 0.875rem; color: var(--ink-soft); }

    /* The location bar is injected by script into document.body. It used to
       carry its own inline cssText blob, which meant its colours could not be
       reached by the tokens. */
    .tenant-bar {
      position: sticky;
      top: 0;
      z-index: 50;
      background: var(--chrome);
      color: var(--chrome-ink);
      padding: 0.6rem 1rem;
      display: flex;
      gap: 0.75rem;
      align-items: center;
      font-size: 0.9rem;
    }
    .tenant-bar label { margin-bottom: 0; color: var(--chrome-ink); }
    .tenant-bar select {
      padding: 0.3rem;
      border-radius: 6px;
      border: 0;
      margin-bottom: 0;
    }

    .qr-modal {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: var(--veil);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
    }
    .qr-modal.hidden { display: none; }
    .qr-card {
      background: var(--sticker);
      border-radius: 0.75rem;
      padding: 1.5rem;
      text-align: center;
      box-shadow: 0 4px 24px var(--shadow-modal);
    }
    .qr-title { margin-bottom: 0.5rem; }
    .qr-img { max-width: 200px; }
    .qr-url {
      font-size: 0.75rem;
      color: var(--ink-soft);
      margin-top: 0.5rem;
      word-break: break-all;
    }

    /* Small shared utilities that used to be inline style attributes.
       Only the ones no script touches: a display:none stays inline, because
       loadLinks toggles those elements through .style.display. */
    .nav-email { font-size: 0.813rem; color: var(--ink-soft); margin-right: 0.75rem; }
    .caption { font-size: 0.813rem; color: var(--ink-soft); }
    .caption-sm { font-size: 0.75rem; color: var(--ink-soft); }
    .short-url { background: var(--kraft); cursor: pointer; }
    .clicks-link { color: var(--tag); text-decoration: none; font-weight: 600; }
    .client-ref-input {
      width: 130px;
      padding: 0.25rem 0.5rem;
      margin-bottom: 0;
      border-radius: 0.375rem;
      font-size: 0.75rem;
    }
    .panel-pad { padding: 0.75rem; }
    .flush-cell { padding: 0; }

    /* Controls that moved out of the links row into the metrics panel.
       They are a set of independent fields, not a row of equal-weight
       buttons, so they stack as a grid on narrow screens. */
    .panel-controls {
      display: grid;
      grid-template-columns: 1fr;
      gap: 0.75rem;
      margin-bottom: 0.75rem;
    }
    @media (min-width: 640px) {
      .panel-controls { grid-template-columns: 1fr 1fr 1fr; gap: 1rem; }
    }
    .panel-controls label { margin-bottom: 0.25rem; }
    .field-row { display: flex; gap: 0.375rem; align-items: center; }
    .panel-controls .client-ref-input {
      width: auto;
      flex: 1 1 auto;
      min-width: 0;
      margin-bottom: 0;
    }
    .panel-controls button { flex: 0 0 auto; }
    .field-note {
      font-size: 0.688rem;
      line-height: 1.5;
      color: var(--ink-soft);
      margin-top: 0.375rem;
    }
    .gap-top { margin-top: 1rem; }
    .gap-top-sm { margin-top: 0.5rem; }
  </style>
</head>
<body>
  <nav>
    <h2>⚡ Link Shortener</h2>
    <div>
      <span id="nav-email" class="nav-email"></span>
      <a href="/">Home</a>
      <button id="logout-nav">Log Out</button>
    </div>
  </nav>
  <div class="container">
    ${body}
  </div>
  <script src="https://unpkg.com/@supabase/supabase-js@2"></script>
  <script>
    (async () => {
      if (!window.supabase) return;
      var sb = window.supabase.createClient("${supabaseUrl}", "${supabaseAnonKey}");

      const { data: { session } } = await sb.auth.getSession();
      if (!session) { window.location.href = "/login"; return; }

      document.getElementById("nav-email").textContent = session.user.email;
      document.getElementById("logout-nav").addEventListener("click", async () => {
        await sb.auth.signOut();
        window.location.href = "/";
      });

      window.__sb = sb;
      window.__token = session.access_token;

      // Defined before __api can reach it: __api calls this synchronously on a
      // 409, and loadLinks() runs at the end of this IIFE.
      window.__showTenantPicker = function (available) {
        var host = document.getElementById("tenant-picker");
        if (!host) {
          host = document.createElement("div");
          host.id = "tenant-picker";
          document.body.insertBefore(host, document.body.firstChild);
        }
        var current = null;
        try { current = window.localStorage.getItem("tenant"); } catch (e) {}

        var opts = available.map(function (t) {
          var sel = t.slug === current ? " selected" : "";
          return '<option value="' + String(t.slug).replace(/"/g, "&quot;") + '"' + sel + ">" +
                 String(t.displayName || t.slug).replace(/[<>&]/g, "") + " (" + String(t.role) + ")</option>";
        }).join("");

        host.innerHTML =
          '<div class="tenant-bar"><label for="tenant-select">Ubicaci&oacute;n</label>' +
          '<select id="tenant-select">' + opts + "</select></div>";

        // The bar used to be styled from here with an inline cssText blob
        // carrying its own hardcoded colours, which put two of them outside the
        // reach of the token layer. It is a real rule now (see .tenant-bar), so
        // the markup above is the only thing this function needs to produce.
        var sel = document.getElementById("tenant-select");
        sel.onchange = function () {
          try { window.localStorage.setItem("tenant", sel.value); } catch (e) {}
          window.location.reload();
        };
        window.scrollTo(0, 0);
      };
      window.__api = async function(method, path, body) {
        const headers = { "Content-Type": "application/json", "Authorization": "Bearer " + window.__token };

        // Which location this call is about. Resolved from the URL first so a
        // shared dashboard link opens the right store, then from the last
        // choice. Absent for a single-location user, who never sees it.
        var q = new URLSearchParams(window.location.search).get("tenant");
        if (!q) { try { q = window.localStorage.getItem("tenant"); } catch (e) { q = null; } }
        if (q) headers["X-Tenant-Slug"] = q;

        // no-store, because the server already sends it, and because deleting a
        // link has to visibly remove its row.
        //
        // The header is the contract; this is the belt to its braces. A GET that
        // follows a mutation must never be answered from a cache holding the
        // list as it was BEFORE the mutation — which is exactly what happened,
        // and exactly why a hard refresh was the only thing that worked: a hard
        // refresh is the browser's own way of saying no-cache.
        const res = await fetch(path, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          cache: "no-store",
        });
        if (res.status === 401) { window.location.href = "/login"; throw new Error("Unauthorized"); }

        // Several locations and none chosen. The API refuses rather than
        // guessing — guessing was the bug Phase 4 removed — so the client has
        // to choose. This is the only way a multi-store user ever sees 409.
        if (res.status === 409) {
          let payload = null;
          try { payload = await res.json(); } catch (e) {}
          if (payload && payload.error === "tenant_required" && Array.isArray(payload.available)) {
            window.__showTenantPicker(payload.available);
            throw new Error("tenant_required");
          }
        }

        if (!res.ok) {
          let msg = "Server error";
          try { const e = await res.json(); msg = e.error || msg; } catch {}
          throw new Error(msg);
        }
        return res;
      };

      // Open the readiness gate LAST, once the helper it guards actually
      // exists. Every loadLinks() caller suspended on this promise resumes here
      // and finds a callable window.__api, however early it was invoked.
      // Resolving it any earlier — on the session, before the assignment — would
      // hand every waiter straight back the race this gate exists to close.
      //
      // The unauthenticated branch above returns WITHOUT resolving: the browser
      // is already navigating to /login, and a load started there could only
      // fail. Leaving waiters parked is the honest outcome, not a leak.
      window.__apiReadyResolve?.();

      if (typeof loadLinks === "function") loadLinks();
    })();
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Dashboard handler
// ---------------------------------------------------------------------------

export const dashboardHandler: Handler<{ Bindings: AppEnv; Variables: HonoVars }> = (c) => {
  // The cap is configuration now (T3.1), so the counter reads it from the same
  // source the API enforces it from. Hardcoding a second copy here would let the
  // UI promise a quota the server does not honour — the user would create links
  // until the dashboard stopped counting and never learn why.
  const activeLinkLimit = resolveMaxActiveLinks(c.env);

  const body = `
    <div class="card">
      <h3>Create Short Link</h3>
      <form id="create-form">
        <label for="url">Destination URL</label>
        <!--
          NOT required.

          Card stock is manufactured before its destination exists: the owner
          creates the link, the designer prints the short_code as a QR, and the
          real URL is loaded later. \`required\` would block that at the
          browser and leave the API able to do something the form cannot reach.

          The field stays first and stays labelled. Leaving it blank is a
          deliberate act, not a default, and the help text says what it means —
          an accidental empty submit should not silently create a card that
          points nowhere.
        -->
        <input type="text" id="url" placeholder="example.com or https://...">
        <p class="field-help">Leave empty to create a card first and add its destination later. Until you do, its QR opens a \"not configured\" page.</p>
        <label for="slug">Custom short code (optional)</label>
        <!--
          Pre-printed tags. A sticker is printed ONCE and lives in the world for
          months, so the code on it must be one the user chose deliberately —
          \`cafe-central\` is meaningful to a store owner in a way \`x7f3b2q\` is not.
          Leaving this blank falls back to a random code, exactly as before.

          The rules (3-32 chars, letters/digits/-/_ only, no leading or trailing
          hyphen, not an app route) are enforced server-side in
          src/utils/short-code.ts; this pattern only helps the user see the shape
          before they hit the error.
        -->
        <input type="text" id="slug" placeholder="cafe-central" maxlength="32" pattern="[A-Za-z0-9_-]+">
        <label for="title">Title (optional)</label>
        <input type="text" id="title" placeholder="My awesome link" maxlength="200">
        <button type="submit">Shorten</button>
      </form>
      <div id="create-msg" class="message"></div>
      <div id="result" class="gap-top" style="display:none;">
        <p class="caption">Your short link:</p>
        <input type="text" id="short-url" readonly class="short-url" onclick="this.select();navigator.clipboard.writeText(this.value)">
      </div>
      <!--
        Card stock is a different job from shortening a URL, so it gets its own
        entry point rather than an option on this form. An owner making a hundred
        stickers does not want a hundred submissions.
      -->
      <hr style="margin:1.25rem 0;border:none;border-top:1px solid var(--edge);">
      <button type="button" id="open-bulk" class="btn-sm btn-outline">
        Create cards in bulk...
      </button>
    </div>

    <div class="card">
      <h3>Your Links (<span id="link-count">0</span>/${activeLinkLimit})</h3>
      <div id="links-loading" class="loading">Loading...</div>
      <div class="table-wrap">
      <table id="links-table" style="display:none;">
        <thead>
          <tr>
            <th>Short Code</th>
            <th>URL</th>
            <th>Clicks</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="links-body"></tbody>
      </table>
      </div>
      <div id="links-empty" class="empty" style="display:none;">
        No links yet. Create your first one above!
      </div>
      <!--
        Server-rendered, not injected by script, and not behind a tooltip.

        This is the whole point of the caveat's placement: a store owner acts on
        the visitor number, so the limitation has to be on the page before they
        expand anything and look for it. A note hidden behind a hover, a
        disclosure, or a README is a note nobody reads — and a bare "42 unique
        visitors" is worse than no figure at all, because someone will make a
        decision with it. The sentence lives beside the constants it qualifies
        in src/analytics/metrics.ts so the two cannot drift apart.
      -->
      <p class="estimate-note"><strong>About visitor figures:</strong> ${VISITOR_ESTIMATE_CAVEAT}</p>
    </div>

    <div class="card" id="clients-card" style="display:none;">
      <h3>Stores by Client Ref</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Client Ref</th>
              <th>Unique Visitors</th>
              <th>Sessions</th>
            </tr>
          </thead>
          <tbody id="clients-body"></tbody>
        </table>
      </div>
      <!-- Same caveat, next to the store-level rollup. -->
      <p class="estimate-note">${VISITOR_ESTIMATE_CAVEAT}</p>
    </div>

    <!-- Review gate. Presentable as a screenshot on purpose: this screen is
         what the owner forwards as their monthly report, so every figure here
         carries its own qualification in the markup rather than in a tooltip
         that a screenshot would not capture. -->
    <div class="card" id="gate-card" style="display:none;">
      <h3>Customer satisfaction</h3>
      <div id="gate-body"><div class="loading">Loading...</div></div>
    </div>

    <!-- QR code modal -->
    <div id="qr-modal" class="qr-modal hidden" onclick="this.classList.add('hidden')">
      <div class="qr-card" onclick="event.stopPropagation()">
        <h3 class="qr-title">QR Code</h3>
        <img id="qr-img" src="" alt="QR Code" class="qr-img">
        <p id="qr-url" class="qr-url"></p>
        <!--
          PRINT-SHEET ENTRY POINT (T3.4).

          The whole point of this phase is a URL that goes on a sticker. The modal
          already DISPLAYS that URL, but a <p> is not something a user can
          usefully copy: selecting it by hand, with a word-break to dodge, is
          exactly the friction that ends with a mistyped code on a sticker.

          So the one action the user came here for is a real control. It copies
          the URL from the DOM — never from a re-derived string — so what lands
          on the sticker is byte-for-byte what the QR image encodes.

          Wired with addEventListener, NOT onclick="...". No inline handler is
          added anywhere in this file: an attribute body is handed to the JS
          engine, where the HTML entities esc() emits are ordinary characters
          that terminate nothing. The pre-existing inline handlers on the modal
          chrome are static and carry no record data; this one is not that.
        -->
        <button id="copy-print-sheet" class="btn-sm btn-outline gap-top-sm">Copy URL for print sheet</button>
        <button class="btn-sm gap-top-sm" onclick="document.getElementById('qr-modal').classList.add('hidden')">Close</button>
      </div>
    </div>

    <!--
      MANUFACTURING CARD STOCK IN BULK.

      One card at a time is the wrong shape for the job. An owner making a
      hundred stickers does not want a hundred form submissions; they want to
      say "ten of these" and receive a print sheet they can hand to a designer.

      This creates them WITHOUT a destination, which is the state the whole flow
      depends on: the QR goes on the card now and the review URL is loaded later,
      when it is settled. A card created with a destination already filled in
      commits the owner to knowing the URL before the sticker exists.

      The modal asks for a COUNT and nothing else. Every field the create form
      has — title, client_ref, location — is per-card by nature, and pretending
      otherwise would mean inventing a bulk meaning for each one. Those stay on
      the row, editable after the fact.

      Deliberately NOT wired through data-action: that switch is for record
      actions, and this acts on no record. It is a static button with a static
      listener, which is the same discipline the create form follows.
    -->
    <div id="bulk-modal" class="qr-modal hidden" onclick="this.classList.add('hidden')">
      <div class="qr-card" onclick="event.stopPropagation()" style="max-width:26rem;">
        <h3 class="qr-title">Create cards in bulk</h3>
        <p class="field-help">
          Each card gets its own QR and no destination yet. Print them, and load
          the real URL whenever it is settled — until then, scanning a card
          opens a \"not configured\" page rather than a broken link.
        </p>
        <label for="bulk-count">How many cards</label>
        <input type="number" id="bulk-count" min="1" max="200" step="1" value="10">
        <div id="bulk-msg" class="message"></div>
        <div id="bulk-result" style="display:none;">
          <p class="caption" id="bulk-summary"></p>
          <button type="button" id="bulk-download" class="btn-sm btn-primary gap-top-sm">
            Download print sheet (.zip)
          </button>
          <p class="field-help">
            One SVG per card plus a links.csv listing them. The cards go straight
            to your designer.
          </p>
        </div>
        <div class="gap-top-sm" style="display:flex;gap:.5rem;">
          <button type="button" id="bulk-create" class="btn-sm btn-primary">Create them</button>
          <button class="btn-sm gap-top-sm" onclick="document.getElementById('bulk-modal').classList.add('hidden')">Close</button>
        </div>
      </div>
    </div>

    <script>
      /**
       * The esbuild runtime shim.
       *
       * \`renderGatePanel.toString()\` below serialises the ALREADY-BUNDLED
       * function, because the Worker this handler ships in was compiled by
       * esbuild with \`keepNames: true\` — which rewrites every named function
       * inside the body to a \`__name(fn, "fn")\` statement. Those statements
       * ride along in the stringified source and then execute HERE.
       *
       * \`__name\` is defined at the top of the Worker bundle, in module scope,
       * so it does not exist in this page. Without this line the very first
       * call throws \`ReferenceError: __name is not defined\` and the gate panel
       * never renders.
       *
       * This is the same helper, byte for byte, that esbuild's own browser
       * runtime declares. It is not a no-op shim: function declarations already
       * carry their own \`.name\`, but an arrow assigned to a variable does not,
       * so this preserves the names esbuild is preserving for a reason.
       *
       * \`var\`, not \`const\`, to match esbuild: the call sites are inside the
       * panel body and must resolve through the global object.
       */
      var __name = (target, value) =>
        Object.defineProperty(target, "name", { value, configurable: true });

      const renderGatePanel = ${renderGatePanel.toString()};
      /**
       * Readiness gate for the auth bootstrap.
       *
       * This script is parsed BEFORE the shell's Supabase bootstrap, and that
       * bootstrap suspends on \`await sb.auth.getSession()\` — a network round
       * trip. So window.__api does not exist yet while this script runs, and
       * anything that reached for it at parse time died on
       * "window.__api is not a function".
       *
       * The dependency is real, so it is expressed as a dependency: loadLinks
       * awaits this promise, and the bootstrap resolves it once the helper is
       * defined. A bare loadLinks() call here is gone because it was never
       * right — this script can only wire things up, the load belongs to the
       * bootstrap that owns the session. A setTimeout would have hidden the
       * race rather than closing it, and would flake differently under load.
       *
       * Created HERE, ahead of the bootstrap script, so a caller running at
       * parse time finds the gate rather than undefined.
       */
      window.__apiReady = new Promise((resolve) => { window.__apiReadyResolve = resolve; });

      /**
       * Copies the QR modal's URL to the clipboard — the print-sheet handoff.
       *
       * Reads #qr-url's textContent rather than rebuilding the URL, so the
       * copied string cannot drift from the one the QR image encodes. showQR
       * writes that element with textContent (never innerHTML), so what is read
       * back here is the plain URL and not markup.
       */
      document.getElementById("copy-print-sheet").addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        const url = document.getElementById("qr-url").textContent;
        if (!url) return;
        try {
          await navigator.clipboard.writeText(url);
          const original = btn.textContent;
          btn.textContent = "Copied!";
          setTimeout(() => { btn.textContent = original; }, 1500);
        } catch {
          // Clipboard access can be refused; surfacing the text beats a silent
          // no-op, because the user's next move is to hand-write the code on a
          // sticker and a typo there is unrecoverable.
          alert("Copy failed — select the URL above and copy it manually.");
        }
      });

      document.getElementById("create-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = e.target.querySelector("button");
        const msg = document.getElementById("create-msg");
        const result = document.getElementById("result");
        btn.disabled = true;
        btn.textContent = "Creating...";
        msg.className = "message";
        result.style.display = "none";

        try {
          // A blank slug field means "generate one for me" and must stay
          // optional, so it is sent as undefined rather than as "". The server
          // treats an explicit empty string as absent too, but a client should
          // not lean on that when it can simply omit the key.
          const slugValue = document.getElementById("slug").value.trim();

          // A blank destination is OMITTED, not sent as "". The server treats "" as
          // absent too, but omitting states the intent at the boundary rather
          // than relying on a coercion the reader has to go and find. This is
          // what makes card stock creatable from the form.
          const urlValue = document.getElementById("url").value.trim();

          const res = await window.__api("POST", "/api/links", {
            ...(urlValue ? { original_url: urlValue } : {}),
            title: document.getElementById("title").value || undefined,
            slug: slugValue || undefined,
          });

          if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || "Failed to create link");
          }

          const data = await res.json();
          document.getElementById("short-url").value = data.short_url;
          result.style.display = "";
          document.getElementById("url").value = "";
          document.getElementById("title").value = "";
          document.getElementById("slug").value = "";
          msg.className = "message success";
          // A card and a link are different objects, and saying "Link created!" for one
          // that has nowhere to point yet is a small lie the owner discovers
          // later, when a customer scans the sticker. Name the state instead.
          msg.textContent = data.original_url
            ? "Link created! Copied to clipboard."
            : "Card created! Its QR opens a 'not configured' page until you add a destination.";
          navigator.clipboard.writeText(data.short_url);
          loadLinks();
        } catch (err) {
          msg.className = "message error";
          msg.textContent = err instanceof Error ? err.message : "Error";
        } finally {
          btn.disabled = false;
          btn.textContent = "Shorten";
        }
      });

      // ---------------------------------------------------------------------
      // Bulk card creation
      //
      // The count is the only input, and that is deliberate: every other field
      // on a link is per-card by nature, and inventing a bulk meaning for each
      // would be inventing vocabulary the product does not have. They stay
      // editable on the row afterwards.
      //
      // The generated ids are kept in module scope rather than in the DOM,
      // because the download button needs them and a data-* attribute would be
      // a second copy of the same list that could drift out of sync with it.
      // ---------------------------------------------------------------------
      // >>> BULK BLOCK — the dashboard test scopes its row-action assertion to
      // exactly this range.
      let bulkIds = [];

      document.getElementById("open-bulk").addEventListener("click", () => {
        bulkIds = [];
        document.getElementById("bulk-result").style.display = "none";
        const msg = document.getElementById("bulk-msg");
        msg.className = "message";
        msg.textContent = "";
        document.getElementById("bulk-modal").classList.remove("hidden");
      });

      document.getElementById("bulk-create").addEventListener("click", async () => {
        const btn = document.getElementById("bulk-create");
        const msg = document.getElementById("bulk-msg");
        const count = parseInt(document.getElementById("bulk-count").value, 10);

        // Validated here as well as on the server: the server is what makes it
        // safe, but a button that does nothing for ten seconds because the count
        // was 0 teaches the owner that the button is broken.
        if (!Number.isInteger(count) || count < 1 || count > 200) {
          msg.className = "message error";
          msg.textContent = "Enter a number between 1 and 200.";
          return;
        }

        btn.disabled = true;
        btn.textContent = "Creating...";
        msg.className = "message";
        msg.textContent = "";

        try {
          // No destination, and \`is_gated\` on: a card whose QR forwards
          // straight past the gate records nothing, and the panel this product
          // is measured by would stay empty.
          const links = Array.from({ length: count }, () => ({ is_gated: true }));
          const res = await window.__api("POST", "/api/links/batch", { links });

          const body = await res.json();
          // A partial batch is reported, never treated as success. Nine of ten
          // cards is a shortfall the owner discovers at the printer.
          const created = (body.results || []).filter((r) => r.status === 201);

          if (!res.ok && !created.length) {
            throw new Error(body.error || "Could not create the cards");
          }

          bulkIds = created.map((r) => r.link.id);

          document.getElementById("bulk-result").style.display = "";
          const failed = (body.results || []).length - created.length;
          document.getElementById("bulk-summary").textContent =
            created.length + (created.length === 1 ? " card created. " : " cards created. ") +
            (failed ? failed + " failed — try those again." : "");

          msg.className = failed ? "message error" : "message success";
          if (!failed) msg.textContent = "";
          loadLinks();
        } catch (err) {
          msg.className = "message error";
          msg.textContent = err instanceof Error ? err.message : "Error";
        } finally {
          btn.disabled = false;
          btn.textContent = "Create them";
        }
      });

      document.getElementById("bulk-download").addEventListener("click", async () => {
        const msg = document.getElementById("bulk-msg");

        if (!bulkIds.length) {
          msg.className = "message error";
          msg.textContent = "Create the cards first.";
          return;
        }

        try {
          // Through __api, NOT a hand-rolled fetch.
          //
          // This handler used to do its own fetch with its own headers, reading
          // the token from localStorage. The dashboard keeps it on window.__token,
          // so the sheet request went out as
          // an empty bearer token and came back 401, while the create (which
          // does go through the helper) had already succeeded: the modal
          // cheerfully claimed ten cards existed and none could be printed.
          //
          // __api returns the response rather than a parsed body, so a blob
          // downloads through it unchanged — and the 401-to-login redirect, the
          // 409 tenant picker, and the server's own error text all come along
          // instead of being reimplemented slightly wrong.
          const res = await window.__api("POST", "/api/links/qr-sheet.zip", {
            link_ids: bulkIds,
          });

          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = "cards.zip";
          document.body.appendChild(a);
          a.click();
          a.remove();
          // Revoked immediately after the click: the download has already been
          // handed to the browser, and leaving the object URL alive pins the
          // whole ZIP in memory for the life of the tab.
          URL.revokeObjectURL(url);
        } catch (err) {
          msg.className = "message error";
          msg.textContent = err instanceof Error ? err.message : "Error";
        }
      });
      // <<< BULK BLOCK

      /**
       * Renders the two visitor figures for one link.
       *
       * Deliberately NOT the \`([k, v]) => ...\` breakdown mapper: these two are
       * not a key/value breakdown, they are the headline pair, and giving them
       * their own renderer keeps the invariant that every such shape is
       * escaped rather than assuming the breakdown mapper was reused.
       *
       * EQUAL WEIGHT, ON PURPOSE. The product decision is that neither figure
       * is the "real" one: \`unique_visitors\` answers "how many people came
       * back", \`sessions\` answers "how many separate visits". Presenting one as
       * the primary number and the other as a footnote would smuggle in a
       * hierarchy the user explicitly rejected. Same markup, same weight, both
       * qualified by the caveat baked into the panel around them.
       *
       * The window labels come from the API response rather than being written
       * here, so the text can never describe a different window than the SQL
       * actually used. \`?? 0\` matters: a bare missing value would render the
       * string "undefined" next to a real number, which reads as a measurement
       * rather than as an absence.
       */
      function renderVisitors(data) {
        const uniqueWindow = data.unique_window || "1 day";
        const sessionWindow = data.session_window || "30 minutes";
        return \`<div class="metric-row"><span>Unique visitors (last \${esc(uniqueWindow)})</span><strong>\${esc(data.unique_visitors ?? 0)}</strong></div>
                <div class="metric-row"><span>Sessions (per \${esc(sessionWindow)})</span><strong>\${esc(data.sessions ?? 0)}</strong></div>\`;
      }

      /**
       * Renders the per-store rollup.
       *
       * \`client_ref\` is the identifier the user types per store, so it is user
       * data from a Referer-adjacent source: it passes through esc() like every
       * other record field. The caveat above this table is static server
       * markup, so it is already on the page before a row renders.
       */
      function renderClients(clients) {
        if (!clients || clients.length === 0) {
          return "<tr><td colspan=\\"3\\" class=\\"empty-cell\\">No client identifiers yet — set one on a link to see store-level visitors.</td></tr>";
        }
        return clients.map((c) => \`<tr>
          <td><span class="code">\${esc(c.client_ref)}</span></td>
          <td>\${esc(c.unique_visitors)}</td>
          <td>\${esc(c.sessions)}</td>
        </tr>\`).join("");
      }

      /**
       * Escapes a value for interpolation into innerHTML or a double-quoted
       * attribute value.
       *
       * The links table and the metric panels are both built by assigning a
       * string to innerHTML, so every interpolated value is an injection
       * vector. This helper is the only sanctioned way to put record data into
       * markup: short_code, original_url, clicks_count, client_ref, and the
       * click-breakdown keys and counts all pass through it.
       *
       * It is NOT a defence for JavaScript context. An onclick="..." body is
       * handed to the JS engine, where &quot; and &#39; are ordinary characters
       * that terminate nothing — so the table carries no inline handlers at
       * all, and values reach JS through data-* attributes read via \`dataset\`.
       */
      function esc(value) {
        if (value === null || value === undefined) return "";
        return String(value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }

      /**
       * One delegated click handler for the whole links table.
       *
       * The rows used to carry inline onclick="..." attributes with record data
       * interpolated into them. HTML-escaping cannot secure that position: the
       * parser hands the attribute body straight to the JS engine, where the
       * escaped entities are literal characters, so a short_code of ');alert(1)//
       * still closes the argument list. Escaping the attribute would have been
       * misleading — the only real fix is to keep user data out of source text.
       *
       * So the handlers live here and read what they need from the clicked
       * element's dataset. Each existing function keeps its signature; only the
       * call site moved.
       */
      function onLinksTableClick(e) {
        const el = e.target.closest("[data-action]");
        if (!el) return;
        switch (el.dataset.action) {
          case "copy":
            copyUrl(el.dataset.url, el);
            break;
          case "qr":
            showQR(el.dataset.url, e);
            break;
          case "metrics":
            showMetrics(el.dataset.id, el.dataset.code, e);
            break;
          case "save-client-ref":
            saveClientRef(el.dataset.id);
            break;
          case "toggle":
            toggleLink(el.dataset.id, el.dataset.active === "true");
            break;
          case "load-destination":
            loadDestination(el.dataset.id);
            break;
          case "delete":
            deleteLink(el.dataset.id);
            break;
        }
      }

      // #links-body is stable across refreshes: loadLinks replaces its
      // innerHTML, never the element itself, so this one listener survives
      // every re-render instead of needing rebinding per row.
      document.getElementById("links-body").addEventListener("click", onLinksTableClick);

      async function loadLinks() {
        // Safe to call at ANY point in the page lifecycle.
        //
        // The gate is awaited before the first request, not after it, so this
        // holds for every caller and for every number of endpoints that follows
        // — the one-request form this function had before the client_ref rollup
        // got its own URL, and the two-request form shipped today. A caller that
        // arrives while getSession() is still in flight parks here instead of
        // throwing, and its load happens the moment the helper exists.
        //
        // Guarded because loadLinks may also be reached in a context where this
        // script's gate was never created; there is nothing to wait for, so the
        // load proceeds and fails (or succeeds) on its own merits.
        if (window.__apiReady) await window.__apiReady;

        const loading = document.getElementById("links-loading");
        const table = document.getElementById("links-table");
        const empty = document.getElementById("links-empty");
        const tbody = document.getElementById("links-body");
        const count = document.getElementById("link-count");
        const clientsCard = document.getElementById("clients-card");
        const gateCard = document.getElementById("gate-card");
        const gateBody = document.getElementById("gate-body");
        const clientsBody = document.getElementById("clients-body");

        loading.style.display = "";
        table.style.display = "none";
        empty.style.display = "none";
        clientsCard.style.display = "none";
        gateCard.style.display = "none";

        try {
          // Two endpoints, two fetches: the links collection and the
          // per-client_ref rollup. They used to be ONE response, which meant
          // GET /api/links had to wrap its array in an object to carry the
          // rollup — a shape change that broke every caller expecting the
          // original array. The rollup keeps its metrics and its panel; it just
          // has its own URL now.
          //
          // Fetched together so the panel and the table still arrive in one
          // paint. A failure in EITHER one fails the load, because the previous
          // behaviour was also all-or-nothing and a half-rendered dashboard is
          // harder to trust than an error message.
          const [linksRes, clientsRes, gateRes] = await Promise.all([
            window.__api("GET", "/api/links"),
            window.__api("GET", "/api/clients/metrics"),
            window.__api("GET", "/api/review-gate/metrics"),
          ]);
          if (!linksRes || !linksRes.ok) throw new Error("Failed to load links");
          if (!clientsRes || !clientsRes.ok) throw new Error("Failed to load client metrics");

          // The gate panel is the exception to the all-or-nothing rule the two
          // fetches above follow. Its numbers qualify each other — a derivation
          // rate beside a satisfaction mean with a different sample — so a
          // partial paint is worse than no paint. But a tenant who has never
          // activated a gated link has no rows, and failing the whole dashboard
          // over an empty panel would be wrong. So this one degrades to hidden,
          // and only if the panel could not be rendered at all.
          if (gateRes && gateRes.ok) {
            try {
              gateBody.innerHTML = renderGatePanel(await gateRes.json());
              gateCard.style.display = "";
            } catch (err) {
              console.error("gate panel failed to render", err);
            }
          }

          const links = await linksRes.json();
          // An array is the documented contract for /api/links. If that ever
          // changes again the dashboard says so rather than rendering an empty
          // table that looks like "you have no links".
          if (!Array.isArray(links)) throw new Error("Unexpected /api/links response shape");

          // The rollup panel degrades to nothing rather than failing: an empty
          // list is its own honest meaning ("no store has recorded traffic"),
          // and there is no figure here that a wrong zero would fake.
          const clientsPayload = await clientsRes.json();
          const clients = Array.isArray(clientsPayload) ? clientsPayload : [];

          count.textContent = links.length;

          if (links.length === 0) {
            empty.style.display = "";
            return;
          }

          if (clients.length > 0) {
            clientsBody.innerHTML = renderClients(clients);
            clientsCard.style.display = "";
          }

          tbody.innerHTML = links.map((l) => {
            const status = !l.is_active ? "inactive"
              : (l.expires_at && new Date(l.expires_at) < new Date()) ? "expired"
              : "active";
            const shortUrl = l.short_url || "";
            return \`<tr>
              <td><span class="code" data-action="copy" data-url="\${esc(shortUrl)}" data-code="\${esc(l.short_code)}" title="Click to copy \${esc(shortUrl)}">\${esc(l.short_code)}</span></td>
              <td><span class="url-trunc" title="\${esc(l.original_url)}">\${esc(l.original_url)}</span></td>
              <td><a href="#" data-action="metrics" data-id="\${esc(l.id)}" data-code="\${esc(l.short_code)}" class="clicks-link">\${esc(l.clicks_count)}</a></td>
              <td><span class="badge badge-\${status}">\${status}</span></td>
              <td><div class="row-actions"><button class="btn-sm btn-danger" data-action="delete" data-id="\${esc(l.id)}">Del</button></div></td>
            </tr>
            <tr id="metrics-\${esc(l.id)}" style="display:none;">
              <td colspan="5" class="flush-cell">
                <div class="panel-pad">
                  <!-- WHAT LEFT THE ROW, AND WHY IT LIVES HERE
                       The client-ref field and the state change used to sit in
                       this row. Measured, that row carried a 130px editable input
                       and four buttons into a 92.7px cell: the buttons stacked
                       four rows tall, and because the actions column is LAST,
                       auto table layout pushed it off the right edge where
                       overflow-x:auto hid it with no affordance at all. On a
                       390px phone, 392px of the table was simply not on screen.

                       Both controls belong here anyway. This panel is opened by
                       the clicks cell -- the primary action of the row -- and it
                       already holds everything else you do TO a tag rather than
                       read ABOUT one. An editable identifier and a lifecycle
                       change are not reading. -->
                  <div class="panel-controls">
                    <div class="field">
                      <label for="client-ref-\${esc(l.id)}">Client ref</label>
                      <div class="field-row">
                        <input type="text" id="client-ref-\${esc(l.id)}" value="\${esc(l.client_ref)}" placeholder="None" maxlength="200" class="client-ref-input">
                        <button class="btn-sm btn-outline" data-action="save-client-ref" data-id="\${esc(l.id)}">Save</button>
                      </div>
                    </div>
                    <div class="field">
                      <label>Print sheet</label>
                      <div class="field-row">
                        <button class="btn-sm" data-action="qr" data-url="\${esc(shortUrl)}">QR code</button>
                      </div>
                      <p class="field-note">The code that goes on the sticker. This is the destination the printed tag resolves to.</p>
                    </div>
                    \${!l.original_url ? \`
                    <div class="field">
                      <label>Destination</label>
                      <div class="field-row">
                        <button class="btn-sm btn-primary" data-action="load-destination" data-id="\${esc(l.id)}">Load destination...</button>
                      </div>
                      <!--
                        Rendered ONLY while the card has no destination, because
                        that is the only state in which there is something to do.

                        It exists because the flow promises one: a card is
                        manufactured first and its destination loaded later. The
                        API has always accepted it and invalidated the cache; what
                        was missing was the door. Without this, "load them before
                        exporting" was an instruction with nowhere to go.
                      -->
                      <p class="field-note">This card has no destination yet. Anyone who scans it opens a "not configured" page. Load the URL whenever it is settled — the printed sticker does not need reprinting.</p>
                    </div>\` : ""}
                    <div class="field">
                      <label>Tag state</label>
                      <div class="field-row">
                        <button class="btn-sm btn-outline" data-action="toggle" data-id="\${esc(l.id)}" data-active="\${!l.is_active}">\${l.is_active ? "Disable" : "Enable"}</button>
                      </div>
                      <!-- The reason the redirect is a 302 and not a 301, said
                           where the decision is made. It was absent from the
                           interface entirely; odd/analysis/dashboard-directions.md
                           calls that absence out by name. -->
                      <p class="field-note">\${l.is_active
                        ? "This tag stops working. Anyone holding the printed sticker keeps the old destination until their browser cache expires."
                        : "This tag starts working again. The printed sticker works from the next scan."}</p>
                    </div>
                  </div>
                  <div class="metric-box visitors-box">
                    <h4>Visitors (estimate)</h4>
                    <div id="visitors-\${esc(l.id)}"><div class="loading">Loading...</div></div>
                    <!-- Build-time interpolation of a compile-time constant:
                         the caveat text ships inside the served markup, so it is
                         present wherever the numbers are, not just in the docs.
                         No user data is involved, so nothing to escape here. -->
                    <p class="estimate-note">${VISITOR_ESTIMATE_CAVEAT}</p>
                  </div>
                  <div class="metrics-grid">
                  <div class="metric-box">
                    <h4>By Country</h4>
                    <div id="country-\${esc(l.id)}"><div class="loading">Loading...</div></div>
                  </div>
                  <div class="metric-box">
                    <h4>By Device</h4>
                    <div id="device-\${esc(l.id)}"><div class="loading">Loading...</div></div>
                  </div>
                  <div class="metric-box">
                    <h4>By Source</h4>
                    <div id="source-\${esc(l.id)}"><div class="loading">Loading...</div></div>
                  </div>
                </div>
                </div>
              </td>
            </tr>\`;
          }).join("");

          table.style.display = "";
        } catch (err) {
          empty.textContent = "Could not load links. " + (err instanceof Error ? err.message : "");
          empty.style.display = "";
        } finally {
          loading.style.display = "none";
        }
      }

      async function toggleLink(id, active) {
        try {
          const res = await window.__api("PATCH", "/api/links/" + id, { is_active: active });
          if (!res.ok) throw new Error("Failed");
          loadLinks();
        } catch (err) {
          alert("Error: " + (err instanceof Error ? err.message : ""));
        }
      }

      // Same update path as toggleLink — PATCH then re-render. An emptied field
      // is sent as null so clearing the identifier removes it rather than
      // storing an empty string that would never match a CRM record.
      async function saveClientRef(id) {
        const input = document.getElementById("client-ref-" + id);
        if (!input) return;
        const value = input.value.trim();
        try {
          const res = await window.__api("PATCH", "/api/links/" + id, {
            client_ref: value === "" ? null : value,
          });
          if (!res.ok) throw new Error("Failed");
          loadLinks();
        } catch (err) {
          alert("Error: " + (err instanceof Error ? err.message : ""));
        }
      }

      /**
       * Loads a destination onto a card that was manufactured without one.
       *
       * THE SECOND HALF OF THE FLOW. The card already exists, already has a
       * short_code, and is already printed — what is missing is the row the QR
       * resolves through. Setting it here is what makes an existing sticker work,
       * with no reprinting, because the pixels never encoded the destination;
       * they encoded the short code.
       *
       * \`prompt\` rather than a modal: this is a single field on a row the
       * owner is already looking at, and a dialog that hides the rest of the
       * table to ask for one string is heavier than the act deserves. It is
       * dismissible and it validates nothing, which is why the server still
       * validates — the prompt is a convenience, not a gate.
       */
      async function loadDestination(id) {
        const url = window.prompt(
          "Where should this card go?\\n\\nPaste the full URL. Leave it blank to clear it again.",
          "",
        );

        // Cancelled is null; an empty string is a deliberate clear. Treating
        // them the same would let an owner undo a mistake by closing the dialog.
        if (url === null) return;

        const trimmed = url.trim();

        // Not validated here on purpose — the same URL rules apply as on create,
        // and reimplementing them in the browser is how the two drift apart.
        // Sending an empty string clears the destination back to card stock.
        await window.__api("PATCH", "/api/links/" + id, {
          original_url: trimmed === "" ? null : trimmed,
        });

        loadLinks();
      }

      async function showMetrics(linkId, code, e) {
        e.preventDefault();
        const row = document.getElementById("metrics-" + linkId);
        const isOpen = row.style.display !== "none";

        if (isOpen) {
          row.style.display = "none";
          return;
        }

        row.style.display = "";
        const countryDiv = document.getElementById("country-" + linkId);
        const deviceDiv = document.getElementById("device-" + linkId);
        const sourceDiv = document.getElementById("source-" + linkId);
        const visitorsDiv = document.getElementById("visitors-" + linkId);

        if (countryDiv.dataset.loaded) return;

        try {
          const res = await window.__api("GET", "/api/links/" + linkId + "/clicks");
          if (!res) throw new Error("No response");
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Server error");

          visitorsDiv.innerHTML = renderVisitors(data);

          // The breakdown keys come from request data (a Referer header can
          // carry arbitrary text as referrer_source), so they are escaped here
          // exactly like the link fields are.
          countryDiv.innerHTML = Object.entries(data.by_country)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => \`<div class="metric-row"><span>\${esc(k)}</span><strong>\${esc(v)}</strong></div>\`)
            .join("") || "<div class='metric-row'>No data</div>";

          deviceDiv.innerHTML = Object.entries(data.by_device)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => \`<div class="metric-row"><span>\${esc(k)}</span><strong>\${esc(v)}</strong></div>\`)
            .join("") || "<div class='metric-row'>No data</div>";

          sourceDiv.innerHTML = Object.entries(data.by_source || {})
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => \`<div class="metric-row"><span>\${esc(k)}</span><strong>\${esc(v)}</strong></div>\`)
            .join("") || "<div class='metric-row'>No data</div>";

          countryDiv.dataset.loaded = "1";
        } catch (err) {
          countryDiv.innerHTML = "<div class='metric-row'>Error: " + esc(err instanceof Error ? err.message : "Unknown") + "</div>";
        }
      }

      /**
       * Opens the QR modal for a short URL.
       *
       * Takes the URL RAW and encodes exactly once, right here, because this
       * is the only place that builds a query string. The call site used to
       * encode too, and that second layer is what shipped: the QR image
       * encoded \`https%3A%2F%2F…\` instead of \`https://…\`, so scanning a sticker
       * landed nowhere. Two encodes and one decode is not a transformation, it
       * is a coin flip.
       *
       * The displayed text is the raw url, NOT a decoded one. Decoding here
       * would only exist to undo the call site's encode; with that gone, a
       * \`decodeURIComponent\` on a plain URL is not a no-op — it throws on a
       * literal \`%\`.
       *
       * This is also what makes the print-sheet handoff honest: #qr-url holds
       * the same bytes the QR encodes, so the copy button cannot drift.
       */
      function showQR(url, e) {
        e.stopPropagation();
        document.getElementById("qr-img").src = "https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=" + encodeURIComponent(url);
        document.getElementById("qr-url").textContent = url;
        document.getElementById("qr-modal").classList.remove("hidden");
      }

      async function deleteLink(id) {
        if (!confirm("Delete this link permanently?")) return;
        try {
          const res = await window.__api("DELETE", "/api/links/" + id);
          if (!res.ok) throw new Error("Failed");
          loadLinks();
        } catch (err) {
          alert("Error: " + (err instanceof Error ? err.message : ""));
        }
      }

      async function copyUrl(url, el) {
        try {
          await navigator.clipboard.writeText(url);
          el.textContent = "Copied!";
          setTimeout(() => { el.textContent = el.dataset.code; }, 1500);
        } catch {
          // Fallback for older browsers
          const input = document.createElement("input");
          input.value = url;
          document.body.appendChild(input);
          input.select();
          document.execCommand("copy");
          document.body.removeChild(input);
          el.textContent = "Copied!";
          setTimeout(() => { el.textContent = el.dataset.code; }, 1500);
        }
      }
    </script>
  `;

  return c.html(shell("Dashboard", body, c.env.SUPABASE_URL, c.env.SUPABASE_ANON_KEY));
};

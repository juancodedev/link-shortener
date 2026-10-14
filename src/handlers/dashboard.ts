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
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: #f8fafc;
      color: #1e293b;
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
      background: #fff;
      border-bottom: 1px solid #e2e8f0;
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
    nav h2 { font-size: 1.125rem; color: #0f172a; }
    nav a, nav button {
      font-size: 0.813rem;
      color: #64748b;
      text-decoration: none;
      background: none;
      border: none;
      cursor: pointer;
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
    }
    nav a:hover, nav button:hover { color: #2563eb; background: #f1f5f9; }
    .card {
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 0.75rem;
      padding: 1.5rem;
      margin-top: 1.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    }
    h3 {
      font-size: 1rem;
      font-weight: 700;
      color: #0f172a;
      margin-bottom: 1rem;
    }
    label {
      display: block;
      font-size: 0.813rem;
      font-weight: 600;
      color: #475569;
      margin-bottom: 0.25rem;
    }
    input, select {
      width: 100%;
      padding: 0.5rem 0.75rem;
      border: 1.5px solid #d1d5db;
      border-radius: 0.5rem;
      font-size: 0.875rem;
      margin-bottom: 1rem;
    }
    input:focus, select:focus {
      outline: none;
      border-color: #2563eb;
      box-shadow: 0 0 0 3px rgba(37,99,235,0.1);
    }
    button {
      padding: 0.625rem 1.25rem;
      background: #2563eb;
      color: #fff;
      border: none;
      border-radius: 0.5rem;
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { background: #1d4ed8; }
    button:disabled { background: #94a3b8; cursor: not-allowed; }
    .btn-sm {
      padding: 0.25rem 0.75rem;
      font-size: 0.75rem;
      border-radius: 0.375rem;
    }
    .btn-danger { background: #dc2626; }
    .btn-danger:hover { background: #b91c1c; }
    .btn-outline {
      background: transparent;
      color: #2563eb;
      border: 1px solid #d1d5db;
    }
    .btn-outline:hover { background: #f1f5f9; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.813rem;
    }
    th {
      text-align: left;
      color: #64748b;
      font-weight: 600;
      padding: 0.5rem 0.75rem;
      border-bottom: 1px solid #e2e8f0;
    }
    td {
      padding: 0.5rem 0.75rem;
      border-bottom: 1px solid #f1f5f9;
      vertical-align: middle;
    }
    tr:hover td { background: #f8fafc; }
    .code {
      font-family: "SF Mono", "Fira Code", monospace;
      color: #2563eb;
      font-weight: 600;
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
    .badge-active { background: #dcfce7; color: #166534; }
    .badge-inactive { background: #fef2f2; color: #991b1b; }
    .badge-expired { background: #fef9c3; color: #854d0e; }
    .table-wrap {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      margin: 0 -1rem;
      padding: 0 1rem;
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
    .message.success { display: block; background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; }
    .message.error { display: block; background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
    .row-actions { display: flex; gap: 0.25rem; flex-wrap: wrap; }
    @media (min-width: 768px) { .row-actions { gap: 0.375rem; } }
    .empty { text-align: center; color: #94a3b8; padding: 2rem; }
    .loading { text-align: center; color: #94a3b8; padding: 1rem; }
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
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 0.5rem;
      padding: 0.75rem;
    }
    .metric-box h4 {
      font-size: 0.688rem;
      text-transform: uppercase;
      color: #94a3b8;
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
      color: #64748b;
      margin-top: 0.625rem;
      padding-top: 0.5rem;
      border-top: 1px dashed #e2e8f0;
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
      border: 1px solid #e2e8f0;
      border-radius: 0.5rem;
      padding: 0.625rem 0.75rem;
      background: #fff;
    }
    .stat-tile .label {
      font-size: 0.688rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #64748b;
      margin-bottom: 0.125rem;
    }
    .stat-tile .value {
      font-size: 1.5rem;
      font-weight: 600;
      line-height: 1.2;
      color: #1e293b;
    }
    .stat-tile .sub {
      font-size: 0.688rem;
      color: #64748b;
      margin-top: 0.125rem;
    }
    .stat-tile .value.withheld {
      font-size: 0.938rem;
      font-weight: 500;
      color: #94a3b8;
    }
    .peak-chart {
      display: flex;
      align-items: flex-end;
      gap: 2px;
      height: 5rem;
      padding-top: 0.5rem;
      border-bottom: 1px solid #e2e8f0;
    }
    .peak-bar {
      flex: 1 1 0;
      min-width: 2px;
      background: #94a3b8;
      border-radius: 1px 1px 0 0;
      position: relative;
    }
    .peak-bar .google {
      background: #1e293b;
      border-radius: 1px 1px 0 0;
    }
    .peak-axis {
      display: flex;
      justify-content: space-between;
      font-size: 0.688rem;
      color: #94a3b8;
      margin-top: 0.25rem;
    }
    .qr-modal {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
    }
    .qr-modal.hidden { display: none; }
    .qr-card {
      background: #fff;
      border-radius: 0.75rem;
      padding: 1.5rem;
      text-align: center;
      box-shadow: 0 4px 24px rgba(0,0,0,0.12);
    }
  </style>
</head>
<body>
  <nav>
    <h2>⚡ Link Shortener</h2>
    <div>
      <span id="nav-email" style="font-size:0.813rem;color:#64748b;margin-right:0.75rem;"></span>
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
      window.__api = async function(method, path, body) {
        const headers = { "Content-Type": "application/json", "Authorization": "Bearer " + window.__token };
        const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
        if (res.status === 401) { window.location.href = "/login"; throw new Error("Unauthorized"); }
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
        <input type="text" id="url" placeholder="example.com or https://..." required>
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
      <div id="result" style="display:none;margin-top:1rem;">
        <p style="font-size:0.813rem;color:#64748b;">Your short link:</p>
        <input type="text" id="short-url" readonly style="background:#f8fafc;cursor:pointer;" onclick="this.select();navigator.clipboard.writeText(this.value)">
      </div>
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
            <th>Client Ref</th>
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
        <h3 style="margin-bottom:0.5rem;">QR Code</h3>
        <img id="qr-img" src="" alt="QR Code" style="max-width:200px;">
        <p id="qr-url" style="font-size:0.75rem;color:#64748b;margin-top:0.5rem;word-break:break-all;"></p>
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
        <button id="copy-print-sheet" class="btn-sm btn-outline" style="margin-top:0.5rem;">Copy URL for print sheet</button>
        <button class="btn-sm" style="margin-top:0.5rem;" onclick="document.getElementById('qr-modal').classList.add('hidden')">Close</button>
      </div>
    </div>

    <script>
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

          const res = await window.__api("POST", "/api/links", {
            original_url: document.getElementById("url").value,
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
          msg.textContent = "Link created! Copied to clipboard.";
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
          return "<tr><td colspan=\\"3\\" style=\\"color:#94a3b8;\\">No client identifiers yet — set one on a link to see store-level visitors.</td></tr>";
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
            showQR(encodeURIComponent(el.dataset.url), e);
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
              <td><span class="code" data-action="copy" data-url="\${esc(shortUrl)}" data-code="\${esc(l.short_code)}" title="Click to copy \${esc(shortUrl)}" style="cursor:pointer;">\${esc(l.short_code)}</span></td>
              <td><span class="url-trunc" title="\${esc(l.original_url)}">\${esc(l.original_url)}</span></td>
              <td><a href="#" data-action="metrics" data-id="\${esc(l.id)}" data-code="\${esc(l.short_code)}" style="color:#2563eb;text-decoration:none;font-weight:600;">\${esc(l.clicks_count)}</a></td>
              <td><span class="badge badge-\${status}">\${status}</span></td>
              <td><input type="text" id="client-ref-\${esc(l.id)}" value="\${esc(l.client_ref)}" placeholder="None" maxlength="200" style="width:130px;padding:0.25rem 0.5rem;margin-bottom:0;border-radius:0.375rem;font-size:0.75rem;"></td>
              <td>
                <div class="row-actions">
                  <button class="btn-sm btn-outline" data-action="save-client-ref" data-id="\${esc(l.id)}" title="Save client identifier">Save</button>
                  <button class="btn-sm" data-action="qr" data-url="\${esc(shortUrl)}" title="QR Code">QR</button>
                  <button class="btn-sm btn-outline" data-action="toggle" data-id="\${esc(l.id)}" data-active="\${!l.is_active}">\${l.is_active ? "Disable" : "Enable"}</button>
                  <button class="btn-sm btn-danger" data-action="delete" data-id="\${esc(l.id)}">Del</button>
                </div>
              </td>
            </tr>
            <tr id="metrics-\${esc(l.id)}" style="display:none;">
              <td colspan="6" style="padding:0;">
                <div style="padding:0.75rem;">
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

      function showQR(url, e) {
        e.stopPropagation();
        document.getElementById("qr-img").src = "https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=" + encodeURIComponent(url);
        document.getElementById("qr-url").textContent = decodeURIComponent(url);
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

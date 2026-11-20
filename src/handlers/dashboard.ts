import type { Handler } from "hono";
import type { AppEnv, HonoVars } from "../types/env";
import { VISITOR_ESTIMATE_CAVEAT } from "../analytics/metrics";
import { resolveMaxActiveLinks } from "../api/links";
import { icon } from "./icons";
import { BRAND_ICONS } from "./brand-head";

// ---------------------------------------------------------------------------
// Shared shell
// ---------------------------------------------------------------------------

/**
 * The config block's JSON, safe inside a <script> element: `<` is escaped so
 * no value can close the element or open a comment, and U+2028/U+2029 so the
 * text stays valid if anyone ever evaluates it.
 */
function configJson(config: { supabaseUrl: string; supabaseAnonKey: string }): string {
  return JSON.stringify(config)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function shell(title: string, body: string, supabaseUrl: string, supabaseAnonKey: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${BRAND_ICONS}
  <title>${title} — Más Reseñas</title>
  <!-- The review cards (Cards section) are drawn with these faces. Loaded by
       the page so the inline card SVGs use them on screen AND the browser
       embeds the same fonts in the PDF it prints. -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&amp;family=Outfit:wght@400;500;600;700&amp;display=swap">
  <!-- The dashboard stylesheet, built from web/src/dashboard.css. -->
  <link rel="stylesheet" href="/assets/dashboard.css">
</head>
<body>
  <nav class="topbar">
    <h2 class="brand">${icon("logo")}<span>Más Reseñas</span></h2>
    <div class="topbar-actions">
      <span id="nav-email" class="nav-email"></span>
      <a href="/">Inicio</a>
      <button id="logout-nav">${icon("logout")}<span>Cerrar sesión</span></button>
    </div>
  </nav>
  <div class="container">
    ${body}
  </div>
  <!--
    Deployment config for the bundle's auth bootstrap (web/src/shell/auth.ts),
    as data rather than code: the Worker stays the source of these values and
    the page carries no inline executable script. The anon key is public by
    design; nothing else goes here.
  -->
  <script type="application/json" id="dashboard-config">${configJson({ supabaseUrl, supabaseAnonKey })}</script>
  <!-- The sidebar routing first, as its own tiny module: module scripts run
       in document order, so a deep link such as #cards opens its section
       without waiting for the bundle (web/src/routing-entry.ts). -->
  <script type="module" src="/assets/routing.js"></script>
  <!-- The shell (auth, API helper, tenant picker) and every section are the
       React bundle (web/, odd/tasks/dashboard-react.md). -->
  <script type="module" src="/assets/dashboard.js"></script>
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
    <!--
      SECTIONS BEHIND A SIDEBAR (odd/tasks/print-queue-cards.md S1).

      One section is visible at a time; the sidebar link and the URL hash pick
      it, so a reload stays where the owner was. Links is the default: it is
      where cards are created, and a phone has always opened there. Every
      section's data still loads at boot, so switching is instant. The
      bundle's router (web/src/shell/routing.ts) toggles [hidden] on these
      sections and the active link; the print rules key on [hidden].
    -->
    <div class="app">
    <aside class="sidebar no-print">
      <nav class="side-nav" aria-label="Secciones del panel">
        <a href="#overview" data-section-link="overview">${icon("overview")}<span>Resumen</span></a>
        <a href="#links" data-section-link="links">${icon("links")}<span>Enlaces</span></a>
        <a href="#cards" data-section-link="cards">${icon("cards")}<span>Tarjetas</span> <span id="cards-count" class="side-count" hidden></span></a>
        <a href="#businesses" data-section-link="businesses">${icon("businesses")}<span>Locales y sucursales</span></a>
        <a href="#comments" data-section-link="comments">${icon("comments")}<span>Comentarios</span></a>
        <a href="#settings" data-section-link="settings">${icon("settings")}<span>Configuración</span></a>
      </nav>
    </aside>
    <main class="sections">
    <section class="dash-section" data-section="overview" hidden>
    <!--
      THE OVERVIEW SECTION, drawn by the React island in web/src/overview
      (odd/tasks/dashboard-react.md T4): the print button and the report
      cards (satisfaction, busy hours, stores by client_ref), each loading
      its own data. The <section> stays here, so showSection and the print
      rules keyed on data-section="overview" keep working on it.

      Nothing is served inside: every card starts hidden until its data
      arrives, and a print button without its script would do nothing.
    -->
    <div id="overview-root" data-island="overview"></div>
    </section>

    <section class="dash-section" data-section="links">
    <!--
      THE LINKS SECTION, drawn by the React island in web/src/links
      (odd/tasks/dashboard-react.md T3a/T3b): the create form, bulk card
      stock, the links table and the QR modal. The <section> stays here, so
      showSection and the print rules keep working on it; the island replaces
      what is inside #links-root when it mounts.

      What the server puts there is the first paint before the bundle runs:
      the table's title, its loading state and the visitor caveat. No form is
      served, because a form without its script would submit as a plain GET.
      data-link-limit carries the plan limit, which only the server knows.
    -->
    <div id="links-root" data-island="links" data-link-limit="${activeLinkLimit}">
    <div class="card no-print" id="links-card">
      <h3>Tus enlaces (<span id="link-count">0</span>/${activeLinkLimit})</h3>
      <div id="links-loading" class="loading">Cargando…</div>
      <!--
        Server-rendered, not injected by script, and not behind a tooltip (the
        island renders the same sentence once it mounts).

        This is the whole point of the caveat's placement: a store owner acts on
        the visitor number, so the limitation has to be on the page before they
        expand anything and look for it. A note hidden behind a hover, a
        disclosure, or a README is a note nobody reads — and a bare "42 unique
        visitors" is worse than no figure at all, because someone will make a
        decision with it. The sentence lives beside the constants it qualifies
        in src/analytics/metrics.ts so the two cannot drift apart.
      -->
      <p class="estimate-note"><strong>Sobre las cifras de visitantes:</strong> ${VISITOR_ESTIMATE_CAVEAT}</p>
    </div>
    </div>
    </section>

    <section class="dash-section" data-section="cards" hidden>
    <!--
      THE PRINT QUEUE (odd/tasks/print-queue-cards.md S4-S6), drawn by the
      React island in web/src/cards (odd/tasks/dashboard-react.md T2).

      Every link sent to print from the Links section, laid out as 10×10 cm
      review cards on the chosen sheet. The sheet below IS the print: same SVG,
      same millimetres; only the screen preview is zoomed. Cards start at the
      top-left margin so a part-used sheet can go through the printer again.
    -->
    <div class="card" id="cards-root" data-island="cards"></div>
    </section>

    <section class="dash-section" data-section="businesses" hidden>
    <!--
      BUSINESSES AND BRANCHES, drawn by the React island in web/src/businesses
      (odd/tasks/dashboard-react.md T5).

      A business ("local") groups one or more branches ("sucursales"), and each
      link belongs to a branch. Operator-only: the businesses never see this.
      Every comment and rating is then traceable to business, branch and link
      (odd/tasks/business-branches.md). The lists live in the bundle's
      branches store (web/src/branches), which the Links pickers and the
      Comments filter read too.
    -->
    <div id="businesses-root" data-island="businesses"></div>
    </section>

    <section class="dash-section" data-section="comments" hidden>
    <!--
      WHAT CUSTOMERS WROTE, drawn by the React island in web/src/comments
      (T5): the feedback inbox, its business/branch filter and the CSV export.
      The island keeps #feedback-card, which the print rules key on.
    -->
    <div id="comments-root" data-island="comments"></div>
    </section>

    <section class="dash-section" data-section="settings" hidden>
    <!--
      WHERE FEEDBACK SHOULD GO, drawn by the React island in web/src/settings
      (T5).

      IT DOES NOT SEND ANYTHING YET. The address is stored, shown and exported
      into the print sheet's CSV, and nothing is emailed from it. The island's
      help text says so, because a green dashboard implying "reviews are being
      emailed" is worse than no field at all: an owner would stop checking the
      comments.
    -->
    <div id="settings-root" data-island="settings"></div>
    </section>

    </main>
    </div>
  `;

  return c.html(shell("Panel", body, c.env.SUPABASE_URL, c.env.SUPABASE_ANON_KEY));
};

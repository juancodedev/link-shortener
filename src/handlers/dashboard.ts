import type { Handler } from "hono";
import type { AppEnv, HonoVars } from "../types/env";
import { VISITOR_ESTIMATE_CAVEAT } from "../analytics/metrics";
import { renderGatePanel } from "./gate-panel";
import { renderFeedbackInbox } from "./feedback-inbox";
import { resolveMaxActiveLinks } from "../api/links";
import { icon } from "./icons";

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
  <!-- The review cards (Cards section) are drawn with these faces. Loaded by
       the page so the inline card SVGs use them on screen AND the browser
       embeds the same fonts in the PDF it prints. -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&amp;family=Outfit:wght@400;500;600;700&amp;display=swap">
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
      --paper: #ffffff;        /* a printing sheet: the cards are drawn on white */
      --card-zoom: 0.45;       /* Cards preview scale; the print is always 1 */

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

      /* Control heights — an input, a select and the button beside it share
         one height, so a row of them lines up without per-row fixes. */
      --control-h: 2.25rem;
      --control-h-sm: 1.75rem;
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: var(--kraft);
      color: var(--ink);
      line-height: 1.6;
      min-height: 100dvh;
    }
    /* Wide, not unbounded: past ~1440px a table row gets too long for the eye
       to follow from the code to its actions. */
    .container {
      max-width: 1440px;
      margin: 0 auto;
      padding: 1rem;
    }
    @media (min-width: 768px) {
      .container { padding: 1.5rem 2rem; }
    }
    /* Sidebar + one visible section. On a phone the sidebar is a horizontal
       bar of section links above the content; from 1024px it is a column. */
    .app { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1rem; }
    .sidebar { min-width: 0; }
    .side-nav {
      display: flex;
      gap: 0.25rem;
      overflow-x: auto;
      background: var(--sticker);
      border: 1px solid var(--edge);
      border-radius: 0.75rem;
      padding: 0.375rem;
    }
    .side-nav a {
      display: flex;
      align-items: center;
      gap: 0.625rem;
      white-space: nowrap;
      padding: 0.5rem 0.75rem;
      border-radius: 0.5rem;
      color: var(--ink-soft);
      text-decoration: none;
      font-size: 0.875rem;
      font-weight: 500;
    }
    .side-nav a:hover { background: var(--kraft-deep); color: var(--ink-strong); }
    /* Active is a wash, not a solid fill: it marks where you are without
       competing with the one filled button that means "do this". */
    .side-nav a.is-active { background: var(--tag-wash); color: var(--tag-deep); font-weight: 600; }
    .side-nav a .icon { width: 1.125rem; height: 1.125rem; }
    .side-count {
      margin-left: auto;
      background: var(--stale-wash);
      color: var(--stale);
      border-radius: 999px;
      padding: 0 0.5rem;
      font-size: 0.75rem;
      font-weight: 700;
    }
    .dash-section[hidden] { display: none; }
    @media (min-width: 1024px) {
      .app {
        grid-template-columns: 15.5rem minmax(0, 1fr);
        align-items: start;
        gap: 1.5rem;
      }
      .side-nav { flex-direction: column; overflow-x: visible; }
      .sections .url-trunc { max-width: 20rem; }
    }
    /* Every icon shares one size and sits on the text's centre line; a
       context only changes the size, never the stroke or the colour source. */
    .icon {
      width: 1rem;
      height: 1rem;
      flex: none;
      display: inline-block;
      vertical-align: middle;
    }
    /* Scoped to .topbar: a bare "nav" selector also styled the sidebar's
       <nav>, which is what centred its links. */
    .topbar {
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
      .topbar { padding: 0.75rem 1.5rem; }
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 1.125rem;
      color: var(--ink-strong);
    }
    .brand .icon { width: 1.25rem; height: 1.25rem; color: var(--tag); }
    .topbar-actions { display: flex; align-items: center; gap: 0.25rem; }
    .topbar-actions a, .topbar-actions button {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      height: auto;
      font-size: 0.813rem;
      font-weight: 500;
      color: var(--ink-soft);
      text-decoration: none;
      background: none;
      border: none;
      cursor: pointer;
      padding: 0.25rem 0.5rem;
      border-radius: 0.375rem;
    }
    .topbar-actions a:hover, .topbar-actions button:hover { color: var(--tag); background: var(--kraft-deep); }
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
    input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), select {
      height: var(--control-h);
      padding: 0 0.75rem;
      background: var(--paper);
      color: var(--ink);
    }
    input, select {
      width: 100%;
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
    /* Three weights, one height scale. Filled = the primary action of a
       form; outline = secondary; danger = outline in oxblood that only fills
       on hover, so a destructive button never outshouts the primary one. */
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.375rem;
      height: var(--control-h);
      padding: 0 1.25rem;
      background: var(--tag);
      color: var(--sticker);
      border: 1px solid transparent;
      border-radius: 0.5rem;
      font-size: 0.875rem;
      font-weight: 600;
      line-height: 1;
      white-space: nowrap;
      cursor: pointer;
    }
    button:hover { background: var(--tag-deep); }
    button:disabled { background: var(--ink-faint); cursor: not-allowed; }
    button:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--tag-wash); }
    .btn-sm {
      height: var(--control-h-sm);
      padding: 0 0.75rem;
      font-size: 0.75rem;
      border-radius: 0.375rem;
    }
    .btn-sm .icon { width: 0.875rem; height: 0.875rem; }
    .btn-danger {
      background: transparent;
      color: var(--retired-ink);
      border-color: var(--retired-edge);
    }
    .btn-danger:hover { background: var(--retired); border-color: var(--retired); color: var(--sticker); }
    .btn-outline {
      background: transparent;
      color: var(--tag);
      border-color: var(--edge-strong);
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
    /* nowrap: Edit and Del stay on one line. Wrapping is what once stacked
       four buttons vertically and pushed this column off the card. */
    .row-actions { display: flex; gap: 0.25rem; flex-wrap: nowrap; }
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
    .hour-bar {
      flex: 1 1 0;
      min-width: 2px;
      background: var(--tag);
      border-radius: 1px 1px 0 0;
    }
    .hour-summary { font-size: 0.875rem; margin-top: 0.25rem; }
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

    /* The feedback inbox. Shared with src/handlers/feedback-inbox.ts, which
       emits these classes. The comment wraps rather than being cut: the API
       returns the full text and the owner should be able to read all of it. */
    .feedback-head { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; }
    .feedback-head h3 { margin: 0; }
    .feedback-list { list-style: none; margin: 0.75rem 0 0; padding: 0; }
    .feedback-item { border-top: 1px solid var(--edge); padding: 0.75rem 0; }
    .feedback-item:first-child { border-top: 0; padding-top: 0; }
    .feedback-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem 0.75rem;
      font-size: 0.75rem;
      color: var(--ink-soft);
    }
    .feedback-rating { color: var(--ink); font-weight: 600; }
    .feedback-rating.withheld { color: var(--ink-faint); font-weight: 400; }
    .feedback-comment {
      margin: 0.35rem 0 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .feedback-contact { margin-top: 0.25rem; font-size: 0.75rem; color: var(--ink-soft); }
    .message.notice { display: block; background: var(--stale-wash); color: var(--stale); border: 1px solid var(--edge); }

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
    /* In a row the field and its button are one control: drop the stacked-form
       bottom margin (it pushed the button off centre) and match heights. */
    .field-row input, .field-row select { margin-bottom: 0; }
    .field-row .btn-sm { height: var(--control-h); }
    .biz-branch .field-row select { width: auto; min-width: 9rem; }
    .biz-name { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem; }
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
    .biz-group { border-top: 1px solid var(--edge); padding: 0.75rem 0; }
    .biz-group:first-child { border-top: none; padding-top: 0; }
    .biz-name { font-weight: 700; color: var(--ink-strong); }
    .biz-branches { list-style: none; margin: 0.375rem 0 0.5rem; }
    .biz-branch { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; padding: 0.25rem 0; flex-wrap: wrap; }
    .feedback-code { font-family: "SF Mono", "Fira Code", monospace; font-size: 0.75rem; color: var(--tag); }
    #links-table .badge, .owner-business { white-space: nowrap; }
    /* Narrow screens: Business/branch, URL and Opens step aside so Clicks,
       Status and the actions stay on the card. The panel still shows all three. */
    @media (max-width: 767px) { .hide-sm { display: none; } }
    .badge-gated { background: var(--kraft-deep); color: var(--tag); }
    .badge-direct { background: var(--kraft); color: var(--ink-soft); }
    .owner-business { display: block; font-weight: 600; color: var(--ink-strong); }
    .owner-branch { display: block; font-size: 0.813rem; color: var(--ink-soft); }
    .owner-none { font-size: 0.813rem; color: var(--ink-soft); }
    .check-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-top: 0.75rem;
      font-weight: 500;
      cursor: pointer;
    }
    .check-row input[type="checkbox"] { width: 1.125rem; height: 1.125rem; margin: 0; flex: none; accent-color: var(--tag); }
    .gap-top { margin-top: 1rem; }
    .gap-top-sm { margin-top: 0.5rem; }
    .report-actions { display: flex; justify-content: flex-end; margin-bottom: 0.75rem; }
    .badge-queued { background: var(--stale-wash); color: var(--stale); }
    /* Cards section (odd/tasks/print-queue-cards.md S4-S6). Sheets and cards
       are sized in millimetres, so the preview is the print at a zoom. */
    .cards-controls { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0.75rem; }
    @media (min-width: 768px) { .cards-controls { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    .cards-controls fieldset { border: 1px solid var(--edge); border-radius: 0.5rem; padding: 0.5rem 0.75rem; margin: 0; }
    .cards-controls legend { font-size: 0.75rem; font-weight: 600; color: var(--ink-label); padding: 0 0.25rem; }
    .cards-controls .check-row { margin-top: 0.375rem; font-weight: 400; }
    .cards-mm { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; margin-top: 0.5rem; font-size: 0.75rem; }
    .cards-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin: 0.75rem 0; }
    .cards-info { font-size: 0.75rem; color: var(--ink-soft); }
    .cards-queue { list-style: none; padding: 0; margin: 0 0 0.75rem; display: flex; flex-wrap: wrap; gap: 0.375rem; }
    .cards-queue li { display: flex; align-items: center; gap: 0.375rem; background: var(--kraft-deep); border-radius: 999px; padding: 0.125rem 0.25rem 0.125rem 0.625rem; font-size: 0.75rem; }
    #card-sheets { zoom: var(--card-zoom); overflow-x: auto; padding: 0.5rem 0; }
    .card-sheet {
      display: grid;
      justify-content: start;
      align-content: start;
      box-sizing: border-box;
      background: var(--paper);
      outline: 1px solid var(--edge);
      margin: 0 0 1rem;
    }
    .print-card { width: 100mm; height: 100mm; overflow: hidden; border-radius: 5mm; background: var(--paper); }
    .print-card.is-crop { outline: 0.25mm dashed var(--edge-strong); outline-offset: -0.25mm; }
    .print-card.is-mirror svg { transform: scaleX(-1); }
    /* The printed report: only the metric cards, one card never split across
       two pages, and the chart colours kept (browsers drop backgrounds by
       default, which would print the bars as nothing). */
    @media print {
      .topbar,
      .sidebar,
      .dash-section:not([data-section="overview"]),
      .no-print,
      .qr-modal,
      button,
      select,
      #feedback-card label,
      .message {
        display: none !important;
      }
      * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      body, .container { background: none; max-width: none; padding: 0; }
      .app { display: block; }
      .dash-section[data-section="overview"] { display: block !important; }
      .card { break-inside: avoid; box-shadow: none; }
      .table-wrap { overflow: visible; }
      /* Printing from Cards: only the sheets, at full size (S5). The class is
         set just for that print, so the report print above is unchanged. */
      body.printing-cards .dash-section[data-section="cards"] { display: block !important; }
      body.printing-cards .dash-section[data-section="overview"] { display: none !important; }
      body.printing-cards #cards-root > :not(#card-sheets) { display: none !important; }
      body.printing-cards #cards-root { border: 0; padding: 0; margin: 0; background: none; }
      body.printing-cards #card-sheets { zoom: 1 !important; overflow: visible; padding: 0; }
      body.printing-cards .card-sheet { margin: 0; outline: none; break-inside: avoid; overflow: hidden; }
      .card-sheet + .card-sheet { break-before: page; page-break-before: always; }
    }
  </style>
</head>
<body>
  <nav class="topbar">
    <h2 class="brand">${icon("logo")}<span>Link Shortener</span></h2>
    <div class="topbar-actions">
      <span id="nav-email" class="nav-email"></span>
      <a href="/">Home</a>
      <button id="logout-nav">${icon("logout")}<span>Log Out</span></button>
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

      // Once, at boot, not on every loadLinks(): the feedback address belongs
      // to the tenant and not to any row, so re-reading it whenever a link is
      // toggled would be a request per keystroke of someone else's workflow.
      if (typeof loadFeedbackEmail === "function") loadFeedbackEmail();
      if (typeof loadFeedbackInbox === "function") loadFeedbackInbox();
      if (typeof loadBranches === "function") loadBranches();
      if (typeof loadHourlyTraffic === "function") loadHourlyTraffic();
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
    <!--
      SECTIONS BEHIND A SIDEBAR (odd/tasks/print-queue-cards.md S1).

      One section is visible at a time; the sidebar link and the URL hash pick
      it, so a reload stays where the owner was. Links is the default: it is
      where cards are created, and a phone has always opened there. Every
      section's data still loads at boot, so switching is instant.
    -->
    <div class="app">
    <aside class="sidebar no-print">
      <nav class="side-nav" aria-label="Dashboard sections">
        <a href="#overview" data-section-link="overview">${icon("overview")}<span>Overview</span></a>
        <a href="#links" data-section-link="links">${icon("links")}<span>Links</span></a>
        <a href="#cards" data-section-link="cards">${icon("cards")}<span>Cards</span> <span id="cards-count" class="side-count" hidden></span></a>
        <a href="#businesses" data-section-link="businesses">${icon("businesses")}<span>Businesses and branches</span></a>
        <a href="#comments" data-section-link="comments">${icon("comments")}<span>Comments</span></a>
        <a href="#settings" data-section-link="settings">${icon("settings")}<span>Settings</span></a>
      </nav>
    </aside>
    <main class="sections">
    <section class="dash-section" data-section="overview" hidden>
    <!-- The report is what the owner forwards: the print stylesheet keeps the
         metric cards and drops everything that is a control. -->
    <div class="report-actions no-print">
      <button type="button" id="print-report" class="btn-sm btn-outline">${icon("print")}<span>Print report</span></button>
    </div>
    <!-- Review gate. Presentable as a screenshot on purpose: this screen is
         what the owner forwards as their monthly report, so every figure here
         carries its own qualification in the markup rather than in a tooltip
         that a screenshot would not capture. -->
    <div class="card" id="gate-card" style="display:none;">
      <h3>Customer satisfaction</h3>
      <div id="gate-body"><div class="loading">Loading...</div></div>
    </div>

    <!-- Busy hours. Same screenshot discipline as the panel above: the window
         and the time zone are printed under the chart, not in a tooltip. -->
    <div class="card" id="traffic-card" style="display:none;">
      <h3>Busy hours</h3>
      <div id="traffic-body"></div>
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
    </section>

    <section class="dash-section" data-section="links">
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
        <!--
          THE REVIEW SCREEN IS OPT-IN.

          Unchecked, a scan is a plain 302 to the destination — for a Google
          review link, the customer lands on Google's own form. Checked, the
          scan shows our review screen first (stars, Google button, private
          comment). Only checked links feed the satisfaction panel, because
          only they record anything; the help text says so.
        -->
        <label class="check-row">
          <input type="checkbox" id="gated">
          <span>Show the review screen before redirecting</span>
        </label>
        <p class="field-help">Off: the scan goes straight to the destination. On: customers see the star rating and can leave you a private comment. Only links with this on feed the satisfaction panel.</p>
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


    <div class="card no-print" id="links-card">
      <h3>Your Links (<span id="link-count">0</span>/${activeLinkLimit})</h3>
      <div id="links-loading" class="loading">Loading...</div>
      <div class="table-wrap">
      <table id="links-table" style="display:none;">
        <thead>
          <tr>
            <th>Short Code</th>
            <th class="hide-sm">Business / branch</th>
            <th class="hide-sm">URL</th>
            <th class="hide-sm">Opens</th>
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
    </section>

    <section class="dash-section" data-section="cards" hidden>
    <!--
      THE PRINT QUEUE (odd/tasks/print-queue-cards.md S4-S6).

      Every link sent to print from the Links section, laid out as 10×10 cm
      review cards on the chosen sheet. The sheet below IS the print: same SVG,
      same millimetres; only the screen preview is zoomed. Cards start at the
      top-left margin so a part-used sheet can go through the printer again.
    -->
    <div class="card" id="cards-root">
      <h3>Cards to print</h3>
      <p class="field-help">Links you send to print from the Links section wait here. A card leaves the queue when you mark it printed, remove it, or save its destination.</p>
      <ul id="cards-queue" class="cards-queue"></ul>
      <div id="cards-controls" class="cards-controls">
        <fieldset>
          <legend>Variante</legend>
          <label class="check-row"><input type="radio" name="card-variant" value="hybrid" checked>Híbrido: QR + NFC</label>
          <label class="check-row"><input type="radio" name="card-variant" value="qr">Solo QR Centrado</label>
          <label class="check-row"><input type="radio" name="card-variant" value="nfc">Solo NFC Centrado</label>
        </fieldset>
        <fieldset>
          <legend>Diseño</legend>
          <select id="card-design" aria-label="Diseño">
            <option value="official">Estándar Oficial Google</option>
            <option value="minimal">Clean Minimalist Glass</option>
          </select>
          <label class="check-row"><input type="checkbox" id="card-mirror">Modo Espejo (impresión posterior transparente)</label>
          <label class="check-row"><input type="checkbox" id="card-crop" checked>Líneas / Guías de Corte (Radio R5)</label>
        </fieldset>
        <fieldset>
          <legend>Hoja</legend>
          <select id="card-sheet" aria-label="Hoja">
            <option value="297x420">A3 vertical (297×420 mm)</option>
            <option value="420x297">A3 horizontal (420×297 mm)</option>
            <option value="210x297">A4 vertical (210×297 mm)</option>
            <option value="216x279">Carta (216×279 mm)</option>
            <option value="100x100">1 tarjeta por hoja (100×100 mm)</option>
            <option value="custom">Medida personalizada (rollo / pliego)</option>
          </select>
          <div class="cards-mm">
            <label>Margen hoja (mm)<input id="card-margin" type="number" min="0" value="10"></label>
            <label>Separación (mm)<input id="card-gap" type="number" min="0" value="6"></label>
            <label>Ancho hoja (mm)<input id="card-sheet-w" type="number" min="100" value="600" disabled></label>
            <label>Alto hoja (mm)<input id="card-sheet-h" type="number" min="100" value="400" disabled></label>
          </div>
          <label class="gap-top-sm">Zoom vista previa<input id="card-zoom" type="range" min="25" max="100" value="45"></label>
        </fieldset>
      </div>
      <div class="cards-actions">
        <button type="button" id="cards-export" class="btn-sm btn-primary">Export PDF / Print</button>
        <button type="button" id="cards-mark-printed" class="btn-sm btn-outline">Mark as printed</button>
        <span id="cards-info" class="cards-info"></span>
      </div>
      <div id="card-sheets"></div>
    </div>
    </section>

    <section class="dash-section" data-section="businesses" hidden>
    <!--
      BUSINESSES AND BRANCHES.

      A business ("local") groups one or more branches ("sucursales"), and each
      link belongs to a branch. Operator-only: the businesses never see this.
      Every comment and rating is then traceable to business, branch and link
      (odd/tasks/business-branches.md).
    -->
    <div class="card" id="businesses-card">
      <h3>Businesses and branches</h3>
      <label for="new-business-name">New business</label>
      <div class="field-row">
        <input type="text" id="new-business-name" maxlength="120" placeholder="e.g. Café Central">
        <button type="button" id="add-business" class="btn-sm btn-primary">Add</button>
      </div>
      <div id="businesses-msg" class="message"></div>
      <div id="businesses-body" class="gap-top"><div class="loading">Loading...</div></div>
    </div>
    </section>

    <section class="dash-section" data-section="comments" hidden>
    <div class="card" id="feedback-card">
      <div class="feedback-head">
        <h3>What customers wrote</h3>
        <button type="button" id="feedback-export" class="btn-sm">Download CSV</button>
      </div>
      <label for="feedback-filter" class="gap-top-sm">Show comments from</label>
      <select id="feedback-filter">
        <option value="">All businesses</option>
      </select>
      <div id="feedback-export-msg" class="message"></div>
      <div id="feedback-body"><div class="loading">Loading...</div></div>
    </div>
    </section>

    <section class="dash-section" data-section="settings" hidden>
    <!--
      WHERE FEEDBACK SHOULD GO.

      A card's QR leads to the review gate. A customer can leave a private
      comment there, and it lands in analytics.tag_feedback and shows up in the
      satisfaction panel below.

      They can also record here where that should be delivered.

      IT DOES NOT SEND ANYTHING YET. The address is stored, shown and exported
      into the print sheet's CSV, and nothing is emailed from it. That is the
      honest state of this field, and the label says so, because a green
      dashboard implying "reviews are being emailed" is worse than no field at
      all: an owner would stop checking the panel.

      Wired as static listeners with the other form controls, not through the
      delegated switch — that switch is for record actions, and this acts on no
      record.
    -->
    <div class="card" id="feedback-email-card">
      <h3>Feedback email</h3>
      <p class="field-help">
        Where you would like private customer comments delivered. Stored now;
        nothing is emailed yet — comments still arrive in the Comments section.
      </p>
      <label for="feedback-email">Email address</label>
      <input type="email" id="feedback-email" placeholder="you@yourbusiness.com"
             autocomplete="email" maxlength="254">
      <div id="feedback-email-msg" class="message"></div>
      <button type="button" id="feedback-email-save" class="btn-sm btn-primary gap-top-sm">Save</button>
    </div>
    </section>

    </main>
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
        <label for="bulk-label" class="gap-top-sm">Label for this batch <span class="field-note">(optional)</span></label>
        <input type="text" id="bulk-label" maxlength="200" placeholder="e.g. Main room — tables 1 to 10">
        <label class="check-row gap-top-sm">
          <input type="checkbox" id="bulk-gated">
          <span>Show the review screen before redirecting</span>
        </label>
        <p class="field-help">
          Off: once a destination is loaded, scans go straight to it. On:
          customers see the star rating and can leave a private comment — and
          only these cards feed the satisfaction panel. Changeable per card later.
        </p>
        <p class="field-help">
          Printed under the code on every card, and written to the sheet's CSV, so
          the designer knows which sticker is which before cutting. One field for
          the whole batch beats typing it ten times.
        </p>
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
      // Same injection, same caveat: self-contained, see feedback-inbox.ts.
      const renderFeedbackInbox = ${renderFeedbackInbox.toString()};
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
            is_gated: document.getElementById("gated").checked,
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
          document.getElementById("gated").checked = false;
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
      // ---------------------------------------------------------------------
      // Feedback email
      //
      // Loads whatever is stored so the owner can see it, which is the whole
      // point of showing it here. Fetches once per load rather than on every
      // render of the links table, because it belongs to the tenant and not to
      // any row.
      // ---------------------------------------------------------------------
      async function loadFeedbackEmail() {
        try {
          const res = await window.__api("GET", "/api/tenant/feedback-email");
          const body = await res.json();
          const input = document.getElementById("feedback-email");
          if (input && typeof body.feedback_email === "string") {
            input.value = body.feedback_email;
          }
        } catch {
          // A tenant that cannot read its own setting still gets a working
          // dashboard; the field just stays empty rather than blocking the page.
        }
      }

      // ---------------------------------------------------------------------
      // Feedback inbox
      //
      // Once at boot, like the feedback address: the comments belong to the
      // tenant, not to any link row, so re-reading them on every table refresh
      // would be a request per toggle for data that did not change.
      //
      // Kept out of loadLinks' all-or-nothing fetch on purpose. A failure here
      // says so in this card and leaves the rest of the dashboard working;
      // the links table should not disappear because the inbox could not load.
      // ---------------------------------------------------------------------
      /**
       * The comment filter as the API's query string. "b:<id>" is a business,
       * "l:<id>" a branch, "" everything. The list and the CSV read the same
       * value, so the export is always what is on screen.
       */
      function feedbackQuery() {
        const value = document.getElementById("feedback-filter").value;
        if (value.indexOf("b:") === 0) return "?business_id=" + encodeURIComponent(value.slice(2));
        if (value.indexOf("l:") === 0) return "?location_id=" + encodeURIComponent(value.slice(2));
        return "";
      }

      /**
       * Rebuilds the filter's options from the loaded businesses and branches,
       * keeping the current choice. Built with DOM APIs: the names are typed
       * by a person.
       */
      function fillFeedbackFilter() {
        const select = document.getElementById("feedback-filter");
        if (!select) return;
        const current = select.value;
        const businesses = (window.__businesses || []).filter((b) => b.is_active !== false);
        const branches = pickableBranches(window.__branches || [], window.__businesses || []);
        select.textContent = "";
        select.add(new Option("All businesses", ""));
        businesses.forEach((b) => {
          select.add(new Option(b.name, "b:" + b.id));
          branches
            .filter((l) => l.business_id === b.id)
            .forEach((l) => select.add(new Option("— " + l.name, "l:" + l.id)));
        });
        branches
          .filter((l) => !l.business_id)
          .forEach((l) => select.add(new Option(l.name + " (no business)", "l:" + l.id)));
        select.value = current;
        // The chosen business or branch no longer exists: fall back to all,
        // and reload, or the list would stay filtered under an "All" label.
        if (select.value !== current) {
          select.value = "";
          loadFeedbackInbox();
        }
      }

      document.getElementById("feedback-filter").addEventListener("change", () => loadFeedbackInbox());
      document.getElementById("print-report").addEventListener("click", () => window.print());

      // ---------------------------------------------------------------------
      // Sidebar sections (odd/tasks/print-queue-cards.md S1). The hash names
      // the visible section, so a reload or a shared link opens the same one.
      // ---------------------------------------------------------------------
      /** The section a URL hash names, or Links for anything else. */
      function sectionFromHash(hash) {
        const sections = ["overview", "links", "cards", "businesses", "comments", "settings"];
        const name = String(hash || "").replace(/^#/, "");
        return sections.indexOf(name) > -1 ? name : "links";
      }

      function showSection(name) {
        document.querySelectorAll(".dash-section").forEach((el) => {
          el.hidden = el.getAttribute("data-section") !== name;
        });
        document.querySelectorAll("[data-section-link]").forEach((a) => {
          const on = a.getAttribute("data-section-link") === name;
          a.classList.toggle("is-active", on);
          if (on) a.setAttribute("aria-current", "page");
          else a.removeAttribute("aria-current");
        });
      }

      window.addEventListener("hashchange", () => showSection(sectionFromHash(location.hash)));
      showSection(sectionFromHash(location.hash));

      // ---------------------------------------------------------------------
      // Cards: the print queue as printable sheets
      // (odd/tasks/print-queue-cards.md S4-S6)
      // ---------------------------------------------------------------------

      /** Sheet size in mm for a preset of the original generator. */
      function sheetPresetSize(preset, customW, customH) {
        if (preset === "custom") return { w: customW, h: customH, single: false };
        const parts = String(preset).split("x").map(Number);
        return { w: parts[0], h: parts[1], single: preset === "100x100" };
      }

      /**
       * How many 100 mm cards fit, as columns and rows from the top-left
       * margin. Never centred: the unused part of a sheet stays in one piece.
       */
      function computeSheetLayout(w, h, margin, gap, count) {
        const card = 100;
        const fits = w - 2 * margin + gap >= card + gap && h - 2 * margin + gap >= card + gap;
        const cols = Math.max(1, Math.floor((w - 2 * margin + gap) / (card + gap)));
        const rows = Math.max(1, Math.floor((h - 2 * margin + gap) / (card + gap)));
        const cap = cols * rows;
        return { cols: cols, rows: rows, cap: cap, pages: Math.max(1, Math.ceil(count / cap)), fits: fits };
      }

      window.__printQueue = [];
      const cardSvgCache = new Map();
      let cardRenderToken = 0;

      function cardOptions() {
        const num = (id, d) => {
          const v = parseFloat(document.getElementById(id).value);
          return isNaN(v) || v < 0 ? d : v;
        };
        const checked = document.querySelector('input[name="card-variant"]:checked');
        return {
          variant: checked ? checked.value : "hybrid",
          design: document.getElementById("card-design").value,
          mirror: document.getElementById("card-mirror").checked,
          crop: document.getElementById("card-crop").checked,
          preset: document.getElementById("card-sheet").value,
          margin: num("card-margin", 10),
          gap: num("card-gap", 6),
          w: num("card-sheet-w", 600),
          h: num("card-sheet-h", 400),
        };
      }

      function renderQueueList(queue) {
        return queue.map((item) =>
          '<li><span class="code">' + esc(item.short_code) + '</span>' +
          '<button type="button" class="btn-sm btn-outline" data-action="unqueue-print" data-id="' + esc(item.id) + '">Remove</button></li>'
        ).join("");
      }

      async function cardSvg(item, design, variant) {
        const key = item.id + "|" + design + "|" + variant;
        if (cardSvgCache.has(key)) return cardSvgCache.get(key);
        const res = await window.__api("GET", "/api/links/" + encodeURIComponent(item.id) + "/card.svg?design=" + design + "&variant=" + variant);
        if (!res.ok) throw new Error("card " + item.short_code + ": HTTP " + res.status);
        const svg = await res.text();
        cardSvgCache.set(key, svg);
        return svg;
      }

      async function renderCardSheets() {
        const token = ++cardRenderToken;
        const queue = window.__printQueue;
        const o = cardOptions();
        const size = sheetPresetSize(o.preset, o.w, o.h);
        const margin = size.single ? 0 : o.margin;
        const gap = size.single ? 0 : o.gap;
        document.getElementById("card-sheet-w").disabled = o.preset !== "custom";
        document.getElementById("card-sheet-h").disabled = o.preset !== "custom";
        const sheets = document.getElementById("card-sheets");
        const info = document.getElementById("cards-info");
        document.getElementById("cards-export").disabled = queue.length === 0;
        document.getElementById("cards-mark-printed").disabled = queue.length === 0;
        if (queue.length === 0) {
          sheets.innerHTML = '<p class="gate-empty">No cards waiting to be printed. Send unconfigured links to print from the Links section.</p>';
          info.textContent = "";
          return;
        }
        const layout = computeSheetLayout(size.w, size.h, margin, gap, queue.length);
        if (!layout.fits) {
          sheets.innerHTML = "";
          info.textContent = "The sheet is too small for a 100×100 mm card with that margin.";
          return;
        }
        info.textContent = layout.cols + "×" + layout.rows + " = " + layout.cap + " cards per sheet · " +
          queue.length + " card(s) · " + layout.pages + " sheet(s)";
        let svgs;
        try {
          svgs = await Promise.all(queue.map((item) => cardSvg(item, o.design, o.variant)));
        } catch (err) {
          if (token !== cardRenderToken) return;
          sheets.innerHTML = '<p class="gate-empty">Could not load the cards.</p>';
          console.error("cards failed to load", err);
          return;
        }
        if (token !== cardRenderToken) return;
        sheets.textContent = "";
        let sheet = null;
        svgs.forEach((svg, i) => {
          if (i % layout.cap === 0) {
            sheet = document.createElement("div");
            sheet.className = "card-sheet";
            sheet.style.width = size.w + "mm";
            sheet.style.height = size.h + "mm";
            sheet.style.padding = margin + "mm";
            sheet.style.gap = gap + "mm";
            sheet.style.gridTemplateColumns = "repeat(" + layout.cols + ", 100mm)";
            sheet.style.gridAutoRows = "100mm";
            sheets.appendChild(sheet);
          }
          const card = document.createElement("div");
          card.className = "print-card" + (o.mirror ? " is-mirror" : "") + (o.crop ? " is-crop" : "");
          card.innerHTML = svg;
          sheet.appendChild(card);
        });
      }

      async function loadCards() {
        try {
          const res = await window.__api("GET", "/api/links/print-queue");
          if (!res.ok) throw new Error("print queue: HTTP " + res.status);
          const queue = await res.json();
          window.__printQueue = Array.isArray(queue) ? queue : [];
        } catch (err) {
          console.error("print queue failed to load", err);
          return;
        }
        const n = window.__printQueue.length;
        const badge = document.getElementById("cards-count");
        badge.textContent = String(n);
        badge.hidden = n === 0;
        document.getElementById("cards-queue").innerHTML = renderQueueList(window.__printQueue);
        renderCardSheets();
      }

      window.__loadCards = loadCards;

      /**
       * Prints only the sheets, at the sheet size with no page margin (S5).
       * The @page rule and the body class exist just for this print and are
       * removed afterwards, so "Print report" keeps the browser's page.
       */
      function exportCards() {
        if (window.__printQueue.length === 0) return;
        const o = cardOptions();
        const size = sheetPresetSize(o.preset, o.w, o.h);
        let style = document.getElementById("card-page-style");
        if (!style) {
          style = document.createElement("style");
          style.id = "card-page-style";
          document.head.appendChild(style);
        }
        // One millimetre shorter on paper: a sheet exactly the page height can
        // spill a blank page in some print engines.
        style.textContent = "@page { size: " + size.w + "mm " + size.h + "mm; margin: 0; }" +
          " @media print { .card-sheet { height: " + (size.single ? size.h : size.h - 1) + "mm !important; } }";
        document.body.classList.add("printing-cards");
        window.print();
      }

      window.addEventListener("afterprint", () => {
        document.body.classList.remove("printing-cards");
        const style = document.getElementById("card-page-style");
        if (style) style.textContent = "";
      });

      async function markCardsPrinted() {
        const ids = window.__printQueue.map((item) => item.id);
        if (ids.length === 0) return;
        if (!confirm("Mark " + ids.length + " card(s) as printed? They leave the print queue.")) return;
        try {
          const res = await window.__api("POST", "/api/links/printed", { ids: ids });
          if (!res.ok) throw new Error("HTTP " + res.status);
          loadLinks();
        } catch (err) {
          alert("Error: " + (err instanceof Error ? err.message : ""));
        }
      }

      document.getElementById("cards-controls").addEventListener("input", (e) => {
        if (e.target.id === "card-zoom") {
          document.getElementById("card-sheets").style.setProperty("--card-zoom", String(e.target.value / 100));
          return;
        }
        renderCardSheets();
      });
      document.getElementById("cards-controls").addEventListener("change", (e) => {
        if (e.target.id !== "card-zoom") renderCardSheets();
      });
      document.getElementById("cards-export").addEventListener("click", exportCards);
      document.getElementById("cards-mark-printed").addEventListener("click", markCardsPrinted);
      document.getElementById("cards-queue").addEventListener("click", (e) => {
        const el = e.target.closest('[data-action="unqueue-print"]');
        if (el) setPrintQueued(el.dataset.id, false);
      });

      async function loadFeedbackInbox() {
        const body = document.getElementById("feedback-body");
        if (!body) return;
        try {
          const res = await window.__api("GET", "/api/review-gate/feedback" + feedbackQuery());
          // Checked before the body is read as an inbox: a 401 or 500 is JSON
          // too, and rendering it would either throw somewhere inside the
          // renderer or, worse, draw an empty inbox that looks like no one wrote.
          if (!res.ok) throw new Error("feedback inbox: HTTP " + res.status);
          body.innerHTML = renderFeedbackInbox(await res.json());
        } catch (err) {
          body.innerHTML = '<p class="gate-empty">Could not load comments.</p>';
          console.error("feedback inbox failed to load", err);
        }
      }

      /**
       * The CSV export, downloaded through window.__api.
       *
       * Not a plain link: every tenant-scoped route authenticates with an
       * Authorization: Bearer header and picks the tenant with X-Tenant-Slug,
       * and a navigation carries neither — an href here would be a 401. So
       * the file is fetched with the same headers as every other call and
       * handed to the browser as a Blob. One auth path, nothing hand-written
       * to drift out of sync with it.
       *
       * The server cannot say "truncated" inside the CSV without corrupting
       * it, so it says so in X-Truncated, and this says it to the owner.
       */
      async function exportFeedbackCsv(btn, msg) {
        btn.disabled = true;
        msg.className = "message";
        msg.textContent = "";
        try {
          const res = await window.__api("GET", "/api/review-gate/feedback.csv" + feedbackQuery());
          // A refused export answers with a JSON error body. Read as a blob it
          // would download as customer-feedback.csv and look like a file, so
          // the status is checked first and the owner is told instead.
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            msg.className = "message error";
            msg.textContent = "Could not export: " +
              (body.detail || body.error || "HTTP " + res.status);
            return;
          }
          const blob = await res.blob();
          const href = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = href;
          a.download = "customer-feedback.csv";
          document.body.appendChild(a);
          a.click();
          a.remove();
          // Revoked on a delay: some browsers start the download after the
          // click handler returns, and an already-revoked URL cancels it.
          setTimeout(() => URL.revokeObjectURL(href), 10000);

          if (res.headers.get("X-Truncated") === "true") {
            msg.className = "message notice";
            msg.textContent = "The file holds the newest " +
              (res.headers.get("X-Feedback-Limit") || "") +
              " comments; older ones were left out.";
          }
        } catch (err) {
          msg.className = "message error";
          msg.textContent = err instanceof Error ? err.message : "Could not export";
        } finally {
          btn.disabled = false;
        }
      }

      document.getElementById("feedback-export").addEventListener("click", (e) =>
        exportFeedbackCsv(e.currentTarget, document.getElementById("feedback-export-msg")));

      document.getElementById("feedback-email-save").addEventListener("click", async () => {
        const input = document.getElementById("feedback-email");
        const msg = document.getElementById("feedback-email-msg");
        const btn = document.getElementById("feedback-email-save");

        btn.disabled = true;
        msg.className = "message";
        msg.textContent = "";

        try {
          const res = await window.__api("PUT", "/api/tenant/feedback-email", {
            feedback_email: input.value,
          });

          // Only say "saved" when the server agreed. A confirmation that lies
          // is worse than no confirmation: the owner walks away believing an
          // address is recorded that is not.
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            msg.className = "message error";
            msg.textContent = body.detail || body.error || "Could not save";
            return;
          }

          msg.className = "message success";
          msg.textContent = "Saved.";
        } catch (err) {
          msg.className = "message error";
          msg.textContent = err instanceof Error ? err.message : "Error";
        } finally {
          btn.disabled = false;
        }
      });

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
          // No destination, and \`is_gated\` as the owner chose it. It used to be
          // forced on; it is opt-in now (odd/tasks/review-screen-refresh.md, S1)
          // and the modal's help text states the cost: an ungated card goes
          // straight to its destination and records nothing for the panel.
          // The label is applied to EVERY card in the batch on purpose. It is
          // one field for the whole run rather than one per card, because the
          // question being asked is "where does this batch go" — ten stickers
          // for the main room — not ten separate identities.
          const label = document.getElementById("bulk-label").value.trim();
          const gated = document.getElementById("bulk-gated").checked;
          const links = Array.from({ length: count }, () => ({
            is_gated: gated,
            ...(label ? { client_ref: label } : {}),
          }));
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
       * The busy-hours chart: 24 CSS bars, one per local hour of the day.
       *
       * Bar height is the hour against the busiest one, like the peak chart in
       * the satisfaction panel. The busiest hour is also written out as text,
       * because a screenshot of bars alone does not say which bar is 13:00.
       */
      function renderHourlyTraffic(payload) {
        const hours = (payload && Array.isArray(payload.hours)) ? payload.hours : [];
        const label = (h) => String(h).padStart(2, "0") + ":00";
        const footnote = '<p class="estimate-note">Last ' + esc(payload && payload.window) +
          " · " + esc(payload && payload.time_zone) + " time. Every scan counts, including repeat scans.</p>";
        const busiest = hours.reduce((top, h) => (h.scans > top.scans ? h : top), { hour: 0, scans: 0 });
        if (busiest.scans === 0) {
          return '<p class="gate-empty">No scans in the last ' + esc(payload && payload.window) + " yet.</p>";
        }
        const bars = hours.map((h) => {
          const height = Math.round((h.scans / busiest.scans) * 100);
          return '<div class="hour-bar" style="height:' + height + '%;" title="' +
            esc(label(h.hour)) + " · " + esc(h.scans) + ' scans"></div>';
        }).join("");
        return '<p class="hour-summary">Busiest hour: ' + label(busiest.hour) + "–" +
            label((busiest.hour + 1) % 24) + " (" + esc(busiest.scans) + " scans)</p>" +
          '<div class="peak-chart">' + bars + "</div>" +
          '<div class="peak-axis"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:00</span></div>' +
          footnote;
      }

      /**
       * Loads the busy-hours card on its own. It degrades to hidden on failure
       * instead of failing the links table: it is a report, not the workflow.
       */
      async function loadHourlyTraffic() {
        const card = document.getElementById("traffic-card");
        const body = document.getElementById("traffic-body");
        if (!card || !body) return;
        try {
          const res = await window.__api("GET", "/api/traffic/hourly");
          if (!res.ok) throw new Error("hourly traffic: HTTP " + res.status);
          body.innerHTML = renderHourlyTraffic(await res.json());
          card.style.display = "";
        } catch (err) {
          card.style.display = "none";
          console.error("hourly traffic failed to load", err);
        }
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
          case "edit":
            openEditor(el.dataset.id, el.dataset.code, e);
            break;
          case "save-client-ref":
            saveClientRef(el.dataset.id);
            break;
          case "toggle":
            toggleLink(el.dataset.id, el.dataset.active === "true");
            break;
          case "toggle-gate":
            // A click on a checkbox has already flipped it, so \`checked\` is
            // the state the owner asked for.
            setGated(el.dataset.id, el.checked);
            break;
          case "save-destination":
            saveDestination(el.dataset.id);
            break;
          case "save-branch":
            saveBranch(el.dataset.id);
            break;
          case "delete":
            deleteLink(el.dataset.id);
            break;
          case "queue-print":
            setPrintQueued(el.dataset.id, true);
            break;
          case "unqueue-print":
            setPrintQueued(el.dataset.id, false);
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
        // The print queue follows every links refresh: queuing, removing and
        // saving a destination all end in loadLinks(). Reached through window
        // so this function stays callable on its own.
        if (window.__loadCards) window.__loadCards();

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
              <td class="hide-sm">\${l.location_name
                ? \`<span class="owner-business">\${esc(l.business_name || "No business")}</span><span class="owner-branch">\${esc(l.location_name)}</span>\`
                : '<span class="owner-none">Unassigned</span>'}</td>
              <td class="hide-sm">\${l.original_url
                ? \`<span class="url-trunc" title="\${esc(l.original_url)}">\${esc(l.original_url)}</span>\`
                : l.print_queued
                  ? \`<button class="btn-sm btn-outline" data-action="unqueue-print" data-id="\${esc(l.id)}">Remove from queue</button>\`
                  : \`<button class="btn-sm btn-outline" data-action="queue-print" data-id="\${esc(l.id)}">Send to print</button>\`}</td>
              <td class="hide-sm">\${l.is_gated
                ? '<span class="badge badge-gated">Review screen</span>'
                : '<span class="badge badge-direct">Direct</span>'}</td>
              <td><a href="#" data-action="metrics" data-id="\${esc(l.id)}" data-code="\${esc(l.short_code)}" class="clicks-link">\${esc(l.clicks_count)}</a></td>
              <td><span class="badge badge-\${status}">\${status}</span>\${l.print_queued ? ' <span class="badge badge-queued">To print</span>' : ""}</td>
              <td><div class="row-actions"><button class="btn-sm btn-outline" data-action="edit" data-id="\${esc(l.id)}" data-code="\${esc(l.short_code)}">Edit</button><button class="btn-sm btn-danger" data-action="delete" data-id="\${esc(l.id)}">Del</button></div></td>
            </tr>
            <tr id="metrics-\${esc(l.id)}" style="display:none;">
              <td colspan="7" class="flush-cell">
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
                        <button class="btn-sm" data-action="qr" data-url="\${esc(shortUrl)}">QR code</button>\${l.original_url ? "" : l.print_queued
                          ? \`<button class="btn-sm btn-outline" data-action="unqueue-print" data-id="\${esc(l.id)}">Remove from queue</button>\`
                          : \`<button class="btn-sm btn-outline" data-action="queue-print" data-id="\${esc(l.id)}">Send to print</button>\`}
                      </div>
                      <p class="field-note">The code that goes on the sticker. This is the destination the printed tag resolves to.</p>
                    </div>
                    <div class="field">
                      <label for="dest-\${esc(l.id)}">Destination</label>
                      <div class="field-row">
                        <input type="text" id="dest-\${esc(l.id)}" value="\${esc(l.original_url)}" placeholder="Not configured yet" class="client-ref-input">
                        <button class="btn-sm btn-primary" data-action="save-destination" data-id="\${esc(l.id)}">Save</button>
                      </div>
                      <!--
                        Editable on EVERY link, not only on card stock. The short
                        code is what is printed, so the destination can change
                        at any time without reprinting. Emptying the field turns
                        the link back into card stock.
                      -->
                      <p class="field-note">\${l.original_url
                        ? "Where the printed code leads. Changing it does not need a reprint."
                        : 'This card has no destination yet. Anyone who scans it opens a "not configured" page. Save the URL whenever it is settled — the printed sticker does not need reprinting.'}</p>
                    </div>
                    <div class="field">
                      <label for="branch-\${esc(l.id)}">Branch</label>
                      <div class="field-row">
                        <select id="branch-\${esc(l.id)}" data-current="\${esc(l.location_id)}" class="client-ref-input"></select>
                        <button class="btn-sm btn-outline" data-action="save-branch" data-id="\${esc(l.id)}">Save</button>
                      </div>
                      <p class="field-note">The business and branch this sticker belongs to. Its comments and ratings are grouped there.</p>
                    </div>
                    <div class="field">
                      <label>Review screen</label>
                      <label class="check-row">
                        <input type="checkbox" data-action="toggle-gate" data-id="\${esc(l.id)}"\${l.is_gated ? " checked" : ""}>
                        <span>Show before redirecting</span>
                      </label>
                      <p class="field-note">\${l.is_gated
                        ? "Scans show the star rating, the Google button and a private comment form."
                        : "Scans go straight to the destination. Nothing is recorded for the satisfaction panel."}</p>
                    </div>
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
          fillBranchSelects();
        } catch (err) {
          empty.textContent = "Could not load links. " + (err instanceof Error ? err.message : "");
          empty.style.display = "";
        } finally {
          loading.style.display = "none";
        }
      }

      /**
       * Sends an unconfigured link to the print queue, or takes it out
       * (odd/tasks/print-queue-cards.md S2-S3). loadLinks() refreshes the
       * table and, through it, the Cards section.
       */
      async function setPrintQueued(id, queued) {
        try {
          const res = await window.__api("PATCH", "/api/links/" + id, { print_queued: queued });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.message || body.error || "HTTP " + res.status);
          }
          loadLinks();
        } catch (err) {
          alert("Error: " + (err instanceof Error ? err.message : ""));
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

      // Same update path as toggleLink. The server invalidates the cached
      // redirect, so the next scan already follows the new choice.
      // Re-renders on failure too: the checkbox already flipped in the browser,
      // and only a reload puts it back to what the server actually holds.
      async function setGated(id, gated) {
        try {
          const res = await window.__api("PATCH", "/api/links/" + id, { is_gated: gated });
          if (!res.ok) throw new Error("Failed");
        } catch (err) {
          alert("Error: " + (err instanceof Error ? err.message : ""));
        }
        loadLinks();
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
       * Saves a link's destination from its row field.
       *
       * Any link, not only card stock: the short code is what is printed, so
       * the destination can change at any time without reprinting. An emptied
       * field is sent as null, which turns the link back into card stock — the
       * escape hatch for a typo'd URL.
       *
       * Not validated here on purpose. The same URL rules apply as on create,
       * and a second copy of them in the browser is how the two drift apart.
       */
      async function saveDestination(id) {
        const input = document.getElementById("dest-" + id);
        if (!input) return;
        const value = input.value.trim();
        try {
          const res = await window.__api("PATCH", "/api/links/" + id, {
            original_url: value === "" ? null : value,
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || "Failed");
          }
        } catch (err) {
          alert("Error: " + (err instanceof Error ? err.message : ""));
        }
        loadLinks();
      }

      /** Assigns a link to a branch (location), or to none with "". */
      async function saveBranch(id) {
        const select = document.getElementById("branch-" + id);
        if (!select) return;
        const value = select.value;
        try {
          const res = await window.__api("PATCH", "/api/links/" + id, {
            location_id: value === "" ? null : value,
          });
          if (!res.ok) throw new Error("Failed");
        } catch (err) {
          alert("Error: " + (err instanceof Error ? err.message : ""));
        }
        loadLinks();
      }

      /**
       * Fills every row's branch picker from the branches list.
       *
       * Done after the table is in the DOM rather than inside the row template,
       * so the template stays a pure function of the link (the tests compile
       * and run it on its own). Options are built with DOM APIs, never with
       * innerHTML, because branch and business names are typed by a person.
       */
      function fillBranchSelects() {
        const all = window.__branches || [];
        const branches = pickableBranches(all, window.__businesses || []);
        const label = (b) => (b.business_name ? b.business_name + " — " : "") + b.name;
        document.querySelectorAll('select[id^="branch-"]').forEach((select) => {
          const current = select.dataset.current || "";
          select.textContent = "";
          select.add(new Option("Unassigned", ""));
          branches.forEach((b) => select.add(new Option(label(b), b.id, false, b.id === current)));
          // The branches list has not loaded (or failed), but the link HAS a
          // branch. Without this the picker would show "Unassigned" selected,
          // and one Save would silently detach the link.
          // The same holds for a link whose branch was switched off: it stays,
          // named and marked, until someone picks another.
          if (current && !branches.some((b) => b.id === current)) {
            const known = all.find((b) => b.id === current);
            select.add(new Option(known ? label(known) + " (inactive)" : "Current branch", current, true, true));
          }
        });
      }

      /**
       * Loads the tenant's branches (locations, with their business) for the
       * row pickers, then refills any picker already on screen. Separate from
       * loadLinks: the list changes when branches are managed, not when a link
       * is toggled.
       */
      async function loadBranches() {
        const card = document.getElementById("businesses-body");
        try {
          const [locRes, bizRes] = await Promise.all([
            window.__api("GET", "/api/locations"),
            window.__api("GET", "/api/businesses"),
          ]);
          if (!locRes.ok) throw new Error("branches: HTTP " + locRes.status);
          if (!bizRes.ok) throw new Error("businesses: HTTP " + bizRes.status);
          window.__branches = (await locRes.json()).locations || [];
          window.__businesses = (await bizRes.json()).businesses || [];
          if (card) card.innerHTML = renderBusinesses(window.__businesses, window.__branches);
          fillFeedbackFilter();
        } catch (err) {
          console.error("branches failed to load", err);
          if (card) card.innerHTML = '<p class="gate-empty">Could not load businesses.</p>';
        }
        fillBranchSelects();
      }

      /**
       * The businesses card: each business with its branches, then the
       * branches that belong to none, each with a picker to move it into one.
       * Every name is escaped — they are typed by a person.
       */
      /**
       * Branches that can be chosen in a picker: switched on, and not inside a
       * switched-off business. The card still lists everything, so an inactive
       * one can be switched back on.
       */
      function pickableBranches(branches, businesses) {
        const off = new Set(businesses.filter((b) => b.is_active === false).map((b) => b.id));
        return branches.filter((l) => l.is_active !== false && !off.has(l.business_id));
      }

      function renderBusinesses(businesses, branches) {
        const active = businesses.filter((b) => b.is_active !== false);
        const toggle = (attrs, isActive) =>
          \`<button type="button" class="btn-sm btn-outline" \${attrs} data-active="\${isActive ? "false" : "true"}">\${isActive ? "Deactivate" : "Activate"}</button>\`;
        const inactiveNote = '<span class="field-note">Inactive</span>';

        // Every branch can move: to another active business, or out of its own.
        const branchLine = (l) => {
          const targets = active
            .filter((b) => b.id !== l.business_id)
            .map((b) => \`<option value="\${esc(b.id)}">\${esc(b.name)}</option>\`)
            .join("") + (l.business_id ? '<option value="none">No business</option>' : "");
          const isActive = l.is_active !== false;
          return \`<li class="biz-branch">
            <span>\${esc(l.name)} <span class="field-note">\${esc(l.link_count)} links</span> \${isActive ? "" : inactiveNote}</span>
            <span class="field-row">
              <select id="move-\${esc(l.id)}"><option value="">Move to…</option>\${targets}</select>
              <button type="button" class="btn-sm btn-outline" data-biz-action="move-branch" data-location-id="\${esc(l.id)}">Move</button>
              \${toggle(\`data-biz-action="toggle-branch" data-location-id="\${esc(l.id)}"\`, isActive)}
            </span>
          </li>\`;
        };

        const groups = businesses.map((b) => {
          const own = branches.filter((l) => l.business_id === b.id);
          const isActive = b.is_active !== false;
          return \`<div class="biz-group">
            <div class="biz-name">\${esc(b.name)} \${isActive ? "" : inactiveNote}
              \${toggle(\`data-biz-action="toggle-business" data-business-id="\${esc(b.id)}"\`, isActive)}</div>
            <ul class="biz-branches">\${own.length ? own.map(branchLine).join("") : '<li class="field-note">No branches yet.</li>'}</ul>
            <div class="field-row">
              <input type="text" id="new-branch-\${esc(b.id)}" maxlength="120" placeholder="New branch, e.g. Providencia">
              <button type="button" class="btn-sm btn-outline" data-biz-action="add-branch" data-business-id="\${esc(b.id)}">Add</button>
            </div>
          </div>\`;
        });

        const loose = branches.filter((l) => !l.business_id);
        if (loose.length) {
          groups.push(\`<div class="biz-group">
            <div class="biz-name">Not in a business</div>
            <ul class="biz-branches">\${loose.map(branchLine).join("")}</ul>
          </div>\`);
        }

        return groups.length ? groups.join("") : '<p class="field-note">No businesses yet. Add the first one above.</p>';
      }

      /** Reloads everything that shows a business or branch name. */
      function refreshOwnership() {
        loadBranches();
        loadLinks();
      }

      function showBusinessesMessage(text, kind) {
        const msg = document.getElementById("businesses-msg");
        msg.className = "message" + (kind ? " " + kind : "");
        msg.textContent = text;
      }

      async function addBusiness() {
        const input = document.getElementById("new-business-name");
        const name = input.value.trim();
        if (!name) return;
        const res = await window.__api("POST", "/api/businesses", { name });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          showBusinessesMessage(body.error || "Could not add the business.", "error");
          return;
        }
        input.value = "";
        showBusinessesMessage("", "");
        refreshOwnership();
      }

      async function addBranch(businessId) {
        const input = document.getElementById("new-branch-" + businessId);
        if (!input) return;
        const name = input.value.trim();
        if (!name) return;
        const res = await window.__api("POST", "/api/locations", { name, business_id: businessId });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          showBusinessesMessage(body.error || "Could not add the branch.", "error");
          return;
        }
        showBusinessesMessage("", "");
        refreshOwnership();
      }

      async function moveBranch(locationId) {
        const select = document.getElementById("move-" + locationId);
        if (!select) return;
        const value = select.value;
        if (value === "") return;
        // "none" takes the branch out of its business.
        const res = await window.__api("PATCH", "/api/locations/" + locationId, {
          business_id: value === "none" ? null : value,
        });
        if (!res.ok) {
          showBusinessesMessage("Could not move the branch.", "error");
          return;
        }
        showBusinessesMessage("", "");
        refreshOwnership();
      }

      async function setBusinessActive(businessId, isActive) {
        const res = await window.__api("PATCH", "/api/businesses/" + businessId, { is_active: isActive });
        if (!res.ok) {
          showBusinessesMessage("Could not update the business.", "error");
          return;
        }
        showBusinessesMessage("", "");
        refreshOwnership();
      }

      async function setBranchActive(locationId, isActive) {
        const res = await window.__api("PATCH", "/api/locations/" + locationId, { is_active: isActive });
        if (!res.ok) {
          showBusinessesMessage("Could not update the branch.", "error");
          return;
        }
        showBusinessesMessage("", "");
        refreshOwnership();
      }

      // Static and delegated listeners, like the create form's. Not routed
      // through the links table's data-action switch: these act on businesses
      // and branches, not on a link row.
      document.getElementById("add-business").addEventListener("click", addBusiness);
      document.getElementById("businesses-body").addEventListener("click", (e) => {
        const el = e.target.closest("[data-biz-action]");
        if (!el) return;
        if (el.dataset.bizAction === "add-branch") addBranch(el.dataset.businessId);
        else if (el.dataset.bizAction === "move-branch") moveBranch(el.dataset.locationId);
        else if (el.dataset.bizAction === "toggle-business") setBusinessActive(el.dataset.businessId, el.dataset.active === "true");
        else if (el.dataset.bizAction === "toggle-branch") setBranchActive(el.dataset.locationId, el.dataset.active === "true");
      });

      /**
       * The row's Edit button. Opens the same panel the clicks count opens —
       * destination, branch, review screen — and puts the cursor in the
       * destination field. Unlike the clicks count it never CLOSES the panel:
       * pressing Edit on an open row should keep it open.
       */
      function openEditor(id, code, e) {
        e.preventDefault();
        const row = document.getElementById("metrics-" + id);
        if (row && row.style.display === "none") showMetrics(id, code, e);
        const input = document.getElementById("dest-" + id);
        if (input) input.focus();
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

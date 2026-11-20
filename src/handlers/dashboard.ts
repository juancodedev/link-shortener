import type { Handler } from "hono";
import type { AppEnv, HonoVars } from "../types/env";
import { VISITOR_ESTIMATE_CAVEAT } from "../analytics/metrics";
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
      --card-size: 100mm;      /* Printed card edge: never more than 10×10 cm */

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
    .btn-outline:disabled { background: transparent; color: var(--ink-faint); border-color: var(--edge); }
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

    /* Gate panel sub-headings and empty state. Shared with the Overview
       island (web/src/overview), which emits these classes. */
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
       a script toggles those elements through .style.display. */
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
    .check-row input[type="checkbox"],
    .check-row input[type="radio"] { width: 1.125rem; height: 1.125rem; margin: 0; flex: none; accent-color: var(--tag); }
    .gap-top { margin-top: 1rem; }
    .gap-top-sm { margin-top: 0.5rem; }
    .report-actions { display: flex; justify-content: flex-end; margin-bottom: 0.75rem; }
    .badge-queued { background: var(--stale-wash); color: var(--stale); }
    .badge-printed { background: var(--live-wash); color: var(--live); }
    .badge[hidden] { display: none; }
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
    #card-sheets { overflow-x: auto; padding: 0.5rem 0; }
    .card-sheet {
      zoom: var(--card-zoom);
      display: grid;
      justify-content: start;
      align-content: start;
      box-sizing: border-box;
      background: var(--paper);
      outline: 1px solid var(--edge);
      margin: 0 0 1rem;
    }
    .print-card { position: relative; width: var(--card-size); height: var(--card-size); overflow: hidden; border-radius: 5mm; background: var(--paper); }
    /* Cut guides are an overlay, not an outline: a mirrored SVG is composited
       on its own layer and paints over its parent's outline, which hid the
       guides exactly when Modo Espejo was on. */
    .print-card.is-crop::after {
      content: ""; position: absolute; inset: 0; z-index: 2; pointer-events: none;
      border: 0.25mm dashed var(--ink-faint); border-radius: 5mm;
    }
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
      body.printing-cards .card-sheet { zoom: 1 !important; margin: 0; outline: none; break-inside: avoid; overflow: hidden; }
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
      // 409, and the boot loads run at the end of this IIFE.
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
      // exists. Every caller suspended on this promise (the Links island's
      // load among them, web/src/links) resumes here
      // and finds a callable window.__api, however early it was invoked.
      // Resolving it any earlier — on the session, before the assignment — would
      // hand every waiter straight back the race this gate exists to close.
      //
      // The unauthenticated branch above returns WITHOUT resolving: the browser
      // is already navigating to /login, and a load started there could only
      // fail. Leaving waiters parked is the honest outcome, not a leak.
      window.__apiReadyResolve?.();

      // Once, at boot, not on every links load: the feedback address belongs
      // to the tenant and not to any row, so re-reading it whenever a link is
      // toggled would be a request per keystroke of someone else's workflow.
      if (typeof loadFeedbackEmail === "function") loadFeedbackEmail();
      if (typeof loadFeedbackInbox === "function") loadFeedbackInbox();
      if (typeof loadBranches === "function") loadBranches();
      // No links or Overview loads here: those islands (a module, so it runs
      // after this page is parsed) load themselves once this gate opens.
      // Calling them from here as well would load them twice.
    })();
  </script>
  <!-- React islands (web/, odd/tasks/dashboard-react.md S2): a module runs
       after the scripts above, so window.__api already exists. -->
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
      <h3>Your Links (<span id="link-count">0</span>/${activeLinkLimit})</h3>
      <div id="links-loading" class="loading">Loading...</div>
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
      <p class="estimate-note"><strong>About visitor figures:</strong> ${VISITOR_ESTIMATE_CAVEAT}</p>
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

    <script>
      /**
       * The esbuild runtime shim.
       *
       * \`renderFeedbackInbox.toString()\` below serialises the ALREADY-BUNDLED
       * function, because the Worker this handler ships in was compiled by
       * esbuild with \`keepNames: true\` — which rewrites every named function
       * inside the body to a \`__name(fn, "fn")\` statement. Those statements
       * ride along in the stringified source and then execute HERE.
       *
       * \`__name\` is defined at the top of the Worker bundle, in module scope,
       * so it does not exist in this page. Without this line the very first
       * call throws \`ReferenceError: __name is not defined\` and the comments
       * inbox never renders. (The review-gate panel, the first function
       * injected this way, is a React component now: web/src/overview.)
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

      // Self-contained on purpose, see feedback-inbox.ts.
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
       * The dependency is real, so it is expressed as a dependency: the Links
       * island (web/src/links) awaits this promise, and the bootstrap resolves
       * it once the helper is defined. A bare load call here is gone because it was never
       * right — this script can only wire things up, the load belongs to the
       * bootstrap that owns the session. A setTimeout would have hidden the
       * race rather than closing it, and would flake differently under load.
       *
       * Created HERE, ahead of the bootstrap script, so a caller running at
       * parse time finds the gate rather than undefined.
       */
      window.__apiReady = new Promise((resolve) => { window.__apiReadyResolve = resolve; });

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
      // Kept out of the links load's all-or-nothing fetch on purpose. A failure here
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
      // Bridges for the React islands (web/, odd/tasks/dashboard-react.md).
      //
      // The Links (T3a/T3b) and Overview (T4) sections and the print queue
      // are React now, and each loads its own data (L13). What this page
      // still lends them is window.__api and its readiness gate, and the
      // branches load (loadBranches, announced with brancheschange). The
      // print queue and window.__loadLinks are lent the other way, by the
      // bundle (web/src/print-queue.ts, web/src/links).
      // ---------------------------------------------------------------------

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

      /**
       * Escapes a value for interpolation into innerHTML or a double-quoted
       * attribute value.
       *
       * The card this page still renders by string (businesses and branches) is
       * built by assigning a string to innerHTML, so every interpolated value
       * is an injection vector. This helper is the only sanctioned way to put
       * record data into that markup. The links table and the Overview cards
       * no longer need it: they are React islands and render record data as
       * text (web/src/links, web/src/overview).
       *
       * It is NOT a defence for JavaScript context. An onclick="..." body is
       * handed to the JS engine, where &quot; and &#39; are ordinary characters
       * that terminate nothing — so no generated markup carries an inline
       * handler, and values reach JS through data-* attributes read via \`dataset\`.
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
       * Loads the tenant's branches (locations, with their business) for the
       * row pickers, then tells the Links island, which rebuilds its pickers
       * from window.__branches. Separate from the links load: the list changes
       * when branches are managed, not when a link is toggled.
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
        window.dispatchEvent(new Event("brancheschange"));
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
        if (window.__loadLinks) window.__loadLinks();
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

      // Static and delegated listeners: these act on businesses and branches,
      // not on a link row.
      document.getElementById("add-business").addEventListener("click", addBusiness);
      document.getElementById("businesses-body").addEventListener("click", (e) => {
        const el = e.target.closest("[data-biz-action]");
        if (!el) return;
        if (el.dataset.bizAction === "add-branch") addBranch(el.dataset.businessId);
        else if (el.dataset.bizAction === "move-branch") moveBranch(el.dataset.locationId);
        else if (el.dataset.bizAction === "toggle-business") setBusinessActive(el.dataset.businessId, el.dataset.active === "true");
        else if (el.dataset.bizAction === "toggle-branch") setBranchActive(el.dataset.locationId, el.dataset.active === "true");
      });
    </script>
  `;

  return c.html(shell("Dashboard", body, c.env.SUPABASE_URL, c.env.SUPABASE_ANON_KEY));
};

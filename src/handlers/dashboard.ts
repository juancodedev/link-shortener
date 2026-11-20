import type { Handler } from "hono";
import type { AppEnv, HonoVars } from "../types/env";
import { VISITOR_ESTIMATE_CAVEAT } from "../analytics/metrics";
import { resolveMaxActiveLinks } from "../api/links";
import { icon } from "./icons";

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

    /* The feedback inbox. Shared with the Comments island (web/src/comments),
       which emits these classes. The comment wraps rather than being cut: the API
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
  <!--
    Deployment config for the bundle's auth bootstrap (web/src/shell/auth.ts),
    as data rather than code: the Worker stays the source of these values and
    the page carries no inline executable script. The anon key is public by
    design; nothing else goes here.
  -->
  <script type="application/json" id="dashboard-config">${configJson({ supabaseUrl, supabaseAnonKey })}</script>
  <!-- The shell (auth, API helper, tenant picker, sidebar routing) and every
       section are the React bundle (web/, odd/tasks/dashboard-react.md). -->
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

  return c.html(shell("Dashboard", body, c.env.SUPABASE_URL, c.env.SUPABASE_ANON_KEY));
};

import type { FeedbackRow } from "../api/review-gate";

// ---------------------------------------------------------------------------
// The inbox: what customers wrote.
//
// WHY THIS EXISTS
//
// The satisfaction panel beside it answers "how many people were satisfied",
// which is an aggregate. The comments behind it were stored all along and no
// screen showed a single one. This is that screen.
//
// EVERY STRING HERE IS HOSTILE UNTIL ESCAPED
//
// The comment, the contact, even the location name, were typed by someone —
// the comment and the contact by a stranger, into a public form that needs no
// account. The dashboard assigns this output with `innerHTML`, so one unescaped
// `<img onerror>` in a comment runs in the owner's session, with the owner's
// token in `window.__token`. Every interpolation below goes through
// `escapeHtml`, the dates included, because "this field cannot contain markup"
// is an assumption about the server that this function has no way to check.
//
// NO TRUNCATION HERE EITHER
//
// The API returns the full comment, and so does this. The stylesheet wraps it;
// nothing cuts it. An owner who sees "the soup was cold and the waiter..." has
// been told less than the customer said.
//
// SELF-CONTAINED, LIKE `renderGatePanel`
//
// `dashboard.ts` ships this function to the browser with
// `Function.prototype.toString()`. Everything it calls is nested inside it; a
// module-scope helper would be a `ReferenceError` in the page while every unit
// test passed. `test/handlers/feedback-inbox.test.ts` rehydrates the source in
// isolation to keep that failure closed.
// ---------------------------------------------------------------------------

export interface FeedbackInboxPayload {
  feedback: FeedbackRow[];
  truncated: boolean;
  limit: number;
}

export function renderFeedbackInbox(payload: FeedbackInboxPayload): string {
  function escapeHtml(raw: string): string {
    return raw.replace(
      /[&<>"']/g,
      (ch) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[ch]!,
    );
  }

  /**
   * Where the comment came from: the location, the sticker's client_ref, or
   * an explicit "No location". Both are shown when both exist, because a
   * location named "Terraza" with six tables is not yet an answer to "which
   * table".
   */
  function origin(r: FeedbackRow): string {
    // Business first, then branch, then the sticker's own label: the order an
    // operator managing several businesses reads it in.
    const parts = [r.business_name, r.location_name, r.client_ref].filter(
      (p): p is string => typeof p === "string" && p !== "",
    );
    const where = parts.length > 0 ? parts.map(escapeHtml).join(" · ") : "No location";
    // The short code always, so a comment is traceable to its exact link even
    // when the link was never placed in a branch.
    const code =
      r.short_code !== null && r.short_code !== ""
        ? ` <code class="feedback-code">${escapeHtml(r.short_code)}</code>`
        : "";
    return where + code;
  }

  function item(r: FeedbackRow): string {
    // "No rating" in words. Stars are optional, so a blank or a zero here would
    // read as "this customer gave nothing" — a judgement the customer never made.
    const rating =
      r.rating === null
        ? `<span class="feedback-rating withheld">No rating</span>`
        : `<span class="feedback-rating">${r.rating} / 5</span>`;

    // Phone first: it is the contact the screen recommends, and the one an
    // owner uses to call back about a bad night.
    const contacts = [r.customer_phone, r.customer_contact].filter(
      (v): v is string => typeof v === "string" && v !== "",
    );
    const contact =
      contacts.length > 0
        ? `<div class="feedback-contact">Contact: ${contacts.map(escapeHtml).join(" · ")}</div>`
        : "";

    const when = new Date(r.scanned_at);
    const shown = Number.isNaN(when.getTime()) ? r.scanned_at : when.toLocaleString();

    return `<li class="feedback-item">
        <div class="feedback-meta">
          <time datetime="${escapeHtml(r.scanned_at)}">${escapeHtml(shown)}</time>
          ${rating}
          <span class="feedback-origin">${origin(r)}</span>
        </div>
        <p class="feedback-comment">${escapeHtml(r.comment)}</p>
        ${contact}
      </li>`;
  }

  const { feedback, truncated, limit } = payload;

  if (feedback.length === 0) {
    // Said in words so an empty inbox does not look like a broken one.
    return `<p class="gate-empty">
        No comments yet. When a customer leaves one at the review gate, it appears here.
      </p>`;
  }

  // The cap is stated, never applied silently: an owner who counts a hundred
  // comments would otherwise conclude that is all there is.
  const note = truncated
    ? `<p class="estimate-note">Showing the newest ${limit} comments. Download the CSV
        to see more.</p>`
    : "";

  return `<ul class="feedback-list">${feedback.map(item).join("")}</ul>${note}`;
}

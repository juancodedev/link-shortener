/**
 * The inbox: what customers wrote (dashboard-react T5).
 *
 * WHY THIS EXISTS
 *
 * The satisfaction panel in the Overview answers "how many people were
 * satisfied", which is an aggregate. The comments behind it were stored all
 * along and no screen showed a single one. This is that screen.
 *
 * EVERY STRING HERE IS HOSTILE
 *
 * The comment, the contact, even the location name, were typed by someone —
 * the comment and the contact by a stranger, into a public form that needs no
 * account. This used to be a server-side string renderer assigned with
 * innerHTML (src/handlers/feedback-inbox.ts), where one unescaped
 * `<img onerror>` would run in the owner's session. Here every value is JSX
 * text or an attribute value, which React escapes; nothing is markup.
 *
 * NO TRUNCATION
 *
 * The API returns the full comment, and so does this. The stylesheet wraps it;
 * nothing cuts it. An owner who sees "the soup was cold and the waiter..." has
 * been told less than the customer said.
 */

/**
 * One comment as GET /api/review-gate/feedback returns it. Mirrors
 * `FeedbackRow` in src/api/review-gate.ts, which this bundle cannot import
 * (it pulls in the Worker's database code).
 */
export type FeedbackRow = {
  id: string;
  comment: string;
  rating: number | null;
  /** The email the customer left, if any. */
  customer_contact: string | null;
  /** The phone the customer left, if any. Shown before the email. */
  customer_phone: string | null;
  scanned_at: string;
  short_code: string | null;
  client_ref: string | null;
  location_name: string | null;
  /** The branch's business ("local"), or null when the branch has none. */
  business_name: string | null;
};

export type FeedbackInboxPayload = { feedback: FeedbackRow[]; truncated: boolean; limit: number };

import { LOCALE } from "../format";

const present = (v: string | null | undefined): v is string => typeof v === "string" && v !== "";

/**
 * Where the comment came from. Business first, then branch, then the
 * sticker's own label: the order an operator managing several businesses
 * reads it in. Both branch and client_ref are shown when both exist, because a
 * location named "Terraza" with six tables is not yet an answer to "which
 * table".
 */
function Origin({ r }: { r: FeedbackRow }) {
  const parts = [r.business_name, r.location_name, r.client_ref].filter(present);
  return (
    <span className="feedback-origin">
      {parts.length > 0 ? parts.join(" · ") : "Sin ubicación"}
      {/* The short code always, so a comment is traceable to its exact link
          even when the link was never placed in a branch. */}
      {present(r.short_code) && (
        <>
          {" "}
          <code className="feedback-code">{r.short_code}</code>
        </>
      )}
    </span>
  );
}

function Item({ r }: { r: FeedbackRow }) {
  // Phone first: it is the contact the screen recommends, and the one an
  // owner uses to call back about a bad night.
  const contacts = [r.customer_phone, r.customer_contact].filter(present);
  const when = new Date(r.scanned_at);
  const shown = Number.isNaN(when.getTime()) ? r.scanned_at : when.toLocaleString(LOCALE);

  return (
    <li className="feedback-item">
      <div className="feedback-meta">
        <time dateTime={r.scanned_at}>{shown}</time>{" "}
        {/* "No rating" in words. Stars are optional, so a blank or a zero here
            would read as "this customer gave nothing" — a judgement the
            customer never made. */}
        {r.rating === null ? (
          <span className="feedback-rating withheld">Sin calificación</span>
        ) : (
          <span className="feedback-rating">{r.rating} / 5</span>
        )}{" "}
        <Origin r={r} />
      </div>
      <p className="feedback-comment">{r.comment}</p>
      {contacts.length > 0 && <div className="feedback-contact">Contacto: {contacts.join(" · ")}</div>}
    </li>
  );
}

export function FeedbackInbox({ payload }: { payload: FeedbackInboxPayload }) {
  const { feedback, truncated, limit } = payload;

  if (feedback.length === 0) {
    // Said in words so an empty inbox does not look like a broken one.
    return <p className="gate-empty">Aún no hay comentarios. Cuando un cliente deje uno en la pantalla de reseña, aparecerá aquí.</p>;
  }

  return (
    <>
      <ul className="feedback-list">
        {feedback.map((r, i) => (
          <Item key={`${r.id}:${i}`} r={r} />
        ))}
      </ul>
      {/* The cap is stated, never applied silently: an owner who counts a
          hundred comments would otherwise conclude that is all there is. */}
      {truncated && <p className="estimate-note">Mostrando los {limit} comentarios más recientes. Descarga el CSV para ver más.</p>}
    </>
  );
}

import type { AppEnv } from "../types/env";

// ---------------------------------------------------------------------------
// The dual-path action screen
//
// This is the screen a scan lands on when `links.is_gated` is true. It looks
// like a Google review prompt — the business name, "¿Cómo fue tu experiencia
// hoy?" and a row of five stars — and below it offers two choices, both shown
// from first paint:
//
//   "Publicar reseña en Google"  → straight to the destination (the owner's
//                                  Google review URL)
//   "Enviar comentario privado" → expands an inline feedback form
//
// WHAT THE STARS DO, AND WHAT THEY DELIBERATELY DO NOT DO
//
// The stars are optional and are only RECORDED. A chosen rating rides along on
// the Google click's beacon and on the private form's submission, and feeds
// the satisfaction panel. It never changes which options are shown, their
// order or their prominence: a one-star customer sees exactly the same Google
// button as a five-star one, and nothing appears or disappears when a star is
// picked.
//
// That is the whole point. Routing happy customers to Google and unhappy ones
// to the business is review gating, and Google prohibits it — a gated profile
// can lose its reviews and its local badges. The owner chose the compliant
// variant explicitly. The private channel exists because a customer with a
// small complaint prefers a direct answer to a public post, not because they
// were steered there. Anyone tempted to "show the form only below 5 stars":
// that is the prohibited flow, not an improvement.
//
// Consequence worth knowing: the capture rate of private feedback will be
// materially lower than a gated flow would produce. That is the cost of being
// compliant, and it is why the product sells on the metric panel rather than on
// review protection.
//
// WHY AN HTML STRING AND NOT A COMPONENT
//
// The repo has no build step: no React, no Tailwind, nothing compiled. Every
// other page (landing, dashboard, auth) is a template string with inline styles
// served straight from a Worker. Matching that pattern is what keeps the screen
// one round trip on a phone with a cold isolate, which is the entire latency
// budget here. The stars are inline SVG for the same reason: no font, no image
// request.
//
// HOW THE PAGE WORKS WITHOUT JAVASCRIPT
//
// - The stars are radio inputs, so choosing one needs no script and arrow keys
//   move between them. They sit OUTSIDE the <form> (so they are visible before
//   the panel opens) and join its submission through the HTML `form`
//   attribute, which a browser treats exactly like a nested control.
// - The panel is a `<details>` element, so revealing the form needs no script.
// - The only script is the Google click's fire-and-forget beacon. Without it
//   the link still works; only that one metric is lost.
// ---------------------------------------------------------------------------

export interface ActionScreenParams {
  /** Business name shown as the screen's heading. */
  businessName: string;
  /** The link's stored destination — the owner's Google review URL. */
  destinationUrl: string;
  /** The scanned slug, used as the form's idempotency key. */
  code: string;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escapes text interpolated into markup or an attribute.
 *
 * `businessName` is owner-supplied and `destinationUrl` is whatever URL the
 * owner registered, so neither is trusted to be free of markup. An unescaped
 * business name would be stored XSS in a customer's own dashboard; an unescaped
 * destination would put a `javascript:` URL in an href.
 */
export function escapeHtml(raw: string): string {
  return raw.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]!);
}

/**
 * Rejects destinations that are not http(s).
 *
 * `validateUrl` already enforces this at creation time, but this screen is
 * reachable from any row that reached the redirect path, and a href that starts
 * with `javascript:` executes on click. Re-checking at render costs nothing and
 * removes the dependency on a guarantee made in a different request.
 */
function isSafeDestination(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Design tokens shared by the action screen and the thanks screen, so the two
 * pages a customer sees in a row look like one product.
 */
const BASE_STYLES = `
  :root {
    --bg: #f1f3f4;
    --card: #ffffff;
    --text: #202124;
    --muted: #5f6368;
    --faint: #80868b;
    --line: #dadce0;
    --star-off: #dadce0;
    --star-on: #fbbc04;
    --accent: #1a73e8;
    --accent-press: #1765cc;
    --focus: #1a73e8;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  }
  main {
    width: 100%; max-width: 26rem;
    background: var(--card);
    border-radius: 1rem;
    box-shadow: 0 1px 2px rgba(60, 64, 67, 0.15), 0 2px 8px rgba(60, 64, 67, 0.1);
    padding: 1.75rem 1.25rem 1.5rem;
  }
  h1 { font-size: 1.375rem; font-weight: 600; letter-spacing: -0.01em; text-align: center; }
`;

/** One inline SVG star; `currentColor` lets CSS fill it on hover and selection. */
const STAR_SVG =
  '<svg viewBox="0 0 24 24" width="40" height="40" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>' +
  "</svg>";

const FORM_ID = "fb-form";

function renderStars(): string {
  const stars = [1, 2, 3, 4, 5]
    .map((n) => {
      const label = n === 1 ? "1 estrella" : `${n} estrellas`;
      // `form` associates the radio with the feedback form even though it sits
      // outside it, so a chosen rating is submitted without any script.
      return (
        `<input class="sr" type="radio" id="star-${n}" name="rating" value="${n}" form="${FORM_ID}">` +
        `<label for="star-${n}" title="${label}">${STAR_SVG}<span class="sr">${label}</span></label>`
      );
    })
    .join("");

  return `<fieldset class="stars">
    <legend class="sr">Califica tu experiencia (opcional)</legend>
    <div class="row">${stars}</div>
  </fieldset>`;
}

export function renderActionScreen(params: ActionScreenParams): Response {
  const name = escapeHtml(params.businessName);
  const code = escapeHtml(params.code);

  // If the stored destination is somehow not a web URL, the screen still has
  // to render — it just cannot offer the Google button. Falling back to the
  // tenant's own site would be a silent lie; omitting the action is honest.
  const canRedirect = isSafeDestination(params.destinationUrl);
  const destination = escapeHtml(params.destinationUrl);

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>${name}</title>
<style>${BASE_STYLES}
  p.sub { color: var(--muted); font-size: 0.9375rem; text-align: center; margin-top: 0.25rem; }

  .sr {
    position: absolute; width: 1px; height: 1px; overflow: hidden;
    clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
  }
  fieldset.stars { border: 0; margin: 1.25rem 0 1.5rem; }
  .stars .row { display: flex; justify-content: center; gap: 0.25rem; }
  .stars label {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 48px; min-height: 48px;
    color: var(--star-off);
    cursor: pointer;
    border-radius: 50%;
    transition: color 0.12s ease, transform 0.12s ease;
    -webkit-tap-highlight-color: transparent;
  }
  .stars label:active { transform: scale(0.92); }
  /* Selected: the checked star and every star before it. */
  .stars input:checked + label,
  .stars label:has(~ input:checked) { color: var(--star-on); }
  /* Hover preview, on devices that hover: up to the pointer, never past it. */
  @media (hover: hover) {
    .stars .row:hover label { color: var(--star-off); }
    .stars .row:hover label:hover,
    .stars .row:hover label:has(~ label:hover) { color: var(--star-on); }
  }
  .stars input:focus-visible + label { outline: 2px solid var(--focus); outline-offset: 2px; }

  .actions { display: flex; flex-direction: column; gap: 0.75rem; }
  a.btn, button.btn, summary.btn {
    display: flex; align-items: center; justify-content: center;
    width: 100%; min-height: 3rem;
    padding: 0.8125rem 1rem;
    border-radius: 0.625rem;
    font: inherit; font-size: 1rem; font-weight: 600;
    text-align: center; text-decoration: none;
    border: 1px solid transparent;
    cursor: pointer;
  }
  a.primary { background: var(--accent); color: #fff; }
  a.primary:active { background: var(--accent-press); }
  summary.secondary { background: var(--card); color: var(--accent); border-color: var(--line); list-style: none; }
  summary.secondary::-webkit-details-marker { display: none; }
  details[open] summary.secondary { background: #f8f9fa; }
  a.btn:focus-visible, summary.btn:focus-visible, button:focus-visible,
  textarea:focus-visible, input:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

  form { margin-top: 1rem; display: flex; flex-direction: column; gap: 0.875rem; }
  .field { display: flex; flex-direction: column; gap: 0.3125rem; }
  .field label { font-size: 0.875rem; font-weight: 600; color: var(--text); }
  textarea, input.text {
    width: 100%; padding: 0.75rem;
    border: 1px solid var(--line); border-radius: 0.5rem;
    font: inherit; font-size: 1rem;
    background: var(--card); color: var(--text);
  }
  textarea { min-height: 6rem; resize: vertical; }
  button.submit { background: var(--text); color: #fff; }
  button.submit:active { background: #3c4043; }
  p.note { margin-top: 1.25rem; font-size: 0.8125rem; color: var(--faint); text-align: center; }
</style>
</head>
<body>
<main>
  <h1>${name}</h1>
  <p class="sub">¿Cómo fue tu experiencia hoy?</p>

  ${renderStars()}

  <!--
    Both choices are in the markup from first paint and nothing below depends
    on the rating above. See the header comment of action-screen.ts before
    changing that.
  -->
  <div class="actions">
    ${
      canRedirect
        ? `<a class="btn primary" href="${destination}" rel="noopener noreferrer" data-action="google_redirect">Publicar reseña en Google</a>`
        : ""
    }
    <details id="fb">
      <summary class="btn secondary">Enviar comentario privado</summary>
      <form method="POST" action="/api/gate" id="${FORM_ID}">
        <input type="hidden" name="code" value="${code}">
        <!--
          WITHOUT THIS FIELD EVERY PRIVATE COMMENT 400s.

          The endpoint validates action_taken against google_redirect and
          internal_feedback, and rejects an empty string. The form posted only
          code, comment and customer_contact, so it sent an empty action and every
          submission came back as an invalid_request error, with no way for the
          customer to tell what was wrong.

          Every handler test passes this field by hand, so all of them stayed green
          while the only client that posts to this endpoint in production could not
          use it. Tests on each side of a boundary are not a test of the boundary.
        -->
        <input type="hidden" name="action_taken" value="internal_feedback">
        <!-- The star radios above also submit with this form, as "rating". -->
        <div class="field">
          <label for="fb-comment">Tu mensaje</label>
          <textarea id="fb-comment" name="comment" required maxlength="2000" placeholder="Cuéntanos qué pasó"></textarea>
        </div>
        <!--
          Phone first: a call or a message is how a local business actually
          answers a complaint. It is recommended, not required — demanding it
          would cost comments from people who just want to be heard.
        -->
        <div class="field">
          <label for="fb-phone">Teléfono (recomendado)</label>
          <input class="text" id="fb-phone" type="tel" name="customer_phone" maxlength="40" autocomplete="tel" inputmode="tel">
        </div>
        <div class="field">
          <label for="fb-email">Correo (opcional)</label>
          <input class="text" id="fb-email" type="email" name="customer_contact" maxlength="200" autocomplete="email">
        </div>
        <button class="btn submit" type="submit">Enviar a la dirección</button>
      </form>
    </details>
  </div>

  <p class="note">Tus comentarios los recibe directamente el local.</p>
</main>
<script>
  document.querySelector('[data-action="google_redirect"]')?.addEventListener('click', function () {
    // The rating is read here only to record it. Nothing on this page reacts
    // to it — see the header comment of action-screen.ts.
    var picked = document.querySelector('input[name="rating"]:checked');
    fetch('/api/gate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'code=' + encodeURIComponent(${JSON.stringify(code)}) + '&action_taken=google_redirect' +
        (picked ? '&rating=' + encodeURIComponent(picked.value) : ''),
      keepalive: true
    }).catch(function () {});
  });
  // There is deliberately NO fetch on the panel's toggle.
  //
  // It used to record \`internal_feedback\` the moment the panel opened, with no
  // comment — which the endpoint rejects on purpose, because "a private
  // submission with no comment carries no information". So this request could
  // only ever return 400: it recorded nothing, and it cost a round trip on a
  // customer's phone.
  //
  // If opening the panel is worth measuring, it needs an action of its own that
  // means "saw the option" rather than "left feedback". That is a product
  // decision, not a bug fix, so it is not invented here.
</script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // A customer's phone should never hold a stale destination for a scan.
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

/** Acknowledgement shown after the private form is submitted. */
export function renderFeedbackThanks(businessName: string): Response {
  const name = escapeHtml(businessName);
  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>Gracias — ${name}</title>
<style>${BASE_STYLES}
  main { text-align: center; }
  .check { color: var(--star-on); margin-bottom: 0.5rem; }
  h1 { margin-bottom: 0.375rem; }
  p { color: var(--muted); font-size: 0.9375rem; }
</style>
</head>
<body>
<main>
  <div class="check">${STAR_SVG}</div>
  <h1>Gracias</h1>
  <p>Tu comentario llegó directamente a ${name}.</p>
</main>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/** Suppresses an unused-import warning for AppEnv in this module's contract. */
export type ActionScreenEnv = AppEnv;
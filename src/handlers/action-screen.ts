import type { AppEnv } from "../types/env";

// ---------------------------------------------------------------------------
// The dual-path action screen
//
// This is the screen a scan lands on when `links.is_gated` is true. It offers
// two choices and shows both from first paint:
//
//   "Publicar Reseña en Google"  → straight to the destination (the owner's
//                                  Google review URL)
//   "Enviar Comentario Privado" → expands an inline feedback form
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO
//
// It never hides, delays or conditions the Google link on anything the customer
// says or picks. Routing happy customers to Google and unhappy ones to the
// business is review gating, and Google prohibits it — a gated profile can lose
// its reviews and its local badges. The private channel exists because a
// customer with a small complaint prefers a direct answer to a public post, not
// because they were steered there.
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
// budget here.
//
// The one piece of interactivity is the second button, which reveals the form.
// It uses the `<details>` element so it needs no JavaScript at all.
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
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: #f8fafc;
    color: #1e293b;
    line-height: 1.5;
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.25rem;
  }
  main { width: 100%; max-width: 26rem; }
  h1 { font-size: 1.375rem; font-weight: 600; letter-spacing: -0.01em; margin-bottom: 0.375rem; }
  p.sub { color: #64748b; font-size: 0.9375rem; margin-bottom: 1.75rem; }
  .actions { display: flex; flex-direction: column; gap: 0.75rem; }
  a.btn, button.btn {
    display: block; width: 100%;
    padding: 0.9375rem 1rem;
    border-radius: 0.625rem;
    font-size: 1rem; font-weight: 600;
    text-align: center; text-decoration: none;
    border: 1px solid transparent;
    cursor: pointer;
    min-height: 3rem;
  }
  a.primary { background: #1e293b; color: #fff; }
  a.primary:active { background: #334155; }
  button.secondary { background: #fff; color: #1e293b; border-color: #cbd5e1; }
  details { margin-top: 0.75rem; }
  details form { margin-top: 0.75rem; }
  textarea, input {
    width: 100%; padding: 0.75rem;
    border: 1px solid #cbd5e1; border-radius: 0.5rem;
    font: inherit; font-size: 1rem;
    background: #fff; color: #1e293b;
  }
  textarea { min-height: 6rem; resize: vertical; }
  input { margin-top: 0.5rem; }
  button.submit {
    margin-top: 0.75rem;
    background: #1e293b; color: #fff;
    border-radius: 0.625rem; padding: 0.8125rem 1rem;
    font: inherit; font-weight: 600; width: 100%;
  }
  p.note { margin-top: 1.5rem; font-size: 0.8125rem; color: #94a3b8; }
</style>
</head>
<body>
<main>
  <h1>${name}</h1>
  <p class="sub">¿Cómo fue tu experiencia hoy?</p>

  <div class="actions">
    ${
      canRedirect
        ? `<a class="btn primary" href="${destination}" rel="noopener noreferrer" data-action="google_redirect">Publicar reseña en Google</a>`
        : ""
    }
    <button class="btn secondary" type="button" onclick="document.getElementById('fb').open=true">Enviar comentario privado</button>
  </div>

  <details id="fb">
    <summary style="display:none">Enviar comentario privado</summary>
    <form method="POST" action="/api/gate">
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
      <textarea name="comment" required maxlength="2000" placeholder="Cuéntanos qué pasó"></textarea>
      <input type="email" name="customer_contact" maxlength="200" placeholder="Tu correo (opcional)">
      <button class="submit" type="submit">Enviar a la dirección</button>
    </form>
  </details>

  <p class="note">Tus comentarios los recibe directamente el local.</p>
</main>
<script>
  document.querySelector('[data-action="google_redirect"]')?.addEventListener('click', function () {
    fetch('/api/gate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'code=' + encodeURIComponent(${JSON.stringify(code)}) + '&action_taken=google_redirect',
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
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f8fafc; color: #1e293b;
    min-height: 100dvh; display: flex; align-items: center; justify-content: center;
    padding: 1.25rem; line-height: 1.5;
  }
  main { max-width: 26rem; text-align: center; }
  h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.5rem; }
  p { color: #64748b; font-size: 0.9375rem; }
</style>
</head>
<body>
<main>
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
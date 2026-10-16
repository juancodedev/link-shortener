import type { Handler } from "hono";
import type { AppEnv, HonoVars } from "../types/env";
import { escapeHtml } from "./action-screen";
import { MAX_CLIENT_REF_LENGTH } from "../api/links";

// ---------------------------------------------------------------------------
// GET /setup/:code — card quick setup
//
// The owner has the card in hand and has just scanned it. The unconfigured
// card page sends a browser with a Supabase session here, and this page loads
// the destination and client ref in one step instead of making the owner find
// the link in the dashboard list.
//
// AUTHENTICATION IS THE BROWSER'S, LIKE THE DASHBOARD'S
//
// The server only reads `Authorization: Bearer` JWTs and there are no cookies,
// so this page ships to any caller and the script decides. Nothing in the HTML
// is private: the link itself is fetched with the session's token, through
// GET /api/links/by-code/:code, which checks membership in the code's tenant.
//
// NO LOOPS
//
// /:code sends a logged-in browser here. So when the session turns out to be
// missing or expired, this page must go to the login page with a return path
// to /setup/:code — never back to /:code, which would send it straight here
// again. After a successful save it does go to /:code: the link now has a
// destination, so that page redirects instead of sending it back.
// ---------------------------------------------------------------------------

/**
 * Encodes a value for a `<script>` block. JSON.stringify alone leaves `<`
 * intact, and `</script>` inside a string literal still ends the element.
 */
function scriptValue(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function renderSetupPage(params: {
  code: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
}): string {
  const code = escapeHtml(params.code);

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Configurar tarjeta</title>
<style>
  :root {
    --kraft: #f4f1ea;
    --sticker: #fbf9f5;
    --edge: #ddd6c8;
    --edge-strong: #c4bba9;
    --ink: #2b2622;
    --ink-soft: #6b625a;
    --ink-faint: #8d847a;
    --tag: #a8482a;
    --tag-deep: #8a3a1f;
    --error: #991b1b;
  }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 2.5rem 1.25rem;
         background: var(--kraft); color: var(--ink);
         display: flex; align-items: center; justify-content: center;
         min-height: 100vh; }
  main { max-width: 30rem; width: 100%; background: var(--sticker);
         border: 1px solid var(--edge); border-radius: 12px; padding: 2rem 1.75rem;
         box-shadow: 0 1px 2px rgba(43, 38, 34, 0.05); }
  .tag { display: inline-block; padding: .25rem .6rem; margin-bottom: 1rem;
         font-size: .75rem; letter-spacing: .04em; text-transform: uppercase;
         color: var(--tag); background: rgba(168, 72, 42, .1);
         border: 1px solid rgba(168, 72, 42, .25); border-radius: 999px; }
  h1 { font-size: 1.2rem; margin: 0 0 .75rem; font-weight: 600; }
  p { font-size: .95rem; line-height: 1.6; margin: 0 0 .85rem; color: var(--ink-soft); }
  label { display: block; font-size: .9rem; font-weight: 600; margin: 1rem 0 .35rem; }
  input { width: 100%; padding: .7rem .8rem; font-size: 1rem; color: var(--ink);
          background: #fff; border: 1px solid var(--edge-strong); border-radius: 8px; }
  input:focus { outline: 2px solid var(--tag); outline-offset: 1px; }
  button { width: 100%; margin-top: 1.25rem; padding: .8rem 1.1rem; border: 0;
           background: var(--tag); color: #fff; border-radius: 8px; font-size: 1rem; cursor: pointer; }
  button:hover { background: var(--tag-deep); }
  button:disabled { opacity: .6; cursor: default; }
  .error { color: var(--error); font-size: .9rem; margin-top: .75rem; }
  small { display: block; margin-top: 1.5rem; padding-top: 1rem;
          border-top: 1px solid var(--edge); font-size: .85rem; color: var(--ink-faint); }
  code { font-family: ui-monospace, monospace; font-size: .85rem; background: var(--kraft);
         padding: .1rem .35rem; border-radius: 4px; color: var(--ink-soft); }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <span class="tag">Configurar tarjeta</span>
  <h1>&iquest;A d&oacute;nde debe llevar esta tarjeta?</h1>
  <p id="status">Cargando&hellip;</p>
  <form id="setup-form" hidden novalidate>
    <label for="original_url">Enlace de destino</label>
    <input id="original_url" name="original_url" type="url" required autofocus
           inputmode="url" autocomplete="url" placeholder="https://">
    <label for="client_ref">Referencia del cliente</label>
    <input id="client_ref" name="client_ref" type="text" maxlength="${MAX_CLIENT_REF_LENGTH}"
           autocomplete="off">
    <p id="form-error" class="error" role="alert" hidden></p>
    <button type="submit" id="save">Guardar</button>
  </form>
  <small>C&oacute;digo <code>${code}</code></small>
</main>
<script src="https://unpkg.com/@supabase/supabase-js@2"></script>
<script>
  (async function () {
    var CODE = ${scriptValue(params.code)};
    var status = document.getElementById("status");
    var form = document.getElementById("setup-form");
    var urlInput = document.getElementById("original_url");
    var refInput = document.getElementById("client_ref");
    var formError = document.getElementById("form-error");
    var save = document.getElementById("save");

    // Back to login, returning HERE. Never to /:code: that page is what sent
    // this browser here, so returning to it would be a loop.
    function toLogin() {
      location.replace("/login?next=" + encodeURIComponent("/setup/" + encodeURIComponent(CODE)));
    }

    if (!window.supabase) {
      status.textContent = "No se pudo cargar la página. Revisa tu conexión e intenta de nuevo.";
      return;
    }
    var sb = window.supabase.createClient(${scriptValue(params.supabaseUrl)}, ${scriptValue(params.supabaseAnonKey)});

    var session = (await sb.auth.getSession()).data.session;
    if (!session) { toLogin(); return; }
    var token = session.access_token;

    var res;
    try {
      res = await fetch("/api/links/by-code/" + encodeURIComponent(CODE), {
        headers: { "Authorization": "Bearer " + token },
      });
    } catch (e) {
      status.textContent = "No se pudo conectar. Intenta de nuevo.";
      return;
    }
    if (res.status === 401) { toLogin(); return; }
    if (!res.ok) {
      status.textContent = "No encontramos esta tarjeta o no tienes acceso a ella.";
      return;
    }
    var link = await res.json();

    urlInput.value = link.original_url || "";
    refInput.value = link.client_ref || "";
    status.hidden = true;
    form.hidden = false;
    urlInput.focus();

    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      formError.hidden = true;
      if (!urlInput.checkValidity()) {
        formError.textContent = "Ingresa un enlace válido, por ejemplo https://ejemplo.com";
        formError.hidden = false;
        urlInput.focus();
        return;
      }
      save.disabled = true;
      save.textContent = "Guardando…";

      var ref = refInput.value.trim();
      try {
        var r = await fetch("/api/links/" + encodeURIComponent(link.id), {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + token,
            // The tenant the code belongs to, so the save lands there even for
            // someone who belongs to several.
            "X-Tenant-Slug": link.tenant_slug,
          },
          body: JSON.stringify({ original_url: urlInput.value.trim(), client_ref: ref || null }),
        });
        if (r.status === 401) { toLogin(); return; }
        if (!r.ok) {
          var body = {};
          try { body = await r.json(); } catch (err) {}
          formError.textContent = body.error || "No se pudo guardar. Intenta de nuevo.";
          formError.hidden = false;
          save.disabled = false;
          save.textContent = "Guardar";
          return;
        }
        location.replace("/" + encodeURIComponent(CODE));
      } catch (err) {
        formError.textContent = "No se pudo conectar. Intenta de nuevo.";
        formError.hidden = false;
        save.disabled = false;
        save.textContent = "Guardar";
      }
    });
  })();
</script>
</body>
</html>`;
}

export const setupHandler: Handler<{ Bindings: AppEnv; Variables: HonoVars }> = (c) => {
  const html = renderSetupPage({
    code: c.req.param("code") ?? "",
    supabaseUrl: c.env.SUPABASE_URL,
    supabaseAnonKey: c.env.SUPABASE_ANON_KEY,
  });
  // no-store: the page is the same for everyone, but it is a step in an
  // authenticated flow and a stale copy would only ever be wrong.
  return c.html(html, 200, { "Cache-Control": "no-store" });
};

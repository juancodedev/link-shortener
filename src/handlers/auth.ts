import type { Handler } from "hono";
import type { AppEnv, HonoVars } from "../types/env";
import { SUPABASE_JS_SCRIPT } from "./supabase-cdn";

// ---------------------------------------------------------------------------
// Shared HTML shell
// ---------------------------------------------------------------------------

function htmlShell(title: string, body: string, supabaseUrl: string, supabaseAnonKey: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Más Reseñas</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      min-height: 100dvh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #f8fafc;
      color: #1e293b;
      line-height: 1.6;
    }
    .card {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 0.75rem;
      padding: 2rem;
      width: 100%;
      max-width: 400px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.06);
    }
    h1 {
      font-size: 1.5rem;
      font-weight: 700;
      color: #0f172a;
      margin-bottom: 0.25rem;
      text-align: center;
    }
    .subtitle {
      font-size: 0.875rem;
      color: #64748b;
      text-align: center;
      margin-bottom: 1.5rem;
    }
    label {
      display: block;
      font-size: 0.813rem;
      font-weight: 600;
      color: #475569;
      margin-bottom: 0.25rem;
    }
    input {
      width: 100%;
      padding: 0.625rem 0.75rem;
      border: 1.5px solid #d1d5db;
      border-radius: 0.5rem;
      font-size: 0.938rem;
      margin-bottom: 1rem;
      transition: border-color 0.15s;
    }
    input:focus {
      outline: none;
      border-color: #2563eb;
      box-shadow: 0 0 0 3px rgba(37,99,235,0.1);
    }
    button {
      width: 100%;
      padding: 0.75rem;
      background: #2563eb;
      color: #ffffff;
      border: none;
      border-radius: 0.5rem;
      font-size: 0.938rem;
      font-weight: 600;
      cursor: pointer;
      transition: background-color 0.15s;
      margin-bottom: 1rem;
    }
    button:hover { background: #1d4ed8; }
    button:disabled { background: #94a3b8; cursor: not-allowed; }
    .message {
      font-size: 0.813rem;
      padding: 0.5rem 0.75rem;
      border-radius: 0.375rem;
      margin-bottom: 1rem;
      display: none;
    }
    .message.success { display: block; background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; }
    .message.error { display: block; background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
    .links {
      text-align: center;
      font-size: 0.813rem;
      color: #64748b;
    }
    .links a { color: #2563eb; text-decoration: none; }
    .links a:hover { text-decoration: underline; }
    .back-link {
      display: block;
      text-align: center;
      margin-top: 1rem;
      font-size: 0.813rem;
    }
    .back-link a { color: #64748b; text-decoration: none; }
    .back-link a:hover { color: #2563eb; }
    .password-field {
      position: relative;
    }
    .password-field input {
      padding-right: 2.75rem;
    }
    .toggle-password {
      position: absolute;
      right: 0.5rem;
      top: 0;
      bottom: 0;
      margin-bottom: 1rem;
      display: flex;
      align-items: center;
      justify-content: center;
      background: none;
      border: none;
      padding: 0.25rem;
      cursor: pointer;
      color: #94a3b8;
      width: 2rem;
    }
    .toggle-password:hover {
      color: #475569;
    }
    .toggle-password svg {
      width: 1.25rem;
      height: 1.25rem;
      pointer-events: none;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Más Reseñas</h1>
    ${body}
  </div>
  ${SUPABASE_JS_SCRIPT}
  <script>
    if (!window.supabase) {
      document.body.innerHTML = '<div style="text-align:center;padding:2rem;font-family:sans-serif;"><h2>Cargando…</h2><p>Si esto continúa, revisa tu conexión a internet.</p></div>';
      throw new Error("Supabase client failed to load");
    }
    var sb = window.supabase.createClient("${supabaseUrl}", "${supabaseAnonKey}");

    function togglePassword(inputId, btn) {
      const input = document.getElementById(inputId);
      const svg = btn.querySelector("svg");
      if (input.type === "password") {
        input.type = "text";
        svg.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>';
      } else {
        input.type = "password";
        svg.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
      }
    }
  </script>
</body>
</html>`;
}

/**
 * The only return paths the login page will follow after signing in.
 *
 * Deliberately narrow: card quick setup (`/setup/:code`) is the one flow that
 * sends a browser here and needs it back. An open `next` would make the login
 * page an open redirect, and `/:code` must never be a target — it is the page
 * that sends a logged-in browser to setup, so returning there could loop.
 * Anchored and charset-limited, so `//host`, schemes, `..` segments and query
 * strings all fail.
 */
export const SAFE_NEXT_PATH = /^\/setup\/[A-Za-z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Sign-up page
// ---------------------------------------------------------------------------

export const signupHandler: Handler<{ Bindings: AppEnv; Variables: HonoVars }> = (c) => {
  const html = htmlShell(
    "Crear cuenta",
    `
    <p class="subtitle">Crea tu cuenta y obtén tu dominio de enlaces cortos</p>
    <form id="signup-form">
      <label for="email">Correo</label>
      <input type="email" id="email" name="email" placeholder="tu@ejemplo.com" required>
      <label for="password">Contraseña</label>
      <div class="password-field">
        <input type="password" id="password" name="password" placeholder="Mínimo 8 caracteres" minlength="8" required>
        <button type="button" class="toggle-password" onclick="togglePassword('password', this)" aria-label="Mostrar contraseña">
          <svg id="eye-password" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
      </div>
      <label for="display">Nombre visible</label>
      <input type="text" id="display" name="display" placeholder="Nombre de tu equipo o empresa" required>
      <label for="subdomain">Subdominio</label>
      <input type="text" id="subdomain" name="subdomain" placeholder="p. ej. acme" required minlength="3" maxlength="30" pattern="[a-z0-9][a-z0-9\-]*[a-z0-9]">
      <button type="submit" id="submit-btn">Crear cuenta</button>
    </form>
    <div id="message" class="message"></div>
    <div class="links">
      ¿Ya tienes una cuenta? <a href="/login">Iniciar sesión</a>
    </div>
    `,
    c.env.SUPABASE_URL,
    c.env.SUPABASE_ANON_KEY,
  );

  const script = `
  <script>
    const form = document.getElementById("signup-form");
    const btn = document.getElementById("submit-btn");
    const msg = document.getElementById("message");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      btn.disabled = true;
      btn.textContent = "Creando cuenta…";
      msg.className = "message";
      msg.textContent = "";

      const email = document.getElementById("email").value;
      const password = document.getElementById("password").value;
      const display = document.getElementById("display").value;
      const subdomain = document.getElementById("subdomain").value.toLowerCase();

      try {
        const { data, error } = await sb.auth.signUp({ email, password });
        if (error) throw error;

        if (data.user) {
          // Auto-provision tenant via API
          const token = data.session?.access_token;
          if (token) {
            const res = await fetch("/api/tenants", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + token,
              },
              body: JSON.stringify({ subdomain, display_name: display }),
            });

            if (!res.ok) {
              const err = await res.json();
              throw new Error(err.error || "No se pudo crear tu espacio");
            }
          }

          msg.className = "message success";
          msg.textContent = "¡Revisa tu correo para encontrar el enlace de confirmación!";
          form.style.display = "none";
        }
      } catch (err) {
        msg.className = "message error";
        msg.textContent = err instanceof Error ? err.message : "Algo salió mal";
        btn.disabled = false;
        btn.textContent = "Crear cuenta";
      }
    });
  </script>`;

  return c.html(html.replace("</body>", script + "\n</body>"));
};

// ---------------------------------------------------------------------------
// Login page
// ---------------------------------------------------------------------------

export const loginHandler: Handler<{ Bindings: AppEnv; Variables: HonoVars }> = (c) => {
  const html = htmlShell(
    "Iniciar sesión",
    `
    <p class="subtitle">Qué bueno verte de nuevo</p>
    <form id="login-form">
      <label for="email">Correo</label>
      <input type="email" id="email" name="email" placeholder="tu@ejemplo.com" required>
      <label for="login-password">Contraseña</label>
      <div class="password-field">
        <input type="password" id="login-password" name="password" placeholder="Tu contraseña" required>
        <button type="button" class="toggle-password" onclick="togglePassword('login-password', this)" aria-label="Mostrar contraseña">
          <svg id="eye-login-password" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
      </div>
      <button type="submit" id="submit-btn">Iniciar sesión</button>
    </form>
    <div id="message" class="message"></div>
    <div class="links">
      <a href="/reset-password">¿Olvidaste tu contraseña?</a>
    </div>
    <div class="links" style="margin-top: 0.5rem;">
      ¿No tienes una cuenta? <a href="/signup">Crear cuenta</a>
    </div>
    `,
    c.env.SUPABASE_URL,
    c.env.SUPABASE_ANON_KEY,
  );

  const script = `
  <script>
    const form = document.getElementById("login-form");
    const btn = document.getElementById("submit-btn");
    const msg = document.getElementById("message");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      btn.disabled = true;
      btn.textContent = "Iniciando sesión…";
      msg.className = "message";
      msg.textContent = "";

      const email = document.getElementById("email").value;
      const password = document.getElementById("login-password").value;

      try {
        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;

        msg.className = "message success";
        msg.textContent = "¡Sesión iniciada! Redirigiendo…";
        // Return path, honoured only when it is a card setup page — see
        // SAFE_NEXT_PATH. Anything else falls back to the default.
        const next = new URL(window.location.href).searchParams.get("next");
        const target = next && /${SAFE_NEXT_PATH.source}/.test(next) ? next : "/";
        setTimeout(() => { window.location.href = target; }, 1000);
      } catch (err) {
        msg.className = "message error";
        msg.textContent = err instanceof Error ? err.message : "No se pudo iniciar sesión";
        btn.disabled = false;
        btn.textContent = "Iniciar sesión";
      }
    });
  </script>`;

  return c.html(html.replace("</body>", script + "\n</body>"));
};

// ---------------------------------------------------------------------------
// Password reset page
// ---------------------------------------------------------------------------

export const resetPasswordHandler: Handler<{ Bindings: AppEnv; Variables: HonoVars }> = (c) => {
  const isCallback = new URL(c.req.url).searchParams.get("type") === "recovery";

  const body = isCallback
    ? `
    <p class="subtitle">Elige una nueva contraseña</p>
    <form id="reset-form">
      <label for="reset-password">Nueva contraseña</label>
      <div class="password-field">
        <input type="password" id="reset-password" name="password" placeholder="Mínimo 8 caracteres" minlength="8" required>
        <button type="button" class="toggle-password" onclick="togglePassword('reset-password', this)" aria-label="Mostrar contraseña">
          <svg id="eye-reset-password" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
      </div>
      <button type="submit" id="submit-btn">Actualizar contraseña</button>
    </form>
    <div id="message" class="message"></div>
    `
    : `
    <p class="subtitle">Escribe tu correo y te enviaremos un enlace para restablecer tu contraseña</p>
    <form id="reset-form">
      <label for="email">Correo</label>
      <input type="email" id="email" name="email" placeholder="tu@ejemplo.com" required>
      <button type="submit" id="submit-btn">Enviar enlace</button>
    </form>
    <div id="message" class="message"></div>
    <div class="links">
      ¿Recordaste tu contraseña? <a href="/login">Iniciar sesión</a>
    </div>
    `;

  const html = htmlShell(
    isCallback ? "Nueva contraseña" : "Restablecer contraseña",
    body,
    c.env.SUPABASE_URL,
    c.env.SUPABASE_ANON_KEY,
  );

  const script = isCallback
    ? `
  <script>
    const form = document.getElementById("reset-form");
    const btn = document.getElementById("submit-btn");
    const msg = document.getElementById("message");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      btn.disabled = true;
      btn.textContent = "Actualizando…";
      msg.className = "message";
      msg.textContent = "";

      const password = document.getElementById("reset-password").value;

      try {
        const { error } = await sb.auth.updateUser({ password });
        if (error) throw error;

        msg.className = "message success";
        msg.textContent = "¡Contraseña actualizada! Redirigiendo a iniciar sesión…";
        setTimeout(() => { window.location.href = "/login"; }, 1500);
      } catch (err) {
        msg.className = "message error";
        msg.textContent = err instanceof Error ? err.message : "No se pudo actualizar la contraseña";
        btn.disabled = false;
        btn.textContent = "Actualizar contraseña";
      }
    });
  </script>`
    : `
  <script>
    const form = document.getElementById("reset-form");
    const btn = document.getElementById("submit-btn");
    const msg = document.getElementById("message");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      btn.disabled = true;
      btn.textContent = "Enviando…";
      msg.className = "message";
      msg.textContent = "";

      const email = document.getElementById("email").value;

      try {
        const { error } = await sb.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin + "/reset-password",
        });
        if (error) throw error;

        msg.className = "message success";
        msg.textContent = "Si ese correo está registrado, recibirás un enlace para restablecer tu contraseña en breve.";
        form.style.display = "none";
      } catch (err) {
        msg.className = "message error";
        msg.textContent = err instanceof Error ? err.message : "Algo salió mal";
        btn.disabled = false;
        btn.textContent = "Enviar enlace";
      }
    });
  </script>`;

  return c.html(html.replace("</body>", script + "\n</body>"));
};

// ---------------------------------------------------------------------------
// Auth callback — handles email confirmation links from Supabase
// ---------------------------------------------------------------------------

export const authCallbackHandler: Handler<{ Bindings: AppEnv; Variables: HonoVars }> = (c) => {
  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Correo confirmado — Más Reseñas</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100dvh; background: #f8fafc; color: #1e293b; margin: 0;
    }
    .card {
      background: #fff; border: 1px solid #e2e8f0; border-radius: 0.75rem;
      padding: 2rem; max-width: 400px; text-align: center;
      box-shadow: 0 1px 3px rgba(0,0,0,0.06);
    }
    h1 { font-size: 1.5rem; color: #0f172a; margin-bottom: 0.5rem; }
    p { color: #64748b; font-size: 0.938rem; margin-bottom: 1.5rem; }
    a { color: #2563eb; text-decoration: none; font-weight: 600; }
    .error { color: #991b1b; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Correo confirmado 🎉</h1>
    <p>Tu cuenta está lista. Ya puedes iniciar sesión y empezar a crear enlaces cortos.</p>
    <a href="/login">Ir a iniciar sesión</a>
    <p id="error" class="error" style="display:none;margin-top:1rem;"></p>
  </div>
  ${SUPABASE_JS_SCRIPT}
  <script>
    var sb = window.supabase.createClient(
      "${c.env.SUPABASE_URL}",
      "${c.env.SUPABASE_ANON_KEY}",
    );
    sb.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" && session) {
        console.log("Email confirmed, user signed in");
      }
    });
  </script>
</body>
</html>`;

  return c.html(html);
};

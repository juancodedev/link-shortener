import type { Handler } from "hono";
import type { AppEnv } from "../types/env";

/**
 * Serves the landing page at `GET /`.
 *
 * Fully self-contained HTML with inline responsive CSS:
 * - Service name and tagline
 * - Sign-up and login links to Supabase Auth
 * - How-it-works section (3 steps)
 * - Footer with attribution
 * - Mobile breakpoint at 768px
 * - No external stylesheets, CSS frameworks, or third-party scripts
 * - Loads the Supabase browser client from a CDN, plus one inline script that
 *   reads the session and swaps between the guest and signed-in views
 *
 * Dark/light neutral color scheme using Tailwind-inspired slate palette.
 */
export const landingHandler: Handler<{ Bindings: AppEnv }> = (c) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Link Shortener — Short links with analytics</title>
  <style>
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
        "Helvetica Neue", Arial, sans-serif;
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      background: #ffffff;
      color: #1e293b;
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }

    /* ---- Layout ---- */
    .container {
      max-width: 720px;
      width: 100%;
      margin: 0 auto;
      padding: 2rem 1.5rem;
    }

    header {
      padding: 4rem 0 2rem;
      text-align: center;
    }

    main {
      flex: 1;
    }

    footer {
      text-align: center;
      padding: 2rem 1.5rem 3rem;
      color: #94a3b8;
      font-size: 0.875rem;
    }

    /* ---- Typography ---- */
    h1 {
      font-size: 2.5rem;
      font-weight: 800;
      letter-spacing: -0.025em;
      color: #0f172a;
      margin-bottom: 0.75rem;
    }

    .tagline {
      font-size: 1.125rem;
      color: #64748b;
      max-width: 480px;
      margin: 0 auto 2rem;
    }

    h2 {
      font-size: 1.25rem;
      font-weight: 700;
      color: #0f172a;
      margin-bottom: 1rem;
      text-align: center;
    }

    /* ---- Buttons ---- */
    .actions {
      display: flex;
      gap: 0.75rem;
      justify-content: center;
      flex-wrap: wrap;
      margin-bottom: 3rem;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0.75rem 1.75rem;
      border-radius: 0.5rem;
      font-size: 0.938rem;
      font-weight: 600;
      text-decoration: none;
      transition: background-color 0.15s, box-shadow 0.15s, transform 0.1s;
      cursor: pointer;
    }

    .btn:active {
      transform: scale(0.98);
    }

    .btn-primary {
      background: #2563eb;
      color: #ffffff;
    }

    .btn-primary:hover {
      background: #1d4ed8;
    }

    .btn-outline {
      background: transparent;
      color: #2563eb;
      border: 1.5px solid #d1d5db;
    }

    .btn-outline:hover {
      background: #f1f5f9;
      border-color: #2563eb;
    }

    /* ---- How It Works ---- */
    .steps {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1.5rem;
      margin-bottom: 2rem;
    }

    .step {
      text-align: center;
      padding: 1.5rem 1rem;
      border-radius: 0.75rem;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
    }

    .step-number {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 2.5rem;
      height: 2.5rem;
      border-radius: 9999px;
      background: #2563eb;
      color: #ffffff;
      font-size: 1.125rem;
      font-weight: 700;
      margin-bottom: 0.75rem;
    }

    .step h3 {
      font-size: 1rem;
      font-weight: 700;
      color: #0f172a;
      margin-bottom: 0.375rem;
    }

    .step p {
      font-size: 0.875rem;
      color: #64748b;
      line-height: 1.5;
    }

    /* ---- Divider ---- */
    .divider {
      border: none;
      border-top: 1px solid #e2e8f0;
      margin: 2rem 0;
    }

    /* ---- Responsive (mobile ≤ 768px) ---- */
    @media (max-width: 768px) {
      header {
        padding: 2.5rem 0 1.5rem;
      }

      h1 {
        font-size: 2rem;
      }

      .tagline {
        font-size: 1rem;
      }

      .steps {
        grid-template-columns: 1fr;
        gap: 1rem;
      }

      .step {
        padding: 1.25rem 1rem;
      }

      .btn {
        width: 100%;
        max-width: 320px;
      }

      .actions {
        flex-direction: column;
        align-items: center;
      }
    }

    /* ---- Dark mode (prefers-color-scheme) ---- */
    @media (prefers-color-scheme: dark) {
      body {
        background: #0f172a;
        color: #e2e8f0;
      }

      h1, h2, .step h3 {
        color: #f1f5f9;
      }

      .tagline, .step p {
        color: #94a3b8;
      }

      .step {
        background: #1e293b;
        border-color: #334155;
      }

      .btn-outline {
        color: #93c5fd;
        border-color: #475569;
      }

      .btn-outline:hover {
        background: #1e293b;
        border-color: #93c5fd;
      }

      .divider {
        border-color: #334155;
      }

      footer {
        color: #64748b;
      }
    }
  </style>
</head>
<body>
  <main class="container">
    <header>
      <h1>Link Shortener</h1>
      <p class="tagline">Short links with analytics — simple, fast, multi-tenant.</p>

      <!-- Logged-out state -->
      <div id="guest-view">
        <p class="auth-note">Sign up for free — 30 links, click analytics, your own subdomain.</p>
        <div class="actions">
          <a href="/signup" class="btn btn-primary">Sign Up</a>
          <a href="/login" class="btn btn-outline">Log In</a>
        </div>
      </div>

      <!-- Logged-in state (hidden by default, shown by JS) -->
      <div id="user-view" style="display:none;">
        <p class="auth-note" id="user-greeting"></p>
        <div class="actions">
          <a href="/dashboard" class="btn btn-primary">Dashboard</a>
          <button id="logout-btn" class="btn btn-outline">Log Out</button>
        </div>
      </div>
    </header>

    <h2>How It Works</h2>

    <div class="steps">
      <div class="step">
        <div class="step-number">1</div>
        <h3>Create Account</h3>
        <p>Sign up with your email and pick a unique subdomain for your links.</p>
      </div>
      <div class="step">
        <div class="step-number">2</div>
        <h3>Shorten Links</h3>
        <p>Paste any URL and get a clean short link instantly. Up to 30 active links on the free tier.</p>
      </div>
      <div class="step">
        <div class="step-number">3</div>
        <h3>Track Clicks</h3>
        <p>See where your clicks come from, what devices people use, and which links perform best.</p>
      </div>
    </div>

    <hr class="divider">
  </main>

  <footer>
    Built with Cloudflare Workers + Supabase
  </footer>

  <script src="https://unpkg.com/@supabase/supabase-js@2"></script>
  <script>
    (async () => {
      if (!window.supabase) return;
      var sb = window.supabase.createClient("${c.env.SUPABASE_URL}", "${c.env.SUPABASE_ANON_KEY}");

      const { data: { session } } = await sb.auth.getSession();
      const guestView = document.getElementById("guest-view");
      const userView = document.getElementById("user-view");
      const greeting = document.getElementById("user-greeting");

      if (session?.user) {
        guestView.style.display = "none";
        userView.style.display = "";
        greeting.textContent = "Welcome, " + (session.user.email || "back") + "!";

        document.getElementById("logout-btn").addEventListener("click", async () => {
          await sb.auth.signOut();
          window.location.reload();
        });
      }

      // Listen for auth changes (login from other tab, etc.)
      sb.auth.onAuthStateChange((event, session) => {
        if (event === "SIGNED_IN" && session) {
          window.location.reload();
        } else if (event === "SIGNED_OUT") {
          window.location.reload();
        }
      });
    })();
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
};

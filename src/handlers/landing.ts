import type { Handler } from "hono";
import type { AppEnv } from "../types/env";

/**
 * Serves a minimal landing page at `GET /`.
 *
 * Returns inline HTML with service name, tagline, and links to Supabase Auth
 * sign-up and login. Uses `<meta name="viewport">` for mobile responsiveness.
 *
 * This is the SKELETON — detailed HTML and CSS deferred to Phase 8 (Task 8.1).
 */
export const landingHandler: Handler<{ Bindings: AppEnv }> = (c) => {
  const supabaseUrl = c.env.SUPABASE_URL;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Link Shortener</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: #f8fafc;
      color: #1e293b;
      padding: 1rem;
    }
    main {
      max-width: 480px;
      width: 100%;
      text-align: center;
    }
    h1 { font-size: 2rem; font-weight: 700; margin-bottom: 0.5rem; }
    p { color: #64748b; margin-bottom: 2rem; line-height: 1.6; }
    .actions { display: flex; gap: 0.75rem; justify-content: center; flex-wrap: wrap; }
    .btn {
      display: inline-block;
      padding: 0.75rem 1.5rem;
      border-radius: 0.5rem;
      font-weight: 600;
      text-decoration: none;
      transition: opacity 0.15s;
    }
    .btn:hover { opacity: 0.85; }
    .btn-primary { background: #2563eb; color: #fff; }
    .btn-outline { background: #fff; color: #2563eb; border: 1.5px solid #2563eb; }
  </style>
</head>
<body>
  <main>
    <h1>Link Shortener</h1>
    <p>Short links with analytics — simple, fast, multi-tenant.</p>
    <div class="actions">
      <a href="${supabaseUrl}/signup" class="btn btn-primary">Sign Up</a>
      <a href="${supabaseUrl}/login" class="btn btn-outline">Log In</a>
    </div>
  </main>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
};

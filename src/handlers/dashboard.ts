import type { Handler } from "hono";
import type { AppEnv, HonoVars } from "../types/env";

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
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: #f8fafc;
      color: #1e293b;
      line-height: 1.6;
      min-height: 100dvh;
    }
    .container {
      max-width: 720px;
      margin: 0 auto;
      padding: 1.5rem;
    }
    nav {
      background: #fff;
      border-bottom: 1px solid #e2e8f0;
      padding: 0.75rem 1.5rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    nav h2 { font-size: 1.125rem; color: #0f172a; }
    nav a, nav button {
      font-size: 0.813rem;
      color: #64748b;
      text-decoration: none;
      background: none;
      border: none;
      cursor: pointer;
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
    }
    nav a:hover, nav button:hover { color: #2563eb; background: #f1f5f9; }
    .card {
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 0.75rem;
      padding: 1.5rem;
      margin-top: 1.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    }
    h3 {
      font-size: 1rem;
      font-weight: 700;
      color: #0f172a;
      margin-bottom: 1rem;
    }
    label {
      display: block;
      font-size: 0.813rem;
      font-weight: 600;
      color: #475569;
      margin-bottom: 0.25rem;
    }
    input, select {
      width: 100%;
      padding: 0.5rem 0.75rem;
      border: 1.5px solid #d1d5db;
      border-radius: 0.5rem;
      font-size: 0.875rem;
      margin-bottom: 1rem;
    }
    input:focus, select:focus {
      outline: none;
      border-color: #2563eb;
      box-shadow: 0 0 0 3px rgba(37,99,235,0.1);
    }
    button {
      padding: 0.625rem 1.25rem;
      background: #2563eb;
      color: #fff;
      border: none;
      border-radius: 0.5rem;
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { background: #1d4ed8; }
    button:disabled { background: #94a3b8; cursor: not-allowed; }
    .btn-sm {
      padding: 0.25rem 0.75rem;
      font-size: 0.75rem;
      border-radius: 0.375rem;
    }
    .btn-danger { background: #dc2626; }
    .btn-danger:hover { background: #b91c1c; }
    .btn-outline {
      background: transparent;
      color: #2563eb;
      border: 1px solid #d1d5db;
    }
    .btn-outline:hover { background: #f1f5f9; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.813rem;
    }
    th {
      text-align: left;
      color: #64748b;
      font-weight: 600;
      padding: 0.5rem 0.75rem;
      border-bottom: 1px solid #e2e8f0;
    }
    td {
      padding: 0.5rem 0.75rem;
      border-bottom: 1px solid #f1f5f9;
      vertical-align: middle;
    }
    tr:hover td { background: #f8fafc; }
    .code {
      font-family: "SF Mono", "Fira Code", monospace;
      color: #2563eb;
      font-weight: 600;
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
    .badge-active { background: #dcfce7; color: #166534; }
    .badge-inactive { background: #fef2f2; color: #991b1b; }
    .badge-expired { background: #fef9c3; color: #854d0e; }
    .message {
      font-size: 0.813rem;
      padding: 0.5rem 0.75rem;
      border-radius: 0.375rem;
      margin: 1rem 0;
      display: none;
    }
    .message.success { display: block; background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; }
    .message.error { display: block; background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
    .row-actions { display: flex; gap: 0.375rem; }
    .empty { text-align: center; color: #94a3b8; padding: 2rem; }
    .loading { text-align: center; color: #94a3b8; padding: 1rem; }
  </style>
</head>
<body>
  <nav>
    <h2>⚡ Link Shortener</h2>
    <div>
      <span id="nav-email" style="font-size:0.813rem;color:#64748b;margin-right:0.75rem;"></span>
      <a href="/">Home</a>
      <button id="logout-nav">Log Out</button>
    </div>
  </nav>
  <div class="container">
    ${body}
  </div>
  <script src="https://unpkg.com/@supabase/supabase-js@2"></script>
  <script>
    if (!window.supabase) throw new Error("Supabase failed to load");
    var sb = window.supabase.createClient("${supabaseUrl}", "${supabaseAnonKey}");
    var token = null;

    async function init() {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { window.location.href = "/login"; return; }
      token = session.access_token;
      document.getElementById("nav-email").textContent = session.user.email;

      document.getElementById("logout-nav").addEventListener("click", async () => {
        await sb.auth.signOut();
        window.location.href = "/";
      });

      loadLinks();
    }

    async function api(method, path, body) {
      const headers = { "Content-Type": "application/json", "Authorization": "Bearer " + token };
      const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
      if (res.status === 401) { window.location.href = "/login"; return; }
      return res;
    }
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Dashboard handler
// ---------------------------------------------------------------------------

export const dashboardHandler: Handler<{ Bindings: AppEnv; Variables: HonoVars }> = (c) => {
  const body = `
    <div class="card">
      <h3>Create Short Link</h3>
      <form id="create-form">
        <label for="url">Destination URL</label>
        <input type="url" id="url" placeholder="https://example.com/your-long-url" required>
        <label for="title">Title (optional)</label>
        <input type="text" id="title" placeholder="My awesome link" maxlength="200">
        <button type="submit">Shorten</button>
      </form>
      <div id="create-msg" class="message"></div>
      <div id="result" style="display:none;margin-top:1rem;">
        <p style="font-size:0.813rem;color:#64748b;">Your short link:</p>
        <input type="text" id="short-url" readonly style="background:#f8fafc;cursor:pointer;" onclick="this.select();navigator.clipboard.writeText(this.value)">
      </div>
    </div>

    <div class="card">
      <h3>Your Links (<span id="link-count">0</span>/30)</h3>
      <div id="links-loading" class="loading">Loading...</div>
      <table id="links-table" style="display:none;">
        <thead>
          <tr>
            <th>Short Code</th>
            <th>URL</th>
            <th>Clicks</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="links-body"></tbody>
      </table>
      <div id="links-empty" class="empty" style="display:none;">
        No links yet. Create your first one above!
      </div>
    </div>

    <script>
      document.addEventListener("DOMContentLoaded", init);

      document.getElementById("create-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = e.target.querySelector("button");
        const msg = document.getElementById("create-msg");
        const result = document.getElementById("result");
        btn.disabled = true;
        btn.textContent = "Creating...";
        msg.className = "message";
        result.style.display = "none";

        try {
          const res = await api("POST", "/api/links", {
            original_url: document.getElementById("url").value,
            title: document.getElementById("title").value || undefined,
          });

          if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || "Failed to create link");
          }

          const data = await res.json();
          document.getElementById("short-url").value = data.short_url;
          result.style.display = "";
          document.getElementById("url").value = "";
          document.getElementById("title").value = "";
          msg.className = "message success";
          msg.textContent = "Link created! Copied to clipboard.";
          navigator.clipboard.writeText(data.short_url);
          loadLinks();
        } catch (err) {
          msg.className = "message error";
          msg.textContent = err instanceof Error ? err.message : "Error";
        } finally {
          btn.disabled = false;
          btn.textContent = "Shorten";
        }
      });

      async function loadLinks() {
        const loading = document.getElementById("links-loading");
        const table = document.getElementById("links-table");
        const empty = document.getElementById("links-empty");
        const tbody = document.getElementById("links-body");
        const count = document.getElementById("link-count");

        loading.style.display = "";
        table.style.display = "none";
        empty.style.display = "none";

        try {
          const res = await api("GET", "/api/links");
          if (!res || !res.ok) throw new Error("Failed to load links");
          const links = await res.json();

          count.textContent = links.length;

          if (links.length === 0) {
            empty.style.display = "";
            return;
          }

          tbody.innerHTML = links.map((l) => {
            const status = !l.is_active ? "inactive"
              : (l.expires_at && new Date(l.expires_at) < new Date()) ? "expired"
              : "active";
            return \\\`<tr>
              <td><span class="code">\${l.short_code}</span></td>
              <td><span class="url-trunc" title="\${l.original_url}">\${l.original_url}</span></td>
              <td>\${l.clicks_count}</td>
              <td><span class="badge badge-\${status}">\${status}</span></td>
              <td>
                <div class="row-actions">
                  <button class="btn-sm btn-outline" onclick="toggleLink('\${l.id}', \${!l.is_active})">\${l.is_active ? "Disable" : "Enable"}</button>
                  <button class="btn-sm btn-danger" onclick="deleteLink('\${l.id}')">Delete</button>
                </div>
              </td>
            </tr>\\\`;
          }).join("");

          table.style.display = "";
        } catch (err) {
          empty.textContent = "Could not load links. " + (err instanceof Error ? err.message : "");
          empty.style.display = "";
        } finally {
          loading.style.display = "none";
        }
      }

      async function toggleLink(id, active) {
        try {
          const res = await api("PATCH", "/api/links/" + id, { is_active: active });
          if (!res.ok) throw new Error("Failed");
          loadLinks();
        } catch (err) {
          alert("Error: " + (err instanceof Error ? err.message : ""));
        }
      }

      async function deleteLink(id) {
        if (!confirm("Delete this link permanently?")) return;
        try {
          const res = await api("DELETE", "/api/links/" + id);
          if (!res.ok) throw new Error("Failed");
          loadLinks();
        } catch (err) {
          alert("Error: " + (err instanceof Error ? err.message : ""));
        }
      }
    </script>
  `;

  return c.html(shell("Dashboard", body, c.env.SUPABASE_URL, c.env.SUPABASE_ANON_KEY));
};

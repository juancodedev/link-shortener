import { createClient } from "@supabase/supabase-js";
import { openApi } from "../api";
import { navigate } from "./navigate";

/** What the Worker hands the bundle: deployment config, never a secret beyond the public anon key. */
export type DashboardConfig = { supabaseUrl: string; supabaseAnonKey: string };

/**
 * Reads the `<script type="application/json" id="dashboard-config">` block the
 * Worker serves (src/handlers/dashboard.ts). The Worker stays the source of
 * these values, as it was when it interpolated them into the inline bootstrap.
 */
export function readConfig(doc: Document): DashboardConfig | null {
  const raw = doc.getElementById("dashboard-config")?.textContent;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DashboardConfig>;
    if (typeof parsed.supabaseUrl !== "string" || typeof parsed.supabaseAnonKey !== "string") return null;
    if (!parsed.supabaseUrl || !parsed.supabaseAnonKey) return null;
    return { supabaseUrl: parsed.supabaseUrl, supabaseAnonKey: parsed.supabaseAnonKey };
  } catch {
    return null;
  }
}

/**
 * The auth bootstrap, ported from the served shell's inline script
 * (odd/tasks/dashboard-react.md T6a). In order: the session check, the
 * /login redirect, the nav email, logout, then the API gate. It starts no
 * load of its own: every island loads itself once the gate opens.
 *
 * The API helper gets a getter for the session's current token, which
 * supabase-js keeps refreshed (L19). Neither the client nor
 * the token is put on window.
 */
export async function bootAuth(doc: Document): Promise<void> {
  const config = readConfig(doc);
  // The served shell did nothing when the Supabase script failed to load;
  // without its config the bundle cannot build a client either.
  if (!config) return;
  const sb = createClient(config.supabaseUrl, config.supabaseAnonKey);

  const {
    data: { session },
  } = await sb.auth.getSession();
  // Leaves the gate parked: the browser is already navigating to /login, and
  // a load started here could only fail.
  if (!session) {
    navigate("/login");
    return;
  }

  const email = doc.getElementById("nav-email");
  if (email) email.textContent = session.user.email ?? "";
  doc.getElementById("logout-nav")?.addEventListener("click", async () => {
    await sb.auth.signOut();
    navigate("/");
  });

  // Last, once the helper it guards can authenticate. Each request asks the
  // client for the current session, which supabase-js keeps refreshed; the
  // boot token is only the fallback if that read fails (L19).
  openApi(async () => {
    try {
      const { data } = await sb.auth.getSession();
      return data.session?.access_token ?? session.access_token;
    } catch {
      return session.access_token;
    }
  });
}

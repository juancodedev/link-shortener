import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The whole bundle as the page runs it, with the real API helper.
vi.unmock("../../src/api");
vi.mock("../../src/shell/navigate", () => ({ navigate: vi.fn(), reload: vi.fn() }));

// The boot read parks until the test resolves it; every later read (the API
// helper asks for the current token on each request) gets that same session.
let finishSession: (session: unknown) => void = () => {};
let resolved: Promise<unknown> | null = null;
const auth = {
  getSession: vi.fn(() => {
    if (!resolved) resolved = new Promise((r) => (finishSession = (session) => r({ data: { session } })));
    return resolved;
  }),
  signOut: vi.fn(),
};
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => ({ auth })) }));

import { createClient } from "@supabase/supabase-js";

/**
 * Boot order of web/src/dashboard.tsx, the bundle entry: the islands mount
 * and park on the API gate, and no request leaves the page until the session
 * resolves. The sidebar routing is the routing entry's
 * (web/test/shell/routing-entry.test.ts), so the bundle leaves [hidden] alone.
 */
describe("the dashboard bundle entry", () => {
  it("mounts the islands, leaves the routing to its own entry, and sends nothing before the session", async () => {
    document.body.innerHTML = `
      <nav class="topbar"><span id="nav-email"></span><button id="logout-nav">Log Out</button></nav>
      <aside class="sidebar"><a href="#links" data-section-link="links">Links</a><a href="#settings" data-section-link="settings">Settings</a></aside>
      <section class="dash-section" data-section="links"></section>
      <section class="dash-section" data-section="settings" hidden><div id="settings-root" data-island="settings"></div></section>
      <script type="application/json" id="dashboard-config">{"supabaseUrl":"https://test.supabase.co","supabaseAnonKey":"k"}</script>`;
    window.history.replaceState(null, "", "/dashboard#settings");
    const sent: Array<{ path: string; auth: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init: RequestInit) => {
        sent.push({ path, auth: (init.headers as Record<string, string>).Authorization! });
        return new Response(JSON.stringify({ feedback_email: null, locations: [], businesses: [] }), { status: 200 });
      }),
    );

    await act(async () => {
      await import("../../src/dashboard");
    });

    expect(createClient).toHaveBeenCalledWith("https://test.supabase.co", "k");
    const settings = document.querySelector<HTMLElement>('[data-section="settings"]')!;
    expect(settings.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('[data-section="links"]')!.hidden).toBe(false);
    expect(document.getElementById("settings-root")!.childElementCount).toBeGreaterThan(0);
    expect(sent).toEqual([]);

    await act(async () => {
      finishSession({ access_token: "tok-1", user: { email: "owner@example.com" } });
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    });

    expect(document.getElementById("nav-email")!.textContent).toBe("owner@example.com");
    // The islands' and the branches store's first loads, all authenticated.
    expect(sent.map((s) => s.path).sort()).toEqual(["/api/businesses", "/api/locations", "/api/tenant/feedback-email"]);
    expect(new Set(sent.map((s) => s.auth))).toEqual(new Set(["Bearer tok-1"]));
    vi.unstubAllGlobals();
  });
});

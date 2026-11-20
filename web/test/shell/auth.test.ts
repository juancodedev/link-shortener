import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("../../src/api");
vi.mock("../../src/shell/navigate", () => ({ navigate: vi.fn(), reload: vi.fn() }));

const auth = {
  getSession: vi.fn(),
  signOut: vi.fn(),
};
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => ({ auth })) }));

import { createClient } from "@supabase/supabase-js";
import { api, whenApiReady } from "../../src/api";
import { bootAuth, readConfig } from "../../src/shell/auth";
import { navigate } from "../../src/shell/navigate";

/**
 * The auth bootstrap (formerly the async IIFE in the served shell,
 * src/handlers/dashboard.ts): one Supabase client from the config the Worker
 * serves, the session check, the /login redirect, the nav email, logout, and
 * the readiness gate every island awaits.
 */

const CONFIG = { supabaseUrl: "https://test.supabase.co", supabaseAnonKey: "test-anon-key" };

function servePage(config: unknown = CONFIG) {
  // `null` serves the page without a config block.
  document.body.innerHTML = `
    <nav class="topbar">
      <span id="nav-email" class="nav-email"></span>
      <button id="logout-nav"><span>Log Out</span></button>
    </nav>
    <div class="container"></div>`;
  if (config !== null) {
    const block = document.createElement("script");
    block.type = "application/json";
    block.id = "dashboard-config";
    block.textContent = typeof config === "string" ? config : JSON.stringify(config);
    document.body.appendChild(block);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("readConfig", () => {
  it("reads the Supabase URL and anon key from the served JSON block", () => {
    servePage();
    expect(readConfig(document)).toEqual(CONFIG);
  });

  it("returns null for a missing, malformed or incomplete block", () => {
    servePage(null);
    expect(readConfig(document)).toBeNull();
    servePage("{not json");
    expect(readConfig(document)).toBeNull();
    servePage({ supabaseUrl: "https://test.supabase.co" });
    expect(readConfig(document)).toBeNull();
  });
});

describe("the auth bootstrap", () => {
  beforeEach(() => {
    vi.mocked(navigate).mockClear();
    vi.mocked(createClient).mockClear();
    auth.getSession.mockReset();
    auth.signOut.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // First, because the gate is module state that a signed-in boot opens.
  it("sends a visitor without a session to /login and leaves the gate parked", async () => {
    servePage();
    auth.getSession.mockResolvedValue({ data: { session: null } });
    let opened = false;
    void whenApiReady().then(() => {
      opened = true;
    });

    await bootAuth(document);
    await tick();

    expect(navigate).toHaveBeenCalledWith("/login");
    expect(opened).toBe(false);
    expect(document.getElementById("nav-email")!.textContent).toBe("");
    // The page is navigating away: nothing is wired to log out from.
    document.getElementById("logout-nav")!.click();
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it("does nothing without a config block: no client, no redirect", async () => {
    servePage(null);

    await bootAuth(document);

    expect(createClient).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("creates one client from the served config", async () => {
    servePage();
    auth.getSession.mockResolvedValue({ data: { session: null } });

    await bootAuth(document);

    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledWith(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey);
  });

  it("shows the signed-in email and opens the gate with the session's token", async () => {
    servePage();
    auth.getSession.mockResolvedValue({ data: { session: { access_token: "tok-1", user: { email: "owner@example.com" } } } });
    const sent: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_path: string, init: RequestInit) => {
        sent.push(init);
        return new Response("[]", { status: 200 });
      }),
    );
    // A waiter parked before the session resolved finds a usable helper when
    // it wakes: the order the gate exists to guarantee.
    const woke = whenApiReady().then(() => api("GET", "/api/links"));

    await bootAuth(document);
    await woke;

    expect(navigate).not.toHaveBeenCalled();
    expect(document.getElementById("nav-email")!.textContent).toBe("owner@example.com");
    expect((sent[0]!.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
  });

  it("authenticates later requests with the session Supabase refreshed, not the boot token (L19)", async () => {
    servePage();
    auth.getSession.mockResolvedValueOnce({ data: { session: { access_token: "tok-boot", user: { email: "o@example.com" } } } });
    const sent: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_path: string, init: RequestInit) => {
        sent.push(init);
        return new Response("[]", { status: 200 });
      }),
    );

    await bootAuth(document);
    auth.getSession.mockResolvedValue({ data: { session: { access_token: "tok-refreshed", user: { email: "o@example.com" } } } });
    await api("GET", "/api/links");

    expect((sent.at(-1)!.headers as Record<string, string>).Authorization).toBe("Bearer tok-refreshed");
  });

  it("starts no request of its own: every load belongs to an island", async () => {
    servePage();
    auth.getSession.mockResolvedValue({ data: { session: { access_token: "tok-1", user: { email: "o@example.com" } } } });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await bootAuth(document);
    await tick();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("logs out, then sends the owner home", async () => {
    servePage();
    auth.getSession.mockResolvedValue({ data: { session: { access_token: "tok-1", user: { email: "o@example.com" } } } });
    let finish = () => {};
    auth.signOut.mockReturnValue(new Promise<{ error: null }>((r) => (finish = () => r({ error: null }))));

    await bootAuth(document);
    document.getElementById("logout-nav")!.click();
    await tick();

    expect(auth.signOut).toHaveBeenCalledTimes(1);
    // Not before signOut settles: leaving first would keep the session.
    expect(navigate).not.toHaveBeenCalled();
    finish();
    await tick();
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("puts neither the client nor the token on window", async () => {
    servePage();
    auth.getSession.mockResolvedValue({ data: { session: { access_token: "tok-secret", user: { email: "o@example.com" } } } });

    await bootAuth(document);

    const win = window as unknown as Record<string, unknown>;
    for (const name of ["__sb", "__token", "__api", "__apiReady", "__apiReadyResolve", "supabase"]) {
      expect(win[name], name).toBeUndefined();
    }
  });
});

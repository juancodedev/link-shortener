import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real helper, not the stub every island test uses (./setup.ts).
vi.unmock("../src/api");
vi.mock("../src/shell/navigate", () => ({ navigate: vi.fn(), reload: vi.fn() }));

import { api, openApi, whenApiReady } from "../src/api";
import { navigate } from "../src/shell/navigate";

/**
 * The authenticated API helper (formerly window.__api in the served shell,
 * src/handlers/dashboard.ts). Its contract is what every island relies on:
 * Bearer token, X-Tenant-Slug, JSON bodies, no-store, 401 → /login, 409
 * tenant_required → the tenant picker, and a throw on any other non-ok answer.
 */

type Sent = { path: string; init: RequestInit };

function stubFetch(answer: () => Response): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit) => {
      sent.push({ path, init });
      return answer();
    }),
  );
  return sent;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const headers = (s: Sent) => s.init.headers as Record<string, string>;

describe("the api helper", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/dashboard");
    vi.mocked(navigate).mockClear();
    // jsdom has no scrolling; the tenant picker scrolls to it.
    window.scrollTo = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.getElementById("tenant-picker")?.remove();
  });

  // Runs first: the gate is module state, and openApi in the tests below opens it.
  it("keeps the gate parked until the session's token is handed over", async () => {
    let opened = false;
    void whenApiReady().then(() => {
      opened = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(opened).toBe(false);

    openApi("tok-1");
    await new Promise((r) => setTimeout(r, 0));
    expect(opened).toBe(true);
  });

  it("carries the bearer token, JSON content type and no-store on every request", async () => {
    openApi("tok-1");
    const sent = stubFetch(() => json({ ok: true }));

    const res = await api("POST", "/api/links", { original_url: "https://example.com" });

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.path).toBe("/api/links");
    expect(sent[0]!.init.method).toBe("POST");
    expect(sent[0]!.init.cache).toBe("no-store");
    expect(sent[0]!.init.body).toBe(JSON.stringify({ original_url: "https://example.com" }));
    expect(headers(sent[0]!)).toEqual({ "Content-Type": "application/json", Authorization: "Bearer tok-1" });
  });

  it("sends no body when there is none", async () => {
    openApi("tok-1");
    const sent = stubFetch(() => json([]));

    await api("GET", "/api/links");

    expect(sent[0]!.init.body).toBeUndefined();
  });

  it("names the remembered location in X-Tenant-Slug", async () => {
    openApi("tok-1");
    window.localStorage.setItem("tenant", "store-b");
    const sent = stubFetch(() => json({}));

    await api("GET", "/api/links");

    expect(headers(sent[0]!)["X-Tenant-Slug"]).toBe("store-b");
  });

  it("prefers a tenant named in the URL over the remembered one", async () => {
    openApi("tok-1");
    window.localStorage.setItem("tenant", "store-b");
    window.history.replaceState(null, "", "/dashboard?tenant=store-a#cards");
    const sent = stubFetch(() => json({}));

    await api("GET", "/api/links");

    expect(headers(sent[0]!)["X-Tenant-Slug"]).toBe("store-a");
  });

  it("sends no tenant header for the single-location user who never picked one", async () => {
    openApi("tok-1");
    const sent = stubFetch(() => json({}));

    await api("GET", "/api/links");

    expect(headers(sent[0]!)).not.toHaveProperty("X-Tenant-Slug");
  });

  it("still sends the request when storage is blocked", async () => {
    openApi("tok-1");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const sent = stubFetch(() => json({}));

    await api("GET", "/api/links");

    expect(headers(sent[0]!)).not.toHaveProperty("X-Tenant-Slug");
    vi.restoreAllMocks();
  });

  it("sends an expired session to /login and throws Unauthorized", async () => {
    openApi("tok-1");
    stubFetch(() => json({ error: "jwt expired" }, 401));

    await expect(api("GET", "/api/links")).rejects.toThrow(/^Unauthorized$/);
    expect(navigate).toHaveBeenCalledWith("/login");
  });

  it("shows the tenant picker on 409 tenant_required and throws tenant_required", async () => {
    openApi("tok-1");
    stubFetch(() =>
      json({ error: "tenant_required", available: [{ slug: "a", displayName: "Store A", role: "admin" }] }, 409),
    );

    await expect(api("GET", "/api/links")).rejects.toThrow(/^tenant_required$/);
    const select = document.getElementById("tenant-select") as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(select.options[0]!.textContent).toBe("Store A (admin)");
    expect(navigate).not.toHaveBeenCalled();
  });

  // A duplicate slug or business name is a 409 too: the owner needs the
  // server's reason, not "Server error" (L19).
  it("throws the server's message on any other 409, without the tenant picker", async () => {
    openApi("tok-1");
    stubFetch(() => json({ error: "slug_taken" }, 409));

    await expect(api("POST", "/api/links", {})).rejects.toThrow(/^slug_taken$/);
    expect(document.getElementById("tenant-picker")).toBeNull();
  });

  it("asks for the current token on every request, so a refreshed session is used (L19)", async () => {
    let current = "tok-old";
    openApi(async () => current);
    const sent = stubFetch(() => json({ ok: true }));

    await api("GET", "/api/links");
    current = "tok-new";
    await api("GET", "/api/links");

    expect(headers(sent[0]!).Authorization).toBe("Bearer tok-old");
    expect(headers(sent[1]!).Authorization).toBe("Bearer tok-new");
  });

  it("throws the server's error message on any other non-ok answer", async () => {
    openApi("tok-1");
    stubFetch(() => json({ error: "Destination is not a valid URL" }, 400));

    await expect(api("POST", "/api/links", {})).rejects.toThrow(/^Destination is not a valid URL$/);
  });

  it("throws Server error when the error answer is not JSON or names nothing", async () => {
    openApi("tok-1");
    stubFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(api("GET", "/api/links")).rejects.toThrow(/^Server error$/);

    stubFetch(() => json({}, 500));
    await expect(api("GET", "/api/links")).rejects.toThrow(/^Server error$/);
  });

  it("puts nothing on window: no helper, gate or token global", async () => {
    openApi("tok-secret");
    const win = window as unknown as Record<string, unknown>;

    for (const name of ["__api", "__apiReady", "__apiReadyResolve", "__token", "__sb", "__showTenantPicker"]) {
      expect(win[name], name).toBeUndefined();
    }
    expect(Object.values(win).some((v) => v === "tok-secret")).toBe(false);
  });
});

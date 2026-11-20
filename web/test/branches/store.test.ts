import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBranches, loadBranches, pickableBranches, resetBranches, subscribeBranches } from "../../src/branches/store";
import { gate, installApi, settle } from "../links/harness";

// The in-bundle branches store (dashboard-react T5). Ported from the Worker
// tests of the legacy loadBranches ("the branches load feeds the Links
// island's pickers", "loads businesses with the branches") and of its
// window.__branches / brancheschange bridge, which the store replaces.

const LOCATIONS = [{ id: "loc-1", name: "Providencia", business_id: "biz-1", link_count: 3 }];
const BUSINESSES = [{ id: "biz-1", name: "Café Central", is_active: true }];

function branchesApi(over: { locations?: () => unknown; businesses?: () => unknown } = {}) {
  return installApi((method, path) => {
    if (method === "GET" && path === "/api/locations") return over.locations ? over.locations() : { locations: LOCATIONS };
    if (method === "GET" && path === "/api/businesses") return over.businesses ? over.businesses() : { businesses: BUSINESSES };
    throw new Error(`unexpected ${method} ${path}`);
  });
}

let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetBranches();
  window.__apiReady = Promise.resolve();
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errors.mockRestore();
});

describe("loadBranches", () => {
  it("sends nothing until the auth gate opens, then loads branches and businesses together", async () => {
    const auth = gate();
    window.__apiReady = auth.wait;
    const calls = branchesApi();

    const done = loadBranches();
    await settle();
    expect(calls).toEqual([]);
    expect(getBranches().status).toBe("loading");

    auth.release();
    await done;

    expect(calls).toEqual([
      { method: "GET", path: "/api/locations" },
      { method: "GET", path: "/api/businesses" },
    ]);
    expect(getBranches()).toEqual({ status: "ready", branches: LOCATIONS, businesses: BUSINESSES, version: 1 });
  });

  it("reads a missing list as empty", async () => {
    branchesApi({ locations: () => ({}), businesses: () => ({}) });
    await loadBranches();

    expect(getBranches()).toMatchObject({ status: "ready", branches: [], businesses: [] });
  });

  it("tells every subscriber about each load", async () => {
    branchesApi();
    const seen: string[] = [];
    const stop = subscribeBranches(() => seen.push(getBranches().status));

    await loadBranches();
    await loadBranches();
    stop();
    await loadBranches();

    expect(seen).toEqual(["ready", "ready"]);
    expect(getBranches().version).toBe(3);
  });

  it.each([
    ["the branches request throws", { locations: () => { throw new Error("Server error"); } }],
    ["the businesses answer is not ok", { businesses: () => new Response("{}", { status: 500 }) }],
  ])("keeps the last lists and says error when %s", async (_case, over) => {
    branchesApi();
    await loadBranches();

    branchesApi(over);
    await loadBranches();

    // The pickers and the filter keep working on what they had; the
    // Businesses card is the one that says the load failed.
    expect(getBranches()).toEqual({ status: "error", branches: LOCATIONS, businesses: BUSINESSES, version: 1 });
    expect(errors).toHaveBeenCalled();
  });

  it("applies only the newest of two overlapping loads", async () => {
    const slow = gate();
    let call = 0;
    branchesApi({
      locations: () => {
        call++;
        if (call === 1) return slow.wait.then(() => ({ locations: [{ id: "stale", name: "Stale" }] }));
        return { locations: [{ id: "fresh", name: "Fresh" }] };
      },
    });

    const first = loadBranches();
    await loadBranches();
    slow.release();
    await first;

    expect(getBranches().branches.map((b) => b.id)).toEqual(["fresh"]);
  });
});

describe("pickableBranches", () => {
  const businesses = [
    { id: "biz-1", name: "Café Central", is_active: true },
    { id: "biz-3", name: "Cerrado", is_active: false },
  ];
  const branches = [
    { id: "loc-1", name: "Providencia", business_id: "biz-1", is_active: true },
    { id: "loc-old", name: "Vieja", business_id: "biz-1", is_active: false },
    { id: "loc-3", name: "Centro", business_id: "biz-3", is_active: true },
    { id: "loc-4", name: "Suelta", business_id: null, is_active: true },
  ];

  it("keeps switched-on branches outside switched-off businesses", () => {
    expect(pickableBranches(branches, businesses).map((b) => b.id)).toEqual(["loc-1", "loc-4"]);
  });

  it("treats a missing is_active as on", () => {
    expect(pickableBranches([{ id: "x", name: "X", business_id: "biz-1" }], [{ id: "biz-1", name: "B" }])).toHaveLength(1);
  });
});

describe("the dashboard bundle", () => {
  it("loads the branches once at boot, after the auth gate", async () => {
    const calls = branchesApi();
    document.body.innerHTML = "";

    await act(async () => {
      await import("../../src/dashboard");
    });
    await settle();

    expect(calls.filter((c) => c.path === "/api/locations")).toHaveLength(1);
    expect(calls.filter((c) => c.path === "/api/businesses")).toHaveLength(1);
    expect(getBranches().status).toBe("ready");
  });
});

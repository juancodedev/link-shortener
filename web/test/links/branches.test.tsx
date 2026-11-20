import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { branchOptions } from "../../src/links/branches";
import { field, installLegacy, link, mountLinks, provideBranches, standardApi } from "./harness";

// The row's branch picker (odd/tasks/business-branches.md S4); the
// pickableBranches rule it shares with the Comments filter is pinned in
// web/test/branches/store.test.ts. Ported from the Worker tests that compiled
// fillBranchSelects + pickableBranches out of the served HTML; the lists come
// from the in-bundle branches store (web/src/branches, T5).

const businesses = [
  { id: "biz-1", name: "Café Central", is_active: true },
  { id: "biz-2", name: "Sabores", is_active: true },
  { id: "biz-3", name: "Cerrado", is_active: false },
];
const branches = [
  { id: "loc-1", name: "Providencia", business_id: "biz-1", business_name: "Café Central", is_active: true },
  { id: "loc-old", name: "Vieja", business_id: "biz-1", business_name: "Café Central", is_active: false },
  { id: "loc-3", name: "Centro", business_id: "biz-3", business_name: "Cerrado", is_active: true },
  { id: "loc-4", name: "Suelta", business_id: null, business_name: null, is_active: true },
];

const options = (id = "branch-link-uuid") =>
  [...field(id).options].map((o) => ({ label: o.text, value: o.value, selected: o.selected }));

describe("branchOptions", () => {
  it("offers Unassigned, then each pickable branch named after its business", () => {
    expect(branchOptions("", branches, businesses)).toEqual([
      { label: "Unassigned", value: "" },
      { label: "Café Central — Providencia", value: "loc-1" },
      { label: "Suelta", value: "loc-4" },
    ]);
  });

  it("keeps the link's own switched-off branch, named and marked, so one Save does not detach it", () => {
    expect(branchOptions("loc-old", branches, businesses).at(-1)).toEqual({
      label: "Café Central — Vieja (inactive)",
      value: "loc-old",
    });
  });

  it("keeps an unknown current branch as Current branch while the list is missing", () => {
    expect(branchOptions("loc-1", [], [])).toEqual([
      { label: "Unassigned", value: "" },
      { label: "Current branch", value: "loc-1" },
    ]);
  });
});

describe("the row's branch picker", () => {
  beforeEach(() => {
    installLegacy();
  });
  afterEach(cleanup);

  it("never shows an assigned link as Unassigned when the branches list is missing", async () => {
    standardApi({ links: [link({ location_id: "loc-1" })] });
    await mountLinks();

    expect(options().find((o) => o.selected)).toEqual({ label: "Current branch", value: "loc-1", selected: true });
  });

  it("keeps inactive branches and businesses out, except the link's current one", async () => {
    await provideBranches(branches, businesses);
    standardApi({ links: [link({ location_id: "loc-old" })] });
    await mountLinks();

    expect(options().map((o) => o.value)).toEqual(["", "loc-1", "loc-4", "loc-old"]);
    expect(options().find((o) => o.selected)).toEqual({ label: "Café Central — Vieja (inactive)", value: "loc-old", selected: true });
  });

  it("rebuilds every picker when the branches store reloads", async () => {
    standardApi({ links: [link({ location_id: "loc-1" })] });
    await mountLinks();
    expect(options().map((o) => o.label)).toEqual(["Unassigned", "Current branch"]);

    const api = window.__api;
    await provideBranches(branches, businesses);
    window.__api = api;

    expect(options().map((o) => o.label)).toEqual(["Unassigned", "Café Central — Providencia", "Suelta"]);
    expect(field("branch-link-uuid").value).toBe("loc-1");
  });

  it("reads branches the store loaded before the island mounted", async () => {
    await provideBranches(branches, businesses);
    standardApi({ links: [link({ location_id: null })] });
    await mountLinks();

    expect(options().map((o) => o.value)).toEqual(["", "loc-1", "loc-4"]);
    expect(field("branch-link-uuid").value).toBe("");
  });
});

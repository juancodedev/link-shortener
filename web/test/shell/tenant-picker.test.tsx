import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/shell/navigate", () => ({ navigate: vi.fn(), reload: vi.fn() }));

import { reload } from "../../src/shell/navigate";
import { showTenantPicker } from "../../src/shell/tenant-picker";

/**
 * The location picker a multi-store user sees when the API answers 409
 * tenant_required (formerly window.__showTenantPicker in the served shell).
 * The API refuses rather than guessing, so the user has to choose; the choice
 * is remembered so a reload does not fall back to 409.
 */

const STORES = [
  { slug: "store-a", displayName: "Store A", role: "admin" },
  { slug: "store-b", displayName: "Store B", role: "viewer" },
];

function show(available: unknown[]) {
  act(() => {
    showTenantPicker(available as never);
  });
}

const select = () => document.getElementById("tenant-select") as HTMLSelectElement;

describe("tenant picker", () => {
  beforeEach(() => {
    document.body.innerHTML = '<nav class="topbar"></nav><div class="container"></div>';
    window.localStorage.clear();
    vi.mocked(reload).mockClear();
    window.scrollTo = vi.fn();
  });

  afterEach(() => {
    act(() => {
      document.getElementById("tenant-picker")?.remove();
    });
  });

  it("puts the bar at the top of the page, labelled, with one option per location", () => {
    show(STORES);

    const host = document.getElementById("tenant-picker")!;
    expect(document.body.firstElementChild).toBe(host);
    const bar = host.querySelector(".tenant-bar")!;
    expect(bar.querySelector('label[for="tenant-select"]')!.textContent).toBe("Ubicación");
    expect([...select().options].map((o) => [o.value, o.textContent])).toEqual([
      ["store-a", "Store A (administrador)"],
      ["store-b", "Store B (lector)"],
    ]);
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("falls back to the slug when a location has no display name", () => {
    show([{ slug: "store-c", role: "admin" }]);
    expect(select().options[0]!.textContent).toBe("store-c (administrador)");
  });

  it("preselects the remembered location", () => {
    window.localStorage.setItem("tenant", "store-b");
    show(STORES);
    expect(select().value).toBe("store-b");
  });

  it("remembers the choice and reloads, so the next load names it", () => {
    show(STORES);

    act(() => {
      select().value = "store-b";
      select().dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(window.localStorage.getItem("tenant")).toBe("store-b");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // The names and slugs come from the API, so they are untrusted markup.
  it("renders a location name with markup as text", () => {
    show([{ slug: 'x"><img src=x onerror=alert(1)>', displayName: "<b>Bold</b> & co", role: "<i>admin</i>" }]);

    expect(document.querySelector("#tenant-picker img, #tenant-picker b, #tenant-picker i")).toBeNull();
    expect(select().options[0]!.textContent).toBe("<b>Bold</b> & co (<i>admin</i>)");
    expect(select().options[0]!.value).toBe('x"><img src=x onerror=alert(1)>');
  });

  it("reuses the same bar when the API asks again", () => {
    show(STORES);
    show([STORES[0]]);

    expect(document.querySelectorAll("#tenant-picker")).toHaveLength(1);
    expect(select().options).toHaveLength(1);
  });

  it("still shows when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    show(STORES);
    vi.restoreAllMocks();

    expect(select().options).toHaveLength(2);
  });
});

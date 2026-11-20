import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installLegacy, settle, standardApi } from "./harness";

// How the served page reaches the Links island: the registry name, the plan
// limit the server knows, and the print queue the entry point installs.

describe("Links island — mounting", () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    vi.resetModules();
  });

  it("is registered under the name its placeholder carries, and reads the plan limit from it", async () => {
    installLegacy();
    standardApi({ links: [] });
    // The served mount (src/handlers/dashboard.ts): the island fills the whole
    // Links section, so its own #links-card is the only one on the page.
    document.body.innerHTML =
      '<section class="dash-section" data-section="links"><div id="links-root" data-island="links" data-link-limit="50"></div></section>';
    const { ISLANDS } = await import("../../src/registry");
    const { mountIslands } = await import("../../src/islands");

    let roots: { unmount(): void }[] = [];
    await act(async () => {
      roots = mountIslands(ISLANDS);
    });
    await settle();

    expect(Object.keys(ISLANDS)).toContain("links");
    expect(document.querySelector("#links-card h3")!.textContent).toBe("Tus enlaces (0/50)");
    expect(document.querySelectorAll("#links-card")).toHaveLength(1);
    expect(document.querySelector('[data-section="links"] #create-form')).not.toBeNull();
    act(() => roots.forEach((r) => r.unmount()));
  });

  it("publishes no print-queue globals when the islands load", async () => {
    document.body.innerHTML = '<span id="cards-count" hidden></span>';

    await import("../../src/registry");

    for (const name of ["__printQueue", "__setPrintQueued", "__clearPrintQueue"]) {
      expect(name in window).toBe(false);
    }
  });
});

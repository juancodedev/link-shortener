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
    document.body.innerHTML = '<div class="card no-print" id="links-card" data-island="links" data-link-limit="50"></div>';
    const { ISLANDS } = await import("../../src/registry");
    const { mountIslands } = await import("../../src/islands");

    let roots: { unmount(): void }[] = [];
    await act(async () => {
      roots = mountIslands(ISLANDS);
    });
    await settle();

    expect(Object.keys(ISLANDS)).toContain("links");
    expect(document.querySelector("#links-card h3")!.textContent).toBe("Your Links (0/50)");
    act(() => roots.forEach((r) => r.unmount()));
  });

  it("lends the print queue to the page before any island mounts", async () => {
    document.body.innerHTML = '<span id="cards-count" hidden></span>';
    const w = window as unknown as Record<string, unknown>;
    delete w.__setPrintQueued;
    delete w.__clearPrintQueue;
    delete w.__printQueue;

    await import("../../src/registry");

    expect(typeof window.__setPrintQueued).toBe("function");
    expect(typeof window.__clearPrintQueue).toBe("function");
    expect(window.__printQueue).toEqual([]);
  });
});

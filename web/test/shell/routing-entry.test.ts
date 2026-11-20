import { describe, expect, it } from "vitest";
import source from "../../src/routing-entry.ts?raw";

/**
 * The routing entry (web/src/routing-entry.ts) is its own tiny module, loaded
 * before the dashboard bundle (src/handlers/dashboard.ts). The bundle is
 * ~500 kB with the Supabase client in it, and module scripts run in document
 * order, so routing from inside it left a deep link such as #cards showing
 * Links until the whole bundle had arrived and run.
 */
describe("the routing entry", () => {
  it("opens the section the hash names as soon as it runs", async () => {
    document.body.innerHTML = `
      <aside class="sidebar"><a href="#links" data-section-link="links">Links</a><a href="#cards" data-section-link="cards">Cards</a></aside>
      <section class="dash-section" data-section="links"></section>
      <section class="dash-section" data-section="cards" hidden></section>`;
    window.history.replaceState(null, "", "/dashboard#cards");

    await import("../../src/routing-entry");

    expect(document.querySelector<HTMLElement>('[data-section="cards"]')!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('[data-section="links"]')!.hidden).toBe(true);
    expect(document.querySelector('[data-section-link="cards"]')!.getAttribute("aria-current")).toBe("page");
  });

  it("imports nothing but the router, so it stays a few hundred bytes", () => {
    const imports = [...source.matchAll(/^import\s.*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    expect(imports).toEqual(["./shell/routing"]);
  });
});

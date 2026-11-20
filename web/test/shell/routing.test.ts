import { beforeEach, describe, expect, it } from "vitest";
import { sectionFromHash, showSection, startRouting } from "../../src/shell/routing";

/**
 * Sidebar sections (odd/tasks/print-queue-cards.md S1), formerly the inline
 * script in the served shell. The hash names the visible section, so a reload
 * or a shared link opens the same one; Links is the default. Hiding uses the
 * [hidden] attribute, which the print stylesheet keys on.
 */

const NAMES = ["overview", "links", "cards", "businesses", "comments", "settings"];

function servePage() {
  document.body.innerHTML = `
    <aside class="sidebar no-print"><nav class="side-nav">
      ${NAMES.map((n) => `<a href="#${n}" data-section-link="${n}"><span>${n}</span>${n === "cards" ? ' <span id="cards-count" class="side-count" hidden></span>' : ""}</a>`).join("")}
    </nav></aside>
    <main class="sections">
      ${NAMES.map((n) => `<section class="dash-section" data-section="${n}"${n === "links" ? "" : " hidden"}></section>`).join("")}
    </main>`;
}

const visible = () =>
  [...document.querySelectorAll<HTMLElement>(".dash-section")].filter((s) => !s.hidden).map((s) => s.dataset.section);
const active = () =>
  [...document.querySelectorAll<HTMLElement>("[data-section-link]")]
    .filter((a) => a.classList.contains("is-active"))
    .map((a) => [a.dataset.sectionLink, a.getAttribute("aria-current")]);

describe("sectionFromHash", () => {
  it("reads the section from the URL hash and falls back to Links", () => {
    expect(sectionFromHash("#cards")).toBe("cards");
    expect(sectionFromHash("#overview")).toBe("overview");
    expect(sectionFromHash("settings")).toBe("settings");
    expect(sectionFromHash("")).toBe("links");
    expect(sectionFromHash("#nope")).toBe("links");
    expect(sectionFromHash("#Cards")).toBe("links");
  });
});

describe("showSection", () => {
  beforeEach(servePage);

  it("shows one section at a time and marks its sidebar link current", () => {
    showSection("cards", document);

    expect(visible()).toEqual(["cards"]);
    expect(active()).toEqual([["cards", "page"]]);
    for (const a of document.querySelectorAll("[data-section-link]:not(.is-active)")) {
      expect(a.hasAttribute("aria-current")).toBe(false);
    }
  });

  it("moves the current mark when the section changes", () => {
    showSection("cards", document);
    showSection("comments", document);

    expect(visible()).toEqual(["comments"]);
    expect(active()).toEqual([["comments", "page"]]);
  });

  it("leaves the Cards count badge to the print-queue store", () => {
    const badge = document.getElementById("cards-count")!;
    badge.textContent = "3";
    badge.hidden = false;

    showSection("overview", document);

    expect(badge.textContent).toBe("3");
    expect(badge.hidden).toBe(false);
  });
});

describe("startRouting", () => {
  beforeEach(servePage);

  it("opens the section the hash names, then follows hash changes", () => {
    window.history.replaceState(null, "", "/dashboard#businesses");
    const stop = startRouting(window, document);
    expect(visible()).toEqual(["businesses"]);

    window.location.hash = "#settings";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(visible()).toEqual(["settings"]);
    expect(active()).toEqual([["settings", "page"]]);

    window.history.replaceState(null, "", "/dashboard#bogus");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(visible()).toEqual(["links"]);
    stop();
  });

  it("opens Links when there is no hash", () => {
    window.history.replaceState(null, "", "/dashboard");
    const stop = startRouting(window, document);
    expect(visible()).toEqual(["links"]);
    expect(active()).toEqual([["links", "page"]]);
    stop();
  });
});

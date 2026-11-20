/**
 * Sidebar sections (odd/tasks/print-queue-cards.md S1), ported from the served
 * shell's inline script (odd/tasks/dashboard-react.md T6a). One section is
 * visible at a time; the URL hash names it, so a reload or a shared link opens
 * the same one. Links is the default: it is where cards are created, and a
 * phone has always opened there.
 *
 * The sidebar and the sections stay server-rendered; this only toggles them.
 * Hiding uses the [hidden] attribute, which the print stylesheet keys on.
 */
export const SECTIONS = ["overview", "links", "cards", "businesses", "comments", "settings"] as const;

/** The section a URL hash names, or Links for anything else. */
export function sectionFromHash(hash: string): string {
  const name = String(hash || "").replace(/^#/, "");
  return (SECTIONS as readonly string[]).includes(name) ? name : "links";
}

export function showSection(name: string, doc: Document): void {
  doc.querySelectorAll<HTMLElement>(".dash-section").forEach((el) => {
    el.hidden = el.getAttribute("data-section") !== name;
  });
  doc.querySelectorAll<HTMLElement>("[data-section-link]").forEach((a) => {
    const on = a.getAttribute("data-section-link") === name;
    a.classList.toggle("is-active", on);
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

/** Opens the section the current hash names and follows hash changes; returns the unsubscribe. */
export function startRouting(win: Window, doc: Document): () => void {
  const onHash = () => showSection(sectionFromHash(win.location.hash), doc);
  win.addEventListener("hashchange", onHash);
  onHash();
  return () => win.removeEventListener("hashchange", onHash);
}

import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

/** A React component that replaces one server-rendered dashboard section. */
export type Island = () => ReactNode;

/**
 * Mounts each registered island into the element that names it with
 * `data-island="<name>"`. Elements without a registered island are left
 * alone, so a section can move to React without touching the others.
 */
export function mountIslands(registry: Record<string, Island>, doc: Document = document): Root[] {
  const roots: Root[] = [];
  doc.querySelectorAll<HTMLElement>("[data-island]").forEach((el) => {
    const Component = registry[el.dataset.island ?? ""];
    if (!Component) return;
    const root = createRoot(el);
    root.render(Component());
    roots.push(root);
  });
  return roots;
}

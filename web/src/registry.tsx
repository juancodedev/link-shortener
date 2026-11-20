import { CardsSection } from "./cards/CardsSection";
import type { Island } from "./islands";
import { LinksSection } from "./links/LinksSection";

/** The plan's active-link limit, which only the server knows: it rides on the placeholder. */
function linkLimit(): number {
  const raw = document.getElementById("links-card")?.dataset.linkLimit;
  const n = Number(raw);
  return Number.isFinite(n) && raw !== undefined && raw !== "" ? n : 0;
}

/** Every migrated dashboard section, by its `data-island` name. */
export const ISLANDS: Record<string, Island> = {
  cards: () => <CardsSection />,
  links: () => <LinksSection limit={linkLimit()} />,
};

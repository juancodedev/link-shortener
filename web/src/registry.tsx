import { BusinessesSection } from "./businesses/BusinessesSection";
import { CardsSection } from "./cards/CardsSection";
import { CommentsSection } from "./comments/CommentsSection";
import type { Island } from "./islands";
import { LinksSection } from "./links/LinksSection";
import { OverviewSection } from "./overview/OverviewSection";
import { SettingsSection } from "./settings/SettingsSection";

/** The plan's active-link limit, which only the server knows: it rides on the placeholder. */
function linkLimit(): number {
  const raw = document.querySelector<HTMLElement>('[data-island="links"]')?.dataset.linkLimit;
  const n = Number(raw);
  return Number.isFinite(n) && raw !== undefined && raw !== "" ? n : 0;
}

/** Every migrated dashboard section, by its `data-island` name. */
export const ISLANDS: Record<string, Island> = {
  cards: () => <CardsSection />,
  links: () => <LinksSection limit={linkLimit()} />,
  overview: () => <OverviewSection />,
  businesses: () => <BusinessesSection />,
  comments: () => <CommentsSection />,
  settings: () => <SettingsSection />,
};

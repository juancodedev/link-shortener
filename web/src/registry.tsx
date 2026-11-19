import { CardsSection } from "./cards/CardsSection";
import type { Island } from "./islands";

/** Every migrated dashboard section, by its `data-island` name. */
export const ISLANDS: Record<string, Island> = {
  cards: () => <CardsSection />,
};

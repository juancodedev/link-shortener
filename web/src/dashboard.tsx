import { mountIslands } from "./islands";
import { ISLANDS } from "./registry";

/**
 * Entry point of the dashboard's React bundle. Each migrated section is
 * registered in ./registry under the name its placeholder carries in
 * `data-island`.
 */
mountIslands(ISLANDS);

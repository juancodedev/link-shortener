import { loadBranches } from "./branches/store";
import { mountIslands } from "./islands";
import { ISLANDS } from "./registry";

/**
 * Entry point of the dashboard's React bundle. Each migrated section is
 * registered in ./registry under the name its placeholder carries in
 * `data-island`.
 */
mountIslands(ISLANDS);

// Once, at boot, for every section that reads them (Businesses, the Links
// pickers, the Comments filter): it parks on window.__apiReady, as the legacy
// bootstrap call did. Businesses reloads it after each of its actions.
void loadBranches();

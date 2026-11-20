import "./dashboard.css";
import { loadBranches } from "./branches/store";
import { mountIslands } from "./islands";
import { ISLANDS } from "./registry";
import { bootAuth } from "./shell/auth";

/**
 * Entry point of the dashboard's React bundle. The sidebar routing is not
 * here: it is its own small entry (./routing-entry), which the page loads
 * first so a deep link opens its section without waiting for this bundle.
 * The shell starts with the auth bootstrap, which opens the API gate (./api)
 * once the session resolves.
 * Each section is registered in ./registry under the name its placeholder
 * carries in `data-island`, and loads itself once that gate opens.
 */
void bootAuth(document);
mountIslands(ISLANDS);

// Once, at boot, for every section that reads them (Businesses, the Links
// pickers, the Comments filter): it parks on the API gate, as each island's
// first load does. Businesses reloads it after each of its actions.
void loadBranches();

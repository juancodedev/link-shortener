import "./dashboard.css";
import { loadBranches } from "./branches/store";
import { mountIslands } from "./islands";
import { ISLANDS } from "./registry";
import { bootAuth } from "./shell/auth";
import { startRouting } from "./shell/routing";

/**
 * Entry point of the dashboard's React bundle. The shell comes first: the
 * sidebar routing, which needs only the served markup, and the auth
 * bootstrap, which opens the API gate (./api) once the session resolves.
 * Each section is registered in ./registry under the name its placeholder
 * carries in `data-island`, and loads itself once that gate opens.
 */
startRouting(window, document);
void bootAuth(document);
mountIslands(ISLANDS);

// Once, at boot, for every section that reads them (Businesses, the Links
// pickers, the Comments filter): it parks on the API gate, as each island's
// first load does. Businesses reloads it after each of its actions.
void loadBranches();

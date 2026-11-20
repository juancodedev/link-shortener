import { startRouting } from "./shell/routing";

/**
 * Its own entry, served as /assets/routing.js before the dashboard bundle
 * (src/handlers/dashboard.ts). Module scripts run in document order once the
 * page is parsed, so this one runs as soon as its few hundred bytes arrive,
 * instead of after the ~500 kB bundle: a deep link such as #cards no longer
 * shows Links first. It must import nothing but the router.
 */
startRouting(window, document);

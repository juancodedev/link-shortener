// The dashboard stylesheet as source text (web/src/dashboard.css). It used to
// be the <style> block of the served document; since T6b
// (odd/tasks/dashboard-react.md) the bundle ships it as /assets/dashboard.css
// and the document only links it, so the stylesheet tests read it here.
import css from "../../web/src/dashboard.css?raw";

export const DASHBOARD_CSS: string = css;

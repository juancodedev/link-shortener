// Stylesheets the bundle imports for their side effect; Vite emits them as
// files (web/vite.config.ts), so they export nothing the code uses.
declare module "*.css";

// Source files the tests read as text through Vite's ?raw suffix.
declare module "*?raw" {
  const text: string;
  export default text;
}

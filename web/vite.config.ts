import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/**
 * Builds the dashboard's React islands into `dist-web/`, which the Worker
 * serves as static assets (`assets` in wrangler.jsonc). File names are fixed
 * because the server-rendered dashboard references them directly; Workers
 * Static Assets revalidates them with an ETag on every load.
 */
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: {
    outDir: "../dist-web",
    emptyOutDir: true,
    rollupOptions: {
      // Two entries: the routing runs from its own tiny file so a deep link
      // does not wait for the dashboard bundle (web/src/routing-entry.ts).
      input: {
        dashboard: resolve(__dirname, "src/dashboard.tsx"),
        routing: resolve(__dirname, "src/routing-entry.ts"),
      },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});

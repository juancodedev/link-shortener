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
      input: resolve(__dirname, "src/dashboard.tsx"),
      output: {
        entryFileNames: "assets/dashboard.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});

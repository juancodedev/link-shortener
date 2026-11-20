import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import react from "@vitejs/plugin-react";

export default defineConfig({
  test: {
    projects: [
      {
        // The Worker: API, server-rendered pages, toolchain rules.
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
          }),
        ],
        test: {
          name: "worker",
          include: ["test/**/*.test.ts"],
          // The stylesheet tests read web/src/dashboard.css as text (?raw);
          // vitest blanks CSS modules unless they are processed.
          css: { include: [/web\/src\/dashboard\.css/] },
        },
      },
      {
        // The dashboard's React islands, in a browser-like DOM.
        plugins: [react()],
        test: {
          name: "web",
          environment: "jsdom",
          include: ["web/test/**/*.test.{ts,tsx}"],
          setupFiles: ["web/test/setup.ts"],
        },
      },
    ],
  },
});

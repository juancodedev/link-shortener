import { describe, expect, it } from "vitest";
import pkg from "../../package.json";
import { SUPABASE_JS_SCRIPT, SUPABASE_JS_URL } from "../../src/handlers/supabase-cdn";
import { landingHandler } from "../../src/handlers/landing";
import authSource from "../../src/handlers/auth.ts?raw";
import landingSource from "../../src/handlers/landing.ts?raw";
import setupSource from "../../src/handlers/setup.ts?raw";

// The server-rendered pages (login, signup, reset, auth callback, landing,
// setup) load the Supabase browser client from a CDN. It used to be
// `@supabase/supabase-js@2`: a floating major, so any new 2.x release ran on
// those pages the day it was published, with nothing checking the bytes. The
// dashboard bundles the client from npm instead, and both have to read the
// same stored session, so the CDN copy is pinned to the very version the
// lockfile resolves, with Subresource Integrity on top.

describe("the Supabase client on the server-rendered pages", () => {
  it("pins the exact version the dashboard bundles", () => {
    const version = pkg.dependencies["@supabase/supabase-js"];
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(SUPABASE_JS_URL).toBe(`https://unpkg.com/@supabase/supabase-js@${version}/dist/umd/supabase.js`);
  });

  it("checks the file with Subresource Integrity, fetched without credentials", () => {
    expect(SUPABASE_JS_SCRIPT).toMatch(
      new RegExp(`^<script src="${SUPABASE_JS_URL.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}" integrity="sha384-[A-Za-z0-9+/]{64}" crossorigin="anonymous"></script>$`),
    );
  });

  it("is the only way a page loads it: no floating CDN tag is left", () => {
    for (const source of [authSource, landingSource, setupSource]) {
      expect(source).not.toContain("unpkg.com/@supabase/supabase-js@2\"");
      expect(source).not.toMatch(/<script src="https:\/\/unpkg\.com/);
    }
  });

  it("serves the pinned tag on the landing page", async () => {
    const html = await (
      await landingHandler({
        env: { SUPABASE_URL: "https://test.supabase.co", SUPABASE_ANON_KEY: "k" },
        req: {},
        html: (body: string) => new Response(body, { headers: { "Content-Type": "text/html" } }),
      } as any)
    ).text();

    expect(html).toContain(SUPABASE_JS_SCRIPT);
  });
});

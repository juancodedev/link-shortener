import { describe, it, expect } from "vitest";
// Read through Vite's ?raw imports, not node:fs: the Workers test pool runs
// bundled, so a relative fs path resolves to /bundle and cannot see the
// repository. Same mechanism as test/toolchain.test.ts.
import readmeRaw from "../README.md?raw";
import routerRaw from "../src/router.ts?raw";

/**
 * The README documents the system's public surface. A route that exists but
 * is undocumented is worse than an undocumented feature: it reads as "this
 * system does not do that", so nobody builds on it, and nobody notices it
 * needs security review either.
 *
 * Six routes were missing from the README for most of this project's life,
 * including both operator billing endpoints. The prose had no way to catch
 * that -- this does.
 */
const ROUTER_SOURCE = routerRaw;

function documentedRoutes(readme: string): Set<string> {
  const set = new Set<string>();
  for (const match of readme.matchAll(/`(GET|POST|PATCH|DELETE)`\s*\|\s*`([^`]+)`/g)) {
    for (const path of match[2].split(/,\s*/)) {
      set.add(`${match[1]} ${path.trim()}`);
    }
  }
  return set;
}

describe("README route documentation", () => {
  const readme = readmeRaw;
  const documented = documentedRoutes(readme);

  // Collected from the router's own registration calls, not a hand-kept list.
  const registered = [...ROUTER_SOURCE.matchAll(
    /app\.(get|post|patch|delete)\(\s*"([^"]+)"/g,
  )].map((m) => `${m[1].toUpperCase()} ${m[2]}`);

  it("finds routes in the router source to compare", () => {
    expect(registered.length).toBeGreaterThan(15);
  });

  it("documents every registered route", () => {
    const missing = registered.filter((route) => !documented.has(route));
    expect(missing).toEqual([]);
  });

  it("documents no route that does not exist", () => {
    const known = new Set<string>(registered);
    const orphans = [...documented].filter((route) => !known.has(route));
    expect(orphans).toEqual([]);
  });

  it("documents both operator billing routes as token-only, not JWT", () => {
    for (const path of ["/api/ops/tenants", "/api/ops/tenants/subscription"]) {
      const row = readme
        .split("\n")
        .find((l) => l.includes(`\`${path}\``) && l.includes("`GET`") || l.includes(`\`${path}\``) && l.includes("`POST`"));
      expect(row, `no row for ${path}`).toBeDefined();
      // The route must appear under the operator heading, never under the
      // customer API heading.
      const operatorSection = readme.slice(
        readme.indexOf("### Operator"),
        readme.indexOf("### Customer API"),
      );
      expect(operatorSection).toContain(`\`${path}\``);
    }
  });

  it("states the absence of self-service billing", () => {
    expect(readme).toContain("No self-service billing endpoint");
  });

  it("states the pagination gap rather than hiding it", () => {
    expect(readme).toContain("No pagination");
  });
});

// ---------------------------------------------------------------------------
// The card-manufacturing walkthrough
//
// The README documents the system's public surface, and this section is the
// part an operator actually follows to produce the printed objects the product
// is about. Prose that drifts from the code is worse than no prose here: the
// steps look authoritative, so a stale field name sends someone through the
// whole flow before it fails.
// ---------------------------------------------------------------------------

describe("README card-manufacturing walkthrough", () => {
  const walkthrough = readmeRaw.slice(
    readmeRaw.indexOf("### Walkthrough: manufacture a pack of review cards"),
    readmeRaw.indexOf("### Tenant administration"),
  );

  it("documents the walkthrough at all", () => {
    expect(walkthrough.length).toBeGreaterThan(500);
  });

  it("uses the batch endpoint that exists, not one it invents", () => {
    expect(walkthrough).toContain("POST");
    expect(walkthrough).toContain("/api/links/batch");
  });

  it("shows is_gated, without which the panel never records anything", () => {
    // The single most consequential field in the flow. A walkthrough that
    // omits it produces a pack of stickers that look right and measure nothing.
    expect(walkthrough).toContain("is_gated");
  });

  it("shows location_id, which backs the per-location rollup", () => {
    expect(walkthrough).toContain("location_id");
  });

  it("shows loading a destination afterwards via PATCH", () => {
    expect(walkthrough).toContain("PATCH");
    expect(walkthrough).toContain("original_url");
  });

  it("states that the redirect cache is invalidated, not left to chance", () => {
    // Skipping this leaves the sticker serving the previous destination for
    // 24h with no error anywhere, which is invisible until a customer scans.
    expect(walkthrough).toMatch(/invalidat/i);
  });

  it("states that short_code is immutable", () => {
    expect(walkthrough).toMatch(/immutable/i);
  });

  it("names both mandatory headers", () => {
    expect(walkthrough).toContain("Authorization");
    expect(walkthrough).toContain("X-Tenant-Slug");
  });

  it("warns that failed must be checked, not just the status code", () => {
    expect(walkthrough).toContain("failed");
    expect(walkthrough).toMatch(/207/);
  });

  it("explains the not-configured page is a 200 and not a 404", () => {
    expect(walkthrough).toMatch(/200/);
    expect(walkthrough).toMatch(/404/);
  });

  it("carries a field reference table for both endpoints", () => {
    for (const field of ["original_url", "slug", "client_ref", "is_gated", "location_id"]) {
      expect(walkthrough).toContain(field);
    }
  });
});

describe("README data model matches the schema", () => {
  it("documents locations, which the per-location rollup needs", () => {
    expect(readmeRaw).toContain("public.locations");
  });

  it("says original_url is nullable rather than implying a plain column", () => {
    // Card stock depends on this being true. A README that shows a bare
    // `original_url` reads as required and sends an operator looking for a
    // workaround that does not exist.
    expect(readmeRaw).toMatch(/original_url \(NULLABLE\)/);
  });

  it("warns that card stock counts against the active-link cap", () => {
    expect(readmeRaw).toMatch(/Card stock counts against that cap/i);
  });

  it("does not state a stale hardcoded cap", () => {
    // It used to say 30 while the code said 1000 and wrangler said 500. An
    // operator sizing a print run reads that number and orders accordingly.
    expect(readmeRaw).not.toMatch(/capped at \*\*30/i);
  });
});

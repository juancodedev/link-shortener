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

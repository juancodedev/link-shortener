import { describe, it, expect } from "vitest";

// Read through Vite's ?raw imports and import.meta.glob rather than node:fs:
// the Workers test pool runs bundled, so a relative fs path resolves to
// /bundle and cannot see the repository. This is the same mechanism
// test/db/schema.test.ts already uses for the migration files.
import pkgRaw from "../package.json?raw";
import readmeRaw from "../README.md?raw";
import ciYmlRaw from "../.github/workflows/ci.yml?raw";
import deployYmlRaw from "../.github/workflows/deploy.yml?raw";
import dependabotRaw from "../.github/dependabot.yml?raw";

const readFileSync = (_p: string) => {
  throw new Error("use the ?raw imports, not the filesystem");
};

const pkg = JSON.parse(pkgRaw) as {
  packageManager: string;
  scripts: Record<string, string>;
};
const readme = readmeRaw;

/** Repository-root lockfiles Vite can see at build time. */
const LOCKFILES = import.meta.glob("../*lock*", {
  eager: true,
  query: "?raw",
}) as Record<string, string>;

function lockfilePresent(basename: string): boolean {
  return Object.keys(LOCKFILES).some((k) => k.endsWith(`/${basename}`));
}

// ---------------------------------------------------------------------------
// Single-toolchain guard
//
// WHY THIS EXISTS
//
// `package.json` declares `packageManager: "pnpm@9.15.9"` and the repository
// carries exactly one lockfile, `pnpm-lock.yaml`. Commit 8aa3969 deleted all
// 3317 lines of `package-lock.json` to consolidate on that.
//
// Dependabot was left on its defaults with no `dependabot.yml`, so it opened
// three PRs — #14, #16, #18 — that all modify `package-lock.json`. Their
// branches predate the consolidation, so merging any of them resurrects the
// npm lockfile and leaves the repository with two competing lockfiles for one
// `package.json`. A developer cloning with npm then resolves a different
// dependency tree than CI does.
//
// The workflow files were already pnpm throughout, so CI never noticed: it
// installs with `pnpm install --frozen-lockfile` and simply ignores a
// `package-lock.json` a PR happens to carry.
//
// These tests keep the whole toolchain on pnpm. They read files rather than
// shelling out, so they run inside the Workers test pool like everything else.
// ---------------------------------------------------------------------------

const pkgManager = "pnpm";

describe("the repository uses exactly one package manager", () => {
  it("declares pnpm as the packageManager", () => {
    expect(pkg.packageManager).toContain(`${pkgManager}@`);
  });

  it("tracks a pnpm lockfile", () => {
    expect(lockfilePresent("pnpm-lock.yaml")).toBe(true);
  });

  it("tracks no npm lockfile — two lockfiles means two dependency trees", () => {
    // The one assertion that would have caught all three stale PRs.
    expect(
      lockfilePresent("package-lock.json"),
      "package-lock.json is back — it was deleted in 8aa3969 to consolidate on pnpm",
    ).toBe(false);
  });

  it("has no npm shrinkwrap or yarn lockfile competing with pnpm", () => {
    for (const other of ["npm-shrinkwrap.json", "yarn.lock"]) {
      expect(lockfilePresent(other), `${other} competes with pnpm-lock.yaml`).toBe(
        false,
      );
    }
  });
});

describe("CI runs on pnpm", () => {
  const workflows: Array<[string, string]> = [
    ["ci", ciYmlRaw],
    ["deploy", deployYmlRaw],
  ];

  for (const [wf, yaml] of workflows) {
    it(`${wf}.yml installs with pnpm --frozen-lockfile`, () => {
      expect(yaml).toMatch(/pnpm\/action-setup/);
      expect(yaml).toMatch(/pnpm install --frozen-lockfile/);
      expect(yaml).toMatch(/cache:\s*pnpm/);
    });

    it(`${wf}.yml invokes no npm command`, () => {
      // Strip comments so prose about npm in a `#` line is not a violation.
      const code = yaml
        .split("\n")
        .filter((l) => !l.trim().startsWith("#"))
        .join("\n");
      expect(
        /(?<![\w-])npm\s+(ci|install|run|test|exec)\b/.test(code),
        `${wf}.yml runs an npm command`,
      ).toBe(false);
    });
  }
});

describe("Dependabot is configured for this repository", () => {
  it("has a config at all", () => {
    // Its absence is what let Dependabot open three PRs against a lockfile
    // that does not exist in the repository. The ?raw import above would fail
    // the whole suite at build time if the file were missing, which is a
    // louder failure than an assertion.
    expect(dependabotRaw.length).toBeGreaterThan(0);
  });

  it("watches the root directory with a schedule", () => {
    const yaml = dependabotRaw;
    expect(yaml).toMatch(/^version:\s*2\s*$/m);
    expect(yaml).toMatch(/package-ecosystem:/);
    expect(yaml).toMatch(/directory:\s*"\/"/);
    expect(yaml).toMatch(/schedule:/);
    expect(yaml).toMatch(/interval:/);
  });
});

describe("documented commands match the toolchain", () => {
  it("README documents pnpm, not npm", () => {
    const offenders = readme
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) =>
        /(?<![\w-])npm\s+(ci|install|run|test|exec)\b/.test(line),
      );
    expect(
      offenders.map((o) => `README.md:${o.n}: ${o.line.trim()}`),
      "README still documents npm commands",
    ).toEqual([]);
  });

  it("README's script table lists pnpm for every package.json script", () => {
    for (const name of Object.keys(pkg.scripts)) {
      // pnpm accepts both `pnpm run x` and the bare `pnpm x`; the bare form is
      // the idiomatic one for `test` and is what the README uses. Requiring
      // `pnpm run test` would be documenting the worse spelling.
      const long = readme.includes(`\`pnpm run ${name}\``);
      const short = readme.includes(`\`pnpm ${name}\``);
      expect(
        long || short,
        `README does not document \`${name}\` as a pnpm command`,
      ).toBe(true);
    }
  });
});
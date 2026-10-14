import { describe, it, expect } from "vitest";
import { dashboardHandler } from "../../src/handlers/dashboard";
import { renderGatePanel } from "../../src/handlers/gate-panel";

// ---------------------------------------------------------------------------
// The token layer — regression guard.
//
// WHY THIS FILE EXISTS
//
// The dashboard is a single template literal. Before this layer it carried 66
// hardcoded hex occurrences across 24 distinct colours, with no CSS custom
// properties anywhere. That is why `odd/analysis/dashboard-directions.md` calls
// the token layer "the first task of any future pass": with no `:root`, every
// visual decision is a find-and-replace across the whole file.
//
// A refactor that only ADDS tokens is worthless if the next contributor writes
// `#2563eb` inline again. So these tests assert the SHAPE of the stylesheet,
// not the presence of tokens — the shape is what keeps the layer intact:
//
//   1. A `:root` block exists and is the only place a literal colour may appear.
//   2. Every colour actually resolves: no `var(--x)` pointing at nothing, which
//      would silently paint nothing and look like a styling bug, not a typo.
//   3. The vocabulary is the domain's, not a generic scale. `--kraft` reads as
//      this product; `--gray-700` reads as a default, and the analysis document
//      rejects defaults explicitly.
//
// These assert against the SERVED output, for the same reason the XSS tests in
// dashboard.test.ts do: asserting against the source would pass while the
// shipped page stayed un-tokenised.
// ---------------------------------------------------------------------------

/** A hex colour literal: `#abc`, `#abcd`, `#aabbcc`, `#aabbccdd`. */
const HEX = /#[0-9a-fA-F]{3,8}\b/;

function mockContext() {
  return {
    env: {
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_ANON_KEY: "test-anon-key",
    },
    html: (body: string) =>
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
  } as any;
}

async function serve(): Promise<string> {
  return (await dashboardHandler(mockContext())).text();
}

async function styleBlock(): Promise<string> {
  const html = await serve();
  const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
  if (!css) throw new Error("no <style> block in served HTML");
  return css;
}

/** The served HTML with the <style> block removed — i.e. the markup and scripts. */
async function htmlWithoutStyle(): Promise<string> {
  const html = await serve();
  return html.replace(/<style>[\s\S]*?<\/style>/, "");
}

function rootBlock(css: string): string {
  const match = css.match(/:root\s*\{[\s\S]*?\n\s*\}/);
  if (!match) throw new Error("no :root token block in the served stylesheet");
  return match[0];
}

// ---------------------------------------------------------------------------
// 1. Colours live in :root and nowhere else
// ---------------------------------------------------------------------------

describe("token layer — literals live in :root only", () => {
  it("declares tokens in a :root block", async () => {
    const css = await styleBlock();

    expect(css).toMatch(/:root\s*\{/);
  });

  it("keeps every hex colour literal inside the :root block", async () => {
    const css = await styleBlock();
    const outsideRoot = css.replace(rootBlock(css), "");

    const offenders = outsideRoot.match(new RegExp(HEX.source, "g")) ?? [];
    expect(
      offenders,
      `hardcoded colour(s) outside :root: ${[...new Set(offenders)].join(", ")}`,
    ).toEqual([]);
  });

  it("keeps rgba() shadow and veil literals inside :root too", async () => {
    const css = await styleBlock();
    const outsideRoot = css.replace(rootBlock(css), "");

    // rgba() is a colour just as much as a hex is. The three that exist today
    // are the card shadow, the modal shadow, and the modal veil.
    const rgba = outsideRoot.match(/rgba?\([^)]*\)/g) ?? [];
    expect(rgba, `rgba colour(s) outside :root: ${rgba.join(", ")}`).toEqual([]);
  });

  it("carries no hex colour literal in the markup or the inline scripts", async () => {
    const markup = await htmlWithoutStyle();

    const offenders = markup.match(new RegExp(HEX.source, "g")) ?? [];
    expect(
      offenders,
      `hardcoded colour(s) outside the stylesheet: ${[...new Set(offenders)].join(", ")}`,
    ).toEqual([]);
  });

  it("leaves no colour-bearing inline style attribute behind", async () => {
    const markup = await htmlWithoutStyle();
    const styles = [...markup.matchAll(/style="([^"]*)"/g)].map((m) => m[1]);

    // `display:none` stays inline on purpose: those elements are toggled from
    // script via `.style.display`, so a class would break the toggle. Layout
    // utilities that no script touches are allowed through. A colour is not.
    const coloured = styles.filter((s) => HEX.test(s) || /color\s*:/.test(s));
    expect(
      coloured,
      `inline style(s) still carrying a colour: ${coloured.join(" | ")}`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Every token resolves
// ---------------------------------------------------------------------------

describe("token layer — every reference resolves", () => {
  it("declares every token the stylesheet references", async () => {
    const css = await styleBlock();
    const declared = new Set(
      [...rootBlock(css).matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]),
    );
    const referenced = new Set(
      [...css.matchAll(/var\(\s*--([a-z0-9-]+)/g)].map((m) => m[1]),
    );

    // An unresolved `var(--typo)` is not a build error and not a test failure
    // anywhere else: the browser just paints nothing. This is the only place
    // that catches it.
    const missing = [...referenced].filter((t) => !declared.has(t));
    expect(missing, `var() references with no :root declaration: ${missing.join(", ")}`).toEqual([]);
  });

  it("gives every token a non-empty value", async () => {
    const css = await styleBlock();
    const empties = [...rootBlock(css).matchAll(/--([a-z0-9-]+)\s*:\s*;/g)].map((m) => m[1]);

    expect(empties, `token(s) declared with no value: ${empties.join(", ")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. The vocabulary is the domain's
// ---------------------------------------------------------------------------

describe("token layer — the vocabulary is the domain's", () => {
  it("names surfaces, ink, and the tag after the product, not after a scale", async () => {
    const css = await styleBlock();
    const declared = [...rootBlock(css).matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]);

    // odd/analysis/dashboard-directions.md: "Token names should come from the
    // domain, not from a scale ... Reading only the token names should let
    // someone guess what the product is."
    expect(declared).toEqual(
      expect.arrayContaining(["kraft", "sticker", "ink", "tag"]),
    );
  });

  it("names the link lifecycle states, which are the product's real states", async () => {
    const css = await styleBlock();
    const declared = [...rootBlock(css).matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]);

    // active / expired / inactive — the states a printed tag can be in.
    expect(declared).toEqual(
      expect.arrayContaining(["live", "stale", "retired"]),
    );
  });

  it("uses no generic scale names", async () => {
    const css = await styleBlock();
    const declared = [...rootBlock(css).matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]);

    const generic = declared.filter((t) => /^(gray|grey|blue|red|green|slate|zinc|neutral)-?\d*$/.test(t));
    expect(generic, `generic scale name(s): ${generic.join(", ")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. The gate panel is part of the same layer
// ---------------------------------------------------------------------------

describe("token layer — the review-gate panel", () => {
  const payload = {
    split: {
      totalScans: 10,
      derivationRate: 0.6,
      google: { scans: 6, rated: 4, avgRating: 4.5 },
      private: { scans: 4, rated: 3, avgRating: 3.5 },
      sentimentGap: 1,
    },
    locations: [
      { locationName: "Cafe Central", totalScans: 7, derivationRate: 0.5 },
    ],
    peaks: [
      { bucketStart: 1_700_000_000, total: 3, google: 2, derivationRate: 0.66 },
      { bucketStart: 1_700_086_400, total: 5, google: 4, derivationRate: 0.8 },
    ],
    meta: { minRatedSample: 3 },
  };

  it("emits no hex colour literal", () => {
    const html = renderGatePanel(payload as any);

    const offenders = html.match(new RegExp(HEX.source, "g")) ?? [];
    expect(
      offenders,
      `hardcoded colour(s) in the gate panel: ${[...new Set(offenders)].join(", ")}`,
    ).toEqual([]);
  });

  it("emits no colour-bearing inline style", () => {
    const html = renderGatePanel(payload as any);
    const styles = [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]);

    const coloured = styles.filter((s) => HEX.test(s) || /color\s*:/.test(s) || /background\s*:/.test(s));
    // The peak bar's height is computed inline and must stay — it is data, not
    // styling. Only colour is banned here.
    expect(
      coloured,
      `gate-panel inline style(s) still carrying a colour: ${coloured.join(" | ")}`,
    ).toEqual([]);
  });

  it("still renders the computed bar heights inline", () => {
    const html = renderGatePanel(payload as any);

    // Guards the rule above from being over-applied: `height:NN%` is data.
    expect(html).toMatch(/style="[^"]*height:\s*\d+%/);
  });
});
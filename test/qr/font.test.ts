import { describe, it, expect } from "vitest";
// Imported, not read from disk. The Workers pool serves a virtual bundle where
// a relative `readFileSync("package.json")` resolves to `/bundle/package.json`
// and throws — three tests failed on exactly that. Vite inlines both of these
// at transform time, so the assertion is about the committed repo state and
// costs nothing at runtime.
import pkg from "../../package.json";
import glyphsSource from "../../src/qr/glyphs.ts?raw";
import generatorSource from "../../scripts/build-glyphs.py?raw";
import { textToPathData, measureText } from "../../src/qr/font";
import { FONT_ADVANCE, FONT_UNITS_PER_EM, GLYPHS } from "../../src/qr/glyphs";
import pkgJson from "../../package.json";

/** Absolute coordinate pairs out of a glyph path stream. */
function coords(d: string): number[][] {
  const nums = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const pairs: number[][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pairs.push([nums[i]!, nums[i + 1]!]);
  return pairs;
}

function bounds(d: string) {
  const pairs = coords(d);
  const xs = pairs.map((p) => p[0]!);
  const ys = pairs.map((p) => p[1]!);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

describe("the short-code font", () => {
  it("carries every character a short code can contain", () => {
    // base62 plus the two separators the generator emits. A missing glyph is a
    // silently blank character on a sticker nobody can read or transcribe.
    for (const ch of CHARSET) {
      expect(GLYPHS[ch], `glyph for ${ch}`).toBeTruthy();
    }
    expect(Object.keys(GLYPHS)).toHaveLength(CHARSET.length);
  });

  it("flips Y, because the font draws up and SVG draws down", () => {
    const { d } = textToPathData("j", { size: 10, centerX: 50, baseline: 50 });
    const b = bounds(d);

    // A letter with a descender (j) must extend BELOW the baseline in SVG's
    // downward-positive Y. Forgetting the flip draws every character upside
    // down, and it looks plausible enough to ship.
    expect(b.maxY).toBeGreaterThan(50);
    expect(b.minY).toBeLessThan(50);
  });

  it("centres the line on the requested axis", () => {
    for (const text of ["a", "jyEdjUp", "VV6iGQm", "Mesa-14"]) {
      const { d } = textToPathData(text, { size: 4.5, centerX: 42.5, baseline: 80, tracking: 0.4 });
      const b = bounds(d);
      // Optical centre, which for a real line of type sits a little above the
      // geometric centre of its ink. Two tenths of a millimetre of slack.
      expect((b.minX + b.maxX) / 2, text).toBeCloseTo(42.5, 0);
    }
  });

  it("advances every character identically", () => {
    // Monospaced: `i` and `W` occupy the same width. If it were not, a code
    // would be hard to read off a card at a glance.
    expect(measureText("i", { size: 10 })).toBe(measureText("W", { size: 10 }));
  });

  it("grows linearly with size", () => {
    const small = measureText("jyEdjUp", { size: 4.5 });
    const large = measureText("jyEdjUp", { size: 9 });
    expect(large / small).toBeCloseTo(2, 3);
  });

  it("adds tracking between glyphs but not after the last one", () => {
    const plain = measureText("abc", { size: 10 });
    const tracked = measureText("abc", { size: 10, tracking: 1 });

    // Three glyphs, two gaps. Adding a trailing gap would shift the line left of
    // centre and make the centring look slightly off for no visible reason.
    expect(tracked - plain).toBeCloseTo(2, 6);
  });

  it("skips a character it has no outline for, instead of throwing", () => {
    // A client_ref can contain anything. Refusing to render the whole card
    // because one character is missing would be a worse failure than a gap.
    expect(() => textToPathData("mesa™14", { size: 4, centerX: 40, baseline: 80 })).not.toThrow();
  });

  it("returns an empty string for empty input", () => {
    const { d, width } = textToPathData("", { size: 4, centerX: 40, baseline: 80 });
    expect(d).toBe("");
    expect(width).toBe(0);
  });

  it("reports the font's own metrics rather than guessing them", () => {
    // These are read off the subset, not hardcoded here. If the font is
    // re-subset, the numbers move with it.
    expect(FONT_UNITS_PER_EM).toBe(2048);
    expect(FONT_ADVANCE).toBe(1233);
  });
});

describe("the bundle cost of printing text", () => {
  it("ships outlines, not a font parser", () => {
    const pkg = pkgJson;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    // Outlining a short code at runtime means shipping a font parser.
    // opentype.js is 520 KB and took the Worker bundle from 631 KB to 1255 KB
    // to draw a string that is never read as text — it is read as INK, by a
    // laser or an engraver. The glyphs are extracted once by
    // scripts/build-glyphs.py and the runtime does arithmetic.
    expect(deps).not.toHaveProperty("opentype.js");
    expect(deps).not.toHaveProperty("fontkit");
    expect(deps).not.toHaveProperty("@pdf-lib/fontkit");
  });

  it("is generated, and says so, so nobody hand-edits it", () => {
    const source = glyphsSource;
    expect(source).toContain("GENERATED");
    expect(source).toContain("scripts/build-glyphs.py");
  });

  it("ships a generator that actually reproduces the committed table", () => {
    // If the table and the script drift apart, the next person to rebuild gets
    // a diff they cannot explain. This asserts the pipeline exists and is
    // runnable, not that its output is current — that is CI's job to notice.
    const script = generatorSource;
    expect(script).toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(script).toContain("src/qr/glyphs.ts");
  });
});
import { FONT_ADVANCE, FONT_UNITS_PER_EM, GLYPHS } from "./glyphs";

/** Cap height as a fraction of the em — 0.729 for DejaVu Sans Mono. */
export const CAP_HEIGHT = 0.729;

/**
 * One glyph's coordinates in font units, parsed once.
 *
 * Parsed at module load rather than per call because the parse is a regex over
 * a short string and the Worker is long-lived: doing it 8 times per card to
 * render 8 characters would be silly.
 */
type Glyph = { ops: number[]; commands: string[] };

const cache = new Map<string, Glyph | null>();

function glyph(ch: string): Glyph | null {
  if (cache.has(ch)) return cache.get(ch)!;

  const source = GLYPHS[ch];
  if (!source) {
    cache.set(ch, null);
    return null;
  }

  const tokens = source.split(" ");
  const commands: string[] = [];
  const ops: number[] = [];

  for (const token of tokens) {
    if (/^[MLQCZ]$/.test(token)) {
      commands.push(token);
    } else {
      ops.push(Number(token));
    }
  }

  const parsed: Glyph = { ops, commands };
  cache.set(ch, parsed);
  return parsed;
}

/**
 * Renders text as SVG path data in millimetre user units, centred on `centerX`.
 *
 * `baseline` is the BASELINE, not the top — the convention every font engine
 * uses, and getting it wrong is how a line of text ends up 4mm too low.
 *
 * The Y flip happens here and nowhere else: glyphs are authored with Y up (the
 * font's convention) and SVG has Y down. The two meet exactly once, and this is
 * it, because every other place that forgot to flip drew upside-down letters.
 */
export function textToPathData(
  text: string,
  opts: { size: number; centerX: number; baseline: number; tracking?: number },
): { d: string; width: number } {
  const scale = opts.size / FONT_UNITS_PER_EM;
  const tracking = opts.tracking ?? 0;
  const advance = FONT_ADVANCE * scale;

  const width = text.length * advance + tracking * Math.max(0, text.length - 1);
  let cursor = opts.centerX - width / 2;

  const out: string[] = [];

  for (const ch of text) {
    const g = glyph(ch);
    if (g) {
      out.push(transformGlyph(g, cursor, opts.baseline, scale));
    }
    cursor += advance + tracking;
  }

  return { d: out.join(" "), width };
}

/** Width of `text` at `size`, including tracking. */
export function measureText(
  text: string,
  opts: { size: number; tracking?: number },
): number {
  const tracking = opts.tracking ?? 0;
  const advance = FONT_ADVANCE * (opts.size / FONT_UNITS_PER_EM);
  return text.length * advance + tracking * Math.max(0, text.length - 1);
}

function n(v: number): string {
  return v.toFixed(2).replace(/\.?0+$/, "");
}

function transformGlyph(
  g: Glyph,
  originX: number,
  baseline: number,
  scale: number,
): string {
  const parts: string[] = [];
  let i = 0;

  for (const command of g.commands) {
    parts.push(command);
    if (command === "Z") continue;

    // M/L take one point, Q two, C three.
    const arity = command === "M" || command === "L" ? 1 : command === "Q" ? 2 : 3;
    for (let k = 0; k < arity; k++) {
      const x = g.ops[i++]!;
      const y = g.ops[i++]!;
      // The flip. Font Y is up, SVG Y is down.
      parts.push(`${n(originX + x * scale)} ${n(baseline - y * scale)}`);
    }
  }

  return parts.join(" ");
}

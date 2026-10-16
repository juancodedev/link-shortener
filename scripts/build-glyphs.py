#!/usr/bin/env python3
"""
Builds src/qr/glyphs.ts from the subset font in this directory.

WHY THIS IS A BUILD STEP AND NOT A RUNTIME FONT PARSER

The card prints a short code — at most 8 characters of base62, plus an optional
client_ref. Outlining that at runtime costs a font parser in the bundle:
opentype.js is 520 KB, which took the Worker from 631 KB to 1255 KB to draw a
string nobody will ever read as text.

The glyphs never change. So they are extracted ONCE, here, and the Worker gets a
table of outlines. Runtime then does arithmetic — a scale and a flip — which is
a few multiplications per coordinate, not a TTF parser.

The result is byte-identical output at roughly 1/40th of the bundle cost.

RUN:  python3 scripts/build-glyphs.py
"""

import json
import os
import sys

from fontTools.pens.basePen import BasePen
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FONT = os.path.join(HERE, "shortcode-mono.ttf")
OUT = os.path.join(ROOT, "src", "qr", "glyphs.ts")
CHARS = (
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "abcdefghijklmnopqrstuvwxyz"
    "0123456789-_"
)


class CoordinatePen(BasePen):
    """Collects absolute glyph contours as M/L/Q/C/Z commands."""

    def __init__(self, glyph_set):
        super().__init__(glyph_set)
        self.commands = []

    def _moveTo(self, pt):
        self.commands.append(("M", pt))

    def _lineTo(self, pt):
        self.commands.append(("L", pt))

    def _curveToOne(self, p1, p2, p3):
        self.commands.append(("C", p1, p2, p3))

    def _qCurveToOne(self, p1, p2):
        self.commands.append(("Q", p1, p2))

    def _closePath(self):
        self.commands.append(("Z",))

    def _endPath(self):
        self.commands.append(("Z",))


def main() -> int:
    if not os.path.exists(FONT):
        print("missing subset font; run scripts/subset-font.sh first", file=sys.stderr)
        return 1

    font = TTFont(FONT)
    glyph_set = font.getGlyphSet()
    cmap = font.getBestCmap()
    units_per_em = font["head"].unitsPerEm
    advance = font["hmtx"][cmap[ord("0")]][0]

    glyphs = {}
    for ch in CHARS:
        name = cmap[ord(ch)]
        pen = CoordinatePen(glyph_set)
        glyph_set[name].draw(pen)

        parts = []
        for cmd in pen.commands:
            parts.append(cmd[0])
            for pt in cmd[1:]:
                parts.append(str(int(round(pt[0]))))
                parts.append(str(int(round(pt[1]))))
        glyphs[ch] = " ".join(parts)

    header = '''/**
 * Glyph outlines for the characters a short code can contain.
 *
 * GENERATED — do not edit. Run `python3 scripts/build-glyphs.py` to rebuild.
 * Source: scripts/shortcode-mono.ttf (DejaVu Sans Mono, Bitstream Vera licence,
 * subset to base62 plus `-` and `_`; OS/2 fsType 0, embeddable without
 * restriction. https://dejavu-fonts.github.io/License.html)
 *
 * WHY PRECOMPUTED
 *
 * Outlining a short code at runtime means shipping a font parser. opentype.js is
 * 520 KB and took the Worker bundle from 631 KB to 1255 KB to render a string
 * that is never read as text — it is read as INK, by a laser or an engraver.
 *
 * The glyphs never change, so they are extracted once at build time and the
 * Worker ships a table of outlines. Runtime does arithmetic on numbers.
 *
 * WHY OUTLINES AT ALL
 *
 * The short code is the fallback for a damaged card: a human reads it and types
 * it. As a `<text>` element its shape belongs to whoever opens the SVG — the
 * designer's Mac, their colleague's Linux box, the print shop's RIP. A card is
 * laminated and left in the world for years, and its typography has to be fixed
 * at the moment it is generated.
 *
 * Coordinates are FONT UNITS with Y pointing UP. Every consumer flips Y, because
 * SVG's Y points down and the two conventions meet exactly once, here.
 */

export const FONT_UNITS_PER_EM = %d;

/** Advance width in font units. Monospaced: every glyph advances identically. */
export const FONT_ADVANCE = %d;

/** Outline per character, as a command stream: M/L/Q/C/Z with absolute coords. */
export const GLYPHS: Record<string, string> = %s;
''' % (
        units_per_em,
        advance,
        json.dumps(glyphs, indent=2, sort_keys=True),
    )

    with open(OUT, "w") as handle:
        handle.write(header)

    print(
        "wrote %s: %d glyphs, %d bytes"
        % (os.path.relpath(OUT, ROOT), len(glyphs), os.path.getsize(OUT))
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

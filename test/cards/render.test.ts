import { describe, it, expect } from "vitest";
import {
  CARD_DESIGNS,
  CARD_VARIANTS,
  renderReviewCard,
} from "../../src/cards/render";
import { matrixToPath, qrMatrix } from "../../src/api/qr";

// ---------------------------------------------------------------------------
// The 10×10 cm review card (odd/tasks/print-queue-cards.md S4)
// ---------------------------------------------------------------------------

const URL = "https://masresenas.cl/Kp2mZrQ";

describe("renderReviewCard", () => {
  it("draws every design and variant as a 100×100 mm SVG", () => {
    for (const design of CARD_DESIGNS) {
      for (const variant of CARD_VARIANTS) {
        const svg = renderReviewCard({ shortUrl: URL, design, variant });
        expect(svg.startsWith("<svg")).toBe(true);
        expect(svg).toContain('viewBox="0 0 100 100"');
        expect(svg).toContain('width="100mm"');
        expect(svg).toContain('height="100mm"');
      }
    }
  });

  it("encodes the short URL with the server's QR generator in the official design", () => {
    const svg = renderReviewCard({ shortUrl: URL, design: "official", variant: "qr" });

    const matrix = qrMatrix(URL);
    const expected = matrixToPath(matrix, { x: 37, y: 64 }, 26 / matrix.length);
    expect(svg).toContain(`d="${expected}"`);
  });

  it("places the QR left of the NFC mark in the hybrid variant", () => {
    const svg = renderReviewCard({ shortUrl: URL, design: "official", variant: "hybrid" });

    const matrix = qrMatrix(URL);
    expect(svg).toContain(`d="${matrixToPath(matrix, { x: 17, y: 64 }, 21 / matrix.length)}"`);
    expect(svg).toContain(">Escanea<");
    expect(svg).toContain(">Acerca tu<");
    expect(svg).toContain(">celular aquí<");
    expect(svg).toContain(">NFC<");
  });

  it("draws no QR in the NFC-only variant", () => {
    for (const design of CARD_DESIGNS) {
      const svg = renderReviewCard({ shortUrl: URL, design, variant: "nfc" });
      expect(svg).not.toContain('shape-rendering="crispEdges"');
      expect(svg).not.toContain("<circle cx=");
      expect(svg).toContain(">NFC<");
    }
  });

  it("keeps the official design's heading, Google colours and five stars", () => {
    const svg = renderReviewCard({ shortUrl: URL, design: "official", variant: "qr" });

    expect(svg).toContain(">Califícanos en<");
    for (const colour of ["#4285F4", "#EA4335", "#FBBC05", "#34A853"]) expect(svg).toContain(colour);
    expect([...svg.matchAll(/<polygon /g)]).toHaveLength(5);
    expect(svg).toContain(">Escanea con tu cámara<");
  });

  it("draws the minimal design's dotted QR from the same matrix family, at level H", () => {
    const svg = renderReviewCard({ shortUrl: URL, design: "minimal", variant: "qr" });

    expect(svg).toContain("Valoraciones &amp; Reseñas");
    expect(svg).toContain(">Escanea con tu cámara<");
    const dark = qrMatrix(URL, "H").flat().filter(Boolean).length;
    const finderDark = 3 * (24 + 9); // ring + centre of each finder pattern
    expect([...svg.matchAll(/<circle cx=/g)]).toHaveLength(dark - finderDark);
  });

  it("uses pure black for every QR module, which prints as K100", () => {
    const official = renderReviewCard({ shortUrl: URL, design: "official", variant: "qr" });
    expect(official).toContain('fill="#000000" shape-rendering="crispEdges"');
  });
});

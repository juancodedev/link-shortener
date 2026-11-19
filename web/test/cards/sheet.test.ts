import { describe, expect, it } from "vitest";
import { computeSheetLayout, presetForSize, SHEET_PRESETS, sheetPresetSize } from "../../src/cards/sheet";

describe("cards sheet layout", () => {
  it("fits 1×2 cards on A4, 2×3 on A3 and 3×2 on landscape A3 with a 10 mm margin and a 6 mm gap", () => {
    expect(computeSheetLayout(210, 297, 10, 6, 3)).toEqual({ cols: 1, rows: 2, cap: 2, pages: 2, fits: true });
    expect(computeSheetLayout(297, 420, 10, 6, 5)).toEqual({ cols: 2, rows: 3, cap: 6, pages: 1, fits: true });
    expect(computeSheetLayout(420, 297, 10, 6, 7)).toEqual({ cols: 3, rows: 2, cap: 6, pages: 2, fits: true });
  });

  it("says when the sheet is too small for one card", () => {
    expect(computeSheetLayout(100, 100, 10, 6, 1).fits).toBe(false);
    expect(computeSheetLayout(100, 100, 0, 0, 1)).toEqual({ cols: 1, rows: 1, cap: 1, pages: 1, fits: true });
  });

  it("knows every preset of the original generator and the Chilean Oficio sheet", () => {
    expect(sheetPresetSize("297x420", 0, 0)).toEqual({ w: 297, h: 420, single: false });
    expect(sheetPresetSize("420x297", 0, 0)).toEqual({ w: 420, h: 297, single: false });
    expect(sheetPresetSize("210x297", 0, 0)).toEqual({ w: 210, h: 297, single: false });
    expect(sheetPresetSize("216x279", 0, 0)).toEqual({ w: 216, h: 279, single: false });
    expect(sheetPresetSize("216x330", 0, 0)).toEqual({ w: 216, h: 330, single: false });
    expect(sheetPresetSize("100x100", 0, 0)).toEqual({ w: 100, h: 100, single: true });
    expect(sheetPresetSize("custom", 600, 400)).toEqual({ w: 600, h: 400, single: false });
  });

  it("maps a typed width and height back to the matching sheet, or to custom", () => {
    const presets = SHEET_PRESETS.map((p) => p.value);

    expect(presetForSize(216, 330, presets)).toBe("216x330");
    expect(presetForSize(210, 297, presets)).toBe("210x297");
    expect(presetForSize(250, 350, presets)).toBe("custom");
  });
});

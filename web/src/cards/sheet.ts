/** Sheet sizes offered for printing, in millimetres ("custom" takes typed values). */
export const SHEET_PRESETS = [
  { value: "297x420", label: "A3 vertical (297×420 mm)" },
  { value: "420x297", label: "A3 horizontal (420×297 mm)" },
  { value: "210x297", label: "A4 vertical (210×297 mm)" },
  { value: "216x279", label: "Carta (216×279 mm)" },
  { value: "216x330", label: "Oficio (216×330 mm)" },
  { value: "100x100", label: "1 tarjeta por hoja (100×100 mm)" },
  { value: "custom", label: "Medida personalizada (rollo / pliego)" },
] as const;

export type SheetSize = { w: number; h: number; single: boolean };
export type SheetLayout = { cols: number; rows: number; cap: number; pages: number; fits: boolean };

/** Sheet size in mm for a preset; "custom" uses the typed width and height. */
export function sheetPresetSize(preset: string, customW: number, customH: number): SheetSize {
  if (preset === "custom") return { w: customW, h: customH, single: false };
  const [w = 0, h = 0] = preset.split("x").map(Number);
  return { w, h, single: preset === "100x100" };
}

/** The preset whose size is exactly w×h, or "custom" when none is. */
export function presetForSize(w: number, h: number, presets: readonly string[]): string {
  return presets.find((p) => p === `${w}x${h}`) ?? "custom";
}

/**
 * How many 100 mm cards fit, as columns and rows from the top-left
 * margin. Never centred: the unused part of a sheet stays in one piece.
 */
export function computeSheetLayout(w: number, h: number, margin: number, gap: number, count: number): SheetLayout {
  const card = 100;
  const fits = w - 2 * margin + gap >= card + gap && h - 2 * margin + gap >= card + gap;
  const cols = Math.max(1, Math.floor((w - 2 * margin + gap) / (card + gap)));
  const rows = Math.max(1, Math.floor((h - 2 * margin + gap) / (card + gap)));
  const cap = cols * rows;
  return { cols, rows, cap, pages: Math.max(1, Math.ceil(count / cap)), fits };
}

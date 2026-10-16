import { describe, it, expect } from "vitest";
import { csvCell, toCsv } from "../../src/utils/csv";

// ---------------------------------------------------------------------------
// The shared CSV writer.
//
// Two files go through it: the designer's print sheet and the owner's feedback
// export. The second one carries text a customer typed into a public form, so
// the tests are as much about what a spreadsheet does with a cell as about
// whether the commas line up.
// ---------------------------------------------------------------------------

/**
 * A minimal RFC 4180 reader, enough to prove the writer round-trips.
 *
 * Written here rather than imported because the point is to check the output
 * against the format, not against another copy of the same assumptions.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  return rows;
}

describe("csvCell — quoting", () => {
  it("leaves a plain value alone", () => {
    expect(csvCell("Mesa 4")).toBe("Mesa 4");
  });

  it("quotes a value holding a comma", () => {
    expect(csvCell("good, but slow")).toBe('"good, but slow"');
  });

  it("doubles an inner quote", () => {
    expect(csvCell('the "special" was cold')).toBe('"the ""special"" was cold"');
  });

  it("quotes a value holding a newline", () => {
    expect(csvCell("line one\nline two")).toBe('"line one\nline two"');
  });

  it("writes null and undefined as an empty cell", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });
});

describe("csvCell — formula injection", () => {
  // A customer comment is opened in Excel by the owner. A cell beginning with
  // one of these is evaluated as a formula, so the owner's spreadsheet would be
  // running whatever a stranger typed into a public form.
  it.each(["=", "+", "-", "@", "\t", "\r"])("neutralises a value starting with %j", (lead) => {
    const out = csvCell(`${lead}HYPERLINK("http://evil.example","click")`);
    // Whatever the quoting, the first character the spreadsheet sees inside the
    // cell must be the apostrophe, not the trigger.
    const inner = out.startsWith('"') ? out.slice(1) : out;
    expect(inner.startsWith("'")).toBe(true);
  });

  it("still quotes a neutralised value that holds a comma", () => {
    expect(csvCell("=1+1,2")).toBe(`"'=1+1,2"`);
  });

  it("leaves a trigger character in the middle of a value alone", () => {
    expect(csvCell("4-5 stars")).toBe("4-5 stars");
    expect(csvCell("a@b.c")).toBe("a@b.c");
  });
});

describe("toCsv", () => {
  it("ends every line with a newline, including the last", () => {
    const out = toCsv(["a", "b"], [["1", "2"]]);
    expect(out).toBe("a,b\n1,2\n");
  });

  it("writes only the header when there are no rows", () => {
    expect(toCsv(["a", "b"], [])).toBe("a,b\n");
  });

  it("round-trips commas, quotes and newlines", () => {
    const rows = [
      ["Mesa 1", 'she said "fine", then left'],
      ["Terraza", "first line\nsecond line"],
    ];
    const parsed = parseCsv(toCsv(["location", "comment"], rows));
    expect(parsed).toEqual([["location", "comment"], ...rows]);
  });
});

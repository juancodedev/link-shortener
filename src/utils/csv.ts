/**
 * CSV writing, shared.
 *
 * Existed first inside the print-sheet builder and got a second hand-rolled
 * copy when the feedback export needed one. Two implementations of "quote a cell
 * when it holds a comma" is two places to forget, and the failure is not loud: a
 * comma in a value shifts every later column, the file still opens, and whoever
 * reads it concludes the data is wrong rather than the escaping is.
 */

/**
 * Quotes a value when it would otherwise move a column boundary.
 *
 * Doubles an inner quote, which is how CSV escapes one. Done on every value
 * rather than only the ones that look risky, because a value that cannot be
 * predicted at write time — a customer comment, an address — is exactly the one
 * that will contain something.
 *
 * FORMULA INJECTION
 *
 * The feedback export carries text a stranger typed into a public form, and
 * the person who opens it does so in Excel or Sheets. Both evaluate a cell that
 * begins with `=`, `+`, `-` or `@` as a formula — and a leading tab or carriage
 * return can smuggle one past a naive check — so `=HYPERLINK(...)` in a comment
 * becomes a clickable link in the owner's spreadsheet, and worse formulas than
 * that exist. Quoting does not help: the quotes are CSV syntax, stripped before
 * the spreadsheet looks at the value.
 *
 * The fix is OWASP's: prefix such a value with an apostrophe, which every
 * spreadsheet reads as "this is text". Applied here, to every cell, rather than
 * at the feedback call site, because the next export to pass user text through
 * this writer should not have to remember. The cost is a visible `'` before a
 * value that really did begin with a minus — a negative number, say. A wrong
 * glyph in a cell is a far cheaper failure than a stranger's formula running
 * on the owner's machine.
 */
export function csvCell(value: string | null | undefined): string {
  const raw = value ?? "";
  const text = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Builds a CSV document from a header and rows.
 *
 * Lines end with `\n`, including the last one. A trailing newline is what makes
 * `wc -l`, `tail` and most spreadsheet importers treat the file as complete;
 * without it the final row reads as truncated to half the tools that open it.
 */
export function toCsv(header: string[], rows: string[][]): string {
  const lines = [header.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return `${lines.join("\n")}\n`;
}
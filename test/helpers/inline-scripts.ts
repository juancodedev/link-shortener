/**
 * Bodies of the inline `<script>` blocks of a served page, in document order.
 *
 * One shared extractor instead of a regex copied into each test file. The end
 * tag accepts whitespace and any case (`</script >`, `</SCRIPT>`), as a browser
 * does, and external scripts (`src=`) are skipped because their empty body is
 * not page code a test can run.
 */
const SCRIPT_BLOCK = /<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi;

export function inlineScripts(html: string): string[] {
  return [...html.matchAll(SCRIPT_BLOCK)]
    .filter((m) => !/\bsrc\s*=/i.test(m[1] ?? ""))
    .map((m) => m[2] ?? "");
}

/**
 * Regular expression for validating schema names.
 * Only lowercase alphanumeric + underscore, must start with a letter.
 * This is defense-in-depth: schema names come from KV cache (populated
 * from public.tenants) or directly from parameterized DB queries, never
 * from raw user input. The regex blocks any injection payloads.
 */
const SCHEMA_NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Validates that a schema name matches the expected pattern.
 * Throws if validation fails — never fall through to SQL with unvalidated input.
 *
 * @param raw - The schema name to validate (from KV cache or public.tenants)
 * @returns The validated schema name (same string, typed as safe)
 * @throws If the schema name does not match the allowed pattern
 */
export function validateSchemaName(raw: string): string {
  if (!SCHEMA_NAME_RE.test(raw)) {
    throw new Error(
      `Invalid schema name: "${raw}". Expected pattern: ${SCHEMA_NAME_RE}`,
    );
  }
  return raw;
}

/**
 * Builds a fully-qualified, double-quoted table identifier.
 * Double-quoting prevents identifier injection and handles reserved words.
 *
 * @example
 * qualifyTable("tenant_a7f3", "links")  // => `"tenant_a7f3"."links"`
 */
export function qualifyTable(schema: string, table: string): string {
  const safe = validateSchemaName(schema);
  return `"${safe}"."${table}"`;
}

/**
 * Replaces `{schema}` placeholders in a SQL template with a validated,
 * double-quoted schema name. Throws if schema validation fails.
 *
 * @example
 * buildQuery("tenant_a7f3", "SELECT * FROM {schema}.links WHERE short_code = $1")
 * // => `SELECT * FROM "tenant_a7f3".links WHERE short_code = $1`
 */
export function buildQuery(schema: string, template: string): string {
  const safe = validateSchemaName(schema);
  return template.replace(/\{schema\}/g, `"${safe}"`);
}

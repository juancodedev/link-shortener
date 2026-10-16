/**
 * URL validation result.
 */
export interface UrlValidationResult {
  valid: boolean;
  error?:
    | "invalid_url"
    | "invalid_protocol"
    | "blocked_host"
    | "blocked_ip_range"
    | "url_too_long";
  /** Normalized URL: scheme lowercased, host lowercased, default port dropped. */
  normalized?: string;
}

/**
 * Slug validation result.
 */
export interface SlugValidationResult {
  valid: boolean;
  error?:
    | "invalid_slug"
    | "reserved_slug"
    | "slug_too_short"
    | "slug_too_long";
}

/**
 * Hostnames that are always blocked regardless of IP resolution.
 */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "[::1]",
  "::1",
]);

/**
 * Reserved subdomain slugs that cannot be claimed by tenants.
 */
const RESERVED_SLUGS = new Set([
  "admin",
  "api",
  "www",
  "app",
  "dashboard",
  "settings",
  "billing",
  "support",
  "help",
  "docs",
  "blog",
  "status",
  "login",
  "signup",
  "register",
  "auth",
  "root",
  "system",
  "tenant",
  "tenants",
]);

/** Maximum allowed URL length in characters. */
const MAX_URL_LENGTH = 2048;

/** Slug regex: 3-30 chars, alphanumeric + hyphens, must start and end with alphanumeric. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

/**
 * URI scheme prefix per RFC 3986: `ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`
 * followed by a colon.
 *
 * Anchored at the start and deliberately independent of `//`, so schemes written
 * without slashes (`javascript:`, `data:`, `mailto:`, `tel:`) are detected too.
 * Anchoring also prevents a colon later in the string from being read as a
 * scheme: `foo/bar:baz` fails at the `/` and is treated as scheme-less.
 */
const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+\-.]*):/;

/**
 * Checks if a string is a numeric IPv4 address that must not be used as a
 * redirect target.
 *
 * Covers:
 * - 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 — RFC 1918 private space
 * - 127.0.0.0/8 — loopback, as a bare address (`http://127.0.0.1` is also
 *   caught by hostname, but `http://127.0.0.53` and friends are not)
 * - 169.254.0.0/16 — link-local, which carries the cloud instance metadata
 *   endpoint (169.254.169.254) on every major cloud provider
 *
 * Returns a single `blocked_ip_range` code for all of them. The check is
 * hygiene rather than SSRF defence: nothing in this codebase ever fetches the
 * target, it only becomes a `Location` header the visitor's browser follows.
 */
function isPrivateIPv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;

  const octets = parts.map((p) => parseInt(p, 10));
  if (octets.some((o) => isNaN(o) || o < 0 || o > 255)) return false;

  const [first, second] = octets;
  // 10.0.0.0/8
  if (first === 10) return true;
  // 172.16.0.0/12
  if (first === 172 && second! >= 16 && second! <= 31) return true;
  // 192.168.0.0/16
  if (first === 192 && second === 168) return true;
  // 127.0.0.0/8 loopback
  if (first === 127) return true;
  // 169.254.0.0/16 link-local, incl. the cloud metadata endpoint
  if (first === 169 && second === 254) return true;

  return false;
}

/**
 * Validates a URL for use as a redirect target.
 *
 * Checks performed, in order:
 * 1. Must not exceed 2048 characters
 * 2. Must carry an explicit URI scheme — no scheme is rejected, never inferred
 * 3. Must parse as a valid URL
 * 4. Protocol must be http: or https: only
 * 5. Hostname must not be localhost or loopback
 * 6. Hostname must not be a private IP address
 *
 * Scheme detection runs *before* parsing and never prepends a protocol. An
 * earlier version auto-prepended `https://` to any input lacking `://`, which
 * promoted arbitrary strings — `//evil.com`, `not-a-url` — to trusted hosts and
 * mangled `javascript:`/`data:` into unparseable `https://javascript:...` strings,
 * making the protocol allowlist unreachable for exactly the payloads it exists
 * to reject.
 */
export function validateUrl(raw: string): UrlValidationResult {
  const input = raw.trim();
  if (input.length > MAX_URL_LENGTH) {
    return { valid: false, error: "url_too_long" };
  }

  // An explicit protocol is mandatory. Catching this here — before parsing —
  // means `//evil.com`, `not-a-url` and `google.com/maps` are rejected outright
  // instead of being rewritten into an https:// URL that skips every check.
  const schemeMatch = SCHEME_RE.exec(input);
  if (!schemeMatch) {
    return { valid: false, error: "invalid_url" };
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { valid: false, error: "invalid_url" };
  }

  // Only allow http and https. Compared case-insensitively: RFC 3986 schemes are
  // case-insensitive, so HTTPS:// is as valid as https://.
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") {
    return { valid: false, error: "invalid_protocol" };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost and loopback addresses
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { valid: false, error: "blocked_host" };
  }

  // Block private IP ranges
  if (isPrivateIPv4(hostname)) {
    return { valid: false, error: "blocked_ip_range" };
  }

  return { valid: true, normalized: parsed.href };
}

/**
 * Validates a tenant subdomain slug.
 *
 * Checks performed:
 * 1. Must match regex: 3-30 chars, lowercase alphanumeric + hyphens only
 * 2. Must not be a reserved word
 */
export function validateSlug(raw: string): SlugValidationResult {
  if (raw.length < 3) {
    return { valid: false, error: "slug_too_short" };
  }
  if (raw.length > 30) {
    return { valid: false, error: "slug_too_long" };
  }
  if (!SLUG_RE.test(raw)) {
    return { valid: false, error: "invalid_slug" };
  }
  if (RESERVED_SLUGS.has(raw.toLowerCase())) {
    return { valid: false, error: "reserved_slug" };
  }
  return { valid: true };
}

/** Canonical 8-4-4-4-12 hex UUID, any version, case-insensitive. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a string is a UUID, as Postgres's `uuid` type would accept it in
 * canonical form.
 *
 * Checked before a query rather than left to the database: a malformed id
 * bound to a `uuid` column is a 22P02 cast error, which surfaces as a 500 for
 * what is plainly a bad request.
 */
export function isUuid(raw: string): boolean {
  return UUID_RE.test(raw);
}

/**
 * Sanitizes user input by trimming whitespace and truncating to maxLen.
 * Used for display_name, title, and other text fields.
 */
export function sanitizeInput(raw: string, maxLen: number): string {
  return raw.trim().slice(0, maxLen);
}

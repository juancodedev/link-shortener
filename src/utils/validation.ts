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
 * Checks if a string is a numeric IPv4 address in a private range.
 * Private ranges: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
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

  return false;
}

/**
 * Validates a URL for use as a redirect target.
 *
 * Checks performed:
 * 1. Must parse as a valid URL
 * 2. Protocol must be http: or https: only
 * 3. Hostname must not be localhost or loopback
 * 4. Hostname must not be a private IP address
 * 5. URL must not exceed 2048 characters
 */
export function validateUrl(raw: string): UrlValidationResult {
  if (raw.length > MAX_URL_LENGTH) {
    return { valid: false, error: "url_too_long" };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { valid: false, error: "invalid_url" };
  }

  // Only allow http and https
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
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

  return { valid: true };
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

/**
 * Sanitizes user input by trimming whitespace and truncating to maxLen.
 * Used for display_name, title, and other text fields.
 */
export function sanitizeInput(raw: string, maxLen: number): string {
  return raw.trim().slice(0, maxLen);
}

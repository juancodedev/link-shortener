import type { AppEnv } from "../types/env";
import { withClient } from "../db/client";
import { qualifyTable } from "../db/schema";
import { hashIp } from "../utils/ip-hash";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrackClickParams {
  /** UUID of the tenant in `public.tenants`. */
  tenantId: string;
  /** Per-tenant schema name (e.g., 'tenant_a7f3d2b1'). */
  schemaName: string;
  /** UUID of the link row. */
  linkId: string;
  /** The short code that was resolved. */
  shortCode: string;
  /** The incoming Worker request (for header extraction). */
  request: Request;
  /** Per-tenant salt for IP hashing (REQ-A002). */
  tenantSalt: string;
}

// ---------------------------------------------------------------------------
// User-Agent parser (minimal — no external deps)
// ---------------------------------------------------------------------------

interface UaSummary {
  browser: string;
  os: string;
}

/**
 * Extracts browser name + version and operating system from a User-Agent
 * string. Returns a compact summary string like "Chrome 125 / macOS".
 *
 * Covers the most common browsers and OSes. Unrecognized UAs return
 * "Unknown Browser / Unknown OS".
 */
function parseUserAgent(ua: string): string {
  const summary = extractUa(ua);
  return `${summary.browser} / ${summary.os}`;
}

function extractUa(ua: string): UaSummary {
  let browser = "Unknown Browser";
  let os = "Unknown OS";

  // --- Browser detection (order matters for edge cases) ---
  if (ua.includes("Edg/")) {
    const ver = ua.match(/Edg\/([\d.]+)/)?.[1];
    browser = ver ? `Edge ${ver}` : "Edge";
  } else if (ua.includes("OPR/") || ua.includes("Opera/")) {
    const ver = ua.match(/(?:OPR|Opera)\/([\d.]+)/)?.[1];
    browser = ver ? `Opera ${ver}` : "Opera";
  } else if (ua.includes("Chrome/")) {
    const ver = ua.match(/Chrome\/([\d.]+)/)?.[1];
    browser = ver ? `Chrome ${ver}` : "Chrome";
  } else if (ua.includes("Safari/") && !ua.includes("Chrome")) {
    const ver = ua.match(/Version\/([\d.]+)/)?.[1];
    browser = ver ? `Safari ${ver}` : "Safari";
  } else if (ua.includes("Firefox/")) {
    const ver = ua.match(/Firefox\/([\d.]+)/)?.[1];
    browser = ver ? `Firefox ${ver}` : "Firefox";
  }

  // --- OS detection ---
  if (ua.includes("Windows NT 10")) os = "Windows 10/11";
  else if (ua.includes("Windows NT 6.3")) os = "Windows 8.1";
  else if (ua.includes("Windows NT 6.1")) os = "Windows 7";
  else if (ua.includes("Windows")) os = "Windows";
  else if (ua.includes("Mac OS X") || ua.includes("macOS")) {
    const ver = ua.match(/Mac OS X (\d+[._]\d+)/)?.[1];
    os = ver ? `macOS ${ver.replace("_", ".")}` : "macOS";
  } else if (ua.includes("Android")) {
    const ver = ua.match(/Android ([\d.]+)/)?.[1];
    os = ver ? `Android ${ver}` : "Android";
  } else if (ua.includes("iPhone") || ua.includes("iPad")) {
    os = "iOS";
  } else if (ua.includes("Linux")) {
    os = "Linux";
  } else if (ua.includes("CrOS")) {
    os = "ChromeOS";
  }

  return { browser, os };
}

/**
 * Detects device type with CF-Device-Type as primary, UA parsing as fallback.
 */
function detectDeviceType(request: Request): string {
  // 1. Cloudflare's built-in detection
  const cfDevice = request.headers.get("CF-Device-Type");
  if (cfDevice === "mobile") return "Mobile";
  if (cfDevice === "tablet") return "Tablet";
  if (cfDevice === "desktop") return "Desktop";

  // 2. Fallback: User-Agent parsing
  const ua = request.headers.get("User-Agent") ?? "";
  if (ua.includes("iPad") || (ua.includes("Android") && !ua.includes("Mobile"))) {
    return "Tablet";
  }
  if (ua.includes("Mobile") || ua.includes("iPhone") || ua.includes("Android")) {
    return "Mobile";
  }
  return "Desktop";
}

// ---------------------------------------------------------------------------
// Header extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the referrer with query parameters stripped.
 * Returns null if the Referer header is absent.
 */
function extractReferrer(request: Request): string | null {
  const ref = request.headers.get("Referer");
  if (!ref) return null;

  try {
    const url = new URL(ref);
    return url.origin + url.pathname;
  } catch {
    // Malformed referrer — store null
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main tracker
// ---------------------------------------------------------------------------

/**
 * Records a click event asynchronously.
 *
 * This function is designed to be called via `ctx.waitUntil()` — it is NEVER
 * awaited inline on the critical path. All errors are caught internally,
 * logged as structured JSON, and never propagated.
 *
 * Actions performed:
 * 1. Extract Cloudflare headers (IP, country, device type)
 * 2. Parse User-Agent → summary string (no raw UA stored)
 * 3. Extract Referer → strip query params
 * 4. Hash IP via SHA-256 with per-tenant salt
 * 5. INSERT into `analytics.link_clicks`
 * 6. UPDATE `{schema}.links SET clicks_count = clicks_count + 1`
 */
export async function trackClick(
  env: AppEnv,
  params: TrackClickParams,
): Promise<void> {
  console.log(JSON.stringify({
    event: "tracker_called",
    tenant: params.tenantId,
    code: params.shortCode,
  }));

  try {
    const { tenantId, schemaName, linkId, shortCode, request } = params;

    // --- 1. Extract headers ---
    const ip = request.headers.get("CF-Connecting-IP");
    const country = request.headers.get("CF-IPCountry") ?? null;
    const deviceType = detectDeviceType(request);
    const userAgent = request.headers.get("User-Agent") ?? "";
    const referrer = extractReferrer(request);

    // --- 2. Parse User-Agent into summary ---
    const uaSummary = userAgent ? parseUserAgent(userAgent) : null;

    // --- 3. Hash IP with per-tenant salt (REQ-A002) ---
    const ipHash = await hashIp(ip, params.tenantSalt);

    // --- 4. INSERT into analytics.link_clicks ---
    await withClient(env, async (client) => {
      await client.query(
        `INSERT INTO analytics.link_clicks
           (tenant_id, link_id, ip_hash, user_agent_summary, device_type, country_code, referrer)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [tenantId, linkId, ipHash, uaSummary, deviceType, country, referrer],
      );

      // --- 5. Increment clicks_count atomically ---
      const table = qualifyTable(schemaName, "links");
      await client.query(
        `UPDATE ${table} SET clicks_count = clicks_count + 1 WHERE short_code = $1`,
        [shortCode],
      );
    });

    console.log(JSON.stringify({
      event: "click_tracked",
      tenant: tenantId,
      code: shortCode,
      country: country ?? "unknown",
    }));
  } catch (err) {
    // NEVER propagate — analytics failures must not affect the redirect
    console.error(
      JSON.stringify({
        event: "error",
        type: "analytics_failed",
        message: err instanceof Error ? err.message : String(err),
        tenant: params.tenantId,
        code: params.shortCode,
      }),
    );
    // Intentionally swallowed
  }
}

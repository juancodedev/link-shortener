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
 * Returns granular info: "Android Phone", "iPhone", "iPad", "Windows", "Mac", etc.
 */
function detectDeviceType(request: Request): string {
  const ua = request.headers.get("User-Agent") ?? "";

  // 1. Cloudflare's built-in detection
  const cfDevice = request.headers.get("CF-Device-Type");

  // 2. Specific device detection from User-Agent
  if (ua.includes("iPhone")) return "iPhone";
  if (ua.includes("iPad")) return "iPad";
  if (ua.includes("Android")) {
    if (cfDevice === "tablet" || ua.includes(" Tablet ")) return "Android Tablet";
    return "Android Phone";
  }

  // 3. Desktop
  if (cfDevice === "mobile") return "Mobile";
  if (cfDevice === "tablet") return "Tablet";

  if (ua.includes("Windows")) return "Windows";
  if (ua.includes("Mac OS") || ua.includes("macOS")) return "Mac";
  if (ua.includes("Linux") && !ua.includes("Android")) return "Linux";
  if (ua.includes("CrOS")) return "ChromeOS";

  return "Desktop";
}

/**
 * Detects the traffic source from the Referer header.
 * Categorizes into: Instagram, Facebook, WhatsApp, Twitter/X, LinkedIn,
 * Telegram, YouTube, Reddit, TikTok, Direct, or the domain name.
 */
function getReferrerSource(referrer: string | null): string {
  if (!referrer) return "Direct";

  try {
    const host = new URL(referrer).hostname.toLowerCase();

    if (host.includes("instagram.com") || host === "l.instagram.com") return "Instagram";
    if (host.includes("facebook.com") || host === "l.facebook.com" || host === "lm.facebook.com") return "Facebook";
    if (host.includes("whatsapp.com") || host === "wa.me") return "WhatsApp";
    if (host.includes("t.co") || host.includes("twitter.com") || host.includes("x.com")) return "Twitter/X";
    if (host.includes("linkedin.com")) return "LinkedIn";
    if (host.includes("t.me") || host.includes("telegram.org")) return "Telegram";
    if (host.includes("youtube.com") || host.includes("youtu.be")) return "YouTube";
    if (host.includes("reddit.com")) return "Reddit";
    if (host.includes("tiktok.com")) return "TikTok";
    if (host.includes("tumblr.com")) return "Tumblr";
    if (host.includes("pinterest.com")) return "Pinterest";
    if (host.includes("discord.com")) return "Discord";
    if (host.includes("slack.com")) return "Slack";
    if (host.includes("github.com")) return "GitHub";
    if (host.includes("google.com")) return "Google";

    // Return the site name (strip www and TLD)
    return host.replace(/^www\./, "").split(".")[0]!;
  } catch {
    return "Unknown";
  }
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
    const referrerSource = getReferrerSource(referrer);

    // --- 2. Parse User-Agent into summary ---
    const uaSummary = userAgent ? parseUserAgent(userAgent) : null;

    // --- 3. Hash IP with per-tenant salt (REQ-A002) ---
    const ipHash = await hashIp(ip, params.tenantSalt);

    // --- 4. INSERT into analytics.link_clicks ---
    await withClient(env, async (client) => {
      try {
        await client.query(
          `INSERT INTO analytics.link_clicks
             (tenant_id, link_id, ip_hash, user_agent_summary, device_type, country_code, referrer, referrer_source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [tenantId, linkId, ipHash, uaSummary, deviceType, country, referrer, referrerSource],
        );
      } catch {
        // Column might not exist yet — fall back
        await client.query(
          `INSERT INTO analytics.link_clicks
             (tenant_id, link_id, ip_hash, user_agent_summary, device_type, country_code, referrer)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [tenantId, linkId, ipHash, uaSummary, deviceType, country, referrer],
        );
      }

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

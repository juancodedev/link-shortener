/**
 * Hashes an IP address using SHA-256 with a per-tenant salt.
 * Uses the Web Crypto API (available in Workers runtime).
 *
 * @param ip - The IP address to hash (from CF-Connecting-IP header)
 * @param salt - Per-tenant salt to prevent cross-tenant correlation
 * @returns 64-character lowercase hex digest, or null if ip is null/undefined
 */
export async function hashIp(
  ip: string | null,
  salt: string,
): Promise<string | null> {
  if (ip == null) return null;

  const data = new TextEncoder().encode(ip + salt);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);

  // Convert to hex string
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

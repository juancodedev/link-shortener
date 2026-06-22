import { customAlphabet } from "nanoid";

/**
 * URL-safe alphabet with ambiguous characters removed:
 * - 0 (zero) and O (capital o)
 * - I (capital i) and 1 (one) and l (lowercase L)
 *
 * 54 characters total. At length 7: ~54^7 ≈ 1.5 trillion combinations
 * — sufficient for per-tenant uniqueness.
 */
const ALPHABET =
  "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const nanoid = customAlphabet(ALPHABET, 7);

/**
 * Generates a URL-safe 7-character short code.
 * Uses cryptographically secure random values via nanoid.
 * Uniqueness is enforced per-tenant schema (UNIQUE constraint + retry on insert).
 */
export function generateShortCode(): string {
  return nanoid();
}

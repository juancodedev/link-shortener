import type { MiddlewareHandler } from "hono";
import { errors, jwtVerify } from "jose";
import type { AppEnv, HonoVars } from "../types/env";

/** Supabase issues access tokens for the `authenticated` role. */
const AUDIENCE = "authenticated";

/**
 * True when local verification produced a verdict that no network call can change.
 *
 * The distinction matters because the middleware falls back to the Supabase Auth
 * API when local verification fails, and that fallback exists so a deployment
 * with a wrong or stale `SUPABASE_JWT_SECRET` does not lock out every real user.
 * Falling back on *every* failure would restore that lockout risk only partially,
 * and worse, it would turn an attacker spamming garbage tokens into a stream of
 * real network calls against the project's Supabase quota.
 *
 * So the failures are split:
 *
 * - **Definitive** — the token is expired, has the wrong audience, or is
 *   structurally malformed. None of those can be caused by a bad secret, so
 *   they reject immediately.
 * - **Ambiguous** — the signature does not verify. That is what a bad secret
 *   looks like, and also what a forged token looks like. The Auth API gets the
 *   final say, and only for tokens that got that far.
 */
function isDefinitiveRejection(err: unknown): boolean {
  return (
    err instanceof errors.JWTExpired ||
    err instanceof errors.JWTClaimValidationFailed ||
    err instanceof errors.JWSInvalid ||
    err instanceof errors.JWTInvalid
  );
}

function logAuthError(type: string, message: string): void {
  console.error(JSON.stringify({ event: "error", type, message }));
}

/**
 * JWT authentication middleware.
 *
 * Verifies the Supabase access token locally with HS256 against
 * `SUPABASE_JWT_SECRET`, which costs no network round trip. When the secret is
 * not configured, or when local verification fails ambiguously, it falls back to
 * the Supabase Auth API (`GET /auth/v1/user`) — the behaviour this middleware
 * had before local verification existed, and the safety net that keeps a
 * misconfigured secret from becoming a total lockout.
 *
 * On success: c.set('user', { userId, email })
 * On failure: 401 with the same structured JSON error shape as before.
 */
export const auth: MiddlewareHandler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c, next) => {
  const authHeader = c.req.header("Authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "unauthenticated" }, 401);
  }

  const token = authHeader.slice(7);

  // --- 1. Local verification (no network hop on the common path) ---
  const secret = c.env.SUPABASE_JWT_SECRET;
  if (secret) {
    try {
      const { payload } = await jwtVerify(
        token,
        new TextEncoder().encode(secret),
        { audience: AUDIENCE },
      );

      const userId = payload.sub;
      if (!userId) {
        logAuthError("jwt_missing_subject", "Access token carries no sub claim");
        return c.json({ error: "unauthenticated" }, 401);
      }

      c.set("user", {
        userId,
        email: typeof payload.email === "string" ? payload.email : "",
      });

      await next();
      return;
    } catch (err) {
      if (isDefinitiveRejection(err)) {
        logAuthError(
          "jwt_verification_rejected",
          err instanceof Error ? err.message : String(err),
        );
        return c.json({ error: "unauthenticated" }, 401);
      }
      // Ambiguous (typically a signature mismatch). Fall through to the Auth API
      // rather than rejecting: a stale or wrong secret must not lock out users.
    }
  }

  // --- 2. Fallback: validate against the Supabase Auth API ---
  try {
    const res = await fetch(`${c.env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: c.env.SUPABASE_ANON_KEY,
      },
    });

    if (!res.ok) {
      throw new Error(`Auth API returned ${res.status}`);
    }

    const user = await res.json() as { id: string; email?: string };

    if (!user.id) {
      throw new Error("Invalid user response");
    }

    c.set("user", {
      userId: user.id,
      email: user.email ?? "",
    });

    await next();
    return;
  } catch (err) {
    logAuthError(
      "jwt_verification_failed",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "unauthenticated" }, 401);
  }
};
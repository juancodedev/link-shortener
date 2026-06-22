import type { MiddlewareHandler } from "hono";
import { jwtVerify, createRemoteJWKSet } from "jose";
import type { AppEnv, HonoVars } from "../types/env";

/**
 * JWT authentication middleware.
 *
 * Validates Supabase JWTs using the JWKS (JSON Web Key Set) endpoint.
 * This supports both HS256 and ES256/RS256 algorithms — Supabase projects
 * may use either. The remote JWK set is cached and automatically rotated.
 *
 * On success: c.set('user', { userId, email })
 * On failure: 401 with structured JSON error
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

  try {
    // Use remote JWKS for ES256/RS256; falls back to local secret for HS256
    const JWKS = createRemoteJWKSet(
      new URL(`${c.env.SUPABASE_URL}/auth/v1/jwks`),
    );

    const { payload } = await jwtVerify(token, JWKS, {
      audience: "authenticated",
      issuer: `${c.env.SUPABASE_URL}/auth/v1`,
      clockTolerance: 5,
    });

    if (!payload.sub) {
      console.error(JSON.stringify({
        event: "error", type: "jwt_invalid", message: "JWT missing sub claim",
      }));
      return c.json({ error: "unauthenticated" }, 401);
    }

    c.set("user", {
      userId: payload.sub,
      email: (payload.email as string) ?? "",
    });

    await next();
    return;
  } catch (err) {
    console.error(JSON.stringify({
      event: "error", type: "jwt_verification_failed",
      message: err instanceof Error ? err.message : String(err),
    }));
    return c.json({ error: "unauthenticated" }, 401);
  }
};

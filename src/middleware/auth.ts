import type { MiddlewareHandler } from "hono";
import { jwtVerify } from "jose";
import type { AppEnv, HonoVars } from "../types/env";

/**
 * JWT authentication middleware.
 *
 * Extracts and verifies a Supabase JWT from the `Authorization: Bearer <token>`
 * header. On success, sets `c.set('user', { userId, email })`. On failure
 * (missing header, invalid/expired token, wrong audience), returns 401 with
 * structured JSON error.
 *
 * This middleware is applied only to authenticated routes (`/api/*`) by the
 * router in Phase 6. Public routes (`GET /`, `GET /r/*`) skip it entirely.
 */
export const auth: MiddlewareHandler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c, next) => {
  const authHeader = c.req.header("Authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "unauthenticated" }, 401);
  }

  const token = authHeader.slice(7); // Remove "Bearer " prefix

  try {
    const secret = new TextEncoder().encode(c.env.SUPABASE_JWT_SECRET);

    const { payload } = await jwtVerify(token, secret, {
      audience: "authenticated",
      clockTolerance: 5, // Allow 5 seconds of clock skew
    });

    // Validate required claims
    if (!payload.sub) {
      console.error(
        JSON.stringify({
          event: "error",
          type: "jwt_invalid",
          message: "JWT missing sub claim",
        }),
      );
      return c.json({ error: "unauthenticated" }, 401);
    }

    c.set("user", {
      userId: payload.sub,
      email: (payload.email as string) ?? "",
    });

    await next();
    return;
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "error",
        type: "jwt_verification_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return c.json({ error: "unauthenticated" }, 401);
  }
};

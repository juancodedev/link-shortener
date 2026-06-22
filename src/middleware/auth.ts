import type { MiddlewareHandler } from "hono";
import type { AppEnv, HonoVars } from "../types/env";

/**
 * JWT authentication middleware.
 *
 * Validates Supabase access tokens by calling the Supabase Auth API
 * (GET /auth/v1/user). This avoids the need for local cryptographic
 * verification and supports all signing algorithms.
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
    // Validate token by calling Supabase Auth API
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
    console.error(JSON.stringify({
      event: "error", type: "jwt_verification_failed",
      message: err instanceof Error ? err.message : String(err),
    }));
    return c.json({ error: "unauthenticated" }, 401);
  }
};

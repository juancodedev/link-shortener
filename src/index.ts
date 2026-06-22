import type { AppEnv } from "./types/env";
import { createApp } from "./router";

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

/**
 * Cloudflare Worker default fetch handler.
 *
 * Lifecycle per request:
 * 1. Structured JSON request log (REQ-O001)
 * 2. Instantiate Hono app with current environment bindings
 * 3. Route through Hono (middleware → handlers → error boundary)
 * 4. Global uncaught error boundary catches anything Hono doesn't
 */
const handler = {
  async fetch(
    request: Request,
    env: AppEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // Structured request logging (REQ-O001)
    const url = new URL(request.url);
    console.log(
      JSON.stringify({
        event: "request",
        method: request.method,
        path: url.pathname,
        timestamp: Date.now(),
      }),
    );

    try {
      const app = createApp(env);
      return await app.fetch(request, env, ctx);
    } catch (err) {
      // Global uncaught error boundary — should only catch errors that escape
      // Hono's internal error handling (e.g., errors during app initialization)
      console.error(
        JSON.stringify({
          event: "error",
          type: "uncaught_exception",
          message: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        }),
      );
      return new Response(
        JSON.stringify({ error: "internal_error", code: "internal_error" }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  },
};

export default handler;

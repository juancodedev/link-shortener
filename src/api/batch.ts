import type { Handler } from "hono";
import type { AppEnv, HonoVars } from "../types/env";
import { mapError } from "../middleware/error";
import { ValidationError } from "../middleware/error";
import { createLinkCore } from "./links";

/**
 * Largest batch accepted in one request (T3.3).
 *
 * Every item is a synchronous create, so an unbounded array is an unbounded
 * number of database round trips inside a single Worker invocation — a request
 * that would simply time out, taking the items already created with it.
 */
export const MAX_BATCH_SIZE = 100;

/** One outcome per input item, positionally aligned with the request. */
export interface BatchItemResult {
  index: number;
  status: number;
  link?: unknown;
  error?: string;
  code?: string;
}

export const createLinksBatch: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  const tenant = c.get("tenant");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError("Invalid JSON body", "invalid_request");
  }

  const links = (body as { links?: unknown } | null)?.links;
  if (!Array.isArray(links)) {
    throw new ValidationError("links must be an array", "invalid_request");
  }
  if (links.length === 0) {
    throw new ValidationError("links must not be empty", "invalid_request");
  }
  if (links.length > MAX_BATCH_SIZE) {
    throw new ValidationError(
      `links must contain at most ${MAX_BATCH_SIZE} items`,
      "invalid_request",
    );
  }

  const results: BatchItemResult[] = [];

  for (const [index, item] of links.entries()) {
    try {
      const link = await createLinkCore({
        env: c.env,
        tenant,
        waitUntil: (p) => c.executionCtx.waitUntil(p),
        input: (item ?? {}) as any,
      });
      results.push({ index, status: 201, link });
    } catch (err) {
      const mapped = mapError(err);
      results.push({
        index,
        status: mapped.status,
        error: mapped.body.error,
        code: mapped.body.code,
      });
    }
  }

  const created = results.filter((r) => r.status === 201).length;

  return c.json(
    { results, created, failed: results.length - created },
    created === results.length ? 201 : 207,
  );
};
import type { Handler } from "hono";
import type { AppEnv, HonoVars } from "../types/env";
import { withClient } from "../db/client";
import { qualifyTable } from "../db/schema";
import { ValidationError } from "../middleware/error";
import { isUuid } from "../utils/validation";

// ---------------------------------------------------------------------------
// The print queue (odd/tasks/print-queue-cards.md S2-S3)
//
// A link is queued with PATCH /api/links/:id { print_queued: true } and leaves
// the queue with { print_queued: false }, when a destination is saved on it,
// or in a batch through POST /api/links/printed after the sheet is printed.
// The queue itself is the set of links with a non-NULL `print_queued_at`.
// ---------------------------------------------------------------------------

/** Most ids one "Mark as printed" may clear: several full A3 sheets. */
export const MAX_PRINTED_BATCH = 200;

interface QueueRow {
  id: string;
  short_code: string;
  print_queued_at: string;
}

/**
 * GET /api/links/print-queue — the links waiting to be printed, oldest first,
 * so cards come out in the order they were sent. Each carries the short URL
 * its QR must encode: never the destination, which can change after printing.
 */
export const listPrintQueue: Handler<{ Bindings: AppEnv; Variables: HonoVars }> = async (c) => {
  const table = qualifyTable(c.get("tenant").schemaName, "links");

  const rows = await withClient(c.env, async (client) => {
    const res = await client.query<QueueRow>(
      `SELECT id, short_code, print_queued_at
         FROM ${table}
        WHERE print_queued_at IS NOT NULL
        ORDER BY print_queued_at ASC, short_code ASC`,
    );
    return res.rows;
  });

  const domain = `https://${c.env.SHORT_URL_DOMAIN}`;
  return c.json(
    rows.map((r) => ({
      id: r.id,
      short_code: r.short_code,
      short_url: `${domain}/${r.short_code}`,
      print_queued_at: r.print_queued_at,
    })),
  );
};

/**
 * POST /api/links/printed { ids } — takes the printed links out of the queue.
 *
 * Ids that are not queued (already cleared, configured meanwhile, or another
 * tenant's) are simply not counted: `cleared` is what actually left the queue.
 */
export const markPrinted: Handler<{ Bindings: AppEnv; Variables: HonoVars }> = async (c) => {
  let body: { ids?: unknown };
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError("Invalid JSON body", "invalid_request");
  }

  const ids = body.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new ValidationError("ids must be a non-empty array", "invalid_request");
  }
  if (ids.length > MAX_PRINTED_BATCH) {
    throw new ValidationError(`ids must hold at most ${MAX_PRINTED_BATCH} entries`, "invalid_request");
  }
  if (!ids.every((id) => typeof id === "string" && isUuid(id))) {
    throw new ValidationError("every id must be a uuid", "invalid_request");
  }

  const table = qualifyTable(c.get("tenant").schemaName, "links");
  const cleared = await withClient(c.env, async (client) => {
    const res = await client.query<{ id: string }>(
      `UPDATE ${table}
          SET print_queued_at = NULL
        WHERE id = ANY($1::uuid[])
          AND print_queued_at IS NOT NULL
        RETURNING id`,
      [ids],
    );
    return res.rows.length;
  });

  return c.json({ cleared });
};

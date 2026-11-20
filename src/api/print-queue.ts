import type { Handler } from "hono";
import type { AppEnv, HonoVars } from "../types/env";
import { withClient } from "../db/client";
import { qualifyTable } from "../db/schema";
import { ValidationError } from "../middleware/error";
import { isUuid } from "../utils/validation";

// ---------------------------------------------------------------------------
// The print queue (odd/tasks/print-queue-cards.md S2-S3,
// odd/tasks/printed-cards-state.md S1-S5)
//
// A link is queued with PATCH /api/links/:id { print_queued: true } and leaves
// the queue with { print_queued: false }, when a destination is saved on it,
// or in a batch through POST /api/links/printed after the sheet is printed.
// The queue itself is the set of links with a non-NULL `print_queued_at`.
//
// The dashboard's queue lives in the page, so the batch call is what survives
// a reload: it stamps `printed_at` on the links it was given, which is the
// "this card was printed" the Links table shows.
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
 * POST /api/links/printed { ids } — records a print run.
 *
 * Stamps `printed_at = NOW()` on every link in the batch and clears any
 * `print_queued_at` left over from the old server-side queue. Printing is not
 * irreversible — a card gets lost or torn — so this only records the run: the
 * same link can be sent to print again and the date moves forward.
 *
 * The queue is page state now, so ids arrive without a queued flag in the
 * database; `where print_queued_at is not null` would match nothing. Ids that
 * do not exist (deleted, or another tenant's) are simply not counted:
 * `printed` is what actually changed.
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
  const printed = await withClient(c.env, async (client) => {
    const res = await client.query<{ id: string }>(
      `UPDATE ${table}
          SET printed_at = NOW(), print_queued_at = NULL
        WHERE id = ANY($1::uuid[])
        RETURNING id`,
      [ids],
    );
    return res.rows.length;
  });

  return c.json({ printed });
};

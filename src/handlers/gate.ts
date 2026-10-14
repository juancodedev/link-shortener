import type { Handler } from "hono";
import type { AppEnv, HonoVars } from "../types/env";
import { withClient } from "../db/client";
import { qualifyTable } from "../db/schema";
import { resolveRegistryEntry } from "../api/links";
import { renderFeedbackThanks } from "./action-screen";

// ---------------------------------------------------------------------------
// POST /api/gate
//
// Records what the customer chose on the dual-path action screen.
//
//   action_taken = 'google_redirect'    → { redirectUrl } so the browser can go
//   action_taken = 'internal_feedback'  → the thanks page
//
// WHAT THIS ENDPOINT MUST NEVER DO
//
// Condition the destination on anything the customer said. There is no code
// path here that withholds the Google URL, and none may be added: routing a
// customer away from the public review flow based on their sentiment is review
// gating, which Google prohibits, and it can cost the customer their reviews
// and their local badges. The rating is recorded as a sentiment signal and has
// no effect on what is returned.
//
// PUBLIC BY NECESSITY
//
// The person scanning a sticker is a customer of the business, not a user of
// this dashboard. Requiring a JWT here would mean the product cannot work.
// ---------------------------------------------------------------------------

/** Longest accepted comment. A body is not free storage. */
const MAX_COMMENT_LENGTH = 2000;

/** Longest accepted contact string. */
const MAX_CONTACT_LENGTH = 200;

const VALID_ACTIONS = new Set(["google_redirect", "internal_feedback"]);

interface GateInput {
  code: string;
  action: string;
  rating: number | null;
  comment: string;
  contact: string;
}

/**
 * Parses the request body. Accepts form encoding (the inline form) and JSON
 * (a scripted caller), and nothing else.
 *
 * A hand-rolled parse rather than `URLSearchParams` on a body stream, because
 * the handler reads the text once and wants the length capped before anything
 * downstream sees it.
 */
function parseBody(raw: string, contentType: string | undefined): GateInput | null {
  const params = new URLSearchParams(raw);

  // JSON callers send the same field names.
  if (contentType?.includes("application/json")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        code: typeof parsed.code === "string" ? parsed.code : "",
        action: typeof parsed.action_taken === "string" ? parsed.action_taken : "",
        rating: toRating(parsed.rating),
        comment: typeof parsed.comment === "string" ? parsed.comment : "",
        contact:
          typeof parsed.customer_contact === "string" ? parsed.customer_contact : "",
      };
    } catch {
      return null;
    }
  }

  return {
    code: params.get("code") ?? "",
    action: params.get("action_taken") ?? "",
    rating: toRating(params.get("rating")),
    comment: params.get("comment") ?? "",
    contact: params.get("customer_contact") ?? "",
  };
}

/** Coerces a rating to 1..5, or null. Anything else is rejected by the caller. */
function toRating(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 5) return NaN;
  return n;
}

export const gateHandler: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  let raw: string;
  try {
    raw = await c.req.text();
  } catch {
    return c.json({ error: "invalid_request", code: "invalid_request" }, 400);
  }

  const input = parseBody(raw, c.req.header("Content-Type"));
  if (!input) {
    return c.json({ error: "invalid_request", code: "invalid_request" }, 400);
  }

  // A NaN rating is the sentinel for "supplied but not a number in range".
  if (!input.code || !VALID_ACTIONS.has(input.action) || Number.isNaN(input.rating)) {
    return c.json({ error: "invalid_request", code: "invalid_request" }, 400);
  }
  if (input.comment.length > MAX_COMMENT_LENGTH) {
    return c.json({ error: "invalid_request", code: "invalid_request" }, 400);
  }
  if (input.contact.length > MAX_CONTACT_LENGTH) {
    return c.json({ error: "invalid_request", code: "invalid_request" }, 400);
  }
  // A private submission with no comment carries no information; accepting it
  // would inflate the feedback count with nothing behind it.
  if (input.action === "internal_feedback" && input.comment.trim().length === 0) {
    return c.json({ error: "invalid_request", code: "invalid_request" }, 400);
  }

  let entry: Awaited<ReturnType<typeof resolveRegistryEntry>>;
  try {
    entry = await resolveRegistryEntry(c.env, input.code);
  } catch {
    return c.json({ error: "service_unavailable", code: "service_unavailable" }, 503);
  }

  if (!entry) {
    return c.json({ error: "not_found", code: "not_found" }, 404);
  }

  const linkId = entry.linkId ?? "";

  // The rating row is written for both branches: it is what the derivation rate
  // and the sentiment gap are computed from. `action_taken` is the measured
  // fact; `rating` is the optional signal beside it.
  const record = async (): Promise<void> => {
    await withClient(c.env, async (client) => {
      await client.query(
        `INSERT INTO analytics.tag_ratings
           (tenant_id, link_id, location_id, rating, action_taken)
         VALUES ($1, $2, NULL, $3, $4)`,
        [entry.tenantId, linkId, input.rating, input.action],
      );

      if (input.action === "internal_feedback") {
        await client.query(
          `INSERT INTO analytics.tag_feedback
             (tenant_id, link_id, location_id, rating, comment, customer_contact)
           VALUES ($1, $2, NULL, $3, $4, $5)`,
          [
            entry.tenantId,
            linkId,
            input.rating,
            input.comment.trim(),
            input.contact.trim() || null,
          ],
        );
      }
    });
  };

  // Fire-and-forget: the customer must not wait on a database write to reach
  // Google. The same trade the click tracker already makes, and it inherits
  // the same accepted cost — an evicted Worker drops the event.
  c.executionCtx.waitUntil(
    record().catch((err: unknown) => {
      console.error(
        JSON.stringify({
          event: "error",
          type: "gate_record_failed",
          message: err instanceof Error ? err.message : String(err),
          tenant: entry!.subdomain,
          code: input.code,
        }),
      );
    }),
  );

  if (input.action === "google_redirect") {
    // Returned verbatim and unconditionally. Nothing the customer supplied can
    // reach this line and change the result.
    const destination = await destinationFor(c.env, entry, input.code);
    if (destination === null) {
      return c.json({ error: "not_found", code: "not_found" }, 404);
    }
    return c.json({ redirectUrl: destination }, 200);
  }

  return renderFeedbackThanks(entry.displayName || entry.subdomain);
};

/**
 * Reads the link's stored destination for the Google branch.
 *
 * The handler deliberately does not hold the destination across the request:
 * the action screen embedded it in the page, and this read exists so a caller
 * that never rendered the screen still gets a working URL.
 */
async function destinationFor(
  env: AppEnv,
  entry: { schemaName: string; linkId: string | null },
  code: string,
): Promise<string | null> {
  try {
    return await withClient(env, async (client) => {
      // qualifyTable, not raw interpolation: schema_name is the one identifier
      // that gets spliced into SQL anywhere in this codebase, and the repo's
      // own convention is to route it through the validating helper every time.
      const table = qualifyTable(entry.schemaName, "links");
      const res = await client.query<{ original_url: string }>(
        `SELECT original_url FROM ${table} WHERE short_code = $1 LIMIT 1`,
        [code],
      );
      return res.rows[0]?.original_url ?? null;
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "error",
        type: "gate_destination_failed",
        message: err instanceof Error ? err.message : String(err),
        code,
      }),
    );
    return null;
  }
}
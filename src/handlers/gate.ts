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

/** Longest accepted phone. Generous for spaces and a country prefix. */
const MAX_PHONE_LENGTH = 40;

const VALID_ACTIONS = new Set(["google_redirect", "internal_feedback"]);

/**
 * Bounds submissions per sticker per minute. Set in `wrangler.jsonc`.
 *
 * Sized against the busiest plausible minute of a single table, not against a
 * whole restaurant: a code is one sticker, and a rushed service might put a
 * dozen people through it inside one minute. Thirty leaves headroom without
 * letting one code fill the queue.
 *
 * This is volume control, not an integrity guarantee. A patient attacker who
 * stays under it is never slowed down. See `odd/tasks/local-business-links.md`
 * for what integrity would actually cost.
 */
const GATE_RATE_LIMIT = 30;

interface GateInput {
  code: string;
  action: string;
  rating: number | null;
  comment: string;
  /** The email, optional and secondary. Stored in `customer_contact`. */
  contact: string;
  /** The phone, optional but the recommended way to be called back. */
  phone: string;
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
        phone: typeof parsed.customer_phone === "string" ? parsed.customer_phone : "",
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
    phone: params.get("customer_phone") ?? "",
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
  if (input.phone.length > MAX_PHONE_LENGTH) {
    return c.json({ error: "invalid_request", code: "invalid_request" }, 400);
  }
  // A private submission with no comment carries no information; accepting it
  // would inflate the feedback count with nothing behind it.
  if (input.action === "internal_feedback" && input.comment.trim().length === 0) {
    return c.json({ error: "invalid_request", code: "invalid_request" }, 400);
  }

  // Volume guard, after validation and before any database work. A malformed
  // body never reaches the limiter, so junk cannot exhaust a real sticker's
  // budget; a flood of well-formed bodies is stopped before Postgres.
  //
  // Keyed on the CODE, not the IP. An IP key punishes the customer: a whole
  // restaurant sits behind one carrier-grade NAT, so per-IP limiting blocks
  // real people at the exact moment they are most likely to arrive together —
  // a full room at 21:00. The code is the resource being protected, and a
  // single code cannot exceed one table's worth of traffic.
  if (c.env.GATE_LIMITER) {
    let allowed: boolean;
    try {
      const { success } = await c.env.GATE_LIMITER.limit({ key: input.code });
      allowed = success;
    } catch {
      // Fail open. A limiter outage must not take the action screen down for
      // real customers; the cost is that a flood gets through during the
      // outage, which is strictly better than every customer being unable to
      // leave feedback.
      allowed = true;
    }

    if (!allowed) {
      // 429 rather than a silently-served success: the rating row is what the
      // owner's dashboard is computed from, and accepting the body while
      // discarding it would inflate nothing but still cost a database write.
      //
      // Note the Google branch is unaffected either way. The screen reaches
      // Google through a plain `<a href>`, and its POST is fire-and-forget with
      // the response discarded — so a rate-limited customer still reaches
      // Google, and refusing here costs the business a rating, not a review.
      //
      // The private form, by contrast, is a real navigation. Showing raw JSON to
      // someone who just typed a complaint is unacceptable, so a browser
      // `Accept: text/html` gets a page that explains what happened.
      return wantsHtml(c.req.header("Accept"))
        ? new Response(rateLimitedHtml(), {
            status: 429,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
            },
          })
        : c.json({ error: "rate_limited", code: "rate_limited" }, 429);
    }
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

  // Resolved BEFORE the rating row is written, because that row is what the
  // per-location rollup groups on. A link attached to a location records it; a
  // link with none records null and surfaces as "not assigned" rather than
  // vanishing.
  const locationId = await locationFor(c.env, entry, input.code);

  // The rating row is written for both branches: it is what the derivation rate
  // and the sentiment gap are computed from. `action_taken` is the measured
  // fact; `rating` is the optional signal beside it.
  const record = async (): Promise<void> => {
    await withClient(c.env, async (client) => {
      await client.query(
        `INSERT INTO analytics.tag_ratings
           (tenant_id, link_id, location_id, rating, action_taken)
         VALUES ($1, $2, $3, $4, $5)`,
        [entry.tenantId, linkId, locationId, input.rating, input.action],
      );

      if (input.action === "internal_feedback") {
        await client.query(
          `INSERT INTO analytics.tag_feedback
             (tenant_id, link_id, location_id, rating, comment, customer_contact, customer_phone)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            entry.tenantId,
            linkId,
            locationId,
            input.rating,
            input.comment.trim(),
            input.contact.trim() || null,
            input.phone.trim() || null,
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
/**
 * Reads the link's location so the scan can be attributed to a table or zone.
 *
 * Separate from `destinationFor` on purpose, even though both read the same
 * row. The Google branch never needs this, and a query it does not use is a
 * round trip it does not pay: a customer who taps "leave a review" is on the
 * happy path and should not wait on Postgres to learn something the answer
 * does not contain.
 *
 * Failure is swallowed and reported as null. A scan that cannot be attributed
 * is still a scan — recording it unattributed beats dropping it, which is
 * exactly how the rollup's totals drifted from the tenant-wide total before.
 */
async function locationFor(
  env: AppEnv,
  entry: { schemaName: string; subdomain: string },
  code: string,
): Promise<string | null> {
  try {
    return await withClient(env, async (client) => {
      const table = qualifyTable(entry.schemaName, "links");
      const res = await client.query<{ location_id: string | null }>(
        `SELECT location_id FROM ${table} WHERE short_code = $1 LIMIT 1`,
        [code],
      );
      return res.rows[0]?.location_id ?? null;
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "error",
        type: "gate_location_failed",
        message: err instanceof Error ? err.message : String(err),
        tenant: entry.subdomain,
        code,
      }),
    );
    return null;
  }
}

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
      // location_id rides along for the same reason: this is the link row for
      // the scanned code, and the location is what the scan gets attributed to.
      // It is already attached to the link — reading it here is what makes the
      // per-location rollup mean anything.
      const res = await client.query<{
        original_url: string | null;
        location_id: string | null;
      }>(
        `SELECT original_url, location_id FROM ${table} WHERE short_code = $1 LIMIT 1`,
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
/**
 * Whether this request is a real browser navigation rather than the
 * screen's fire-and-forget `fetch`.
 *
 * `fetch()` sends a wildcard Accept header; a top-level navigation sends
 * `text/html`. Only the latter needs to be given something readable.
 */
function wantsHtml(accept: string | undefined): boolean {
  return accept != null && accept.includes("text/html");
}

/**
 * Shown when the private-feedback form is submitted from an already-full
 * sticker. It must not read as an accusation: the customer did nothing wrong,
 * and a busy room is the normal cause.
 */
function rateLimitedHtml(): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Momentáneamente saturado</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 2rem 1.25rem;
         background: #f6f6f4; color: #1a1a1a; }
  main { max-width: 30rem; margin: 0 auto; background: #fff; border: 1px solid #e5e5e0;
         border-radius: 12px; padding: 1.75rem; }
  h1 { font-size: 1.15rem; margin: 0 0 .75rem; }
  p { font-size: .95rem; line-height: 1.55; margin: 0 0 .75rem; color: #3d3d3d; }
</style>
</head>
<body>
<main>
  <h1>Nos llegó demasiado feedback a la vez</h1>
  <p>Este punto recibió demasiados envíos en este momento. Tu comentario no se registró.</p>
  <p>Si querés que el local lo sepa, podés escribirles directamente.</p>
</main>
</body>
</html>`;
}

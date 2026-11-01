import type { Handler } from "hono";
import type { AppEnv, HonoVars } from "../types/env";
import { withClient } from "../db/client";
import { qualifyTable } from "../db/schema";
import { NotFoundError, ValidationError } from "../middleware/error";
import { isCardDesign, isCardVariant, renderReviewCard } from "../cards/render";

// ---------------------------------------------------------------------------
// GET /api/links/:id/card.svg?design=official|minimal&variant=hybrid|qr|nfc
//
// One 10×10 cm review card for one link (odd/tasks/print-queue-cards.md S4).
// The dashboard's Cards section fetches one per queued link and inlines it in
// the sheet, so the preview and the printed PDF are the same SVG. Defaults are
// the generator's own: the official design with QR + NFC.
// ---------------------------------------------------------------------------

export const linkCardSvg: Handler<{ Bindings: AppEnv; Variables: HonoVars }> = async (c) => {
  const design = c.req.query("design") ?? "official";
  const variant = c.req.query("variant") ?? "hybrid";
  if (!isCardDesign(design)) throw new ValidationError("design must be official or minimal", "invalid_request");
  if (!isCardVariant(variant)) throw new ValidationError("variant must be hybrid, qr or nfc", "invalid_request");

  const table = qualifyTable(c.get("tenant").schemaName, "links");
  const row = await withClient(c.env, async (client) => {
    const res = await client.query<{ short_code: string }>(
      `SELECT short_code FROM ${table} WHERE id = $1 LIMIT 1`,
      [c.req.param("id")],
    );
    return res.rows[0];
  });
  if (!row) throw new NotFoundError("Link not found", "not_found");

  const svg = renderReviewCard({
    shortUrl: `https://${c.env.SHORT_URL_DOMAIN}/${row.short_code}`,
    design,
    variant,
  });
  return new Response(svg, {
    status: 200,
    headers: { "Content-Type": "image/svg+xml; charset=utf-8" },
  });
};

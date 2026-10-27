# Locales and branches (Local → Sucursal → Links) + editable links

Objective: group links by business ("local") and its branches ("sucursales") so every comment can be traced to its local, branch and link; and let the operator edit a link's destination and review-screen choice from "Your Links".
Branch: `feat/business-branches` · Delivery: ask-on-risk · Runner: `pnpm test` (vitest), `pnpm typecheck`.

## Specs

- **S1 — Model.** "un mismo dueño, puede tener varias sucursales" / "lo ideal es poder agruparlos por "locales", donde un local puede tener una o mas sucursales y debe quedar en el mismo grupo". New `public.businesses` (local) per tenant; `public.locations` becomes the branch (sucursal) with a nullable `business_id`. Links keep pointing at a location. Operator-only: "el sistema lo administraré yo y los locales no veran esto".
- **S2 — API.** `GET/POST/PATCH /api/businesses` (name, is_active), tenant-scoped like `/api/locations`. Locations accept and return `business_id` (validated to belong to the tenant) and return `business_name`.
- **S3 — Dashboard: manage locales and branches.** Create a local, create branches inside it, see branches grouped under their local.
- **S4 — Dashboard: edit a link.** "donde sale Your Links (59/500), debo poder editar datos de los links, no el short code, si no la url, y si ese link va re dirigido directamente a google o a la pantalla de comentarios". Destination URL editable for any link (not only card stock); review-screen choice visible in the row and editable; branch assignable per link. Short code stays immutable.
- **S5 — Trace comments.** "como vinculo, a que link fue el comentario que se realizo?". Inbox shows Local · Sucursal · short code on every comment; filter by local and by branch. CSV appends `business` (appended, positional compatibility).

## Tasks

| ID | Specs | Route | Status | Commit |
|----|-------|-------|--------|--------|
| T1 | S1, S2 | inline | pending | — |
| T2 | S3 | inline | pending | — |
| T3 | S4 | inline | pending | — |
| T4 | S5 | inline | pending | — |

Route evidence: units share `src/handlers/dashboard.ts`, so no parallel writers. Risk: T1 is item 1 (migration: new table + column on `public.locations`) — own commit.

## Log

- **L1 (2026-10-27, user, verbatim):** "detalle, como vinculo, a que link fue el comentario que se realizo?, cada link, pueden ser de locales diferentes"
- **L2 (2026-10-27, user, verbatim):** "si, me referia a que un mismo dueño, puede tener varias sucursales / en este caso, como el sistema lo administraré yo y los locales no veran esto, lo ideal es poder agruparlos por "locales", donde un local puede tener una o mas sucursales y debe quedar en el mismo grupo"
- **L3 (2026-10-27, user, verbatim):** "Si avanza con eso / ademas, donde sale Your Links (59/500), debo poder editar datos de los links, no el short code, si no la url, y si ese link va re dirigido directamente a google o a la pantalla de comentarios, ya que es algo opcional que entregaré a quien les venda estos links"
- **L4 (analysis):** production has 1 tenant ("Cards", the operator), 1 location, 59 links. Comments already store `link_id` and `location_id`; the inbox showed location · client_ref but never the short code. Tenant-per-local rejected (separate schemas/subscriptions/dashboards for one operator). Feedback email stays per tenant for now (per-local is a later step).

# Review screen refresh, gate checkbox, full-width dashboard

Objective: refresh the customer review screen (Google-style stars, compliant), let the owner choose per link whether a scan shows that screen or goes straight to Google, and make the dashboard use the page width.
Branch: `feat/review-screen-refresh` · Delivery: ask-on-risk · Runner: `pnpm test` (vitest), `pnpm typecheck`.

## Specs

- **S1 — Gate checkbox in the dashboard.** "que desde el dashboard me permita el seleccionar , si quiero re dirigir a esta pagina, con un checkbox, si no esta seleccionado, por defecto debe enviar a la pagina de reseñas de google de forma directa". Maps to the existing `links.is_gated` flag. Present on the create form, on the bulk-cards modal, and editable per link in the row panel. Default unchecked everywhere (`is_gated: false` → plain 302 to the destination).
- **S2 — Review screen refresh, Google-reviews style.** "que sea una similar a las reseñas de google, donde aparecen las 5 estrellas a selecionar". COMPLIANT variant chosen by the user (L2): the star rating is recorded as a metric and NEVER decides what the customer sees. After any rating, both paths are shown: the Google button (always visible) and the private form.
- **S3 — Private form fields.** "el telefono recomendado como principal contacto, actualmente esta el email, este debe quedar como opcional y secundario, el orden actual esta bien, el mensaje, luego el metodo de contacto y el boton de enviar". Order: message → phone (primary, labelled recommended) → email (optional, secondary) → submit. Assumption: phone is recommended, not required.
- **S4 — Phone persisted.** New nullable `analytics.tag_feedback.customer_phone` (migration 00017); `/api/gate` accepts `customer_phone`; inbox and CSV show it. `customer_contact` keeps holding the email.
- **S5 — Dashboard full width.** "actualmente esta centrado y lo ideal que ocupe todo el ancho de la pagina". Wide container (~1400px cap) with a two-column grid on desktop: main column (links table, satisfaction, comments) and side column (create, bulk, feedback email). Stacks on mobile.

## Tasks

| ID | Specs | Route | Status | Commit |
|----|-------|-------|--------|--------|
| T1 | S4 | inline | done (RED 9 → GREEN) | 89f863a |
| T2 | S2, S3 | delegated (parallel unit, disjoint surface: action-screen.ts + its test) | done (RED 5 → GREEN 17/17) | cd8a595 |
| T3 | S1 | inline | done (RED 8 → GREEN) | fc76306 |
| T4 | S5 | inline | done (RED 4 → GREEN) | 419ea92 |

Risk: T1 is item 1 (migration on stored table, additive nullable column) — own commit.

## Log

- **L1 (2026-10-27, user, verbatim):** "hola claude, ayudame con un analisis de este proyecto, necesito mejorar el /dashboard, ya que actualmente esta centrado y lo ideal que ocupe todo el ancho de la pagina, ademas hazme un analis de ese diseño, que hoy es funcional, pero, visiblemente se puede mejorar otra cosa, que los links que estan ahí, cuando no tienen una url de destino, estos son direccionados a la vista que muestro en imagen, hay que ajustar esa vista, en dos cosas, que desde el dashboard me permita el seleccionar , si quiero re dirigir a esta pagina, con un checkbox, si no esta seleccionado, por defecto debe enviar a la pagina de reseñas de google de forma directa, y esa pagina que esta en la imagen hay que darle un refresh, estoy pensando que sea una similar a las reseñas de google, donde aparecen las 5 estrellas a selecionar, que si la reseña tiene menos de 5 estrellas, me muestre un formulario, con informacion de contacto del cliente, el telefono recomendado como principal contacto, actualmente esta el email, este debe quedar como opcional y secundario, el orden actual esta bien, el mensaje, luego el metodo de contacto y el boton de enviar"
- **L2 (2026-10-27, user, verbatim):** "descartamos el "review gating", por lo que vamos con la version que cumple la politica"
- **L3 (analysis):** the action screen renders when `is_gated = true`, not when the destination is missing (that is `renderCardNotConfigured`). `/api/gate` already accepts `rating` 1-5. Bulk cards hardcoded `is_gated: true`; S1's default reverses that, so ungated cards do not feed the satisfaction panel — surfaced to the user in the analysis and stated in the UI help text.
- **L4 (verification):** full suite 1081/1081, typecheck clean. Screenshots (headless Chrome) of the review screen (closed, 3 stars + form open) and of the dashboard at 1440px and 600px confirmed layout. Fixes found by looking: `.url-trunc` widening was overridden by source order (scoped to `.layout`); sticky side column dropped (taller than a laptop viewport would hide its bottom).
- **L5 (deploy note):** migration 00017 must be applied BEFORE deploying; the gate's feedback INSERT is fire-and-forget and would silently drop comments against a database without `customer_phone`. Documented in README.

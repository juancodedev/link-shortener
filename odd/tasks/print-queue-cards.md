# Print queue and review-card sheets in a dashboard sidebar

Objective: a left sidebar in the dashboard with a "Cards" section that prints 10×10 cm review cards for the links waiting in a print queue, exporting to PDF exactly what the preview shows.
Branch: `feat/print-queue` (stacked on `feat/hourly-traffic`, PR #87) · Delivery: single PR, one commit per work unit · Runner: `pnpm test` (vitest), `pnpm exec tsc --noEmit`.

## Specs

- **S1 — Sidebar.** "en el dashboard, crear un sidebard a la izquierda y ahi incorporar este "artefacto"". The dashboard becomes sections reached from a left sidebar: Overview (metrics + report), Links (create form + links table), Cards (the print queue), Businesses and branches, Comments, Settings (feedback email). One section visible at a time; the chosen section survives a reload (URL hash). On a phone the sidebar becomes a horizontal bar on top.
- **S2 — Send to print.** "quizás podriamos agregar al listado de links, que los que no están configurados aún, permitan mandarlos a imprimir, con un botón y cambia su estado, que también quede como para imprimir en la tabla". A link without destination shows a "Send to print" button; pressing it puts the link in the print queue and the table shows a "To print" badge. Queuing a link that already has a destination is refused with `409 link_configured` (the button only exists on unconfigured links).
- **S3 — Leaving the queue.** "Sale de la cola cuando yo le cambie el estado, manualmente o cuando se configure" / "que ese registro se actualice cuando el link fue configurado". A link leaves the queue (a) manually, per link ("Remove from queue") or for the whole batch ("Mark as printed", accepted by the user: "tu idea es mejor"), or (b) automatically when a destination is saved on it.
- **S4 — Generator.** The pasted generator's options are kept: variant "Híbrido: QR + NFC" / "Solo QR Centrado" / "Solo NFC Centrado"; design "Estándar Oficial Google" / "Clean Minimalist Glass"; "Modo Espejo"; "Líneas / Guías de Corte (Radio R5)"; sheet A3 vertical, A3 horizontal, A4 vertical, Carta, 1 card per sheet (100×100 mm), custom size; sheet margin and gap in mm. Cards are 100×100 mm. The QR encodes the link's short URL, never a pasted URL ("el link que salía en ese html, es para muestra nada más"). Styles follow the dashboard tokens; no Tailwind or qrcodejs CDN ("Sobre los estilos, encuentro muy buena tu idea"): QR comes from the server's existing generator (`src/api/qr.ts`).
- **S5 — What you see is what prints.** "este apartado para imprimir debe permitir el exportar a pdf sin perder nada de lo que se ve en el preview, lo que se ve, debe salir impreso". Preview and PDF are the same SVG in millimetres on sheets of the chosen size; `@page` takes the sheet size with zero margin; only the screen preview is scaled. Printing from Cards prints only the sheets; printing from Overview still prints the metrics report.
- **S6 — Top-left placement.** "Si hay pocas cards a imprimir, deben salir ordenadas a la parte superior izquierda, como si fuera en una hoja, ya que en la hoja no voy a imprimir nada a mitad de página". Cards fill rows left to right starting at the top-left margin; the block is never centred.

## Tasks

| ID | Specs | Route | Status | Commit |
|----|-------|-------|--------|--------|
| T1 | S2, S3 | inline | pending — migration `print_queued_at` on every tenant `links` table (Risk item 1, own commit) | |
| T2 | S2, S3 | inline | pending — API: list flag, PATCH `print_queued`, auto-clear on configure, `GET /api/links/print-queue`, `POST /api/links/printed` | |
| T3 | S4 | inline | pending — card SVG renderer + `GET /api/links/:id/card.svg` | |
| T4 | S1 | inline | pending — dashboard sidebar and sections | |
| T5 | S2, S3, S4, S5, S6 | inline | pending — Cards section, queue buttons in the links table, sheet layout, print | |

Route evidence: every unit touches `src/handlers/dashboard.ts` or depends on T1/T2, so no parallel writers. Risk: T1 is item 1 (schema change on every tenant `links` table).

## Log

- **L1 (2026-11-01, user, verbatim):** "me interesa agregar esto, en el dashboard, crear un sidebard a la izquierda y ahi incorporar este "artefacto"" + the pasted HTML generator (10×10 cm Google Reviews cards, QR/NFC variants, two designs, mirror, crop marks, sheet presets).
- **L2 (2026-11-01, user, verbatim):** "Este apartado es para imprimir las tarjetas, ya sea a una impresa o impresora manual, quizás podriamos agregar al listado de links, que los que no están configurados aún, permitan mandarlos a imprimir, con un botón y cambia su estado, que también quede como para imprimir en la tabla, que ese registro se actualice cuando el link fue configurado, que piensas. Sobre los estilos, encuentro muy buena tu idea, el link que salía en ese html, es para muestra nada más. También, este apartado para imprimir debe permitir el exportar a pdf sin perder nada de lo que se ve en el preview, lo que se ve, debe salir impreso. Si hay pocas cards a imprimir, deben salir ordenadas a la parte superior izquierda, como si fuera en una hoja, ya que en la hoja no voy a imprimir nada a mitad de página"
- **L3 (2026-11-01, user, verbatim):** "Sale de la cola cuando yo le cambie el estado, manualmente o cuando se configure"
- **L4 (2026-11-01, user, verbatim):** "Si, cumple, es la misma idea, pero yo lo pensé de pocas, no por lotes, pero tu idea es mejor / Implementarlo" — approved the mockup (sidebar sections, "To print" badge, Cards screen with controls and a top-left sheet).
- **L5 (decisions, mine):** queue state is a nullable `print_queued_at TIMESTAMPTZ` on the tenant `links` table (dies with the row, cleared in the same UPDATE that saves a destination) rather than a separate table. Tenant migration version 5 (versions 2–4 are taken; 00015 reused 3). Dashboard copy stays English like the rest of the dashboard; the printed card text stays Spanish as in the pasted design. Card text uses `<text>` with web fonts loaded by the page and the SVG is inlined, so the browser embeds the same fonts in the PDF that the preview shows.

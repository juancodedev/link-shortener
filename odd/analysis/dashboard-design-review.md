# Dashboard design review

**Type:** analysis — no implementation
**Date:** 2026-10-09
**Scope:** `src/handlers/dashboard.ts`, the single server-rendered HTML string
**Status:** documented for a future pass. Nothing here is implemented.
**Correction (2026-10-14):** the measurement and the root-cause claim in
[the bug section below](#bug-found-not-cosmetic) are both wrong. See
`odd/tasks/one-action-per-row.md`, which re-measured it and fixed it. Read that first.

---

## How this was assessed

Not by reading the CSS. The served HTML was fetched, rendered in a real browser at desktop
(1582px) and mobile (390px) widths, and populated with realistic sample data — long Google Maps
URLs, three links, two client refs — so the layout problems would actually surface rather than
hide behind an empty state.

Two findings are measurements, not opinions. They are marked as such below.

---

## Bug found (not cosmetic)

> **Superseded 2026-10-14 — do not act on this section.** It is kept because the
> original defect was real and the fix is worth reading next to it, but both the
> measurement and the cause below were wrong when re-checked in a real browser.
> Corrected: `odd/tasks/one-action-per-row.md`.
>
> What was wrong: `.row-actions` *does* declare `flex-wrap: wrap`, so the
> "cell that has no wrapping" claim is false — the wrapping is what stacked all
> four buttons vertically. And the first button was not reachable either: measured
> at 1582px in the real layout, **zero** of the four buttons was fully visible,
> not one. The real cause is that the actions column is *last*, so auto table
> layout pushes it off the right edge, and a 130px editable input was consuming
> 25% of the available width to make the table too wide in the first place.

**The action buttons are clipped. This is a functional defect, not a style preference.**

At a 1582px viewport, `.row-actions` overflows `.table-wrap` by **53px**. The wrap has
`overflow-x: auto`, so the column is scrollable — but nothing indicates that. Four buttons per row
(`Save`, `QR`, `Disable`, `Del`) live in a 69px-wide container while each button needs 54px. The
first button is fully visible; the rest are cut off at the card edge.

Measured:

```
.row-actions right edge   : 1155px
.table-wrap right edge    : 1102px
overflow                  :  53px
buttons per row           : 4, in 69px
```

Consequence: **`Disable` and `Del` are unreachable** without discovering a horizontal scroll that
nothing advertises. Deactivating and deleting a link are core operations — and for the NFC use
case, deactivating a link is how you retire a printed tag.

The root cause is structural: four inline buttons compete for horizontal space in a table cell
that has no wrapping, inside a container that clips rather than reflows.

This is worth fixing regardless of any visual work.

---

## Layout and hierarchy

### What works

- Card-based structure is sound. Form, links, and store rollup are visually distinct blocks.
- The type scale is consistent — one family, sane weights, real hierarchy between `h2` and `h3`.
- Spacing rhythm holds. Card padding and inter-card gaps are uniform.
- The estimate caveat renders in every relevant place, which was a deliberate decision in Phase 2.

### What does not

**The page has no dominant focal point.** Three equally-weighted cards stack vertically, each
roughly the same visual weight. Nothing tells the eye where to start. For a tool whose primary
loop is "scan a QR, see the numbers", the store rollup — the actual answer — is the *last* thing
on the page, below the fold on most screens.

**Data density is inverted.** The links table is the busiest element on the page and carries the
least important content. Meanwhile the store-level numbers, which answer the business question, get
three bare columns in a small table at the bottom.

**The URL column fights itself.** Google Maps review URLs are genuinely long — the real one is
~180 characters with tracking parameters. `url-trunc` clamps it, but a truncated Google Maps URL is
uninformative; the useful signal is the *domain*, which is buried at the far left of the string.

**Inline styles everywhere.** `style="..."` appears throughout the markup — widths, paddings, font
sizes, colors. Anything visual is now un-editable without hunting through a 700-line template
string. This is the main reason a redesign is expensive rather than merely tedious.

---

## Interaction

**Action buttons are text-only.** `Save`, `QR`, `Disable`, `Del` — four words in a 69px strip. No
icons, no tooltips beyond `title` attributes. `Del` in particular is a destructive action sharing
visual weight with the others; it is colored red but sits at the same size and weight as the rest.

**No confirmation on delete.** The button fires immediately. For a table of physical-store tags,
an accidental `Del` means re-printing.

**The client-ref input is always visible.** Every row carries an editable text field permanently,
which adds visual noise to a read-mostly table and makes scanning harder. It reads like a form,
not like data.

**Metrics are two clicks deep.** Country, device, and source breakdowns live in an expandable row
that is collapsed by default. For the NFC case the interesting comparison is *between stores*,
which the current structure makes awkward — you must expand each row separately.

---

## Responsive behavior

At 390px the form reflows acceptably, but:

- The table keeps its desktop column count and relies entirely on horizontal scroll. Six columns
  of actions in a phone viewport is unusable.
- The navigation wraps (`flex-wrap: wrap`), pushing `Log Out` onto its own line.
- No card layout, no stacking, no progressive disclosure.

The dashboard is effectively desktop-only. That may be an acceptable constraint — it is an internal
tool — but it should be a **stated** decision rather than an accident.

---

## Accessibility

**Touch targets are undersized.** Measured: buttons render **36px tall**, below the 44px
recommendation. Two of three buttons on the mobile view fail the guideline.

**Contrast is acceptable but unverified in context.** Body text is `#1e293d` on `#f8fafc` — that
combination passes AA. Placeholder text (`#94a3b8`) and the secondary metric values were not
audited.

**No dark mode.** `prefers-color-scheme: dark` has no effect: the page stays `#f8fafc` with dark
text. Colors are hardcoded hex values with **no CSS custom properties**, so there is no token layer
to retheme.

---

## Prioritized findings

### Fix regardless of redesign

| # | Finding | Impact |
|---|---|---|
| 1 | Action buttons clipped by 53px | **`Disable` and `Del` unreachable** |
| 2 | No confirmation on delete | Accidental loss of a printed tag |
| 3 | Touch targets at 36px | Below accessibility guidance |

### Structural — required before any visual work

| # | Finding | Why it blocks |
|---|---|---|
| 4 | Inline styles throughout the markup | Every visual change is a find-and-replace in a 700-line string |
| 5 | No CSS custom properties | No theming layer exists; dark mode means touching every rule |
| 6 | No component structure | One template literal mixes markup, styles, and three scripts |

### Design

| # | Finding |
|---|---|
| 7 | Store rollup — the actual business answer — is last and below the fold |
| 8 | No dominant focal point; three cards of equal weight |
| 9 | Long destination URLs are truncated to uninformativeness |
| 10 | Always-visible `client_ref` inputs add form noise to a data table |
| 11 | Four text-only buttons for distinct actions; destructive action not differentiated |
| 12 | Metrics two clicks deep; cross-store comparison is the awkward path |
| 13 | Desktop-only, by accident rather than decision |

---

## Suggested direction, for a future pass

Not a design. Just the shape of the decision.

The central question is **what this page is for**. Right now it does three jobs — create a link,
manage links, read store metrics — and gives each a third of the page. For the NFC use case the
primary loop is *"a customer scanned my tag, how many did I get?"*, which the page answers worst.

Two coherent directions:

**A — Link manager.** Optimise for creating, finding, and retiring tags. Store metrics become a
secondary view. Best if the tool is used operationally, many links at a time.

**B — Store dashboard.** Optimise for the per-store question. Local rollup first, links as detail
underneath. Best if it is read occasionally to answer "is this location working".

These imply different layouts, so the direction should be chosen before any visual work starts.
Picking a visual style first would produce a prettier page that is still ambiguous about its job.

Prerequisite either way: **extract the styles into a token layer** (finding #4/#5). Without it
every subsequent change stays expensive, and the third visual pass costs as much as the first.

---

## Not covered

- Login and signup pages, which share the visual language and were not assessed.
- The landing page.
- The QR modal, which was not opened during this review.
- Real data volumes: the assessment used three links. Behaviour at 30 links (the cap) may differ.
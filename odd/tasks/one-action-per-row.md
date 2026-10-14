# One action per row: retire a reachable dashboard

**Type:** implementation
**Status:** in progress
**Started:** 2026-10-14
**Fixes:** the `.row-actions` overflow defect in `odd/analysis/dashboard-design-review.md`
**Implements:** Direction A from `odd/analysis/dashboard-directions.md`

---

## Objective

Make every core link operation reachable at every viewport, by removing from the row what is not
something you *read*.

## Problem

Measured in a real browser at 1582px, in the real layout:

```
.container      max-width       720px
card content box                622px      ← available
table min-content              684.8px     ← required
hidden                          62.8px
.row-actions beyond the wrap    50.8px
buttons fully reachable              0 of 4
```

The document's own root-cause claim is **wrong** and this corrects it:

> Four buttons per row compete for horizontal space in a table cell that has no wrapping

`.row-actions` does declare `flex-wrap: wrap`. The wrapping is what makes it worse — the cell is
92.7px, the buttons are 54/42/68.7/42.7px, so with a 4px gap no two fit and all four stack
vertically, taking a 24px row to **127px**.

There are two independent defects:

1. **The actions column is last.** Auto table layout hands it the leftover. When the table's
   min-content exceeds the card, the last column is what falls off the right. `.table-wrap`'
   `overflow-x: auto` then absorbs the difference silently, and macOS overlay scrollbars mean there
   is no affordance at all.
2. **That squeezed column triggers the vertical button stack.**

At 390px the wrap is 292px, the table still wants 684.8px, so **392.8px is hidden** and the actions
column sits 380.8px past the visible edge. For a product whose own design doc says the user opens the
dashboard "standing up, usually on a phone", retiring a tag and deleting a link are unreachable on
the device the product is designed for.

## The diagnosis that drives the fix

Where the 622px goes:

| Column | Width | Share |
|---|---|---|
| Short Code | 78.8 | 13% |
| URL | 224 | 36% |
| Clicks | 62.3 | 10% |
| Status | 73.1 | 12% |
| **Client Ref** | **154** | **25%** |
| **Actions** | **92.7** | **15%** |

The two columns that consume the width are the two that are **not reading**. Client Ref is a 130px
editable text field in every row; the URL is already truncated with an ellipsis and a title tooltip.
What you actually *read* — code, destination, clicks, status — is 438px and fits.

## What changes

**The row keeps what you read, plus one primary and one destructive action:**

| Before | After |
|---|---|
| Short Code (copy) | Short Code (copy) |
| URL | URL |
| Clicks (opens metrics) | Clicks (opens metrics) — **the primary action** |
| Status | Status |
| Client Ref input + Save | — moved to the metrics panel |
| Save, QR, Disable, Del | **Del only**, the destructive action |

**The metrics panel gains the two that left the row:** the client-ref field, and enable/disable.

The panel already exists — it opens on the clicks — and it already carries the visitor estimate and
the three breakdowns. It is the right home for an editable attribute and for a state change.

### The sentence that belongs with Disable

`odd/analysis/dashboard-directions.md` argues that deactivating a tag is not a toggle in a row but a
distinct state change, and gives the reason:

> "This tag stops working. Anyone holding the printed sticker keeps the old destination until their
> browser cache expires." — That sentence is the whole reason for 302, stated in the place where the
> decision is made.

That sentence is not in the interface anywhere today. Moving Disable into the panel puts it next to
the decision it explains.

## Predicted result

Row width drops from 684.8px to ~510px against a 622px box: **fits at desktop with no scroll**.
Mobile stops being unusable, though a 6-column table is still the wrong format for a phone — that is
Direction B, and a separate task.

## Scope

**In:** the row template, the metrics panel, the column header, two tests whose subject is the row's
control set, and a measurement that proves reachability at every width.

**Out:**
- Direction B itself — venue cards instead of a table, which is what mobile actually wants.
- Any change to the API, the delegation model, or the escaping helper.
- Touching the six inline `display:none` elements, which `loadLinks` toggles.

## Constraints

- **Delegation is unchanged.** `#links-body` keeps exactly one click listener; the metrics panel is
  already inside that tbody, so controls moved into it are dispatched by the same handler.
- **Client-side function signatures are unchanged.** `toggleLink`, `saveClientRef` and friends keep
  their signatures — only the markup that reaches them moves.
- **Escaping is unchanged.** `client_ref` is still user-typed free text and still passes through
  `esc()`; it moves, it does not become trusted.
- **No new inline handlers.**

## Tasks

- [x] R0 — Measure and reproduce the defect in a real browser
- [x] R1 — Correct the root-cause claim in the design review
- [x] R2 — RED: a test asserting every core operation is reachable at every width
- [x] R3 — Move the client-ref field and enable/disable into the metrics panel
- [x] R4 — Reduce the row to one primary and one destructive action; drop the column
- [x] R5 — Add the 302 explanation next to the state change
- [x] R6 — Update the two tests whose subject is the row's control set
- [x] R7 — GREEN: full suite, typecheck, and a measured before/after at five widths

## Verification evidence

**TDD.** `test/handlers/links-row-reachability.test.ts` was written and run first. The first
draft only failed 3 of 14, because most of its assertions happened to pass against the broken
markup — a weak RED. It was strengthened with the two assertions that actually pin the change
(exactly one button in the row; the row's action set is exactly copy/delete/metrics) and then
failed **5 of 15**. Final: **18/18 pass**.

Two of those failures were **defects in the test**, not in the code, and both are worth recording:

- `renderRow()` returns the row *and* the hidden metrics panel from one arrow function, so a bare
  result contains the panel. Assertions about "the row" that did not split the two appeared to fail
  after the change had already landed. There is now a `split()` helper.
- `not.toContain(">Client Ref<")` failed because a *second* table — the "Stores by Client Ref"
  rollup — legitimately has that header. The header assertion is now scoped to the links table.

**The two tests in `dashboard.test.ts` that assert the action set were not modified.** They pin
the exact set of `data-action` values in the rendered template, and that set is unchanged: the
controls moved, the delegation surface did not. They passing untouched is the strongest available
evidence that this change did not touch the delegation model.

**Measured before/after**, real layout, real browser:

| | Before | After (1582px) |
|---|---|---|
| Card content box | 622px | 622px |
| Table width | 684.8px | **622px** |
| Hidden | 62.8px | **0** |
| `.row-actions` overflow | +50.8px | **−12px (inside)** |
| Button rows in the cell | 4 | **1** |
| Row height | 127px | **43.6px** |
| Buttons fully reachable | **0 of 4** | **1 of 1 (Del)** |

The freed width went to the destination column, which now shows 262px instead of 224.

**Mobile (390px, emulated).** Hidden content drops from **392.8px to 174.7px**, and `Del` is now
reachable by scrolling. The table still needs horizontal scroll on a phone, which is stated rather
than hidden: `.table-wrap` gained a four-layer scroll fade (`background-attachment: local, scroll`)
that appears only while there is more table in that direction.

**Why mobile still scrolls, and why that is not fixed here.** The URL column's min-content is
**224px and never shrinks** — `.url-trunc { max-width: 200px }` caps it but cannot make it smaller,
so it pins the table. Fitting five columns into 340px would mean a cramped table that fits nobody's
use case. A phone wants Direction B's venue cards, not a tighter table. That is a separate task.

**Suite.** `pnpm test` → **687 passed / 687**, exit 0, 31 files.
**Types.** `pnpm typecheck` → clean.

**Files changed:** `src/handlers/dashboard.ts`,
`odd/analysis/dashboard-design-review.md` (correction), plus new
`test/handlers/links-row-reachability.test.ts`.

## Next step after this

Direction B — venue cards instead of a table, which is what a phone actually wants — and then the
analytics page this whole exercise was for.
# Dashboard token layer

**Type:** implementation
**Status:** in progress
**Started:** 2026-10-14
**Prerequisite from:** `odd/analysis/dashboard-directions.md` ("The token layer is the first task of any future pass, independent of which direction is chosen")

---

## Objective

Replace every hardcoded colour in the served dashboard with a CSS custom property, named from the
product's domain rather than from a generic scale, so that a future visual revision costs one variable
instead of a find-and-replace across a 1000-line template literal.

## Problem

`src/handlers/dashboard.ts` is a single template literal carrying markup, CSS, and three scripts.
It has **zero CSS custom properties**, **66 hardcoded hex occurrences across 24 distinct colours**, and
**19 inline `style=""` attributes**. `src/handlers/gate-panel.ts` adds five more inline colour values.

Under this structure every decision in `odd/analysis/dashboard-directions.md` — swapping the palette to
the physical-world colours the document argues for — costs a find-and-replace across the whole file.

## Why extraction first, palette swap later (deliberate, and it is the point)

This feature **preserves the current colours exactly**. It changes no value; it only changes *where the
value lives*.

That separation is what makes the layer trustworthy. A faithful extraction is provably safe — every
computed style is identical, so the diff carries zero visual risk and can be verified without a browser.
Folding a palette change into the same commit would make "the layer works" and "the new colours are good"
one unverifiable claim, and the second one needs eyes on a real screen, which this environment has not got.

So: **this task delivers the layer. The palette swap is the next task, and it is a one-line-per-token diff.**

## Scope

**In:**
- A `:root` token block in the shell stylesheet
- Every hex colour in the shell CSS replaced by `var(--token)`
- Inline `style=""` attributes that carry *colour* replaced by token-driven classes
- The tenant-picker's `style.cssText` blob moved into a real CSS rule
- Colours in `src/handlers/gate-panel.ts` tokenised
- A regression test that fails if a colour is hardcoded outside `:root`

**Out (deliberate):**
- Changing any colour *value* — that is the next task
- Fixing the `.row-actions` 53px overflow defect from `odd/analysis/dashboard-design-review.md` — real,
  but a layout change that does not belong in a "no visual change" commit
- The analytics/charts page — depends on this task landing first

## Constraints

- **Zero visual change.** Every token's value is the exact hex currently in use.
- **Inline `display` styles stay inline.** Several elements are JS-toggled via `.style.display`; moving
  them to a class would break the toggle.
- **No new inline event handlers.** The dashboard carries a deliberate no-inline-handler discipline
  (asserted by `test/handlers/dashboard.test.ts`); this change must not weaken it.

## Token vocabulary

Named from the domain, per the analysis document's explicit instruction
(`--kraft`, `--ink`, `--tag`, `--venue`, `--retired` — not `--gray-700`).

| Group | Tokens |
|---|---|
| Surfaces | `--kraft` (page), `--kraft-deep` (inset/hover), `--sticker` (card/nav/raised) |
| Edges | `--edge`, `--edge-strong` |
| Ink | `--ink`, `--ink-strong`, `--ink-soft`, `--ink-label`, `--ink-faint` |
| The tag itself | `--tag`, `--tag-deep`, `--tag-wash` |
| Lifecycle | `--live-*`, `--stale-*`, `--retired-*` (active / expired / inactive) |
| Chrome | `--chrome`, `--chrome-ink`, `--veil`, `--shadow-card`, `--shadow-modal` |
| Peak chart | `--peak-public`, `--peak-private`, `--peak-rest` |

## Tasks

- [x] T0 — Create the feature branch and this document
- [x] T1 — RED: a test that fails while any colour is hardcoded outside `:root`
- [x] T2 — `:root` token block; replace every hex in the shell CSS
- [x] T3 — Move colour-bearing inline styles into token-driven classes
- [x] T4 — Move the tenant-picker's `cssText` blob into a `.tenant-bar` CSS rule
- [x] T5 — Tokenise the colours in `src/handlers/gate-panel.ts`
- [x] T6 — GREEN: full suite + typecheck pass

## Verification evidence

**TDD.** `test/handlers/dashboard-tokens.test.ts` was written and run first: **12 of 13 failed**
against the pre-existing code, confirming the guard actually detects the condition it claims to.
After the refactor: **13/13 pass**.

**Token equivalence — the claim that matters.** The whole point of this change is that it is
value-preserving, so that was checked mechanically rather than asserted:

```bash
# distinct hex literals before (both handlers)  vs  distinct hex literals inside :root
```

```
before: 24 distinct   in :root now: 24
absent from :root: none
introduced:      none
```

The only textual difference is `#fff` → `#ffffff`, which is the same colour in six-digit form.

**Suite.** `pnpm test` → **669 passed / 669**, exit code 0, 30 files.
**Types.** `pnpm typecheck` → clean.

**What stayed inline, deliberately** (and why the guard permits it):

| Remains | Why |
|---|---|
| `style="display:none"` × 6 | `loadLinks` toggles these through `.style.display`; a class would break the toggle |
| `style="height:NN%"` × 4 in the peak chart | Height *is* the encoded data — it scales each bucket against the busiest one |

**One existing test changed, and why it is not a weakening.**
`test/handlers/gate-panel.test.ts` asserted the literal string `style="height:100%;background:transparent;"`.
Its subject is bar scaling, not colour, so the assertion now reads `class="peak-bar" style="height:100%;"` —
same claim, new markup. A separate test was added asserting the computed heights are still emitted inline,
so the rule cannot later be over-applied and start stripping real data out of the markup.

**Files changed:** `src/handlers/dashboard.ts`, `src/handlers/gate-panel.ts`,
`test/handlers/gate-panel.test.ts`, plus new `test/handlers/dashboard-tokens.test.ts`.

## Next step after this

Swap the token *values* to the physical-world palette the analysis document argues for
(`odd/analysis/dashboard-directions.md`). With the layer in place that is a one-line-per-token diff
inside a single `:root` block — 30 tokens, one place, and no other file changes at all.
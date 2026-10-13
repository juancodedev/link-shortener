# Dashboard direction: two deepening passes

**Type:** design analysis — no implementation
**Date:** 2026-10-09
**Companion:** `odd/analysis/dashboard-design-review.md` (the findings this builds on)
**Status:** documented for a future pass. Nothing here is implemented.

---

## The premise behind both directions

Before drawing either one, the question that decides both:

**Who is this human, and what did they do five minutes ago?**

They printed an NFC tag or a QR sticker and put it on a table, a door, or a window. It is not a
web app they live in. They open it maybe once a day, usually standing up, usually on a phone, and
usually because something looks wrong or something looks right.

That single fact kills most dashboard conventions. This is not Linear with fewer features. It is a
**signage problem** — physical tags in the world, read by strangers, counted for one person who
walks the venue.

---

## The domain, taken seriously

This product lives in a specific world, and reaching for a generic SaaS palette would miss it.

**Domain concepts.** The tag. The sticker on glass. The table tent. The QR that has to survive
condensation and grease. The card you print and the *card you printed six months ago and cannot
retrieve*. The venue. The lunch rush. The dead tag — printed, mounted, and now pointing at a place
that closed. The number that has to mean something by tomorrow morning.

**Color world.** What is physically on a table in a café at noon? Kraft cardboard and a dark
espresso. A white sticker slightly yellowed by sun. Ink black on matte laminate. A green
"open" light and an amber one that means the printer is out. Chalkboard. Terracotta and brass on
a storefront. Condensation on glass.

**The signature.** This product's one irreducible object is **the tag in the world** — a physical
thing whose identity must survive the gap between *printed* and *online*. Every other element
serves that. Nothing in the current dashboard acknowledges it exists.

**The three defaults I am rejecting:**

| Default | What the current page does | What this product needs |
|---|---|---|
| Link table as hero | Links table is the biggest, busiest element | The **venue** is the unit of meaning; links are its tags |
| CRUD row layout | Four buttons per row, same weight | One primary action per row; destructive one visibly separate |
| Generic dashboard palette | `#f8fafc` / `#2563eb` / `#1e293d` | Should come from the physical world — kraft, ink, brass |

---

# Direction A — Link manager

**Optimised for:** creating, finding, and retiring tags. Best when many tags exist and the work is
operational.

## The human in this mode

They are at a laptop, or standing with a phone, having just received a brief: *"new location opens
Friday, need a tag for it."* They will create several links in a row, and they need to print.

## Structure

**Focal point: the tag you are holding.** The page leads with a single creation surface that reads
like a ticket, not a form. Destination, title, and client ref in one vertical column, generous
padding, one dominant button. The physics of a tag — small, physical, printed — justify a
*compact, dense* creation unit rather than a spacious marketing form.

**Second: the tag list as inventory, not as a table.** Rows are scanned, not read. Each row leads
with the venue identity (`client_ref`), because that is what the person recognises — "Cafe Central",
not `a7f3b2`. The short code is demoted to a monospace badge, because it is machine-facing and
only needed when copying.

**Third: print.** A QR action is not a modal that opens a picture. It opens a **print-ready sheet**
at actual tag size, with the code, the URL, and the venue name. This is the moment the product
actually exists in the physical world, and the current modal actively hides it behind a
small image.

**Fourth: retire, deliberately.** Deactivating a tag is not a toggle in a row — it is a distinct
state change with a confirmation that says what it means: *"This tag stops working. Anyone holding
the printed sticker keeps the old destination until their browser cache expires."* That sentence
is the whole reason to use 302, stated in the place where the decision is made.

## What A does well

- **Batch thinking.** New location = one client_ref, several destinations. Creating one at a time
  is friction.
- **Lifecycle visibility.** Active, expired, retired, and *never scanned* are the four states that
  matter. "Never scanned" is invisible today and is the single most actionable signal in the
  product — a tag that has never been scanned is either unmounted or broken.
- **Print is a first-class flow.**

## What A does badly

- It answers nothing about *performance*. If two venues are both underperforming, A makes you
  check each one.
- It treats a venue as a string, so "show me all of Cafe Central" is a manual `client_ref`
  memorisation task.
- It encourages link-shaped thinking. The person is managing tags; the page keeps reminding them
  they are managing URLs.

---

# Direction B — Store dashboard

**Optimised for:** the per-venue question. Best when read occasionally to answer *"is this place
working?"*

## The human in this mode

They are the owner. It is Monday. Two venues came in below expectations last week and they want
to know which, and whether it is the tag or the venue.

## Structure

**Focal point: the answer to "how many people came."** Not a link row — a **venue card**, and the
number on it is the hero. `Cafe Central · 38 visitors · 52 sessions`, with the number at display
size and the label demoted to an 11px tracked caption. Weight and colour do the hierarchy work, not
size alone.

**The comparison is the layout.** Venues are peers, so they sit in a consistent grid, scanned
top-to-bottom like a printout, not stacked in cards of different heights. Sorting by visitors
surfaces the outliers immediately, which is the entire job.

**Tags become detail.** Under each venue, its links are secondary — the venue is the unit, links
are how it is measured. Country and device breakdowns sit at venue level, because *"who is coming
here"* is a venue question, not a link question.

**The estimate caveat earns its place here.** A/B disagree about whether footfall is real, and B is
where that matters. The caveat is not a footnote in B — it is adjacent to the hero number,
because B's hero number *is* an estimate and pretending otherwise would be the actual defect.

## What B does well

- **Answers the actual business question** in the first screen.
- **Comparison is native.** The format suits spotting the weak venue.
- **Matches the deployment reality.** One tag per NFC marker per venue maps to one venue card.

## What B does badly

- **Bad at volume.** At 30 links across 20 venues, the grid scrolls and management gets harder.
- **Creation is demoted.** If new venues arrive weekly, a page optimised for reading is wrong for
  the day they arrive.
- **Hides the individual tag.** When a specific printed sticker stops working, B makes you hunt.

---

# The honest comparison

| | A — Link manager | B — Store dashboard |
|---|---|---|
| Primary verb | create, retire | compare, judge |
| Unit | the tag | the venue |
| Answers "why did that place drop?" | no | **yes** |
| Answers "I need a tag by Friday" | **yes** | no |
| Handles 30 tags well | **yes** | poorly |
| Cost of the wrong choice | frustrating | **invisible** |

**B has the worse failure mode.** Choosing A when you needed B produces a page that is merely
unhelpful — you notice and add views. Choosing B when you needed A produces a page that looks
right and answers nothing, which is harder to notice.

## My recommendation

**B first, with A's creation flow retained above it.**

Reason: the current page already *is* A — a creation form and a table — and it is not answering
the question that made the product worth building. Phase 2 already computed per-`client_ref`
rollups and they render in a three-column table at the bottom, below the fold, answering a question
nobody asked. The capability exists and is buried.

B surfaces what is already computed. A is a lateral move that changes nothing about what the
numbers mean.

Practically, that means **one page, hero venue grid first, creation as a compact unit that does not
dominate**. Not two pages — that is a nav decision this product does not need at this size.

---

# Prerequisite: the token layer

Both directions depend on work that is not visual.

`src/handlers/dashboard.ts` is a single template literal carrying markup, CSS, and three scripts.
Colours are hardcoded hex; there are **zero CSS custom properties**; `style="..."` attributes
appear throughout. `prefers-color-scheme` has no effect because there is nothing to switch.

Under the current structure, every decision in this document costs a find-and-replace through a
700-line string. Under a token layer, each costs one variable.

**The token layer is the first task of any future pass, independent of which direction is chosen.**
Without it, the third visual revision costs as much as the first.

Token names should come from the domain, not from a scale. `--kraft`, `--ink`, `--tag`, `--venue`,
`--retired` — not `--gray-700` and `--surface-2`. Reading only the token names should let someone
guess what the product is.

---

# Sequence, if this proceeds

1. **Token layer.** Extract CSS custom properties. No visual change. Everything after this is
   cheaper.
2. **Fix the clipped action buttons.** Currently 53px overflow hides `Disable` and `Del`. This is a
   functional defect and does not wait for the design decision.
3. **Add a delete confirmation.** Accidental deletion of a printed tag means re-printing.
4. **Choose a direction and build the focal element.** Hero venue grid, or tag inventory.
5. **Everything else** — dark mode, responsive, print sheet — after the primary loop is right.

Steps 2 and 3 are not design work and should not wait on it.
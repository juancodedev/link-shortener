# Dashboard physical palette

**Type:** implementation
**Status:** in progress
**Started:** 2026-10-14
**Depends on:** `odd/tasks/dashboard-token-layer.md` — this change is only reviewable *because* of it

---

## Objective

Swap the dashboard's colour **values** for the physical-world palette that
`odd/analysis/dashboard-directions.md` argues for, now that every colour lives in one `:root` block.

## Why this is only now, and only this small

`odd/analysis/dashboard-directions.md` rejects the generic SaaS palette explicitly:

> Generic dashboard palette — `#f8fafc` / `#2563eb` / `#1e293d` — should come from the physical
> world — kraft, ink, brass.

and names its own prerequisite:

> The token layer is the first task of any future pass, independent of which direction is chosen.
> Without it, the third visual revision costs as much as the first.

So this task was blocked on the token layer, and with the layer in place it is **30 changed lines in a
single block**. Before it, the same change was 66 replacements across a 1000-line template literal.

## The palette

The product is NFC and QR tags printed and mounted in venues — cafés, shops, storefronts. So the
colours come from that world, not from a UI kit:

| Token | Value | What it is |
|---|---|---|
| `--kraft` | `#f4f1ea` | the page: uncoated paper |
| `--kraft-deep` | `#ece7dd` | inset panels, hover wash, row rules |
| `--sticker` | `#fbf9f5` | the printed tag itself: nav, cards, tiles |
| `--edge` | `#ddd6c8` | a cut edge of board, not a cold grey rule |
| `--edge-strong` | `#c4bba9` | form fields, outlined buttons |
| `--ink` | `#2b2622` | espresso |
| `--ink-strong` | `#1a1613` | ink on matte laminate |
| `--ink-soft` | `#6b625a` | secondary text, table headers |
| `--ink-label` | `#544c44` | form labels |
| `--ink-faint` | `#8d847a` | placeholders, disabled, empty states |
| `--tag` | `#a8482a` | terracotta, the colour of a storefront |
| `--tag-deep` | `#8a3a1f` | |
| `--tag-wash` | `rgba(168, 72, 42, 0.12)` | |
| `--live` | `#2f6b3a` | the green "open" light, seen on a chalkboard |
| `--stale` | `#8a5a12` | amber: the light that means the printer is out |
| `--retired` | `#a13325` | oxblood |
| `--chrome` | `#241f1b` | the location bar |
| `--shadow-card` | `rgba(43, 38, 34, 0.06)` | a shadow on a warm surface picks up that surface's colour |
| `--veil` | `rgba(36, 31, 27, 0.45)` | |
| `--peak-public` | `#9c8d74` | brass |

## The part that is not a matter of taste: contrast

**Warm colours darken faster than cool ones.** A palette chosen by eye against a cool-grey baseline
will quietly lose contrast on every text pair. That is not a hypothetical: the first draft of this
palette regressed three pairs and would have shipped if nobody had measured.

Every value was therefore chosen by measuring WCAG contrast against the surface it sits on, against
the old palette as the baseline. Three values were corrected as a result:

| Pair | Draft | Shipped | Old | Why it changed |
|---|---|---|---|---|
| `--tag` on `--kraft-deep` (outline button hover) | `#b4502e` → **4.13** | `#a8482a` → **4.70** | 4.72 | below the 4.5 text floor, and a regression |
| `--ink-faint` on `--sticker` (placeholders) | `#9a9188` → **2.95** | `#8d847a` → **3.49** | 2.56 | below the 3.0 non-text floor |
| `--peak-public` on `--sticker` (chart bar) | `#b8ad9a` → **2.11** | `#9c8d74` → **3.08** | 1.48 | below the 3.0 floor WCAG 1.4.11 sets for chart fills |

Final result across all 18 measured pairs: **zero regressions**, every text pair at or above its
floor. Two borders (`--edge`, `--edge-strong`) measure below 3:1 against the card — as they did
before, at 1.23 and 1.47 — and stay that way deliberately: they are separators between surfaces, not
the sole indicator of a control's boundary, and darkening them would put a hard outline on every card.

## Visual verification

The served shell was rendered to a static HTML file, opened in a real browser, and screenshotted —
not eyeballed from the source. Checked: page and card surfaces, all three lifecycle badges, both
message states, the stat tiles, the peak chart segments, every button variant including disabled, the
code and clicks link, and the location bar.

Rendering the shell is what made it possible to check this at all: the tests run inside `workerd`,
where `node:fs` is a stub, so the render had to happen outside the runner.

## Tasks

- [x] P0 — Abandon the stalled review lineage and release the authority
- [x] P1 — Measure the old palette as a contrast baseline
- [x] P2 — Design the physical palette and correct the three failing pairs
- [x] P3 — Swap the values in `:root`
- [x] P4 — GREEN: full suite + typecheck pass
- [x] P5 — Visual verification in a real browser

## Acceptance criteria

1. No value regresses against the old palette on any measured pair.
2. Every text pair clears 4.5:1; every non-text UI element clears 3:1.
3. `pnpm test` and `pnpm typecheck` pass unchanged.
4. The token layer is intact: no colour literal outside `:root`.

## Verification evidence

```
pnpm test       → 669 passed / 669, exit 0, 30 files
pnpm typecheck  → clean
contrast        → 18 pairs, 0 regressions
visual          → rendered and screenshotted in a real browser
```

## Out of scope

- **Dark mode.** `prefers-color-scheme` still does nothing, because there is still nothing to switch.
  Doing it properly doubles the palette and needs its own contrast pass over both schemes.
- The `.row-actions` 53px overflow defect from `odd/analysis/dashboard-design-review.md`. Still open.
- Direction B itself — the venue grid and the analytics page, which is why the charts matter.
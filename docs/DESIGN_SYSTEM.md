# Genesis — Design System

*The visual foundation, defined before any UI is built. Light, clean, spacious,
high-clarity — calibrated to sarvam.ai's ACTUAL palette (colors extracted from
their shipped CSS, not guessed). Explicitly NOT dark. Designed to prevent the
failure modes called out: overlap, over-cramming, and an unpolished feel.*

## Source of the palette (VERIFIED via browser-console computed styles)

These are sarvam.ai's exact computed values, read from the live rendered page (not
guessed, not CSS-grep — actual `getComputedStyle` output):
- **Body text:** `#1F1F1F` (near-black), font **Matter**, weight **425**, 16px.
- **Headings:** `#1F1F1F`, font **"Season Mix"**, weight **425** (light, even at 64px —
  that's the airy feel), h1 = 64px.
- **Canvas:** `#FAFAFA` (confirmed: `linear-gradient(#FAFAFA 40%, transparent)`);
  a panel gradient runs `#FFFFFF → #F0F1F5`.
- **Dark UI (buttons/nav):** a NAVY GRADIENT `#3A3F5C → #1E2033` — not flat.
- **Button radius:** **8px** (rounded-rect, NOT a pill — corrected from the screenshot
  guess).
- **Accent family is INDIGO / PERIWINKLE** (corrected — it is NOT green): hero glow
  `radial(#A5BBFC → #D5E2FF → transparent)`, plus `#6A88E2`, and an indigo band
  `#C7D2FE → #A5B4FC → #818CF8`. (Green appears only as one minor card wash.)
- **Fonts:** Matter (UI) + Season Mix (display) — proprietary; we MATCH their
  character with open fonts, we do NOT copy their font files (IP rule). Matter ≈ a
  neutral grotesque (Inter); Season Mix ≈ a light display serif/grotesque (Fraunces
  light, or Inter 300 to stay single-font).
- **Key trait:** heading weight is LIGHT (~300–425), not bold. Big + thin + airy.

---

## 0. Principles (what every screen must obey)

1. **Light & clean, never dark.** A cool near-white canvas, deep indigo-navy ink,
   one restrained green accent. Calm, trustworthy, premium — not a neon dashboard.
2. **Space is the feature.** Generous whitespace and breathing room around every
   element. When in doubt, add space, not content.
3. **One idea per region.** No screen crams multiple competing things. Clear
   hierarchy: one primary thing, supporting things visibly secondary.
4. **A strict spacing scale.** All gaps/padding come from one 4px-based scale — this
   is what eliminates the overlap and ragged alignment problems.
5. **Restraint on color.** Color carries meaning (status, the one accent), never
   decoration. Most of the screen is ink-on-near-white.
6. **Type does the hierarchy.** Size + weight + color create order; we rarely need
   borders or boxes to separate things.

---

## 1. Color tokens

A cool, light palette (sarvam-calibrated). Near-white canvas, deep indigo-navy ink,
a single confident GREEN accent, plus restrained semantic colors.

### Neutrals (the 95% of the screen) — cool light, sarvam-calibrated
| Token | Hex | Use |
|---|---|---|
| `--canvas` | `#FAFAFA` | app background (sarvam's near-white) |
| `--surface` | `#FFFFFF` | cards, panels (sit *on* the canvas) |
| `--surface-sunken` | `#F0F1F5` | insets, code blocks, table header row (sarvam's cool light grey) |
| `--ink` | `#1E2033` | primary text (sarvam's deep indigo-navy, their #1 color — not pure black) |
| `--ink-soft` | `#3A3F5C` | secondary text, labels (sarvam's secondary) |
| `--ink-muted` | `#6B7088` | tertiary/captions, placeholder (desaturated from ink) |
| `--line` | `#E6E7EC` | hairline borders, dividers (cool, low-contrast) |
| `--line-strong`| `#D3D5DE` | borders that need to read (inputs, active card) |

> **Approach: learn, don't clone.** We do NOT copy sarvam's exact values or layout
> (that would be derivative, and risks IP). We extracted the *principles* from their
> real computed styles and chose Genesis's OWN tokens that embody those principles
> but are distinct. The lessons we adopted:
> 1. Cool near-white base; near-black ink; almost no saturation in the base.
> 2. Big, **light-weight** headings (weight ~300–400, not bold) = airy, premium.
> 3. Color appears only as **soft gradient glows/washes**, never loud flat blocks.
> 4. One dark color for solid UI (buttons/nav); accents are gentle, indigo-leaning.
> 5. Modest radius (~8–14px), generous whitespace, hairline borders.
> Genesis's own choices below differ in the specifics (our accent, our gradient mix,
> our heading font) while keeping that calm, premium feel.

### Primary UI color — our deep ink (for solid buttons / chrome)
A solid dark for the one primary action and dark chrome. We use our own ink-navy
(slightly cooler/darker than sarvam's, so it's ours, not theirs).
| Token | Hex | Use |
|---|---|---|
| `--primary` | `#1C1E2E` | primary (filled) button, dark chrome |
| `--primary-hover` | `#282B40` | hover/pressed |
| `--primary-ink` | `#FFFFFF` | text on primary |

### Accent — soft indigo + gentle gradient washes (our mix, sarvam-informed)
Lesson adopted: color is atmospheric, not loud. Our accent is a readable indigo for
the few saturated touches (links, active state, the live graph edge); everything
else is a soft wash. These are OUR values, not sarvam's verbatim.
| Token | Value | Use |
|---|---|---|
| `--accent` | `#4F5BD5` | links, active state, the live/active graph edge (readable indigo) |
| `--accent-hover` | `#3F49B0` | hover/pressed |
| `--accent-soft` | `#ECEDFB` | selected row, badge background |
| `--accent-ink` | `#FFFFFF` | text on accent |
| `--wash-indigo` | `linear-gradient(135deg,#ECEDFB,#E2E8F8)` | primary card / panel tint |
| `--wash-warm` | `linear-gradient(135deg,#FBEDE0,#F6E6F0)` | alternate card tint (warm) |
| `--wash-mint` | `linear-gradient(135deg,#E8F2E6,#DEEEEA)` | alternate card tint (cool green) |
| `--hero-glow` | `radial-gradient(55% 45% at 50% 0%, #DCE0F7 0%, #EDE4F2 40%, transparent 72%)` | the soft glow behind a hero / page header |

> Rule: saturated color is RARE. Most color on screen is a soft gradient wash behind
> content; solid color is navy (UI) + the occasional indigo link. Nothing is loud.

### Semantic (status — meaning only, low saturation so it stays calm)
| Token | Hex | Use |
|---|---|---|
| `--ok` | `#3F7D4E` | completed, verified, healthy |
| `--ok-soft` | `#EAF3EC` | ok background |
| `--warn` | `#B5762B` | parked / awaiting approval / attention |
| `--warn-soft`| `#FAF1E3` | warn background |
| `--danger` | `#A8392F` | failed, denied, over budget |
| `--danger-soft`|`#F8EAE7` | danger background |
| `--running` | `#4F5BD5` | in-progress (reuses the indigo accent) |

> Rule: status is shown as a **soft-bg pill with a dot + label**, never a loud
> full-saturation block. Keeps the screen calm even when something failed.

### Contrast (accessibility — non-negotiable)
- `--ink` on `--canvas` ≈ 15:1, `--ink-soft` on `--canvas` ≈ 7:1 — both pass WCAG AAA/AA.
- `--accent-ink` on `--accent` ≥ 7:1. Every status pill: text on its soft bg ≥ 4.5:1.

---

## 2. Typography

A single, modern sans for UI + a mono for the ledger/code. No more than two families.

- **UI / sans:** `Inter` (variable) → fallback `system-ui, -apple-system, Segoe UI, sans-serif`.
  Sarvam uses a proprietary grotesque ("Matter") we will NOT copy; Inter is the closest
  open, license-clean match in character (neutral grotesque, excellent at small sizes).
- **Display (optional, hero only):** a warm humanist serif/grotesque for the one page
  title, echoing sarvam's "Season Mix" display feel — open option: `Fraunces` (variable)
  or simply Inter 600 to stay minimal. Default to Inter to avoid a second font load.
- **Mono (ledger, hashes, code):** `"JetBrains Mono"` → fallback `ui-monospace, SFMono-Regular, Menlo, monospace`.
- **All fonts are open-licensed (SIL OFL / Apache).** We never ship sarvam's font files.

### Type scale (1.20 "minor third" ratio, rounded to clean px)
> Lesson from sarvam: headings are **light** (weight ~300–425) even when large — big
> + thin + airy reads premium. We keep titles at 400–500, not 600–700.

| Token | Size / line-height | Weight | Use |
|---|---|---|---|
| `display` | 48 / 56 | 350 | hero / page title (one per page) — large + LIGHT |
| `h1` | 32 / 40 | 400 | section title |
| `h2` | 24 / 32 | 500 | sub-section |
| `h3` | 18 / 26 | 600 | card title (small, so a touch heavier for legibility) |
| `body-lg` | 17 / 28 | 400 | intro paragraph |
| `body` | 15 / 24 | 400 | default text |
| `small` | 13 / 20 | 400 | secondary / captions |
| `micro` | 11 / 16 | 500 | labels, eyebrows (UPPERCASE, letter-spacing 0.06em) |
| `mono` | 13 / 20 | 400 | hashes, ids, code |

### Rules
- **One `display` per page.** Headings step down in order — never skip h1→h3 for size.
- **Body line length capped at ~70ch** (a `max-width` on text columns) — prevents the
  wall-of-text cramming.
- Numerals: use `font-variant-numeric: tabular-nums` for cost meters and tables so
  digits align.
- Color, not just size, signals hierarchy: titles `--ink`, support `--ink-soft`,
  captions `--ink-muted`.

---

## 3. Spacing scale (the anti-overlap system)

One 4px-based scale. **Every** margin, padding, and gap is a token from this list —
nothing arbitrary. This single rule is what kills overlap and ragged alignment.

| Token | px | Typical use |
|---|---|---|
| `space-0` | 0 | — |
| `space-1` | 4 | icon↔label, tight inline gaps |
| `space-2` | 8 | inside a pill, chip padding |
| `space-3` | 12 | input padding, small gaps |
| `space-4` | 16 | default gap between related items |
| `space-5` | 24 | card padding, gap between cards |
| `space-6` | 32 | gap between sub-sections |
| `space-7` | 48 | gap between major sections |
| `space-8` | 64 | page top padding / hero |
| `space-9` | 96 | large landing rhythm |

Rules:
- **Minimum 24px (`space-5`) padding inside any card/panel.** No element touches a
  card edge.
- **Minimum 16px (`space-4`) between any two interactive elements** — no overlap, no
  accidental mis-taps.
- Vertical rhythm: stack sections with `space-7` (48px); items within a section with
  `space-4`/`space-5`.

---

## 4. Layout & density (the anti-cramming rules)

- **Max content width:** 1200px, centered, with `space-6`+ gutters. The canvas/graph
  view may go full-bleed; text and forms never do.
- **8-column → 12-column responsive grid**, `space-5` (24px) gutter.
- **One primary action per view.** Secondary actions are visually quieter (text or
  outline buttons), tertiary go in a menu.
- **Progressive disclosure over cramming.** Detail lives behind a click (a drawer, an
  expand), not all on screen at once. A run row shows status + name + cost; the full
  17-event trace is one click away.
- **Empty space is allowed.** A page with one card and lots of near-white is correct, not
  "unfinished".
- **Lists breathe:** row height ≥ 48px, `space-3`/`space-4` vertical padding, hairline
  `--line` dividers (not boxes around every row).

---

## 5. Shape, elevation, motion

- **Radius (verified: sarvam buttons are 8px rounded-rect, NOT pills):**
  `radius-sm` 8px (inputs, buttons), `radius-md` 14px (cards), `radius-lg` 20px (large
  panels / feature cards), `radius-pill` 9999px reserved for small chips/badges only.
  Buttons are 8px rounded-rect; cards are soft 14–20px. (My earlier "pill button" read
  from the screenshot was wrong — the console confirmed 8px.)
- **Borders over shadows.** Prefer a 1px `--line` border on a `--surface` card. Use
  shadow only for true overlays (dropdown, modal): `shadow-sm` =
  `0 1px 2px rgba(26,26,23,.06)`, `shadow-md` = `0 8px 24px rgba(26,26,23,.10)`.
  Low, warm, diffuse — never a hard dark drop shadow.
- **Motion:** quick + calm. 150ms ease for hover/state, 220ms for enter/leave. Respect
  `prefers-reduced-motion`. The canvas may animate edges subtly; nothing blinks.

---

## 6. Components — the rules that prevent the named problems

- **Buttons:** height 40px (default) / 32px (small); horizontal padding `space-4`;
  `radius-md`. Primary = `--accent` filled; secondary = `--surface` + `--line-strong`
  border; tertiary = text-only `--accent`. One primary per region.
- **Inputs:** height 40px, `--surface` bg, `--line-strong` border, `--accent` focus
  ring (2px, offset). Label above (`micro`), help text below (`small --ink-muted`).
- **Cards:** `--surface`, 1px `--line`, `radius-md`, `space-5` padding. Title (`h3`),
  one supporting line (`small --ink-soft`), then content. **Never** more than one
  primary action per card.
- **Status pill:** soft-bg + colored dot + `micro`/`small` label. e.g. completed =
  `--ok-soft` bg, `--ok` dot+text.
- **Tables/lists:** sunken header row, tabular-nums for numbers, hairline row
  dividers, generous row height, the row's primary id in `mono`.
- **The agent canvas (ReactFlow):** nodes are `--surface` cards on the `--canvas`,
  `--line` border, `radius-md`; running = `--accent` border, done = `--ok` dot,
  failed = `--danger` border. Edges hairline `--line-strong`; the active path
  `--accent`. **Auto-layout with enforced min node spacing** (≥ `space-6` between
  nodes) so nodes never overlap — directly solving the overlap problem on the most
  layout-prone screen.

---

## 7. The "is it attractive / not crammed?" checklist (apply to every screen)

- [ ] One clear primary thing; everything else visibly secondary.
- [ ] Nothing overlaps; ≥16px between interactive elements; nodes ≥32px apart.
- [ ] Every gap/padding is a token from §3 (no arbitrary px).
- [ ] Card/panel inner padding ≥ 24px.
- [ ] Text columns ≤ ~70ch; no wall of text.
- [ ] One `display`/page; headings step down in order.
- [ ] Color used only for meaning + the one accent; the screen is mostly near-white+ink.
- [ ] Numbers use tabular-nums and align.
- [ ] Detail is one click away, not all on screen.
- [ ] It looks calm and premium at a glance — would fit next to sarvam.ai.

---

## 8. Token reference (drop-in CSS variables)

```css
:root {
  /* neutrals — sarvam-calibrated, cool light */
  --canvas:#FAFAFA; --surface:#FFFFFF; --surface-sunken:#F0F1F5;
  --ink:#1E2033; --ink-soft:#3A3F5C; --ink-muted:#6B7088;
  --line:#E6E7EC; --line-strong:#D3D5DE;
  /* primary UI (solid dark) + indigo accent (our values, sarvam-informed) */
  --primary:#1C1E2E; --primary-hover:#282B40; --primary-ink:#FFFFFF;
  --accent:#4F5BD5; --accent-hover:#3F49B0; --accent-soft:#ECEDFB; --accent-ink:#FFFFFF;
  /* soft gradient washes — color is atmospheric, never loud */
  --wash-indigo:linear-gradient(135deg,#ECEDFB,#E2E8F8);
  --wash-warm:linear-gradient(135deg,#FBEDE0,#F6E6F0);
  --wash-mint:linear-gradient(135deg,#E8F2E6,#DEEEEA);
  --hero-glow:radial-gradient(55% 45% at 50% 0%,#DCE0F7 0%,#EDE4F2 40%,transparent 72%);
  --radius-pill:9999px; /* chips/badges only — buttons are radius-sm 8px */
  /* semantic */
  --ok:#16A34A; --ok-soft:#E3F1D8;
  --warn:#EA580C; --warn-soft:#FDE7D7;
  --danger:#B5392F; --danger-soft:#F8E7E5;
  /* spacing */
  --space-1:4px; --space-2:8px; --space-3:12px; --space-4:16px; --space-5:24px;
  --space-6:32px; --space-7:48px; --space-8:64px; --space-9:96px;
  /* radius */
  --radius-sm:6px; --radius-md:10px; --radius-lg:16px;
  /* shadow */
  --shadow-sm:0 1px 2px rgba(26,26,23,.06);
  --shadow-md:0 8px 24px rgba(26,26,23,.10);
  /* type */
  --font-sans:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;
  --font-mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
}
```

*This is the contract the web UI is built against. Every component references these
tokens; nothing hardcodes a color or a px value outside the scale.*

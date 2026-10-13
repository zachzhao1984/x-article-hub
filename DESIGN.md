---
name: X Article Hub
description: A human-curated, machine-archived reading room for long-form posts from X.
colors:
  verdigris: "#176b75"
  verdigris-dim: "#145f68"
  verdigris-on: "#ffffff"
  paper: "#faf9f6"
  panel: "#ffffff"
  panel-sunk: "#f3f3ef"
  hairline: "#dfe4e1"
  hairline-soft: "#e9ede9"
  ink: "#202a30"
  ink-muted: "#59656b"
  ink-faint: "#657176"
  signal-ok: "#2f7d5c"
  signal-warn: "#b8873a"
  signal-danger: "#b3402a"
  header-veil: "#faf9f6e8"
typography:
  display:
    fontFamily: "Inter, PingFang SC, Noto Sans CJK SC, -apple-system, system-ui, sans-serif"
    fontSize: "clamp(30px, 6vw, 48px)"
    fontWeight: 400
    lineHeight: 1.08
  headline:
    fontFamily: "Inter, PingFang SC, Noto Sans CJK SC, -apple-system, system-ui, sans-serif"
    fontSize: "clamp(28px, 5vw, 40px)"
    fontWeight: 700
    lineHeight: 1.28
  title:
    fontFamily: "Inter, PingFang SC, Noto Sans CJK SC, -apple-system, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "Inter, PingFang SC, Noto Sans CJK SC, -apple-system, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.75
  label:
    fontFamily: "Inter, PingFang SC, Noto Sans CJK SC, -apple-system, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  control: "7px"
  button: "8px"
  surface: "10px"
  pill: "999px"
spacing:
  xs: "6px"
  sm: "12px"
  md: "16px"
  lg: "24px"
components:
  button-primary:
    backgroundColor: "{colors.verdigris}"
    textColor: "{colors.verdigris-on}"
    rounded: "{rounded.button}"
    padding: "8px 16px"
    typography: "{typography.label}"
  button-secondary:
    backgroundColor: "{colors.panel-sunk}"
    textColor: "{colors.ink}"
    rounded: "{rounded.button}"
    padding: "8px 16px"
    typography: "{typography.label}"
  input:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "6px 11px"
    typography: "{typography.label}"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.control}"
    padding: "6px 9px"
    typography: "14px"
  chip:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.pill}"
    padding: "4px 11px"
    typography: "{typography.label}"
  card-article:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
    padding: "0"
    typography: "{typography.title}"
---

# Design System: X Article Hub

## Overview

**Creative North Star: "The Reading Room"**

A public reading room, not a storefront and not a control panel. Warm paper under
everything, one deep verdigris used the way a librarian's stamp is used — rarely,
and always meaning something. Nothing on this site is trying to convert a visitor;
it is trying to hand them something worth reading and then get out of the way. The
curator is deliberately invisible, so the interface cannot lean on personality to
carry authority — the writing and the ordering have to do that work instead.

The aesthetic position is **restrained and literate**: typography is the material,
and decoration does not earn its keep. A beautiful page here is produced by type
size, measure, whitespace and alignment — not by effects applied on top of them.
The whole stylesheet contains three transition values and one shadow. That is not
a budget that ran out; it is the position.

The explicit anti-reference is **anything that reads as a dashboard or as
technology**. No telemetry aesthetic, no dense metric panels, no sci-fi blue
gradients, no chrome that implies a machine is running. This is a place to read
something someone wrote.

**Key Characteristics:**

- Hairline borders carry all structure; surfaces never lift, cast, or float
- Manila-paper ground with a near-monochrome ink scale, one verdigris accent
- CJK-first typography: Latin and Chinese/Japanese share one stack and one scale
- Deliberately static — motion is a 0.12–0.15s colour shift, nothing else
- Pills for taxonomy, soft rectangles for surfaces, no decorative geometry

## Colors

A warm near-monochrome with a single saturated accent, inverted in character
between themes.

### Primary

- **Verdigris** (`#176b75`): The one accent. Links on hover, the active nav item,
  the ranking numeral, primary buttons, and every focus edge. It is the only
  colour on the site that is not derived from paper or ink.
- **Verdigris Dim** (`#145f68`): The interactive-state variant. Border colour on
  card hover and input focus — one step darker so the change registers without
  the accent arriving at full strength on a resting surface.
- **Verdigris On** (`#ffffff`): Text and icon colour on a verdigris fill.

### Neutral

- **Manila Paper** (`#faf9f6`): The page ground. Warm, very slightly yellow —
  deliberately not pure white, because a full-white field under long-form CJK
  body text is harsh.
- **Panel** (`#ffffff`): Raised surfaces — cards, inputs, selects. One step
  lighter than the ground, which is the only elevation signal in the system.
- **Panel Sunken** (`#f3f3ef`): Secondary and resting fills — secondary buttons,
  the save button, nav hover.
- **Hairline** (`#dfe4e1`): The structural border. Every card, input, chip and
  divider is drawn with it. This token does more work than any other.
- **Hairline Soft** (`#e9ede9`): Dividers and low-emphasis separations.
- **Ink** (`#202a30`): Primary text. A dark slate, not black — black against warm
  paper reads as printed-on rather than written-in.
- **Ink Muted** (`#59656b`): Metadata, captions, resting nav labels.
- **Ink Faint** (`#657176`): The quietest tier — pager links, secondary board
  controls, timestamps.

### Status

- **Signal Ok** (`#2f7d5c`), **Signal Warn** (`#b8873a`), **Signal Danger**
  (`#b3402a`): Success, warning and error states. Used almost exclusively in the
  admin and in governance banners, never decoratively.

### The Dark Theme

The theme is a full parallel palette, not a filter applied over the light one, and
two of its decisions are worth stating because they are easy to get wrong later.

The ground becomes `#13191c` and the ink `#e7eceb` — both kept off pure
black/white for the same reason their light counterparts are: a pure-black field
under 17.5px CJK body text produces halation. Borders become **translucent
white** (`#ffffff26` / `#ffffff17`) rather than darkened greys, so a hairline
reads as a hairline against whatever surface is behind it.

The accent **changes character**, not just value: `#12ccd8` with `#000` for
contrast on it. Light-mode verdigris is a deep ink; dark-mode verdigris is a
luminous cyan. Preserve both — a "dark theme" that just darkens `#176b75` is
invisible, and one that keeps the white contrast text is illegible.

A third theme state exists that restores the light palette explicitly; it shares
every value with the light theme and introduces no new tokens.

### Named Rules

**The One Accent Rule.** Verdigris appears on roughly one element per viewport: a
hovered link, the active nav item, a focused field, a ranking numeral. It is never
a section background, never a gradient, never a decorative fill. Its scarcity is
what makes a hovered link mean "this is live".

**The Translucent Border Rule.** Dark-theme borders are alpha-white, never
solid grey. A solid `#3a4247` hairline looks correct on the panel and wrong on
the ground; the alpha value does not.

## Typography

**Display / Body / Label Font:** Inter, with a CJK-aware fallback chain —
`PingFang SC`, `Microsoft YaHei`, `Noto Sans CJK SC`, `Hiragino Sans GB`, then
the system stack.
**Serif:** Georgia / Songti SC / Noto Serif CJK SC.
**Mono:** `ui-monospace`, SF Mono, Menlo, Consolas.

**Character:** One sans does almost all the work, chosen because it has to serve
Latin and CJK in the same line without one looking borrowed. The serif is not a
second voice — it is reserved for a single element and its scarcity is the whole
point.

### Hierarchy

- **Display** (400, `clamp(30px, 6vw, 48px)`, 1.08): Board headings. Note the
  deliberate inversion — the board's `h1` is a 13px/700 eyebrow and this display
  size sits under it in a `<p>`. The small, loud label above the large, quiet
  title is the site's signature typographic move.
- **Headline** (700, `clamp(28px, 5vw, 40px)`, 1.28): Article titles.
- **Title** (600, 18px, 1.3): Card titles, single line with ellipsis.
- **Body** (400, 16px, 1.75): Site body. Article prose is 17.5px at the same 1.75
  leading, capped at a 72ch measure.
- **Label** (400, 13px, 1.5): The 11–13px band that carries all metadata —
  captions, chips, pagers, bylines, stats. Weight varies (600–700 for eyebrows
  and badges) but the size band does not.

### Named Rules

**The CJK Floor Rule.** Body text is 16px and never smaller. Chinese glyphs
occupy the full em box, so a 15px CJK line is below the comfortable reading
floor — especially in a mixed Latin/numeric article. This is why the site does
not use the 15px body size that Latin-only sites default to.

**The One Serif Rule.** Exactly one element uses the serif: the ranking numeral
on a trending card (20px/700, tabular figures). A digit has no CJK to clash
with, so it is the one place a serif is safe. Introducing a serif heading or pull
quote breaks the rule and the reason behind it.

**The Leading List Rule.** Text smaller than 16px must declare its own
line-height (1.5) rather than inherit the body's 1.75. At 13px, 1.75 produces a
23px line box and a visible gap between a label and the thing it labels. The
stylesheet carries an explicit selector list for this; anything new and small
joins it.

## Layout

A single centred column capped at `1180px` with `24px` side padding, held at
every viewport above ~1300px — a wider monitor buys more margin, never more
content width. This cap is load-bearing for the header: the nav, the category
filter and search share one 58px row, and the column cannot be widened to give
them room, so any new header element must displace something rather than grow.

The header is sticky with a translucent veil (`#faf9f6e8`) and a 12px backdrop
blur, so content passes visibly beneath it. It is 58px tall and its inner row uses
an 18px gap.

Cards sit in an auto-fill grid, `minmax(300px, 1fr)` with a 16px gap, which
yields three or four columns at the container width. Cards are equal-height with
a cover cropped to fill, a single-line ellipsised title, and metadata pinned to
the bottom.

Board pagination is 12 per page, with the page number at the left edge and both
controls at the right.

**Responsive:** six breakpoints — 1200, 900, 820, 720, 700 and 560px. The
decisive one is 700px, where the header has to give up its single-row arrangement
entirely. Below it, secondary controls shrink before content does: the theme
switch is the first element to lose width, because the search box and the
category filter both need their full size to stay usable.

### Named Rules

**The Fixed Column Rule.** Never widen the content column to solve a fit problem.
The 1180px cap is deliberate; a horizontal squeeze in the header is a signal that
something must be removed or prioritised, not that the column should grow.

## Elevation & Depth

The system is **flat with exactly one shadow**. There is no elevation scale, no
resting shadow on any card, and no hover lift. Depth is conveyed entirely by two
mechanisms: the panel colour sitting one step lighter than the paper ground, and
hairline borders doing the drawing.

### Shadow Vocabulary

- **Menu Float** (`0 8px 24px rgb(0 0 0 / 0.12)`, `0 10px 30px rgb(0 0 0 / 0.5)`
  in dark): Reserved exclusively for genuinely floating layers — the theme and
  language menus. It is the only shadow in the stylesheet.

### Named Rules

**The Flat-By-Hairline Rule.** Cards, panels and inputs rest flat and stay flat.
A hover changes the border colour and nothing else — no lift, no shadow, no
scale, no transform. If a new component seems to need depth, it needs a border
first.

**The Two-Shadow Rule.** Shadows exist only on layers that physically overlay
content (menus). Nothing that occupies document flow may cast one.

## Shapes

A three-step radius scale plus a pill, applied by element class rather than by
nesting.

- **Surface** (10px): Cards and major containers.
- **Button** (8px): Buttons.
- **Control** (7px): Inputs, selects, nav items, the ranking numeral plate.
- **Pill** (999px): Category chips, tags, badges, the save button — anything
  that classifies rather than acts.
- **Circle** (50%): Avatars and the letter-avatar fallback.

Borders are a uniform 1px hairline. There are no doubled borders, no inset
shadows, no clipped or angled corners, and no decorative geometry anywhere. The
one bespoke shape is the ranking numeral: a small plate pinned to the bottom-left
of a card cover, on a 82%-opacity paper scrim so it stays legible over any image.

## Components

### Buttons

Restrained, structural, never loud. A resting button is a hairline border over a
sunken panel fill.

- **Shape:** 8px radius, `8px 16px` padding, 14px label.
- **Secondary:** Panel-sunk fill, ink text, hairline border. This is the default
  and the majority case.
- **Primary:** Verdigris fill, white label, 600 weight. Used sparingly — admin
  actions, not reading actions.
- **Hover:** The secondary's border and text shift to verdigris; the primary
  brightens by 8% rather than changing hue.
- **Focus:** The standard ring (below).

### Focus Ring

One ring for every focusable element, public and admin alike. A 2px verdigris
outline drawn **inset** — `outline-offset: -1px` — on `:focus-visible`.

- **Shape:** 2px solid accent, `-1px` offset. No radius is declared; the outline
  already follows its own element's radius, so a 7px input draws a 7px ring and
  a square link draws a square one.
- **Trigger:** `:focus-visible`, not `:focus`. Tabbing to a link rings it; a
  mouse click does not. A text input *does* ring on click, which is correct —
  the caret is in there and the reader needs to see where it went.
- **Second cue:** Inputs and selects additionally darken their border to
  verdigris-dim. That is a supplementary signal for a reader already looking at
  the field, never a replacement for the ring.
- **Why inset:** `.card-article` is `overflow: hidden` because that is what
  clips its cover image to the radius, so an outset ring around the card's title
  link is cut off on both sides and reads as a pair of brackets. Inset is drawn
  inside the border box and is never clipped by any ancestor.
- **Exception:** The theme and language switches redirect the ring from their
  visually-hidden radio onto the visible option. That is structural, not a
  second standard — the offset still matches.

### Cards

The workhorse; the site is a grid of them.

- **Corner style:** 10px surface radius, `overflow: hidden` so the cover crop is
  clipped to it.
- **Background:** Panel, with a 1px hairline border. No shadow, ever.
- **Cover:** Cropped to fill the card width in a fixed-height box, sitting flush
  to the top and side borders. The height is pinned at 150px rather than
  expressed as an aspect ratio, and the reason is recorded in the code: a ratio
  resolves to a different height in each column, so the same card was 205px tall
  in the two-column board and 260px in the wide Editor's Pick grid. Fixed height
  means the box's height *is* the crop, and every card in every grid shares one.
- **Hover:** Border colour only, 0.15s. The card does not move.
- **Content:** Single-line ellipsised title at 18px/600, a 13.5px excerpt at
  1.55 leading, and 12px metadata pinned to the bottom so a row of cards shares
  a baseline even when excerpt lengths differ.

### Chips and Tags

Taxonomy, always as a pill.

- **Shape:** 999px radius, `4px 11px` padding, 13px label, 1px hairline border,
  transparent fill.
- **Resting:** Hairline border, ink-muted text.
- **Hover:** Text steps up to ink and the border to the faint tier — the same
  two-step lift the cards use, at a smaller amplitude.

### Inputs and Selects

- **Shape:** 7px radius, `6px 11px` padding, panel fill, 1px hairline border.
- **Focus:** The standard ring, plus a border shift to verdigris-dim.
- **Select:** Same geometry, with a bespoke inline-SVG chevron set at 12px on the
  right — no native appearance, no icon font.

### Navigation

- **Shape:** 7px radius, `6px 9px` padding, 14px label, 6px icon gap.
- **Resting:** Ink-muted text, transparent fill.
- **Hover:** Sunken-panel fill, text to ink.
- **Active:** Verdigris fill with white label — the single loudest element in the
  header, and the only place the accent appears at rest.

### The Ranking Numeral (signature)

The system's one flourish and its one serif. A 20px/700 Georgia numeral with
tabular figures, in verdigris, on a small plate pinned `10px / 8px` inside the
bottom-left of a trending card's cover. The plate is paper at 82% opacity, so the
numeral stays legible over any image without a solid block being introduced. It
is the only element where serif, accent colour and a scrim all appear at once.

## Do's and Don'ts

### Do:

- **Do** draw structure with a 1px hairline before reaching for any fill, shadow
  or gap to separate two things.
- **Do** keep verdigris to roughly one appearance per viewport — a hover, an
  active nav item, a focus edge, a ranking numeral.
- **Do** set body text at 16px minimum and article prose at 17.5px/1.75, with a
  72ch measure.
- **Do** give any text under 16px its own 1.5 line-height instead of inheriting
  the body's 1.75.
- **Do** use the pill radius for anything that classifies, and the surface
  radius for anything that contains.
- **Do** build the dark theme from its own tokens, with alpha-white borders and
  `#000` as the accent's contrast colour.
- **Do** keep new header elements inside the 1180px column and displace
  something to make room.
- **Do** inherit the focus ring. Any focusable element gets it automatically; a
  new control needs no focus styling of its own.

### Don't:

- **Don't** let a card, panel or button lift, scale, shadow or move on hover.
  Change the border colour and stop.
- **Don't** use the serif anywhere except the ranking numeral.
- **Don't** let body text drop below 16px, even for a Latin-only screen.
- **Don't** introduce a second accent, a gradient, a glass treatment, or a
  decorative fill.
- **Don't** build toward a dashboard: no dense metric panels, no telemetry
  aesthetic, no sci-fi blue gradients, no chrome implying a running machine.
- **Don't** use an emoji or a font icon as a UI glyph. Icons are vendored SVG
  paths; the only Unicode characters permitted in the interface are typographic
  marks that *are* the label (arrows, stars, dashes, ellipses).
- **Don't** add a resting shadow to anything in document flow.
- **Don't** suppress a focus outline. `outline: none` on a focusable element
  takes the ring away from a keyboard user and cannot be traded for a border
  colour change — that colour is close to invisible against the hairline it
  borders, which is exactly why this system had to be unified.
- **Don't** make the ring outset. An outset ring is clipped by any
  `overflow: hidden` ancestor, and the card is one of them.

# `sanad.ui.Cards`

The design prototype's card vocabulary (`docs/component/Cards.dc.html`) as a component: a
screen of numbers is composed from a fixed set of card kinds arranged in sections, so every
console looks like one product. Sections carry the grid —
`repeat(auto-fit, minmax(min(100%, <min>px), 1fr))` — so columns reflow without per-screen media
queries. Clicks are delegated: a card or row names a handler by `action`, the component keeps no
closure per card. No server calls; icons come from the kit's own set (`_kit/icons.js` `ico`).

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `wrapper` | jQuery \| HTMLElement | — | Emptied and given `sanad-kit wa` (+ `wa--compact`). |
| `sections` | `Section[]` | `[]` | See below. |
| `density` | `"comfortable"` \| `"compact"` | `"comfortable"` | The prototype's two scales. |
| `handlers` | `{[name]: (key, event) => void}` | `{}` | Called when an element with `data-action="<name>"` is clicked; `key` is the card/row `key` or `null`. |

**Section** — `{title?, sub?, min = 240, cards: Card[]}`. `min` (px) is the narrowest a card may
be; it sets `--wa-cards-min` on the grid.

**Card (common)** — `kind` (`stat` default, `kpi`, `panel`, `alert`, `html`), `key`, `label`,
`value`, `note`, `tone` (`ok` \| `warn` \| `danger` \| `info` \| `muted` \| `pri`; anything else →
`muted`), `icon` (kit icon name, drawn in a toned tile), `span` (columns to span, sets
`--wa-card-span`), `action` (handler name; makes `stat`/`kpi` a `<button>`).

| Kind | Extra keys | Renders |
|---|---|---|
| `stat` | `dot` (`false` hides), `rtl` (value `dir="auto"` instead of `ltr`) | dot + label, figure, note, tile at the end |
| `kpi` | `series` (numbers, ≥2 points) | label + tile on top, large figure, note and 60×18 sparkline |
| `panel` | `rows[]`, `foot` | title (`label`) + `note`, rows, foot text |
| `alert` | `cta`, `ctaStyle` (`"solid"` → primary, else secondary) | toned tile, bold label, note, CTA button (only when `cta` and `action`) |
| `html` | `html` (raw, **not escaped**) | caller markup inside a card surface |

**Panel row** — `{key?, label, sub?, value?, tone?, dot?, avatar?, bar? (0–100), badge?, badgeTone?, action?}`.
A row with `action` becomes a `<button>`; a dot shows only when `tone` is set and `dot !== false`.

## Methods

- `set_sections(sections)` — replace sections and re-render.
- `render()` — full re-render of the wrapper.
- `destroy()` — unbind clicks and empty the wrapper.

## Events and callbacks

One delegated `click` on `[data-action]` → `handlers[name](key, event)`. No realtime events.

## Server calls

None.

## Usage

```js
const cards = new sanad.ui.Cards({
  wrapper: $host,
  density: "compact",
  handlers: { open_failed: () => frappe.set_route("List", "Error Log") },
  sections: [
    { title: __("Today"), min: 200, cards: [
      { kind: "stat", label: __("Sent"), value: "1,240", icon: "check", tone: "ok" },
      { kind: "stat", label: __("Failed"), value: "80", tone: "danger", icon: "error", action: "open_failed" },
      { kind: "kpi", label: __("Rate"), value: "42/min", series: [3, 8, 5, 12, 9] },
    ] },
    { min: 420, cards: [{ kind: "panel", label: __("Funnel"), span: 2, rows: [
      { label: __("Left the device"), value: "1,180", bar: 95, tone: "ok" },
      { label: __("Arrived"), value: "900", bar: 76, tone: "ok", badge: __("76%") },
    ] }] },
  ],
});
cards.set_sections(next_sections); // on refresh
```

## CSS hooks

- Wrapper `sanad-kit wa` (+ `wa--compact`); inner `wa-cards wa-cards--<density>`.
- `wa-cards__section`, `__head`, `__title`, `__sub`, `__grid` (`--wa-cards-min`).
- `wa-card` with `--stat`, `--kpi`, `--panel`, `--alert`, `--html`, tone modifiers
  `--ok/--warn/--danger/--info/--pri/--muted`, `--click`; custom property `--wa-card-span`.
- Elements: `__body`, `__line`, `__dot(--tone)`, `__label`, `__value`, `__note`, `__tile(--tone)`,
  `__top`, `__figure`, `__foot`, `__spark`, `__phead`, `__ptitle`, `__rows`, `__row(--click)`,
  `__row-main`, `__av`, `__row-text`, `__row-label`, `__row-sub`, `__row-value`, `__bar`,
  `__bar-fill(--tone)`, `__pfoot`, `__alert-label`, `__cta`; badges use `wa-badge wa-badge--<tone>`.
- Tone colours come from `--wa-ok/-s/-i/-sb`-style palette tokens.

## Notes

- Figures are `sanad-tabular` and `dir="ltr"` (except `stat` with `rtl: true`).
- `alert` is `role="alert"` when `danger`, else `role="status"`; default icon by tone
  (`error` / `check` / `warn`).
- No loading/empty states of its own — callers render placeholder sections.
- Clickable cards and rows are real `<button type="button">` elements.
- Live use: `whatsapp_next/page/wa_functions_center/wa_functions_center.js` (four compact
  `stat` readings). The README's mention of `public/js/form/whatsapp_campaign.js` is stale — that
  file does not instantiate Cards.

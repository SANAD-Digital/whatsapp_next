# Cards

The design prototype's card vocabulary (`docs/component/Cards.dc.html`), ported. The prototype does
not invent a layout for each screen that shows numbers — it composes one out of a fixed set of card
kinds, which is why the home console, the queue and the functions centre look like one product.

| kind | what it is |
|---|---|
| `stat` | a reading on one line: dot, label, figure, note, icon tile at the end |
| `kpi` | a reading with room: label and tile on top, a large figure, a note and an optional sparkline |
| `panel` | a titled surface of rows — label, optional second line, an optional share bar, a figure, an optional badge |
| `alert` | a tinted strip: what is wrong, what it costs, and the verb that ends it |

Sections carry the grid. `min` is the narrowest a card in that section may be and the columns fall
out of `repeat(auto-fit, minmax(min(100%, min), 1fr))` — the prototype's own rule, which is why a
section of six readings becomes three and three on a laptop and one column on a phone with no
media query per screen.

## Usage

```js
frm.cards = new sanad.ui.Cards({
  wrapper: $host,
  density: "comfortable",              // or "compact" — the prototype's two scales
  handlers: { open_failed: () => frappe.set_route("List", "WhatsApp Log", { status: "Failed" }) },
  sections: [
    {
      title: __("How it is going"),
      min: 200,
      cards: [
        { kind: "stat", label: __("Recipients"), value: "1,240", note: __("everyone in the list"), icon: "users" },
        { kind: "stat", label: __("Failed"), value: "80", tone: "danger", icon: "error", action: "open_failed" },
      ],
    },
    {
      min: 420,
      cards: [{
        kind: "panel", label: __("The funnel"), span: 2,
        rows: [
          { label: __("Left the device"), value: "1,180", bar: 95, tone: "ok" },
          { label: __("Arrived"), value: "900", bar: 76, tone: "ok" },
        ],
      }],
    },
  ],
});
```

A card or a row names its handler by `action`; the component holds no closure per card, so a
section can be rebuilt from data on every refresh without leaking listeners. `span` makes a card
take more than one column of its section's grid.

## Live use
`public/js/form/whatsapp_campaign.js` — the campaign's Progress tab: a section of `stat` readings,
a `panel` whose rows are the stages of the funnel, and a second section for the audience.
Functions Center (`page/wa_functions_center/wa_functions_center.js`) — the prototype's four compact
`stat` readings (functions · active · calls · updates) as a `PageHeader` block, two of them clickable.

## Design gate
- Tone is never colour alone: every toned card carries its tone in a dot, a tile or a badge **and**
  in its own words, and the four quartets come from the palette, whose tone inks are made to be
  read on their own soft surfaces.
- A figure is tabular and always LTR — a number does not mirror in Arabic, and a column of figures
  that jitters as digits change is unreadable.
- A clickable card is a real `<button>` with a focus ring, not a `div` with a click handler.
- The grid rule is one line and there is no media query per screen, so a section that gains a card
  reflows instead of breaking.

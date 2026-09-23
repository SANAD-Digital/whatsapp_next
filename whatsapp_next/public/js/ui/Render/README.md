# Render

The kit's presentation layer: one place that decides how a **value**, a **record** or a **link**
looks, so the same data reads the same way in a table cell, a drawer, a picker row and a card.

The same record may need more than one representation depending on where it appears and how much
room there is. `Render` gives every kind of record five display levels, from the reference brief in
`docs/component/Overlay-Panel-drawr-ui-renderer-reference/`:

| Density | Where | Shows |
|---|---|---|
| `inline` | table cells, links inside a sentence | small media · name · one secondary fact |
| `compact` | dense lists, quick results | media · name · type · status or value |
| `row` | drawer lists, pick results | media · name · two or three facts · status/value · action |
| `card` | when the record needs space or has a picture | media · name · description · status · value · facts |
| `hero` | when the record is the subject of the screen | large media · title · status · values · facts · actions |

Kinds decide *which* facts get the weight: a **person** leads with a picture and a way to reach
them, an **item** with its picture and price, a **document** with its number, party and amount (or
progress, for tasks), a **file** with its type, size and actions. `generic` is the fallback.

## Usage

### Values

```js
sanad.ui.Render.value(doc.amount, df, doc, { density: "card" });   // 1,250.00 ر.س, tabular, LTR
sanad.ui.Render.value(doc.percent_complete, df, doc, { variant: "progress" }); // bar + number
sanad.ui.Render.value(doc.is_active, df, doc);                     // "Yes" badge, never a checkbox
sanad.ui.Render.value(doc.modified, df, doc, { variant: "relative" }); // "3 days ago"
```

One renderer per fieldtype, each `(value, df, doc, opts) => html`, with `opts.density` and
`opts.variant` (`badge`, `strong`, `progress`, `relative`, `readable`, `number`, `text`).
Covered: Currency · Int/Float · Percent · Date · Datetime · Time · Duration · Check · Select ·
Rating · Link · Dynamic Link · Phone · Attach · Attach Image · Table MultiSelect · Geolocation ·
Code · JSON · Text Editor · HTML · the long-text family · Color · `Data` with `Phone`/`Email`/`URL`
options. Anything else falls back to `frappe.format`.

Add or replace one:

```js
sanad.ui.Render.field("Currency", (value, df, doc, o) => `…`);
```

### Records

```js
// HTML only
$cell.html(sanad.ui.Render.entity(doc, { doctype: "Contact", density: "inline" }));

// Rendered and wired (quick actions, row click)
sanad.ui.Render.mount($el, doc, {
  doctype: "Contact",
  density: "row",
  actions: [{ icon: "es-line-call", label: __("Call"), on_click: (d) => … }],
  on_click: (d) => sanad.ui.Drawer.open({ doctype: "Contact", name: d.name }),
});

// A link you only have the name of: fetch the fields its view model needs, then render
sanad.ui.Render.load_into($el, "Contact", doc.contact, { density: "row" });

// Many at once
sanad.ui.Render.list($el, rows, { doctype: "Contact", density: "compact" });
```

## Configuration — three levels

1. **Nothing.** The view model is derived from the DocType's meta: title field, image field,
   indicator rules, the first currency field, the `in_list_view` / `bold` fields.
2. **A profile** — name which field plays which part. Every entry is a fieldname, a
   `{field, icon, ltr, variant, label}` spec, or a function of the doc (give it a `field` too when
   it reads one, so the same value is not repeated elsewhere):

   ```js
   sanad.ui.Render.profile("WhatsApp Log", {
     icon: "es-line-chat",
     title: { field: "display_name", value: (doc) => doc.display_name || doc.phone_e164 },
     lines: [{ field: "phone_e164", ltr: true, icon: "es-line-call" }],
     value: false,            // this record has no headline amount
     facts: ["device", "message_type"],
     actions: [{ icon: "es-line-chat", label: __("Quick send"), on_click: … }],
   });
   ```

   Keys: `kind`, `icon`, `tone`, `shape`, `emphasis`, `title`, `title_ltr`, `lines`, `subtitle`,
   `description`, `image`, `status`, `value`, `progress`, `facts`, `actions`, `href`, `after(vm, doc)`.
   `false` switches a part off.
3. **A renderer** — take over one kind at one density:

   ```js
   sanad.ui.Render.register("person", { card(vm) { return `…`; } });
   sanad.ui.Render.map({ "WhatsApp Number": "person" });
   ```

All three can come from the host app in one call, next to its API map:

```js
sanad.ui.configure({
  api,
  renderers: { doctypes: {...}, profiles: {...}, kinds: {...}, fields: {...} },
});
```

## Pieces

`sanad.ui.Render.parts` exports the blocks renderers are assembled from — `avatar`, `thumb`,
`chip`, `chips`, `fact`, `progress`, `stars`, `dl`, `code`, `actions`, `bind_actions` — so a custom
renderer or a page can build the same shapes instead of inventing new ones.

## Live use
Every `DataList` cell (typed values), the `Drawer` document layout (identity, quick facts, related
records, details), `Collection` (every view), and the Outbound and Inbound message drawers. The
host app declares its own profiles in its setup file, beside its API map.

## Design gate
- Hierarchy: one title, one status, at most one headline value; secondary facts are 11 px and grey.
- Colour is never the only signal — badges carry a label, progress carries its number, a boolean
  reads "Yes" / "No" rather than a checkbox that looks editable.
- Icons are scanning aids, not decoration: one per fact, from the fieldtype or the field's meaning.
- Mixed text: phones, IDs, amounts and dates are `dir="ltr"` inside Arabic rows; free text uses
  `dir="auto"` and `unicode-bidi: plaintext`, so it reads correctly and still starts where the
  panel starts.
- An `<svg>` is a replaced element: a bare icon inside a flex row would stretch, so every kit icon
  is pinned with `flex: none`.
- Targets are ≥ 32 px with ≥ 8 px gaps; quick actions carry `aria-label` and a `title`.

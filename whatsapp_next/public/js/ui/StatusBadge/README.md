# StatusBadge

A status pill coloured by the DocType's own indicator rules (`frappe.get_indicator`, so
`listview_settings[doctype].get_indicator`, workflow states and docstatus all apply) with a gray
fallback. The label is always rendered — colour is never the only signal — and green / red / amber
tones add a small icon (accessibility finding: "don't convey information by colour alone").

## Usage

```js
// Inline (formatters, drawers, cards)
$cell.html(sanad.ui.StatusBadge.html({ label: __("Connected"), colour: "green" }));

// Meta-driven: resolves label + colour from the DocType's indicator rules
new sanad.ui.StatusBadge({ wrapper: $el, doctype: "WhatsApp Device", doc });

// Column formatter in listview_settings
formatters: {
  status(value, df, doc) {
    return sanad.ui.StatusBadge.html({ label: __(value), colour: sanad.ui.indicator_for(doc.doctype, doc).colour });
  },
},
```

Options: `wrapper`, `doctype`, `fieldname` (default `status`), `doc` | `value`, `colour`, `label`,
`icon` (default `true`), `size` (`sm` | `md`), `title`. `refresh(doc)` re-renders.

Tones: Frappe colours map to the Espresso triplets green / blue / amber / red / gray / cyan /
violet / pink (`sanad.ui.tone`). Only `--surface-*`, `--ink-*`, `--outline-*` tokens are used.

## Live use
`WhatsApp Log` list (Outbound) — `public/js/listview/whatsapp_log_list.js` status column and the
Drawer header; `WhatsApp Number` list `link_status` column.

## Design gate
- Colour + label + icon (WCAG 1.4.1); `title` for truncated labels.
- 12 px text is allowed for badges only (secondary information next to a 13–14 px row).

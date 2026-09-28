# `sanad.ui.AttachMenu`

A composer's "+" popover: a 3-column grid of attachment kinds — image, video, document, voice note,
location, contact card — each in its tone. A file kind opens Frappe's own `frappe.ui.FileUploader`
(private, restricted to that family); location and contact are a second step inside the same
popover (latitude/longitude/place name, or a contact search). The picked value is handed to the
host, which also draws the chip above its field with the static `chip_html()`. The constructor
opens the popover immediately; each click on "+" makes a new instance.

**Portability:** no server calls of its own and no app-specific keys; the contact search is the
host's. The stylesheet uses the app's `--wa-*` palette tokens (`public/scss/_tokens.scss`), which
live outside the kit.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `anchor` | jQuery \| HTMLElement | — | The "+" button; the popover is placed above it (below if there is no room) and focus returns to it on Esc or after a location/contact pick. |
| `kinds` | string[] | all six | Kinds the host can send: `image`, `video`, `document`, `audio`, `location`, `contact`. Others are drawn disabled. |
| `reasons` | `{[kind]: string}` | — | Title shown on a disabled kind (fallback "Not available here"). |
| `search_contacts` | `(txt) => Promise<[{name, label, phone}]>` | — | Needed for the contact step; debounced 220 ms, first 20 rows shown. |
| `on_pick` | `(value) => void` | — | Required. Receives the picked value (below). |
| `on_close` | `() => void` | — | Called on every close, including just before the uploader opens. Not in the JSDoc/README. |

**Picked value** (only the keys relevant to the kind are set):

- file kinds: `{kind, attachment (file_url), file_name}`
- location: `{kind: "location", location: {latitude, longitude, name|null}}`
- contact: `{kind: "contact", contact (name), contact_label}`

## Methods

- `close(refocus = false)` — remove the popover and listeners; refocus the anchor when `true`.
- `go(step)` — switch to `"menu"`, `"location"` or `"contact"` and re-place.
- `pick(kind)` — act as if the kind was clicked.
- `place($anchor)` — reposition against the anchor, clamped to the viewport (RTL-aware).
- Static `AttachMenu.icon(kind)` — the kind's inline SVG (document icon as fallback).
- Static `AttachMenu.label(kind)` — the kind's translated label.
- Static `AttachMenu.chip_html(value)` — the chip HTML for a picked value ("Image · receipt.jpg ×");
  empty string for no value. The host binds the clear button, `[data-attach-clear]`.

## Events and callbacks

- `on_pick(value)`, `on_close()`.
- Listens to `mousedown` on `document` (capture) to close on an outside click, `keydown` Escape
  on the popover, and `resize.sanad-am` on `window`; all removed on close. No realtime.

## Server calls

None. File kinds go through `frappe.ui.FileUploader` (`make_attachments_public: false`,
`allowed_file_types` `image/*`, `video/*`, `audio/*`; any file for a document).

## Usage

```js
$plus.on("click", (ev) =>
  new sanad.ui.AttachMenu({
    anchor: ev.currentTarget,
    kinds: ["image", "video", "document", "audio", "contact"],
    reasons: { location: __("A location goes to one conversation at a time.") },
    search_contacts: (txt) => my_search(txt),        // → [{name, label, phone}]
    on_pick: (v) => { draft.attach = v; redraw(); },
  })
);
$slot.html(sanad.ui.AttachMenu.chip_html(draft.attach));
$slot.find("[data-attach-clear]").on("click", () => { draft.attach = null; redraw(); });
```

## CSS hooks

- Root `.sanad-kit.sanad-am[role=dialog]`, appended to `body` and positioned with inline
  `left`/`top`.
- Menu: `__grid`, `__item[data-kind]`, `__icon--{pri|nf|wn|ok|dg|muted}`, `__label`.
- Steps: `__form`, `__title`, `__row`, `__fld`, `__link[data-here]`, `__error`, `__actions`,
  `__btn` (`--pri`), `__search`, `__results`, `__opt[data-name]`, `__none`.
- Chip (outside the popover): `.sanad-am__chip--{tone}`, `__chip-icon`, `__chip-text`,
  `__chip-x[data-attach-clear]`.

## Notes

- Tones by kind: image `pri`, video `nf`, document `wn`, audio `ok`, location `dg`, contact `muted`.
- Location validates −90..90 / −180..180 before closing and reports in `__error` (`role="alert"`).
  "Use my current location" appears only when `navigator.geolocation` exists.
- Contact step shows "Loading…", "No matching contacts." or the search error's message. If the
  host omits `search_contacts`, the resulting TypeError's message is what is shown — pass it, or
  leave `contact` out of `kinds`.
- Focus moves to the first enabled control on open and on each step; every item has a visible
  label; the chip's × has an `aria-label`. Numbers/phones are `dir="ltr"`.
- **Live use:** `whatsapp_next/page/wa_simulator/wa_simulator.js` (the composer "+" and chip) and
  `public/js/ui/BulkSend/index.js` (the bulk window's "+").

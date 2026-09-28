# `sanad.ui.ListStatsCard`

A row of live number cards, prepended to a Desk list's `listview.$frappe_list` or appended to any
wrapper. Each card's value comes from a `ui.call` key or function (`method`), a `frappe.db.count`,
a `SUM` aggregate through `frappe.db.get_list`, or a static `value`. Cards show a skeleton while
loading and an inline error on failure. An interactive card either runs `onclick` or opens a
`frappe.ui.Dialog` listing rows with per-row action buttons (optionally behind
`sanad.ui.ConfirmDialog`). It refreshes on an interval and/or on realtime events.

**Portability:** no DocType, field name or API key lives in the component; everything comes from
the card specs.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `listview` | ListView | — | Mount above the result rows; also refreshes on the page's `show` and stops the timer on `hide`. |
| `wrapper` | jQuery \| HTMLElement | — | Mount point when there is no `listview`. |
| `cards` | Card[] | `[]` | The cards (below). |
| `layout` | `"row"` \| `"kpi"` | `"row"` | `kpi`: KPI cards (icon in a tinted square, label, big number, sub-text; 4 / 2 / 1 per row). |
| `refresh_seconds` | number | — | Interval refresh; skipped while the tab is hidden, the element is not visible, or the modal is open. |
| `events` | `{[event]: (data) => void}` | `{}` | Realtime events → handlers, called with `this` = the card set (typically `this.refresh(true)`). |

**Card spec**

| Key | Type | Meaning |
|---|---|---|
| `key`, `label` | string | Identity and visible label (required). |
| `icon`, `tone` | string | Icon name; tone for icon square and value (`ui.tone()` maps it to `sanad-tone--*`). |
| `method` | string \| `() => Promise` | API key (called with `args`, silent) or a function — lets several cards share one call. Resolves to a number, `{value, tone}` or an array (its length). |
| `args` | object \| `() => object` | Arguments for a string `method`. |
| `count` | `{doctype, filters}` | `frappe.db.count`. |
| `sum` | `{doctype, field, filters}` | `SUM(field)` via `frappe.db.get_list`. |
| `value` | any \| `() => any` | Fallback static value (not in the JSDoc). |
| `format` | `(value, raw) => string` | Display text; default `ui.format_int(value \|\| 0)`. |
| `sub` | string \| `(value, raw) => string` | Line under the value. |
| `onclick` | `(card, value, raw) => void` | Makes the card interactive. |
| `modal` | object | Makes the card open a rows dialog (below). `onclick` wins if both are set. |

**`modal`:** `title` (default the card label), `method` (default the card's `method`), `args`,
`size` (default `"large"`), `empty_text`, `columns[{fieldname, label, format?(value, row)}]`,
`row_actions[{label, icon?, method?, args?(row, {reason}), handler?(row, {reason}),
confirm?: true | ConfirmDialog options (+ impact_of(row)), condition?(row),
success_message?}]`. The method may return an array or `{rows}`. An action needs `method` or
`handler`; a `method` action defaults to `{name: row.name}` args and gets `reason` from the
confirmation when present.

## Methods

- `refresh(force = false)` — fetch every card; calls within 2 s are skipped unless `force`.
  Restarts the interval timer. Returns a Promise.
- `open_modal(card)` — open a card's rows dialog; returns the Dialog.
- `start_timer()` / `stop_timer()` — control the interval refresh.
- `destroy()` — stop the timer, unsubscribe realtime handlers, unbind page events, remove.

`values[key]` holds the last `{raw, value}` (or `{error}`); `$el` is the root.

## Events and callbacks

- `frappe.realtime.on(event, handler)` for each `events` entry on mount; `off` on `destroy()`.
- With `listview`: `show.sanadstats` → `refresh()`, `hide.sanadstats` → `stop_timer()` on
  `listview.page.wrapper`.
- Card `onclick`, `format`, `sub`, `args`; modal `row_actions` `handler`/`args`/`condition`.
- Closing the modal (`hidden.bs.modal`) forces a refresh; a successful row action reloads the rows
  and forces a refresh.

## Server calls

| Call | When |
|---|---|
| `ui.call(card.method, card.args)` (silent) | Card refresh, when `method` is a string. |
| `frappe.db.count` / `frappe.db.get_list` | Card refresh for `count` / `sum`. |
| `ui.call(modal.method \|\| card.method, modal.args)` (silent) | Opening the modal, and Retry. |
| `ui.call(action.method, args)` | A row action without `handler`; Toast on success/error. |

No keys of its own.

## Usage

```js
new sanad.ui.ListStatsCard({
  listview,
  layout: "kpi",
  refresh_seconds: 60,
  events: { "wa:queue:progress": function () { this.refresh(true); } },
  cards: [
    { key: "open", label: __("Open"), icon: "es-line-inbox", count: { doctype: "ToDo", filters: { status: "Open" } } },
    { key: "sending", label: __("Sending now"), method: "campaigns.get_sending_now", tone: "green",
      modal: {
        columns: [{ fieldname: "campaign_name", label: __("Campaign") }],
        row_actions: [{ label: __("Pause"), method: "campaigns.pause", confirm: { title: __("Pause this campaign?") } }],
        empty_text: __("No campaign is sending right now"),
      } },
  ],
});
```

## CSS hooks

- Root `.sanad-kit.sanad-stats.sanad-stats--{row|kpi}[role=group]`.
- Card `.sanad-stats__card[data-key]` (`--interactive`, `--error`), `__icon`, `__text`, `__label`,
  `__value`, `__sub`, `__error`, `__chevron`; tones via `.sanad-tone--*`.
- Modal: `.sanad-kit.sanad-stats-modal.sanad-sheet` on the dialog wrapper, `__table`
  (`.sanad-table`), `__actions`.

## Notes

- **States:** `ui.skeleton` in each value until it resolves; failure shows "Could not load" with
  `role="alert"` and the reason in a visually hidden span. The modal uses `sanad.ui.EmptyState`
  (loading, empty with `empty_text`, error with Retry).
- **Keyboard/ARIA:** interactive cards are `role="button"` + `tabindex="0"`, Enter/Space activate;
  no per-card `aria-live`.
- The chevron is mirrored with a `[dir="rtl"] … transform: scaleX(-1)` rule in `style.scss`.
- **Live use:** `public/js/listview/whatsapp_inbound_message_list.js` (four KPI cards sharing one
  `messages.get_inbound_summary` call) and, indirectly, `public/js/ui/PageHeader/index.js` (its
  `stats` option builds a `kpi` ListStatsCard).

# `sanad.ui.PageHeader`

The screen header above a Desk list or on a custom page: an H2 title and one-line description,
the primary button at the inline-end of the title row, optional secondary buttons (with a count
pill), a KPI row (a `sanad.ui.ListStatsCard` in `kpi` layout), an optional banner (tone + icon +
text + one action, static or loaded) and caller-rendered **blocks** that re-render on realtime
events. On a list it mounts as the first child of `listview.$frappe_list` (above the FilterBar)
and, when `primary` is given, clears Frappe's own "+ Add" and keeps it cleared across renders.
Portable: every label, count source and event name is the caller's.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `listview` | Desk ListView | — | List mode: prepend to `listview.$frappe_list`, refresh on page `show`. |
| `wrapper` | jQuery \| HTMLElement | — | Page mode mount point (the header is prepended). |
| `title` | string | — | H2 title. With neither `title` nor `description` the text block is removed. |
| `description` | string | — | One-line description. |
| `primary` | Action | — | Primary button (`btn-primary`); replaces Frappe's "+ Add". |
| `secondary` | `Action[]` | `[]` | Default buttons before the primary; `count` renders a tabular pill. |
| `stats` | `Object[]` | `[]` | ListStatsCard card specs; see `ListStatsCard.md`. Omitted/empty removes the KPI row. |
| `refresh_seconds` | number | — | Passed to ListStatsCard for KPI auto-refresh. |
| `banner` | Banner \| `(header) => Promise<Banner\|null>` | — | Static banner, or loader re-run on `refresh()`. A loader rejection shows a red banner with the error. |
| `blocks` | `Array<{key, render($el, header), events?}>` | `[]` | Custom sections; `render` may return a promise. Each re-renders (throttled 1.5 s) on its `events`. |
| `events` | `{[realtime_event]: (data, header) => void}` | `{}` | Realtime subscriptions owned by the header. |

**Action** — `{label, icon?, handler(header), roles?, perm?, condition?, count?}`. Rendered only
when `handler` is a function, the user has one of `roles`, has `perm` on `listview.doctype`
(list mode only) and `condition()` is truthy.

**Banner** — `{tone = "amber", icon?, text, action?: {label, handler(header)}}`. Default icons
per tone: amber alert-triangle, red alert-circle, blue/gray info, green success.

## Methods

- `refresh(force = false)` — re-run banner loader, blocks and KPIs; skipped within 2 s of the
  last refresh unless `force`.
- `set_banner(banner | null)` — show or hide the banner.
- `refresh_banner()`, `render_blocks()`, `render_block(block)` — partial refreshes.
- `get_block(key)` — the block's `<section>` jQuery element.
- `clear_frappe_primary()` — re-clear Desk's primary action (called automatically).
- `destroy()` — unbind realtime, list-render hook and page `show`, destroy KPIs, remove markup.
- Properties: `$el`, `stats` (the ListStatsCard, if any).

## Events and callbacks

- `frappe.realtime.on` for each key of `events` and each block's `events`.
- List mode: `ui.on_list_render` (keeps the header first and Frappe's primary cleared) and the
  page wrapper's `show.sanadpagehead` jQuery event → `refresh()`.
- Action/banner handlers receive the header instance.

## Server calls

None directly. KPI counts go through ListStatsCard; banner loaders and blocks make their own calls.

## Usage

```js
frappe.listview_settings["Sales Order"] = {
  onload(listview) {
    listview.sanad_header = new sanad.ui.PageHeader({
      listview,
      title: __("Sales orders"),
      description: __("Every order, its status and what is still to deliver."),
      primary: { label: __("New order"), icon: "es-line-add", perm: "create", handler: () => frappe.new_doc("Sales Order") },
      stats: [{ key: "open", label: __("Open"), icon: "es-line-inbox", count: { doctype: "Sales Order", filters: { status: "To Deliver" } } }],
      banner: () => frappe.xcall("my_app.api.status").then((s) => (s.paused ? { tone: "amber", text: __("Sending is paused.") } : null)),
      blocks: [{ key: "live", events: ["my_app:progress"], render: ($el) => frappe.xcall("my_app.api.live").then((rows) => $el.html(render(rows))) }],
    });
  },
};
```

## CSS hooks

- Root `<header class="sanad-kit sanad-pagehead">`.
- `__row`, `__text`, `__title`, `__desc`, `__actions`, `__primary`, `__count`, `__stats`,
  `__banner` (+ `sanad-tone--<tone>`), `__banner-icon`, `__banner-text`, `__banner-action`,
  `__blocks`, `__block[data-key]`.
- Shared primitives shipped in this stylesheet for blocks and DataList cells: `.sanad-strip`
  (`--green`, `--amber`, `__title`, `__dot`, `__meta`, `__grow`, `__actions`, `__note`),
  `.sanad-strip-list`, `.sanad-strip-more`, `.sanad-progress` (`__label`, `__bar`, `__fill`,
  `__fail`, `--amber`).

## Notes

- Banner is `role="status"`, or `role="alert"` when the tone is red.
- Block errors render `sanad.ui.EmptyState` (`state: "error"`, with Retry for async failures).
- Empty title row / actions / stats containers are removed so no stray spacing remains.
- Live use: `public/js/listview/whatsapp_campaign_list.js`, `whatsapp_command_list.js`,
  `whatsapp_contact_group_list.js`, `whatsapp_notification_list.js`,
  `whatsapp_notification_alert_list.js`, `whatsapp_number_list.js`,
  `whatsapp_queue_item_list.js`, `whatsapp_template_list.js`; pages
  `whatsapp_next/page/wa_contacts/wa_contacts.js`, `wa_devices/wa_devices.js`,
  `wa_functions_center/wa_functions_center.js`, `wa_home/wa_home.js`.

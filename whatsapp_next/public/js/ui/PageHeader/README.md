# PageHeader

The prototype's screen header above a Desk list (or on a custom page): an H2 title with a
one-line description, the primary button at the inline-end of the title row (Desk `btn-primary`;
Frappe's own "+ Add" primary is cleared and kept cleared), optional secondary buttons (with a
count pill), a KPI row rendered by ListStatsCard in its `kpi` layout (icon in a tinted square,
label, big tabular number, sub-text — 4 per row, 2 on tablets, 1 on phones), an optional banner
(tone + icon + text + one action; static or loaded by a function) and custom **blocks** the caller
renders (strips, cards) that re-render on their realtime events. Mounted as the first child of
`listview.$frappe_list`, above the FilterBar. Portable: every label is the caller's, counts come
from ListStatsCard specs or the caller's API keys.

## Usage

```js
frappe.listview_settings["Sales Order"] = {
  onload(listview) {
    listview.sanad_header = new sanad.ui.PageHeader({
      listview,
      title: __("Sales orders"),
      description: __("Every order, its status and what is still to deliver."),
      primary: { label: __("New order"), icon: "es-line-add", perm: "create", handler: () => frappe.new_doc("Sales Order") },
      secondary: [{ label: __("Reports"), icon: "es-line-chart", count: 3, handler: () => frappe.set_route("query-report", "Sales Analytics") }],
      stats: [
        { key: "open", label: __("Open"), icon: "es-line-inbox", count: { doctype: "Sales Order", filters: { status: "To Deliver" } }, sub: __("Not yet delivered") },
        { key: "value", label: __("Open value"), icon: "es-line-money", tone: "blue", sum: { doctype: "Sales Order", field: "grand_total", filters: { docstatus: 1 } },
          format: (v) => frappe.format(v, { fieldtype: "Currency" }), sub: (v, raw) => __("Across {0} orders", [raw.count]) },
      ],
      banner: () => sanad.ui.call("queue.get_summary").then((s) => (s.paused_globally ? { tone: "amber", text: __("Sending is paused."), action: { label: __("Resume"), handler: resume } } : null)),
      blocks: [{ key: "sending", events: ["wa:campaign:status"], render: ($el, header) => sanad.ui.call("campaigns.get_sending_now").then((rows) => render_strips($el, rows)) }],
      events: { "wa:queue:progress": (data, header) => header.refresh() },
    });
  },
};
```

Options: `listview` | `wrapper`, `title`, `description`, `primary {label, icon?, handler, roles?,
perm?, condition?}`, `secondary[{label, icon?, count?, handler, roles?, perm?}]`, `stats[]`
(ListStatsCard card specs; `sub` text or `(value, raw) => text`), `banner` (object or
`() => Promise<banner|null>`), `blocks[{key, render($el, header) → void|Promise, events?}]`,
`events {name: (data, header)}`, `refresh_seconds`.
Methods: `refresh()` (banner + blocks + KPIs), `set_banner(b)`, `get_block(key)`, `destroy()`.
Shared primitives shipped with the component's stylesheet: `.sanad-strip` / `.sanad-strip-list`
(bordered item rows with a coloured inline-start rule) and `.sanad-progress` (sent / failed bar
with a tabular label) — used by campaign strips and by DataList progress cells.

## Live use
`WhatsApp Campaign` list — `public/js/listview/whatsapp_campaign_list.js` (title, "New campaign",
"Sending now" and "Scheduled" strips as blocks); `WhatsApp Contact Group` list —
`public/js/listview/whatsapp_contact_group_list.js` (title, "New group", three KPIs).

## Design gate
- One primary action per screen: Frappe's "+ Add" is cleared (`can_create = false`, re-cleared on
  every render) so two primaries never compete.
- Actions hidden by `roles` / `perm` / `condition` are not rendered (no dead buttons); ≥ 32 px targets.
- KPI cards reserve their value height (ListStatsCard) so the list below never jumps; colour is
  paired with the label and icon.
- The banner is `role="status"` (or `role="alert"` for red) so a paused state is announced once.
- Blocks render their own skeleton / empty / error through EmptyState and re-render on realtime
  events throttled (1.5 s), never on every message.
- Title row stacks and buttons go full-width under 768 px; strips wrap their actions.

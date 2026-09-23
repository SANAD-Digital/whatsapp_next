# ListStatsCard

A row of live number cards above a Desk list (inserted at the top of `listview.$frappe_list`) or
inside any wrapper. Each card's value comes from a configured API key (`method` → a number,
`{value, tone}` or an array whose length is the value), a `frappe.db.count`, or a `sum` aggregate
through `frappe.db.get_list`. Cards render a skeleton while loading and an inline "Unavailable"
error on failure; an interactive card either runs `onclick` or opens a `frappe.ui.Dialog` listing
the method's rows with per-row action buttons (each optionally behind a ConfirmDialog). Refresh
on an interval and/or on realtime events (`events: {name: handler}` — subscribed on mount,
unsubscribed on `destroy()`). Portable: no DocType or field name lives in the component.

## Usage

```js
frappe.listview_settings["Sales Order"] = {
  onload(listview) {
    listview.sanad_stats = new sanad.ui.ListStatsCard({
      listview,
      refresh_seconds: 60,
      events: { "wa:queue:progress": function () { this.refresh(); } },
      cards: [
        { key: "open", label: __("Open orders"), icon: "es-line-inbox",
          count: { doctype: "Sales Order", filters: { status: "To Deliver and Bill" } },
          onclick: () => listview.filter_area.add([["Sales Order", "status", "=", "To Deliver and Bill"]]) },
        { key: "value", label: __("Open value"), sum: { doctype: "Sales Order", field: "grand_total", filters: { docstatus: 1 } },
          format: (v) => frappe.format(v, { fieldtype: "Currency" }) },
        { key: "sending", label: __("Sending now"), method: "campaigns.get_sending_now", tone: "green",
          modal: {
            title: __("Sending now"),
            method: "campaigns.get_sending_now",
            columns: [
              { fieldname: "campaign_name", label: __("Campaign") },
              { fieldname: "sent_count", label: __("Progress"), format: (v, row) => `${v} / ${row.total_recipients}` },
            ],
            row_actions: [
              { label: __("Pause"), method: "campaigns.pause", args: (row) => ({ name: row.name }),
                confirm: { title: __("Pause this campaign?"), reason_field: true } },
              { label: __("Open"), handler: (row) => frappe.set_route("Form", "WhatsApp Campaign", row.name) },
            ],
            empty_text: __("No campaign is sending right now"),
          } },
      ],
    });
  },
};
```

Options: `listview` | `wrapper`, `cards[{key, label, icon?, tone?, method?, args?, count?,
sum?, value?, format?(value, raw), onclick?(card, value, raw), modal?: {title, method, args?,
columns[{fieldname, label, format?(value, row)}], row_actions[{label, icon?, method?,
args?(row, {reason}), handler?(row), confirm?: true | ConfirmDialog options (+ `impact_of(row)`),
condition?(row), success_message?}], empty_text?, size?}}]`, `refresh_seconds?`, `events?`.
Methods: `refresh()` (returns a promise), `destroy()`. `values[key]` holds the last `{raw, value}`.

## Live use
`WhatsApp Campaign` list — `public/js/listview/whatsapp_campaign_list.js` ("Sending now" card +
modal with Pause / Outbound log); `WhatsApp Contact Group` list — group count and members total.

## Design gate
- Reserved value height (`min-height`) so skeleton → number never shifts the list below.
- Interactive cards are real buttons for the keyboard (`role="button"`, `tabindex="0"`, Enter /
  Space) with the kit's global focus ring and a chevron affordance; no `aria-label` overrides the
  inner text, so the accessible name is "Sending now 3".
- No per-card `aria-live`: values refresh in the background without screen-reader chatter.
- Errors are inline and announced once (`role="alert"`): "Could not load" with the reason in a
  visually hidden span, never a hover-only `title`.
- Auto-refresh pauses while the page is hidden and while the card's modal is open.
- Tone is never the only signal: the label is always rendered next to the coloured value.
- Modal tables use the shared `.sanad-table` in a scroll wrapper; the modal is a `.sanad-sheet`
  on phones; row actions are ≥ 32 px.
- Decisions in row actions go through ConfirmDialog (`confirm.title` expected; fallback "{label}
  this row?"), results through Toast ("{label} done" fallback).

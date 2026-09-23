# BulkActions

Actions over the checked rows of a Desk list, registered in the list's own **Actions** menu
(Frappe shows it once rows are checked). Native mode calls the API once with `{names}`;
`per_name` mode loops the names calling the API with `{name}` behind a cancellable progress
dialog ("3 of 12 done · 1 failed"). Labels carry the count ("Resend failed (12)"), the selection
is capped (200 by default) with a clear toast, an optional ConfirmDialog states the impact, and
every run ends with a result toast, `listview.clear_checked_items()` and `listview.refresh()`.

## Usage

```js
new sanad.ui.BulkActions({
  listview,
  actions: [
    // native: one call with names[] (+ reason from the confirm dialog)
    { label: (n) => (n ? __("Cancel ({0})", [n]) : __("Cancel")),
      method: "queue.delete_items",
      condition: (docs) => docs.some((d) => d.status === "Queued"),
      confirm: (names) => ({ title: __("Cancel {0} messages?", [names.length]), reason_field: true, danger: true,
                             confirm_label: __("Cancel messages") }),
      success: (r) => __("{0} messages cancelled", [r.count]) },
    // per-name loop with progress
    { label: __("Link to account"), method: "contacts.update_contact", per_name: true,
      args: (names, { docs }) => ({ payload: { links: [...] } }) },
    // fully custom
    { label: __("Resend failed"), handler: (names, docs) => resend(docs.filter((d) => d.status === "Failed")) },
  ],
});
```

Options: `listview`, `cap` (default 200), `actions[]` (`label` string or `(count) => string`,
`icon`, `method` api key, `args(names, {docs, reason})` extra args, `per_name`, `confirm` spec or
`(names, docs) => spec | null`, `condition(docs)`, `handler(names, docs, payload)` (replaces the
API call), `success` string or `(result, names) => string`, `on_done(result, names)`, `cap`,
`roles`, `perm`). Result shapes understood: `{count}` and `{count, done[], failed[], skipped[]}`.
Methods: `update()`, `run(action)`, `destroy()`.

## Live use
Outbound list — `public/js/listview/whatsapp_log_list.js` (Resend failed → `messages.resend_many`,
toast when the selection has no failed rows); Queue list —
`public/js/listview/whatsapp_queue_item_list.js` (pause / resume / retry dead letter / cancel,
native `names[]`).

## Design gate
Applied from the phase-5 audit:
- Count in the button label (`(n) => __("Resend failed ({0})", [n])`); the selection size is
  announced as a sentence ("12 selected").
- The progress dialog renders its `aria-live` region **once** and only updates the status text
  and `aria-valuenow` per tick (WCAG 4.1.3 — a re-created live region is not announced
  reliably); it shows the bar **and** "N of M done, K failed", and can be stopped.
- Selection cap (200) with a message that says both the cap and the current count.
- Decisions go through ConfirmDialog (impact rows, reason, acknowledgement); toasts only report.
- Role / permission visibility through `sanad.ui.visible_actions` (same rules as RowActions and
  Drawer); `condition(docs)` re-evaluated on every selection change.

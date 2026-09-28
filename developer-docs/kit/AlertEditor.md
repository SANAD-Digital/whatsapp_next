# `sanad.ui.AlertEditor`

A full-screen modal window to create, edit, preview and test a scheduled alert (a report or a
plain message sent daily / weekly / monthly / quarterly / yearly). The draft is built in four
numbered step cards — **When**, **What**, **Who**, **From** — each ticking green once complete,
beside a live preview pane (message bubble, attachment, row / recipient counts, next runs, problems)
that re-runs 600 ms after every change. Below the preview: "Send a test" to one number, "Run it now"
for a saved alert, and the saved alert's send history. The component never calls the app's API
itself — the host passes every data source as a function.

**Portability:** the kit file has no app imports, but the data contract is the shape of this app's
`WhatsApp Notification Alert` (fields `periodicity`, `content_type` = `Report` | `Static Message`,
`attachment_format` = `None` | `PDF` | `PNG`, recipient types `User` | `Role` | `Phone` |
`Report Column`, dynamic-filter tokens such as `last_days:7`) and of `alerts.get_editor` /
`alerts.preview_draft`. Another app must return the same shapes. It also temporarily replaces the
global `frappe.query_report` (restored on close) and evals report scripts.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `name` | string \| null | `null` | Alert to open; empty opens a new one (name field focused). |
| `load` | `(name) → Promise<Data>` | required | Loads the alert and everything the editor needs (see *Data* below). Re-called after each save. |
| `preview` | `(payload) → Promise<Preview>` | required | Dry-run of the unsaved draft. |
| `save` | `(payload) → Promise<{name}>` | required | Create / update; `name` becomes the draft's name. |
| `remove` | `(name) → Promise` | — | Enables the footer **Delete** (only if also `data.can_delete`). |
| `send_test` | `(payload, phone) → Promise<{phone_e164}>` | — | Enables the "Try it" block; without it the block is not drawn. |
| `run_now` | `(name) → Promise` | — | Shows "Run it now for every recipient" on a saved alert. Refused while dirty. |
| `search` | `(kind, txt) → Promise<[{value, label, description}]>` | required | Picker search; `kind` is `report`, `print_format`, `letter_head` or `language`. |
| `report_columns` | `(report, filters) → Promise<[{fieldname, label}]>` | — | Columns offered as "one message per number in this column" recipients. |
| `report_info` | `(report) → Promise<{report_type, ref_doctype, saved_filters}>` | — | Decides the filter UI. Without it filters are always key/value rows. |
| `pick_recipients` | `({existing}) → Promise<[{phone_e164 \| phone, display_name}]>` | — | Backs "Choose from contacts"; button disabled without it. `existing` = phones already on the draft. |
| `device_link` | `{doctype, filters?, placeholder?}` | `{}` | The **From** step's Link control. No `doctype` → no control drawn. |
| `on_saved` | `(result)` | — | After save (`{name}`) and delete (`{name, deleted: true}`). |
| `on_close` | `()` | — | After the window is removed. |

**Data** returned by `load`:
`{alert, stats, recent[], options, devices[], templates[], tokens[], variables[], png_available, me, can_write, can_delete}`

- `alert` — the doc fields listed under *Payload*, plus `recipients[{recipient_type, user, role, phone | phone_e164, report_column}]`, `filters_json`, `dynamic_filters_json`.
- `options` — `{periodicity[], day_of_week[], month_of_year[]}` (select choices).
- `devices[]` — `{name, device_name, status, phone_e164, is_default}`; `status === "Connected"` shows a green dot.
- `templates[]` — `{name, template_name, category}`; empty disables "Use a template".
- `tokens[]` — `{name, example}` moving-date tokens (`today`, `month_start`, `last_days:N`, `days_ago:N`, …).
- `variables[]` — `{code, label}` insertable into the message at the caret.
- `stats` — `{send_count, last_sent_at, last_error}`; `recent[]` — `{display_name, phone_e164, status, creation}`.
- `me.phone` pre-fills the test number; `png_available` false disables the Image attachment; `can_write` false disables Save.

**Preview** returned by `preview`: `{problem, error, next_runs[], row_count, recipients[{phone_e164}], recipients_count, message, attachment{file_name, message_type}}`.

**Payload** passed to `preview` / `save` / `send_test`:
`{name?, alert_name, enabled, periodicity, day_of_week, day_of_month, month_of_year, notification_time, content_type, report, filters_json, dynamic_filters_json, template, message, attachment_format, print_format, letter_head, language, device, recipients[]}`.
`report`, filters and `Report Column` recipients are dropped for a message-only alert;
`attachment_format` becomes `"None"`.

## Methods

The constructor builds and opens the window; there is no separate `open`.

- `close(force = false)` — closes; asks "Discard unsaved changes?" when dirty unless `force`.
- `save()` / `remove()` / `send_test()` / `run_now()` — the footer / side actions, callable directly.
- `is_dirty()` — draft differs from the last loaded/saved state.
- `payload()` — the current draft as the payload above.

## Events and callbacks

Only `on_saved` and `on_close`. No DOM events are triggered and no realtime is subscribed. Every
failure is shown with `frappe.show_alert`; confirmations use `frappe.confirm`.

## Server calls

The component itself calls only:

| Call | When |
|---|---|
| `frappe.xcall("frappe.desk.query_report.get_script", {report_name})` | A script/query report's filter definitions, if not already in `frappe.query_reports`. |
| `frappe.model.with_doctype(ref_doctype)` | Report Builder report, before drawing `frappe.ui.FilterGroup`. |

Everything else goes through the host's functions. This app wires them in
`public/js/screens/alerts.js` to `alerts.get_editor`, `alerts.preview_draft`, `alerts.save_editor`,
`alerts.delete_alert`, `alerts.send_test`, `alerts.run_now`, `alerts.search`,
`alerts.get_report_columns` and `alerts.get_report_info` (all `{silent: true}`).

## Usage

```js
const call = (m, args) => sanad.ui.call(`alerts.${m}`, args || {}, { silent: true });
new sanad.ui.AlertEditor({
  name: null,
  load: (n) => call("get_editor", n ? { name: n } : {}),
  preview: (payload) => call("preview_draft", { payload }),
  save: (payload) => call("save_editor", { payload }),
  remove: (n) => call("delete_alert", { name: n }),
  send_test: (payload, phone) => call("send_test", { payload, phone }),
  search: (kind, txt) => call("search", { kind, txt: txt || "" }),
  report_info: (report) => call("get_report_info", { report }),
  report_columns: (report, filters) => call("get_report_columns", { report, filters }),
  device_link: { doctype: "WhatsApp Device", filters: { status: "Connected" } },
  on_saved: () => cur_list && cur_list.refresh(),
});
```

## CSS hooks

- Layer: `.sanad-kit.sanad-ae-layer` > `.sanad-ae-backdrop` + `.sanad-ae` (the dialog). `body.sanad-ae-open` locks page scroll.
- Frame: `__head` (`__mark`, `__name`, `__sentence`, `__dirty`, `__enabled`), `__main` > `__build` + `__side`, `__foot` (`__foot-hint.is-warn`), `__loading`.
- Steps: `__step[data-step=when|what|who|from]`, `__step-head`, `__num.is-done`, `__step-body`.
- Controls: `__chip.is-on`, `__seg` (on `.wa-seg`), `__pick`, `__results`, `__opt`, `__picked`, `__vars` / `__var`, `__msg`, `__filter`, `__rf.is-moving`, `__token`, `__n`, `__more`.
- Recipients: `__whos` > `__who--user|--role|--phone|--report_column` (`frappe.scrub` of the type), `__colpick`.
- Side: `__phone`, `__bubble` (`.is-ghost`), `__file`, `__facts`, `__note--warn|--danger`, `__status.is-busy`, `__test`, `__hist`, `__recent`, `__next` / `__runs` (`li.is-first`).
- Buttons: `__btn`, `__btn--pri`, `__btn--danger`, `__icon`, `__icon--sm`, `__link`, `__add`.
- Breakpoints in `style.scss`: under 960 px the side drops below the steps; under 720 px the window is full screen; honours `prefers-reduced-motion`.

## Notes

- **States:** "Loading…" until `load` resolves; a failed load shows the error with a Close button.
  The preview shows a skeleton bubble until the first result, then "Updating…" / "Up to date"
  (`aria-live="polite"`). Stale preview/search responses are dropped by sequence/query checks.
- **Filters:** three modes chosen by `report_info` — `report` (the report's own filter controls
  via `frappe.ui.form.make_control`, date fields switch Fixed / Moves-token), `builder` (Frappe's
  `FilterGroup` on `ref_doctype`), or `rows` (key/value rows with an "Edit as JSON" toggle; JSON
  that rows can't represent stays JSON). A new alert gets the report's defaults; a date defaulting
  to today becomes the `today` token.
- **Keyboard:** focus is trapped (`sanad.ui.trap_focus`) and restored on close. Esc closes an open
  picker, else the window (skipped while a Frappe modal is open). Ctrl/⌘+S saves. In a picker,
  Enter takes the first result and ArrowDown moves into the list; Enter in the test number sends.
- **ARIA:** `role="dialog"` + `aria-modal`, labelled by a visually hidden title; segmented controls
  are `radiogroup`s; chips use `aria-pressed`; results are a `listbox`; each step says
  "Complete" / "Not complete yet" in `sr-only` text.
- **RTL:** logical properties only; numbers and phone fields are `dir="ltr"`, text `dir="auto"`.
- **Limits:** day of month is 1–28; "N days" inputs are 1–3660.
- **Live use:** `public/js/screens/alerts.js` (`whatsapp_next.alerts.open`), opened from
  `public/js/listview/whatsapp_notification_alert_list.js` and
  `public/js/form/whatsapp_notification_alert.js`.

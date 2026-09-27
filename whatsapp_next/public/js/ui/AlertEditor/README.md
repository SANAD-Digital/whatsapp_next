# AlertEditor

One window to create, edit, look at and try a scheduled alert — a report or a message that goes
out daily, weekly, monthly, quarterly or yearly. The alert is written as four short answers, each
in its own card that ticks itself green once it is complete:

1. **When** — every day / week / month / quarter / year; weekday chips, a 28-day grid, month
   chips, a time with quick picks; read back as one sentence in the header, with the next three
   runs under the card.
2. **What** — a report (searched as you type), its filters as rows (a fixed value, or a date that
   moves: today, start of the month, N days back…; "Edit as JSON" for anything rows cannot hold)
   and the file it attaches (none, PDF, image) with print format, letter head and language; or a
   message only. The text is written with insertable variables, or taken from a saved template.
3. **To whom** — users, roles, numbers, or a column of the report (one message per number in it,
   with only that number's rows), as chips.
4. **From** — the sending device, as cards with their state.

Beside the cards, a live preview of the unsaved draft — the message as the first recipient gets
it, the file it would attach, how many rows and numbers, the next run, and what is still missing —
refreshed as you type. Under it, **Send a test** sends the draft once to one number without saving
anything; a saved alert also shows what it has sent and can run now.

## Usage

```js
new sanad.ui.AlertEditor({
  name: "Daily sales" /* or null for a new one */,
  load: (name) => api("get_editor", { name }),          // alert, options, devices, templates, tokens, variables, stats, recent
  preview: (payload) => api("preview_draft", { payload }),
  save: (payload) => api("save_editor", { payload }),    // → {name}
  remove: (name) => api("delete_alert", { name }),
  send_test: (payload, phone) => api("send_test", { payload, phone }),
  run_now: (name) => api("run_now", { name }),
  search: (kind, txt) => api("search", { kind, txt }),   // report · user · role · print_format · letter_head · language
  report_columns: (report, filters) => api("get_report_columns", { report, filters }),
  on_saved: () => list.refresh(),
});
```

The payload is `{name?, alert_name, enabled, periodicity, day_of_week, day_of_month,
month_of_year, notification_time, content_type, report, filters_json, dynamic_filters_json,
template, message, attachment_format, print_format, letter_head, language, device,
recipients[{recipient_type, user | role | phone | report_column}]}` — the host decides what it
accepts.

## Live use
The host app's notification alerts: "New alert", a row, and "View" in the alerts list open it,
and the alert form offers "Open in the editor".

## Design gate
- A labelled `role="dialog"` with `aria-modal`; Tab stays inside; Esc closes a picker first, then
  the window (asking before unsaved changes are dropped); Ctrl/⌘+S saves.
- Each step says whether it is complete in words as well as with the tick; the header sentence
  and the preview status are live text, so a screen reader hears the schedule and the refresh.
- Segmented controls are radio groups; chips are toggle buttons with `aria-pressed`; the device
  cards are a radio group; pickers are listboxes that open on focus and take Enter and arrows.
- Nothing is sent or saved by the preview; the test sends one message to one number and says so.
- Product tokens only; logical properties; under 960 px the preview drops under the cards and
  under 720 px the window takes the whole screen.

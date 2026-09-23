# DateFilter

The design prototype's operator-based date filter (`docs/component/Date Filter.html`), rebuilt for
Desk. A split trigger — **operator · value** — opens a panel whose shape follows the operator:

| Operator | Panel |
|---|---|
| `is`, `after`, `before`, `onOrAfter`, `onOrBefore` | one calendar plus quick single-date presets |
| `between` | a preset rail, two calendars and a range band that follows the pointer |
| `timespan` | last / next *N* hours, days, weeks, months or years, with "include today" |
| `fiscal` | a fiscal year with FY, Q1–Q4 and H1–H2, and a twelve-month bar strip |

Nothing is emitted until **Apply**; **Cancel** restores the applied snapshot, and the × on the
trigger clears the filter and emits `null`.

## Usage

```js
new sanad.ui.DateFilter({
    wrapper: $("<div>").appendTo(page.main),
    label: __("Sent at"),
    default_op: "between",
    on_change: (value) => {
        if (!value) return clear_my_filter();
        // {op, from, to, fromTime, toTime, exclusive, label, summary, params}
        apply_my_filter(value);
    },
});
```

In a list, use the `date` preset type instead and `FilterBar` does the wiring:

```js
new sanad.ui.FilterBar({
    listview,
    presets: [{ fieldname: "creation", type: "date", label: __("Date"), default_op: "between" }],
});
```

`FilterBar` turns the value into one Frappe filter: `Between` for a range, `>` / `>=` / `<` / `<=`
for the single-sided operators, and it appends `00:00:00` / `23:59:59` (or the chosen times) when
the field is a Datetime.

## Options

| Option | Default | Meaning |
|---|---|---|
| `wrapper` | — | where the trigger mounts (required) |
| `label` | — | a caption above the trigger |
| `placeholder` | `Pick a date` | shown while nothing is applied |
| `default_op` | `between` | any of the eight operator keys |
| `layout` | `auto` | `wide` / `compact`; `auto` goes compact under 720 px |
| `week_start` | Frappe's setting | `sun` / `mon` / `sat` |
| `fiscal_start_month` | `1` | 1–12 |
| `value` | — | a previously emitted value, to restore |
| `on_change` | — | `(value\|null) => void` on Apply and on Clear |

## Value

```js
{
  op: "between",              // the operator key
  from: "2026-09-17",         // YYYY-MM-DD or null
  to: "2026-09-23",           // YYYY-MM-DD or null
  fromTime: null,             // "HH:MM" when "Set a time" is on
  toTime: null,
  exclusive: false,           // true only for `after` / `before`
  label: "Last 7 days",       // short text for a trigger or a chip
  summary: "17-09-2026 → 23-09-2026",
  params: { … }               // the whole draft, for round-tripping through `value`
}
```

A range that matches a preset reports that preset's name as its `label`, so "Last 7 days" reads as
itself rather than as two dates.

## Behaviour worth knowing

- Bounds are **inclusive**: `span` counts both ends, and every "to date" preset ends today.
- The first click sets the start and clears the end; the second completes the range and swaps the
  two if the second date is earlier. A third click starts over. One day is a valid range.
- `after` and `before` shift the bound by a day and set `exclusive`, unless a time is given, in
  which case the pivot day is kept and the time carries the exclusion.
- Switching operator keeps the dates: between → single takes the start, single → between uses the
  date as the start and today as the end.
- Typed dates accept `DD/MM/YYYY`, `YYYY-M-D`, dots, dashes, slashes or spaces, two-digit years,
  and Arabic-Indic digits. An unparseable value turns the field red and blocks Apply.
- The panel never closes on selection. Escape, Cancel, Apply or a click outside close it; Escape
  closes the operator menu or the month picker first.
- Month and weekday names come from `moment`, so they follow the user's language; the calendar
  inherits RTL from Desk and the range band flips with it.

## Live use

`WhatsApp Log` (Outbound) — the `creation` filter in its toolbar.

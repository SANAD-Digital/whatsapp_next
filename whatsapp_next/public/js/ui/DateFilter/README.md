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

## Which field — `sanad.ui.DateFilterSet`

Give the trigger a field segment by passing `fields`, and a **set** turns each picked field into a
filter row of its own:

```js
new sanad.ui.DateFilterSet({
    wrapper: $("<div>").appendTo(page.main),
    fields: [
        { value: "sent_at", label: __("Sent at") },
        { value: "creation", label: __("Created On") },
    ],
    fieldname: "creation",            // the field the first row starts on
    on_change: (rows, { removed }) => {
        // rows = [{fieldname, value|null}] — one entry per row
        // removed = the fieldnames the set no longer holds
    },
});
```

The toolbar keeps **one** trigger. Its field segment reads the field's own name while one field is
filtered, and a tag carrying the count once several are — `2 fields`, `3 fields` — because the
names would not fit and the panel lists them anyway.

Opening it shows a **rail** of the fields being filtered, each with its own dates: the one being
edited is outlined, clicking another switches to it (an unapplied draft is kept), and its × drops
it. Ticking an unheld field in the field list adds it and opens it straight away; a field with
nothing applied *moves* to the one just ticked instead of leaving an empty field behind. One
**Apply** commits every field at once, so the list is refetched once, and the trigger's × clears
the lot back to a single field. The last field never goes — there would be nothing left to pick
from.

A single `DateFilter` takes `fields` too; on its own the picker just switches which field the
control reports (`on_field_change(now, was)`).

In a list, use the `date` preset type instead and `FilterBar` does the wiring:

```js
new sanad.ui.FilterBar({
    listview,
    presets: [{ type: "date", label: __("Date"), default_op: "between" }],
});
```

With no `fieldname`, the picker offers every **Date** and **Datetime** field on the DocType, in the
DocType's own order, plus `creation` and `modified`, and starts on the DocType's `sort_field` —
all of it from meta, nothing hard-coded. `date_fields: [...]` narrows the list and `fields: false`
drops the picker and goes back to the single-field control.

`FilterBar` turns each row into one Frappe filter on its own field: `Between` for a range,
`>` / `>=` / `<` / `<=` for the single-sided operators, and it appends `00:00:00` / `23:59:59` (or
the chosen times) when the field is a Datetime.

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
| `fields` | — | `[{value\|fieldname, label}]` — shows the field segment |
| `fieldname` | first of `fields` | which field this control reports on |
| `field_caption` | the field's label | `() => {text, count}` for the field segment (a set's count tag) |
| `field_rail` | — | `() => [{fieldname, label, summary}]` — the panel's rail, drawn from two up |
| `on_change` | — | `(value\|null) => void` on Apply and on Clear |
| `on_field_change` | — | `(now, was) => void` when the field segment changes |

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
- Years and months are **picked, not stepped**: the calendar's month head, the month grid's own
  year, and both of the fiscal panel's steppers open a 3×4 grid in place. The year grid is centred
  on the year in hand (2026 opens on 2021–2032) and pages by twelve; the fiscal steppers keep their
  arrows beside the value for a one-step nudge.
- Panel and menus hang off the **start** edge of the trigger — the left in English, the right in
  Arabic — and are measured after mounting: one that would run off the viewport flips to the other
  edge, and is pinned to the viewport if even that does not fit. The menus are at least as wide as
  the trigger, so they read as attached to it rather than as a stub sticking out one side.
- The panel never closes on selection. Escape, Cancel, Apply or a click outside close it; Escape
  closes the field picker, the operator menu or the month picker first.
- Month and weekday names come from `moment`, so they follow the user's language; the calendar
  inherits RTL from Desk and the range band flips with it.

## Live use

`WhatsApp Log` (Outbound) — the date filter in its toolbar, over the log's ten date fields.

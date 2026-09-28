# `sanad.ui.DateFilter` and `sanad.ui.DateFilterSet`

`DateFilter` is the prototype's operator-based date filter (`docs/component/Date Filter.html`). A split trigger (**operator · [field] · value**) opens a panel whose shape follows the operator:

| Operator key | Panel |
|---|---|
| `is`, `after`, `before`, `onOrAfter`, `onOrBefore` | one calendar, typed input, quick single-date presets |
| `between` | preset rail, two calendars (one when compact), a range band that follows the pointer |
| `timespan` | last / next *N* hours / days / weeks / months / years, "Include today", common spans |
| `fiscal` | fiscal year and start month (steppers), FY / Q1–Q4 / H1–H2, a 12-month bar strip |

Nothing is emitted until **Apply**. **Cancel** throws the draft away, and the next open starts again from the applied snapshot. The trigger's × clears the filter.

`DateFilterSet`, exported from the same file, puts several date fields behind **one** trigger. Each field is its own `DateFilter` row with its own dates, and one Apply commits all of them.

Both are portable: there is no DocType or server dependency, and no host API.

## Value

`get_value()` and `on_change` return:

```js
{ op, from, to,          // from / to are "YYYY-MM-DD" or null
  fromTime, toTime,      // "HH:MM" when "Set a time" is on (always set for hour timespans)
  exclusive,             // true only for after / before
  label,                 // trigger text; a range equal to a preset reads as the preset's name
  summary,               // sentence shown in the footer
  params }               // the whole draft — pass back as `value` to restore
```

All bounds are inclusive. `after` / `before` without a time shift the date by one day and set `exclusive`. With a time, the pivot day is kept.

## Options — `DateFilter`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `wrapper` | jQuery \| HTMLElement | — (required) | The trigger is appended here. |
| `label` | string | — | Caption above the trigger (`.sanad-datefilter__label`). |
| `placeholder` | string | `__("Pick a date")` | Value text while nothing is applied. `""` hides the text. |
| `default_op` | operator key | `"between"` | Operator for a fresh draft. |
| `layout` | `"auto"` \| `"wide"` \| `"compact"` | `"auto"` | `auto` goes compact under 720 px wide. |
| `week_start` | `"sun"` \| `"mon"` \| `"sat"` | Frappe `sysdefaults.first_day_of_the_week`, else Sunday | First weekday. When set, the option overrides the system default. |
| `fiscal_start_month` | 1–12 | `1` | Default fiscal start month. |
| `value` | value object | — | Restored silently at construction. |
| `on_change` | `(value \| null) => void` | — | Fired on Apply and on Clear. |
| `fields` | `string[]` \| `[{fieldname\|value, label}]` | — | Shows the field segment (a multi-select list). |
| `fieldname` | string | first of `fields` | The field this control reports on. |
| `on_field_change` | `(now, was, filter) => void` | — | The field segment changed (standalone mode). |
| `field_caption` | `() => {text, count}` | own field's label | Text of the field segment. With `count > 1` it is styled as a tag. |
| `selected_fields` | `() => string[]` | `[fieldname]` | Which fields show as ticked in the field list. |
| `on_toggle_field` | `(fieldname, filter) => void` | — | Takes over field ticks. Without it, a tick calls `set_field`. |
| `field_rail` | `() => [{fieldname, label, summary}]` | — | The rail of fields in the panel. It is drawn only when there are 2 or more entries. |
| `on_pick_row` / `on_drop_row` | `(fieldname) => void` | — | Rail entry clicked, or its × clicked. |
| `on_apply_all` / `on_clear_all` | `() => any` | — | When present, Apply or Clear calls this instead of `on_change` (the cascade). |

The last seven options are the set's wiring. `DateFilterSet` supplies them, and a standalone host rarely needs them.

## Options — `DateFilterSet`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `wrapper` | jQuery \| HTMLElement | — (required) | Receives `.sanad-datefilter-set`. |
| `fields` | as above | — | The date fields on offer. |
| `fieldname` | string | first field | The field the first row starts on. |
| `on_change` | `(rows, {removed}) => void` | — | `rows = [{fieldname, value \| null}]`. `removed` holds the fieldnames the set dropped. |
| any `DateFilter` option | | | Passed through to every row, except the wiring options above and `value` / `on_change`, which the set overrides. |

## Methods

`DateFilter`:

- `get_value()` returns the value object, or `null` while the draft is incomplete.
- `set_value(value, {silent})` restores a value. `null` clears.
- `apply({cascade = true, silent = false})` applies the draft.
- `clear({silent = false, cascade = true})` clears the filter.
- `open({keep_state})` / `close(restore_focus)` open and close the panel. `open_menu()` / `close_menu()` do the same for the operator list, and `open_fields()` / `close_fields()` for the field list.
- `set_op(key)` changes the operator. The picked dates are kept.
- `set_field(fieldname, {silent})` points the row at another field.
- `set(patch)` merges `patch` into the draft and re-renders.
- `render_panel()` redraws the open panel.
- `reflect_trigger()` repaints the trigger.
- `destroy()` removes the control and its document handlers.

`DateFilterSet`:

- `values()` returns `[{fieldname, value}]`.
- `selected()` returns the fieldnames currently held.
- `add(fieldname, {silent, activate})` and `remove(fieldname, {silent, open})` add and drop rows. The last row cannot be removed.
- `activate(fieldname, {open})` switches the visible row.
- `toggle(fieldname, from)` ticks or unticks a field in the list. Ticking a field while the current row is still blank moves that row to the new field instead of adding one.
- `apply_all()` applies every row that has a usable draft, then emits once.
- `clear({silent})` goes back to one cleared row.
- `reopen()` redraws or opens the active row's panel.
- `destroy()` removes the set.

## Events and callbacks

- Only the callbacks above. Nothing is emitted while picking.
- Document listeners `mousedown.<id>` (outside click) and `keydown.<id>` (Escape) are bound per instance and removed by `destroy()`.

## Server calls

None.

## Usage

```js
new sanad.ui.DateFilter({
  wrapper: $slot, label: __("Sent at"), default_op: "between",
  on_change: (v) => (v ? load({ from: v.from, to: v.to }) : load({})),
});

new sanad.ui.DateFilterSet({
  wrapper: $slot,
  fields: [{ value: "sent_at", label: __("Sent at") }, { value: "creation", label: __("Created On") }],
  fieldname: "creation",
  on_change: (rows, { removed }) => rows.forEach((r) => apply_filter(r.fieldname, r.value)),
});
```

In a Desk list, use the FilterBar preset `{ type: "date" }` instead, which does this wiring for you.

## CSS hooks

- **Root:** `.sanad-datefilter`, with the modifiers `--set` (a value is applied) and `--hidden` (the set's inactive rows).
- **Trigger:** `.sanad-datefilter__trigger` contains `__op`, `__fieldpick` (`__fieldpick-label--tag`), `__value`, `__text` (`--empty`), `__clear` and `__caret`.
- **Menus:** `.sanad-datefilter__menu` (`--fields`) holds `__menu-item`, with the modifiers `--on` and `--mine`, plus `__menu-box` and `__menu-check`.
- **Panel:** `.sanad-datefilter__panel` (`--compact`) contains:
  - `__chead` (the compact head)
  - `__rail` / `__rail-item--on`
  - `__presets` / `__preset--on`
  - `__inputs` / `__field--bad`
  - `__cal` / `__month` / `__grid`
  - `__day`, with the modifiers `--on`, `--ring`, `--today`, `--band`, `--band-start/-mid/-end` and `--blank`, containing `__pill[data-key]`
  - `__picker` / `__picker-cell--on` / `--now`
  - `__form`, `__seg`, `__stepper` and `__bars` / `__bar--on`
  - `__footer`, holding `__summary`, `__count-chip`, `__cancel` and `__apply`
- **Custom property:** `--sanad-band-radius` is set on range cells.
- **Set root:** `.sanad-datefilter-set`.

## Notes

- **Picking a range:** the first click sets the start, the second completes the range (swapping if needed), and a third starts over.
- **Typed dates:** `DD/MM/YYYY`, `YYYY-M-D`, `.`/`-`/`/`/space separators, two-digit years and Arabic-Indic digits are accepted. An invalid entry turns the field red and is not committed.
- **Month and year pickers:** the month head, the month grid's year and both fiscal steppers open a 3×4 grid in place of stepping one at a time. The year grid pages by 12 and is centred on the current year.
- **Keyboard:** Enter, Space or ArrowDown opens a trigger segment. Escape closes the innermost layer first: the field list, then the operator menu, then the month/year grid, then the panel. The panel never closes on selection.
- **ARIA:** operator and field lists are `role="listbox"`, the panel is `role="dialog"`, the rail is `role="tablist"`, and segmented buttons use `aria-pressed`.
- **Positioning:** popups hang off the trigger's start edge. They are measured after mounting, flip to the end edge, or are pinned `fixed` to the viewport when neither fits.
- **Localisation:** month and weekday names come from `Intl` in `frappe.boot.lang` (moment is only the fallback). Plurals go through `ui.plural`. The range band flips its gradients under `[dir="rtl"]`.
- **No live use of its own:** it is created only by FilterBar's `date` preset (`DateFilterSet` by default, a single `DateFilter` with `fields: false`). The screens using that preset are:
  - `public/js/listview/`: `whatsapp_campaign_list.js`, `whatsapp_contact_group_list.js`, `whatsapp_notification_alert_list.js`, `whatsapp_notification_list.js`, `whatsapp_number_list.js`, `whatsapp_template_list.js`
  - `public/js/screens/messages.js`, for the Outbound, Inbound and Queue lists
  - `whatsapp_next/page/wa_contacts/wa_contacts.js`
- **Phones (under 768 px):** the stylesheet reduces the trigger to one calendar icon. The label, operator and field segments are hidden, and the compact panel head (`__chead`) carries the operator and field instead. The panel becomes `position: fixed` and scrolls, so Apply stays reachable. When a value is set, the trigger is tinted and keeps its ×.

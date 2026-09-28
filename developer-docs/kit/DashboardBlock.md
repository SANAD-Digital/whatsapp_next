# `sanad.ui.DashboardBlock`

The driver behind a Frappe **Custom HTML Block** (or any element): renders Number Cards and
Dashboard Charts **by document name** through the same server methods Desk's workspace widgets
use, in a responsive grid with skeleton → value, an error state per card and per chart, an optional
Today / 7 days / 30 days period filter applied to the charts, a Refresh button, timed refresh and
realtime refresh. What is shown is configured in Desk (Number Card / Dashboard Chart documents), not
in code. Mounted inside a block's shadow root, it copies the document's stylesheets and the
`#all-symbols` icon sprite into the root so kit styles and Espresso icons apply.

**Portability:** only Frappe core methods are called; no app keys. The card and chart names and
realtime event names come from the host (here from the `WA %` fixtures).

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `wrapper` | jQuery \| HTMLElement \| ShadowRoot child | — | Mount point, e.g. an element inside a Custom Block's `root_element`. |
| `number_cards` | string[] | `[]` | Number Card names. Types: Document Type (with percentage stats when `show_percentage_stats`), Custom (`method` → value or `{value, route, route_options}`), Report (`report_field` + `report_function`). |
| `charts` | string[] | `[]` | Dashboard Chart names. Report and Custom chart types show an error state. |
| `period_filter` | boolean | `false` | Show the period radiogroup. |
| `period` | `"today"` \| `"7d"` \| `"30d"` | `"7d"` | Initial period (only used when `period_filter` is on). |
| `columns` | number | `4` | Card columns on wide screens (sets `--sanad-dashboard-columns`; 2 under 992 px, 1 under 576 px). |
| `chart_height` | number | `240` | Chart height and reserved body `min-height` (px). |
| `refresh_seconds` | number | `0` | Timed full refresh; 0 = off. |
| `events` | `{[event]: true \| (data, block) => void}` | `{}` | Realtime events; `true` = debounced (1 s) full refresh. |
| `on_card_click` | `(name, doc, number) => void` | — | Replaces the default click-through and makes every loaded card a button. |

## Methods

- `refresh({initial = false, announce = false} = {})` — reload every card and chart; concurrent
  calls share one promise; `announce` says "Dashboard updated".
- `refresh_charts()` — reload charts only (with skeletons).
- `set_period(key)` — switch period (`today`/`7d`/`30d`), announce it, reload charts.
- `period_range()` — `{from, to}` (YYYY-MM-DD) of the selected period, or `null`.
- `open_card(card)` — the card click-through (internal card object).
- `destroy()` — clear the timer, unsubscribe realtime, dispose chart instances, remove the DOM.

## Events and callbacks

- `on_card_click(name, doc, number)`; `events` handlers get `(data, block)`.
- `frappe.realtime.on` for each truthy `events` entry; `off` on `destroy()`.
- No custom DOM events.

## Server calls

| Method | Args | When |
|---|---|---|
| `frappe.db.get_doc("Number Card" / "Dashboard Chart", name)` | — | First load, unless the doc is in `locals`. |
| `frappe.desk.doctype.number_card.number_card.get_result` | `{doc, filters}` | Document Type cards. |
| `…number_card.get_percentage_difference` | `{doc, filters, result}` | Document Type cards with `show_percentage_stats`. |
| `frappe.desk.query_report.run` | `{report_name, filters, ignore_prepared_report: 1}` | Report cards. |
| the card's own `doc.method` | `{filters}` | Custom cards. |
| `frappe.desk.doctype.dashboard_chart.dashboard_chart.get` | `{chart_name, filters, refresh: 1}` + period args | Each chart load. With a period: timeseries charts get `timespan: "Select Date Range"`, `from_date`, `to_date`, `time_interval: "Daily"`; group-by charts get extra `creation` filters. |

All via `frappe.xcall`; filters come from `frappe.dashboard_utils.get_all_filters(doc)`.

## Usage

```js
// Custom HTML Block script; the block html is <div class="wa-dashboard"></div>
new sanad.ui.DashboardBlock({
  wrapper: root_element.querySelector(".wa-dashboard"),
  number_cards: ["WA Queued Now", "WA Connected Devices", "WA Sent Today", "WA Failed Today"],
  charts: ["WA Messages per Day", "WA Outbound by Status"],
  period_filter: true,
  refresh_seconds: 120,
  events: { "wa:queue:progress": true, "wa:message:status": true },
});
```

## CSS hooks

- Root `.sanad-kit.sanad-dashboard` with `--sanad-dashboard-columns`.
- Toolbar: `__toolbar`, `__period[role=radiogroup]`, `__period-btn.sanad-chip[role=radio][data-key]`,
  `__refresh`.
- Cards: `__cards[role=list]`, `__card[role=listitem]`, `__card-btn` (a `<button>` when openable,
  else a `<div>` with `--static`; `aria-busy`), `__card-label`, `__card-value`, `__number`,
  `__card-stat`, `__stat.sanad-tone--{green|red|gray}`, `__card-state`.
- Charts: `__charts`, `__chart` (`aria-busy`), `__chart-title`, `__chart-body`, `__chart-state`,
  `__chart-canvas`.

## Notes

- **States:** skeleton on first load; per-card error via `sanad.ui.EmptyState` (`size: "sm"`) with
  Retry; per chart loading/empty ("No data for this period", "Try a wider period.")/error with
  Retry. Existing charts refresh in place (`update(data)`) without a skeleton; Pie/Donut/Percentage
  are rebuilt after disposing the old instance.
- Number format: `doc.currency` → currency; `show_full_number` → full; else shortened
  (`frappe.utils.shorten_number`); `null` → "Not available".
- Default click-through: Custom → `data.route` (+ `route_options`); Report → the query report with
  filters; Document Type → the list view with the card's filters. A card with nowhere to go stays
  a plain `<div>`.
- **A11y:** each chart `<section>` is labelled by its title and described by a visually hidden
  summary; the SVG is `aria-hidden`. The period group uses roving `tabindex` with RTL-aware arrows,
  Home/End (`ui.roving_index`), and announces "Showing the last {period}.".
- **Live use:** not referenced from JS in the app; it runs from the fixture
  `fixtures/custom_html_block.json` ("WA Dashboard Block"), placed in the module workspace
  `whatsapp_next/workspace/whatsapp/whatsapp.json`.

# DashboardBlock

The driver behind a Frappe **Custom HTML Block** (it also mounts in any element): renders Number
Cards and Dashboard Charts by name through the same server methods the workspace widgets use
(`number_card.get_result` / `get_percentage_difference`, `dashboard_chart.get`, `frappe.Chart` via
`frappe.utils.make_chart`), in a responsive grid — skeleton → value, an error state per card and per
chart, a Today / 7 days / 30 days period filter applied to the charts (timeseries via `timespan`,
group-by charts via a `creation` range), a Refresh button, timed refresh and realtime refresh. The
cards and charts themselves are ordinary Number Card / Dashboard Chart documents (fixtures), so
what is shown is configured in Desk, not in code. Mounted inside a block's shadow root it mirrors
the document's stylesheets and icon sprite so kit styles and Espresso icons apply.

## Usage

```js
// Custom HTML Block `script` (Frappe exposes `root_element` = the block's shadow root);
// the block `html` holds `<div class="dashboard"></div>`.
new sanad.ui.DashboardBlock({
  wrapper: root_element.querySelector(".dashboard"),
  number_cards: ["Queued Now", "Connected Devices", "Sent Today", "Failed Today"],
  charts: ["Messages per Day", "Outbound by Status"],
  period_filter: true,            // Today / 7 days / 30 days
  period: "7d",
  columns: 4,
  refresh_seconds: 60,
  events: { "app:queue:progress": true, "app:message:status": (data, block) => block.refresh() },
});

// Any page
const block = new sanad.ui.DashboardBlock({ wrapper: $panel, number_cards: ["Open Tasks"] });
block.refresh();  block.set_period("30d");  block.destroy();
```

Options: `wrapper`, `number_cards[]`, `charts[]` (document-type charts: Count / Sum / Average /
Group By; Report and Custom charts show an error state), `period_filter`, `period`, `columns`,
`chart_height`, `refresh_seconds`, `events {event: true | (data, block) => …}`,
`on_card_click(name, doc, number)` (default: the list view with the card's filters, as the widget does).
Methods: `refresh({announce})`, `refresh_charts()`, `set_period(key)`, `destroy()`.

Number Card types: Document Type (with `dynamic_filters_json` evaluated like the widget), Custom
(`method` → `{value, route}`), Report. Percentage stats render when `show_percentage_stats` is on.

## Live use
Workspace "WhatsApp" (module document `workspace/whatsapp/whatsapp.json`) → Custom HTML Block
"WA Dashboard Block" (fixtures `number_card.json`, `dashboard_chart.json`, `custom_html_block.json`);
Home page KPI strip.

## Design gate
- Reserved space: cards keep a fixed `min-height` and a 32 px value slot, charts a fixed body
  height — skeleton → value never shifts the layout; loading is a skeleton, never a spinner.
- Every async pane has loading / empty / error through `EmptyState` with a Retry action; an empty
  chart says "No data for this period" and suggests a wider period.
- Charts have a text alternative: each `<section>` is `aria-labelledby` its title and
  `aria-describedby` a visually-hidden summary ("{title}: N data points, latest X on D." /
  "N groups, largest …"); the SVG canvas is `aria-hidden`.
- Period filter is a real `radiogroup` of `.sanad-chip`s (shared height / look) with roving
  `tabindex`; arrows are RTL-aware plus Home / End through `sanad.ui.roving_index`; the change is
  announced as a sentence ("Showing the last 7 days."); Refresh announces "Dashboard updated".
- No silent clicks: a card is a `<button>` only when it leads somewhere (list, report, custom
  route or `on_card_click`); otherwise it renders as a plain `<div>`. Targets ≥ 32 px, focus ring
  from the kit's global rule.
- Colour (stat tone) is always paired with an icon and text — `ui.icons.open` for increases,
  `es-line-down` for decreases; percentages through `frappe.format(v, {fieldtype: "Percent"})`
  (locale sign and placement); "Not available" instead of "N/A".
- Mobile: 2 columns under 992 px, 1 column under 576 px, charts stack; a wide series scrolls
  inside its card.

// sanad.ui.DashboardBlock — the driver behind a Frappe Custom HTML Block (or any wrapper): renders
// Number Cards and Dashboard Charts by name through the same server methods the workspace widgets
// call (`number_card.get_result`, `dashboard_chart.get`), in a responsive grid with skeleton →
// value, an error state per card, an optional Today / 7 days / 30 days period filter applied to the
// charts, timed refresh and realtime refresh. Mounted inside a Custom Block's shadow root it mirrors
// the document's stylesheets and icon sprite so kit styles and Espresso icons still apply.

import ui from "../_core/index.js";

const METHODS = {
	number_card_result: "frappe.desk.doctype.number_card.number_card.get_result",
	number_card_stats: "frappe.desk.doctype.number_card.number_card.get_percentage_difference",
	chart_get: "frappe.desk.doctype.dashboard_chart.dashboard_chart.get",
	report_run: "frappe.desk.query_report.run",
};

const PERIODS = [
	{ key: "today", label: () => __("Today"), days: 0 },
	{ key: "7d", label: () => __("7 days"), days: 6 },
	{ key: "30d", label: () => __("30 days"), days: 29 },
];

const CHART_TYPES = { Line: "line", Bar: "bar", Percentage: "percentage", Pie: "pie", Donut: "donut", Heatmap: "heatmap" };

const STATS_QUALIFIER = {
	Daily: () => __("since yesterday"),
	Weekly: () => __("since last week"),
	Monthly: () => __("since last month"),
	Yearly: () => __("since last year"),
};

const as_error = (err) => (err instanceof Error ? err : ui.error_from(err));

sanad.ui.DashboardBlock = class DashboardBlock {
	/**
	 * @param {Object} opts
	 * @param {jQuery|HTMLElement|ShadowRoot} opts.wrapper — a Custom Block's `root_element` or any element
	 * @param {string[]} [opts.number_cards=[]] — Number Card names
	 * @param {string[]} [opts.charts=[]] — Dashboard Chart names (document-type charts: Count / Sum / Average / Group By)
	 * @param {boolean} [opts.period_filter=false] — Today / 7 days / 30 days segmented control
	 * @param {"today"|"7d"|"30d"} [opts.period="7d"] — initial period when the filter is on
	 * @param {number} [opts.columns=4] — card columns on wide screens (2 under 992 px, 1 under 576 px)
	 * @param {number} [opts.chart_height=240]
	 * @param {number} [opts.refresh_seconds=0] — timed refresh (0 = off)
	 * @param {Object<string, Function|boolean>} [opts.events] — realtime events; `true` = refresh, or `(data, block) => …`
	 * @param {Function} [opts.on_card_click] — `(name, doc, number)` replaces the list click-through
	 */
	constructor(opts = {}) {
		this.opts = Object.assign(
			{ number_cards: [], charts: [], period_filter: false, period: "7d", columns: 4, chart_height: 240, refresh_seconds: 0, events: {} },
			opts
		);
		this.$wrapper = $(this.opts.wrapper);
		this.period = this.opts.period_filter ? this.opts.period : null;
		this.cards = {};
		this.charts = {};
		this._handlers = [];
		this.adopt_host_styles();
		this.render();
		this.bind();
		this.refresh({ initial: true });
	}

	/** Inside a shadow root the page's stylesheets and icon sprite do not apply — mirror them. */
	adopt_host_styles() {
		const node = this.$wrapper[0];
		const root = node && node.getRootNode ? node.getRootNode() : document;
		if (typeof ShadowRoot === "undefined" || !(root instanceof ShadowRoot)) return;
		const have = new Set(Array.from(root.querySelectorAll("link[rel=stylesheet]")).map((l) => l.getAttribute("href")));
		document.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
			const href = link.getAttribute("href");
			if (href && !have.has(href)) root.appendChild(link.cloneNode(true));
		});
		const sprite = document.getElementById("all-symbols");
		if (sprite && !root.getElementById("all-symbols")) root.appendChild(sprite.cloneNode(true));
	}

	render() {
		const o = this.opts;
		this.$root = $(`<div class="sanad-kit sanad-dashboard" style="--sanad-dashboard-columns:${cint(o.columns) || 4}"></div>`);
		this.$toolbar = $('<div class="sanad-dashboard__toolbar"></div>').appendTo(this.$root);
		if (o.period_filter) this.render_period();
		this.$refresh = $(
			`<button type="button" class="btn btn-sm btn-default sanad-dashboard__refresh">${ui.icon("es-line-reload", "xs")} <span>${ui.escape(__("Refresh"))}</span></button>`
		)
			.on("click", () => this.refresh({ announce: true }))
			.appendTo(this.$toolbar);

		if (o.number_cards.length) {
			this.$cards = $('<div class="sanad-dashboard__cards" role="list"></div>').appendTo(this.$root);
			o.number_cards.forEach((name) => (this.cards[name] = this.make_card(name)));
		}
		if (o.charts.length) {
			this.$charts = $('<div class="sanad-dashboard__charts"></div>').appendTo(this.$root);
			o.charts.forEach((name) => (this.charts[name] = this.make_chart(name)));
		}
		this.$wrapper.append(this.$root);
	}

	render_period() {
		this.$period = $(`<div class="sanad-dashboard__period" role="radiogroup" aria-label="${ui.escape(__("Period"))}"></div>`);
		PERIODS.forEach((p) => {
			$(
				`<button type="button" class="sanad-chip sanad-dashboard__period-btn" role="radio" aria-checked="${p.key === this.period}" tabindex="${
					p.key === this.period ? 0 : -1
				}" data-key="${p.key}">${ui.escape(p.label())}</button>`
			)
				.on("click", () => this.set_period(p.key))
				.appendTo(this.$period);
		});
		// Arrow keys (RTL-aware), Home and End move between the options, as in a native radio group.
		this.$period.on("keydown", "[role=radio]", (e) => {
			const keys = PERIODS.map((p) => p.key);
			const next = ui.roving_index(e, keys, keys.indexOf(e.currentTarget.dataset.key));
			if (next < 0) return;
			e.preventDefault();
			this.set_period(keys[next]);
			this.$period.find(`[data-key="${keys[next]}"]`).trigger("focus");
		});
		this.$period.appendTo(this.$toolbar);
	}

	set_period(key) {
		if (!PERIODS.some((p) => p.key === key) || key === this.period) return;
		this.period = key;
		this.$period.find("[role=radio]").each((i, el) => {
			const on = el.dataset.key === key;
			el.setAttribute("aria-checked", String(on));
			el.setAttribute("tabindex", on ? "0" : "-1");
		});
		ui.announce(__("Showing the last {0}.", [PERIODS.find((p) => p.key === key).label()]));
		this.refresh_charts();
	}

	/** `{from, to}` (YYYY-MM-DD) of the selected period, or null when the filter is off. */
	period_range() {
		const p = PERIODS.find((x) => x.key === this.period);
		if (!p) return null;
		const to = frappe.datetime.get_today();
		return { from: moment(to).subtract(p.days, "days").format("YYYY-MM-DD"), to };
	}

	/** Cached in `locals` when Desk already has it; otherwise fetched with a rejecting call. */
	get_doc(doctype, name) {
		const local = frappe.get_doc(doctype, name);
		if (local) return Promise.resolve(local);
		return frappe.db.get_doc(doctype, name).then((doc) => {
			if (!doc) throw new Error(__('{0} "{1}" was not found', [__(doctype), name]));
			return doc;
		});
	}

	// ---- number cards -------------------------------------------------------------------------

	make_card(name) {
		const $el = $(`
			<div class="sanad-dashboard__card" role="listitem">
				<div class="sanad-dashboard__card-btn sanad-dashboard__card-btn--static" aria-busy="true">
					<span class="sanad-dashboard__card-label"></span>
					<span class="sanad-dashboard__card-value sanad-tabular"></span>
					<span class="sanad-dashboard__card-stat"></span>
				</div>
				<div class="sanad-dashboard__card-state" hidden></div>
			</div>`).appendTo(this.$cards);
		const card = {
			name,
			$el,
			$btn: $el.find(".sanad-dashboard__card-btn"),
			$label: $el.find(".sanad-dashboard__card-label"),
			$value: $el.find(".sanad-dashboard__card-value"),
			$stat: $el.find(".sanad-dashboard__card-stat"),
			$state: $el.find(".sanad-dashboard__card-state"),
			doc: null,
			number: null,
		};
		card.$label.text(__(name));
		return card;
	}

	async load_card(card, { initial = false } = {}) {
		card.$btn.attr("aria-busy", "true");
		if (initial) card.$value.html(ui.skeleton(1, { lines: 1 }));
		try {
			if (!card.doc) card.doc = await this.get_doc("Number Card", card.name);
			const doc = card.doc;
			card.$label.text(__(doc.label || doc.name));
			card.filters = frappe.dashboard_utils.get_all_filters(doc) || [];
			const { number, formatted } = await this.fetch_card_value(card);
			card.number = number;
			card.$value.html(`<span class="sanad-dashboard__number">${ui.escape(formatted)}</span>`);
			await this.render_card_stats(card);
			this.set_card_openable(card, this.card_route_exists(card));
			this.set_card_state(card, null);
		} catch (err) {
			this.set_card_state(card, "error", as_error(err));
		} finally {
			card.$btn.attr("aria-busy", "false");
		}
	}

	/** Same server methods as Frappe's NumberCardWidget, per card `type`. */
	async fetch_card_value(card) {
		const doc = card.doc;
		const type = doc.type || "Document Type";
		if (type === "Custom") {
			const res = await frappe.xcall(doc.method, { filters: card.filters });
			card.data = res;
			if (res && typeof res === "object") return { number: res.value, formatted: this.format_number(card, res.value, res) };
			return { number: res, formatted: cstr(res) };
		}
		if (type === "Report") {
			const res = await frappe.xcall(METHODS.report_run, { report_name: doc.report_name, filters: card.filters, ignore_prepared_report: 1 });
			const field = doc.report_field;
			const values = (res.result || []).reduce((acc, row) => {
				if (row && !Array.isArray(row) && row[field] != null) acc.push(row[field]);
				return acc;
			}, []);
			const col = (res.columns || []).find((c) => c.fieldname === field);
			const number = frappe.report_utils.get_result_of_fn(doc.report_function, values);
			return { number, formatted: this.format_number(card, number, col) };
		}
		const number = await frappe.xcall(METHODS.number_card_result, { doc, filters: card.filters });
		let df = null;
		if (doc.function !== "Count" && doc.aggregate_function_based_on) {
			await ui.meta.with_doctype(doc.document_type);
			df = frappe.meta.get_docfield(doc.document_type, doc.aggregate_function_based_on);
		}
		return { number, formatted: this.format_number(card, number, df) };
	}

	format_number(card, number, df) {
		if (number == null) return __("Not available");
		const doc = card.doc;
		if (doc.currency) return format_currency(flt(number), doc.currency);
		const is_count = doc.function === "Count" || !df;
		if (doc.show_full_number) return is_count ? ui.format_int(number) : frappe.format(number, df, { inline: true });
		const short = frappe.utils.shorten_number(number, frappe.sys_defaults.country, 5);
		return is_count && !/[A-Za-z]/.test(short) ? ui.format_int(number) : short;
	}

	async render_card_stats(card) {
		const doc = card.doc;
		card.$stat.empty();
		if ((doc.type || "Document Type") !== "Document Type" || !doc.show_percentage_stats) return;
		const res = await frappe.xcall(METHODS.number_card_stats, { doc, filters: card.filters, result: card.number });
		if (res == null || isNaN(res)) return;
		const pct = frappe.format(Math.abs(flt(res)), { fieldtype: "Percent" }, { inline: true });
		const tone = res > 0 ? "green" : res < 0 ? "red" : "gray";
		const icon = res > 0 ? ui.icon(ui.icons.open, "xs") : res < 0 ? ui.icon("es-line-down", "xs") : "";
		const qualifier = (STATS_QUALIFIER[doc.stats_time_interval] || STATS_QUALIFIER.Daily)();
		card.$stat.html(
			`<span class="sanad-dashboard__stat sanad-tone--${tone}">${icon}<span>${ui.escape(__("{0} {1}", [pct, qualifier]))}</span></span>`
		);
	}

	set_card_state(card, state, err) {
		if (!state) {
			card.$state.prop("hidden", true).empty();
			card.$btn.prop("hidden", false);
			return;
		}
		card.$btn.prop("hidden", true);
		card.$state.prop("hidden", false);
		new sanad.ui.EmptyState({
			wrapper: card.$state,
			state,
			size: "sm",
			title: __(card.doc ? card.doc.label || card.name : card.name),
			description: err && err.message,
			action: { label: __("Retry"), onclick: () => this.load_card(card, { initial: true }) },
		});
	}

	/** Whether a click on the card leads somewhere; cards without a route are plain, not buttons. */
	card_route_exists(card) {
		const doc = card.doc;
		if (!doc) return false;
		if (typeof this.opts.on_card_click === "function") return true;
		const type = doc.type || "Document Type";
		if (type === "Custom") return !!(card.data && card.data.route);
		if (type === "Report") return !!doc.report_name;
		return !!doc.document_type;
	}

	/** Swap the card body between a `<button>` (openable) and a `<div>` (read-only) keeping its content. */
	set_card_openable(card, openable) {
		const is_button = card.$btn.is("button");
		if (openable === is_button) return;
		const $next = $(openable ? '<button type="button"></button>' : "<div></div>")
			.addClass("sanad-dashboard__card-btn")
			.toggleClass("sanad-dashboard__card-btn--static", !openable)
			.attr("aria-busy", card.$btn.attr("aria-busy") || "false")
			.append(card.$btn.children());
		card.$btn.replaceWith($next);
		card.$btn = $next;
		if (openable) card.$btn.on("click", () => this.open_card(card));
	}

	/** Click-through: the same route the workspace widget takes (list with the card's filters). */
	open_card(card) {
		const doc = card.doc;
		if (!doc) return;
		if (typeof this.opts.on_card_click === "function") return this.opts.on_card_click(card.name, doc, card.number);
		const type = doc.type || "Document Type";
		if (type === "Custom") {
			if (!card.data || !card.data.route) return;
			if (card.data.route_options) frappe.route_options = card.data.route_options;
			frappe.set_route(card.data.route);
			return;
		}
		const filters = card.filters || [];
		if (type === "Report") {
			if (filters && Object.keys(filters).length) frappe.route_options = filters;
			frappe.set_route(frappe.utils.generate_route({ name: doc.report_name, type: "report", is_query_report: true }));
			return;
		}
		frappe.route_options = filters.reduce((acc, f) => {
			const value = [f[2], f[3]];
			if (acc[f[1]]) acc[f[1]].push(value);
			else acc[f[1]] = [value];
			return acc;
		}, {});
		frappe.set_route(frappe.utils.generate_route({ name: doc.document_type, type: "doctype" }));
	}

	// ---- charts -------------------------------------------------------------------------------

	make_chart(name) {
		const height = cint(this.opts.chart_height) || 240;
		const id = ui.uid("sanad-chart");
		const $el = $(`
			<section class="sanad-dashboard__chart" aria-busy="true" aria-labelledby="${id}-title" aria-describedby="${id}-summary">
				<h3 class="sanad-dashboard__chart-title" id="${id}-title"></h3>
				<p class="sanad-visually-hidden" id="${id}-summary"></p>
				<div class="sanad-dashboard__chart-body" style="min-height:${height}px">
					<div class="sanad-dashboard__chart-state"></div>
					<div class="sanad-dashboard__chart-canvas" hidden aria-hidden="true"></div>
				</div>
			</section>`).appendTo(this.$charts);
		const chart = {
			name,
			$el,
			$title: $el.find(".sanad-dashboard__chart-title"),
			$summary: $el.find(`#${id}-summary`),
			$canvas: $el.find(".sanad-dashboard__chart-canvas"),
			state: new sanad.ui.EmptyState({ wrapper: $el.find(".sanad-dashboard__chart-state"), state: "loading", rows: 4 }),
			doc: null,
			instance: null,
		};
		chart.$title.text(__(name));
		return chart;
	}

	async load_chart(chart, { initial = false } = {}) {
		chart.$el.attr("aria-busy", "true");
		// Skeleton only while no chart exists: an existing instance keeps its canvas visible and is
		// refreshed in place through `update(data)` (hiding/emptying it would break its observer).
		if (initial && !chart.instance) {
			chart.$canvas.prop("hidden", true);
			chart.state.loading({ rows: 4 });
		}
		try {
			if (!chart.doc) chart.doc = await this.get_doc("Dashboard Chart", chart.name);
			const doc = chart.doc;
			chart.$title.text(__(doc.chart_name || doc.name));
			if (["Report", "Custom"].includes(doc.chart_type)) {
				throw new Error(__("{0} charts are not supported in this block", [__(doc.chart_type)]));
			}
			const data = await frappe.xcall(METHODS.chart_get, this.chart_args(doc));
			chart.data = data;
			if (!data || !data.labels || !data.labels.length) {
				this.dispose_chart(chart);
				chart.$canvas.prop("hidden", true);
				chart.$summary.text(__("No data for this period"));
				chart.state.empty({
					title: __("No data for this period"),
					description: this.period ? __("Try a wider period.") : undefined,
					action: { label: __("Refresh"), onclick: () => this.load_chart(chart, { initial: true }) },
				});
				return;
			}
			if (doc.document_type) await ui.meta.with_doctype(doc.document_type);
			chart.state.hide();
			chart.$canvas.prop("hidden", false);
			chart.$summary.text(this.chart_summary(doc, data));
			await this.draw_chart(chart, data);
		} catch (err) {
			this.dispose_chart(chart);
			chart.$canvas.prop("hidden", true);
			chart.state.error(as_error(err), { action: { label: __("Retry"), onclick: () => this.load_chart(chart, { initial: true }) } });
		} finally {
			chart.$el.attr("aria-busy", "false");
		}
	}

	/** Arguments for `dashboard_chart.get`; the period applies via `timespan` (timeseries) or a creation range (group-by). */
	chart_args(doc) {
		const args = { chart_name: doc.name, filters: frappe.dashboard_utils.get_all_filters(doc) || [], refresh: 1 };
		const range = this.period_range();
		if (range) {
			if (doc.timeseries) {
				args.timespan = "Select Date Range";
				args.from_date = range.from;
				args.to_date = `${range.to} 23:59:59`;
				args.time_interval = "Daily";
			} else if (doc.document_type && Array.isArray(args.filters)) {
				args.filters = args.filters.concat([
					[doc.document_type, "creation", ">=", range.from],
					[doc.document_type, "creation", "<=", `${range.to} 23:59:59`],
				]);
			}
		}
		return args;
	}

	/** Text alternative for the SVG: title, point count and the latest / largest value. */
	chart_summary(doc, data) {
		const labels = data.labels || [];
		const values = ((data.datasets || [])[0] || {}).values || [];
		const last = labels.length - 1;
		const title = __(doc.chart_name || doc.name);
		if (doc.timeseries) {
			return __("{0}: {1} data points, latest {2} on {3}.", [title, ui.format_int(labels.length), frappe.format(values[last], { fieldtype: "Float" }, { inline: true }), labels[last]]);
		}
		return __("{0}: {1} groups, largest {2} with {3}.", [title, ui.format_int(labels.length), labels[0], frappe.format(values[0], { fieldtype: "Float" }, { inline: true })]);
	}

	async draw_chart(chart, data) {
		const doc = chart.doc;
		const circular = ["Pie", "Donut", "Percentage"].includes(doc.type);
		const value_field = doc.value_based_on || doc.aggregate_function_based_on;
		const df = (doc.document_type && value_field && frappe.meta.get_docfield(doc.document_type, value_field)) || { fieldtype: "Int" };
		const args = {
			data,
			type: CHART_TYPES[doc.type] || "line",
			height: cint(this.opts.chart_height) || 240,
			maxSlices: doc.number_of_groups || (["Pie", "Donut"].includes(doc.type) ? 6 : 9),
			truncateLegends: 0,
			axisOptions: {
				xIsSeries: doc.timeseries ? 1 : 0,
				shortenYAxisNumbers: 1,
				xAxisMode: "tick",
				numberFormatter: frappe.utils.format_chart_axis_number,
			},
			tooltipOptions: {
				formatTooltipY: (value) =>
					doc.currency ? format_currency(value, doc.currency) : frappe.format(value, df, { always_show_decimals: df.fieldtype !== "Int", inline: true }),
			},
		};
		if (doc.color) args.colors = [doc.color];
		if (doc.show_values_over_chart) args.valuesOverPoints = true;
		// One stable container per chart: refresh through `update(data)`; circular charts (whose
		// slice count can change) are rebuilt, but only after the previous instance released its
		// ResizeObserver and window listeners, otherwise frappe-charts redraws into a removed SVG.
		if (chart.instance && !circular) {
			chart.instance.update(data);
			return;
		}
		this.dispose_chart(chart);
		chart.$canvas.empty();
		// frappe-charts measures the container on creation: wait one frame so the (shadow-root)
		// canvas has been laid out and has a real width.
		await new Promise((resolve) => window.requestAnimationFrame(resolve));
		if (chart.$canvas.prop("hidden") || !chart.$canvas[0].isConnected) return;
		chart.instance = frappe.utils.make_chart(chart.$canvas[0], args);
	}

	/** Release a frappe.Chart instance (ResizeObserver + window resize listeners) before its SVG goes. */
	dispose_chart(chart) {
		const instance = chart.instance;
		chart.instance = null;
		if (!instance) return;
		try {
			if (typeof instance.destroy === "function") instance.destroy();
			else if (instance.resizeObserver && typeof instance.resizeObserver.disconnect === "function") instance.resizeObserver.disconnect();
		} catch (e) {
			// already torn down
		}
	}

	// ---- refresh / lifecycle ------------------------------------------------------------------

	/** Reload every card and chart; `initial` shows skeletons, `announce` speaks the result. */
	refresh({ initial = false, announce = false } = {}) {
		if (this._refreshing) return this._refreshing;
		this.$refresh.prop("disabled", true);
		this._refreshing = Promise.all([
			...Object.values(this.cards).map((card) => this.load_card(card, { initial })),
			...Object.values(this.charts).map((chart) => this.load_chart(chart, { initial })),
		])
			.then(() => {
				if (announce) ui.announce(__("Dashboard updated"));
			})
			.finally(() => {
				this._refreshing = null;
				this.$refresh.prop("disabled", false);
			});
		return this._refreshing;
	}

	refresh_charts() {
		return Promise.all(Object.values(this.charts).map((chart) => this.load_chart(chart, { initial: true })));
	}

	bind() {
		const o = this.opts;
		const seconds = cint(o.refresh_seconds);
		if (seconds > 0) this._timer = window.setInterval(() => this.refresh(), seconds * 1000);
		const debounced = ui.debounce(() => this.refresh(), 1000);
		Object.entries(o.events || {}).forEach(([event, handler]) => {
			if (!handler) return;
			const fn = typeof handler === "function" ? (data) => handler(data, this) : () => debounced();
			frappe.realtime.on(event, fn);
			this._handlers.push([event, fn]);
		});
	}

	destroy() {
		if (this._timer) window.clearInterval(this._timer);
		this._handlers.forEach(([event, fn]) => frappe.realtime.off(event, fn));
		this._handlers = [];
		Object.values(this.charts).forEach((chart) => this.dispose_chart(chart));
		this.$root.remove();
	}
};

export default sanad.ui.DashboardBlock;

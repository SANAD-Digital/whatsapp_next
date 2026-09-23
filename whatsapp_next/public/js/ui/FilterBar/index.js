// sanad.ui.FilterBar — the prototype's one-row toolbar above a Desk list or a custom page:
// a search box first, then one dropdown button per filter (a multi-select checkbox popover —
// options from meta, a Link target or the caller), then a segmented period control (Today ·
// 7 days · 30 days · All) at the inline-end; optional status pills (`tabs`) on a row below and
// an optional actions row ("Group by", "Export"). On a list view it replaces Frappe's standard
// filter fields (the Filter popover and the sort selector stay) and writes into the list's own
// `filter_area`, so saved views and the URL remain the source of truth; the search box adds
// `or_filters` through `get_args`. On a page it only reports `on_change(filters, extra)`.

import ui from "../_core/index.js";

const ALL = "";
const LINK_PAGE = 20;
const SEARCH_THRESHOLD = 8;

/** Stable string key for an option value (`"a"` or `["a","b"]`). */
const key_of = (value) => (Array.isArray(value) ? JSON.stringify(value) : String(value == null ? "" : value));

const PERIOD_DEFAULTS = () => [
	{ value: 0, label: __("Today") },
	{ value: 7, label: __("7 days") },
	{ value: 30, label: __("30 days") },
	{ value: null, label: __("All") },
];

/** `"30d"` / `"7d"` / `"today"` / `"all"` / number → days or null. */
const parse_period = (v) => {
	if (v == null || v === "all" || v === "") return null;
	if (typeof v === "number") return v;
	const s = String(v).toLowerCase();
	if (s === "today") return 0;
	const m = s.match(/^(\d+)\s*d?$/);
	return m ? cint(m[1]) : null;
};

sanad.ui.FilterBar = class FilterBar {
	/**
	 * @param {Object} opts
	 * @param {Object} [opts.listview] — a Desk ListView (`frappe.views.ListView`)
	 * @param {Object} [opts.page] — a custom page (`frappe.ui.Page`) — needs `doctype` + `on_change`
	 * @param {jQuery|HTMLElement} [opts.wrapper] — explicit mount point (default: above the list / `page.main`)
	 * @param {string} [opts.doctype] — defaults to `listview.doctype`
	 * @param {Array<Object>} opts.presets — `{fieldname, type?: "select"|"tabs"|"daterange"|"search"|"period", label?,
	 *   options?: Array<string|{value,label}> | () => Promise<Array>, multiple?: boolean (select, default true),
	 *   fields?: string[] (search), placeholder?, all_label?, default?: "30d"|"7d"|"today"|"all"|number (period)}`
	 * @param {Array<string>} [opts.actions] — `"group_by"` (TreeGroupBy rail on a chosen preset field), `"export"` (Desk's exporter)
	 * @param {string} [opts.intro] — one-line description rendered above the toolbar
	 * @param {boolean} [opts.replace_standard_filters=true] — list mode: hide Frappe's standard-filter fields
	 * @param {Function} [opts.on_change] — `(filters, {or_filters, values, search}) => void` (page mode; also fired in list mode)
	 * @param {number} [opts.debounce=300] — search debounce in ms
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({ presets: [], actions: [], debounce: 300, replace_standard_filters: true }, opts);
		this.listview = this.opts.listview || null;
		this.doctype = this.opts.doctype || (this.listview && this.listview.doctype);
		if (!this.doctype) throw new Error("sanad.ui.FilterBar: doctype is required");
		this.values = {};
		this.search_text = "";
		this.controls = {};
		this.labels = {}; // fieldname → { value → label } (remembered Link titles)
		this.id = ui.uid("filterbar");
		ui.meta.with_doctype(this.doctype).then((meta) => {
			this.meta = meta;
			this.make();
		});
	}

	// ---- mount -----------------------------------------------------------------------------

	make() {
		this.$wrapper = $(
			`<div class="sanad-kit sanad-filterbar${this.listview ? " sanad-filterbar--list" : ""}" role="group" aria-label="${ui.escape(__("Filters"))}"></div>`
		);
		const $mount = this.opts.wrapper ? $(this.opts.wrapper) : null;
		if ($mount) $mount.append(this.$wrapper);
		else if (this.listview) this.listview.$frappe_list.prepend(this.$wrapper);
		else if (this.opts.page) $(this.opts.page.main).prepend(this.$wrapper);
		if (this.opts.intro) this.$wrapper.append(`<p class="sanad-filterbar__intro">${ui.escape(this.opts.intro)}</p>`);
		this.$toolbar = $('<div class="sanad-filterbar__row sanad-filterbar__row--toolbar"></div>').appendTo(this.$wrapper);
		this.$tabs = $('<div class="sanad-filterbar__row sanad-filterbar__row--tabs"></div>').appendTo(this.$wrapper);
		this.$actions = $('<div class="sanad-filterbar__actions"></div>').appendTo(this.$wrapper);
		this.$groupby = $('<div class="sanad-filterbar__groupby"></div>').appendTo(this.$wrapper);
		const of_type = (types) => this.opts.presets.filter((p) => types.includes(p.type || "select"));
		of_type(["search"]).forEach((p) => this.render_search(p));
		of_type(["select", "daterange"]).forEach((p) => (p.type === "daterange" ? this.render_daterange(p) : this.render_select(p)));
		$(`<button type="button" class="btn btn-xs btn-link sanad-filterbar__clear" hidden>${ui.escape(__("Clear filters"))}</button>`)
			.on("click", () => this.clear())
			.appendTo(this.$toolbar);
		of_type(["period"]).forEach((p) => this.render_period(p));
		of_type(["tabs"]).forEach((p) => this.render_tabs(p));
		if (!this.$tabs.children().length) this.$tabs.remove();
		this.render_actions();
		if (!this.$actions.children().length) this.$actions.remove();
		if (this.listview) this.bind_listview();
		this.sync();
		this.apply_defaults();
		$(document).on(`mousedown.${this.id} touchstart.${this.id}`, (e) => {
			if (this.$open && !$(e.target).closest(".sanad-filterbar__dd").length) this.close_popover();
		});
	}

	bind_listview() {
		const lv = this.listview;
		if (this.opts.replace_standard_filters) this.hide_standard_filters();
		// search → or_filters over the search fields (Frappe filters are AND-only)
		if (!lv._sanad_get_args) {
			lv._sanad_get_args = lv.get_args.bind(lv);
			lv._sanad_or_filters = [];
			lv.get_args = () => {
				const args = lv._sanad_get_args();
				if (lv._sanad_or_filters.length) args.or_filters = lv._sanad_or_filters;
				return args;
			};
		}
		// keep buttons / pills in step with filters set elsewhere (Filter popover, URL, sidebar)
		const orig = lv.on_filter_change.bind(lv);
		lv.on_filter_change = (...a) => {
			const r = orig(...a);
			this.sync();
			return r;
		};
	}

	/** Hide Frappe's standard-filter fields; keep the Filter popover, the sort selector and `.filter-section`. */
	hide_standard_filters() {
		const lv = this.listview;
		const $form = lv.page.page_form;
		const $std = (lv.filter_area && lv.filter_area.standard_filters_wrapper) || $form.find(".standard-filter-section");
		$std.hide().attr("aria-hidden", "true");
		$form.find(".filter-toggle").hide(); // mobile toggle of the same section
		const others = $form.children().filter((i, el) => !$(el).is(".standard-filter-section, .clearfix") && $(el).children().length);
		$form.toggleClass("hide", !others.length);
	}

	/** Period presets with a `default` apply it once, when the list has no filter on that field yet. */
	apply_defaults() {
		Object.values(this.controls).forEach((c) => {
			if (c.type !== "period" || c.preset.default === undefined) return;
			if (this.values[c.preset.fieldname] !== undefined) return;
			if (this.listview && frappe.route_options) return;
			const days = parse_period(c.preset.default);
			if (days != null) this.set(c.preset.fieldname, days);
		});
	}

	// ---- meta / options --------------------------------------------------------------------

	df(fieldname) {
		return (this.meta.fields || []).find((f) => f.fieldname === fieldname) || frappe.meta.get_docfield(this.doctype, fieldname) || { fieldname, label: fieldname, fieldtype: "Data" };
	}

	label_of(preset) {
		return preset.label || __(this.df(preset.fieldname).label || preset.fieldname);
	}

	normalise_options(list) {
		return (list || []).map((o) => (typeof o === "string" || typeof o === "number" ? { value: o, label: __(String(o)) } : { value: o.value, label: o.label || __(String(o.value)) }));
	}

	/** Static option list (Select / Check / explicit array) or `null` when options are fetched. */
	static_options(preset) {
		const df = this.df(preset.fieldname);
		if (Array.isArray(preset.options)) return this.normalise_options(preset.options);
		if (typeof preset.options === "function") return null;
		if (df.fieldtype === "Check") return [{ value: "1", label: __("Yes") }, { value: "0", label: __("No") }];
		if (df.fieldtype === "Select") {
			return (df.options || "").split("\n").map((s) => s.trim()).filter(Boolean).map((v) => ({ value: v, label: __(v) }));
		}
		if (df.fieldtype === "Link" && df.options) return null;
		return [];
	}

	/** Options for a popover → Promise<[{value, label}]>; Link targets are searched server-side. */
	resolve_options(preset, txt = "") {
		const stat = this.static_options(preset);
		if (stat) return Promise.resolve(txt ? stat.filter((o) => String(o.label).toLowerCase().includes(txt.toLowerCase())) : stat);
		if (typeof preset.options === "function") {
			return Promise.resolve(preset.options(txt)).then((list) => this.normalise_options(list));
		}
		const df = this.df(preset.fieldname);
		return ui.meta.with_doctype(df.options).then((meta) => {
			const title = meta && meta.show_title_field_in_link && meta.title_field ? meta.title_field : null;
			const fields = title ? ["name", title] : ["name"];
			const filters = txt ? [[title || "name", "like", `%${txt}%`]] : [];
			return frappe.db.get_list(df.options, { fields, filters, limit: LINK_PAGE, order_by: "modified desc" }).then((rows) =>
				(rows || []).map((r) => ({ value: r.name, label: title && r[title] ? r[title] : r.name }))
			);
		});
	}

	remember(fieldname, options) {
		this.labels[fieldname] = this.labels[fieldname] || {};
		options.forEach((o) => (this.labels[fieldname][key_of(o.value)] = o.label));
	}

	label_for_value(fieldname, value) {
		const map = this.labels[fieldname] || {};
		return map[key_of(value)] || __(String(value));
	}

	// ---- search / date range / period / tabs -----------------------------------------------

	render_search(preset) {
		const fields = preset.fields || this.search_fields();
		const label = preset.label || __("Search");
		const $field = $(`<div class="sanad-filterbar__field sanad-filterbar__field--search"></div>`).appendTo(this.$toolbar);
		const $input = $(`<input type="search" class="form-control sanad-filterbar__search" placeholder="${ui.escape(preset.placeholder || label)}" aria-label="${ui.escape(label)}">`);
		const apply = ui.debounce(() => this.set_search($input.val(), fields), this.opts.debounce);
		$input.on("input", apply).on("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.set_search($input.val(), fields);
			}
		});
		$field.append(`<span class="sanad-filterbar__search-icon" aria-hidden="true">${ui.icon("es-line-search", "sm")}</span>`).append($input);
		this.controls.__search = { preset, $el: $input, type: "search", fields };
	}

	/** Meta search fields + title field + name (used unless the preset lists `fields`). */
	search_fields() {
		const meta = this.meta;
		const out = new Set(["name"]);
		if (meta.title_field) out.add(meta.title_field);
		(meta.search_fields || "").split(",").map((s) => s.trim()).filter(Boolean).forEach((f) => out.add(f));
		return Array.from(out);
	}

	render_daterange(preset) {
		const label = this.label_of(preset);
		const $field = $(`<div class="sanad-filterbar__field sanad-filterbar__field--range"></div>`).appendTo(this.$toolbar);
		const control = frappe.ui.form.make_control({
			df: { fieldtype: "DateRange", fieldname: preset.fieldname, label, placeholder: label, onchange: () => this.set(preset.fieldname, control.get_value()) },
			parent: $field,
			render_input: true,
			only_input: true,
		});
		control.$input.attr("aria-label", label);
		this.controls[preset.fieldname] = { preset, control, type: "daterange" };
	}

	/** Segmented control (Desk `.btn-group`, the active button `btn-primary`) at the inline-end. */
	render_period(preset) {
		const p = Object.assign({ fieldname: "creation", label: __("Period") }, preset);
		const options = preset.options ? preset.options.map((o) => ({ value: parse_period(o.value), label: o.label })) : PERIOD_DEFAULTS();
		const label = this.label_of(p);
		const $group = $(`<div class="btn-group sanad-filterbar__period" role="group" aria-label="${ui.escape(label)}"></div>`);
		options.forEach((o) => {
			$(`<button type="button" class="btn btn-sm btn-default sanad-filterbar__period-btn" data-key="${ui.escape(key_of(o.value))}" aria-pressed="false">${ui.escape(o.label)}</button>`)
				.on("click", () => this.set(p.fieldname, o.value))
				.appendTo($group);
		});
		this.$toolbar.append($group);
		this.controls[p.fieldname] = { preset: p, $el: $group, type: "period", options };
	}

	render_tabs(preset) {
		const label = this.label_of(preset);
		const options = [{ value: ALL, label: preset.all_label || __("All") }].concat(this.static_options(preset) || []);
		const $list = $(`<div class="sanad-chip-row sanad-filterbar__pills" role="radiogroup" aria-label="${ui.escape(label)}"></div>`);
		options.forEach((o, i) => {
			$(`<button type="button" class="sanad-chip sanad-filterbar__pill" role="radio" data-key="${ui.escape(key_of(o.value))}" aria-checked="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${ui.escape(o.label)}</button>`)
				.on("click", () => this.set(preset.fieldname, o.value))
				.appendTo($list);
		});
		$list.on("keydown", (e) => {
			const pills = $list.find('[role="radio"]').toArray();
			const idx = ui.roving_index(e, pills, Math.max(0, pills.indexOf(document.activeElement)));
			if (idx < 0) return;
			e.preventDefault();
			pills.forEach((el) => el.setAttribute("tabindex", "-1"));
			pills[idx].setAttribute("tabindex", "0");
			pills[idx].focus();
		});
		this.$tabs.append($list);
		this.controls[preset.fieldname] = { preset, $el: $list, type: "tabs", options };
	}

	// ---- dropdown filters (multi-select popover) --------------------------------------------

	render_select(preset) {
		const p = Object.assign({ multiple: true }, preset);
		const label = this.label_of(p);
		const $dd = $(`<div class="sanad-filterbar__dd"></div>`).appendTo(this.$toolbar);
		const pop_id = `${this.id}-${p.fieldname}-pop`;
		const $btn = $(`<button type="button" class="sanad-filterbar__btn" aria-haspopup="dialog" aria-expanded="false" aria-controls="${pop_id}">
			<span class="sanad-filterbar__btn-label">${ui.escape(label)}</span><span class="sanad-filterbar__btn-value"></span>
			<span class="sanad-filterbar__chevron" aria-hidden="true">${ui.icon("es-line-down", "xs")}</span>
		</button>`)
			.on("click", () => (this.$open && this.$open.data("field") === p.fieldname ? this.close_popover() : this.open_popover(p.fieldname)))
			.on("keydown", (e) => {
				if (e.key === "ArrowDown") {
					e.preventDefault();
					this.open_popover(p.fieldname);
				}
			})
			.appendTo($dd);
		this.controls[p.fieldname] = { preset: p, $el: $btn, $dd, type: "select", pop_id, label };
		this.reflect(p.fieldname);
	}

	open_popover(fieldname) {
		this.close_popover();
		const c = this.controls[fieldname];
		const p = c.preset;
		const stat = this.static_options(p);
		const searchable = !stat || stat.length > SEARCH_THRESHOLD;
		const $pop = $(`<div class="sanad-filterbar__pop" id="${c.pop_id}" role="dialog" aria-label="${ui.escape(c.label)}" data-field="${ui.escape(fieldname)}">
			<div class="sanad-filterbar__pop-head"><span class="sanad-filterbar__pop-title">${ui.escape(c.label)}</span>
				<button type="button" class="btn btn-xs btn-default sanad-filterbar__pop-close" aria-label="${ui.escape(__("Close"))}">${ui.icon("es-line-close", "xs")}</button></div>
			${searchable ? `<input type="search" class="form-control input-xs sanad-filterbar__pop-search" placeholder="${ui.escape(__("Search"))}" aria-label="${ui.escape(__("Search {0}", [c.label]))}">` : ""}
			<div class="sanad-filterbar__pop-list" role="group" aria-labelledby="${c.pop_id}-legend"><span class="sanad-visually-hidden" id="${c.pop_id}-legend">${ui.escape(c.label)}</span></div>
			<div class="sanad-filterbar__pop-foot"><button type="button" class="btn btn-xs btn-link sanad-filterbar__pop-clear">${ui.escape(__("Clear"))}</button></div>
		</div>`).appendTo(c.$dd);
		c.$el.attr("aria-expanded", "true");
		this.$open = $pop;
		$pop.find(".sanad-filterbar__pop-close").on("click", () => this.close_popover(true));
		$pop.find(".sanad-filterbar__pop-clear").on("click", () => {
			this.set(fieldname, null);
			this.fill_popover(fieldname, $pop.find(".sanad-filterbar__pop-search").val() || "");
		});
		const $search = $pop.find(".sanad-filterbar__pop-search");
		$search.on("input", ui.debounce(() => this.fill_popover(fieldname, $search.val()), 250));
		$pop.on("keydown", (e) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				return this.close_popover(true);
			}
			if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) || $(e.target).is("input[type=search]")) return;
			const items = $pop.find(".sanad-filterbar__opt input").toArray();
			const idx = ui.roving_index(e, items, items.indexOf(document.activeElement));
			if (idx < 0) return;
			e.preventDefault();
			items[idx].focus();
		});
		this.fill_popover(fieldname, "").then(() => {
			const $first = $search.length ? $search : $pop.find(".sanad-filterbar__opt input").first();
			$first.trigger("focus");
		});
	}

	/** (Re)load the option list of the open popover; chosen values are always listed. */
	fill_popover(fieldname, txt) {
		const $pop = this.$open;
		if (!$pop || $pop.data("field") !== fieldname) return Promise.resolve();
		const c = this.controls[fieldname];
		const $list = $pop.find(".sanad-filterbar__pop-list");
		const $legend = $list.children(".sanad-visually-hidden").detach();
		$list.html(ui.skeleton(3, { lines: 1 })).prepend($legend);
		return this.resolve_options(c.preset, txt)
			.then((options) => {
				if (this.$open !== $pop) return;
				this.remember(fieldname, options);
				const chosen = this.chosen(fieldname);
				const listed = new Set(options.map((o) => key_of(o.value)));
				chosen.filter((v) => !listed.has(key_of(v))).forEach((v) => options.unshift({ value: v, label: this.label_for_value(fieldname, v) }));
				$list.empty().append($legend);
				if (!options.length) {
					$list.append(`<div class="sanad-filterbar__pop-empty">${ui.escape(txt ? __("No match for {0}", [txt]) : __("No options"))}</div>`);
					return;
				}
				const type = c.preset.multiple === false ? "radio" : "checkbox";
				options.forEach((o) => {
					const on = chosen.some((v) => key_of(v) === key_of(o.value));
					const $opt = $(`<label class="sanad-filterbar__opt"><input type="${type}" name="${c.pop_id}" value="${ui.escape(key_of(o.value))}"${on ? " checked" : ""}><span class="sanad-filterbar__opt-label">${ui.escape(o.label)}</span></label>`);
					$opt.find("input").on("change", (e) => this.toggle(fieldname, o.value, e.target.checked));
					$list.append($opt);
				});
			})
			.catch((err) => {
				$list.empty().append($legend);
				new sanad.ui.EmptyState({ wrapper: $list, state: "error", description: err.message, size: "sm", action: { label: __("Retry"), onclick: () => this.fill_popover(fieldname, txt) } });
			});
	}

	close_popover(restore_focus = false) {
		if (!this.$open) return;
		const fieldname = this.$open.data("field");
		this.$open.remove();
		this.$open = null;
		const c = this.controls[fieldname];
		if (c && c.$el) {
			c.$el.attr("aria-expanded", "false");
			if (restore_focus) c.$el.trigger("focus");
		}
	}

	/** Chosen values of a select preset as an array. */
	chosen(fieldname) {
		const v = this.values[fieldname];
		if (v == null || v === "") return [];
		return Array.isArray(v) ? v : [v];
	}

	toggle(fieldname, value, checked) {
		const c = this.controls[fieldname];
		if (c.preset.multiple === false) return this.set(fieldname, checked ? value : null);
		const next = this.chosen(fieldname).filter((v) => key_of(v) !== key_of(value));
		if (checked) next.push(value);
		this.set(fieldname, next.length ? next : null);
	}

	// ---- actions row (group by / export) ---------------------------------------------------

	render_actions() {
		const actions = this.opts.actions || [];
		if (actions.includes("group_by")) this.render_group_by();
		if (actions.includes("export") && this.listview) {
			$(`<button type="button" class="btn btn-sm btn-default sanad-filterbar__action">${ui.icon("es-line-download", "xs")} <span>${ui.escape(__("Export"))}</span></button>`)
				.on("click", () => this.export())
				.appendTo(this.$actions);
		}
	}

	render_group_by() {
		const candidates = this.opts.presets.filter((p) => ["select", "tabs"].includes(p.type || "select"));
		if (!candidates.length) return;
		const $dd = $(`<div class="sanad-filterbar__dd"></div>`).appendTo(this.$actions);
		const pop_id = `${this.id}-groupby-pop`;
		const $btn = $(`<button type="button" class="btn btn-sm btn-default sanad-filterbar__action sanad-filterbar__action--group" aria-haspopup="dialog" aria-expanded="false" aria-controls="${pop_id}">${ui.icon("es-line-sort", "xs")} <span class="sanad-filterbar__btn-label">${ui.escape(__("Group by"))}</span><span class="sanad-filterbar__btn-value"></span> ${ui.icon("es-line-down", "xs")}</button>`).appendTo($dd);
		const options = [{ value: "", label: __("None") }].concat(candidates.map((p) => ({ value: p.fieldname, label: this.label_of(p) })));
		this.remember("__group_by", options);
		this.controls.__group_by = { preset: { fieldname: "__group_by", multiple: false, options }, $el: $btn, $dd, type: "select", pop_id, label: __("Group by") };
		$btn.on("click", () => (this.$open && this.$open.data("field") === "__group_by" ? this.close_popover() : this.open_popover("__group_by")));
	}

	/** Mount (or replace / remove) a TreeGroupBy rail under the toolbar. */
	group_by(fieldname) {
		if (this.tree) {
			this.tree.destroy();
			this.tree = null;
		}
		if (!fieldname || typeof sanad.ui.TreeGroupBy !== "function") return;
		this.tree = new sanad.ui.TreeGroupBy({ listview: this.listview || undefined, doctype: this.doctype, group_by_field: fieldname, wrapper: this.$groupby, on_select: this.listview ? undefined : (value) => this.set(fieldname, value) });
	}

	/** Desk's own exporter (Data Export dialog) over the checked rows or the current filters. */
	export() {
		const lv = this.listview;
		const checked = lv.get_checked_items(true);
		const filters = checked.length ? [[this.doctype, "name", "in", checked, false]] : lv.get_filters_for_args().map((f) => f.concat([false]));
		frappe.require("data_import_tools.bundle.js", () => {
			const exporter = new frappe.data_import.DataExporter(this.doctype, "Insert New Records");
			exporter.dialog.set_value("export_records", "by_filter");
			if (filters.length) exporter.filter_group.add_filters_to_filter_group(filters);
		});
	}

	// ---- state -----------------------------------------------------------------------------

	is_empty(fieldname, value) {
		const c = this.controls[fieldname] || {};
		if (c.type === "period") return value == null || value === "";
		return value == null || value === "" || (Array.isArray(value) && !value.filter((v) => v != null && v !== "").length);
	}

	/** Set one preset's value (`""` / `null` / `[]` clears it). */
	set(fieldname, value) {
		if (fieldname === "__group_by") {
			this.values.__group_by = value || "";
			this.reflect(fieldname);
			this.group_by(value);
			return this;
		}
		const empty = this.is_empty(fieldname, value);
		const unchanged = key_of(this.values[fieldname]) === key_of(empty ? "" : value);
		if (empty) delete this.values[fieldname];
		else this.values[fieldname] = value;
		this.reflect(fieldname);
		if (unchanged) return this; // e.g. a control echoing the value sync() just set
		if (this.listview) this.apply_listview(fieldname, empty ? null : value);
		this.emit();
		return this;
	}

	set_search(text, fields) {
		this.search_text = (text || "").trim();
		this.search_fields_used = fields;
		if (this.listview) {
			const lv = this.listview;
			lv._sanad_or_filters = this.search_text ? fields.map((f) => [this.doctype, f, "like", `%${this.search_text}%`]) : [];
			lv.start = 0;
			lv.refresh();
		}
		this.reflect_clear();
		this.emit();
	}

	/** Frappe filter tuple for one preset value. */
	filter_of(fieldname, value) {
		const c = this.controls[fieldname] || {};
		if (c.type === "daterange") return [this.doctype, fieldname, "Between", value];
		if (c.type === "period") return [this.doctype, fieldname, ">=", frappe.datetime.add_days(frappe.datetime.now_date(), -cint(value))];
		if (Array.isArray(value)) return [this.doctype, fieldname, "in", value];
		return [this.doctype, fieldname, "=", value];
	}

	apply_listview(fieldname, value) {
		const lv = this.listview;
		if (value == null) return lv.filter_area.remove(fieldname);
		// replace an existing filter on the same field, then add (add() triggers the refresh)
		return lv.filter_area.remove(fieldname).then(() => lv.filter_area.add([this.filter_of(fieldname, value)]));
	}

	/** Update a button / pill / segment / control to `this.values` without emitting. */
	reflect(fieldname) {
		const c = this.controls[fieldname];
		if (!c) return;
		const value = this.values[fieldname];
		if (c.type === "select") {
			const chosen = fieldname === "__group_by" ? (value ? [value] : []) : this.chosen(fieldname);
			const $value = c.$el.find(".sanad-filterbar__btn-value");
			if (!chosen.length) $value.text("").attr("hidden", true);
			else if (chosen.length === 1) $value.text(this.label_for_value(fieldname, chosen[0])).removeAttr("hidden");
			else $value.text(ui.format_int(chosen.length)).removeAttr("hidden");
			c.$el.toggleClass("sanad-filterbar__btn--active", chosen.length > 0);
		} else if (c.type === "period") {
			const current = key_of(value == null ? null : value);
			c.$el.find(".sanad-filterbar__period-btn").each((i, el) => {
				const on = String($(el).attr("data-key")) === current;
				$(el).attr("aria-pressed", on).toggleClass("btn-primary", on).toggleClass("btn-default", !on);
			});
		} else if (c.type === "tabs") {
			const current = key_of(value == null ? ALL : value);
			c.$el.find('[role="radio"]').each((i, el) => {
				const on = String($(el).attr("data-key")) === current;
				$(el).attr("aria-checked", on).attr("tabindex", on ? 0 : -1);
			});
		} else if (c.control) {
			const current = c.control.get_value();
			if (JSON.stringify(current || "") !== JSON.stringify(value || "")) c.control.set_value(value == null ? "" : value);
		}
		this.reflect_clear();
	}

	reflect_clear() {
		const active = Object.keys(this.values).some((k) => k !== "__group_by") || !!this.search_text;
		this.$wrapper.find(".sanad-filterbar__clear").prop("hidden", !active);
	}

	/** Read the list's current filters into the bar (list mode). */
	sync() {
		if (!this.listview || !this.listview.filter_area) return;
		const filters = this.listview.filter_area.get();
		Object.keys(this.controls).forEach((fieldname) => {
			if (fieldname.startsWith("__")) return;
			const c = this.controls[fieldname];
			const f = filters.find((x) => x[1] === fieldname);
			let value = null;
			if (f) {
				if (c.type === "daterange" && f[2] === "Between") value = f[3];
				else if (c.type === "period" && f[2] === ">=") {
					const days = frappe.datetime.get_day_diff(frappe.datetime.now_date(), String(f[3]).slice(0, 10));
					const match = (c.options || []).find((o) => o.value != null && o.value === days);
					value = match ? match.value : null;
				} else if (c.type === "select" && (f[2] === "=" || f[2] === "in")) {
					const list = Array.isArray(f[3]) ? f[3] : [f[3]];
					value = c.preset.multiple === false ? list[0] : list;
				} else if (f[2] === "=" || f[2] === "in") value = f[3];
			}
			if (value == null) delete this.values[fieldname];
			else this.values[fieldname] = value;
			this.reflect(fieldname);
		});
	}

	/** Frappe-style filter list built from the bar's own values. */
	get_filters() {
		return Object.entries(this.values)
			.filter(([k]) => !k.startsWith("__"))
			.map(([fieldname, value]) => this.filter_of(fieldname, value));
	}

	get_or_filters() {
		if (!this.search_text) return [];
		return (this.search_fields_used || this.search_fields()).map((f) => [this.doctype, f, "like", `%${this.search_text}%`]);
	}

	emit() {
		if (typeof this.opts.on_change === "function") {
			this.opts.on_change(this.get_filters(), { or_filters: this.get_or_filters(), values: Object.assign({}, this.values), search: this.search_text });
		}
	}

	clear() {
		Object.keys(this.values).forEach((fieldname) => {
			if (fieldname.startsWith("__")) return;
			delete this.values[fieldname];
			this.reflect(fieldname);
			if (this.listview) this.listview.filter_area.remove(fieldname);
		});
		if (this.controls.__search) {
			this.controls.__search.$el.val("");
			this.set_search("", this.controls.__search.fields);
		} else {
			this.emit();
		}
		ui.announce(__("Filters cleared."));
	}

	destroy() {
		this.close_popover();
		$(document).off(`.${this.id}`);
		this.tree && this.tree.destroy();
		this.$wrapper && this.$wrapper.remove();
	}
};

export default sanad.ui.FilterBar;

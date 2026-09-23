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
	 * @param {Array<string>} [opts.actions] — `"group_by"` (multi-level grouping of the table),
	 *   `"export"` (Desk's exporter)
	 * @param {string} [opts.intro] — one-line description rendered above the toolbar
	 * @param {boolean} [opts.replace_standard_filters=true] — list mode: hide Frappe's standard-filter fields
	 * @param {Function} [opts.on_change] — `(filters, {or_filters, values, search}) => void` (page mode; also fired in list mode)
	 * @param {number} [opts.debounce=300] — search debounce in ms
	 * @param {number} [opts.max_inline=4] — filter buttons shown in the row; the rest stay reachable
	 *   through Desk's Filter popover, which sits in the same toolbar (prototype: one row, no wrap)
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({ presets: [], actions: [], debounce: 300, max_inline: 4, replace_standard_filters: true }, opts);
		this.listview = this.opts.listview || null;
		this.doctype = this.opts.doctype || (this.listview && this.listview.doctype);
		if (!this.doctype) throw new Error("sanad.ui.FilterBar: doctype is required");
		this.values = {};
		this.search_text = "";
		this.controls = {};
		this.labels = {}; // fieldname → { value → label } (remembered Link titles)
		this.id = ui.uid("filterbar");
		// Meta is already loaded on a list route: mount synchronously so the toolbar is painted in
		// the same frame as the list (an async mount made the page jump and re-layout twice).
		const cached = frappe.get_meta(this.doctype);
		if (cached && (cached.fields || []).length) {
			this.meta = cached;
			this.make();
		} else {
			ui.meta.with_doctype(this.doctype).then((meta) => {
				this.meta = meta;
				this.make();
			});
		}
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
		// One row, one button style (prototype `List View` toolbar): search and the filter buttons at
		// the inline-start, then a single cluster at the inline-end — period, Group by, Export and
		// Desk's own Filter popover, all restyled to the same 32 px control.
		this.$toolbar = $('<div class="sanad-filterbar__row sanad-filterbar__row--toolbar"></div>').appendTo(this.$wrapper);
		this.$tabs = $('<div class="sanad-filterbar__row sanad-filterbar__row--tabs"></div>').appendTo(this.$wrapper);
		this.$groupby = $('<div class="sanad-filterbar__groupby"></div>').appendTo(this.$wrapper);
		const of_type = (types) => this.opts.presets.filter((p) => types.includes(p.type || "select"));
		of_type(["search"]).forEach((p) => this.render_search(p));
		of_type(["select", "daterange"])
			.slice(0, cint(this.opts.max_inline) || 99)
			.forEach((p) => (p.type === "daterange" ? this.render_daterange(p) : this.render_select(p)));
		$(`<button type="button" class="sanad-filterbar__clear" hidden>${ui.escape(__("Clear filters"))}</button>`)
			.on("click", () => this.clear())
			.appendTo(this.$toolbar);
		this.render_mobile_toggle();
		this.$end = $('<div class="sanad-filterbar__end"></div>').appendTo(this.$toolbar);
		this.$actions = $('<div class="sanad-filterbar__actions"></div>').appendTo(this.$end);
		of_type(["period"]).forEach((p) => this.render_period(p));
		of_type(["tabs"]).forEach((p) => this.render_tabs(p));
		if (!this.$tabs.children().length) this.$tabs.remove();
		this.render_actions();
		if (this.listview) {
			this.listview._sanad_filterbar = this;
			this.bind_listview();
		}
		if (!this.$actions.children().length) this.$actions.remove();
		if (!this.$end.children().length) this.$end.remove();
		this.sync();
		this.apply_defaults();
		$(document).on(`mousedown.${this.id} touchstart.${this.id}`, (e) => {
			if ($(e.target).closest(".sanad-filterbar__dd").length) return;
			this.close_popover();
			this.close_levels();
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

	/**
	 * Replace Frappe's filter row with this toolbar (D-064 / R-038: the prototype has one toolbar,
	 * not two). The standard filter fields are hidden, and Frappe's own Filter popover and sort
	 * selector are *moved* into this bar's action row — nothing becomes unreachable — after which
	 * the now-empty `page_form` row is hidden, which also removes a whole layout row above the list.
	 */
	hide_standard_filters() {
		const lv = this.listview;
		const $form = lv.page.page_form;
		const $std = (lv.filter_area && lv.filter_area.standard_filters_wrapper) || $form.find(".standard-filter-section");
		$std.hide().attr("aria-hidden", "true");
		$form.find(".filter-toggle").hide(); // mobile toggle of the same section
		const $section = $form.find(".filter-section");
		if ($section.length && this.$actions && this.$actions.parent().length) {
			$section.find(".sort-selector").hide(); // the table's own column headers sort
			$section.find(".filter-button .button-label").hide(); // icon only; the kit buttons name what is set
			$section.find(".filter-button").attr("title", __("More filters"));
			$section.addClass("sanad-filterbar__native").appendTo(this.$actions);
		}
		const others = $form.children().filter((i, el) => !$(el).is(".standard-filter-section, .clearfix") && $(el).children().length);
		$form.toggleClass("hide", !others.length);
		// on phones Desk re-orders and re-shows `page_form` after this runs, so mark the page and
		// let CSS keep the row down for good
		lv.page.wrapper.addClass("sanad-hide-page-form");
	}

	/** Period presets with a `default` apply it once, when the list has no filter on that field yet. */
	apply_defaults() {
		Object.values(this.controls).forEach((c) => {
			if (c.type !== "period" || c.preset.default === undefined) return;
			if (this.values[c.preset.fieldname] !== undefined) return;
			if (this.listview && frappe.route_options && Object.keys(frappe.route_options).length) return;
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
		// a fetched list (Link target / callback) is cached per search text, so re-opening the same
		// dropdown is instant instead of another round trip
		const key = `${preset.fieldname}::${txt || ""}`;
		this._options_cache = this._options_cache || {};
		if (this._options_cache[key]) return Promise.resolve(this._options_cache[key]);
		return this.fetch_options(preset, txt).then((options) => {
			this._options_cache[key] = options;
			return options;
		});
	}

	fetch_options(preset, txt = "") {
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
		const $group = $(`<div class="sanad-filterbar__period" role="group" aria-label="${ui.escape(label)}"></div>`);
		options.forEach((o) => {
			$(`<button type="button" class="sanad-filterbar__period-btn" data-key="${ui.escape(key_of(o.value))}" aria-pressed="false">${ui.escape(o.label)}</button>`)
				.on("click", () => this.set(p.fieldname, o.value))
				.appendTo($group);
		});
		if (this.$actions && this.$actions.parent().length) $group.insertBefore(this.$actions);
		else this.$end.append($group);
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

	/**
	 * Under 768 px the prototype hides the filter buttons behind one "Filters" button carrying the
	 * number that is set; it opens a sheet holding the same option lists. The button is always in
	 * the DOM and shown by the media query, so there is no resize listener to get wrong.
	 */
	render_mobile_toggle() {
		this.$mobile_btn = $(`<button type="button" class="sanad-filterbar__btn sanad-filterbar__mobile-toggle">${ui.icon("es-line-filter", "xs")}<span>${ui.escape(__("Filters"))}</span><span class="sanad-filterbar__mobile-count sanad-tabular" hidden></span></button>`)
			.on("click", () => this.open_filter_sheet())
			.appendTo(this.$toolbar);
	}

	reflect_mobile() {
		if (!this.$mobile_btn) return;
		const n = Object.keys(this.values).filter((k) => !k.startsWith("__") && this.controls[k] && this.controls[k].type === "select").length;
		this.$mobile_btn.find(".sanad-filterbar__mobile-count").prop("hidden", !n).text(ui.format_int(n));
		this.$mobile_btn.toggleClass("sanad-filterbar__btn--active", !!n);
	}

	/** Every select preset as one section in a full-height sheet (kit dialogs share `.sanad-sheet`). */
	open_filter_sheet() {
		const presets = this.opts.presets.filter((p) => (p.type || "select") === "select");
		const dialog = new frappe.ui.Dialog({ title: __("Filters"), fields: [{ fieldtype: "HTML", fieldname: "body" }], primary_action_label: __("Done"), primary_action: () => dialog.hide() });
		dialog.$wrapper.addClass("sanad-kit sanad-sheet sanad-filter-sheet");
		dialog.set_secondary_action_label(__("Clear all"));
		dialog.set_secondary_action(() => {
			this.clear();
			dialog.hide();
		});
		const $body = dialog.get_field("body").$wrapper.empty();
		presets.forEach((preset) => {
			const label = this.label_of(preset);
			const $section = $(`<section class="sanad-filter-sheet__section"><h3 class="sanad-filter-sheet__title">${ui.escape(label)}</h3><div class="sanad-filter-sheet__list"></div></section>`).appendTo($body);
			const $list = $section.find(".sanad-filter-sheet__list").html(ui.skeleton(2, { lines: 1 }));
			this.resolve_options(preset, "")
				.then((options) => {
					this.remember(preset.fieldname, options);
					$list.empty();
					if (!options.length) return $list.append(`<div class="sanad-filterbar__pop-empty">${ui.escape(__("No options"))}</div>`);
					const type = preset.multiple === false ? "radio" : "checkbox";
					options.forEach((o) => {
						const on = this.chosen(preset.fieldname).some((v) => key_of(v) === key_of(o.value));
						const $opt = $(`<label class="sanad-filterbar__opt"><input type="${type}" name="${this.id}-sheet-${ui.escape(preset.fieldname)}" value="${ui.escape(key_of(o.value))}"${on ? " checked" : ""}><span class="sanad-filterbar__opt-label">${ui.escape(o.label)}</span></label>`);
						$opt.find("input").on("change", (e) => this.toggle(preset.fieldname, o.value, e.target.checked));
						$list.append($opt);
					});
					return undefined;
				})
				.catch((err) => {
					$list.empty();
					new sanad.ui.EmptyState({ wrapper: $list, state: "error", size: "sm", description: err.message });
				});
		});
		dialog.show();
		return dialog;
	}

	// ---- dropdown filters (multi-select popover) --------------------------------------------

	render_select(preset) {
		const p = Object.assign({ multiple: true }, preset);
		const label = this.label_of(p);
		const $dd = $(`<div class="sanad-filterbar__dd"></div>`).appendTo(this.$toolbar);
		const pop_id = `${this.id}-${p.fieldname}-pop`;
		const $btn = $(`<button type="button" class="sanad-filterbar__btn" aria-haspopup="dialog" aria-expanded="false" aria-controls="${pop_id}">
			<span class="sanad-filterbar__btn-label">${ui.escape(label)}</span><span class="sanad-filterbar__btn-value"></span>
			<span class="sanad-filterbar__btn-clear" title="${ui.escape(__("Clear {0}", [label]))}" hidden>${ui.icon("es-line-close", "xs")}</span>
			<span class="sanad-filterbar__chevron" aria-hidden="true">${ui.icon("es-line-down", "xs")}</span>
		</button>`)
			.on("click", (e) => {
				// the inline × clears this one filter instead of opening the list
				if ($(e.target).closest(".sanad-filterbar__btn-clear").length) {
					this.close_popover();
					return this.set(p.fieldname, null);
				}
				return this.$open && this.$open.data("field") === p.fieldname ? this.close_popover() : this.open_popover(p.fieldname);
			})
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
			$(`<button type="button" class="sanad-filterbar__action sanad-filterbar__action--icon" title="${ui.escape(__("Export"))}" aria-label="${ui.escape(__("Export"))}">${ui.icon("download", "sm")}</button>`)
				.on("click", () => this.export())
				.appendTo(this.$actions);
		}
	}

	/**
	 * The prototype's grouping control: a button that names the active levels, opening a popover
	 * with the ordered levels (each removable, movable up / down), the fields that can still be
	 * added, and "Remove all". It drives the DataList's multi-level group rows.
	 */
	render_group_by() {
		const $dd = $(`<div class="sanad-filterbar__dd sanad-filterbar__dd--group"></div>`).appendTo(this.$actions);
		const pop_id = `${this.id}-levels-pop`;
		this.$group_btn = $(`<button type="button" class="sanad-filterbar__action sanad-filterbar__action--group" aria-haspopup="dialog" aria-expanded="false" aria-controls="${pop_id}">${ui.icon("es-line-sort", "sm")}<span class="sanad-filterbar__levels"></span></button>`).appendTo($dd);
		this.$group_dd = $dd;
		this.group_pop_id = pop_id;
		this.$group_btn.on("click", () => (this.$levels ? this.close_levels() : this.open_levels()));
		// DataList usually mounts after this bar: label the button once the table is there
		this.reflect_levels();
		window.setTimeout(() => this.reflect_levels(), 0);
	}

	/** The table this bar groups (set by DataList through `listview._sanad_datalist`). */
	datalist() {
		return this.listview && this.listview._sanad_datalist;
	}

	group_levels() {
		const dl = this.datalist();
		return dl ? dl.group_by.slice() : [];
	}

	set_group_levels(levels) {
		const dl = this.datalist();
		if (dl) dl.set_group_by(levels);
		this.reflect_levels();
		if (this.$levels) this.fill_levels();
	}

	reflect_levels() {
		if (!this.$group_btn) return;
		const dl = this.datalist();
		const levels = this.group_levels();
		const label_of = (f) => {
			const col = dl && dl.columns.find((c) => c.fieldname === f);
			return col ? col.label : __(f);
		};
		const text = levels.map(label_of).join(" › ");
		this.$group_btn
			.toggleClass("sanad-filterbar__action--active", !!levels.length)
			.attr("title", levels.length ? __("Grouped by {0}", [text]) : __("Group by"))
			.attr("aria-label", levels.length ? __("Grouped by {0}", [text]) : __("Group by"))
			.find(".sanad-filterbar__levels")
			.text(text);
	}

	open_levels() {
		this.close_popover();
		const $pop = $(`<div class="sanad-filterbar__pop sanad-filterbar__pop--levels" id="${this.group_pop_id}" role="dialog" aria-label="${ui.escape(__("Grouping levels"))}"></div>`).appendTo(this.$group_dd);
		this.$levels = $pop;
		this.$group_btn.attr("aria-expanded", "true");
		this.fill_levels();
		$pop.on("keydown", (e) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				this.close_levels(true);
			}
		});
	}

	fill_levels() {
		const $pop = this.$levels;
		if (!$pop) return;
		const dl = this.datalist();
		const options = dl ? dl.group_options() : [];
		const levels = this.group_levels();
		const label_of = (f) => (options.find((o) => o.value === f) || { label: __(f) }).label;
		$pop.empty();
		$pop.append(`<div class="sanad-filterbar__pop-head"><span class="sanad-filterbar__pop-title">${ui.escape(__("Grouping levels"))}</span>${levels.length ? `<button type="button" class="sanad-filterbar__levels-clear">${ui.escape(__("Remove all"))}</button>` : ""}</div>`);
		const $list = $(`<div class="sanad-filterbar__levels-list"></div>`).appendTo($pop);
		levels.forEach((f, i) => {
			$(`<div class="sanad-filterbar__level">
				<span class="sanad-filterbar__level-no sanad-tabular">${ui.escape(ui.format_int(i + 1))}</span>
				<span class="sanad-filterbar__level-label">${ui.escape(label_of(f))}</span>
				<button type="button" class="sanad-filterbar__level-move" data-dir="-1" ${i === 0 ? "disabled" : ""} aria-label="${ui.escape(__("Move {0} up", [label_of(f)]))}">${ui.icon("es-line-up", "xs")}</button>
				<button type="button" class="sanad-filterbar__level-move" data-dir="1" ${i === levels.length - 1 ? "disabled" : ""} aria-label="${ui.escape(__("Move {0} down", [label_of(f)]))}">${ui.icon("es-line-down", "xs")}</button>
				<button type="button" class="sanad-filterbar__level-remove" aria-label="${ui.escape(__("Remove level {0}", [label_of(f)]))}">${ui.icon("es-line-close", "xs")}</button>
			</div>`)
				.attr("data-field", f)
				.appendTo($list);
		});
		const rest = options.filter((o) => !levels.includes(o.value));
		if (rest.length) {
			$pop.append(`<div class="sanad-filterbar__pop-title sanad-filterbar__levels-add">${ui.escape(__("Add a level"))}</div>`);
			const $add = $(`<div class="sanad-filterbar__levels-list"></div>`).appendTo($pop);
			rest.forEach((o) => {
				$(`<button type="button" class="sanad-filterbar__level sanad-filterbar__level--add"><span class="sanad-filterbar__level-label">${ui.escape(o.label)}</span><span class="sanad-filterbar__level-plus" aria-hidden="true">+</span></button>`)
					.attr("data-field", o.value)
					.appendTo($add);
			});
		}
		$pop.find(".sanad-filterbar__levels-clear").on("click", () => this.set_group_levels([]));
		$pop.find(".sanad-filterbar__level--add").on("click", (e) => this.set_group_levels(this.group_levels().concat($(e.currentTarget).data("field"))));
		$pop.find(".sanad-filterbar__level-remove").on("click", (e) => {
			const f = $(e.currentTarget).closest(".sanad-filterbar__level").data("field");
			this.set_group_levels(this.group_levels().filter((x) => x !== f));
		});
		$pop.find(".sanad-filterbar__level-move").on("click", (e) => {
			const dir = cint($(e.currentTarget).data("dir"));
			const f = $(e.currentTarget).closest(".sanad-filterbar__level").data("field");
			const next = this.group_levels();
			const i = next.indexOf(f);
			if (i < 0 || i + dir < 0 || i + dir >= next.length) return;
			next.splice(i + dir, 0, next.splice(i, 1)[0]);
			this.set_group_levels(next);
		});
	}

	close_levels(restore_focus = false) {
		if (!this.$levels) return;
		this.$levels.remove();
		this.$levels = null;
		this.$group_btn.attr("aria-expanded", "false");
		if (restore_focus) this.$group_btn.trigger("focus");
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

	/**
	 * Write one preset into the list's filters and refresh **once**.
	 * Frappe's `filter_area.remove()` and `add()` each schedule their own (debounced) refresh, so a
	 * plain remove-then-add fetched the list twice per click. Both are run with the area's
	 * `trigger_refresh` flag down and a single `refresh()` is issued here.
	 */
	apply_listview(fieldname, value) {
		const lv = this.listview;
		const area = lv.filter_area;
		const has = area.get().some((f) => f[1] === fieldname);
		if (!has && value == null) return Promise.resolve();
		return this.quietly(() => {
			const removed = has ? area.remove(fieldname) : Promise.resolve();
			return value == null ? removed : removed.then(() => area.add([this.filter_of(fieldname, value)], false));
		}).then(() => this.refresh_list());
	}

	/** Run `fn` with Frappe's own filter refresh suppressed (it is debounced by 300 ms). */
	quietly(fn) {
		const area = this.listview.filter_area;
		area.trigger_refresh = false;
		window.clearTimeout(this._restore);
		return Promise.resolve(fn()).then(
			(out) => {
				this._restore = window.setTimeout(() => (area.trigger_refresh = true), 400);
				return out;
			},
			(err) => {
				this._restore = window.setTimeout(() => (area.trigger_refresh = true), 400);
				throw err;
			}
		);
	}

	/** The one refresh a filter change is allowed to cost. */
	refresh_list() {
		const lv = this.listview;
		lv.start = 0;
		const out = lv.refresh();
		this.sync();
		return out;
	}

	/** Update a button / pill / segment / control to `this.values` without emitting. */
	reflect(fieldname) {
		const c = this.controls[fieldname];
		if (!c) return;
		const value = this.values[fieldname];
		if (c.type === "select") {
			const chosen = this.chosen(fieldname);
			const $value = c.$el.find(".sanad-filterbar__btn-value");
			if (!chosen.length) $value.text("").attr("hidden", true);
			else if (chosen.length === 1) $value.text(this.label_for_value(fieldname, chosen[0])).removeAttr("hidden");
			else $value.text(ui.format_int(chosen.length)).removeAttr("hidden");
			c.$el.toggleClass("sanad-filterbar__btn--active", chosen.length > 0);
			c.$el.find(".sanad-filterbar__btn-clear").prop("hidden", !chosen.length);
		} else if (c.type === "period") {
			const current = key_of(value == null ? null : value);
			c.$el.find(".sanad-filterbar__period-btn").each((i, el) => {
				$(el).attr("aria-pressed", String($(el).attr("data-key")) === current);
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
		this.reflect_mobile();
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
		const fields = Object.keys(this.values).filter((f) => !f.startsWith("__"));
		fields.forEach((fieldname) => {
			delete this.values[fieldname];
			this.reflect(fieldname);
		});
		if (this.controls.__search) {
			this.controls.__search.$el.val("");
			this.search_text = "";
			if (this.listview) this.listview._sanad_or_filters = [];
		}
		const done = this.listview
			? this.quietly(() => fields.reduce((chain, f) => chain.then(() => this.listview.filter_area.remove(f)), Promise.resolve())).then(() => this.refresh_list())
			: Promise.resolve();
		this.reflect_clear();
		this.emit();
		ui.announce(__("Filters cleared."));
		return done;
	}

	destroy() {
		this.close_popover();
		this.close_levels();
		$(document).off(`.${this.id}`);
		this.$wrapper && this.$wrapper.remove();
	}
};

export default sanad.ui.FilterBar;

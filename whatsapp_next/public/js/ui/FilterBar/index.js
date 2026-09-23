// sanad.ui.FilterBar — a compact preset bar (status tabs, selects, a date range, a search box)
// rendered above a Desk list or a custom page. On a list view every control writes into the
// list's own `filter_area`, so the standard filter UI, saved views and the URL stay the source of
// truth; the search box adds `or_filters` over the meta search fields through `get_args`. On a
// page it only reports `on_change(filters, extra)`. Options come from meta unless supplied.

import ui from "../_core/index.js";

const ALL = "";

/** Stable string key for an option value (`"a"` or `["a","b"]`). */
const key_of = (value) => (Array.isArray(value) ? JSON.stringify(value) : String(value == null ? "" : value));

sanad.ui.FilterBar = class FilterBar {
	/**
	 * @param {Object} opts
	 * @param {Object} [opts.listview] — a Desk ListView (`frappe.views.ListView`)
	 * @param {Object} [opts.page] — a custom page (`frappe.ui.Page`) — needs `doctype` + `on_change`
	 * @param {jQuery|HTMLElement} [opts.wrapper] — explicit mount point (default: above the list / `page.main`)
	 * @param {string} [opts.doctype] — defaults to `listview.doctype`
	 * @param {Array<{fieldname: string, label?: string, type: "tabs"|"select"|"daterange"|"search", options?: Array, fields?: string[], all_label?: string}>} opts.presets
	 * @param {Function} [opts.on_change] — `(filters, {or_filters, values}) => void` (page mode; also fired in list mode)
	 * @param {number} [opts.debounce=300] — search debounce in ms
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({ presets: [], debounce: 300 }, opts);
		this.listview = this.opts.listview || null;
		this.doctype = this.opts.doctype || (this.listview && this.listview.doctype);
		if (!this.doctype) throw new Error("sanad.ui.FilterBar: doctype is required");
		this.values = {};
		this.search_text = "";
		this.controls = {};
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
		this.$tabs = $('<div class="sanad-filterbar__row sanad-filterbar__row--tabs"></div>').appendTo(this.$wrapper);
		this.$controls = $('<div class="sanad-filterbar__row sanad-filterbar__row--controls"></div>').appendTo(this.$wrapper);
		this.opts.presets.forEach((preset) => this.render_preset(preset));
		if (!this.$tabs.children().length) this.$tabs.remove();
		if (!this.$controls.children().length) this.$controls.remove();
		this.$wrapper.append(
			`<button type="button" class="btn btn-xs btn-link sanad-filterbar__clear" hidden>${ui.escape(__("Clear filters"))}</button>`
		);
		this.$wrapper.find(".sanad-filterbar__clear").on("click", () => this.clear());
		if (this.listview) this.bind_listview();
		this.sync();
	}

	bind_listview() {
		const lv = this.listview;
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
		// keep tabs / selects in step with filters set elsewhere (standard filters, URL, sidebar)
		const orig = lv.on_filter_change.bind(lv);
		lv.on_filter_change = (...a) => {
			const r = orig(...a);
			this.sync();
			return r;
		};
	}

	// ---- presets ---------------------------------------------------------------------------

	df(fieldname) {
		return (this.meta.fields || []).find((f) => f.fieldname === fieldname) || frappe.meta.get_docfield(this.doctype, fieldname) || { fieldname, label: fieldname, fieldtype: "Data" };
	}

	label_of(preset) {
		return preset.label || __(this.df(preset.fieldname).label || preset.fieldname);
	}

	/** `{value, label}` list for a Select / Check / explicit options preset. */
	options_of(preset) {
		const df = this.df(preset.fieldname);
		if (preset.options) {
			return preset.options.map((o) => (typeof o === "string" ? { value: o, label: __(o) } : { value: o.value, label: o.label || __(String(o.value)) }));
		}
		if (df.fieldtype === "Check") return [{ value: "1", label: __("Yes") }, { value: "0", label: __("No") }];
		if (df.fieldtype === "Select") {
			return (df.options || "").split("\n").map((s) => s.trim()).filter(Boolean).map((v) => ({ value: v, label: __(v) }));
		}
		return [];
	}

	render_preset(preset) {
		switch (preset.type) {
			case "tabs":
				return this.render_tabs(preset);
			case "daterange":
				return this.render_daterange(preset);
			case "search":
				return this.render_search(preset);
			default:
				return this.render_select(preset);
		}
	}

	render_tabs(preset) {
		const label = this.label_of(preset);
		const options = [{ value: ALL, label: preset.all_label || __("All") }].concat(this.options_of(preset));
		const $list = $(`<div class="sanad-chip-row sanad-filterbar__tabs" role="radiogroup" aria-label="${ui.escape(label)}"></div>`);
		options.forEach((o, i) => {
			$(`<button type="button" class="sanad-chip sanad-filterbar__tab" role="radio" data-key="${ui.escape(key_of(o.value))}" aria-checked="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${ui.escape(o.label)}</button>`)
				.on("click", () => this.set(preset.fieldname, o.value))
				.appendTo($list);
		});
		// arrows / Home / End only move focus (manual activation); Enter / Space click the radio
		$list.on("keydown", (e) => this.tabs_keydown(e, $list));
		this.$tabs.append($list);
		this.controls[preset.fieldname] = { preset, $el: $list, type: "tabs", options };
	}

	tabs_keydown(e, $list) {
		const tabs = $list.find('[role="radio"]').toArray();
		const idx = ui.roving_index(e, tabs, Math.max(0, tabs.indexOf(document.activeElement)));
		if (idx < 0) return;
		e.preventDefault();
		tabs.forEach((el) => el.setAttribute("tabindex", "-1"));
		tabs[idx].setAttribute("tabindex", "0");
		tabs[idx].focus();
	}

	render_select(preset) {
		const df = this.df(preset.fieldname);
		const label = this.label_of(preset);
		const $field = $(`<div class="sanad-filterbar__field"></div>`).appendTo(this.$controls);
		const on_change = ui.debounce((value) => this.set(preset.fieldname, value), 150);
		if (df.fieldtype === "Link" && !preset.options) {
			const control = frappe.ui.form.make_control({
				df: { fieldtype: "Link", fieldname: preset.fieldname, label, options: df.options, placeholder: label, onchange: () => on_change(control.get_value()) },
				parent: $field,
				render_input: true,
				only_input: true,
			});
			control.$input.attr("aria-label", label);
			this.controls[preset.fieldname] = { preset, control, type: "link" };
			return;
		}
		const id = `${this.id}-${preset.fieldname}`;
		$field.append(`<label class="sanad-visually-hidden" for="${id}">${ui.escape(label)}</label>`);
		const $select = $(`<select id="${id}" class="form-control sanad-filterbar__select"></select>`);
		$select.append(`<option value="">${ui.escape(preset.all_label || __("{0}: all", [label]))}</option>`);
		const options = this.options_of(preset);
		options.forEach((o) => $select.append(`<option value="${ui.escape(key_of(o.value))}">${ui.escape(o.label)}</option>`));
		$select.on("change", () => {
			const o = options.find((x) => key_of(x.value) === $select.val());
			this.set(preset.fieldname, o ? o.value : "");
		});
		$field.append($select);
		this.controls[preset.fieldname] = { preset, $el: $select, type: "select", options };
	}

	render_daterange(preset) {
		const label = this.label_of(preset);
		const $field = $(`<div class="sanad-filterbar__field sanad-filterbar__field--range"></div>`).appendTo(this.$controls);
		const control = frappe.ui.form.make_control({
			df: { fieldtype: "DateRange", fieldname: preset.fieldname, label, placeholder: label, onchange: () => this.set(preset.fieldname, control.get_value()) },
			parent: $field,
			render_input: true,
			only_input: true,
		});
		control.$input.attr("aria-label", label);
		this.controls[preset.fieldname] = { preset, control, type: "daterange" };
	}

	render_search(preset) {
		const fields = preset.fields || this.search_fields();
		const label = preset.label || __("Search");
		const $field = $(`<div class="sanad-filterbar__field sanad-filterbar__field--search"></div>`).appendTo(this.$controls);
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

	// ---- state -----------------------------------------------------------------------------

	/** Set one preset's value (`""` / `null` clears it). */
	set(fieldname, value) {
		const empty = value == null || value === "" || (Array.isArray(value) && !value.filter(Boolean).length);
		const unchanged = key_of(this.values[fieldname]) === key_of(empty ? "" : value);
		if (empty) delete this.values[fieldname];
		else this.values[fieldname] = value;
		this.reflect(fieldname);
		if (unchanged) return this; // e.g. a Link control echoing the value sync() just set
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

	apply_listview(fieldname, value) {
		const lv = this.listview;
		const control = this.controls[fieldname] || {};
		if (value == null) return lv.filter_area.remove(fieldname);
		let filter;
		if (control.type === "daterange") filter = [this.doctype, fieldname, "Between", value];
		else if (Array.isArray(value)) filter = [this.doctype, fieldname, "in", value];
		else filter = [this.doctype, fieldname, "=", value];
		// replace an existing filter on the same field, then add (add() triggers the refresh)
		return lv.filter_area.remove(fieldname).then(() => lv.filter_area.add([filter]));
	}

	/** Update the active tab / select / range to `this.values` without emitting. */
	reflect(fieldname) {
		const c = this.controls[fieldname];
		if (!c) return;
		const value = this.values[fieldname];
		if (c.type === "tabs") {
			const current = key_of(value == null ? ALL : value);
			c.$el.find('[role="radio"]').each((i, el) => {
				const on = String($(el).attr("data-key")) === current;
				$(el).attr("aria-checked", on).attr("tabindex", on ? 0 : -1);
			});
		} else if (c.type === "select") {
			c.$el.val(value == null ? "" : key_of(value));
		} else if (c.control) {
			const current = c.control.get_value();
			if (JSON.stringify(current || "") !== JSON.stringify(value || "")) c.control.set_value(value == null ? "" : value);
		}
		this.reflect_clear();
	}

	reflect_clear() {
		const active = Object.keys(this.values).length > 0 || !!this.search_text;
		this.$wrapper.find(".sanad-filterbar__clear").prop("hidden", !active);
	}

	/** Read the list's current filters into the bar (list mode). */
	sync() {
		if (!this.listview || !this.listview.filter_area) return;
		const filters = this.listview.filter_area.get();
		Object.keys(this.controls).forEach((fieldname) => {
			if (fieldname === "__search") return;
			const c = this.controls[fieldname];
			const f = filters.find((x) => x[1] === fieldname);
			let value = null;
			if (f) {
				if (c.type === "daterange" && f[2] === "Between") value = f[3];
				else if (f[2] === "=" || f[2] === "in") value = f[3];
			}
			if (value == null) delete this.values[fieldname];
			else this.values[fieldname] = value;
			this.reflect(fieldname);
		});
	}

	/** Frappe-style filter list built from the bar's own values. */
	get_filters() {
		return Object.entries(this.values).map(([fieldname, value]) => {
			const c = this.controls[fieldname] || {};
			if (c.type === "daterange") return [this.doctype, fieldname, "Between", value];
			return Array.isArray(value) ? [this.doctype, fieldname, "in", value] : [this.doctype, fieldname, "=", value];
		});
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
		ui.announce(__("Filters cleared"));
	}

	destroy() {
		this.$wrapper && this.$wrapper.remove();
	}
};

export default sanad.ui.FilterBar;

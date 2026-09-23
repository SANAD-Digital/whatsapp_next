// sanad.ui.TreeGroupBy — a "group by" rail with counts for one field: on a Desk list it reads
// `frappe.desk.listview.get_group_by_count` (the list's own filters minus this field) and applies
// `= value` through `filter_area`; on a custom page it calls the host's `counts_method` and
// reports `on_select(value)`. Labels come from meta (Link titles, Select options, Check → Yes/No).
// Frappe 16 hides the list sidebar, so the rail sits above the list (chips) and becomes a
// `<select>` under 768 px.

import ui from "../_core/index.js";

const ALL = "__all__";

sanad.ui.TreeGroupBy = class TreeGroupBy {
	/**
	 * @param {Object} opts
	 * @param {Object} [opts.listview] — a Desk ListView
	 * @param {Object} [opts.page] — a custom page (`frappe.ui.Page`); needs `counts_method`
	 * @param {jQuery|HTMLElement} [opts.wrapper] — explicit mount point
	 * @param {string} [opts.doctype] — defaults to `listview.doctype`
	 * @param {string} opts.group_by_field
	 * @param {string} [opts.label] — rail label (default: the field label)
	 * @param {string} [opts.counts_method] — api key returning `[{name, count, title?}]` (page mode)
	 * @param {Function} [opts.counts_args] — `() => args` for `counts_method`
	 * @param {Function} [opts.on_select] — `(value|null, row) => void`
	 * @param {boolean} [opts.show_all=true] — "All" entry with the total
	 * @param {number} [opts.limit=12] — chips shown before "More…" (the select shows all)
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({ show_all: true, limit: 12 }, opts);
		this.listview = this.opts.listview || null;
		this.doctype = this.opts.doctype || (this.listview && this.listview.doctype);
		this.field = this.opts.group_by_field;
		if (!this.field) throw new Error("sanad.ui.TreeGroupBy: group_by_field is required");
		this.rows = [];
		this.selected = null;
		this.id = ui.uid("groupby");
		const ready = this.doctype ? ui.meta.with_doctype(this.doctype) : Promise.resolve(null);
		ready.then((meta) => {
			this.meta = meta;
			this.df = meta ? frappe.meta.get_docfield(this.doctype, this.field) || {} : {};
			this.make();
			this.refresh();
		});
	}

	make() {
		const label = this.opts.label || __(this.df.label || this.field);
		this.$wrapper = $(`<div class="sanad-kit sanad-groupby${this.listview ? " sanad-groupby--list" : ""}"></div>`);
		const $mount = this.opts.wrapper ? $(this.opts.wrapper) : null;
		if ($mount) $mount.append(this.$wrapper);
		else if (this.listview) {
			const $bar = this.listview.$frappe_list.children(".sanad-filterbar").first();
			if ($bar.length) $bar.after(this.$wrapper);
			else this.listview.$frappe_list.prepend(this.$wrapper);
		} else if (this.opts.page) $(this.opts.page.main).prepend(this.$wrapper);
		this.$wrapper.html(`
			<div class="sanad-groupby__label" id="${this.id}-label">${ui.escape(label)}</div>
			<div class="sanad-chip-row sanad-groupby__chips" role="group" aria-labelledby="${this.id}-label"></div>
			<select class="form-control sanad-groupby__select" aria-labelledby="${this.id}-label"></select>
			<div class="sanad-groupby__state"></div>`);
		this.$chips = this.$wrapper.find(".sanad-groupby__chips");
		this.$select = this.$wrapper.find(".sanad-groupby__select");
		this.$state = this.$wrapper.find(".sanad-groupby__state");
		this.state = new sanad.ui.EmptyState({ wrapper: this.$state, state: "loading", rows: 1, size: "sm" });
		this.$select.on("change", () => this.select(this.$select.val() === ALL ? null : this.$select.val()));
		this.$chips.on("keydown", (e) => this.chips_keydown(e));
		if (this.listview) this.bind_listview();
	}

	bind_listview() {
		this.unbind_render = ui.on_list_render(this.listview, () => this.refresh());
	}

	// ---- data ------------------------------------------------------------------------------

	fetch() {
		if (this.opts.counts_method) {
			return ui.call(this.opts.counts_method, this.opts.counts_args ? this.opts.counts_args() : {});
		}
		const lv = this.listview;
		const current_filters = (lv ? lv.get_filters_for_args() : []).filter((f) => f[1] !== this.field);
		return frappe.xcall("frappe.desk.listview.get_group_by_count", { doctype: this.doctype, current_filters, field: this.field });
	}

	refresh() {
		if (this._loading) return this._loading;
		this.$wrapper.attr("aria-busy", "true");
		this._loading = Promise.resolve(this.fetch())
			.then((rows) => {
				this.rows = (rows || []).filter((r) => r.count !== 0);
				this.selected = this.current_value();
				this.render();
			})
			.catch((err) => {
				this.$chips.empty();
				this.state.error(err, { action: { label: __("Retry"), onclick: () => this.refresh() } });
			})
			.finally(() => {
				this._loading = null;
				this.$wrapper.attr("aria-busy", "false");
			});
		return this._loading;
	}

	current_value() {
		if (this.listview) {
			const f = this.listview.get_filters_for_args().find((x) => x[1] === this.field && x[2] === "=");
			return f ? f[3] : null;
		}
		return this.selected;
	}

	label_of(row) {
		if (row.name == null || row.name === "") return __("Not set");
		if (this.df.fieldtype === "Check") return cint(row.name) ? __("Yes") : __("No");
		if (row.title) return __(row.title);
		return __(String(row.name));
	}

	// ---- render ----------------------------------------------------------------------------

	render() {
		const total = this.rows.reduce((s, r) => s + cint(r.count), 0);
		const entries = this.opts.show_all ? [{ name: ALL, label: __("All"), count: total }] : [];
		this.rows.forEach((r) => entries.push({ name: r.name == null ? "" : String(r.name), label: this.label_of(r), count: cint(r.count) }));
		if (!this.rows.length) {
			this.$chips.empty();
			this.$select.empty();
			this.state.empty({ title: __("Nothing to group"), description: __("No records match the current filters.") });
			return;
		}
		this.state.hide();
		const selected = this.selected == null ? ALL : String(this.selected);
		const limit = this.opts.limit;
		this.$chips.empty();
		entries.forEach((e, i) => {
			const on = e.name === selected;
			const hidden = i >= limit + 1 && !this._expanded;
			$(`<button type="button" class="sanad-chip sanad-groupby__chip" aria-pressed="${on}" tabindex="${on ? 0 : -1}" data-value="${ui.escape(e.name)}"${hidden ? " hidden" : ""}>
				<span class="sanad-groupby__chip-label">${ui.escape(e.label)}</span>
				<span class="sanad-chip__count sanad-tabular" aria-hidden="true">${ui.format_int(e.count)}</span>
				<span class="sanad-visually-hidden">${ui.escape(ui.plural(e.count, { one: __("{0} record"), other: __("{0} records") }))}</span>
			</button>`)
				.on("click", () => this.select(e.name === ALL ? null : e.name))
				.appendTo(this.$chips);
		});
		if (entries.length > limit + 1) {
			$(`<button type="button" class="btn btn-xs btn-link sanad-groupby__more">${this._expanded ? ui.escape(__("Show less")) : ui.escape(__("Show {0} more", [ui.format_int(entries.length - limit - 1)]))}</button>`)
				.on("click", () => {
					this._expanded = !this._expanded;
					this.render();
				})
				.appendTo(this.$chips);
		}
		if (!this.$chips.find('[tabindex="0"]').length) this.$chips.find(".sanad-groupby__chip").first().attr("tabindex", 0);
		this.$select.empty();
		entries.forEach((e) => this.$select.append(`<option value="${ui.escape(e.name)}"${e.name === selected ? " selected" : ""}>${ui.escape(e.label)} (${ui.format_int(e.count)})</option>`));
	}

	chips_keydown(e) {
		const items = this.$chips.find(".sanad-groupby__chip:not([hidden])").toArray();
		const idx = ui.roving_index(e, items, items.indexOf(document.activeElement));
		if (idx < 0) return;
		e.preventDefault();
		items.forEach((el) => el.setAttribute("tabindex", "-1"));
		items[idx].setAttribute("tabindex", "0");
		items[idx].focus();
	}

	// ---- selection -------------------------------------------------------------------------

	/** Select a group value (`null` = all). Applies the list filter or calls `on_select`. */
	select(value) {
		this.selected = value;
		const row = this.rows.find((r) => String(r.name == null ? "" : r.name) === String(value == null ? "" : value)) || null;
		const label = value == null ? __("All") : row ? this.label_of(row) : String(value);
		ui.announce(__("Grouped by {0}: {1}", [this.opts.label || __(this.df.label || this.field), label]));
		if (this.listview) {
			const lv = this.listview;
			const filter = value == null ? null : [this.doctype, this.field, "=", value];
			lv.filter_area.remove(this.field).then(() => filter && lv.filter_area.add([filter]));
		}
		this.render();
		if (typeof this.opts.on_select === "function") this.opts.on_select(value, row);
	}

	destroy() {
		this.unbind_render && this.unbind_render();
		this.$wrapper && this.$wrapper.remove();
	}
};

export default sanad.ui.TreeGroupBy;

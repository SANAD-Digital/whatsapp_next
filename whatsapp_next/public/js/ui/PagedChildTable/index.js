// sanad.ui.PagedChildTable — replaces the native grid of a large child table with a paged,
// read-only table fed by a configured API key (`{rows, total}`), while the child data stays on
// the form. The field itself stays visible (its label and description are kept and Frappe keeps
// the tab it lives in); only the grid DOM inside the field wrapper is hidden. Columns default to the child DocType's `in_list_view`
// fields from meta; values are formatted through `frappe.format`; a status column renders as a
// StatusBadge. Filter chips, a search box, a toolbar with the caller's actions (e.g. "Add rows")
// and per-row actions are all options. States: skeleton / empty / error through EmptyState.

import ui from "../_core/index.js";

const CHIP_LIMIT = 8;

sanad.ui.PagedChildTable = class PagedChildTable {
	/**
	 * @param {Object} opts
	 * @param {Object} opts.frm — the form
	 * @param {string} opts.fieldname — the Table field to replace
	 * @param {string} opts.page_method — API key resolving to `{rows, total}`
	 * @param {Function} [opts.args] — `(state) => args` where state = `{name, page, page_length, search, filters}`;
	 *   default sends `{name, page, page_length, search, ...filters}`
	 * @param {number} [opts.page_length=50]
	 * @param {Array<{fieldname, label?, format?(value, row), width?}>} [opts.columns] — default: child meta `in_list_view`
	 * @param {Array<{label, icon?, condition?(row), handler(row)}>} [opts.row_actions]
	 * @param {string|null} [opts.status_field="status"] — rendered as a StatusBadge (null disables)
	 * @param {Function} [opts.status_indicator] — `(row) => {label, colour}` override
	 * @param {Array<{fieldname, type: "select"|"search", label?, options?: string[]}>} [opts.filters]
	 * @param {Array<{label, primary?, icon?, condition?(), disabled?, hint?, handler()}>} [opts.toolbar_actions] — `hint` is shown as visible text when disabled
	 * @param {string} [opts.empty_text]
	 * @param {boolean} [opts.hide_grid=true] — hide the native grid DOM (never the field, so its tab stays)
	 * @param {boolean} [opts.search=true] — search box (sent as `search`)
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({ page_length: 50, status_field: "status", hide_grid: true, search: true, filters: [], row_actions: [], toolbar_actions: [] }, opts);
		this.frm = this.opts.frm;
		this.fieldname = this.opts.fieldname;
		this.state = { page: 1, page_length: cint(this.opts.page_length) || 50, search: "", filters: {}, total: 0, rows: [] };
		this.resolve_meta();
		this.make();
		this.refresh();
	}

	resolve_meta() {
		const df = frappe.meta.get_docfield(this.frm.doctype, this.fieldname);
		this.child_doctype = df && df.options;
		this.child_meta = this.child_doctype ? frappe.get_meta(this.child_doctype) : null;
		// the panel prints this label, so it is translated here once rather than at each use
		this.label = df && df.label ? __(df.label) : this.fieldname;
		const fields = this.child_meta ? this.child_meta.fields : [];
		this.field_map = {};
		fields.forEach((f) => (this.field_map[f.fieldname] = f));
		const status_field = this.opts.status_field;
		this.status_field = status_field && this.field_map[status_field] ? status_field : null;
		let columns = this.opts.columns;
		if (!columns || !columns.length) {
			columns = fields.filter((f) => f.in_list_view && !ui.meta.is_layout(f)).map((f) => ({ fieldname: f.fieldname }));
		}
		this.columns = columns.map((c) => Object.assign({}, c, { df: this.field_map[c.fieldname], label: c.label || (this.field_map[c.fieldname] ? __(this.field_map[c.fieldname].label) : c.fieldname) }));
	}

	make() {
		const field = this.frm.get_field(this.fieldname);
		const id = ui.uid("pct");
		this.$el = $(`
			<div class="sanad-kit sanad-pct" data-fieldname="${ui.escape(this.fieldname)}" id="${id}">
				<div class="sanad-pct__head">
					<h4 class="sanad-pct__title">${ui.escape(this.label)}</h4>
					<span class="sanad-pct__count sanad-tabular" aria-live="polite"></span>
					<div class="sanad-pct__actions"></div>
				</div>
				<div class="sanad-pct__toolbar">
					<div class="sanad-pct__filters"></div>
				</div>
				<div class="sanad-pct__note" hidden></div>
				<div class="sanad-pct__state"></div>
				<div class="sanad-pct__scroll sanad-table-wrap" tabindex="0"><table class="sanad-table sanad-pct__table" aria-label="${ui.escape(this.label)}"></table></div>
				<div class="sanad-pct__pager">
					<span class="sanad-pct__range sanad-tabular" aria-live="polite" aria-atomic="true"></span>
					<div class="sanad-pct__pager-btns">
						<button type="button" class="btn btn-default btn-sm sanad-pct__prev" aria-label="${ui.escape(__("Previous page"))}">${ui.icon("es-line-left-chevron", "xs")}<span>${ui.escape(__("Previous"))}</span></button>
						<button type="button" class="btn btn-default btn-sm sanad-pct__next" aria-label="${ui.escape(__("Next page"))}"><span>${ui.escape(__("Next"))}</span>${ui.icon("es-line-right-chevron", "xs")}</button>
					</div>
				</div>
			</div>`);
		// Mount inside the field's own wrapper (`.grid-field`: label, description, grid, footer) so
		// the field stays visible — Frappe hides a tab whose fields are all hidden — and only the
		// grid parts are hidden through the host class (see style.scss). Idempotent: a previous
		// instance of the same field is replaced; the host class survives grid re-renders.
		this.$host = field && field.grid && field.grid.wrapper ? field.grid.wrapper : field && field.$wrapper;
		const $existing = this.frm.$wrapper.find(`.sanad-pct[data-fieldname="${this.fieldname}"]`);
		if ($existing.length) $existing.replaceWith(this.$el);
		else if (this.$host && this.$host.length) this.$host.append(this.$el);
		else this.frm.$wrapper.find(".form-page").first().append(this.$el);
		if (this.$host && this.opts.hide_grid) this.$host.addClass("sanad-pct-host");
		this.$filters = this.$el.find(".sanad-pct__filters");
		this.$count = this.$el.find(".sanad-pct__count");
		this.$actions = this.$el.find(".sanad-pct__actions");
		this.$state = this.$el.find(".sanad-pct__state");
		this.$note = this.$el.find(".sanad-pct__note");
		this.$scroll = this.$el.find(".sanad-pct__scroll");
		this.$table = this.$el.find(".sanad-pct__table");
		this.$range = this.$el.find(".sanad-pct__range");
		this.state_view = new sanad.ui.EmptyState({ wrapper: this.$state, state: "loading", size: "sm" });
		this.$el.find(".sanad-pct__prev").on("click", () => this.go(this.state.page - 1));
		this.$el.find(".sanad-pct__next").on("click", () => this.go(this.state.page + 1));
		this.render_filters();
		this.render_toolbar();
	}

	render_filters() {
		this.$filters.empty();
		(this.opts.filters || []).forEach((f) => {
			if (f.type === "search") return; // search box is rendered once below
			const df = this.field_map[f.fieldname] || {};
			const label = f.label || (df.label ? __(df.label) : f.fieldname);
			let options = f.options;
			if (!options && df.fieldtype === "Select") options = (df.options || "").split("\n").filter(Boolean);
			options = options || [];
			if (options.length <= CHIP_LIMIT) {
				const $group = $(`<div class="sanad-chip-row sanad-pct__chips" role="group" data-field="${ui.escape(f.fieldname)}" aria-label="${ui.escape(label)}"></div>`);
				const all = [{ value: "", label: __("All") }].concat(options.map((o) => ({ value: o, label: __(o) })));
				all.forEach((o) => {
					const $chip = $(`<button type="button" class="sanad-chip sanad-pct__chip" data-value="${ui.escape(o.value)}" data-label="${ui.escape(o.label)}" aria-pressed="${o.value === "" ? "true" : "false"}"><span class="sanad-pct__chip-label">${ui.escape(o.label)}</span></button>`);
					$chip.on("click", () => {
						$group.find(".sanad-pct__chip").attr("aria-pressed", "false");
						$chip.attr("aria-pressed", "true");
						this.set_filter(f.fieldname, o.value);
					});
					$group.append($chip);
				});
				this.$filters.append($group);
			} else {
				const $select = $(`<select class="form-control input-xs sanad-pct__select" aria-label="${ui.escape(label)}"><option value="">${ui.escape(label)}: ${ui.escape(__("All"))}</option></select>`);
				options.forEach((o) => $select.append(`<option value="${ui.escape(o)}">${ui.escape(__(o))}</option>`));
				$select.on("change", () => this.set_filter(f.fieldname, $select.val()));
				this.$filters.append($select);
			}
		});
		if (this.opts.search) {
			const $search = $(`<input type="search" class="form-control input-xs sanad-pct__search" placeholder="${ui.escape(__("Search"))}" aria-label="${ui.escape(__("Search {0}", [this.label]))}">`);
			$search.on("input", ui.debounce(() => {
				this.state.search = $search.val().trim();
				this.go(1);
			}, 300));
			this.$filters.append($search);
		}
	}

	render_toolbar() {
		this.$actions.empty();
		const reasons = [];
		(this.opts.toolbar_actions || []).forEach((a) => {
			if (!a.handler) return;
			if (a.condition && !a.condition()) return;
			const $btn = $(`<button type="button" class="btn btn-sm ${a.primary ? "btn-primary" : "btn-default"}">${a.icon ? ui.icon(a.icon, "xs") + " " : ""}${ui.escape(a.label)}</button>`);
			$btn.prop("disabled", !!a.disabled);
			const reason = a.hint || a.title;
			if (a.disabled && reason && !reasons.includes(reason)) reasons.push(reason);
			if (reason) $btn.attr("aria-describedby", this.$el.attr("id") + "-note");
			$btn.on("click", () => a.handler(this));
			this.$actions.append($btn);
		});
		// The reason a button is disabled is visible text, never only a hover title.
		this.$note.attr("id", this.$el.attr("id") + "-note");
		if (reasons.length) this.$note.text(reasons.join(" ")).removeAttr("hidden");
		else this.$note.attr("hidden", true).empty();
	}

	set_filter(fieldname, value) {
		if (value) this.state.filters[fieldname] = value;
		else delete this.state.filters[fieldname];
		this.go(1);
	}

	/** Re-read options (e.g. after a status change) and re-render toolbar + rows. */
	update(opts = {}) {
		Object.assign(this.opts, opts);
		this.render_toolbar();
		return this.refresh();
	}

	build_args() {
		const s = this.state;
		if (this.opts.args) return this.opts.args(Object.assign({ name: this.frm.doc.name }, s));
		return Object.assign({ name: this.frm.doc.name, page: s.page, page_length: s.page_length, search: s.search || undefined }, s.filters);
	}

	go(page) {
		const pages = Math.max(1, Math.ceil(this.state.total / this.state.page_length));
		this.state.page = Math.min(Math.max(1, page), pages);
		return this.refresh();
	}

	refresh() {
		if (this.frm.is_new()) {
			this.$table.empty();
			this.$range.text("");
			this.state_view.empty({ title: __("Save the document first"), description: __("Rows can be added after the first save.") });
			this.render_pager();
			return Promise.resolve();
		}
		this.state_view.loading();
		this.$table.attr("aria-busy", "true");
		const seq = (this._seq = (this._seq || 0) + 1);
		return sanad.ui
			.call(this.opts.page_method, this.build_args(), { silent: true })
			.then((r) => {
				if (seq !== this._seq) return;
				const rows = (r && r.rows) || [];
				this.state.rows = rows;
				this.state.total = cint(r && r.total);
				this.state.counts = (r && r.counts) || null;
				this.render_counts();
				this.$table.removeAttr("aria-busy");
				if (!rows.length) {
					this.$table.empty();
					this.state_view.empty({ title: this.opts.empty_text || __("No rows yet"), description: this.state.search || Object.keys(this.state.filters).length ? __("Try a different search or filter.") : undefined });
				} else {
					this.state_view.hide();
					this.render_rows(rows);
				}
				this.render_pager();
			})
			.catch((err) => {
				if (seq !== this._seq) return;
				this.$table.removeAttr("aria-busy").empty();
				this.state_view.error(err, { action: { label: __("Retry"), onclick: () => this.refresh() } });
			});
	}

	/**
	 * The head's count and, when the page reports `counts` — `{fieldname: {value: n, All: n}}` —
	 * the number on every chip of that field. A value with no rows steps out of the row unless it
	 * is the one in force, so the chips only offer what is actually there. A field the page says
	 * nothing about keeps plain chips.
	 */
	render_counts() {
		const counts = this.state.counts || {};
		const any = Object.keys(counts)[0];
		const total = any && counts[any] && counts[any].All != null ? cint(counts[any].All) : cint(this.state.total);
		this.$count.text(ui.plural(total, { one: __("{0} row"), other: __("{0} rows") }));
		this.$el.find(".sanad-pct__chips").each((i, group) => {
			const $group = $(group);
			const field = counts[$group.attr("data-field")];
			let offered = 0;
			$group.find(".sanad-pct__chip").each((j, el) => {
				const $chip = $(el);
				const value = $chip.attr("data-value");
				const active = $chip.attr("aria-pressed") === "true";
				$chip.find(".sanad-pct__chip-label").text($chip.attr("data-label"));
				$chip.find(".sanad-pct__chip-count").remove();
				if (!field) return;
				const n = value === "" ? cint(field.All) : cint(field[value]);
				$chip.append(`<span class="sanad-pct__chip-count sanad-tabular">${ui.escape(ui.format_int(n))}</span>`);
				$chip.attr("hidden", !n && !active && value !== "" ? "hidden" : null);
				if (value !== "" && (n || active)) offered += 1;
			});
			// a row that can only be read one way is not a choice: it goes, and the head keeps the count
			if (field) $group.attr("hidden", offered > 1 ? null : "hidden");
		});
	}

	format_cell(col, row) {
		if (col.format) return col.format(row[col.fieldname], row);
		if (this.status_field && col.fieldname === this.status_field) {
			const ind = this.opts.status_indicator ? this.opts.status_indicator(row) : ui.indicator_for(this.child_doctype, Object.assign({ doctype: this.child_doctype }, row));
			return { html: sanad.ui.StatusBadge.html({ label: __(ind.label || row[col.fieldname] || ""), colour: ind.colour }) };
		}
		if (col.df) return { html: ui.meta.format(row[col.fieldname], col.df, row) };
		return row[col.fieldname];
	}

	render_rows(rows) {
		const actions = (this.opts.row_actions || []).filter((a) => a.handler);
		let html = "<thead><tr>";
		this.columns.forEach((c) => (html += `<th scope="col"${c.width ? ` style="width:${ui.escape(c.width)}"` : ""}>${ui.escape(c.label)}</th>`));
		if (actions.length) html += `<th scope="col" class="sanad-pct__th-actions"><span class="sanad-visually-hidden">${ui.escape(__("Actions"))}</span></th>`;
		html += "</tr></thead><tbody>";
		rows.forEach((row, i) => {
			html += `<tr data-idx="${i}">`;
			this.columns.forEach((c) => {
				const cell = this.format_cell(c, row);
				const inner = cell && typeof cell === "object" && "html" in cell ? cell.html : ui.escape(cell == null ? "" : cell);
				html += `<td>${inner || ""}</td>`;
			});
			if (actions.length) {
				html += '<td class="sanad-pct__row-actions">';
				actions.forEach((a, j) => {
					if (a.condition && !a.condition(row)) return;
					html += `<button type="button" class="btn btn-xs btn-default" data-action="${j}" data-idx="${i}" ${a.icon ? `aria-label="${ui.escape(a.label)}" title="${ui.escape(a.label)}"` : ""}>${a.icon ? ui.icon(a.icon, "xs") : ui.escape(a.label)}</button>`;
				});
				html += "</td>";
			}
			html += "</tr>";
		});
		html += "</tbody>";
		this.$table.html(html);
		this.$table.find("[data-action]").on("click", (e) => {
			const $b = $(e.currentTarget);
			actions[cint($b.data("action"))].handler(rows[cint($b.data("idx"))], this);
		});
	}

	render_pager() {
		const { page, page_length, total } = this.state;
		const start = total ? (page - 1) * page_length + 1 : 0;
		const end = Math.min(page * page_length, total);
		this.$range.text(total ? __("{0}–{1} of {2}", [ui.format_int(start), ui.format_int(end), ui.format_int(total)]) : __("No rows"));
		this.$el.find(".sanad-pct__prev").prop("disabled", page <= 1);
		this.$el.find(".sanad-pct__next").prop("disabled", end >= total);
		this.$el.find(".sanad-pct__pager").toggle(total > page_length);
	}

	destroy() {
		this.$el.remove();
		if (this.$host) this.$host.removeClass("sanad-pct-host");
	}
};

export default sanad.ui.PagedChildTable;

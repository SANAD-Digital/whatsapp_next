// sanad.ui.DataList — the prototype's data table on top of a Desk ListView: sortable headers,
// a checkbox column (Desk's `.list-row-checkbox[data-name]`, so `get_checked_items()` and
// BulkActions keep working), dense rows with a muted second line, typed cells (status badge,
// avatar chip, tabular numbers, user dates, links), a per-row "View" button, an optional
// expandable row, and a footer with the count and a page pager. `frappe.views.ListView` keeps
// doing data / filters / sorting / URL; DataList only replaces how rows, the count and paging
// are rendered (instance overrides, nothing patched globally). Cards under 768 px (CSS only).

import ui from "../_core/index.js";

const CONTROL_SELECTOR = "a, button, input, select, textarea, label, .sanad-datalist__action, [data-toggle]";

sanad.ui.DataList = class DataList {
	/**
	 * @param {Object} opts
	 * @param {Object} opts.listview — a Desk ListView
	 * @param {Array<Object>} [opts.columns] — `{fieldname, label?, width?, align?: "start"|"end"|"center", sortable?,
	 *   format?(value, doc) → html, sub?(doc) → html, type?: "status"|"avatar"|"number"|"date"|"link", hidden_xs?}`
	 *   (default: `listview.columns`)
	 * @param {boolean} [opts.selectable=true] — checkbox column
	 * @param {{label: string, handler: Function}|false} [opts.row_action] — per-row button at the inline-end
	 * @param {Function} [opts.on_row_click] — `(doc, $row) => void` (whole row except controls / links)
	 * @param {Function} [opts.expand] — `($el, doc) => void|Promise` renders an expandable row
	 * @param {number} [opts.page_length=20]
	 * @param {{count?: Function(total, rows) → string, extra?: Function($el, rows)}} [opts.footer]
	 * @param {{title?, description?, action?}} [opts.empty]
	 * @param {"cards"|"scroll"} [opts.mobile="cards"]
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({ selectable: true, page_length: 20, mobile: "cards", footer: {}, empty: {} }, opts);
		this.listview = this.opts.listview;
		if (!this.listview) throw new Error("sanad.ui.DataList: listview is required");
		this.doctype = this.listview.doctype;
		this.page_length = cint(this.opts.page_length) || 20;
		this.page = 0;
		this.total = null;
		this.expanded = new Set();
		this.id = ui.uid("datalist");
		this.columns = this.resolve_columns(this.opts.columns);
		this.mount();
	}

	// ---- wiring into the ListView ----------------------------------------------------------

	mount() {
		const lv = this.listview;
		const self = this;
		lv.page_length = this.page_length;
		lv.selected_page_count = this.page_length;
		lv.start = 0;
		lv.$paging_area && lv.$paging_area.hide();
		lv.$no_result && lv.$no_result.hide();
		lv.$result.addClass("sanad-datalist-host");
		// toolbar + table + footer read as one card (prototype: List View is a single panel)
		lv.$frappe_list.addClass("sanad-list-card");
		this.$table = $(`<div class="sanad-kit sanad-datalist__wrap${this.opts.mobile === "cards" ? " sanad-datalist__wrap--cards" : ""}"></div>`);
		lv.$result.find(".list-row-container, .list-row-head").remove();
		lv.$result.prepend(this.$table);
		this.$footer = $(`<div class="sanad-kit sanad-datalist__footer"><div class="sanad-datalist__count" aria-live="polite"></div><div class="sanad-datalist__extra"></div><nav class="sanad-datalist__pager" aria-label="${ui.escape(__("Pages"))}"></nav></div>`);
		if (lv.$paging_area) this.$footer.insertAfter(lv.$paging_area);
		else lv.$frappe_list.append(this.$footer);

		// rows: our table instead of Desk's row markup (keeps the shared render hooks of the kit)
		lv._sanad_render_hooks = lv._sanad_render_hooks || [];
		lv.render_list = function () {
			self.render();
			lv._sanad_render_hooks.forEach((fn) => {
				try {
					fn(lv);
				} catch (e) {
					console.error(e); // eslint-disable-line no-console
				}
			});
		};
		lv.render_header = () => {};
		lv.render_skeleton = () => {};
		// data: one page at a time (Desk concatenates for "load more")
		lv.prepare_data = function (r) {
			let data = r.message || {};
			Object.assign(frappe.boot.user_info, data.user_info);
			delete data.user_info;
			data = !Array.isArray(data) ? frappe.utils.dict(data.keys, data.values) : data;
			lv.data = data.uniqBy((d) => d.name);
		};
		lv.reset_defaults = function () {
			// the page that was just fetched (a caller resetting `start = 0` lands on page 1)
			self.page = Math.floor(cint(lv.start) / self.page_length);
			lv.page_length = self.page_length;
			lv.start = self.page * self.page_length;
		};
		lv.toggle_result_area = function () {
			lv.$result.parent(".result-container").show();
			lv.$result.show();
			lv.$paging_area && lv.$paging_area.hide();
			lv.$no_result && lv.$no_result.hide();
		};
		lv.render_count = () => this.render_footer();
		lv.get_count_str = () => Promise.resolve("");
		lv.freeze = (on) => this.set_loading(!!on);
		// the card scrolls the table itself (see style.scss), so Desk's result-height maths is skipped
		lv.set_result_height = () => {};
		this.bind_events();
		this.render_skeleton();
	}

	bind_events() {
		const $r = this.listview.$result;
		$r.on(`click.${this.id}`, ".sanad-datalist__sort", (e) => {
			e.preventDefault();
			this.sort($(e.currentTarget).closest("th").data("fieldname"));
		});
		$r.on(`click.${this.id}`, ".sanad-datalist__view", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const doc = this.doc_of($(e.currentTarget).closest("tr").data("name"));
			if (doc && this.opts.row_action && this.opts.row_action.handler) this.run(this.opts.row_action.handler, doc, $(e.currentTarget));
		});
		$r.on(`click.${this.id}`, ".sanad-datalist__toggle", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.expand_row($(e.currentTarget).closest("tr").data("name"));
		});
		$r.on(`click.${this.id}`, ".sanad-datalist__row", (e) => {
			if (!this.opts.on_row_click) return;
			if (e.ctrlKey || e.metaKey || $(e.target).closest(CONTROL_SELECTOR).length) return;
			const doc = this.doc_of($(e.currentTarget).data("name"));
			if (doc) this.run(this.opts.on_row_click, doc, $(e.currentTarget));
		});
		$r.on(`keydown.${this.id}`, ".sanad-datalist__row", (e) => {
			if (e.key !== "Enter" || !this.opts.on_row_click || e.target !== e.currentTarget) return;
			const doc = this.doc_of($(e.currentTarget).data("name"));
			if (doc) this.run(this.opts.on_row_click, doc, $(e.currentTarget));
		});
		$r.on(`change.${this.id}`, ".sanad-datalist__check-all", (e) => {
			const on = e.currentTarget.checked;
			$r.find(".list-row-checkbox").prop("checked", on);
			this.listview.on_row_checked();
			ui.announce(on ? __("All rows on this page selected.") : __("Selection cleared."));
		});
		this.$footer.on(`click.${this.id}`, "[data-page]", (e) => {
			e.preventDefault();
			this.go_to(cint($(e.currentTarget).data("page")));
		});
	}

	run(fn, doc, $el) {
		Promise.resolve(fn(doc, $el)).catch((err) => {
			if (err && err.message && err.message !== "cancelled") sanad.ui.Toast.error(err);
		});
	}

	doc_of(name) {
		return (this.listview.data || []).find((d) => d.name === name) || null;
	}

	// ---- columns ---------------------------------------------------------------------------

	resolve_columns(columns) {
		const lv = this.listview;
		const meta = frappe.get_meta(this.doctype) || { fields: [] };
		const df_of = (fieldname) => (meta.fields || []).find((f) => f.fieldname === fieldname) || frappe.meta.get_docfield(this.doctype, fieldname) || (fieldname === "name" ? { fieldname: "name", label: __("ID"), fieldtype: "Data" } : { fieldname, label: fieldname, fieldtype: "Data" });
		let list = columns;
		if (!list || !list.length) {
			list = (lv.columns || [])
				.filter((c) => c.type === "Field" || c.type === "Subject" || c.type === "Status")
				.map((c) => (c.type === "Status" ? { fieldname: "status", type: "status" } : { fieldname: c.df.fieldname }));
		}
		return list.map((c) => {
			const df = df_of(c.fieldname);
			const type = c.type || (df.fieldtype === "Link" ? "link" : ["Int", "Float", "Currency", "Percent"].includes(df.fieldtype) ? "number" : ["Date", "Datetime"].includes(df.fieldtype) ? "date" : "text");
			return Object.assign({ sortable: !c.format && !c.sub && !!df.fieldtype, align: type === "number" ? "end" : "start" }, c, { df, type, label: c.label || __(df.label || c.fieldname) });
		});
	}

	set_columns(columns) {
		this.columns = this.resolve_columns(columns);
		this.render();
		return this;
	}

	// ---- render ----------------------------------------------------------------------------

	colspan() {
		return this.columns.length + (this.opts.selectable ? 1 : 0) + (this.opts.expand ? 1 : 0) + (this.opts.row_action ? 1 : 0);
	}

	render_skeleton() {
		const rows = [];
		for (let i = 0; i < 6; i++) rows.push(`<tr class="sanad-datalist__row--skeleton"><td colspan="${this.colspan()}">${ui.skeleton(1, { lines: 1 })}</td></tr>`);
		this.$table.html(`<table class="sanad-datalist" aria-busy="true">${this.thead()}<tbody>${rows.join("")}</tbody></table>`);
	}

	thead() {
		const lv = this.listview;
		const sort_by = lv.sort_selector && lv.sort_selector.sort_by;
		const sort_order = lv.sort_selector && lv.sort_selector.sort_order;
		let html = "<thead><tr>";
		if (this.opts.selectable) {
			html += `<th scope="col" class="sanad-datalist__th sanad-datalist__th--check"><input type="checkbox" class="sanad-datalist__check-all" aria-label="${ui.escape(__("Select all rows on this page"))}"></th>`;
		}
		if (this.opts.expand) html += `<th scope="col" class="sanad-datalist__th sanad-datalist__th--expand"><span class="sanad-visually-hidden">${ui.escape(__("Details"))}</span></th>`;
		this.columns.forEach((c) => {
			const active = c.sortable && sort_by === c.fieldname;
			const aria = active ? ` aria-sort="${sort_order === "asc" ? "ascending" : "descending"}"` : "";
			const style = c.width ? ` style="width:${ui.escape(typeof c.width === "number" ? `${c.width}px` : c.width)}"` : "";
			const icon = active ? ui.icon(sort_order === "asc" ? "sort-ascending" : "sort-descending", "xs") : ui.icon("es-line-sort", "xs");
			html += `<th scope="col" class="sanad-datalist__th sanad-datalist__th--${c.align}${c.hidden_xs ? " sanad-datalist__th--hidden-xs" : ""}${active ? " sanad-datalist__th--sorted" : ""}" data-fieldname="${ui.escape(c.fieldname)}"${aria}${style}>`;
			if (c.sortable) {
				const dir = active && sort_order === "asc" ? __("descending") : __("ascending");
				html += `<button type="button" class="sanad-datalist__sort" aria-label="${ui.escape(__("Sort by {0}, {1}", [c.label, dir]))}"><span>${ui.escape(c.label)}</span><span class="sanad-datalist__sort-icon" aria-hidden="true">${icon}</span></button>`;
			} else html += `<span class="sanad-datalist__label">${ui.escape(c.label)}</span>`;
			html += "</th>";
		});
		if (this.opts.row_action) html += `<th scope="col" class="sanad-datalist__th sanad-datalist__th--action"><span class="sanad-datalist__label">${ui.escape(this.opts.row_action.label || __("View"))}</span></th>`;
		return html + "</tr></thead>";
	}

	render() {
		const rows = this.listview.data || [];
		this.expanded = new Set(Array.from(this.expanded).filter((n) => rows.some((d) => d.name === n)));
		let body = "";
		if (!rows.length) {
			body = `<tr class="sanad-datalist__row--empty"><td colspan="${this.colspan()}"><div class="sanad-datalist__empty"></div></td></tr>`;
		} else {
			body = rows.map((doc) => this.row_html(doc)).join("");
		}
		this.$table.html(`<table class="sanad-datalist" aria-busy="false">${this.thead()}<tbody>${body}</tbody></table>`);
		if (!rows.length) {
			const e = this.opts.empty || {};
			new sanad.ui.EmptyState({ wrapper: this.$table.find(".sanad-datalist__empty"), state: "empty", title: e.title || __("No records match"), description: e.description || __("Change the filters or the period to see more."), action: e.action });
		}
		this.expanded.forEach((name) => this.render_expand(name, true));
		return this;
	}

	row_html(doc) {
		const name = ui.escape(doc.name);
		const clickable = !!this.opts.on_row_click;
		let html = `<tr class="sanad-datalist__row${clickable ? " sanad-datalist__row--clickable" : ""}" data-name="${name}"${clickable ? ' tabindex="0"' : ""}>`;
		if (this.opts.selectable) {
			html += `<td class="sanad-datalist__td sanad-datalist__td--check"><input type="checkbox" class="list-row-checkbox" data-name="${name}" aria-label="${ui.escape(__("Select {0}", [this.title_of(doc)]))}"></td>`;
		}
		if (this.opts.expand) {
			const open = this.expanded.has(doc.name);
			html += `<td class="sanad-datalist__td sanad-datalist__td--expand"><button type="button" class="sanad-datalist__toggle" aria-expanded="${open}" aria-label="${ui.escape(__("Details of {0}", [this.title_of(doc)]))}">${ui.icon("es-line-down", "xs")}</button></td>`;
		}
		this.columns.forEach((c) => {
			html += `<td class="sanad-datalist__td sanad-datalist__td--${c.align}${c.hidden_xs ? " sanad-datalist__td--hidden-xs" : ""}" data-label="${ui.escape(c.label)}">${this.cell_html(c, doc)}</td>`;
		});
		if (this.opts.row_action) {
			html += `<td class="sanad-datalist__td sanad-datalist__td--action"><button type="button" class="sanad-datalist__view sanad-datalist__action">${ui.escape(this.opts.row_action.label || __("View"))}</button></td>`;
		}
		return html + "</tr>";
	}

	title_of(doc) {
		const meta = frappe.get_meta(this.doctype) || {};
		return (meta.title_field && doc[meta.title_field]) || doc.name;
	}

	/** Display text of a value (Link title when Desk fetched it). */
	display_of(c, doc) {
		const value = doc[c.fieldname];
		const title_field = (this.listview.link_field_title_fields || {})[c.fieldname];
		if (title_field && doc[`${c.fieldname}_${title_field}`]) return doc[`${c.fieldname}_${title_field}`];
		return value;
	}

	cell_html(c, doc) {
		const value = doc[c.fieldname];
		let main;
		if (typeof c.format === "function") {
			main = c.format(value, doc);
			if (main == null) main = "";
		} else {
			main = sanad.ui.DataList.format(c.type, value, c.df, doc, this.display_of(c, doc), this.doctype);
		}
		const sub = typeof c.sub === "function" ? c.sub(doc) : "";
		return `<div class="sanad-datalist__cell">${main === "" ? `<span class="sanad-datalist__muted" aria-hidden="true">—</span>` : `<div class="sanad-datalist__main">${main}</div>`}${sub ? `<div class="sanad-datalist__sub" dir="auto">${sub}</div>` : ""}</div>`;
	}

	/** Typed cell renderers (also usable by callers: `sanad.ui.DataList.format("avatar", value, df, doc)`). */
	static format(type, value, df, doc, display, doctype) {
		if (value == null || value === "") return "";
		display = display == null ? value : display;
		switch (type) {
			case "status": {
				const ind = ui.indicator_for(doctype || doc.doctype, Object.assign({ doctype: doctype || doc.doctype }, doc));
				return sanad.ui.StatusBadge.html({ label: __(String(value)), colour: ind.colour });
			}
			case "avatar":
				return `<span class="sanad-avatar" aria-hidden="true">${ui.escape(ui.initials(display))}</span><span class="sanad-datalist__avatar-text">${ui.escape(display)}</span>`;
			case "number":
				return `<span class="sanad-tabular">${frappe.format(value, df || { fieldtype: "Int" }, { inline: true }, doc)}</span>`;
			case "date":
				// dates stay left-to-right inside an Arabic row, or the time jumps ahead of the date
				return `<span class="sanad-tabular sanad-datalist__date" dir="ltr">${ui.escape(frappe.datetime.str_to_user(value))}</span>`;
			case "link": {
				const target = df && df.options;
				return target ? frappe.utils.get_form_link(target, value, true, ui.escape(display)) : ui.escape(display);
			}
			default:
				return df && df.fieldtype && df.fieldtype !== "Data" ? ui.meta.format(value, df, doc) : ui.escape(display);
		}
	}

	// ---- expandable rows -------------------------------------------------------------------

	expand_row(name) {
		if (!this.opts.expand) return;
		const open = this.expanded.has(name);
		if (open) {
			this.expanded.delete(name);
			this.$table.find(`tr.sanad-datalist__detail[data-for="${CSS.escape(name)}"]`).remove();
			this.$table.find(`tr[data-name="${CSS.escape(name)}"] .sanad-datalist__toggle`).attr("aria-expanded", "false");
			return;
		}
		this.expanded.add(name);
		this.render_expand(name);
	}

	render_expand(name) {
		const $row = this.$table.find(`tr.sanad-datalist__row[data-name="${CSS.escape(name)}"]`);
		if (!$row.length) return;
		$row.find(".sanad-datalist__toggle").attr("aria-expanded", "true");
		this.$table.find(`tr.sanad-datalist__detail[data-for="${CSS.escape(name)}"]`).remove();
		const $detail = $(`<tr class="sanad-datalist__detail" data-for="${ui.escape(name)}"><td colspan="${this.colspan()}"><div class="sanad-datalist__detail-body"></div></td></tr>`).insertAfter($row);
		const $body = $detail.find(".sanad-datalist__detail-body");
		const state = new sanad.ui.EmptyState({ wrapper: $body, state: "loading", rows: 2, size: "sm" });
		const doc = this.doc_of(name);
		Promise.resolve(this.opts.expand($body, doc, this))
			.then(() => {
				if ($body.find(".sanad-empty--loading").length && $body.children().length === 1) state.hide();
			})
			.catch((err) => state.error(err));
	}

	// ---- sorting / paging / footer ---------------------------------------------------------

	sort(fieldname) {
		const lv = this.listview;
		const col = this.columns.find((c) => c.fieldname === fieldname);
		if (!col || !col.sortable || !lv.sort_selector) return;
		const order = lv.sort_selector.sort_by === fieldname && lv.sort_selector.sort_order === "desc" ? "asc" : "desc";
		lv.sort_selector.set_value(fieldname, order);
		lv.start = 0;
		lv.on_sort_change(fieldname, order);
	}

	go_to(page) {
		const lv = this.listview;
		const pages = this.page_count();
		page = Math.max(0, Math.min(page, Math.max(0, pages - 1)));
		this.page = page;
		lv.start = page * this.page_length;
		lv.page_length = this.page_length;
		lv.last_args = null;
		lv.refresh();
		ui.announce(__("Page {0} of {1}.", [ui.format_int(page + 1), ui.format_int(Math.max(1, pages))]));
	}

	page_count() {
		if (this.total == null) return this.page + 1;
		return Math.max(1, Math.ceil(this.total / this.page_length));
	}

	set_loading(on) {
		this.$table.find(".sanad-datalist").attr("aria-busy", on).toggleClass("sanad-datalist--loading", on);
	}

	/**
	 * Count for the footer / pager. The total only changes when the filters change, and a first
	 * page that is not full already *is* the total — so most refreshes (paging, sorting, realtime)
	 * cost no extra request. Previously every render fired `frappe.db.count`.
	 */
	count_for(rows) {
		const lv = this.listview;
		const key = JSON.stringify(lv.get_filters_for_args() || []);
		if (this.page === 0 && rows.length < this.page_length) {
			this.count_key = key;
			this.total = rows.length;
			return Promise.resolve(this.total);
		}
		if (this.count_key === key && this.total != null) return Promise.resolve(this.total);
		return frappe.db.count(this.doctype, { filters: lv.get_filters_for_args() }).then((n) => {
			this.count_key = key;
			this.total = cint(n);
			return this.total;
		});
	}

	render_footer() {
		const lv = this.listview;
		const rows = lv.data || [];
		const $count = this.$footer.find(".sanad-datalist__count");
		const $pager = this.$footer.find(".sanad-datalist__pager");
		const paint = () => {
			const total = this.total == null ? rows.length : this.total;
			const text = typeof this.opts.footer.count === "function" ? this.opts.footer.count(total, rows) : ui.plural(total, { one: __("{0} record"), other: __("{0} records") });
			const from = rows.length ? this.page * this.page_length + 1 : 0;
			const to = this.page * this.page_length + rows.length;
			$count.text(rows.length ? __("{0} · showing {1}–{2}", [text, ui.format_int(from), ui.format_int(to)]) : text);
			const pages = this.page_count();
			$pager.html(`
				<span class="sanad-datalist__page">${ui.escape(__("Page {0} of {1}", [ui.format_int(this.page + 1), ui.format_int(pages)]))}</span>
				<button type="button" class="btn btn-sm btn-default" data-page="${this.page - 1}"${this.page <= 0 ? " disabled" : ""}>${ui.escape(__("Previous"))}</button>
				<button type="button" class="btn btn-sm btn-default" data-page="${this.page + 1}"${this.page + 1 >= pages ? " disabled" : ""}>${ui.escape(__("Next"))}</button>`);
			if (typeof this.opts.footer.extra === "function") this.opts.footer.extra(this.$footer.find(".sanad-datalist__extra"), rows, this);
		};
		paint();
		const before = this.total;
		return this.count_for(rows)
			.then(() => {
				if (this.total !== before) paint();
			})
			.catch(() => {});
	}

	refresh() {
		return this.listview.refresh();
	}

	get_selected() {
		return this.listview.get_checked_items();
	}

	destroy() {
		this.listview.$frappe_list.removeClass("sanad-list-card");
		this.listview.$result.off(`.${this.id}`);
		this.$footer.off(`.${this.id}`).remove();
		this.$table.remove();
	}
};

export default sanad.ui.DataList;

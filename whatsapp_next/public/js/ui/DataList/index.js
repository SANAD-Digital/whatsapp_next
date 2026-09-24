// sanad.ui.DataList — the prototype's data table on top of a Desk ListView: sortable headers,
// a checkbox column (Desk's `.list-row-checkbox[data-name]`, so `get_checked_items()` and
// BulkActions keep working), dense rows with a muted second line, typed cells (status badge,
// avatar chip, tabular numbers, user dates, links), a per-row "View" button, an optional
// expandable row, and a footer with the count and a page pager. `frappe.views.ListView` keeps
// doing data / filters / sorting / URL; DataList only replaces how rows, the count and paging
// are rendered (instance overrides, nothing patched globally). Cards under 768 px (CSS only).

import ui from "../_core/index.js";

/** The table never gets less than this, however tall the console above it is. */
const MIN_TABLE_HEIGHT = 280;

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
	 * @param {Array<string>} [opts.group_by] — initial grouping levels, outermost first
	 * @param {boolean} [opts.groupable=true] — offer grouping (the levels menu lives in FilterBar)
	 * @param {boolean} [opts.pinnable=true] — a pin toggle on every header cell
	 * @param {Array<string>} [opts.pinned] — initially pinned fieldnames, in order
	 * @param {string|{fieldname, label?}} [opts.sum] — field totalled on every group row
	 * @param {Array<string>} [opts.mobile_columns] — columns kept in the card layout (default: the
	 *   first column plus any status column)
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({ selectable: true, page_length: 20, mobile: "cards", groupable: true, pinnable: true, footer: {}, empty: {} }, opts);
		// Two hosts. A Desk list view (the table replaces its rows, which is every screen built so
		// far) or, on a custom page that has no list view, a plain wrapper: the page then owns the
		// data and hands it over with `set_rows`. Nothing about the list path changes.
		this.listview = this.opts.listview || null;
		this.lv = this.listview;
		this.page_mode = !this.lv;
		if (!this.lv && !this.opts.wrapper) throw new Error("sanad.ui.DataList: listview or wrapper is required");
		this.doctype = this.lv ? this.lv.doctype : this.opts.doctype || null;
		this.rows = (this.opts.rows || []).slice();
		this.sort_state = this.opts.sort || {};
		this.page = 0;
		this.page_length = cint(this.opts.page_length) || 20;
		this.page = 0;
		this.total = null;
		this.expanded = new Set();
		this.group_names = new Map(); // rendered group id → { path, names }
		this.selected = new Set(); // checked docnames, kept across re-renders (folding, sorting, realtime)
		this.group_by = (this.opts.group_by || []).slice(); // grouping reads the rows it has, from either host
		this.collapsed = new Set(); // group paths the user folded away
		this.pinned = (this.opts.pinned || []).slice();
		this.id = ui.uid("datalist");
		this.declared = (this.opts.columns || []).slice(); // the screen's own default column set
		this.columns = this.resolve_columns(this.apply_saved_columns(this.opts.columns));
		this.mount();
	}

	// ---- wiring into the ListView ----------------------------------------------------------

	mount() {
		if (this.page_mode) return this.mount_page();
		const lv = this.listview;
		const self = this;
		lv.page_length = this.page_length;
		lv.selected_page_count = this.page_length;
		lv.start = 0;
		lv.$no_result && lv.$no_result.hide();
		lv._sanad_datalist = this; // FilterBar's grouping control drives this table
		lv.$result.addClass("sanad-datalist-host");
		// the list owns its page edge to edge: no card frame, no outer margin
		lv.$frappe_list.addClass("sanad-list-card");
		this.$table = $(`<div class="sanad-kit sanad-datalist__wrap${this.opts.mobile === "cards" ? " sanad-datalist__wrap--cards" : ""}"></div>`);
		lv.$result.find(".list-row-container, .list-row-head").remove();
		lv.$result.prepend(this.$table);
		this.$footer = $(`<div class="sanad-kit sanad-datalist__footer"><div class="sanad-datalist__count" aria-live="polite"></div><div class="sanad-datalist__extra"></div><nav class="sanad-datalist__pager" aria-label="${ui.escape(__("Pages"))}"></nav></div>`);
		lv.$frappe_list.append(this.$footer);
		// Frappe's own paging component (page sizes + Load More) moves into the footer: it divides
		// the pages, keeps the fetch small and is what the rest of Desk behaves like.
		if (lv.$paging_area) lv.$paging_area.addClass("sanad-datalist__paging").appendTo(this.$footer.find(".sanad-datalist__pager")).show();

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
		// data, paging and "load more" stay Frappe's: nothing is overridden here any more
		const orig_toggle = lv.toggle_result_area.bind(lv);
		lv.toggle_result_area = function () {
			orig_toggle();
			lv.$result.parent(".result-container").show();
			lv.$result.show();
			lv.$no_result && lv.$no_result.hide(); // the empty state is drawn inside the table
		};
		lv.render_count = () => this.render_footer();
		lv.get_count_str = () => Promise.resolve("");
		lv.freeze = (on) => this.set_loading(!!on);
		// the card is a flex column that fills its page, so Desk's result-height maths is skipped
		lv.set_result_height = () => {};
		this.bind_events();
		this._on_resize = ui.debounce(() => {
			this.apply_pins();
			this.fit_height();
		}, 150);
		$(window).on(`resize.${this.id}`, this._on_resize);
		// a screen's console above the table fills in after its own reads, and it is taller then
		// than it was at mount: the card has to be re-measured when that happens
		if (typeof ResizeObserver === "function") {
			this._card_observer = new ResizeObserver(ui.debounce(() => this.fit_height(), 120));
			Array.from(lv.$frappe_list[0].children).forEach((child) => {
				if (!child.contains(this.$table[0])) this._card_observer.observe(child);
			});
		}
		this.render_skeleton();
	}

	/**
	 * The same table on a custom page: the page owns the data, the filters and the fetching, and
	 * hands over one page at a time. Used where a screen has no Desk list view to stand on.
	 */
	mount_page() {
		const $w = $(this.opts.wrapper);
		$w.addClass("sanad-kit sanad-datalist-page");
		this.$table = $(`<div class="sanad-datalist__wrap${this.opts.mobile === "cards" ? " sanad-datalist__wrap--cards" : ""}"></div>`).appendTo($w);
		this.$footer = $(`<div class="sanad-datalist__footer"><div class="sanad-datalist__count" aria-live="polite"></div><div class="sanad-datalist__extra"></div><nav class="sanad-datalist__pager" aria-label="${ui.escape(__("Pages"))}"></nav></div>`).appendTo($w);
		this.$root = $w;
		this.total = cint(this.opts.total) || this.rows.length;
		this.bind_events();
		this.render_page_buttons();
		this._on_resize = ui.debounce(() => this.apply_pins(), 150);
		$(window).on(`resize.${this.id}`, this._on_resize);
		if (this.opts.rows) {
			this.render();
			this.render_footer();
		} else this.render_skeleton();
	}

	/** The page hands over the rows it fetched and how many there are in all. */
	set_rows(rows, total) {
		this.rows = (rows || []).slice();
		if (total != null) this.total = cint(total);
		this.set_loading(false);
		this.render();
		this.render_footer();
		return this;
	}

	/** Page mode's own footer buttons (a list view keeps Frappe's paging component instead). */
	render_page_buttons() {
		const $pager = this.$footer.find(".sanad-datalist__pager");
		if (!this.page_mode || $pager.find(".sanad-datalist__page-btn").length) return;
		const step = (delta) => {
			const pages = Math.max(1, Math.ceil((this.total || 0) / this.page_length));
			const target = Math.max(0, Math.min(this.page + delta, pages - 1));
			if (target === this.page) return;
			this.page = target;
			this.set_loading(true);
			if (this.opts.on_page) this.opts.on_page(target, this);
		};
		$(`<button type="button" class="btn btn-default btn-sm sanad-datalist__page-btn" data-go="prev">${ui.escape(__("Previous"))}</button>`).on("click", () => step(-1)).appendTo($pager);
		$(`<button type="button" class="btn btn-default btn-sm sanad-datalist__page-btn" data-go="next">${ui.escape(__("Next"))}</button>`).on("click", () => step(1)).appendTo($pager);
	}

	bind_events() {
		const $r = this.$root || this.listview.$result;
		$r.on(`click.${this.id}`, ".sanad-datalist__sort", (e) => {
			e.preventDefault();
			if ($(e.target).closest(".sanad-datalist__pin").length) return;
			this.sort($(e.currentTarget).closest("th").data("fieldname"));
		});
		$r.on(`click.${this.id}`, ".sanad-datalist__view", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const doc = this.doc_of($(e.currentTarget).closest("tr").data("name"));
			if (doc && this.opts.row_action && this.opts.row_action.handler) this.run(this.opts.row_action.handler, doc, $(e.currentTarget));
		});
		$r.on(`click.${this.id}`, ".sanad-datalist__pin", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.toggle_pin($(e.currentTarget).data("fieldname"));
		});
		$r.on(`click.${this.id}`, ".sanad-datalist__group-toggle", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const gid = e.currentTarget.closest("tr").getAttribute("data-gid");
			const group = this.group_names.get(String(gid));
			if (!group) return;
			if (this.collapsed.has(group.path)) this.collapsed.delete(group.path);
			else this.collapsed.add(group.path);
			this.render();
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
		$r.on(`change.${this.id}`, ".sanad-datalist__group-checkbox", (e) => {
			e.stopPropagation();
			this.select_group(e.currentTarget.getAttribute("data-gid"), e.currentTarget.checked);
		});
		$r.on(`change.${this.id}`, ".list-row-checkbox", (e) => {
			const name = e.currentTarget.getAttribute("data-name");
			if (e.currentTarget.checked) this.selected.add(name);
			else this.selected.delete(name);
			this.selection_changed(); // one row is a selection too: the host hears about it
			this.sync_group_checkboxes();
		});
		$r.on(`change.${this.id}`, ".sanad-datalist__check-all", (e) => {
			const on = e.currentTarget.checked;
			$r.find(".list-row-checkbox").each((i, el) => {
				el.checked = on;
				if (on) this.selected.add(el.getAttribute("data-name"));
				else this.selected.delete(el.getAttribute("data-name"));
			});
			this.selection_changed();
			this.sync_group_checkboxes();
			ui.announce(on ? __("All rows on this page selected.") : __("Selection cleared."));
		});
	}

	run(fn, doc, $el) {
		Promise.resolve(fn(doc, $el)).catch((err) => {
			if (err && err.message && err.message !== "cancelled") sanad.ui.Toast.error(err);
		});
	}

	doc_of(name) {
		const rows = this.page_mode ? this.rows : this.listview.data || [];
		return rows.find((d) => String(d.name) === String(name)) || null;
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
		const resolved = list.map((c) => {
			const df = df_of(c.fieldname);
			const type = c.type || (df.fieldtype === "Link" ? "link" : ["Int", "Float", "Currency", "Percent"].includes(df.fieldtype) ? "number" : ["Date", "Datetime"].includes(df.fieldtype) ? "date" : "text");
			return Object.assign({ sortable: !c.format && !c.sub && !!df.fieldtype, align: type === "number" ? "end" : "start" }, c, { df, type, label: c.label || __(df.label || c.fieldname) });
		});
		return this.ordered_columns(resolved);
	}

	set_columns(columns) {
		this.columns = this.resolve_columns(columns);
		this.render();
		return this;
	}

	// ---- which columns are shown (Frappe's own List View Settings) --------------------------

	/**
	 * Every column the user may show: the screen's declared ones first, then the rest of the
	 * DocType's own fields, so a list starts with sensible defaults and can be widened like any
	 * Frappe list.
	 */
	available_columns() {
		const meta = frappe.get_meta(this.doctype) || { fields: [] };
		const declared = (this.declared || []).map((c) => c.fieldname);
		const extra = (meta.fields || [])
			.filter(
				(df) =>
					!frappe.model.layout_fields.includes(df.fieldtype) &&
					!["Text Editor", "Code", "HTML", "Markdown Editor", "Signature", "Table", "Table MultiSelect"].includes(df.fieldtype) &&
					df.label &&
					!df.hidden &&
					!declared.includes(df.fieldname)
			)
			.map((df) => ({ fieldname: df.fieldname, label: __(df.label) }));
		return (this.declared || []).map((c) => ({ fieldname: c.fieldname, label: c.label || __(c.fieldname), declared: true })).concat(extra);
	}

	/** Fieldnames currently shown, in order. */
	visible_columns() {
		return this.columns.map((c) => c.fieldname);
	}

	/** Column spec for a fieldname: the screen's own definition when it has one. */
	spec_for(fieldname) {
		return (this.declared || []).find((c) => c.fieldname === fieldname) || { fieldname };
	}

	/**
	 * The user's own column choice, kept in Frappe's per-user `user_settings` for this DocType.
	 * The shared `List View Settings.fields` is deliberately not reused: it is written by Desk's
	 * own list and would drag 27 unrelated fields into a screen that declares 8.
	 */
	apply_saved_columns(columns) {
		const saved = this.saved_fields();
		if (!saved || !saved.length) return columns;
		const meta = frappe.get_meta(this.doctype) || { fields: [] };
		const known = new Set((meta.fields || []).map((df) => df.fieldname).concat(["name"]));
		const declared = (columns || []).slice();
		const out = saved
			.filter((f) => known.has(f))
			.map((f) => declared.find((c) => c.fieldname === f) || { fieldname: f });
		return out.length ? out : columns;
	}

	saved_fields() {
		const settings = frappe.get_user_settings(this.doctype) || {};
		const saved = settings[this.settings_key()];
		return Array.isArray(saved) ? saved : null;
	}

	settings_key() {
		return `sanad_columns_${this.opts.settings_key || "default"}`;
	}

	/** Show exactly these fieldnames, in this order, and remember the choice like Frappe does. */
	set_visible_columns(fieldnames, { save = true } = {}) {
		const list = (fieldnames || []).filter(Boolean);
		if (!list.length) return this;
		this.pinned = this.pinned.filter((f) => list.includes(f));
		this.columns = this.resolve_columns(list.map((f) => this.spec_for(f)));
		this.render();
		if (save) this.save_columns();
		return this;
	}

	/** Back to the screen's declared columns, and forget the saved choice. */
	reset_columns() {
		this.columns = this.resolve_columns(this.declared);
		this.render();
		this.forget_columns();
		return this;
	}

	save_columns() {
		return frappe.model.user_settings.save(this.doctype, this.settings_key(), this.visible_columns());
	}

	forget_columns() {
		return frappe.model.user_settings.save(this.doctype, this.settings_key(), null);
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
		const sort_by = this.page_mode ? this.sort_state.fieldname : lv.sort_selector && lv.sort_selector.sort_by;
		const sort_order = this.page_mode ? this.sort_state.order : lv.sort_selector && lv.sort_selector.sort_order;
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
			const pinned = this.pinned.includes(c.fieldname) ? " sanad-datalist__th--pinned" : "";
			html += `<th scope="col" class="sanad-datalist__th sanad-datalist__th--${c.align}${c.hidden_xs ? " sanad-datalist__th--hidden-xs" : ""}${active ? " sanad-datalist__th--sorted" : ""}${pinned}" data-fieldname="${ui.escape(c.fieldname)}"${aria}${style}>`;
			if (c.sortable) {
				const dir = active && sort_order === "asc" ? __("descending") : __("ascending");
				html += `<button type="button" class="sanad-datalist__sort" aria-label="${ui.escape(__("Sort by {0}, {1}", [c.label, dir]))}"><span>${ui.escape(c.label)}</span><span class="sanad-datalist__sort-icon" aria-hidden="true">${icon}</span></button>`;
			} else html += `<span class="sanad-datalist__label">${ui.escape(c.label)}</span>`;
			if (this.opts.pinnable) {
				const on = this.pinned.includes(c.fieldname);
				html += `<button type="button" class="sanad-datalist__pin${on ? " sanad-datalist__pin--on" : ""}" data-fieldname="${ui.escape(c.fieldname)}" aria-pressed="${on}" title="${ui.escape(on ? __("Unpin {0}", [c.label]) : __("Pin {0}", [c.label]))}" aria-label="${ui.escape(on ? __("Unpin {0}", [c.label]) : __("Pin {0}", [c.label]))}">${ui.icon("es-line-pin", "xs")}</button>`;
			}
			html += "</th>";
		});
		if (this.opts.row_action) html += `<th scope="col" class="sanad-datalist__th sanad-datalist__th--action"><span class="sanad-datalist__label">${ui.escape(this.opts.row_action.label || __("View"))}</span></th>`;
		return html + "</tr></thead>";
	}

	render() {
		const rows = this.page_mode ? this.rows : this.listview.data || [];
		this.expanded = new Set(Array.from(this.expanded).filter((n) => rows.some((d) => d.name === n)));
		let body = "";
		if (!rows.length) {
			body = `<tr class="sanad-datalist__row--empty"><td colspan="${this.colspan()}"><div class="sanad-datalist__empty"></div></td></tr>`;
		} else if (this.group_by.length) {
			this.group_names = new Map();
			body = this.group_html(this.group_tree(rows, 0, []), 0);
		} else {
			body = rows.map((doc) => this.row_html(doc)).join("");
		}
		this.$table.html(`<table class="sanad-datalist" aria-busy="false">${this.thead()}<tbody>${body}</tbody></table>`);
		if (!rows.length) {
			const e = this.opts.empty || {};
			new sanad.ui.EmptyState({ wrapper: this.$table.find(".sanad-datalist__empty"), state: "empty", title: e.title || __("No records match"), description: e.description || __("Change the filters or the period to see more."), action: e.action });
		}
		this.expanded.forEach((name) => this.render_expand(name, true));
		this.apply_pins();
		this.restore_selection();
		this.render_group_tools(); // grouping can change without a refetch
		this.fit_height();
		return this;
	}

	// ---- grouping -------------------------------------------------------------------------

	/** The field totalled on every group row, as a column-like spec (or null). */
	sum_column() {
		const raw = this.opts.sum;
		if (!raw) return null;
		const fieldname = typeof raw === "string" ? raw : raw.fieldname;
		const col = this.columns.find((c) => c.fieldname === fieldname);
		const df = (col && col.df) || frappe.meta.get_docfield(this.doctype, fieldname) || { fieldtype: "Float" };
		return { fieldname, df, label: (typeof raw === "object" && raw.label) || (col && col.label) || __(df.label || fieldname) };
	}

	/** Display label of one group value on `level` (Link titles and Select labels included). */
	group_label(fieldname, doc) {
		const col = this.columns.find((c) => c.fieldname === fieldname);
		const raw = doc[fieldname];
		if (raw == null || raw === "") return __("Not set");
		if (col && typeof col.group_label === "function") return col.group_label(raw, doc);
		const title_field = ((this.lv && this.lv.link_field_title_fields) || {})[fieldname];
		if (title_field && doc[`${fieldname}_${title_field}`]) return String(doc[`${fieldname}_${title_field}`]);
		const df = (col && col.df) || frappe.meta.get_docfield(this.doctype, fieldname);
		if (df && ["Select", "Data"].includes(df.fieldtype)) return __(String(raw));
		return String(raw);
	}

	/**
	 * Bucket `rows` into the grouping levels, outermost first. Each node is
	 * `{key, label, path, level, rows, count, sum, children}`; grouping is over the loaded page,
	 * as in the prototype, so the counts describe what is on screen.
	 */
	group_tree(rows, level, path) {
		const fieldname = this.group_by[level];
		const buckets = new Map();
		rows.forEach((doc) => {
			const key = String(doc[fieldname] == null ? "" : doc[fieldname]);
			if (!buckets.has(key)) buckets.set(key, { key, label: this.group_label(fieldname, doc), rows: [] });
			buckets.get(key).rows.push(doc);
		});
		const sum_col = this.sum_column();
		return Array.from(buckets.values())
			.sort((a, b) => String(a.label).localeCompare(String(b.label), frappe.boot.lang || undefined))
			.map((b) => {
				const node_path = path.concat(b.key);
				return {
					fieldname,
					key: b.key,
					label: b.label,
					path: node_path.join("\u0000"),
					level,
					rows: b.rows,
					count: b.rows.length,
					sum: sum_col ? b.rows.reduce((t, d) => t + flt(d[sum_col.fieldname]), 0) : null,
					children: level + 1 < this.group_by.length ? this.group_tree(b.rows, level + 1, node_path) : null,
				};
			});
	}

	/** `level` tree guides — the vertical rules that make the nesting read as a tree. */
	rails(level) {
		let html = "";
		for (let i = 0; i < level; i++) html += '<span class="sanad-datalist__rail" aria-hidden="true"></span>';
		return html;
	}

	group_html(nodes) {
		const sum_col = this.sum_column();
		return nodes
			.map((node) => {
				const open = !this.collapsed.has(node.path);
				const label_col = this.columns.find((c) => c.fieldname === node.fieldname);
				const names = node.rows.map((d) => d.name);
				const gid = String(this.group_names.size);
				this.group_names.set(gid, { path: node.path, names });
				const label = `${label_col ? label_col.label : __(node.fieldname)}: ${node.label}`;
				const check = this.opts.selectable
					? `<span class="sanad-datalist__group-check"><input type="checkbox" class="sanad-datalist__group-checkbox" data-gid="${gid}" aria-label="${ui.escape(__("Select the {0} rows in {1}", [ui.format_int(node.count), label]))}"></span>`
					: "";
				let html = `<tr class="sanad-datalist__group sanad-datalist__group--l${node.level}" data-gid="${gid}">
					<td class="sanad-datalist__group-cell" colspan="${this.colspan()}">
						<div class="sanad-datalist__group-inner">
							${check}
							${this.rails(node.level)}
							<button type="button" class="sanad-datalist__group-toggle" aria-expanded="${open}" aria-label="${ui.escape(open ? __("Collapse {0}", [node.label]) : __("Expand {0}", [node.label]))}">${ui.icon("es-line-down", "xs")}</button>
							<span class="sanad-datalist__group-field">${ui.escape(label_col ? label_col.label : __(node.fieldname))}</span>
							<span class="sanad-datalist__group-label">${ui.escape(node.label)}</span>
							<span class="sanad-datalist__group-count sanad-tabular">${ui.escape(ui.format_int(node.count))}</span>
							${sum_col && node.sum ? `<span class="sanad-datalist__group-sum"><span class="sanad-datalist__group-sum-label">${ui.escape(__("Total {0}", [sum_col.label]))}</span> <span class="sanad-tabular" dir="ltr">${frappe.format(node.sum, sum_col.df, { inline: true })}</span></span>` : ""}
						</div>
					</td>
				</tr>`;
				if (!open) return html;
				html += node.children ? this.group_html(node.children) : node.rows.map((doc) => this.row_html(doc, node.level + 1)).join("");
				return html;
			})
			.join("");
	}

	// ---- selecting a whole group ------------------------------------------------------------

	/** Row checkboxes belonging to one rendered group. */
	$rows_of(gid) {
		const group = this.group_names.get(String(gid));
		const set = new Set((group && group.names) || []);
		return this.$table.find(".list-row-checkbox").filter((i, el) => set.has(el.getAttribute("data-name")));
	}

	select_group(gid, on) {
		const $boxes = this.$rows_of(gid);
		$boxes.each((i, el) => {
			el.checked = !!on;
			if (on) this.selected.add(el.getAttribute("data-name"));
			else this.selected.delete(el.getAttribute("data-name"));
		});
		this.selection_changed();
		this.sync_group_checkboxes();
		ui.announce(
			on
				? ui.plural($boxes.length, { one: __("{0} row selected"), other: __("{0} rows selected") })
				: __("Selection cleared.")
		);
	}

	/** Re-check the rows the user had selected before this render, then refresh the group boxes. */
	restore_selection() {
		if (this.selected.size) {
			let changed = false;
			this.$table.find(".list-row-checkbox").each((i, el) => {
				const on = this.selected.has(el.getAttribute("data-name"));
				if (el.checked !== on) {
					el.checked = on;
					changed = true;
				}
			});
			if (changed) this.selection_changed();
		}
		this.sync_group_checkboxes();
	}

	/** Fold or unfold every group at once. */
	set_all_folded(folded) {
		if (!folded) this.collapsed.clear();
		else Array.from(this.group_names.values()).forEach((g) => this.collapsed.add(g.path));
		this.render();
		ui.announce(folded ? __("All groups collapsed.") : __("All groups expanded."));
		return this;
	}

	/** Group boxes reflect their rows: checked, unchecked, or indeterminate when partly selected. */
	sync_group_checkboxes() {
		this.$table.find(".sanad-datalist__group-checkbox").each((i, el) => {
			const $boxes = this.$rows_of(el.getAttribute("data-gid"));
			const total = $boxes.length;
			const on = $boxes.filter(":checked").length;
			el.checked = total > 0 && on === total;
			el.indeterminate = on > 0 && on < total;
		});
		const $all = this.$table.find(".sanad-datalist__check-all");
		if ($all.length) {
			const rows = this.$table.find(".list-row-checkbox");
			const on = rows.filter(":checked").length;
			$all[0].checked = rows.length > 0 && on === rows.length;
			$all[0].indeterminate = on > 0 && on < rows.length;
		}
	}

	/**
	 * Replace the grouping levels (outermost first); `[]` turns grouping off.
	 * Grouping a single page would describe 20 rows out of hundreds, so while it is on the list
	 * fetches up to `group_page_length` rows and the pager stands down.
	 */
	/** Forget the selection (filters changed, or the caller cleared it). */
	clear_selection() {
		this.selected.clear();
		this.$table.find(".list-row-checkbox").prop("checked", false);
		this.selection_changed();
		this.sync_group_checkboxes();
		return this;
	}

	/**
	 * Replace the grouping levels (outermost first); `[]` turns grouping off.
	 * Grouping shapes the rows that are loaded — it never widens the fetch, so a big table stays
	 * as cheap grouped as ungrouped and "Load More" keeps working.
	 */
	set_group_by(fields) {
		this.group_by = (fields || []).filter(Boolean);
		this.collapsed.clear();
		if (typeof this.opts.on_group_change === "function") this.opts.on_group_change(this.group_by.slice(), this);
		this.render();
		return this;
	}

	/**
	 * Fields worth grouping by. Free text and dates give one bucket per row, which is not a
	 * grouping at all, so only the field types that form real buckets are offered — plus anything
	 * a column opts into with `groupable: true`.
	 */
	group_options() {
		const BUCKETED = ["Select", "Link", "Check", "Dynamic Link"];
		return this.columns
			.filter((c) => c.groupable === true || (c.groupable !== false && c.df && BUCKETED.includes(c.df.fieldtype)))
			.map((c) => ({ value: c.fieldname, label: c.label }));
	}

	// ---- pinned columns ---------------------------------------------------------------------

	toggle_pin(fieldname) {
		const at = this.pinned.indexOf(fieldname);
		if (at >= 0) this.pinned.splice(at, 1);
		else this.pinned.push(fieldname);
		this.columns = this.ordered_columns(this.columns);
		this.render();
		return this;
	}

	/**
	 * Pinned columns lead, in the order they were pinned; the rest keep their declared order.
	 * A pinned column that stayed in place would leave a gap the unpinned ones scroll through.
	 */
	ordered_columns(columns) {
		const pinned = this.pinned.map((f) => columns.find((c) => c.fieldname === f)).filter(Boolean);
		return pinned.concat(columns.filter((c) => !this.pinned.includes(c.fieldname)));
	}

	/**
	 * Give the table exactly the height left on the screen, so it fills the window and scrolls
	 * inside the card instead of growing the page. Measured rather than guessed with a `calc()`,
	 * because the toolbar's height depends on how many filters a screen declares.
	 */
	fit_height() {
		if (this.page_mode) return; // the page owns its own layout
		const card = this.listview.$frappe_list && this.listview.$frappe_list[0];
		const el = this.$table && this.$table[0];
		if (!card || !el || !el.isConnected) return;
		const top = card.getBoundingClientRect().top;
		const room = Math.max(MIN_TABLE_HEIGHT, Math.round(window.innerHeight - top));

		// A screen may carry a console above its toolbar (Queue, Campaigns). The card is then made
		// exactly one console taller than the room on screen, so the page scrolls by the height of
		// the console and stops: at the end of that scroll the toolbar sits at the top, the table
		// fills the viewport and the footer rests on its bottom edge. Without a console the card is
		// the room itself and nothing scrolls, as Desk's own list does.
		const bar = card.querySelector(":scope > .sanad-filterbar");
		let above = 0;
		if (bar) {
			for (const child of Array.from(card.children)) {
				if (child === bar || child.contains(el)) break;
				const style = window.getComputedStyle(child);
				if (style.display === "none" || style.position === "absolute" || style.position === "fixed") continue;
				above += child.getBoundingClientRect().height;
			}
		}
		card.style.height = `${Math.round(room + above)}px`;
		el.style.maxHeight = "";
	}

	/**
	 * Stick the pinned columns to the inline-start edge. Offsets are measured after paint, because
	 * the table sizes itself to its content; the last pinned column carries the edge shadow.
	 */
	apply_pins() {
		const $table = this.$table.find("table.sanad-datalist");
		$table.find(".sanad-datalist__td--pinned, .sanad-datalist__th--pinned").removeClass("sanad-datalist__cell--pin-edge").css({ "inset-inline-start": "" });
		if (!this.pinned.length) return;
		let offset = 0;
		const $lead = $table.find("thead th.sanad-datalist__th--check, thead th.sanad-datalist__th--expand");
		$lead.each((i, el) => (offset += $(el).outerWidth() || 0));
		const order = this.columns.map((c) => c.fieldname).filter((f) => this.pinned.includes(f));
		order.forEach((fieldname, i) => {
			const $cells = $table.find(`[data-fieldname="${CSS.escape(fieldname)}"]`).filter(".sanad-datalist__th, .sanad-datalist__td");
			$cells.css("inset-inline-start", `${offset}px`);
			if (i === order.length - 1) $cells.addClass("sanad-datalist__cell--pin-edge");
			offset += ($cells.first().outerWidth() || 0);
		});
	}

	row_html(doc, depth = 0) {
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
		let first = true;
		this.columns.forEach((c) => {
			const rails = first && depth ? this.rails(depth) : "";
			first = false;
			const pinned = this.pinned.includes(c.fieldname) ? " sanad-datalist__td--pinned" : "";
			const card = this.in_card_layout(c) ? (c === this.card_title_column() || c.type === "status" ? "" : " sanad-datalist__td--card-extra") : " sanad-datalist__td--off-card";
			const kind = c.type === "status" ? " sanad-datalist__td--status" : "";
			html += `<td class="sanad-datalist__td sanad-datalist__td--${c.align}${c.hidden_xs ? " sanad-datalist__td--hidden-xs" : ""}${pinned}${card}${kind}" data-fieldname="${ui.escape(c.fieldname)}" data-label="${ui.escape(c.label)}">${rails ? `<div class="sanad-datalist__indent">${rails}<div class="sanad-datalist__indent-body">${this.cell_html(c, doc)}</div></div>` : this.cell_html(c, doc)}</td>`;
		});
		if (this.opts.row_action) {
			html += `<td class="sanad-datalist__td sanad-datalist__td--action"><button type="button" class="sanad-datalist__view sanad-datalist__action">${ui.escape(this.opts.row_action.label || __("View"))}</button></td>`;
		}
		return html + "</tr>";
	}

	/** The column that titles the phone card: the first one kept in that layout. */
	card_title_column() {
		return this.columns.find((c) => this.in_card_layout(c));
	}

	/** Columns kept in the phone card layout: the first one, any status column, plus `mobile_columns`. */
	in_card_layout(c) {
		if (this.opts.mobile !== "cards") return true;
		const picked = this.opts.mobile_columns;
		if (picked && picked.length) return picked.includes(c.fieldname);
		return c === this.columns[0] || c.type === "status";
	}

	title_of(doc) {
		const meta = frappe.get_meta(this.doctype) || {};
		return (meta.title_field && doc[meta.title_field]) || doc.name;
	}

	/** Display text of a value (Link title when Desk fetched it). */
	display_of(c, doc) {
		const value = doc[c.fieldname];
		const title_field = ((this.lv && this.lv.link_field_title_fields) || {})[c.fieldname];
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
				return `<span class="sanad-avatar sanad-avatar--sm sanad-avatar--solid" aria-hidden="true">${ui.escape(ui.initials(display))}</span><span class="sanad-datalist__avatar-text">${ui.escape(display)}</span>`;
			case "entity":
				return sanad.ui.Render.entity(doc, { doctype: doctype || doc.doctype, density: "inline" });
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
				// Everything else is drawn by the kit's one presentation layer, at cell density:
				// a check reads "Yes", a percent gets its bar, an attachment gets its file chip.
				return df && df.fieldtype && df.fieldtype !== "Data" ? sanad.ui.Render.value(value, df, doc, { density: "inline", doctype: doctype || doc.doctype }) : ui.escape(display);
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
		const col = this.columns.find((c) => c.fieldname === fieldname);
		if (!col || !col.sortable) return;
		if (this.page_mode) {
			// the page owns the query: the table only reports what the reader asked for
			const order = this.sort_state.fieldname === fieldname && this.sort_state.order === "desc" ? "asc" : "desc";
			this.sort_state = { fieldname, order };
			this.page = 0;
			this.set_loading(true);
			if (this.opts.on_sort) this.opts.on_sort(fieldname, order, this);
			else this.render();
			return;
		}
		const lv = this.listview;
		if (!lv.sort_selector) return;
		const order = lv.sort_selector.sort_by === fieldname && lv.sort_selector.sort_order === "desc" ? "asc" : "desc";
		lv.sort_selector.set_value(fieldname, order);
		lv.start = 0;
		lv.on_sort_change(fieldname, order);
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
		if (this.page_mode) return Promise.resolve(this.total == null ? rows.length : this.total);
		const lv = this.listview;
		const key = JSON.stringify(lv.get_filters_for_args() || []);
		// a page that came back short is the whole result; no extra request needed
		if (rows.length < cint(lv.start) + cint(lv.page_length)) {
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

	/** Page mode: which page this is, and whether there is another one. */
	render_page_state() {
		if (!this.page_mode) return;
		const pages = Math.max(1, Math.ceil((this.total || 0) / this.page_length));
		const $pager = this.$footer.find(".sanad-datalist__pager");
		let $state = $pager.find(".sanad-datalist__page-state");
		if (!$state.length) $state = $('<span class="sanad-datalist__page-state sanad-tabular" aria-live="polite"></span>').prependTo($pager);
		$state.text(__("{0} / {1}", [ui.format_int(this.page + 1), ui.format_int(pages)]));
		$pager.find('[data-go="prev"]').prop("disabled", this.page <= 0);
		$pager.find('[data-go="next"]').prop("disabled", this.page + 1 >= pages);
	}

	render_footer() {
		const lv = this.listview;
		const rows = this.page_mode ? this.rows : lv.data || [];
		const $count = this.$footer.find(".sanad-datalist__count");
		const $pager = this.$footer.find(".sanad-datalist__pager");
		const paint = () => {
			const total = this.total == null ? rows.length : this.total;
			const text = typeof this.opts.footer.count === "function" ? this.opts.footer.count(total, rows) : ui.plural(total, { one: __("{0} record"), other: __("{0} records") });
			$count.text(rows.length ? __("{0} · showing {1}", [text, ui.format_int(rows.length)]) : text);
			this.render_group_tools();
			this.render_page_state();
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

	/** Expand all / Collapse all, next to the count, only while the table is grouped. */
	render_group_tools() {
		let $tools = this.$footer.find(".sanad-datalist__group-tools");
		if (!this.group_by.length) {
			$tools.remove();
			return;
		}
		if (!$tools.length) {
			$tools = $('<div class="sanad-datalist__group-tools"></div>').insertAfter(this.$footer.find(".sanad-datalist__count"));
			$(`<button type="button" class="sanad-datalist__group-tool" data-fold="0">${ui.icon("es-line-expand", "xs")}<span>${ui.escape(__("Expand all"))}</span></button>`)
				.on("click", () => this.set_all_folded(false))
				.appendTo($tools);
			$(`<button type="button" class="sanad-datalist__group-tool" data-fold="1">${ui.icon("es-line-sidebar-collapse", "xs")}<span>${ui.escape(__("Collapse all"))}</span></button>`)
				.on("click", () => this.set_all_folded(true))
				.appendTo($tools);
		}
		const total = this.group_names.size;
		const folded = Array.from(this.group_names.values()).filter((g) => this.collapsed.has(g.path)).length;
		$tools.find('[data-fold="0"]').prop("disabled", folded === 0);
		$tools.find('[data-fold="1"]').prop("disabled", total > 0 && folded === total);
	}

	refresh() {
		if (this.page_mode) return this.opts.on_page ? this.opts.on_page(this.page, this) : this.render();
		return this.listview.refresh();
	}

	get_selected() {
		if (this.page_mode) return this.rows.filter((d) => this.selected.has(String(d.name)));
		return this.listview.get_checked_items();
	}

	/** A list view keeps its own toolbar in step with a selection; a page is told instead. */
	selection_changed() {
		if (this.lv) this.lv.on_row_checked();
		else if (this.opts.on_select) this.opts.on_select(this.get_selected(), this);
	}

	destroy() {
		$(window).off(`resize.${this.id}`);
		this._card_observer && this._card_observer.disconnect();
		if (this.lv) this.lv.$frappe_list.removeClass("sanad-list-card");
		if (this.$root) this.$root.off(`.${this.id}`);
		this.$footer.off(`.${this.id}`).remove();
		this.$table.remove();
	}
};

export default sanad.ui.DataList;

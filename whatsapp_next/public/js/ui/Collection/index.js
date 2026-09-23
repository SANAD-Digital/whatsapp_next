// sanad.ui.Collection — many rows are not always a table (reference image 07). The same records
// can be read as a table (when comparing columns is the point — accounting entries), a compact
// list (dense scanning), cards (when a picture or a value matters), a gallery (images) or a
// timeline (when *when* is the most important column — activity history).
//
// The component owns the switch between those views, remembers the chosen one per key, and hands
// every row to `sanad.ui.Render` so a person, an item or a document looks the same here as in a
// drawer. Columns come from the DocType's meta unless the caller names them.

import ui from "../_core/index.js";
import Render from "../Render/index.js";
import { avatar, thumb, chip, bind_actions, actions as action_buttons } from "../Render/parts.js";

const VIEW_META = {
	table: { label: () => __("Table"), icon: "es-line-table-view", density: null },
	list: { label: () => __("List"), icon: "es-line-bullet-list", density: "compact" },
	cards: { label: () => __("Cards"), icon: "es-line-tiles", density: "card" },
	gallery: { label: () => __("Gallery"), icon: "es-line-image", density: null },
	timeline: { label: () => __("Timeline"), icon: "es-line-time", density: null },
};

/** Which views suit a kind, in the order the reference shows them. */
const VIEWS_BY_KIND = {
	person: ["list", "cards", "table"],
	item: ["table", "list", "cards", "gallery"],
	document: ["table", "list", "cards"],
	file: ["list", "gallery", "cards"],
	generic: ["table", "list", "cards"],
};

sanad.ui.Collection = class Collection {
	/**
	 * @param {Object} opts
	 * @param {jQuery|HTMLElement} opts.wrapper
	 * @param {string} [opts.doctype] — meta source for columns, kind and formatting
	 * @param {Array<Object>} [opts.rows]
	 * @param {Function} [opts.fetch] — `() => Promise<rows>` (used instead of `rows`)
	 * @param {Array<"table"|"list"|"cards"|"gallery"|"timeline">} [opts.views] — default: by kind
	 * @param {string} [opts.view] — the initial view (default: the first)
	 * @param {Array<Object>} [opts.columns] — `{fieldname, label?, align?, width?, format?(value, doc), type?}`
	 * @param {string} [opts.title]
	 * @param {string} [opts.description]
	 * @param {string} [opts.icon] — header icon
	 * @param {{label: string, value: string|number, fieldtype?: string}} [opts.total] — footer total
	 * @param {Array<Object>} [opts.actions] — per-row quick actions (see Render)
	 * @param {Function} [opts.on_click] — `(doc) => void`
	 * @param {Object} [opts.profile] — Render profile override for these rows
	 * @param {string} [opts.settings_key] — remembers the chosen view for this screen
	 * @param {string} [opts.empty_title]
	 * @param {number} [opts.limit] — show only the first N rows, with a "show all" control
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({ rows: [], actions: [] }, opts);
		this.$wrapper = $(this.opts.wrapper);
		this.doctype = this.opts.doctype;
		this.rows = this.opts.rows || [];
		this.kind = this.opts.kind || (this.doctype ? Render.kind_of(this.doctype) : "generic");
		this.views = this.opts.views || VIEWS_BY_KIND[this.kind] || VIEWS_BY_KIND.generic;
		this.view = this.opts.view || this.saved_view() || this.views[0];
		this.expanded = false;
		this.make();
		if (typeof this.opts.fetch === "function") this.refresh();
		else this.render();
	}

	// ---- shell -----------------------------------------------------------------------------

	make() {
		this.id = ui.uid("coll");
		this.$root = $(`
			<section class="sanad-kit sanad-collection" aria-labelledby="${this.id}-title">
				<header class="sanad-collection__head"${this.opts.title ? "" : " hidden"}>
					<div class="sanad-collection__heading">
						${this.opts.icon ? `<span class="sanad-collection__icon" aria-hidden="true">${ui.icon(this.opts.icon, "md")}</span>` : ""}
						<div>
							<h3 class="sanad-collection__title" id="${this.id}-title">${ui.escape(this.opts.title || "")}</h3>
							${this.opts.description ? `<p class="sanad-collection__desc">${ui.escape(this.opts.description)}</p>` : ""}
						</div>
					</div>
					<div class="sanad-collection__views"></div>
				</header>
				<div class="sanad-collection__body"></div>
				<footer class="sanad-collection__foot" hidden></footer>
			</section>`).appendTo(this.$wrapper.empty());
		this.$body = this.$root.find(".sanad-collection__body");
		this.$foot = this.$root.find(".sanad-collection__foot");
		this.render_switcher();
	}

	render_switcher() {
		const $views = this.$root.find(".sanad-collection__views").empty();
		if (this.views.length < 2) return;
		this.$root.find(".sanad-collection__head").prop("hidden", false);
		const $group = $(`<div class="sanad-seg" role="tablist" aria-label="${ui.escape(__("Display"))}"></div>`).appendTo($views);
		this.views.forEach((view) => {
			const meta = VIEW_META[view];
			if (!meta) return;
			const active = view === this.view;
			$(`<button type="button" class="sanad-seg__btn" role="tab" aria-selected="${active}" tabindex="${active ? 0 : -1}" data-view="${view}">${ui.icon(meta.icon, "xs")}<span>${ui.escape(meta.label())}</span></button>`)
				.on("click", () => this.set_view(view))
				.appendTo($group);
		});
		$group.on("keydown", (e) => {
			const items = $group.find(".sanad-seg__btn").toArray();
			const idx = ui.roving_index(e, items, items.indexOf(document.activeElement));
			if (idx < 0) return;
			e.preventDefault();
			items[idx].focus();
			this.set_view($(items[idx]).data("view"));
		});
	}

	set_view(view) {
		if (!VIEW_META[view] || view === this.view) return this;
		this.view = view;
		this.save_view();
		this.render_switcher();
		this.render();
		ui.announce(__("{0} view", [VIEW_META[view].label()]));
		return this;
	}

	saved_view() {
		if (!this.opts.settings_key) return null;
		try {
			return window.localStorage.getItem(`sanad_collection_${this.opts.settings_key}`);
		} catch (e) {
			return null;
		}
	}

	save_view() {
		if (!this.opts.settings_key) return;
		try {
			window.localStorage.setItem(`sanad_collection_${this.opts.settings_key}`, this.view);
		} catch (e) {
			// private mode — the view simply is not remembered
		}
	}

	// ---- data ------------------------------------------------------------------------------

	refresh() {
		const state = new sanad.ui.EmptyState({ wrapper: this.$body, state: "loading", rows: 3 });
		return Promise.resolve(this.opts.fetch())
			.then((rows) => {
				this.rows = rows || [];
				this.render();
			})
			.catch((err) => state.error(err, { action: { label: __("Retry"), on_click: () => this.refresh() } }));
	}

	set_rows(rows) {
		this.rows = rows || [];
		this.render();
		return this;
	}

	/** Rows shown right now (`limit` keeps the first N until the reader asks for the rest). */
	visible_rows() {
		const limit = this.opts.limit;
		if (!limit || this.expanded || this.rows.length <= limit) return this.rows;
		return this.rows.slice(0, limit);
	}

	columns() {
		if (this._columns) return this._columns;
		const meta = this.doctype ? frappe.get_meta(this.doctype) : null;
		let list = this.opts.columns;
		if (!list || !list.length) {
			list = meta ? ui.meta.preview_fields(meta).slice(0, 5).map((df) => ({ fieldname: df.fieldname })) : Object.keys(this.rows[0] || {}).filter((k) => !k.startsWith("_") && k !== "doctype").slice(0, 5).map((fieldname) => ({ fieldname }));
		}
		this._columns = list.map((c) => {
			const df = (meta && (meta.fields || []).find((f) => f.fieldname === c.fieldname)) || c.df || { fieldname: c.fieldname, fieldtype: "Data" };
			const numeric = ["Currency", "Int", "Float", "Percent"].includes(df.fieldtype);
			return Object.assign({ align: numeric ? "end" : "start" }, c, { df, label: c.label || __(df.label || frappe.unscrub(c.fieldname)) });
		});
		return this._columns;
	}

	set_columns(columns) {
		this.opts.columns = columns;
		this._columns = null;
		this.render();
		return this;
	}

	// ---- render ----------------------------------------------------------------------------

	render() {
		this.$body.empty().attr("data-view", this.view);
		const rows = this.visible_rows();
		if (!this.rows.length) {
			new sanad.ui.EmptyState({ wrapper: this.$body, state: "empty", title: this.opts.empty_title || __("Nothing to show"), description: this.opts.empty_description, action: this.opts.empty_action, size: "sm" });
			this.$foot.prop("hidden", true).empty();
			return this;
		}
		const method = { table: "render_table", list: "render_list", cards: "render_cards", gallery: "render_gallery", timeline: "render_timeline" }[this.view] || "render_list";
		this[method](rows);
		this.render_foot();
		return this;
	}

	/** Shared per-row wiring: click, quick actions. */
	bind_row($el, doc) {
		bind_actions($el, this.row_actions(doc), doc);
		if (typeof this.opts.on_click === "function") {
			$el.addClass("sanad-collection__clickable").on("click", (e) => {
				if ($(e.target).closest("[data-action-index], a, button").length) return;
				this.opts.on_click(doc, e);
			});
			$el.attr("tabindex", "0").on("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					this.opts.on_click(doc, e);
				}
			});
		}
	}

	row_actions(doc) {
		const list = typeof this.opts.actions === "function" ? this.opts.actions(doc) : this.opts.actions;
		return ui.visible_actions(list || [], doc, this.doctype);
	}

	render_table(rows) {
		const cols = this.columns();
		const head = cols.map((c) => `<th class="sanad-table__${c.align}"${c.width ? ` style="inline-size:${ui.escape(c.width)}"` : ""}>${ui.escape(c.label)}</th>`).join("");
		const has_actions = this.opts.actions && (typeof this.opts.actions === "function" || this.opts.actions.length);
		const $wrap = $(`<div class="sanad-table-wrap"><table class="sanad-table sanad-collection__table"><thead><tr>${head}${has_actions ? `<th class="sanad-table__end"><span class="sanad-visually-hidden">${ui.escape(__("Actions"))}</span></th>` : ""}</tr></thead><tbody></tbody></table></div>`).appendTo(this.$body);
		const $tbody = $wrap.find("tbody");
		rows.forEach((doc) => {
			const cells = cols
				.map((c) => {
					const html = typeof c.format === "function" ? c.format(doc[c.fieldname], doc) : this.cell(c, doc);
					return `<td class="sanad-table__${c.align}${c.align === "end" ? " sanad-tabular" : ""}" data-label="${ui.escape(c.label)}">${html == null || html === "" ? '<span class="sanad-muted">—</span>' : html}</td>`;
				})
				.join("");
			const $tr = $(`<tr>${cells}${has_actions ? `<td class="sanad-table__end">${action_buttons(this.row_actions(doc))}</td>` : ""}</tr>`).appendTo($tbody);
			this.bind_row($tr, doc);
		});
	}

	/** One table cell: the first column carries the record's identity, the rest are values. */
	cell(c, doc) {
		if (c.entity || (c === this.columns()[0] && this.opts.identity !== false && this.doctype)) {
			return Render.entity(doc, { doctype: this.doctype, kind: this.kind, density: "inline", profile: this.opts.profile, href: this.opts.on_click ? null : undefined });
		}
		return Render.value(doc[c.fieldname], c.df, doc, { density: "inline", doctype: this.doctype, variant: c.variant });
	}

	render_list(rows) {
		const $list = $('<div class="sanad-collection__list"></div>').appendTo(this.$body);
		rows.forEach((doc) => {
			const $item = $('<div class="sanad-collection__item"></div>').appendTo($list);
			$item.html(Render.entity(doc, { doctype: this.doctype, kind: this.kind, density: "row", profile: this.opts.profile, actions: this.row_actions(doc), href: this.opts.on_click ? null : undefined }));
			this.bind_row($item, doc);
		});
	}

	render_cards(rows) {
		const $grid = $('<div class="sanad-collection__grid"></div>').appendTo(this.$body);
		rows.forEach((doc) => {
			const $item = $('<div class="sanad-collection__cell"></div>').appendTo($grid);
			$item.html(Render.entity(doc, { doctype: this.doctype, kind: this.kind, density: "card", profile: this.opts.profile, actions: this.row_actions(doc), href: this.opts.on_click ? null : undefined }));
			this.bind_row($item, doc);
		});
	}

	render_gallery(rows) {
		const $grid = $('<div class="sanad-collection__gallery"></div>').appendTo(this.$body);
		const max = this.opts.gallery_max || 8;
		rows.slice(0, max).forEach((doc, i) => {
			const vm = Render.vm(doc, { doctype: this.doctype, kind: this.kind, profile: this.opts.profile, density: "card" });
			const rest = rows.length - max;
			const overlay = i === max - 1 && rest > 0 ? `<span class="sanad-collection__more">+${ui.format_int(rest)}</span>` : "";
			const $item = $(`<div class="sanad-collection__tile" title="${ui.escape(vm.title)}">${thumb({ src: vm.image, alt: vm.title, size: "cover", icon: vm.icon })}${overlay}<span class="sanad-collection__caption" dir="auto">${ui.escape(vm.title)}</span></div>`).appendTo($grid);
			this.bind_row($item, doc);
		});
	}

	/**
	 * Activity history: time and sequence are the information, so a timeline beats a table.
	 * Rows are `{title, description?, time, user?, icon?, tone?, html?}` — or plain docs, read
	 * through `opts.timeline` (a mapper).
	 */
	render_timeline(rows) {
		const map = this.opts.timeline || ((doc) => doc);
		const $list = $('<ol class="sanad-timeline"></ol>').appendTo(this.$body);
		rows.forEach((doc) => {
			const r = map(doc) || {};
			const tone = ui.tone(r.tone || "gray");
			const $item = $(`<li class="sanad-timeline__item">
				<span class="sanad-timeline__rail" aria-hidden="true"><span class="sanad-timeline__dot sanad-tone--${tone}">${r.icon ? ui.icon(r.icon, "xs") : ""}</span></span>
				<div class="sanad-timeline__body">
					<div class="sanad-timeline__head">
						<span class="sanad-timeline__title" dir="auto">${ui.escape(r.title || "")}</span>
						${r.time ? `<span class="sanad-timeline__time">${Render.value(r.time, { fieldtype: "Datetime", fieldname: "time" }, doc, { density: "inline" })}</span>` : ""}
					</div>
					${r.description ? `<div class="sanad-timeline__desc" dir="auto">${r.html ? r.description : ui.escape(r.description)}</div>` : ""}
					${r.user ? `<div class="sanad-timeline__user">${chip({ icon: "es-line-customer", text: r.user })}</div>` : ""}
				</div>
			</li>`).appendTo($list);
			this.bind_row($item, doc);
		});
	}

	/** Footer: the total of the reference tables, and the "show all" control when `limit` cut. */
	render_foot() {
		this.$foot.empty();
		const total = this.opts.total;
		const hidden = this.opts.limit && !this.expanded && this.rows.length > this.opts.limit;
		if (!total && !hidden) {
			this.$foot.prop("hidden", true);
			return;
		}
		if (total) {
			const value = typeof total.value === "function" ? total.value(this.rows) : total.value;
			const html = total.fieldtype ? Render.value(value, { fieldtype: total.fieldtype }, this.rows[0] || {}, { density: "card", variant: "strong" }) : ui.escape(value);
			this.$foot.append(`<div class="sanad-collection__total"><span class="sanad-collection__total-label">${ui.escape(total.label || __("Total"))}</span><span class="sanad-collection__total-value">${html}</span>${total.note ? `<span class="sanad-collection__total-note">${ui.escape(total.note)}</span>` : ""}</div>`);
		}
		if (hidden) {
			const rest = this.rows.length - this.opts.limit;
			$(`<button type="button" class="btn btn-sm btn-default sanad-collection__more-btn">${ui.escape(__("Show all {0}", [ui.format_int(this.rows.length)]))}</button>`)
				.on("click", () => {
					this.expanded = true;
					this.render();
					ui.announce(__("{0} more rows shown", [ui.format_int(rest)]));
				})
				.appendTo(this.$foot);
		}
		this.$foot.prop("hidden", false);
	}

	destroy() {
		this.$root.remove();
	}
};

export default sanad.ui.Collection;

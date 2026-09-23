// sanad.ui.RowActions — a per-row overflow button (`es-line-overflow`) on a Desk list that opens
// a small menu of the actions whose `condition(doc)` passes, plus an optional row-click handler
// (used to open a Drawer instead of the form). Rows are re-decorated after every render by
// wrapping `listview.render_list`, so realtime updates and paging keep their buttons. The menu is
// appended to `<body>` (list rows clip overflow) with full keyboard support.

import ui from "../_core/index.js";

sanad.ui.RowActions = class RowActions {
	/**
	 * @param {Object} opts
	 * @param {Object} opts.listview — a Desk ListView
	 * @param {Array<{label: string, icon?: string, condition?: Function, handler: Function, danger?: boolean, perm?: string, roles?: string[]}>} opts.actions
	 *   `condition(doc)` hides the entry; `perm` = ptype on the list doctype; `roles` = any-of
	 * @param {Function} [opts.on_row_click] — `(doc, $row) => void`; suppresses the form route
	 * @param {string} [opts.label] — accessible name of the button ("Actions")
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({ actions: [] }, opts);
		this.listview = this.opts.listview;
		if (!this.listview) throw new Error("sanad.ui.RowActions: listview is required");
		this.doctype = this.listview.doctype;
		this.mount();
	}

	mount() {
		const lv = this.listview;
		this.unbind_render = ui.on_list_render(lv, () => this.decorate());
		lv.$result.on("click.sanadrow", ".sanad-rowactions__btn", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.open_menu($(e.currentTarget));
		});
		lv.$result.on("keydown.sanadrow", ".sanad-rowactions__btn", (e) => {
			if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				e.stopPropagation();
				this.open_menu($(e.currentTarget));
			}
		});
		this.decorate();
	}

	doc_of(name) {
		return (this.listview.data || []).find((d) => d.name === name) || null;
	}

	visible_actions(doc) {
		return ui.visible_actions(this.opts.actions, doc, this.doctype);
	}

	/** Add the overflow button to every rendered row (idempotent). */
	decorate() {
		const label = this.opts.label || __("Actions");
		this.listview.$result.find(".list-row-container").each((i, el) => {
			const $row = $(el);
			if ($row.find(".sanad-rowactions").length) return;
			const name = ui.docname_of_row($row);
			if (!name) return;
			const doc = this.doc_of(name);
			const has_actions = doc && this.visible_actions(doc).length > 0;
			const title_field = (frappe.get_meta(this.doctype) || {}).title_field;
			const title = (doc && title_field && doc[title_field]) || name;
			const $target = $row.find(".level-right").first();
			const $cell = $(`<div class="sanad-rowactions"></div>`);
			if (has_actions) {
				$cell.append(
					`<button type="button" class="btn btn-xs btn-default sanad-rowactions__btn" data-name="${ui.escape(name)}" aria-haspopup="menu" aria-expanded="false" aria-label="${ui.escape(__("{0} for {1}", [label, title]))}">${ui.icon(ui.icons.more, "sm")}</button>`
				);
			}
			if ($target.length) $target.append($cell);
			else $row.find(".list-row").append($cell);
			if (typeof this.opts.on_row_click === "function") {
				$row.addClass("sanad-rowactions__clickable");
				$row.find(".list-row").on("click", (e) => this.row_click(e, $row, name));
			}
		});
	}

	row_click(e, $row, name) {
		const $t = $(e.target);
		if (e.ctrlKey || e.metaKey) return; // Frappe: toggle the checkbox
		if (
			$t.is(":checkbox") ||
			$t.closest("a, button, .sanad-rowactions, [data-toggle='dropdown'], .filterable, .list-row-like, .select-like").length
		) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		const doc = this.doc_of(name);
		if (doc) this.opts.on_row_click(doc, $row);
	}

	// ---- menu ------------------------------------------------------------------------------

	open_menu($btn) {
		this.close_menu();
		const name = $btn.data("name");
		const doc = this.doc_of(name);
		if (!doc) return;
		const actions = this.visible_actions(doc);
		if (!actions.length) return;
		const id = ui.uid("rowmenu");
		const $menu = $(`<div class="sanad-kit sanad-rowactions__menu" id="${id}" role="menu" aria-label="${ui.escape(this.opts.label || __("Actions"))}"></div>`);
		actions.forEach((a) => {
			$(`<button type="button" class="sanad-rowactions__item${a.danger ? " sanad-rowactions__item--danger" : ""}" role="menuitem" tabindex="-1">${a.icon ? `<span class="sanad-rowactions__icon" aria-hidden="true">${ui.icon(a.icon, "sm")}</span>` : ""}<span>${ui.escape(a.label)}</span></button>`)
				.on("click", (e) => {
					e.preventDefault();
					e.stopPropagation();
					this.close_menu(true);
					Promise.resolve(a.handler(doc, $btn.closest(".list-row-container"))).catch((err) => {
						if (err && err.message && err.message !== "cancelled") sanad.ui.Toast.error(err);
					});
				})
				.appendTo($menu);
		});
		$menu.on("keydown", (e) => this.menu_keydown(e, $menu));
		$menu.appendTo(document.body);
		this.position($menu, $btn);
		$btn.attr("aria-expanded", "true").attr("aria-controls", id);
		this.$menu = $menu;
		this.$opener = $btn;
		this._outside = (e) => {
			if (!$(e.target).closest(".sanad-rowactions__menu").length) this.close_menu();
		};
		window.setTimeout(() => {
			$(document).on("mousedown.sanadrowmenu touchstart.sanadrowmenu", this._outside);
			$(window).on("resize.sanadrowmenu scroll.sanadrowmenu", () => this.close_menu());
		}, 0);
		$menu.find('[role="menuitem"]').first().attr("tabindex", "0").trigger("focus");
	}

	position($menu, $btn) {
		const rect = $btn[0].getBoundingClientRect();
		const w = $menu.outerWidth();
		const h = $menu.outerHeight();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		// physical x of the menu's start edge; CSS anchors it with inset-inline-start: 0
		const start_edge = rect.left;
		const end_edge = rect.right;
		let x = ui.is_rtl() ? start_edge : end_edge - w;
		x = Math.max(8, Math.min(x, vw - w - 8));
		let y = rect.bottom + 4;
		if (y + h > vh - 8) y = Math.max(8, rect.top - h - 4);
		const tx = ui.is_rtl() ? -(vw - (x + w)) : x;
		$menu[0].style.setProperty("--sanad-menu-x", `${Math.round(tx)}px`);
		$menu[0].style.setProperty("--sanad-menu-y", `${Math.round(y)}px`);
	}

	menu_keydown(e, $menu) {
		const items = $menu.find('[role="menuitem"]').toArray();
		let idx = items.indexOf(document.activeElement);
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			this.close_menu(true);
		} else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
			e.preventDefault();
			if (e.key === "ArrowDown") idx = (idx + 1) % items.length;
			else if (e.key === "ArrowUp") idx = (idx - 1 + items.length) % items.length;
			else if (e.key === "Home") idx = 0;
			else idx = items.length - 1;
			items.forEach((el) => el.setAttribute("tabindex", "-1"));
			items[idx].setAttribute("tabindex", "0");
			items[idx].focus();
		} else if (e.key === "Tab") {
			this.close_menu();
		}
	}

	close_menu(restore_focus = false) {
		if (!this.$menu) return;
		this.$menu.remove();
		this.$menu = null;
		$(document).off(".sanadrowmenu");
		$(window).off(".sanadrowmenu");
		if (this.$opener) {
			this.$opener.attr("aria-expanded", "false").removeAttr("aria-controls");
			if (restore_focus) this.$opener.trigger("focus");
			this.$opener = null;
		}
	}

	destroy() {
		this.close_menu();
		this.unbind_render && this.unbind_render();
		this.listview.$result.off(".sanadrow");
		this.listview.$result.find(".sanad-rowactions").remove();
	}
};

export default sanad.ui.RowActions;

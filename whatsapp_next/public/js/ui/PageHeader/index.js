// sanad.ui.PageHeader — the prototype's screen header above a Desk list (or on a custom page):
// H2 title + one-line description with the primary button at the inline-end, an optional
// secondary button row, a KPI row (ListStatsCard inside — icon in a tinted square, label, big
// tabular number, sub-text; 4 / 2 / 1 per row), an optional banner (tone + text + action) and
// custom blocks (strips, cards) rendered by the caller. Mounted as the first child of
// `listview.$frappe_list`, above the FilterBar. Above a list, Desk's breadcrumb already names the
// screen and its page bar is where a list's verbs live: `primary` replaces Frappe's "+ Add" there
// and `secondary` become page-bar buttons, so the header itself is the KPI row, banner and blocks.

import ui from "../_core/index.js";

const BANNER_ICON = { amber: "es-line-alert-triangle", red: "es-line-alert-circle", blue: "es-line-info", green: "es-line-success", gray: "es-line-info" };

sanad.ui.PageHeader = class PageHeader {
	/**
	 * @param {Object} opts
	 * @param {Object} [opts.listview] — a Desk ListView
	 * @param {Object} [opts.page] — on a custom page, its Desk page (`frappe.ui.make_app_page`): the
	 *   screen then wears Desk's own strip as a list does — the page's title and breadcrumb, `primary`
	 *   and `secondary` on its page bar — and the header is the KPI row, banner and blocks
	 * @param {jQuery|HTMLElement} [opts.wrapper] — mount point on a custom page
	 * @param {string} opts.title
	 * @param {string} [opts.description]
	 * @param {{label, icon?, handler, roles?, perm?}} [opts.primary] — replaces Frappe's "+ Add"
	 * @param {Array<{label, icon?, handler, roles?, perm?, count?}>} [opts.secondary]
	 * @param {Array<Object>} [opts.stats] — ListStatsCard card specs (KPI row)
	 * @param {Object|Function} [opts.banner] — `{tone, icon?, text, action?: {label, handler}}` or `() => Promise<banner|null>`
	 * @param {Array<{key, render($el, header), events?: string[]}>} [opts.blocks] — custom strips / cards
	 * @param {Object<string, Function>} [opts.events] — realtime event → `(data, header) => void`
	 * @param {number} [opts.refresh_seconds] — KPI auto-refresh
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({ secondary: [], stats: [], blocks: [], events: {} }, opts);
		this.listview = this.opts.listview;
		// the Desk page whose bar carries the verbs: the list's, or a custom page's own
		this.desk_page = this.listview ? this.listview.page : this.opts.page || null;
		this.page_buttons = [];
		this.handlers = {};
		this.block_handlers = [];
		this.make();
		this.bind_events();
		this.last_refresh = Date.now();
		this.refresh_banner();
		this.render_blocks();
	}

	// ---- mount ---------------------------------------------------------------------------

	make() {
		const o = this.opts;
		this.$el = $(`
			<header class="sanad-kit sanad-pagehead">
				<div class="sanad-pagehead__row">
					<div class="sanad-pagehead__text">
						${o.title && !this.desk_page ? `<h2 class="sanad-pagehead__title">${ui.escape(o.title)}</h2>` : ""}
						${o.description && !this.desk_page ? `<p class="sanad-pagehead__desc">${ui.escape(o.description)}</p>` : ""}
					</div>
					<div class="sanad-pagehead__actions"></div>
				</div>
				<div class="sanad-pagehead__stats"></div>
				<div class="sanad-pagehead__banner" hidden></div>
				<div class="sanad-pagehead__blocks"></div>
			</header>`);
		this.$actions = this.$el.find(".sanad-pagehead__actions");
		this.$stats = this.$el.find(".sanad-pagehead__stats");
		this.$banner = this.$el.find(".sanad-pagehead__banner");
		this.$blocks = this.$el.find(".sanad-pagehead__blocks");
		if (!this.desk_page) this.render_actions();
		else this.$actions.remove();
		// a header may carry nothing but a banner and its blocks (a screen whose console names
		// itself, or one whose title is Desk's strip): an empty title row would then reserve space
		// and draw a stray margin
		if (this.desk_page || (!o.title && !o.description)) this.$el.find(".sanad-pagehead__text").remove();
		if (!this.$el.find(".sanad-pagehead__row").children().length) this.$el.find(".sanad-pagehead__row").remove();
		if (o.stats && o.stats.length) {
			this.stats = new sanad.ui.ListStatsCard({ wrapper: this.$stats, cards: o.stats, refresh_seconds: o.refresh_seconds, layout: "kpi" });
		} else {
			this.$stats.remove();
		}
		if (this.listview) {
			this.listview.$frappe_list.prepend(this.$el);
			// FilterBar mounts after its meta promise and also prepends itself: stay first.
			this.keep_first = () => {
				if (this.$el.parent().length && !this.$el.is(":first-child")) this.$el.prependTo(this.listview.$frappe_list);
			};
			window.setTimeout(this.keep_first, 0);
			this.unhook_render = ui.on_list_render(this.listview, this.keep_first);
			this.mount_page_actions();
			// Desk fires `show` immediately after mount; without this guard every banner, block and
			// KPI was fetched twice on each visit to the list.
			this.listview.page.wrapper.on("show.sanadpagehead", () => this.refresh());
		} else {
			$(this.opts.wrapper).prepend(this.$el);
			if (this.desk_page) {
				if (o.title) this.desk_page.set_title(o.title);
				this.mount_page_actions();
			}
		}
	}

	/**
	 * Above a list the actions go to Desk's page bar. Desk re-draws "+ Add" after each load and
	 * whenever the selection clears (`ListView.set_primary_action`), so that method is replaced on
	 * this list rather than the button being cleared after the fact.
	 */
	mount_page_actions() {
		const lv = this.listview;
		const page = this.desk_page;
		const p = this.opts.primary;
		if (p && lv) {
			lv.can_create = false;
			lv.set_primary_action = () => {
				if (this.allowed(p)) page.set_primary_action(p.label, () => p.handler(this), p.icon);
				else page.clear_primary_action();
			};
			lv.set_primary_action();
		} else if (p && this.allowed(p)) {
			page.set_primary_action(p.label, () => p.handler(this), p.icon);
		}
		(this.opts.secondary || []).forEach((a) => {
			if (!this.allowed(a)) return;
			const $btn = page.add_button(ui.escape(a.label), () => a.handler(this), { icon: a.icon });
			this.page_buttons.push($btn);
			if (a.count == null) return;
			Promise.resolve(typeof a.count === "function" ? a.count() : a.count).then((n) => {
				if (n == null) return;
				$btn.append(` <span class="sanad-pagehead__count sanad-tabular">${ui.escape(ui.format_int(n))}</span>`);
			});
		});
	}

	allowed(action) {
		if (action.roles && !action.roles.some((r) => frappe.user.has_role(r))) return false;
		if (action.perm && this.listview && !frappe.perm.has_perm(this.listview.doctype, 0, action.perm)) return false;
		if (action.condition && !action.condition()) return false;
		return typeof action.handler === "function";
	}

	render_actions() {
		this.$actions.empty();
		(this.opts.secondary || []).forEach((a) => {
			if (!this.allowed(a)) return;
			const count = a.count != null ? ` <span class="sanad-pagehead__count sanad-tabular">${ui.escape(ui.format_int(a.count))}</span>` : "";
			$(`<button type="button" class="btn btn-default btn-sm">${a.icon ? ui.icon(a.icon, "xs") + " " : ""}${ui.escape(a.label)}${count}</button>`)
				.on("click", () => a.handler(this))
				.appendTo(this.$actions);
		});
		const p = this.opts.primary;
		if (p && this.allowed(p)) {
			$(`<button type="button" class="btn btn-primary btn-sm sanad-pagehead__primary">${p.icon ? ui.icon(p.icon, "xs") + " " : ""}${ui.escape(p.label)}</button>`)
				.on("click", () => p.handler(this))
				.appendTo(this.$actions);
		}
		if (!this.$actions.children().length) this.$actions.remove();
	}

	// ---- banner ----------------------------------------------------------------------------

	set_banner(banner) {
		if (!banner) {
			this.$banner.attr("hidden", true).empty().removeAttr("role");
			return this;
		}
		const tone = ui.tone(banner.tone || "amber");
		const icon = banner.icon || BANNER_ICON[tone] || "es-line-info";
		this.$banner
			.attr("role", tone === "red" ? "alert" : "status")
			.removeAttr("hidden")
			.attr("class", `sanad-pagehead__banner sanad-tone--${tone}`)
			.html(`<span class="sanad-pagehead__banner-icon" aria-hidden="true">${ui.icon(icon, "sm")}</span><span class="sanad-pagehead__banner-text">${ui.escape(banner.text)}</span>`);
		if (banner.action && banner.action.handler) {
			$(`<button type="button" class="btn btn-default btn-xs sanad-pagehead__banner-action">${ui.escape(banner.action.label)}</button>`)
				.on("click", () => banner.action.handler(this))
				.appendTo(this.$banner);
		}
		return this;
	}

	refresh_banner() {
		const b = this.opts.banner;
		if (!b) return Promise.resolve();
		if (typeof b !== "function") {
			this.set_banner(b);
			return Promise.resolve();
		}
		return Promise.resolve(b(this))
			.then((banner) => this.set_banner(banner))
			.catch((err) => this.set_banner({ tone: "red", text: err.message || __("Something went wrong. Try again.") }));
	}

	// ---- blocks ----------------------------------------------------------------------------

	get_block(key) {
		return this.$blocks.find(`.sanad-pagehead__block[data-key="${key}"]`);
	}

	render_block(block) {
		let $el = this.get_block(block.key);
		if (!$el.length) $el = $(`<section class="sanad-pagehead__block" data-key="${ui.escape(block.key)}"></section>`).appendTo(this.$blocks);
		try {
			return Promise.resolve(block.render($el, this)).catch((err) => {
				new sanad.ui.EmptyState({ wrapper: $el, state: "error", size: "sm", description: err.message, action: { label: __("Retry"), onclick: () => this.render_block(block) } });
			});
		} catch (err) {
			new sanad.ui.EmptyState({ wrapper: $el, state: "error", size: "sm", description: err.message });
			return Promise.resolve();
		}
	}

	render_blocks() {
		return Promise.all((this.opts.blocks || []).map((b) => this.render_block(b)));
	}

	// ---- realtime / refresh ----------------------------------------------------------------

	bind_events() {
		Object.entries(this.opts.events || {}).forEach(([event, handler]) => {
			const bound = (data) => handler(data, this);
			this.handlers[event] = bound;
			frappe.realtime.on(event, bound);
		});
		(this.opts.blocks || []).forEach((block) => {
			(block.events || []).forEach((event) => {
				const bound = ui.throttle(() => this.render_block(block), 1500);
				this.block_handlers.push([event, bound]);
				frappe.realtime.on(event, bound);
			});
		});
	}

	/** @param {boolean} [force] — refresh even inside the quiet window (an explicit user action). */
	refresh(force = false) {
		const now = Date.now();
		if (!force && this.last_refresh && now - this.last_refresh < 2000) return Promise.resolve();
		this.last_refresh = now;
		const jobs = [this.refresh_banner(), this.render_blocks()];
		if (this.stats) jobs.push(this.stats.refresh());
		return Promise.all(jobs);
	}

	destroy() {
		Object.entries(this.handlers).forEach(([event, h]) => frappe.realtime.off(event, h));
		this.block_handlers.forEach(([event, h]) => frappe.realtime.off(event, h));
		this.handlers = {};
		this.block_handlers = [];
		this.unhook_render && this.unhook_render();
		this.stats && this.stats.destroy();
		this.listview && this.listview.page.wrapper.off(".sanadpagehead");
		// a custom page redraws its header: the buttons it put on Desk's bar go with it
		if (this.desk_page && !this.listview) {
			this.page_buttons.forEach(($b) => $b && $b.remove());
			this.page_buttons = [];
			if (this.opts.primary) this.desk_page.clear_primary_action();
		}
		this.$el.remove();
	}
};

export default sanad.ui.PageHeader;

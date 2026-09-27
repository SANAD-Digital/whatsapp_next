// sanad.ui.SettingsWindow — a settings window in the shape of claude.ai's own: one large modal
// over the dimmed page, a rail on the inline-start (a search field, then the sections in labelled
// groups) and one content pane that scrolls by itself, with the close button at its top corner.
// Under 720 px it takes the whole screen and works in two steps — the list of sections, then one
// section with a back button — the way a phone's settings do.
//
// The window draws nothing inside a section. The host renders each one through `render(key,
// $pane)`; the content classes below (`sanad-sw__h`, `sanad-sw__row`, …) give it the same rows
// and headings Claude's settings use, so a host that wants that look only writes markup.
//
// Nothing here knows the host app: every colour is a token, every label goes through `__()`.

import ui from "../_core/index.js";
import { ico } from "../_kit/icons.js";

const esc = (v) => ui.escape(v);

sanad.ui.SettingsWindow = class SettingsWindow {
	/**
	 * @param {Object} opts
	 * @param {string} opts.title — the window's accessible name ("Settings")
	 * @param {Array<{label?: string, items: Array<{key: string, label: string, icon?: string, keywords?: string}>}>} opts.groups
	 * @param {Function} opts.render — `(key, $pane, win) => Promise|void`; draws one section
	 * @param {string} [opts.active] — the section to open first; default the first one
	 * @param {string} [opts.cls] — extra class on the window (the host's palette scope)
	 * @param {Function} [opts.on_show] — `(key, win)` after a section is drawn
	 * @param {Function} [opts.on_close] — `(win)`
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({ groups: [] }, opts);
		this.id = ui.uid("sanad-sw");
		this.items = [];
		(this.opts.groups || []).forEach((g) => (g.items || []).forEach((it) => this.items.push(it)));
		this.current = null;
		this.open = false;
		this.make();
	}

	// ---- shell -----------------------------------------------------------------------------------

	make() {
		const o = this.opts;
		this.$backdrop = $(`<div class="sanad-sw-backdrop" hidden></div>`);
		this.$root = $(`
			<section class="sanad-kit sanad-sw ${esc(o.cls || "")}" role="dialog" aria-modal="true" aria-label="${esc(o.title || __("Settings"))}" hidden>
				<aside class="sanad-sw__rail">
					<label class="sanad-sw__search">
						<span class="sanad-sw__search-icon" aria-hidden="true">${ico("search", "sm")}</span>
						<input type="search" data-sanad-bare autocomplete="off" placeholder="${esc(__("Search"))}" aria-label="${esc(__("Search settings"))}">
					</label>
					<nav class="sanad-sw__nav" aria-label="${esc(o.title || __("Settings"))}"></nav>
					<p class="sanad-sw__none" hidden>${esc(__("No setting matches"))}</p>
				</aside>
				<div class="sanad-sw__main">
					<div class="sanad-sw__bar">
						<button type="button" class="sanad-sw__back" aria-label="${esc(__("Back"))}">${ico("caret", "sm")}<span class="sanad-sw__back-label">${esc(o.title || __("Settings"))}</span></button>
						<button type="button" class="sanad-sw__close" aria-label="${esc(__("Close"))}" title="${esc(__("Close (Esc)"))}">${ico("x", "md")}</button>
					</div>
					<div class="sanad-sw__pane" role="region" tabindex="-1"></div>
				</div>
			</section>`);
		this.$nav = this.$root.find(".sanad-sw__nav");
		this.$pane = this.$root.find(".sanad-sw__pane");
		this.$search = this.$root.find(".sanad-sw__search input");
		this.draw_nav();

		this.$root.find(".sanad-sw__close").on("click", () => this.hide());
		this.$root.find(".sanad-sw__back").on("click", () => this.$root.removeClass("sanad-sw--pane"));
		this.$backdrop.on("click", () => this.hide());
		this.$root.on("keydown", (e) => {
			// a Frappe dialog opened from a section owns its own Escape
			if (e.key === "Escape" && !$(".modal.show").length) {
				e.stopPropagation();
				this.hide();
			}
		});
		this.$search.on("input", () => this.filter(this.$search.val()));
		this.$search.on("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				const $first = this.$nav.find(".sanad-sw__item:visible").first();
				if ($first.length) this.show($first.data("key"));
			} else if (e.key === "ArrowDown") {
				e.preventDefault();
				this.$nav.find(".sanad-sw__item:visible").first().trigger("focus");
			}
		});
		this.$nav.on("keydown", ".sanad-sw__item", (e) => {
			const items = this.$nav.find(".sanad-sw__item:visible").toArray();
			const idx = ui.roving_index(e, items, items.indexOf(e.currentTarget));
			if (idx < 0) return;
			e.preventDefault();
			items[idx].focus();
		});
	}

	draw_nav() {
		this.$nav.empty();
		(this.opts.groups || []).forEach((g) => {
			const $group = $(`<div class="sanad-sw__group" role="group"></div>`).appendTo(this.$nav);
			if (g.label) {
				const gid = ui.uid("sanad-sw-g");
				$group.attr("aria-labelledby", gid).append(`<p class="sanad-sw__group-label" id="${gid}">${esc(g.label)}</p>`);
			}
			(g.items || []).forEach((it) => {
				$(`<button type="button" class="sanad-sw__item" data-key="${esc(it.key)}">
					<span class="sanad-sw__item-icon" aria-hidden="true">${it.icon ? ico(it.icon, "sm") : ""}</span>
					<span class="sanad-sw__item-label">${esc(it.label)}</span>
				</button>`)
					.on("click", () => this.show(it.key))
					.appendTo($group);
			});
		});
	}

	/** Keep the sections whose label (or keywords) holds the typed text; a group with none hides. */
	filter(text) {
		const q = String(text || "").trim().toLowerCase();
		let shown = 0;
		this.$nav.find(".sanad-sw__group").each((_, group) => {
			let in_group = 0;
			$(group)
				.find(".sanad-sw__item")
				.each((__, btn) => {
					const it = this.items.find((i) => i.key === $(btn).data("key")) || {};
					const hay = `${it.label || ""} ${it.keywords || ""} ${it.key || ""}`.toLowerCase();
					const hit = !q || hay.includes(q);
					$(btn).prop("hidden", !hit);
					if (hit) in_group += 1;
				});
			$(group).prop("hidden", !in_group);
			shown += in_group;
		});
		this.$root.find(".sanad-sw__none").prop("hidden", shown > 0);
	}

	// ---- sections --------------------------------------------------------------------------------

	/** Open one section: mark it in the rail and let the host draw it into the pane. */
	show(key) {
		const it = this.items.find((i) => i.key === key) || this.items[0];
		if (!it) return Promise.resolve();
		this.current = it.key;
		this.$nav
			.find(".sanad-sw__item")
			.removeClass("is-on")
			.removeAttr("aria-current")
			.filter(`[data-key="${it.key}"]`)
			.addClass("is-on")
			.attr("aria-current", "page");
		this.$root.addClass("sanad-sw--pane");
		this.$root.find(".sanad-sw__back-label").text(it.label);
		this.$pane.attr("aria-label", it.label).scrollTop(0).empty();
		const done = Promise.resolve(this.opts.render ? this.opts.render(it.key, this.$pane, this) : null);
		return done.then(() => {
			if (typeof this.opts.on_show === "function") this.opts.on_show(it.key, this);
		});
	}

	/** Draw the open section again (after a save, a sync, a realtime event). */
	refresh() {
		return this.current ? this.show(this.current) : Promise.resolve();
	}

	// ---- open / close ----------------------------------------------------------------------------

	/** Show the window, on `key` when given; a second call only switches the section. */
	show_window(key) {
		const first = key || this.current || this.opts.active || (this.items[0] || {}).key;
		if (this.open) return this.show(first);
		this.open = true;
		this.opener = document.activeElement;
		this.$backdrop.appendTo(document.body).prop("hidden", false);
		this.$root.appendTo(document.body).prop("hidden", false);
		ui.overlay.open(this);
		$(document.body).addClass("sanad-sw-open");
		window.requestAnimationFrame(() => this.$root.addClass("sanad-sw--in"));
		this.untrap = ui.trap_focus(this.$root);
		const shown = this.show(first);
		// on a phone the window opens on the list when no section was asked for
		if (!key && window.matchMedia("(max-width: 719px)").matches) this.$root.removeClass("sanad-sw--pane");
		// like Claude's: the caret waits in the search field (on a phone only on the list step)
		if (this.$search.is(":visible")) this.$search.trigger("focus");
		else this.$root.find(".sanad-sw__close").trigger("focus");
		ui.announce(__("{0} opened.", [this.opts.title || __("Settings")]));
		return shown;
	}

	hide() {
		if (!this.open) return this;
		this.open = false;
		this.untrap && this.untrap();
		ui.overlay.close(this);
		this.$root.removeClass("sanad-sw--in");
		window.setTimeout(() => {
			if (this.open) return;
			this.$root.prop("hidden", true).detach();
			this.$backdrop.prop("hidden", true).detach();
			if (!$(".sanad-sw:not([hidden])").length) $(document.body).removeClass("sanad-sw-open");
		}, 160);
		if (this.opener && document.contains(this.opener) && this.opener.focus) this.opener.focus();
		if (typeof this.opts.on_close === "function") this.opts.on_close(this);
		return this;
	}

	// ---- content helpers -------------------------------------------------------------------------

	/** The pane's title and the line under it. */
	static head_html(title, description) {
		return `<header class="sanad-sw__head"><h2 class="sanad-sw__title">${esc(title)}</h2>${
			description ? `<p class="sanad-sw__desc">${esc(description)}</p>` : ""
		}</header>`;
	}

	/** A section heading inside the pane (Claude's "General", "Code appearance"). */
	static section_html(title, note) {
		return `<div class="sanad-sw__h"><h3>${esc(title)}</h3>${note ? `<p>${esc(note)}</p>` : ""}</div>`;
	}

	/** One setting row: title and description on the start side, `control_html` on the end side. */
	static row_html(title, description, control_html = "") {
		return `<div class="sanad-sw__row"><div class="sanad-sw__row-text"><span class="sanad-sw__row-title">${esc(
			title
		)}</span>${description ? `<span class="sanad-sw__row-desc">${esc(description)}</span>` : ""}</div><div class="sanad-sw__row-control">${control_html}</div></div>`;
	}
};

export default sanad.ui.SettingsWindow;

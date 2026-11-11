// whatsapp.ui.SettingsWindow — a settings window in the shape of claude.ai's own: one large modal
// over the dimmed page, a rail on the inline-start (a search field, then the sections in labelled
// groups) and one content pane that scrolls by itself, with the close button at its top corner.
// Under 720 px it takes the whole screen and works in two steps — the list of sections, then one
// section with a back button — the way a phone's settings do.
//
// The window draws nothing inside a section. The host renders each one through `render(key,
// $pane)`; the content classes below (`whatsapp-kit-settings-window__h`, `whatsapp-kit-settings-window__row`, …) give it the same rows
// and headings Claude's settings use, so a host that wants that look only writes markup.
//
// Nothing here knows the host app: every colour is a token, every label goes through `__()`.

import ui from "../_core/index.js";
import { inline_icon_html } from "../_kit/icons.js";

const escape_html = (v) => ui.escape(v);

whatsapp.ui.SettingsWindow = class SettingsWindow {
	/**
	 * @param {Object} opts
	 * @param {string} opts.title — the window's accessible name ("Settings")
	 * @param {Array<{label?: string, items: Array<{key: string, label: string, icon?: string, keywords?: string}>}>} opts.groups
	 * @param {Function} opts.render — `(key, $pane, win) => Promise|void`; draws one section
	 * @param {string} [opts.active] — the section to open first; default the first one
	 * @param {string} [opts.cls] — extra class on the window (the host's palette scope)
	 * @param {Function} [opts.on_show] — `(key, win)` after a section is drawn
	 * @param {Function} [opts.on_close] — `(win)`
	 * @param {Array<{label: string, icon?: string, danger?: boolean, handler: Function}>} [opts.footer]
	 *   — actions pinned under the sections (Claude's \"Log out\"); `handler(win)`
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({ groups: [] }, opts);
		this.id = ui.unique_dom_id("whatsapp-kit-settings-window");
		this.items = [];
		(this.opts.groups || []).forEach((g) => (g.items || []).forEach((it) => this.items.push(it)));
		this.current = null;
		this.open = false;
		this.build_window_shell();
	}

	// ---- shell -----------------------------------------------------------------------------------

	build_window_shell() {
		const options = this.opts;
		this.$backdrop = $(`<div class="whatsapp-kit-settings-window-backdrop" hidden></div>`);
		this.$root = $(`
			<section class="whatsapp-kit whatsapp-kit-settings-window ${escape_html(options.cls || "")}" role="dialog" aria-modal="true" aria-label="${escape_html(options.title || __("Settings"))}" hidden>
				<aside class="whatsapp-kit-settings-window__rail">
					<label class="whatsapp-kit-settings-window__search">
						<span class="whatsapp-kit-settings-window__search-icon" aria-hidden="true">${inline_icon_html("search", "sm")}</span>
						<input type="search" data-whatsapp-bare autocomplete="off" placeholder="${escape_html(__("Search"))}" aria-label="${escape_html(__("Search settings"))}">
					</label>
					<nav class="whatsapp-kit-settings-window__nav" aria-label="${escape_html(options.title || __("Settings"))}"></nav>
					<p class="whatsapp-kit-settings-window__none" hidden>${escape_html(__("No setting matches"))}</p>
					<div class="whatsapp-kit-settings-window__foot" hidden></div>
				</aside>
				<div class="whatsapp-kit-settings-window__main">
					<div class="whatsapp-kit-settings-window__bar">
						<button type="button" class="whatsapp-kit-settings-window__back" aria-label="${escape_html(__("Back"))}">${inline_icon_html("caret", "sm")}<span class="whatsapp-kit-settings-window__back-label">${escape_html(options.title || __("Settings"))}</span></button>
						<button type="button" class="whatsapp-kit-settings-window__close" aria-label="${escape_html(__("Close"))}" title="${escape_html(__("Close (Esc)"))}">${inline_icon_html("x", "md")}</button>
					</div>
					<div class="whatsapp-kit-settings-window__pane" role="region" tabindex="-1"></div>
				</div>
			</section>`);
		this.$nav = this.$root.find(".whatsapp-kit-settings-window__nav");
		this.$pane = this.$root.find(".whatsapp-kit-settings-window__pane");
		this.$search = this.$root.find(".whatsapp-kit-settings-window__search input");
		this.draw_nav();

		this.$root.find(".whatsapp-kit-settings-window__close").on("click", () => this.hide());
		this.$root.find(".whatsapp-kit-settings-window__back").on("click", () => this.$root.removeClass("whatsapp-kit-settings-window--pane"));
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
				const $first = this.$nav.find(".whatsapp-kit-settings-window__item:visible").first();
				if ($first.length) this.show($first.data("key"));
			} else if (e.key === "ArrowDown") {
				e.preventDefault();
				this.$nav.find(".whatsapp-kit-settings-window__item:visible").first().trigger("focus");
			}
		});
		this.$nav.on("keydown", ".whatsapp-kit-settings-window__item", (e) => {
			const items = this.$nav.find(".whatsapp-kit-settings-window__item:visible").toArray();
			const idx = ui.roving_index(e, items, items.indexOf(e.currentTarget));
			if (idx < 0) return;
			e.preventDefault();
			items[idx].focus();
		});
	}

	draw_nav() {
		this.$nav.empty();
		(this.opts.groups || []).forEach((g) => {
			const $group = $(`<div class="whatsapp-kit-settings-window__group" role="group"></div>`).appendTo(this.$nav);
			if (g.label) {
				const gid = ui.unique_dom_id("whatsapp-kit-settings-window-g");
				$group.attr("aria-labelledby", gid).append(`<p class="whatsapp-kit-settings-window__group-label" id="${gid}">${escape_html(g.label)}</p>`);
			}
			(g.items || []).forEach((it) => {
				$(`<button type="button" class="whatsapp-kit-settings-window__item" data-key="${escape_html(it.key)}">
					<span class="whatsapp-kit-settings-window__item-icon" aria-hidden="true">${it.icon ? inline_icon_html(it.icon, "sm") : ""}</span>
					<span class="whatsapp-kit-settings-window__item-label">${escape_html(it.label)}</span>
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
		this.$nav.find(".whatsapp-kit-settings-window__group").each((_, group) => {
			let in_group = 0;
			$(group)
				.find(".whatsapp-kit-settings-window__item")
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
		this.$root.find(".whatsapp-kit-settings-window__none").prop("hidden", shown > 0);
	}

	// ---- sections --------------------------------------------------------------------------------

	/** Open one section: mark it in the rail and let the host draw it into the pane. */
	show(key) {
		const it = this.items.find((i) => i.key === key) || this.items[0];
		if (!it) return Promise.resolve();
		this.current = it.key;
		this.$nav
			.find(".whatsapp-kit-settings-window__item")
			.removeClass("is-on")
			.removeAttr("aria-current")
			.filter(`[data-key="${it.key}"]`)
			.addClass("is-on")
			.attr("aria-current", "page");
		this.$root.addClass("whatsapp-kit-settings-window--pane");
		this.$root.find(".whatsapp-kit-settings-window__back-label").text(it.label);
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
		$(document.body).addClass("whatsapp-kit-settings-window-open");
		window.requestAnimationFrame(() => this.$root.addClass("whatsapp-kit-settings-window--in"));
		this.untrap = ui.trap_focus(this.$root);
		const shown = this.show(first);
		// on a phone the window opens on the list when no section was asked for
		if (!key && window.matchMedia("(max-width: 719px)").matches) this.$root.removeClass("whatsapp-kit-settings-window--pane");
		// like Claude's: the caret waits in the search field (on a phone only on the list step)
		if (this.$search.is(":visible")) this.$search.trigger("focus");
		else this.$root.find(".whatsapp-kit-settings-window__close").trigger("focus");
		ui.announce(__("{0} opened.", [this.opts.title || __("Settings")]));
		return shown;
	}

	hide() {
		if (!this.open) return this;
		this.open = false;
		this.untrap && this.untrap();
		ui.overlay.close(this);
		this.$root.removeClass("whatsapp-kit-settings-window--in");
		window.setTimeout(() => {
			if (this.open) return;
			this.$root.prop("hidden", true).detach();
			this.$backdrop.prop("hidden", true).detach();
			if (!$(".whatsapp-kit-settings-window:not([hidden])").length) $(document.body).removeClass("whatsapp-kit-settings-window-open");
		}, 160);
		if (this.opener && document.contains(this.opener) && this.opener.focus) this.opener.focus();
		if (typeof this.opts.on_close === "function") this.opts.on_close(this);
		return this;
	}

	// ---- content helpers -------------------------------------------------------------------------

	/** The pane's title and the line under it. */
	static head_html(title, description) {
		return `<header class="whatsapp-kit-settings-window__head"><h2 class="whatsapp-kit-settings-window__title">${escape_html(title)}</h2>${
			description ? `<p class="whatsapp-kit-settings-window__desc">${escape_html(description)}</p>` : ""
		}</header>`;
	}

	/** A section heading inside the pane (Claude's "General", "Code appearance"). */
	static section_html(title, note) {
		return `<div class="whatsapp-kit-settings-window__h"><h3>${escape_html(title)}</h3>${note ? `<p>${escape_html(note)}</p>` : ""}</div>`;
	}

	/** One setting row: title and description on the start side, `control_html` on the end side. */
	static row_html(title, description, control_html = "") {
		return `<div class="whatsapp-kit-settings-window__row"><div class="whatsapp-kit-settings-window__row-text"><span class="whatsapp-kit-settings-window__row-title">${escape_html(
			title
		)}</span>${description ? `<span class="whatsapp-kit-settings-window__row-desc">${escape_html(description)}</span>` : ""}</div><div class="whatsapp-kit-settings-window__row-control">${control_html}</div></div>`;
	}
};

export default whatsapp.ui.SettingsWindow;

// whatsapp.ui.EmptyState — the one component for the four non-data states of any panel, list or
// page: `loading` (skeleton rows, never a spinner), `empty`, `error` (role=alert + retry) and
// `offline`. Every custom Page and drawer renders through it so the states look and behave alike.

import ui from "../_core/index.js";

const DEFAULTS = {
	loading: { icon: null, title: () => __("Loading…") },
	empty: { icon: "es-line-inbox", title: () => __("Nothing here yet") },
	error: { icon: "es-line-alert-circle", title: () => __("Something went wrong") },
	offline: { icon: "es-line-wifi-off", title: () => __("You are offline") },
};

whatsapp.ui.EmptyState = class EmptyState {
	/**
	 * @param {Object} opts
	 * @param {jQuery|HTMLElement} opts.wrapper
	 * @param {"loading"|"empty"|"error"|"offline"} [opts.state="empty"]
	 * @param {string} [opts.title]
	 * @param {string} [opts.description]
	 * @param {{label: string, on_click: Function, icon?: string, primary?: boolean}} [opts.action] (`onclick` alias accepted)
	 * @param {{label: string, on_click: Function}} [opts.secondary]
	 * @param {number} [opts.rows=3] skeleton rows for `loading`
	 * @param {"sm"|"md"} [opts.size="md"]
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({ state: "empty", rows: 3, size: "md" }, opts);
		this.$wrapper = $(this.opts.wrapper);
		this.render();
	}

	set_state(state, opts = {}) {
		Object.assign(this.opts, opts, { state });
		return this.render();
	}

	loading(opts) { return this.set_state("loading", opts); }
	empty(opts) { return this.set_state("empty", opts); }
	error(err, opts = {}) {
		const description = err && err.message ? err.message : opts.description;
		return this.set_state("error", Object.assign({}, opts, { description }));
	}
	offline(opts) { return this.set_state("offline", opts); }

	hide() {
		this.$wrapper.empty();
		return this;
	}

	render() {
		const { state } = this.opts;
		const base = DEFAULTS[state] || DEFAULTS.empty;
		const title = this.opts.title || base.title();
		if (state === "loading") {
			this.$wrapper.html(
				`<div class="whatsapp-kit-empty whatsapp-kit-empty--loading" role="status" aria-busy="true"><span class="whatsapp-kit-visually-hidden">${ui.escape(title)}</span>${ui.skeleton(this.opts.rows)}</div>`
			);
			return this;
		}
		const is_error = state === "error" || state === "offline";
		const $el = $(`
			<div class="whatsapp-kit-empty whatsapp-kit-empty--${state} whatsapp-kit-empty--${this.opts.size}" ${is_error ? 'role="alert"' : ""}>
				${base.icon ? `<div class="whatsapp-kit-empty__icon" aria-hidden="true">${ui.icon(base.icon, "lg")}</div>` : ""}
				<div class="whatsapp-kit-empty__title">${ui.escape(title)}</div>
				${this.opts.description ? `<div class="whatsapp-kit-empty__description">${ui.escape(this.opts.description)}</div>` : ""}
				<div class="whatsapp-kit-empty__actions"></div>
			</div>`);
		const $actions = $el.find(".whatsapp-kit-empty__actions");
		const action = this.opts.action;
		const click = action && (action.on_click || action.onclick);
		if (click) {
			$(`<button type="button" class="btn btn-sm ${action.primary === false ? "btn-default" : "btn-primary"}">${action.icon ? ui.icon(action.icon, "xs") + " " : ""}${ui.escape(action.label)}</button>`)
				.on("click", () => click())
				.appendTo($actions);
		}
		const secondary_click = this.opts.secondary && (this.opts.secondary.on_click || this.opts.secondary.onclick);
		if (secondary_click) {
			$(`<button type="button" class="btn btn-sm btn-default">${ui.escape(this.opts.secondary.label)}</button>`)
				.on("click", () => secondary_click())
				.appendTo($actions);
		}
		if (!$actions.children().length) $actions.remove();
		this.$wrapper.html($el);
		return this;
	}
};

export default whatsapp.ui.EmptyState;

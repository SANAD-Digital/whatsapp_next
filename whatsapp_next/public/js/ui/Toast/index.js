// sanad.ui.Toast — thin, consistent wrapper over `frappe.show_alert`: semantic tones, sensible
// auto-dismiss (3–7 s), optional action link. Desk's alert container is already a live region,
// so nothing is announced twice. Bottom-start on RTL is Desk's own
// placement (the alert container follows the document direction).

import ui from "../_core/index.js";

const INDICATOR = { success: "green", info: "blue", warning: "orange", error: "red" };
const DEFAULT_SECONDS = { success: 4, info: 5, warning: 6, error: 8 };

sanad.ui.Toast = class Toast {
	/**
	 * @param {Object|string} opts — a message string or `{ title, message, tone, seconds, action }`
	 * @param {string} [opts.tone="info"] — success | info | warning | error
	 * @param {number} [opts.seconds] — auto-dismiss; errors default to 8 s
	 * @param {{label: string, on_click: Function}} [opts.action] — one inline action link (`onclick` still accepted)
	 */
	constructor(opts) {
		this.opts = typeof opts === "string" ? { message: opts } : Object.assign({}, opts);
		this.opts.tone = this.opts.tone || "info";
		this.show();
	}

	show() {
		const { title, message, tone, action } = this.opts;
		const seconds = this.opts.seconds || DEFAULT_SECONDS[tone] || 5;
		const body = [title ? `<strong>${ui.escape(title)}</strong>` : "", message ? ui.escape(message) : ""]
			.filter(Boolean)
			.join("<br>");
		let html = body;
		if (action && (action.on_click || action.onclick)) {
			const id = ui.uid("toast-action");
			html += ` <a href="#" class="sanad-toast__action" data-id="${id}">${ui.escape(action.label)}</a>`;
			window.setTimeout(() => {
				$(`.sanad-toast__action[data-id="${id}"]`).on("click", (e) => {
					e.preventDefault();
					(action.on_click || action.onclick)();
				});
			}, 0);
		}
		// Desk's alert already carries role="alert" — no second live-region announcement.
		this.$alert = frappe.show_alert({ message: html, indicator: INDICATOR[tone] || "blue" }, seconds);
		return this;
	}

	static success(message, opts = {}) { return new Toast(Object.assign({ message, tone: "success" }, opts)); }
	static info(message, opts = {}) { return new Toast(Object.assign({ message, tone: "info" }, opts)); }
	static warning(message, opts = {}) { return new Toast(Object.assign({ message, tone: "warning" }, opts)); }
	static error(message, opts = {}) {
		const text = message && message.message ? message.message : message;
		return new Toast(Object.assign({ message: text, tone: "error" }, opts));
	}
	/** Show every warning code returned by an API (`warnings[]`) with a translated label. */
	static warnings(codes = [], labels = {}) {
		(codes || []).forEach((code) => Toast.warning(labels[code] || __(code)));
	}
};

export default sanad.ui.Toast;

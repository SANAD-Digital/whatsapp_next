// sanad.ui.StatusBadge — a status pill whose colour comes from the DocType's own indicator rules
// (`frappe.listview_settings[doctype].get_indicator`, workflow states, submittable docstatus) and
// falls back to gray. Colour is never the only signal: the label is always rendered, plus an
// optional dot / icon for the four semantic tones.

import ui from "../_core/index.js";

const TONE_ICON = { green: "es-line-success", red: "es-line-close-circle", amber: "es-line-alert-triangle" };

sanad.ui.StatusBadge = class StatusBadge {
	/**
	 * @param {Object} opts
	 * @param {jQuery|HTMLElement} [opts.wrapper] — where to render (omit to use `html()` only)
	 * @param {string} [opts.doctype] — resolves the colour through `frappe.get_indicator`
	 * @param {string} [opts.fieldname="status"] — the status field on `doc`
	 * @param {Object} [opts.doc] — the document (or `{status: value}`)
	 * @param {string} [opts.value] — shortcut for `{ [fieldname]: value }`
	 * @param {string} [opts.colour] — explicit Frappe colour (skips the meta lookup)
	 * @param {string} [opts.label] — explicit label (defaults to the translated value)
	 * @param {boolean} [opts.icon=true] — semantic icon for green / red / amber tones
	 * @param {"sm"|"md"} [opts.size="sm"]
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({ fieldname: "status", icon: true, size: "sm" }, opts);
		if (this.opts.wrapper) {
			this.$wrapper = $(this.opts.wrapper);
			this.refresh();
		}
	}

	resolve() {
		const { doctype, fieldname, colour, label } = this.opts;
		let doc = this.opts.doc;
		if (!doc && this.opts.value != null) doc = { [fieldname]: this.opts.value };
		doc = doc || {};
		const raw = doc[fieldname];
		let out = { label: label || (raw ? __(raw) : ""), colour: colour || "gray" };
		if (!colour && doctype) {
			const ind = ui.indicator_for(doctype, Object.assign({ doctype }, doc));
			out.colour = ind.colour;
			if (!label && ind.label) out.label = __(ind.label);
		}
		out.tone = ui.tone(out.colour);
		return out;
	}

	html() {
		return sanad.ui.StatusBadge.html(Object.assign({}, this.opts, this.resolve()));
	}

	refresh(doc) {
		if (doc) this.opts.doc = doc;
		if (this.$wrapper) this.$wrapper.html(this.html());
		return this;
	}

	/** Static renderer: `sanad.ui.StatusBadge.html({label, colour|tone, icon, size, title})`. */
	static html({ label = "", colour, tone, icon = true, size = "sm", title } = {}) {
		const t = tone || ui.tone(colour);
		const show_icon = icon && TONE_ICON[t];
		const icon_html = show_icon ? `<span class="sanad-badge__icon" aria-hidden="true">${ui.icon(TONE_ICON[t], "xs")}</span>` : `<span class="sanad-badge__dot" aria-hidden="true"></span>`;
		return `<span class="sanad-badge sanad-badge--${size} sanad-tone--${t}"${title ? ` title="${ui.escape(title)}"` : ""}>${icon_html}<span class="sanad-badge__label">${ui.escape(label)}</span></span>`;
	}
};

export default sanad.ui.StatusBadge;

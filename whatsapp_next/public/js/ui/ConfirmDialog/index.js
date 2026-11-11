// whatsapp.ui.ConfirmDialog — a confirmation that states the impact before the action runs:
// a list of `{label, value}` facts (counts supplied by the caller), an optional mandatory
// reason, an optional "I understand" acknowledgement, and a danger variant. Built on
// `frappe.ui.Dialog` (focus trap, Escape, backdrop) — the kit adds the impact layout and copy rules.

import ui from "../_core/index.js";

whatsapp.ui.ConfirmDialog = class ConfirmDialog {
	/**
	 * @param {Object} opts
	 * @param {string} opts.title
	 * @param {string} [opts.message] — one sentence under the title
	 * @param {Array<{label: string, value: string|number, tone?: string}>} [opts.impact]
	 * @param {boolean|{label?: string, required?: boolean}} [opts.reason_field] — free-text reason
	 * @param {string} [opts.ack_checkbox] — text of a mandatory acknowledgement checkbox
	 * @param {boolean} [opts.danger=false] — red primary button
	 * @param {string} [opts.confirm_label] — default "Confirm"
	 * @param {string} [opts.cancel_label] — default "Cancel"
	 * @param {Function} [opts.on_confirm] — `({reason}) => Promise|void`; a rejected promise keeps the dialog open
	 * @param {Function} [opts.on_cancel] — `({dismissed})`: true when closed with ×/Escape/backdrop
	 * @param {Function} [opts.load_impact] — `() => Promise<impact[]>` fetched after open (skeleton meanwhile)
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({ danger: false, impact: [] }, opts);
		this.build_dialog();
	}

	build_dialog() {
		const options = this.opts;
		const fields = [{ fieldtype: "HTML", fieldname: "impact" }];
		if (options.reason_field) {
			const rf = typeof options.reason_field === "object" ? options.reason_field : {};
			fields.push({
				fieldtype: "Small Text",
				fieldname: "reason",
				label: rf.label || __("Reason"),
				reqd: rf.required !== false ? 1 : 0,
				description: rf.description || __("Recorded in the audit log."),
			});
		}
		if (options.ack_checkbox) {
			fields.push({ fieldtype: "Check", fieldname: "ack", label: options.ack_checkbox });
		}
		this.dialog = new frappe.ui.Dialog({
			// a dialog title is HTML and callers put record names in it: text, always
			title: ui.escape(options.title),
			fields,
			size: options.size || "small",
			primary_action_label: options.confirm_label || __("Confirm"),
			secondary_action_label: options.cancel_label || __("Cancel"),
			secondary_action: () => this.cancel(),
			primary_action: (values) => this.confirm(values),
		});
		this.dialog.$wrapper.addClass("whatsapp-kit whatsapp-kit-confirm");
		const $btn = this.dialog.get_primary_btn();
		if (options.danger) $btn.removeClass("btn-primary").addClass("btn-danger");
		this.$impact = this.dialog.get_field("impact").$wrapper;
		this.render_impact(options.impact);
		if (options.ack_checkbox) {
			$btn.prop("disabled", true);
			this.dialog.fields_dict.ack.$input.on("change", (e) => $btn.prop("disabled", !e.target.checked));
		}
		this.dialog.$wrapper.on("hidden.bs.modal", () => {
			if (!this._resolved) this.cancel(true);
		});
	}

	render_impact(impact = []) {
		const options = this.opts;
		let html = options.message ? `<p class="whatsapp-kit-confirm__message">${ui.escape(options.message)}</p>` : "";
		if (impact && impact.length) {
			html += '<dl class="whatsapp-kit-confirm__impact">';
			impact.forEach((row) => {
				const tone = row.tone ? ` whatsapp-kit-tone--${ui.tone_for_colour(row.tone)}` : "";
				html += `<div class="whatsapp-kit-confirm__row"><dt>${ui.escape(row.label)}</dt><dd class="whatsapp-kit-tabular${tone}">${ui.escape(row.value)}</dd></div>`;
			});
			html += "</dl>";
		}
		this.$impact.html(html);
	}

	show() {
		this.dialog.show();
		if (this.opts.load_impact) {
			this.$impact.append(ui.skeleton(2, { lines: 1 }));
			Promise.resolve(this.opts.load_impact())
				.then((impact) => this.render_impact(impact))
				.catch((err) => this.$impact.append(`<div class="whatsapp-kit-confirm__error" role="alert">${ui.escape(err.message || err)}</div>`));
		}
		return new Promise((resolve, reject) => {
			this._resolve = resolve;
			this._reject = reject;
		});
	}

	confirm(values) {
		const $btn = this.dialog.get_primary_btn();
		const payload = { reason: values.reason || null };
		$btn.prop("disabled", true).addClass("disabled");
		Promise.resolve(this.opts.on_confirm ? this.opts.on_confirm(payload) : payload)
			.then((result) => {
				this._resolved = true;
				this.dialog.hide();
				this._resolve && this._resolve(result === undefined ? payload : result);
			})
			.catch((err) => {
				$btn.prop("disabled", false).removeClass("disabled");
				if (err && err.message) whatsapp.ui.Toast.error(err);
			});
	}

	cancel(silent = false) {
		if (this._resolved) return;
		this._resolved = true;
		if (!silent) this.dialog.hide();
		// `dismissed`: closed with ×, Escape or the backdrop rather than the cancel verb itself
		this.opts.on_cancel && this.opts.on_cancel({ dismissed: silent });
		this._reject && this._reject(new Error("cancelled"));
	}

	/** Promise-style shortcut: `await whatsapp.ui.ConfirmDialog.ask({...})` → `{reason}`; rejects on cancel. */
	static ask_for_confirmation(opts) {
		return new ConfirmDialog(opts).show();
	}
};

export default whatsapp.ui.ConfirmDialog;

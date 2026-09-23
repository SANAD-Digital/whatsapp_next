// sanad.ui.ConfirmDialog — a confirmation that states the impact before the action runs:
// a list of `{label, value}` facts (counts supplied by the caller), an optional mandatory
// reason, an optional "I understand" acknowledgement, and a danger variant. Built on
// `frappe.ui.Dialog` (focus trap, Escape, backdrop) — the kit adds the impact layout and copy rules.

import ui from "../_core/index.js";

sanad.ui.ConfirmDialog = class ConfirmDialog {
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
	 * @param {Function} [opts.on_cancel]
	 * @param {Function} [opts.load_impact] — `() => Promise<impact[]>` fetched after open (skeleton meanwhile)
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({ danger: false, impact: [] }, opts);
		this.make();
	}

	make() {
		const o = this.opts;
		const fields = [{ fieldtype: "HTML", fieldname: "impact" }];
		if (o.reason_field) {
			const rf = typeof o.reason_field === "object" ? o.reason_field : {};
			fields.push({
				fieldtype: "Small Text",
				fieldname: "reason",
				label: rf.label || __("Reason"),
				reqd: rf.required !== false ? 1 : 0,
				description: rf.description || __("Recorded in the audit log."),
			});
		}
		if (o.ack_checkbox) {
			fields.push({ fieldtype: "Check", fieldname: "ack", label: o.ack_checkbox });
		}
		this.dialog = new frappe.ui.Dialog({
			title: o.title,
			fields,
			size: o.size || "small",
			primary_action_label: o.confirm_label || __("Confirm"),
			secondary_action_label: o.cancel_label || __("Cancel"),
			secondary_action: () => this.cancel(),
			primary_action: (values) => this.confirm(values),
		});
		this.dialog.$wrapper.addClass("sanad-kit sanad-confirm");
		const $btn = this.dialog.get_primary_btn();
		if (o.danger) $btn.removeClass("btn-primary").addClass("btn-danger");
		this.$impact = this.dialog.get_field("impact").$wrapper;
		this.render_impact(o.impact);
		if (o.ack_checkbox) {
			$btn.prop("disabled", true);
			this.dialog.fields_dict.ack.$input.on("change", (e) => $btn.prop("disabled", !e.target.checked));
		}
		this.dialog.$wrapper.on("hidden.bs.modal", () => {
			if (!this._resolved) this.cancel(true);
		});
	}

	render_impact(impact = []) {
		const o = this.opts;
		let html = o.message ? `<p class="sanad-confirm__message">${ui.escape(o.message)}</p>` : "";
		if (impact && impact.length) {
			html += '<dl class="sanad-confirm__impact">';
			impact.forEach((row) => {
				const tone = row.tone ? ` sanad-tone--${ui.tone(row.tone)}` : "";
				html += `<div class="sanad-confirm__row"><dt>${ui.escape(row.label)}</dt><dd class="sanad-tabular${tone}">${ui.escape(row.value)}</dd></div>`;
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
				.catch((err) => this.$impact.append(`<div class="sanad-confirm__error" role="alert">${ui.escape(err.message || err)}</div>`));
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
				if (err && err.message) sanad.ui.Toast.error(err);
			});
	}

	cancel(silent = false) {
		if (this._resolved) return;
		this._resolved = true;
		if (!silent) this.dialog.hide();
		this.opts.on_cancel && this.opts.on_cancel();
		this._reject && this._reject(new Error("cancelled"));
	}

	/** Promise-style shortcut: `await sanad.ui.ConfirmDialog.ask({...})` → `{reason}`; rejects on cancel. */
	static ask(opts) {
		return new ConfirmDialog(opts).show();
	}
};

export default sanad.ui.ConfirmDialog;

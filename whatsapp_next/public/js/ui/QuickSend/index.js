// sanad.ui.QuickSend — the one-message composer as a `frappe.ui.Dialog`: recipient (resolved
// server-side, with known / blacklisted badges), device (default from settings), optional
// template with a live preview over the reference document, text / document / image body,
// private attachment, optional schedule, and an "Open in Simulator" footer link. Data through the
// configured `quick_send.*` keys; validation errors are placed next to the field; `send` warnings
// (`device_offline`, `queue_paused`) become toasts, never blockers.

import ui from "../_core/index.js";

const MESSAGE_TYPES = ["Text", "Document", "Image"];

sanad.ui.QuickSend = class QuickSend {
	/**
	 * @param {Object} opts — every key optional; a phone / contact / number / jid pre-fills the recipient
	 * @param {string} [opts.phone]
	 * @param {string} [opts.contact]
	 * @param {string} [opts.number] — a WhatsApp Number row
	 * @param {string} [opts.jid] — group JID
	 * @param {string} [opts.reference_doctype]
	 * @param {string} [opts.reference_name]
	 * @param {string} [opts.device]
	 * @param {string} [opts.template]
	 * @param {string} [opts.body]
	 * @param {Function} [opts.on_sent] — `(result) => void` with `{outbound, queue_item, warnings[]}`
	 * @param {{get_context?: string, preview?: string, send?: string}} [opts.api] — key overrides
	 * @param {string} [opts.simulator_route] — default `sanad.ui.config.defaults.simulator_route`
	 * @param {string} [opts.title]
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({}, opts);
		this.api = Object.assign({ get_context: "quick_send.get_context", preview: "quick_send.preview", send: "quick_send.send" }, opts.api || {});
		this.context = null;
		this.recipient = null;
		this.make();
		this.dialog.show();
		this.load();
	}

	// ---- dialog ----------------------------------------------------------------------------

	make() {
		const o = this.opts;
		const has_recipient = !!(o.phone || o.contact || o.number || o.jid);
		const fields = [
			{ fieldtype: "HTML", fieldname: "recipient", label: __("Recipient") },
			{ fieldtype: "Data", fieldname: "phone", label: __("Phone"), reqd: has_recipient ? 0 : 1, hidden: has_recipient ? 1 : 0 },
			{ fieldtype: "Select", fieldname: "device", label: __("Device"), reqd: 1, options: [] },
			{ fieldtype: "Select", fieldname: "template", label: __("Template"), options: [] },
			{ fieldtype: "Column Break", fieldname: "col_1" },
			{ fieldtype: "Select", fieldname: "message_type", label: __("Message type"), reqd: 1, options: MESSAGE_TYPES.map((t) => ({ value: t, label: __(t) })), default: "Text" },
			{ fieldtype: "Datetime", fieldname: "scheduled_at", label: __("Schedule (optional)"), description: __("Leave empty to send now.") },
			{ fieldtype: "Section Break", fieldname: "sec_body" },
			{ fieldtype: "Small Text", fieldname: "body", label: __("Message"), reqd: 1 },
			{ fieldtype: "HTML", fieldname: "preview" },
			{ fieldtype: "Section Break", fieldname: "sec_attachment", depends_on: 'eval:doc.message_type && doc.message_type !== "Text"' },
			{ fieldtype: "Attach", fieldname: "attachment", label: __("Attachment"), depends_on: 'eval:doc.message_type && doc.message_type !== "Text"', options: { make_attachments_public: false, allow_multiple: false, allow_toggle_private: false } },
			{ fieldtype: "Data", fieldname: "caption", label: __("Caption"), depends_on: 'eval:doc.message_type && doc.message_type !== "Text"' },
		];
		this.dialog = new frappe.ui.Dialog({
			title: o.title || __("Send message"),
			fields,
			size: "large",
			primary_action_label: __("Send"),
			primary_action: () => this.send(),
			on_hide: () => this.opts.on_close && this.opts.on_close(),
		});
		this.dialog.$wrapper.addClass("sanad-kit sanad-sheet sanad-quicksend");
		this.$recipient = this.dialog.get_field("recipient").$wrapper;
		this.$preview = this.dialog.get_field("preview").$wrapper;
		this.$recipient.html(`<div class="sanad-quicksend__recipient">${ui.skeleton(1, { lines: 1 })}</div>`);
		// footer: Open in Simulator
		const route = o.simulator_route || (ui.config.defaults || {}).simulator_route;
		if (route) {
			this.dialog.add_custom_action(__("Open in the simulator"), () => {
				const args = {};
				const key = this.recipient && (this.recipient.phone_e164 || this.recipient.jid);
				if (key) args.phone = key;
				this.dialog.hide();
				frappe.set_route(route, args);
			}, "btn-default sanad-quicksend__simulator");
		}
		// live preview when a template or a reference is involved
		const preview = ui.debounce(() => this.preview(), 400);
		this.dialog.fields_dict.template.$input.on("change", () => {
			this.on_template_change();
			preview();
		});
		this.dialog.fields_dict.body.$input.on("input", () => {
			this.clear_error("body");
			if (this.opts.reference_doctype) preview();
		});
		this.dialog.fields_dict.message_type.$input.on("change", () => this.clear_error("attachment"));
		if (!has_recipient) {
			// country hint + loose E.164 normalisation; the example number is never hard-coded here
			if (typeof sanad.ui.PhoneField === "function") {
				this.phone_field = new sanad.ui.PhoneField({ control: this.dialog.fields_dict.phone });
			}
			this.dialog.fields_dict.phone.$input.on("blur", () => this.resolve_phone());
		}
		if (o.body) this.dialog.set_value("body", o.body);
		if (o.device) this.dialog.set_value("device", o.device);
	}

	// ---- context ---------------------------------------------------------------------------

	load() {
		const o = this.opts;
		const args = {};
		["phone", "contact", "number", "reference_doctype", "reference_name"].forEach((k) => o[k] && (args[k] = o[k]));
		if (o.jid && !args.phone) args.phone = o.jid;
		return ui.call(this.api.get_context, args)
			.then((ctx) => {
				this.context = ctx || {};
				this.fill_options();
				this.set_recipient(this.context.recipient);
				if (o.template) {
					this.dialog.set_value("template", o.template);
					this.on_template_change();
					this.preview();
				} else if (o.reference_doctype && o.reference_name) {
					this.preview();
				}
			})
			.catch((err) => {
				if (err.exc_type === "WAInvalidPhoneError" && !this.dialog.fields_dict.phone.df.hidden) {
					this.set_error("phone", err.message);
				} else {
					this.$recipient.empty();
					new sanad.ui.EmptyState({ wrapper: this.$recipient, state: "error", description: err.message, size: "sm", action: { label: __("Retry"), onclick: () => this.load() } });
				}
			});
	}

	fill_options() {
		const ctx = this.context;
		const devices = (ctx.devices || []).map((d) => ({
			value: d.name,
			label: d.status === "Connected" ? d.device_name || d.name : __("{0} ({1})", [d.device_name || d.name, __(d.status || "Unknown")]),
		}));
		this.dialog.fields_dict.device.df.options = devices;
		this.dialog.fields_dict.device.refresh();
		const current_device = this.opts.device || ctx.default_device || (devices[0] && devices[0].value);
		if (current_device) this.dialog.set_value("device", current_device);
		if (!devices.length) {
			this.set_error("device", __("No device is enabled. Pair or enable a device, then try again."), { focus: true });
			const route = (ui.config.defaults || {}).devices_route;
			if (route) {
				$(`<button type="button" class="btn btn-xs btn-default sanad-quicksend__fix">${ui.escape(__("Open devices"))}</button>`)
					.on("click", () => {
						this.dialog.hide();
						frappe.set_route(route);
					})
					.appendTo(this.dialog.get_field("device").$wrapper.find(".sanad-quicksend__error"));
			}
		}
		const templates = [{ value: "", label: __("No template (write the message)") }].concat(
			(ctx.templates || []).map((t) => ({ value: t.name, label: t.template_name || t.name }))
		);
		this.dialog.fields_dict.template.df.options = templates;
		this.dialog.fields_dict.template.refresh();
		if (ctx.policy && ctx.policy.send_only_to_known_numbers) {
			this.dialog.fields_dict.phone.set_description(__("Only numbers with an existing conversation can be messaged."));
		}
	}

	/** Render the recipient line: name, phone, known / blacklisted badges. */
	set_recipient(recipient) {
		this.recipient = recipient || null;
		if (!recipient) {
			this.$recipient.html(`<div class="sanad-quicksend__recipient sanad-quicksend__recipient--empty">${ui.escape(__("Enter a phone number to look up the recipient."))}</div>`);
			return;
		}
		const key = recipient.phone_e164 || recipient.jid || "";
		const badges = [];
		if (recipient.blacklisted) badges.push(sanad.ui.StatusBadge.html({ label: __("Blacklisted"), colour: "red" }));
		else if (recipient.known) badges.push(sanad.ui.StatusBadge.html({ label: __("Known number"), colour: "green" }));
		else badges.push(sanad.ui.StatusBadge.html({ label: __("New number"), colour: "gray" }));
		if (recipient.jid) badges.push(sanad.ui.StatusBadge.html({ label: __("Group"), colour: "blue" }));
		this.$recipient.html(`
			<div class="sanad-quicksend__recipient">
				<span class="sanad-quicksend__avatar" aria-hidden="true">${ui.icon(recipient.jid ? "es-line-people" : "es-line-customer", "md")}</span>
				<span class="sanad-quicksend__who">
					<span class="sanad-quicksend__name">${ui.escape(recipient.display_name || key)}</span>
					${recipient.display_name ? `<span class="sanad-quicksend__phone sanad-tabular">${ui.escape(key)}</span>` : ""}
				</span>
				<span class="sanad-quicksend__badges">${badges.join(" ")}</span>
			</div>`);
		if (recipient.blacklisted) {
			this.$recipient.append(`<div class="sanad-quicksend__error" role="alert">${ui.escape(__("This number is blacklisted, so the message cannot be sent."))}</div>`);
		}
		this.dialog.get_primary_btn().prop("disabled", !!recipient.blacklisted);
	}

	resolve_phone() {
		const raw = (this.dialog.get_value("phone") || "").trim();
		if (!raw) return;
		// prefer the client-side E.164 guess; the server's normaliser stays authoritative
		const guess = this.phone_field ? this.phone_field.get_value() : null;
		const phone = guess && guess.phone_e164 ? guess.phone_e164 : raw;
		this.clear_error("phone");
		return ui.call(this.api.get_context, { phone, reference_doctype: this.opts.reference_doctype, reference_name: this.opts.reference_name }, { silent: true })
			.then((ctx) => {
				this.opts.phone = phone;
				this.context = Object.assign(this.context || {}, ctx || {});
				this.set_recipient(this.context.recipient);
			})
			.catch((err) => {
				this.set_recipient(null);
				this.set_error("phone", err.message);
			});
	}

	// ---- template / preview ----------------------------------------------------------------

	on_template_change() {
		const template = this.dialog.get_value("template");
		const body = this.dialog.fields_dict.body;
		if (template) {
			const t = (this.context && this.context.templates || []).find((x) => x.name === template);
			if (t && t.message_type && MESSAGE_TYPES.includes(t.message_type)) this.dialog.set_value("message_type", t.message_type);
			body.df.reqd = 0;
			body.df.description = __("The template text is sent. Leave this empty, or type to replace it.");
		} else {
			body.df.reqd = 1;
			body.df.description = "";
			this.$preview.empty();
		}
		body.refresh();
	}

	preview() {
		const template = this.dialog.get_value("template");
		const body = this.dialog.get_value("body");
		const { reference_doctype, reference_name } = this.opts;
		if (!template && !(reference_doctype && body)) {
			this.$preview.empty();
			return;
		}
		this.$preview.html(`<div class="sanad-quicksend__preview" aria-busy="true"><div class="sanad-quicksend__preview-label">${ui.escape(__("Preview"))}</div>${ui.skeleton(1, { lines: 2 })}</div>`);
		return ui.call(this.api.preview, { template, body, reference_doctype, reference_name }, { silent: true })
			.then((r) => {
				const errors = (r && r.errors) || [];
				this.$preview.html(`
					<div class="sanad-quicksend__preview">
						<div class="sanad-quicksend__preview-label">${ui.escape(__("Preview"))}</div>
						<div class="sanad-quicksend__bubble">${ui.escape((r && r.body) || "")}</div>
						${errors.length ? `<div class="sanad-quicksend__error" role="alert">${errors.map((e) => ui.escape(e)).join("<br>")}</div>` : ""}
					</div>`);
			})
			.catch((err) => {
				this.$preview.html(`<div class="sanad-quicksend__error" role="alert">${ui.escape(err.message)}</div>`);
			});
	}

	// ---- validation ------------------------------------------------------------------------

	/** Inline error next to the field (`role="alert"`, `aria-describedby`); focus only when asked. */
	set_error(fieldname, message, { focus = true } = {}) {
		const field = this.dialog.get_field(fieldname);
		if (!field) return sanad.ui.Toast.error(message);
		this.clear_error(fieldname);
		const id = `${ui.uid("qs-err")}`;
		field.$wrapper.addClass("sanad-quicksend__field--invalid");
		field.$wrapper.append(`<div class="sanad-quicksend__error" id="${id}" role="alert">${ui.escape(message)}</div>`);
		field.$input && field.$input.attr("aria-invalid", "true").attr("aria-describedby", [field.$input.attr("aria-describedby"), id].filter(Boolean).join(" "));
		if (focus && field.set_focus) field.set_focus();
	}

	clear_error(fieldname) {
		const field = this.dialog.get_field(fieldname);
		if (!field) return;
		const $err = field.$wrapper.find(".sanad-quicksend__error");
		const ids = $err.map((i, el) => el.id).get();
		$err.remove();
		field.$wrapper.removeClass("sanad-quicksend__field--invalid");
		if (field.$input) {
			field.$input.removeAttr("aria-invalid");
			const rest = (field.$input.attr("aria-describedby") || "").split(" ").filter((x) => x && !ids.includes(x));
			if (rest.length) field.$input.attr("aria-describedby", rest.join(" "));
			else field.$input.removeAttr("aria-describedby");
		}
	}

	validate(values) {
		const errors = [];
		["phone", "device", "body", "attachment"].forEach((f) => this.clear_error(f));
		if (!this.recipient && !values.phone) errors.push(["phone", __("Enter the recipient's phone number.")]);
		if (!values.device) errors.push(["device", __("Choose the device that sends the message.")]);
		if (!values.template && !(values.body || "").trim()) errors.push(["body", __("Write a message or pick a template.")]);
		if (values.message_type !== "Text" && !values.attachment) errors.push(["attachment", __("Attach a file for a {0} message.", [__(values.message_type)])]);
		// every error is shown inline; only the first invalid field takes focus
		errors.forEach(([f, msg], i) => this.set_error(f, msg, { focus: i === 0 }));
		return !errors.length;
	}

	// ---- send ------------------------------------------------------------------------------

	send() {
		const values = this.dialog.get_values(true) || {};
		if (!this.validate(values)) return;
		const o = this.opts;
		const args = {
			device: values.device,
			message_type: values.message_type || "Text",
			body: values.body || null,
			template: values.template || null,
			attachment: values.attachment || null,
			caption: values.caption || null,
			scheduled_at: values.scheduled_at || null,
			reference_doctype: o.reference_doctype || null,
			reference_name: o.reference_name || null,
		};
		if (this.recipient && this.recipient.jid) args.jid = this.recipient.jid;
		else args.phone = (this.recipient && this.recipient.phone_e164) || values.phone || o.phone;
		if (o.contact || (this.recipient && this.recipient.contact)) args.contact = o.contact || this.recipient.contact;
		const $btn = this.dialog.get_primary_btn();
		$btn.prop("disabled", true);
		return ui.call(this.api.send, args, { silent: true })
			.then((r) => {
				this.dialog.hide();
				sanad.ui.Toast.warnings((r && r.warnings) || [], {
					device_offline: __("The device is offline; the message stays queued until it reconnects."),
					queue_paused: __("The queue is paused; the message is sent after it resumes."),
				});
				sanad.ui.Toast.success(args.scheduled_at ? __("Message scheduled") : __("Message queued"));
				typeof o.on_sent === "function" && o.on_sent(r);
			})
			.catch((err) => {
				$btn.prop("disabled", false);
				const t = err.exc_type || "";
				if (t === "WAInvalidPhoneError" || t === "WABlacklistedError" || t === "WAUnknownNumberPolicyError") {
					if (this.dialog.fields_dict.phone.df.hidden) {
						this.$recipient.find(".sanad-quicksend__error").remove();
						this.$recipient.append(`<div class="sanad-quicksend__error" role="alert">${ui.escape(err.message)}</div>`);
					} else this.set_error("phone", err.message);
				} else if (t === "WAFileError") {
					this.set_error("attachment", err.message);
				} else if (t === "WAValidationError") {
					this.set_error("body", err.message);
				} else {
					sanad.ui.Toast.error(err);
				}
			});
	}

	hide() {
		this.dialog.hide();
	}

	/** Shortcut: `sanad.ui.QuickSend.open({phone})`. */
	static open(opts) {
		return new QuickSend(opts);
	}
};

export default sanad.ui.QuickSend;

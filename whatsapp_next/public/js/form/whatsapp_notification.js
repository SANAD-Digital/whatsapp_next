// WhatsApp Notification form (09 row 10b, D-016): the field choices that depend on the chosen
// DocType — the date / datetime / value-change fields of the trigger, the field set after a send,
// and each recipient row's document field — are Selects with no options in the meta, filled here
// from `notifications.get_document_fields` (the server skips option validation for an empty
// Select, as Frappe's own Notification does). Preview and Send now run against one document.

frappe.ui.form.on("WhatsApp Notification", {
	setup(frm) {
		frm._wa_fields = null;
	},

	refresh(frm) {
		load_field_choices(frm);
		if (frm.is_new() || !frappe.user.has_role(["WhatsApp Manager", "System Manager"])) return;
		frm.add_custom_button(__("Preview"), () => pick_document(frm, __("Preview for a document"), __("Preview")).then((ref) => ref && preview(frm, ref)));
		frm.add_custom_button(__("Send now"), () => pick_document(frm, __("Send for a document"), __("Continue")).then((ref) => ref && send_now(frm, ref)));
	},

	document_type(frm) {
		frm._wa_fields = null;
		["date_changed", "datetime_changed", "value_changed", "set_property_after_alert"].forEach((f) => frm.set_value(f, ""));
		(frm.doc.recipients || []).forEach((row) => {
			frappe.model.set_value(row.doctype, row.name, "receiver_by_document_field", "");
			frappe.model.set_value(row.doctype, row.name, "linked_document_field", "");
		});
		load_field_choices(frm);
	},
});

/** `{value, label}` options with an empty first choice; a saved value outside the list is kept. */
function options_of(rows, current) {
	const out = [{ value: "", label: "" }].concat((rows || []).map((r) => ({ value: r.fieldname, label: `${__(r.label)} (${r.fieldname})` })));
	if (current && !out.some((o) => o.value === current)) out.push({ value: current, label: current });
	return out;
}

function load_field_choices(frm) {
	const dt = frm.doc.document_type;
	if (!dt) return;
	const apply = (f) => {
		frm.set_df_property("date_changed", "options", options_of(f.date_fields, frm.doc.date_changed));
		frm.set_df_property("datetime_changed", "options", options_of(f.datetime_fields, frm.doc.datetime_changed));
		frm.set_df_property("value_changed", "options", options_of(f.all_fields, frm.doc.value_changed));
		frm.set_df_property("set_property_after_alert", "options", options_of(f.all_fields, frm.doc.set_property_after_alert));
		const grid = frm.fields_dict.recipients && frm.fields_dict.recipients.grid;
		if (grid) {
			// A phone field, or a Link to Contact (its primary mobile is used).
			const receivers = (f.phone_fields || []).concat((f.link_fields || []).filter((r) => r.options === "Contact"));
			grid.update_docfield_property("receiver_by_document_field", "options", options_of(receivers));
			grid.update_docfield_property("linked_document_field", "options", options_of(f.link_fields));
			grid.update_docfield_property("linked_document_field", "description", __("A Link field of {0}; the number is read from the linked document.", [__(dt)]));
			grid.refresh();
		}
	};
	if (frm._wa_fields && frm._wa_fields.dt === dt) return apply(frm._wa_fields.data);
	sanad.ui
		.call("notifications.get_document_fields", { document_type: dt })
		.then((data) => {
			frm._wa_fields = { dt, data };
			apply(data);
		})
		.catch((err) => sanad.ui.Toast.error(err));
}

/** Ask for one document of the notification's DocType; resolves its name, or null when closed. */
function pick_document(frm, title, label) {
	return new Promise((resolve) => {
		if (!frm.doc.document_type) {
			sanad.ui.Toast.info(__("Choose the document type first."));
			return resolve(null);
		}
		let done = false;
		const d = new frappe.ui.Dialog({
			title,
			fields: [{ fieldname: "reference_name", fieldtype: "Link", options: frm.doc.document_type, label: __(frm.doc.document_type), reqd: 1 }],
			primary_action_label: label,
			primary_action(values) {
				done = true;
				d.hide();
				resolve(values.reference_name);
			},
			on_hide: () => done || resolve(null),
		});
		d.$wrapper.addClass("sanad-kit");
		d.show();
	});
}

function preview(frm, reference_name) {
	sanad.ui
		.call("notifications.preview", { name: frm.doc.name, reference_name }, { freeze: true })
		.then((r) => {
			const esc = sanad.ui.escape;
			const recipients = (r.recipients || []).map((x) => `<li><bdi dir="ltr">${esc(x.phone_e164)}</bdi> <span class="text-muted">· ${esc(__(x.source || ""))}</span></li>`).join("");
			const errors = (r.errors || []).map((e) => `<li>${esc(e)}</li>`).join("");
			const d = new frappe.ui.Dialog({
				title: __("Preview: {0}", [reference_name]),
				size: "large",
				fields: [
					{
						fieldtype: "HTML",
						fieldname: "body",
						options: `
							<p class="${r.meets_condition ? "text-success" : "text-warning"}">${esc(r.meets_condition ? __("The condition is met: this document would be sent.") : __("The condition is not met: nothing would be sent."))}</p>
							<h6>${esc(__("Message"))}</h6>
							<div class="wa-notification-preview" dir="auto" style="white-space: pre-wrap">${esc(r.message || "")}</div>
							<h6>${esc(__("Recipients"))}</h6>
							${recipients ? `<ul>${recipients}</ul>` : `<p class="text-muted">${esc(__("No recipient resolved."))}</p>`}
							${errors ? `<h6>${esc(__("Errors"))}</h6><ul class="text-danger">${errors}</ul>` : ""}`,
					},
				],
			});
			d.$wrapper.addClass("sanad-kit");
			d.show();
		})
		.catch((err) => sanad.ui.Toast.error(err));
}

function send_now(frm, reference_name) {
	sanad.ui.ConfirmDialog.ask({
		title: __("Send {0} now?", [frm.doc.notification_name || frm.doc.name]),
		message: __("The condition is checked again; one message per recipient is queued."),
		impact: [{ label: __(frm.doc.document_type), value: reference_name }],
		confirm_label: __("Send now"),
		on_confirm: () => sanad.ui.call("notifications.send_now", { name: frm.doc.name, reference_name }),
	})
		.then((r) => {
			if (r && r.error) sanad.ui.Toast.error(r.error);
			else if (r && r.sent) sanad.ui.Toast.success(sanad.ui.plural(r.sent, { one: __("{0} message queued"), other: __("{0} messages queued") }));
			else sanad.ui.Toast.info(__("Nothing was sent: the condition is not met or no recipient was found."));
			frm.reload_doc();
		})
		.catch(() => {});
}

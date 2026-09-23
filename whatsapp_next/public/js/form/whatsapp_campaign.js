// WhatsApp Campaign form (09 row 6): the recipients child table becomes a PagedChildTable fed by
// `campaigns.get_recipients_page` with ContactPicker add / remove; lifecycle buttons by status
// (Start / Schedule / Unschedule / Pause / Resume / Cancel through ConfirmDialog); a progress
// strip from `campaigns.get_progress` refreshed on `wa:campaign:status` for this campaign; and
// "Preview message" per messages row. Terminal campaigns are read-only.

const TERMINAL = ["Completed", "Partially Failed", "Cancelled"];
const EDITABLE = ["Draft", "Scheduled"];
const fmt_int = (v) => sanad.ui.format_int(v);

// The one status → colour source for recipient rows; PagedChildTable and the ContactPicker read it
// through `sanad.ui.indicator_for`.
frappe.listview_settings["WhatsApp Campaign Recipient"] = {
	get_indicator(doc) {
		const colour = { Pending: "gray", Queued: "blue", Sent: "green", Delivered: "green", Read: "green", Failed: "red", Cancelled: "red", Removed: "gray" }[doc.status] || "gray";
		return [__(doc.status), colour, `status,=,${doc.status}`];
	},
};

function is_manager() {
	return frappe.user.has_role("WhatsApp Manager") || frappe.user.has_role("System Manager");
}

function can_change_recipients(frm) {
	return !frm.is_new() && !frm.is_dirty() && !TERMINAL.includes(frm.doc.status) && frappe.perm.has_perm(frm.doctype, 0, "write", frm.doc);
}

function open_picker(frm, operation, preselect) {
	new sanad.ui.ContactPicker({
		target_doctype: frm.doctype,
		target_name: frm.doc.name,
		operation,
		preselect,
		target_label: frm.doc.campaign_name || frm.doc.name,
		on_commit: () => frm.reload_doc(),
	});
}

function mount_recipients(frm) {
	// Shown as visible text next to the buttons when they are disabled (never only a hover title).
	const hint = frm.is_new() || frm.is_dirty() ? __("Save the campaign to add or remove recipients.") : TERMINAL.includes(frm.doc.status) ? __("The campaign has ended, so recipients can no longer change.") : undefined;
	const toolbar_actions = [
		{ label: __("Add recipients"), primary: true, icon: "es-line-add", condition: () => !TERMINAL.includes(frm.doc.status) && is_manager(), disabled: !can_change_recipients(frm), hint, handler: () => open_picker(frm, "add") },
		{ label: __("Remove recipients"), icon: "es-line-delete", condition: () => !TERMINAL.includes(frm.doc.status) && is_manager() && cint(frm.doc.total_recipients) > 0, disabled: !can_change_recipients(frm), hint, handler: () => open_picker(frm, "remove") },
	];
	if (frm.sanad_recipients && frm.sanad_recipients.frm === frm && frm.$wrapper.find('.sanad-pct[data-fieldname="recipients"]').length) {
		frm.sanad_recipients.update({ toolbar_actions });
		return;
	}
	frm.sanad_recipients = new sanad.ui.PagedChildTable({
		frm,
		fieldname: "recipients",
		page_method: "campaigns.get_recipients_page",
		page_length: 50,
		columns: [{ fieldname: "display_name" }, { fieldname: "phone_e164" }, { fieldname: "source_type" }, { fieldname: "status" }, { fieldname: "contact" }],
		filters: [{ fieldname: "status", type: "select" }, { fieldname: "source_type", type: "select" }],
		status_field: "status",
		row_actions: [
			{ label: __("Sent message"), icon: "es-line-link", condition: (row) => !!row.outbound_message, handler: (row) => frappe.set_route("Form", "WhatsApp Log", row.outbound_message) },
			{ label: __("Open contact"), icon: "es-line-people", condition: (row) => !!row.contact, handler: (row) => frappe.set_route("Form", "Contact", row.contact) },
		],
		toolbar_actions,
		empty_text: __("No recipients yet"),
	});
}

function render_progress(frm, p) {
	if (!frm.sanad_progress || !p) return;
	const esc = sanad.ui.escape;
	const c = p.counters || {};
	const r = p.rates || {};
	const percent = Math.min(100, Math.max(0, flt(r.percent)));
	const eta = cint(r.eta_seconds);
	const eta_text = eta ? (eta >= 3600 ? __("About {0} h left", [Math.round(eta / 360) / 10]) : __("About {0} min left", [Math.max(1, Math.round(eta / 60))])) : "";
	const cells = [
		[__("Total"), c.total],
		[__("Queued"), c.queued],
		[__("Sent"), c.sent],
		[__("Delivered"), c.delivered],
		[__("Read"), c.read],
		[__("Failed"), c.failed],
		[__("Cancelled"), c.cancelled],
	];
	const meta = [
		__("{0} done", [frappe.format(percent, { fieldtype: "Percent" }, { inline: true })]),
		__("{0} messages per minute", [fmt_int(r.messages_per_minute)]),
		__("{0} sent in the last minute", [fmt_int(r.sent_last_minute)]),
	].concat(eta_text ? [eta_text] : []);
	frm.sanad_progress.html(`
		<div class="progress" style="height: var(--sanad-gap-sm); margin-block-end: var(--sanad-gap-sm);">
			<div class="progress-bar" role="progressbar" style="width:${percent}%" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-label="${esc(__("Campaign progress"))}"></div>
		</div>
		<div class="text-muted small sanad-tabular">${meta.map(esc).join(" · ")}</div>
		<div style="display:flex; flex-wrap:wrap; gap: var(--sanad-gap-lg); margin-block-start: var(--sanad-gap-sm);">${cells
			.map(([label, value]) => `<div><div class="text-muted small">${esc(label)}</div><div class="sanad-tabular" style="font-weight:600">${fmt_int(value)}</div></div>`)
			.join("")}</div>`);
}

function load_progress(frm) {
	if (frm.is_new() || !frm.sanad_progress) return;
	sanad.ui
		.call("campaigns.get_progress", { name: frm.doc.name }, { silent: true })
		.then((p) => render_progress(frm, p))
		.catch((err) => new sanad.ui.EmptyState({ wrapper: frm.sanad_progress, state: "error", size: "sm", description: err.message, action: { label: __("Retry"), onclick: () => load_progress(frm) } }));
}

function mount_progress(frm) {
	const attached = frm.sanad_progress && frm.sanad_progress.closest("body").length;
	if (frm.is_new() || frm.doc.status === "Draft") {
		if (attached) frm.sanad_progress.closest(".form-dashboard-section").remove();
		frm.sanad_progress = null;
		return;
	}
	if (!attached) {
		// css_class "custom": the dashboard removes it on every reset, so it is re-added per refresh.
		frm.sanad_progress = frm.dashboard.add_section(sanad.ui.skeleton(1, { lines: 2 }), __("Progress"), "custom");
	}
	load_progress(frm);
}

function subscribe(frm) {
	unsubscribe(frm);
	frm.sanad_realtime = (data) => {
		if (!data || data.campaign !== frm.doc.name) return;
		load_progress(frm);
		if (data.status && data.status !== frm.doc.status) frm.reload_doc();
		else if (frm.sanad_recipients) frm.sanad_recipients.refresh();
	};
	frappe.realtime.on("wa:campaign:status", frm.sanad_realtime);
}

function unsubscribe(frm) {
	if (frm.sanad_realtime) frappe.realtime.off("wa:campaign:status", frm.sanad_realtime);
	frm.sanad_realtime = null;
}

function confirm_then(frm, opts, method, args) {
	return sanad.ui.ConfirmDialog.ask(Object.assign({}, opts, { on_confirm: ({ reason }) => sanad.ui.call(method, Object.assign({ name: frm.doc.name }, args || {}, opts.reason_field ? { reason } : {})) }))
		.then((r) => {
			sanad.ui.Toast.success(opts.success || __("Done"));
			frm.reload_doc();
			return r;
		})
		.catch(() => {});
}

function add_buttons(frm) {
	if (frm.is_new() || !is_manager()) return;
	const s = frm.doc.status;
	const messages = (frm.doc.messages || []).length;
	if (EDITABLE.includes(s)) {
		const start = () =>
			confirm_then(frm, {
				title: __("Start the campaign now?"),
				impact: [
					{ label: __("Recipients"), value: fmt_int(frm.doc.total_recipients) },
					{ label: __("Messages per recipient"), value: fmt_int(messages) },
					{ label: __("Messages in total"), value: fmt_int(cint(frm.doc.total_recipients) * messages) },
				],
				confirm_label: __("Start"),
				success: __("Campaign started"),
			}, "campaigns.start");
		if (frm.is_dirty()) frm.add_custom_button(__("Start"), start);
		else frm.page.set_primary_action(__("Start"), start, "es-line-email");
	}
	if (s === "Draft") {
		frm.add_custom_button(__("Schedule"), () => {
			const d = new frappe.ui.Dialog({
				title: __("Schedule the campaign"),
				fields: [{ fieldtype: "Datetime", fieldname: "scheduled_at", label: __("Start at"), reqd: 1, default: frm.doc.scheduled_at || frappe.datetime.add_days(frappe.datetime.now_datetime(), 1) }],
				primary_action_label: __("Schedule"),
				primary_action: ({ scheduled_at }) => {
					sanad.ui
						.call("campaigns.schedule", { name: frm.doc.name, scheduled_at })
						.then(() => {
							d.hide();
							sanad.ui.Toast.success(__("Campaign scheduled"));
							frm.reload_doc();
						})
						.catch((err) => sanad.ui.Toast.error(err));
				},
			});
			d.show();
		});
	}
	if (s === "Scheduled") {
		frm.add_custom_button(__("Unschedule"), () => sanad.ui.call("campaigns.unschedule", { name: frm.doc.name }).then(() => frm.reload_doc()).catch((err) => sanad.ui.Toast.error(err)));
	}
	if (["Running", "Queued"].includes(s)) {
		frm.add_custom_button(__("Pause"), () =>
			confirm_then(frm, {
				title: __("Pause the campaign?"),
				impact: [{ label: __("Messages that will stop"), value: fmt_int(cint(frm.doc.total_recipients) - cint(frm.doc.sent_count) - cint(frm.doc.failed_count)) }],
				reason_field: { label: __("Reason"), required: false },
				confirm_label: __("Pause"),
				success: __("Campaign paused"),
			}, "campaigns.pause")
		);
	}
	if (s === "Paused") {
		frm.add_custom_button(__("Resume"), () =>
			confirm_then(frm, {
				title: __("Resume the campaign?"),
				impact: [{ label: __("Messages that will be sent"), value: fmt_int(cint(frm.doc.total_recipients) - cint(frm.doc.sent_count) - cint(frm.doc.failed_count)) }],
				confirm_label: __("Resume"),
				success: __("Campaign resumed"),
			}, "campaigns.resume")
		);
	}
	if (!TERMINAL.includes(s)) {
		frm.add_custom_button(__("Cancel campaign"), () =>
			confirm_then(frm, {
				title: __("Cancel the campaign?"),
				impact: [{ label: __("Messages that will not be sent"), value: fmt_int(cint(frm.doc.total_recipients) - cint(frm.doc.sent_count) - cint(frm.doc.failed_count)), tone: "red" }],
				reason_field: { label: __("Reason"), required: true },
				ack_checkbox: __("I understand the remaining messages will not be sent."),
				danger: true,
				confirm_label: __("Cancel campaign"),
				success: __("Campaign cancelled"),
			}, "campaigns.cancel")
		);
	}
	if (cint(frm.doc.total_recipients) > 0) {
		frm.add_custom_button(__("Sent messages"), () => frappe.set_route("List", "WhatsApp Log", { campaign: frm.doc.name }), __("View"));
	}
}

function preview_message(frm, row) {
	sanad.ui
		.call("campaigns.preview_message", { name: frm.doc.name, idx: row.idx }, { silent: true })
		.then((p) => {
			const d = new frappe.ui.Dialog({ title: __("Preview of message {0}", [row.idx]), fields: [{ fieldtype: "HTML", fieldname: "body" }] });
			const errors = (p.errors || []).map((e) => `<li>${sanad.ui.escape(e)}</li>`).join("");
			d.get_field("body").$wrapper.html(`
				<div>
					<pre style="white-space:pre-wrap; font-family:inherit;">${sanad.ui.escape(p.body || "")}</pre>
					${p.attachment_name ? `<div class="text-muted">${sanad.ui.escape(__("Attachment: {0}", [p.attachment_name]))}</div>` : ""}
					${errors ? `<ul class="text-danger" role="alert">${errors}</ul>` : ""}
				</div>`);
			d.show();
		})
		.catch((err) => sanad.ui.Toast.error(err));
}

frappe.ui.form.on("WhatsApp Campaign", {
	setup(frm) {
		frm.set_query("device", () => ({ filters: { disabled: 0 } }));
	},

	onload(frm) {
		// "Campaign for this group" (Contact Group list / form) — new_doc drops unknown route_options,
		// so the group travels in frappe.flags and the picker opens on it after the first save.
		if (frappe.flags.wa_picker_group) {
			frm.sanad_picker_group = frappe.flags.wa_picker_group;
			frappe.flags.wa_picker_group = null;
		}
	},

	refresh(frm) {
		if (TERMINAL.includes(frm.doc.status)) {
			frm.set_read_only();
			frm.disable_save();
		} else if (!EDITABLE.includes(frm.doc.status) && !frm.is_new()) {
			["messages", "device", "scheduled_at", "messages_per_minute", "exclude_unknown_numbers"].forEach((f) => frm.set_df_property(f, "read_only", 1));
		}
		add_buttons(frm);
		mount_recipients(frm);
		mount_progress(frm);
		if (!frm.is_new()) subscribe(frm);
		if (frm.sanad_picker_group && !frm.is_new() && can_change_recipients(frm)) {
			const group = frm.sanad_picker_group;
			frm.sanad_picker_group = null;
			open_picker(frm, "add", { source: "groups", ref: group });
		}
		if (!frm.is_new() && frm.fields_dict.messages && frm.fields_dict.messages.grid) {
			frm.fields_dict.messages.grid.add_custom_button(__("Preview message"), () => {
				const selected = frm.fields_dict.messages.grid.get_selected_children();
				const row = selected[0] || (frm.doc.messages || [])[0];
				if (!row) return sanad.ui.Toast.warning(__("Add a message first"));
				preview_message(frm, row);
			});
		}
	},

	on_hide(frm) {
		unsubscribe(frm);
	},
});

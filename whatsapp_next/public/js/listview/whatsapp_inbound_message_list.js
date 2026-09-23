// WhatsApp Inbound Message list — screen 5 (09 §1B/§1C row 5). FilterBar (matched tabs on
// `command_status`, command / contact / device, received_at range, search, simulated), row
// click → record Drawer over `messages.get_inbound` with the command trace and the reply,
// RowActions (reply via QuickSend, open command, contact) and the `wa:inbound:received` refresh.

(function () {
	const ui = sanad.ui;
	const DT = "WhatsApp Inbound Message";
	const AGENT_ROLES = ["WhatsApp Agent", "WhatsApp Manager", "System Manager"];
	const DRAWER_FIELDS = ["device", "phone_e164", "display_name", "contact", "is_group", "message_type", "body", "caption", "received_at", "is_simulated", "creation"];

	const is_agent = () => frappe.user.has_role(AGENT_ROLES);
	const fmt_dt = (v) => (v ? frappe.datetime.str_to_user(v) : "");
	const badge = (doctype, doc, label) => {
		const ind = ui.indicator_for(doctype, Object.assign({ doctype }, doc));
		return ui.StatusBadge.html({ label: __(label || ind.label || ""), colour: ind.colour });
	};
	const dl = (rows) =>
		`<dl class="sanad-drawer__dl">${rows
			.filter((r) => r[1] !== "" && r[1] != null)
			.map((r) => `<div class="sanad-drawer__field${r[2] ? " sanad-drawer__field--wide" : ""}"><dt>${ui.escape(r[0])}</dt><dd>${r[3] ? r[1] : ui.escape(r[1])}</dd></div>`)
			.join("")}</dl>`;

	const reply = (doc, after) => {
		const opts = { device: doc.device, on_sent: after };
		if (doc.is_group && doc.chat_jid) opts.jid = doc.chat_jid;
		else opts.phone = doc.phone_e164 || doc.phone || doc.jid;
		if (doc.contact) opts.contact = doc.contact;
		return new ui.QuickSend(opts);
	};

	const open_contact = (doc) => {
		if (doc.contact) return frappe.set_route("Form", "Contact", doc.contact);
		return frappe.set_route("List", "WhatsApp Number", { phone_e164: doc.phone_e164 });
	};

	const render_trace = ($el, doc) => {
		const t = doc.command_trace || {};
		const status = t.command_status || "None";
		const status_badge = badge(DT, { command_status: status }, status);
		if (!t.command && (status === "None" || status === "Not Matched")) {
			$el.html(`<p class="text-muted">${status_badge} ${ui.escape(__("No command matches this text."))}</p>`);
			return;
		}
		let args = t.command_args;
		if (args && typeof args === "object") args = JSON.stringify(args);
		$el.html(
			dl([
				[__("Result"), status_badge, false, true],
				[__("Command"), t.command ? frappe.utils.get_form_link("WhatsApp Command", t.command, true) : "", false, true],
				[__("Matched text"), t.command_text],
				[__("Arguments"), args, true],
				[__("Block reason"), t.block_reason ? __(t.block_reason) : ""],
				[__("Error"), t.command_error, true],
			])
		);
	};

	const render_reply = ($el, doc) => {
		const r = doc.reply_outbound;
		if (!r) {
			new ui.EmptyState({ wrapper: $el, state: "empty", title: __("No reply was sent"), size: "sm" });
			return;
		}
		let gap = "";
		if (doc.received_at && r.sent_at && typeof frappe.utils.get_formatted_duration === "function") {
			const seconds = moment(r.sent_at).diff(moment(doc.received_at), "seconds");
			if (seconds >= 0) gap = frappe.utils.get_formatted_duration(seconds);
		}
		// colour from the Outbound DocType's own indicator rule (gray when its list script is not loaded)
		$el.html(
			dl([
				[__("Reply"), frappe.utils.get_form_link("WhatsApp Log", r.name, true), false, true],
				[__("Status"), badge("WhatsApp Log", r, r.status), false, true],
				[__("Sent at"), fmt_dt(r.sent_at)],
				[__("Response time"), gap],
				[__("Error"), r.error_code],
				[__("Text"), r.body, true],
			])
		);
	};

	const open_drawer = (doc, refresh, listview) =>
		new ui.Drawer({
			doctype: DT,
			name: doc.name,
			mode: "record",
			method: "messages.get_inbound",
			fields: DRAWER_FIELDS,
			listview,
			sections: [
				{ label: __("Command trace"), render: render_trace },
				{ label: __("Reply"), render: render_reply },
			],
			actions: [
				{ label: __("Reply"), icon: "es-line-reply", condition: () => is_agent(), handler: (d) => reply(d, refresh) },
				{ label: __("Open command"), icon: "es-line-zap", condition: (d) => !!(d.command_trace && d.command_trace.command), handler: (d) => frappe.set_route("Form", "WhatsApp Command", d.command_trace.command) },
				{ label: __("Contact"), icon: "es-line-customer", handler: (d) => open_contact(d) },
			],
		}).show();

	frappe.listview_settings[DT] = {
		hide_name_column: true,
		add_fields: ["command_status", "command", "phone", "phone_e164", "jid", "chat_jid", "is_group", "display_name", "contact", "device", "message_type", "received_at", "is_simulated"],

		// The one command_status → colour rule; badges read it through `sanad.ui.indicator_for`.
		get_indicator(doc) {
			const status = doc.command_status || "None";
			const colour = { Matched: "green", Executed: "green", "Not Matched": "gray", None: "gray", Failed: "red", Blocked: "orange" }[status] || "gray";
			return [__(status), colour, `command_status,=,${status}`];
		},

		formatters: {
			command_status(value, df, doc) {
				return badge(DT, Object.assign({}, doc, { command_status: value || "None" }), value || "None");
			},
		},

		onload(listview) {
			const refresh = () => listview.refresh();

			new ui.FilterBar({
				listview,
				intro: __("Everything received on your devices: the matched command, the reply and any errors."),
				actions: ["group_by", "export"],
				presets: [
					{ fieldname: "phone_e164", type: "search", fields: ["phone_e164", "display_name", "body"], placeholder: __("Search phone, name or text…") },
					{ fieldname: "command_status", type: "select", label: __("Result") },
					{ fieldname: "command", type: "select" },
					{ fieldname: "contact", type: "select" },
					{ fieldname: "device", type: "select" },
					{ fieldname: "message_type", type: "select" },
					{ fieldname: "is_simulated", type: "select", label: __("Simulated") },
					{ fieldname: "received_at", type: "period", label: __("Period"), default: "30d" },
				],
			});

			listview._sanad_row_actions = new ui.RowActions({
				listview,
				actions: [
					{ label: __("Reply"), icon: "es-line-reply", condition: () => is_agent(), handler: (doc) => reply(doc, refresh) },
					{ label: __("Open command"), icon: "es-line-zap", condition: (doc) => !!doc.command, handler: (doc) => frappe.set_route("Form", "WhatsApp Command", doc.command) },
					{ label: __("Contact"), icon: "es-line-customer", handler: (doc) => open_contact(doc) },
				],
				on_row_click: (doc) => open_drawer(doc, refresh, listview),
			});

			ui.bind_list_realtime(listview, "wa:inbound:received", 2000);
		},

		refresh(listview) {
			listview && listview._sanad_row_actions && listview._sanad_row_actions.decorate();
		},
	};
})();

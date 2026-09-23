// WhatsApp Inbound Message list — screen 5 (09 §1B/§1C row 5), prototype-faithful (D-064):
// PageHeader → FilterBar toolbar → DataList table (Sender + phone, Incoming text, Matched command,
// Contact link, Device, Time, View) → footer. "View" and the row click open the record Drawer over
// `messages.get_inbound` with the command trace and the reply; realtime `wa:inbound:received`.

(function () {
	const ui = sanad.ui;
	const DT = "WhatsApp Inbound Message";
	const AGENT_ROLES = ["WhatsApp Agent", "WhatsApp Manager", "System Manager"];
	const DRAWER_FIELDS = ["device", "phone_e164", "display_name", "contact", "is_group", "message_type", "body", "caption", "received_at", "is_simulated", "creation"];

	const is_agent = () => frappe.user.has_role(AGENT_ROLES);
	const fmt_dt = (v) => (v ? frappe.datetime.str_to_user(v) : "");
	// table cell: user date + HH:mm (no seconds), like the prototype's time column
	const fmt_short = (v) => (v ? moment(frappe.datetime.convert_to_user_tz ? frappe.datetime.convert_to_user_tz(v, false) : v).format(`${frappe.datetime.get_user_date_fmt().toUpperCase()} HH:mm`) : "");
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

	/** "Matched command" cell: green "code — function" chip or an amber "No match" chip. */
	const match_chip = (doc) => {
		const status = doc.command_status || "None";
		if (doc.command && ["Matched", "Executed"].includes(status)) {
			const title = doc.command_title || doc.command_code || doc.command;
			return ui.StatusBadge.html({ label: title, colour: "green", icon: false });
		}
		if (status === "Failed") return ui.StatusBadge.html({ label: __("Failed"), colour: "red" });
		if (status === "Blocked") return ui.StatusBadge.html({ label: __("Blocked"), colour: "orange" });
		return ui.StatusBadge.html({ label: __("No match"), colour: "orange", icon: false });
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
			// the incoming text is the record: it leads, the rest explains it
			highlight: { field: "body", label: __("Incoming text"), icon: "es-line-chat-alt" },
			// the badge follows the command match, which the payload carries inside `command_trace`
			profile: {
				status: (d) => {
					const status = (d.command_trace || {}).command_status || d.command_status;
					if (!status) return null;
					const ind = ui.indicator_for(DT, { doctype: DT, command_status: status });
					return { label: __(ind.label || status), colour: ind.colour };
				},
			},
			facts: ["message_type", "device", "received_at"],
			relations: [{ field: "contact", doctype: "Contact", label: __("Contact"), actions: [{ icon: "es-line-reply", label: __("Reply"), condition: () => is_agent(), on_click: () => reply(doc, refresh) }] }],
			sections: [
				{ label: __("Command trace"), icon: "es-line-zap", render: render_trace },
				{ label: __("Reply"), icon: "es-line-reply", render: render_reply },
			],
			actions: [
				{ label: __("Reply"), icon: "es-line-reply", condition: () => is_agent(), handler: (d) => reply(d, refresh) },
				{ label: __("Open command"), icon: "es-line-zap", condition: (d) => !!(d.command_trace && d.command_trace.command), handler: (d) => frappe.set_route("Form", "WhatsApp Command", d.command_trace.command) },
				{ label: __("Contact"), icon: "es-line-customer", handler: (d) => open_contact(d) },
			],
		}).show();

	frappe.listview_settings[DT] = {
		hide_name_column: true,
		add_fields: ["command_status", "command", "phone", "phone_e164", "jid", "chat_jid", "is_group", "display_name", "contact", "device", "message_type", "body", "received_at", "is_simulated", "creation"],

		// The one command_status → colour rule; badges read it through `sanad.ui.indicator_for`.
		get_indicator(doc) {
			const status = doc.command_status || "None";
			const colour = { Matched: "green", Executed: "green", "Not Matched": "orange", None: "gray", Failed: "red", Blocked: "orange" }[status] || "gray";
			return [__(status), colour, `command_status,=,${status}`];
		},

		onload(listview) {
			const refresh = () => listview.refresh();
			const open = (doc) => open_drawer(doc, refresh, listview);

			if (typeof ui.PageHeader === "function") {
				new ui.PageHeader({
					listview,
					title: __("Inbound messages"),
					description: __("Everything received from customers on your devices, with the matched command and the automatic reply."),
				});
			}

			new ui.FilterBar({
				listview,
				actions: ["group_by", "export"],
				presets: [
					{ fieldname: "phone_e164", type: "search", fields: ["phone_e164", "display_name", "body"], placeholder: __("Search name, number or message text…") },
					{ fieldname: "command_status", type: "select", label: __("Matched command") },
					{ fieldname: "command", type: "select" },
					{ fieldname: "contact", type: "select", label: __("Contact link") },
					{ fieldname: "device", type: "select" },
					{ fieldname: "message_type", type: "select" },
					{ fieldname: "is_simulated", type: "select", label: __("On behalf") },
					{ fieldname: "received_at", type: "period", label: __("Period"), default: "30d" },
				],
			});

			new ui.DataList({
				listview,
				columns: [
					{
						fieldname: "display_name",
						label: __("Sender"),
						sortable: true,
						format: (v) => ui.escape(v || __("Unknown")),
						sub: (doc) => `<span dir="ltr">${ui.escape(doc.phone_e164 || doc.phone || doc.jid || "")}</span>`,
					},
					{ fieldname: "body", label: __("Incoming text"), format: (v) => ui.escape(frappe.utils.html2text ? frappe.utils.html2text(v || "") : v || "") },
					{ fieldname: "command_status", label: __("Matched command"), sortable: true, format: (v, doc) => match_chip(doc) },
					{ fieldname: "contact", label: __("Contact link"), sortable: true, format: (v) => ui.StatusBadge.html(v ? { label: __("Linked"), colour: "green" } : { label: __("Not linked"), colour: "gray", icon: false }) },
					{ fieldname: "device", type: "avatar", label: __("Device"), sortable: true },
					{ fieldname: "received_at", type: "date", label: __("Time"), sortable: true, format: (v, doc) => `<span class="sanad-tabular sanad-datalist__date" dir="ltr">${ui.escape(fmt_short(v || doc.creation))}</span>` },
				],
				row_action: { label: __("View"), handler: open },
				on_row_click: open,
				footer: { count: (total) => ui.plural(total, { one: __("{0} message"), other: __("{0} messages") }) },
				empty: { title: __("No messages match"), description: __("Change the filters or the period to see more.") },
			});

			ui.bind_list_realtime(listview, "wa:inbound:received", 2000);
		},
	};
})();

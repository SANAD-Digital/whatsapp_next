// WhatsApp Inbound Message list — screen 5 (09 §1B/§1C row 5). Same scaffold as the Outbound
// list (`whatsapp_next.screens.message_list`), so both message screens carry the same toolbar,
// the same table behaviour and the same drawer shape; this file only says what an incoming
// message is — the matched command, the contact link, and the reply that went back.

(function () {
	const ui = sanad.ui;
	const DT = "WhatsApp Inbound Message";
	const M = whatsapp_next.messages;
	const fmt = whatsapp_next.fmt;
	const dl = ui.Render.parts.dl;
	const is_agent = M.is_agent;
	const DRAWER_FIELDS = ["device", "phone_e164", "display_name", "contact", "is_group", "message_type", "body", "caption", "attachment", "received_at", "is_simulated", "creation"];

	const reply = (doc, after) => M.quick_send(doc, after);

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
		const status_badge = fmt.badge(DT, { command_status: status }, status);
		if (!t.command && (status === "None" || status === "Not Matched")) {
			$el.html(`<p class="text-muted">${status_badge} ${ui.escape(__("No command matches this text."))}</p>`);
			return;
		}
		let args = t.command_args;
		if (args && typeof args === "object") args = JSON.stringify(args);
		$el.html(
			dl([
				{ label: __("Result"), value: status_badge },
				{ label: __("Command"), value: t.command ? frappe.utils.get_form_link("WhatsApp Command", t.command, true) : "" },
				{ label: __("Matched text"), value: t.command_text },
				{ label: __("Arguments"), value: args, wide: true },
				{ label: __("Block reason"), value: t.block_reason ? __(t.block_reason) : "" },
				{ label: __("Error"), value: t.command_error, wide: true },
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
				{ label: __("Reply"), value: frappe.utils.get_form_link("WhatsApp Log", r.name, true) },
				{ label: __("Status"), value: fmt.badge("WhatsApp Log", r, r.status) },
				{ label: __("Sent at"), value: fmt.dt(r.sent_at) },
				{ label: __("Response time"), value: gap },
				{ label: __("Error"), value: r.error_code },
				{ label: __("Text"), value: r.body, wide: true },
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
			facts: [
				{ field: "message_type", icon: "es-line-chat-alt" },
				{ field: "device", icon: "es-line-laptop" },
				{ field: "received_at", icon: "es-line-time" },
			],
			relations: [{ field: "contact", doctype: "Contact", label: __("Contact"), actions: [{ icon: "es-line-reply", label: __("Reply"), condition: is_agent, on_click: () => reply(doc, refresh) }] }],
			sections: [
				{ label: __("Command trace"), icon: "es-line-zap", render: render_trace },
				{ label: __("Reply"), icon: "es-line-reply", render: render_reply },
			],
			actions: [
				{ label: __("Reply"), icon: "es-line-reply", condition: is_agent, handler: (d) => reply(d, refresh) },
				{ label: __("Open command"), icon: "es-line-zap", condition: (d) => !!(d.command_trace && d.command_trace.command), handler: (d) => M.open_command(d.command_trace.command) },
				{ label: __("Add as synonym"), icon: "es-line-add", condition: (d) => M.is_manager() && !(d.command_trace && d.command_trace.command) && !!d.body, handler: (d) => M.add_synonym(d, refresh) },
				{ label: __("Contact"), icon: "es-line-customer", handler: (d) => M.open_contact(d, refresh) },
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

			whatsapp_next.screens.message_list(listview, {
				open,
				realtime: "wa:inbound:received",
				search: { fields: ["phone_e164", "display_name", "body"], placeholder: __("Search name, number or message text…") },
				filters: [
					{ fieldname: "command_status", type: "select", label: __("Matched command") },
					{ fieldname: "command", type: "select" },
					{ fieldname: "contact", type: "select", label: __("Contact link") },
					{ fieldname: "device", type: "select" },
					{ fieldname: "message_type", type: "select" },
					{ fieldname: "is_simulated", type: "select", label: __("On behalf") },
				],
				columns: [
					whatsapp_next.columns.party({ label: __("Sender") }),
					{ fieldname: "body", label: __("Incoming text"), format: (v) => ui.escape(frappe.utils.html2text ? frappe.utils.html2text(v || "") : v || "") },
					{ fieldname: "command_status", type: "status", label: __("Matched command"), sortable: true, format: (v, doc) => match_chip(doc) },
					{ fieldname: "contact", label: __("Contact link"), sortable: true, format: (v) => ui.StatusBadge.html(v ? { label: __("Linked"), colour: "green" } : { label: __("Not linked"), colour: "gray", icon: false }) },
					whatsapp_next.columns.device(),
					whatsapp_next.columns.time({ fieldname: "received_at", label: __("Time") }),
				],
				mobile_columns: ["display_name", "command_status"],
				buttons: [{ label: __("Quick send"), condition: is_agent, action: () => new ui.QuickSend({ on_sent: refresh }) }],
			});
		},
	};
})();

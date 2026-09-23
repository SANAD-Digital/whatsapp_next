// WhatsApp Log (Outbound) list — screen 4 (09 §1B/§1C row 4), prototype-faithful (D-064):
// the shared message-list scaffold (`whatsapp_next.screens.message_list`) draws the toolbar
// (search · filters · date filter · grouping · columns · export) and the table; this file only
// says what an outbound message is — its columns, its filters, its bulk action and its drawer.
// The drawer, the formatters and the per-message actions live in `js/screens/messages.js`.

(function () {
	const ui = sanad.ui;
	const DT = "WhatsApp Log";
	const M = whatsapp_next.messages;
	const is_agent = M.is_agent;

	frappe.listview_settings[DT] = {
		hide_name_column: true,
		// every field the table, the badges and the actions read (the columns are explicit below)
		add_fields: ["status", "phone", "phone_e164", "jid", "recipient_type", "display_name", "contact", "device", "source_type", "campaign", "reference_doctype", "reference_name", "message_type", "error_code", "error_message", "is_simulated", "is_test", "creation", "sent_at", "command", "template"],

		// The one status → colour rule for this DocType; every badge reads it through `sanad.ui.indicator_for`.
		get_indicator(doc) {
			const colour = { Sent: "green", Delivered: "green", Read: "green", Queued: "blue", Sending: "blue", Unsent: "orange", Held: "orange", Failed: "red", Cancelled: "red" }[doc.status] || "gray";
			return [__(doc.status), colour, `status,=,${doc.status}`];
		},

		onload(listview) {
			const refresh = () => listview.refresh();
			const open = (doc) => M.open_outbound_drawer(doc.name, { after_change: refresh, listview });

			whatsapp_next.screens.message_list(listview, {
				open,
				realtime: "wa:message:status",
				search: { fields: ["phone_e164", "display_name", "reference_name"], placeholder: __("Search name, number or document…") },
				filters: [
					{ fieldname: "status", type: "select" },
					{ fieldname: "reference_doctype", type: "select", label: __("Document type") },
					{ fieldname: "device", type: "select" },
					{
						fieldname: "error_code",
						type: "select",
						label: __("Error"),
						// Data field: distinct values seen in the log (guarded — an empty list just hides nothing)
						options: (txt) =>
							frappe.db
								.get_list(DT, { fields: ["error_code"], filters: [["error_code", "is", "set"]].concat(txt ? [["error_code", "like", `%${txt}%`]] : []), group_by: "error_code", order_by: "error_code asc", limit: 50 })
								.then((rows) => Array.from(new Set((rows || []).map((r) => r.error_code).filter(Boolean))))
								.catch(() => []),
					},
				],
				columns: [
					whatsapp_next.columns.party({ label: __("Contact") }),
					{ fieldname: "status", type: "status", label: __("Status"), sortable: true },
					whatsapp_next.columns.reference(),
					whatsapp_next.columns.device(),
					whatsapp_next.columns.time({ fieldname: "sent_at", label: __("Sent at") }),
					{ fieldname: "error_code", label: __("Error"), sortable: true, format: (v, doc) => (v ? `<span class="sanad-cell__error" title="${ui.escape(doc.error_message || v)}">${ui.escape(v)}</span>` : "") },
					whatsapp_next.columns.flag({ fieldname: "is_simulated", label: __("On behalf") }),
				],
				mobile_columns: ["display_name", "status"],
				bulk: is_agent()
					? [
							{
								label: (n) => (n ? __("Resend failed ({0})", [ui.format_int(n)]) : __("Resend failed")),
								method: "messages.resend_many",
								confirm: (names, docs) => {
									const failed = docs.filter((d) => d.status === "Failed").length;
									return failed
										? {
												title: ui.plural(failed, { one: __("Resend {0} failed message?"), other: __("Resend {0} failed messages?") }),
												impact: [
													{ label: __("Will be re-queued"), value: ui.format_int(failed), tone: "blue" },
													{ label: __("Ignored (not failed)"), value: ui.format_int(names.length - failed) },
												],
												confirm_label: __("Resend"),
										  }
										: null;
								},
								handler: (names, docs) => {
									const failed = docs.filter((d) => d.status === "Failed").map((d) => d.name);
									if (!failed.length) {
										ui.Toast.info(__("No failed messages in the selection"));
										return undefined;
									}
									return ui.call("messages.resend_many", { names: failed }, { freeze: true, freeze_message: __("Resending {0} messages…", [ui.format_int(failed.length)]) });
								},
								success: (r) => ui.plural(r.count || 0, { one: __("{0} message re-queued"), other: __("{0} messages re-queued") }),
							},
					  ]
					: [],
				buttons: [{ label: __("Quick send"), condition: is_agent, action: () => new ui.QuickSend({ on_sent: refresh }) }],
			});
		},

		before_render() {},
	};
})();

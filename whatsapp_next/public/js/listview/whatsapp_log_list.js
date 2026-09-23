// WhatsApp Log (Outbound) list — screen 4 (09 §1B/§1C row 4). Mounts the kit: FilterBar presets,
// RowActions (resend / quick send / contact / cancel), BulkActions (resend failed), the record
// Drawer over `messages.get_outbound`, a "Quick send" page button and the `wa:message:status`
// realtime refresh. All data goes through `whatsapp_next.api.v1.messages.*` / `quick_send.*`.
// The `whatsapp_next.messages.*` helpers are shared with the Outbound form and the Queue list
// (they `frappe.require` this file when it is not loaded on their route).

frappe.provide("whatsapp_next.messages");

(function () {
	const ui = sanad.ui;
	const DT = "WhatsApp Log";
	const TERMINAL = ["Sent", "Delivered", "Read", "Failed", "Cancelled"];
	const AGENT_ROLES = ["WhatsApp Agent", "WhatsApp Manager", "System Manager"];
	const MANAGER_ROLES = ["WhatsApp Manager", "System Manager"];
	const DRAWER_FIELDS = [
		"status", "phone_e164", "display_name", "contact", "device", "message_type", "body", "caption",
		"source_type", "template", "campaign", "command", "notification", "scheduled_at", "queued_at",
		"sent_at", "delivered_at", "read_at", "failed_at", "error_code", "error_message", "attempts",
		"is_test", "is_simulated", "creation",
	];

	const is_agent = () => frappe.user.has_role(AGENT_ROLES);
	const is_manager = () => frappe.user.has_role(MANAGER_ROLES);
	const fmt_dt = (v) => (v ? frappe.datetime.str_to_user(v) : "");

	// ---- shared helpers (also used by the Outbound form and the Queue list) -----------------

	whatsapp_next.messages.resend = function (name, after) {
		return ui.call("messages.resend", { name }).then((r) => {
			ui.Toast.success(__("Message re-queued"), {
				action: r && r.outbound ? { label: __("Open"), onclick: () => frappe.set_route("Form", DT, r.outbound) } : undefined,
			});
			after && after(r);
			return r;
		});
	};

	/** Cancel one outbound message (`doc` needs `name`; `display_name` / `phone_e164` / `status` for the impact rows). */
	whatsapp_next.messages.cancel = function (doc, after) {
		return ui.ConfirmDialog.ask({
			title: __("Cancel this message?"),
			message: __("The message leaves the queue and its status becomes Cancelled."),
			impact: [
				{ label: __("Recipient"), value: doc.display_name || doc.phone_e164 || doc.jid || "" },
				{ label: __("Status now"), value: __(doc.status || "") },
			],
			reason_field: true,
			danger: true,
			confirm_label: __("Cancel message"),
			cancel_label: __("Keep it"),
			on_confirm: ({ reason }) => ui.call("messages.cancel", { name: doc.name, reason }),
		})
			.then((r) => {
				ui.Toast.success(__("Message cancelled"));
				after && after(r);
			})
			.catch(() => {});
	};

	whatsapp_next.messages.quick_send = function (doc, after) {
		const opts = { device: doc.device, on_sent: after };
		if (doc.jid && doc.recipient_type === "Group") opts.jid = doc.jid;
		else opts.phone = doc.phone_e164 || doc.phone || doc.jid;
		if (doc.contact) opts.contact = doc.contact;
		return new ui.QuickSend(opts);
	};

	whatsapp_next.messages.open_contact = function (doc) {
		if (doc.contact) return frappe.set_route("Form", "Contact", doc.contact);
		return frappe.set_route("List", "WhatsApp Number", { phone_e164: doc.phone_e164 });
	};

	/** Timeline rows `{at, text, tone}` from the `messages.get_outbound` payload. */
	whatsapp_next.messages.timeline_rows = function (doc) {
		const rows = [];
		const push = (at, text, tone) => at && rows.push({ at, text, tone });
		push(doc.creation, __("Created ({0})", [__(doc.source_type || "API")]), "gray");
		push(doc.queued_at, __("Queued"), "blue");
		push(doc.scheduled_at, __("Scheduled for {0}", [fmt_dt(doc.scheduled_at)]), "blue");
		const q = doc.timeline && doc.timeline.queue_item;
		if (q) {
			push(q.claimed_at, __("Picked up for sending (attempt {0} of {1})", [ui.format_int(q.attempts || 1), ui.format_int(q.max_attempts || 0)]), "blue");
			push(q.paused_at, __("Paused by {0}: {1}", [q.paused_by || "", q.pause_reason || ""]), "amber");
			push(q.next_attempt_at, __("Retry scheduled ({0})", [q.last_error_code || q.last_error || ""]), "amber");
			push(q.deleted_at, __("Removed from the queue by {0}: {1}", [q.deleted_by || "", q.delete_reason || ""]), "red");
			if (q.status === "Dead Letter") push(q.modified, __("Gave up after retries: {0}", [q.dead_letter_reason || q.last_error || ""]), "red");
			push(q.completed_at, __("Handed to the sending platform ({0})", [q.platform_queue_id || q.batch_id || ""]), "green");
		}
		push(doc.sent_at, __("Sent"), "green");
		push(doc.delivered_at, __("Delivered"), "green");
		push(doc.read_at, __("Read"), "green");
		push(doc.held_at, __("Held: {0}", [doc.held_reason || ""]), "amber");
		push(doc.failed_at, __("Failed: {0}", [doc.error_message || doc.error_code || ""]), "red");
		push(doc.cancelled_at, __("Cancelled"), "red");
		((doc.timeline && doc.timeline.webhook_events) || []).forEach((e) => {
			const ok = e.status === "Processed";
			const text = e.error
				? __("Webhook {0} ({1}): {2}", [e.event_name || "", __(e.status || ""), e.error])
				: __("Webhook {0} ({1})", [e.event_name || "", __(e.status || "")]);
			push(e.received_at || e.creation, text, ok ? "gray" : "amber");
		});
		return rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
	};

	whatsapp_next.messages.render_timeline = function ($el, rows) {
		if (!rows.length) {
			new ui.EmptyState({ wrapper: $el, state: "empty", title: __("No events yet"), size: "sm" });
			return;
		}
		const html = rows
			.map(
				(r) => `<li class="sanad-drawer__event"><span class="sanad-drawer__event-time">${ui.escape(fmt_dt(r.at))}</span><span class="sanad-drawer__event-text"><span class="sanad-badge__dot sanad-tone--${r.tone || "gray"}" aria-hidden="true"></span> ${ui.escape(r.text)}</span></li>`
			)
			.join("");
		$el.html(`<ol class="sanad-drawer__timeline">${html}</ol>`);
	};

	whatsapp_next.messages.render_reference = function ($el, doc) {
		const ref = doc.reference || {};
		const link = frappe.utils.get_form_link(ref.doctype, ref.name, true, `${__(ref.doctype)}: ${ref.name}`);
		const amount = ref.amount != null ? frappe.format(ref.amount, { fieldtype: "Currency" }) : "";
		$el.html(`<dl class="sanad-drawer__dl"><div class="sanad-drawer__field"><dt>${ui.escape(__("Document"))}</dt><dd>${link}</dd></div>${amount ? `<div class="sanad-drawer__field"><dt>${ui.escape(__("Amount"))}</dt><dd class="sanad-tabular">${amount}</dd></div>` : ""}</dl>`);
	};

	/** Record drawer of one outbound row (used by the Outbound and Queue lists). */
	whatsapp_next.messages.open_outbound_drawer = function (name, { after_change, listview } = {}) {
		const refresh = () => after_change && after_change();
		const drawer = new ui.Drawer({
			doctype: DT,
			name,
			mode: "record",
			method: "messages.get_outbound",
			fields: DRAWER_FIELDS,
			listview,
			sections: [
				{ label: __("Reference"), condition: (d) => d.reference && d.reference.doctype && d.reference.name, render: whatsapp_next.messages.render_reference },
				{ label: __("Timeline"), render: ($el, d) => whatsapp_next.messages.render_timeline($el, whatsapp_next.messages.timeline_rows(d)) },
			],
			actions: [
				{ label: __("Resend"), icon: ui.icons.resend, condition: (d) => is_agent() && TERMINAL.includes(d.status), handler: (d) => whatsapp_next.messages.resend(d.name, refresh) },
				{ label: __("Quick send"), icon: ui.icons.quick_send, condition: () => is_agent(), handler: (d) => whatsapp_next.messages.quick_send(d, refresh) },
				{ label: __("Contact"), icon: "es-line-customer", handler: (d) => whatsapp_next.messages.open_contact(d) },
				{ label: __("Cancel"), icon: ui.icons.cancel, danger: true, condition: (d) => is_manager() && d.status === "Queued", handler: (d) => whatsapp_next.messages.cancel(d, () => { drawer.refresh(); refresh(); }) },
			],
		});
		return drawer.show();
	};

	// ---- list settings ----------------------------------------------------------------------

	frappe.listview_settings[DT] = {
		hide_name_column: true,
		// fetched with every row (not extra columns): the list columns come from the DocType's `in_list_view` flags
		add_fields: ["status", "phone", "phone_e164", "jid", "recipient_type", "display_name", "contact", "device", "source_type", "campaign", "reference_doctype", "reference_name", "message_type", "error_code", "error_message", "is_simulated", "is_test", "creation", "sent_at"],

		// The one status → colour rule for this DocType; every badge reads it through `sanad.ui.indicator_for`.
		get_indicator(doc) {
			const colour = { Sent: "green", Delivered: "green", Read: "green", Queued: "blue", Sending: "blue", Unsent: "orange", Held: "orange", Failed: "red", Cancelled: "red" }[doc.status] || "gray";
			return [__(doc.status), colour, `status,=,${doc.status}`];
		},

		formatters: {
			// the subject cell is rendered as text by Desk; the phone line is added after render (see onload)
			display_name(value) {
				return value || __("Unknown");
			},
			status(value, df, doc) {
				const ind = ui.indicator_for(DT, Object.assign({ doctype: DT }, doc));
				return ui.StatusBadge.html({ label: __(value), colour: ind.colour });
			},
			sent_at(value, df, doc) {
				const at = value || doc.creation;
				return at ? `<span class="sanad-tabular">${ui.escape(frappe.datetime.str_to_user(at))}</span>` : "—";
			},
			error_code(value, df, doc) {
				if (!value) return `<span class="sanad-cell__muted" aria-hidden="true">—</span>`;
				return `<span class="sanad-cell__error" title="${ui.escape(doc.error_message || value)}">${ui.escape(value)}</span>`;
			},
			reference_name(value, df, doc) {
				if (!value) return `<span class="sanad-cell__muted" aria-hidden="true">—</span>`;
				const link = doc.reference_doctype ? frappe.utils.get_form_link(doc.reference_doctype, value, true, ui.escape(value)) : ui.escape(value);
				return doc.reference_doctype ? `${ui.escape(__(doc.reference_doctype))} · ${link}` : link;
			},
			is_simulated(value) {
				return cint(value) ? ui.StatusBadge.html({ label: __("Yes"), colour: "gray", icon: false }) : `<span class="sanad-cell__muted" aria-hidden="true">—</span>`;
			},
		},

		onload(listview) {
			const refresh = () => listview.refresh();

			new ui.FilterBar({
				listview,
				intro: __("Everything sent from your devices: status, document, device and errors."),
				actions: ["group_by", "export"],
				presets: [
					{ fieldname: "phone_e164", type: "search", fields: ["phone_e164", "display_name", "reference_name"], placeholder: __("Search name, number or document…") },
					{ fieldname: "status", type: "select" },
					{ fieldname: "reference_doctype", type: "select" },
					{ fieldname: "device", type: "select" },
					{
						fieldname: "error_code",
						type: "select",
						// Data field: distinct values seen in the log (guarded — an empty list just hides nothing)
						options: (txt) =>
							frappe.db
								.get_list(DT, { fields: ["error_code"], filters: [["error_code", "is", "set"]].concat(txt ? [["error_code", "like", `%${txt}%`]] : []), group_by: "error_code", order_by: "error_code asc", limit: 50 })
								.then((rows) => Array.from(new Set((rows || []).map((r) => r.error_code).filter(Boolean))))
								.catch(() => []),
					},
					{ fieldname: "is_simulated", type: "select", label: __("Simulated") },
					{ fieldname: "message_type", type: "select" },
					{ fieldname: "command", type: "select" },
					{ fieldname: "template", type: "select" },
					{ fieldname: "creation", type: "period", label: __("Period"), default: "30d" },
				],
			});

			// subject cell: name + the phone (or JID) as a muted second line (Desk renders the subject as text)
			listview.$result.addClass("sanad-list--two-line");
			ui.on_list_render(listview, () => {
				listview.$result.find(".list-row-container").each((i, el) => {
					const $row = $(el);
					if ($row.find(".sanad-cell__sub").length) return;
					const doc = (listview.data || []).find((d) => d.name === ui.docname_of_row($row));
					const key = doc && (doc.phone_e164 || doc.phone || doc.jid);
					if (!key) return;
					$row.find(".list-subject a").first().parent().addClass("sanad-cell").append(`<span class="sanad-cell__sub" dir="ltr">${ui.escape(key)}</span>`);
				});
			});

			listview._sanad_row_actions = new ui.RowActions({
				listview,
				actions: [
					{ label: __("Resend"), icon: ui.icons.resend, condition: (doc) => is_agent() && TERMINAL.includes(doc.status), handler: (doc) => whatsapp_next.messages.resend(doc.name, refresh) },
					{ label: __("Quick send"), icon: ui.icons.quick_send, condition: () => is_agent(), handler: (doc) => whatsapp_next.messages.quick_send(doc, refresh) },
					{ label: __("Contact"), icon: "es-line-customer", handler: (doc) => whatsapp_next.messages.open_contact(doc) },
					{ label: __("Cancel"), icon: ui.icons.cancel, danger: true, condition: (doc) => is_manager() && doc.status === "Queued", handler: (doc) => whatsapp_next.messages.cancel(doc, refresh) },
				],
				on_row_click: (doc) => whatsapp_next.messages.open_outbound_drawer(doc.name, { after_change: refresh, listview }),
			});

			if (is_agent()) {
				new ui.BulkActions({
					listview,
					actions: [
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
					],
				});
				listview.page.add_inner_button(__("Quick send"), () => new ui.QuickSend({ on_sent: refresh }));
			}

			ui.bind_list_realtime(listview, "wa:message:status", 2000);
		},

		// Frappe 16 calls `before_render` without arguments; RowActions re-decorates rows through
		// `sanad.ui.on_list_render`, so nothing is needed here beyond keeping the hooks explicit.
		before_render() {},
		refresh(listview) {
			listview && listview._sanad_row_actions && listview._sanad_row_actions.decorate();
		},
	};
})();

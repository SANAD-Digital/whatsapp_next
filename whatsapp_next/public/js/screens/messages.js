// Message screens — everything the Outbound, Inbound and Queue lists, the Outbound form and the
// message drawers share: the formatters, the columns that mean the same thing on every screen,
// the actions on one message, and the one list scaffold that gives every message list the same
// toolbar (search · filters · date filter · grouping · columns · export) and the same table
// (grouped, pinnable, a "View" that opens the record drawer, a counted footer).
//
// It is part of the app bundle, so it is loaded on every Desk route: a screen just calls it, and
// nothing has to `frappe.require` another screen's file to reach a helper.

frappe.provide("whatsapp_next.messages");
frappe.provide("whatsapp_next.screens");
frappe.provide("whatsapp_next.columns");
frappe.provide("whatsapp_next.fmt");

(function () {
	const ui = sanad.ui;
	const OUT = "WhatsApp Log";
	const TERMINAL = ["Sent", "Delivered", "Read", "Failed", "Cancelled"];
	const AGENT_ROLES = ["WhatsApp Agent", "WhatsApp Manager", "System Manager"];
	const MANAGER_ROLES = ["WhatsApp Manager", "System Manager"];
	// the timeline dot is never colour alone: each tone carries its own mark
	const TONE_ICON = { green: "es-line-success", red: "es-line-close-circle", amber: "es-line-alert-triangle", blue: "es-line-time", gray: "es-line-dot" };

	const DRAWER_FIELDS = [
		"status", "phone_e164", "display_name", "contact", "device", "message_type", "body", "caption",
		"attachment", "file_name",
		"source_type", "template", "campaign", "command", "notification", "scheduled_at", "queued_at",
		"sent_at", "delivered_at", "read_at", "failed_at", "error_code", "error_message", "attempts",
		"is_test", "is_simulated", "creation",
	];

	const is_agent = () => frappe.user.has_role(AGENT_ROLES);
	const is_manager = () => frappe.user.has_role(MANAGER_ROLES);

	// ---- formatters -------------------------------------------------------------------------

	const fmt = whatsapp_next.fmt;

	/** Full date and time in the user's format. */
	fmt.dt = (v) => (v ? frappe.datetime.str_to_user(v) : "");

	/** Table cell: user date + HH:mm, no seconds, as the prototype's time column shows it. */
	fmt.short = (v) => (v ? moment(frappe.datetime.convert_to_user_tz ? frappe.datetime.convert_to_user_tz(v, false) : v).format(`${frappe.datetime.get_user_date_fmt().toUpperCase()} HH:mm`) : "");

	/** A badge coloured by a DocType's own indicator rule. */
	fmt.badge = (doctype, doc, label) => {
		const ind = ui.indicator_for(doctype, Object.assign({ doctype }, doc));
		return ui.StatusBadge.html({ label: __(label || ind.label || ""), colour: ind.colour });
	};

	/** A time cell: left-to-right and tabular, falling back to when the row was created. */
	fmt.time_cell = (v, doc) => (v || (doc && doc.creation) ? `<span class="sanad-tabular sanad-datalist__date" dir="ltr">${ui.escape(fmt.short(v || doc.creation))}</span>` : "");

	// ---- columns every message screen shares --------------------------------------------------

	const columns = whatsapp_next.columns;

	/** Who the message is with: the name, with the number under it. */
	columns.party = ({ label, fieldname = "display_name", sortable = true, fallback, width } = {}) => ({
		fieldname,
		label: label || __("Contact"),
		sortable,
		width,
		format: (v) => ui.escape(v || fallback || __("Unknown")),
		sub: (doc) => `<span dir="ltr">${ui.escape(doc.phone_e164 || doc.phone || doc.jid || "")}</span>`,
	});

	/** The device that carried it. */
	columns.device = ({ label, fieldname = "device" } = {}) => ({ fieldname, type: "avatar", label: label || __("Device"), sortable: true });

	/** When it happened. */
	columns.time = ({ fieldname, label, sortable = true } = {}) => ({ fieldname, type: "date", label: label || __("Time"), sortable, format: fmt.time_cell });

	/** A flag that only matters when it is on ("On behalf", "Test"). */
	columns.flag = ({ fieldname, label, colour = "gray" } = {}) => ({
		fieldname,
		label,
		sortable: true,
		format: (v) => (cint(v) ? ui.StatusBadge.html({ label: __("Yes"), colour, icon: false }) : ""),
	});

	/** The document a message was sent about, as two columns (type, then number). */
	columns.reference = () => [
		{ fieldname: "reference_doctype", label: __("Document type"), format: (v) => (v ? ui.escape(__(v)) : ""), sortable: true },
		{ fieldname: "reference_name", label: __("Document no."), sortable: true, format: (v, doc) => (v ? (doc.reference_doctype ? frappe.utils.get_form_link(doc.reference_doctype, v, true, ui.escape(v)) : ui.escape(v)) : "") },
	];

	// ---- one message on its own ---------------------------------------------------------------

	whatsapp_next.messages.resend = function (name, after) {
		return ui.call("messages.resend", { name }).then((r) => {
			ui.Toast.success(__("Message re-queued"), {
				action: r && r.outbound ? { label: __("Open"), onclick: () => frappe.set_route("Form", OUT, r.outbound) } : undefined,
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

	/** Compose a message to the same party, on the same device. */
	whatsapp_next.messages.quick_send = function (doc, after) {
		const opts = { device: doc.device, on_sent: after };
		const group_jid = doc.recipient_type === "Group" ? doc.jid : doc.is_group ? doc.chat_jid || doc.jid : null;
		if (group_jid) opts.jid = group_jid;
		else opts.phone = doc.phone_e164 || doc.phone || doc.jid;
		if (doc.contact) opts.contact = doc.contact;
		return new ui.QuickSend(opts);
	};

	/** The contact behind a message — its Contact when linked, else its number in the phonebook. */
	whatsapp_next.messages.open_contact = function (doc, after) {
		if (doc.contact) return frappe.set_route("Form", "Contact", doc.contact);
		// Unknown number: link it to a contact or create one, in place (09 row 5 → `numbers.link_number`).
		if (doc.phone_e164 && whatsapp_next.numbers && whatsapp_next.numbers.link_convert_dialog) {
			return whatsapp_next.numbers.link_convert_dialog({ phone_e164: doc.phone_e164, name: doc.phone_e164, display_name: doc.display_name }, after);
		}
		return frappe.set_route("List", "WhatsApp Number", { phone_e164: doc.phone_e164 });
	};

	/** The CommandModal lives in the Command DocType's form script; load it on demand, read-only. */
	whatsapp_next.messages.open_command = function (name) {
		frappe.model.with_doctype("WhatsApp Command", () => {
			if (typeof whatsapp_next.command_modal !== "function") {
				const meta = frappe.get_meta("WhatsApp Command");
				if (meta && meta.__js) new Function(meta.__js)();
			}
			if (typeof whatsapp_next.command_modal === "function") whatsapp_next.command_modal(name, { read_only: true });
			else frappe.set_route("Form", "WhatsApp Command", name);
		});
	};

	/**
	 * "Add as synonym" (09 row 5): the incoming text becomes one more word of a command, so the next
	 * customer who types it is matched. Only a stopped command takes it (`commands.save_command`
	 * refuses an Active one, D-029 OQ-3); the payload carries the name and the synonyms only.
	 */
	whatsapp_next.messages.add_synonym = function (doc, after) {
		const text = (frappe.utils.html2text ? frappe.utils.html2text(doc.body || "") : doc.body || "").trim().split("\n")[0].slice(0, 140);
		const d = new frappe.ui.Dialog({
			title: __("Add as a synonym"),
			fields: [
				{ fieldtype: "Data", fieldname: "synonym", label: __("Synonym"), default: text, reqd: 1, description: __("Saved in lower case; it must not be another command's word.") },
				{
					fieldtype: "Link",
					fieldname: "command",
					label: __("Command"),
					options: "WhatsApp Command",
					reqd: 1,
					get_query: () => ({ filters: { status: "Inactive" } }),
					description: __("Only a stopped command can take a new synonym; start it again afterwards."),
				},
			],
			primary_action_label: __("Add synonym"),
			primary_action: async (values) => {
				const $btn = d.get_primary_btn().prop("disabled", true);
				try {
					const current = (await frappe.db.get_value("WhatsApp Command", values.command, "synonyms")).message || {};
					const words = (current.synonyms || "").split("\n").map((w) => w.trim()).filter(Boolean);
					if (!words.includes(values.synonym.trim())) words.push(values.synonym.trim());
					await ui.call("commands.save_command", { payload: { name: values.command, synonyms: words.join("\n") } });
					d.hide();
					ui.Toast.success(__("«{0}» now matches {1}", [values.synonym.trim(), values.command]));
					after && after();
				} catch (err) {
					$btn.prop("disabled", false);
					ui.Toast.error(err);
				}
			},
		});
		d.$wrapper.addClass("sanad-kit");
		d.show();
		return d;
	};

	/** Timeline rows `{at, text, tone}` from the `messages.get_outbound` payload. */
	whatsapp_next.messages.timeline_rows = function (doc) {
		const rows = [];
		const push = (at, text, tone) => at && rows.push({ at, text, tone });
		push(doc.creation, __("Created ({0})", [__(doc.source_type || "API")]), "gray");
		push(doc.queued_at, __("Queued"), "blue");
		push(doc.scheduled_at, __("Scheduled for {0}", [fmt.dt(doc.scheduled_at)]), "blue");
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

	/** Those rows as the drawer's activity block. */
	whatsapp_next.messages.activity = (doc) => whatsapp_next.messages.timeline_rows(doc).map((r) => ({ title: r.text, time: r.at, tone: r.tone, icon: TONE_ICON[r.tone] }));

	/** The document this message was sent about — its number, its type and its amount, as a row. */
	whatsapp_next.messages.render_reference = function ($el, doc) {
		const ref = doc.reference || {};
		ui.Render.mount(
			$el,
			{ doctype: ref.doctype, name: ref.name, amount: ref.amount },
			{
				doctype: ref.doctype,
				kind: "document",
				density: "row",
				profile: { title: () => ref.name, lines: [{ text: __(ref.doctype) }], value: ref.amount != null ? { value: ref.amount, df: { fieldtype: "Currency" } } : false, status: false },
			}
		);
	};

	/** Record drawer of one outbound row (used by the Outbound list, the Queue list and the form). */
	whatsapp_next.messages.open_outbound_drawer = function (name, { after_change, listview, extra_actions = [] } = {}) {
		const refresh = () => after_change && after_change();
		const drawer = new ui.Drawer({
			doctype: OUT,
			name,
			mode: "record",
			method: "messages.get_outbound",
			fields: DRAWER_FIELDS,
			listview,
			// document layout: the message says itself first, then the facts that explain it,
			// then who it went to, then everything else, then what happened to it.
			highlight: { field: "body", label: __("Message"), icon: ui.icons.quick_send },
			facts: [
				{ field: "message_type", icon: "es-line-chat" },
				{ field: "recipient_type", icon: "es-line-people" },
				{ field: "device", icon: "es-line-laptop" },
				{ field: "source_type", icon: "es-line-share" },
				{ field: "language", icon: "es-line-globe" },
				{ field: "attempts", icon: "es-line-reload" },
			],
			relations: [
				{
					field: "contact",
					doctype: "Contact",
					label: __("Contact"),
					actions: [
						{ icon: ui.icons.quick_send, label: __("Quick send"), condition: () => is_agent(), on_click: () => whatsapp_next.messages.quick_send(drawer.doc, refresh) },
						{ icon: "es-line-call", label: __("Open contact"), on_click: () => whatsapp_next.messages.open_contact(drawer.doc) },
					],
				},
			],
			activity: whatsapp_next.messages.activity,
			sections: [
				{ label: __("Reference"), icon: "es-line-article", condition: (d) => d.reference && d.reference.doctype && d.reference.name, render: whatsapp_next.messages.render_reference },
			],
			actions: [
				{ label: __("Resend"), icon: ui.icons.resend, condition: (d) => is_agent() && TERMINAL.includes(d.status), handler: (d) => whatsapp_next.messages.resend(d.name, refresh) },
				{ label: __("Quick send"), icon: ui.icons.quick_send, condition: () => is_agent(), handler: (d) => whatsapp_next.messages.quick_send(d, refresh) },
				{ label: __("Contact"), icon: "es-line-customer", handler: (d) => whatsapp_next.messages.open_contact(d) },
				{ label: __("Cancel"), icon: ui.icons.cancel, danger: true, condition: (d) => is_manager() && d.status === "Queued", handler: (d) => whatsapp_next.messages.cancel(d, () => { drawer.refresh(); refresh(); }) },
			].concat(extra_actions),
		});
		return drawer.show();
	};

	// ---- the list scaffold --------------------------------------------------------------------

	/**
	 * One message list: the toolbar and the table every message screen uses, so the screens differ
	 * only in what they are about.
	 *
	 * @param {Object} listview
	 * @param {Object} opts
	 * @param {{fields: string[], placeholder: string, fieldname?: string}} opts.search
	 * @param {Array<Object>} [opts.filters] — FilterBar presets between the search and the date filter
	 * @param {Object|false} [opts.date] — the date filter's options (`false` leaves it out)
	 * @param {Array<Object>} opts.columns — DataList columns (arrays are flattened, so
	 *   `whatsapp_next.columns.reference()` can be dropped in as one entry)
	 * @param {Function} opts.open — `(doc) => void` for the row click and the "View" button
	 * @param {string} [opts.realtime] — an event that refreshes the list, throttled
	 * @param {Function} [opts.count] — footer count (default: "{0} messages")
	 * @param {Object} [opts.empty] — empty state (default: "No messages match")
	 * @param {Array<string>} [opts.mobile_columns]
	 * @param {Array<Object>} [opts.bulk] — BulkActions actions
	 * @param {Array<{label: string, action: Function, condition?: Function}>} [opts.buttons] — inner page buttons
	 * @param {Object} [opts.datalist] — extra DataList options for a screen that needs them
	 *   (`selectable`, `expand`, …), merged over the defaults
	 * @returns {Object} the DataList instance
	 */
	whatsapp_next.screens.message_list = function (listview, opts = {}) {
		// No PageHeader: Desk's own page head already names the screen, and a second title above
		// the toolbar only repeated it (owner, 2026-09-23). The card starts at the toolbar.
		const presets = [];
		if (opts.search) presets.push(Object.assign({ type: "search", fieldname: "phone_e164" }, opts.search));
		(opts.filters || []).forEach((f) => presets.push(f));
		if (opts.date !== false) presets.push(Object.assign({ type: "date", label: __("Date"), default_op: "between" }, opts.date || {}));

		new ui.FilterBar(Object.assign({ listview, actions: ["group_by", "columns", "export"], presets }, opts.max_inline ? { max_inline: opts.max_inline } : {}));

		const list = new ui.DataList(
			Object.assign(
				{
					listview,
					columns: (opts.columns || []).flat(),
					row_action: { label: __("View"), handler: opts.open },
					on_row_click: opts.open,
					// grouping levels and pinning are driven from the toolbar / the column headers
					groupable: true,
					pinnable: true,
					mobile_columns: opts.mobile_columns,
					footer: { count: opts.count || ((total) => ui.plural(total, { one: __("{0} message"), other: __("{0} messages") })) },
					empty: opts.empty || { title: __("No messages match"), description: __("Change the filters or the period to see more.") },
				},
				opts.datalist || {}
			)
		);

		if (opts.bulk && opts.bulk.length) new ui.BulkActions({ listview, actions: opts.bulk });
		(opts.buttons || []).forEach((b) => {
			if (b.condition && !b.condition()) return;
			listview.page.add_inner_button(b.label, b.action);
		});
		if (opts.realtime) ui.bind_list_realtime(listview, opts.realtime, 2000);
		return list;
	};

	whatsapp_next.messages.is_agent = is_agent;
	whatsapp_next.messages.is_manager = is_manager;
	whatsapp_next.messages.TERMINAL = TERMINAL;
})();

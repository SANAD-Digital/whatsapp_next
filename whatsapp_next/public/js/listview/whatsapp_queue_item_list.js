// WhatsApp Queue Item list — screen 9 (09 §1B/§1C row 9), minimal phase-5 version: the live
// default filter (Queued / Sending / Paused) on first load, status colours, RowActions and native
// BulkActions over `queue.*_items` / `retry_dead_letter`, row click → Drawer of the linked
// outbound message (shared `whatsapp_next.messages` helpers, loaded on demand) and the
// `wa:queue:progress` throttled refresh.

(function () {
	const ui = sanad.ui;
	const DT = "WhatsApp Queue Item";
	const MANAGER_ROLES = ["WhatsApp Manager", "System Manager"];
	const LIVE = ["Queued", "Sending", "Paused"];

	const is_manager = () => frappe.user.has_role(MANAGER_ROLES);
	const count_of = (docs, statuses) => docs.filter((d) => statuses.includes(d.status)).length;
	const with_helpers = () =>
		whatsapp_next.messages && whatsapp_next.messages.open_outbound_drawer
			? Promise.resolve()
			: frappe.require("/assets/whatsapp_next/js/listview/whatsapp_log_list.js");

	const run = (method, args, message, after) =>
		ui.call(method, args)
			.then((r) => {
				ui.Toast.success(typeof message === "function" ? message(r) : message);
				after && after(r);
				return r;
			})
			.catch((err) => {
				if (err && err.message !== "cancelled") ui.Toast.error(err);
			});

	/** Cancel through the shared outbound helper (same dialog everywhere). */
	const cancel_one = (doc, after) => {
		if (!doc.outbound_message) {
			ui.Toast.info(__("This queue item has no message linked to it."));
			return;
		}
		return with_helpers().then(() =>
			whatsapp_next.messages.cancel({ name: doc.outbound_message, display_name: doc.display_name, phone_e164: doc.phone_e164, status: doc.status }, after)
		);
	};

	const open_drawer = (doc, refresh, listview) => {
		if (!doc.outbound_message) {
			ui.Toast.info(__("This queue item has no message linked to it."));
			return;
		}
		return with_helpers().then(() => whatsapp_next.messages.open_outbound_drawer(doc.outbound_message, { after_change: refresh, listview }));
	};

	frappe.listview_settings[DT] = {
		hide_name_column: true,
		add_fields: ["status", "outbound_message", "device", "campaign", "phone_e164", "display_name", "priority", "scheduled_at", "attempts", "max_attempts", "last_error_code"],

		// The one status → colour rule; badges read it through `sanad.ui.indicator_for`.
		get_indicator(doc) {
			const colour = { Queued: "blue", Sending: "blue", Paused: "orange", Completed: "green", Deleted: "gray", "Dead Letter": "red" }[doc.status] || "gray";
			return [__(doc.status), colour, `status,=,${doc.status}`];
		},

		formatters: {
			status(value, df, doc) {
				const ind = ui.indicator_for(DT, Object.assign({ doctype: DT }, doc));
				return ui.StatusBadge.html({ label: __(value), colour: ind.colour });
			},
		},

		onload(listview) {
			const refresh = () => listview.refresh();
			const settings = frappe.listview_settings[DT];

			// Default to the live statuses once per session (the user may clear it afterwards).
			if (!settings._defaulted && !frappe.route_options && !listview.filter_area.get().some((f) => f[1] === "status")) {
				settings._defaulted = true;
				listview.filter_area.add([[DT, "status", "in", LIVE]]);
			}

			if (is_manager()) {
				listview._sanad_row_actions = new ui.RowActions({
					listview,
					actions: [
						{ label: __("Pause"), icon: "es-line-time", condition: (doc) => doc.status === "Queued", handler: (doc) => run("queue.pause_items", { names: [doc.name] }, __("Message paused"), refresh) },
						{ label: __("Resume"), icon: "es-line-zap", condition: (doc) => doc.status === "Paused", handler: (doc) => run("queue.resume_items", { names: [doc.name] }, __("Message resumed"), refresh) },
						{ label: __("Retry"), icon: ui.icons.resend, condition: (doc) => doc.status === "Dead Letter", handler: (doc) => run("queue.retry_dead_letter", { names: [doc.name] }, __("Message re-queued"), refresh) },
						{ label: __("Cancel"), icon: ui.icons.cancel, danger: true, condition: (doc) => ["Queued", "Paused"].includes(doc.status), handler: (doc) => cancel_one(doc, refresh) },
					],
					on_row_click: (doc) => open_drawer(doc, refresh, listview),
				});

				const plural = (n, one, other) => ui.plural(n, { one, other });
				new ui.BulkActions({
					listview,
					actions: [
						{
							label: (n) => (n ? __("Pause ({0})", [ui.format_int(n)]) : __("Pause")),
							method: "queue.pause_items",
							condition: (docs) => count_of(docs, ["Queued"]) > 0,
							args: (names, { docs }) => ({ names: docs.filter((d) => d.status === "Queued").map((d) => d.name) }),
							success: (r) => plural(r.count || 0, __("{0} message paused"), __("{0} messages paused")),
						},
						{
							label: (n) => (n ? __("Resume ({0})", [ui.format_int(n)]) : __("Resume")),
							method: "queue.resume_items",
							condition: (docs) => count_of(docs, ["Paused"]) > 0,
							args: (names, { docs }) => ({ names: docs.filter((d) => d.status === "Paused").map((d) => d.name) }),
							success: (r) => plural(r.count || 0, __("{0} message resumed"), __("{0} messages resumed")),
						},
						{
							label: (n) => (n ? __("Retry after giving up ({0})", [ui.format_int(n)]) : __("Retry after giving up")),
							method: "queue.retry_dead_letter",
							condition: (docs) => count_of(docs, ["Dead Letter"]) > 0,
							args: (names, { docs }) => ({ names: docs.filter((d) => d.status === "Dead Letter").map((d) => d.name) }),
							success: (r) => plural(r.count || 0, __("{0} message re-queued"), __("{0} messages re-queued")),
						},
						{
							label: (n) => (n ? __("Cancel ({0})", [ui.format_int(n)]) : __("Cancel")),
							method: "queue.delete_items",
							condition: (docs) => count_of(docs, ["Queued", "Paused"]) > 0,
							confirm: (names, docs) => {
								const n = count_of(docs, ["Queued", "Paused"]);
								return {
									title: plural(n, __("Cancel {0} message?"), __("Cancel {0} messages?")),
									message: __("The messages leave the queue and their status becomes Cancelled."),
									impact: [
										{ label: __("Will be cancelled"), value: ui.format_int(n), tone: "red" },
										{ label: __("Ignored (already sent or removed)"), value: ui.format_int(names.length - n) },
									],
									reason_field: true,
									ack_checkbox: __("I understand these messages will not be sent."),
									danger: true,
									confirm_label: __("Cancel messages"),
									cancel_label: __("Keep them"),
								};
							},
							args: (names, { docs }) => ({ names: docs.filter((d) => ["Queued", "Paused"].includes(d.status)).map((d) => d.name) }),
							success: (r) => plural(r.count || 0, __("{0} message cancelled"), __("{0} messages cancelled")),
						},
					],
				});
			} else {
				listview._sanad_row_actions = new ui.RowActions({ listview, actions: [], on_row_click: (doc) => open_drawer(doc, refresh, listview) });
			}

			ui.bind_list_realtime(listview, "wa:queue:progress", 2000);
		},

		refresh(listview) {
			listview && listview._sanad_row_actions && listview._sanad_row_actions.decorate();
		},
	};
})();

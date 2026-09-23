// WhatsApp Notification list (09 row 10b, D-064: the prototype "Notification templates" screen):
// PageHeader (title, "+ New notification", KPIs Notifications · Enabled · Sent (30 days) · On a
// disconnected device) → FilterBar (search, document type, status, device, event) → DataList
// (Notification · Document type · Status toggle · Device avatar · Variables · Sent · Last updated ·
// View → form). The status chip toggles `enabled` through `frappe.client.set_value` after a
// ConfirmDialog. PageHeader / DataList are guarded with `typeof`; native rows render until they land.

const DOCTYPE = "WhatsApp Notification";
const has_kit = (name) => typeof sanad.ui[name] === "function";
const days_ago = (n) => frappe.datetime.add_days(frappe.datetime.now_date(), -n);

function open_form(doc) {
	frappe.set_route("Form", DOCTYPE, doc.name);
}

/** Enable / disable one row with a confirmation, then refresh the list. */
function toggle_enabled(doc, listview) {
	const enable = !cint(doc.enabled);
	const title = doc.notification_name || doc.name;
	return sanad.ui.ConfirmDialog.ask({
		title: enable ? __("Enable {0}?", [title]) : __("Disable {0}?", [title]),
		message: enable
			? __("Messages will be sent automatically when the event happens.")
			: __("No messages will be sent for this event until it is enabled again."),
		impact: [
			{ label: __("Document type"), value: __(doc.document_type || "") },
			{ label: __("Device"), value: doc.device || "—" },
		],
		confirm_label: enable ? __("Enable") : __("Disable"),
		danger: !enable,
		on_confirm: () => frappe.xcall("frappe.client.set_value", { doctype: DOCTYPE, name: doc.name, fieldname: "enabled", value: enable ? 1 : 0 }),
	})
		.then(() => {
			sanad.ui.Toast.success(enable ? __("Notification enabled") : __("Notification disabled"));
			listview.refresh();
			listview._sanad_header && listview._sanad_header.refresh();
		})
		.catch(() => {});
}

/** Status chip that doubles as the enable / disable toggle (mouse + keyboard). */
function status_chip(doc, can_write) {
	const enabled = !!cint(doc.enabled);
	const badge = sanad.ui.StatusBadge.html({ label: enabled ? __("Enabled") : __("Disabled"), colour: enabled ? "green" : "gray" });
	if (!can_write) return badge;
	return `<button type="button" class="btn btn-link p-0 wa-toggle-enabled" data-name="${frappe.utils.escape_html(doc.name)}" aria-pressed="${enabled}" aria-label="${frappe.utils.escape_html(enabled ? __("Enabled — click to disable") : __("Disabled — click to enable"))}">${badge}</button>`;
}

/** Enabled notifications whose device is not Connected (their messages wait in the queue). */
function count_on_disconnected_device() {
	return Promise.all([
		frappe.db.get_list("WhatsApp Device", { fields: ["name", "status"], limit: 500 }),
		frappe.db.get_list(DOCTYPE, { fields: ["name", "device"], filters: { enabled: 1 }, limit: 500 }),
	]).then(([devices, rows]) => {
		const offline = new Set((devices || []).filter((d) => d.status !== "Connected").map((d) => d.name));
		const value = (rows || []).filter((r) => r.device && offline.has(r.device)).length;
		return { value, tone: value ? "amber" : "gray" };
	});
}

const STATS = () => [
	{
		key: "notifications",
		label: __("Notifications"),
		icon: "es-line-notifications",
		value: () =>
			Promise.all([
				frappe.db.count(DOCTYPE),
				frappe.db.get_list(DOCTYPE, { fields: ["document_type"], group_by: "document_type", limit: 200 }),
			]).then(([total, rows]) => ({ value: total, types: (rows || []).filter((r) => r.document_type).length })),
		sub: (value, raw) => sanad.ui.plural((raw && raw.types) || 0, { one: __("{0} document type"), other: __("{0} document types") }),
	},
	{
		key: "enabled",
		label: __("Enabled"),
		icon: "es-line-success",
		tone: "green",
		value: () =>
			Promise.all([frappe.db.count(DOCTYPE, { filters: { enabled: 1 } }), frappe.db.count(DOCTYPE, { filters: { enabled: 0 } })]).then(
				([on, off]) => ({ value: on, tone: "green", disabled: off })
			),
		sub: (value, raw) => sanad.ui.plural((raw && raw.disabled) || 0, { one: __("{0} disabled"), other: __("{0} disabled") }),
	},
	{
		key: "sent",
		label: __("Sent (30 days)"),
		icon: "es-line-chat",
		tone: "blue",
		count: { doctype: "WhatsApp Log", filters: { notification: ["is", "set"], creation: [">=", days_ago(30)] } },
		sub: __("Messages sent through a notification"),
		onclick: () => frappe.set_route("List", "WhatsApp Log", { notification: ["is", "set"] }),
	},
	{
		key: "offline",
		label: __("On a disconnected device"),
		icon: "es-line-mobile",
		value: count_on_disconnected_device,
		sub: (value) => (value ? __("Their messages stay in the queue") : __("Every linked device is connected")),
		onclick: () => frappe.set_route((sanad.ui.config.defaults || {}).devices_route || "wa-devices"),
	},
];

const COLUMNS = (can_write) => [
	{ fieldname: "notification_name", label: __("Notification"), sortable: true, format: (v, doc) => `<strong>${frappe.utils.escape_html(v || doc.name)}</strong>` },
	{ fieldname: "document_type", label: __("Document type"), sortable: true, format: (v) => frappe.utils.escape_html(v ? __(v) : "") },
	{ fieldname: "enabled", label: __("Status"), sortable: true, format: (v, doc) => status_chip(doc, can_write) },
	{ fieldname: "device", label: __("Device"), type: "avatar", sortable: true },
	{ fieldname: "variables_count", label: __("Variables"), type: "number", align: "end", sortable: true, hidden_xs: true },
	{ fieldname: "send_count", label: __("Sent"), type: "number", align: "end", sortable: true },
	{ fieldname: "modified", label: __("Last updated"), type: "date", sortable: true, hidden_xs: true, format: (v) => (v ? frappe.datetime.str_to_user(v, false, true) : "") },
];

frappe.listview_settings[DOCTYPE] = {
	add_fields: ["notification_name", "enabled", "document_type", "event", "device", "variables_count", "send_count", "last_sent_at", "modified"],

	get_indicator(doc) {
		return cint(doc.enabled) ? [__("Enabled"), "green", "enabled,=,1"] : [__("Disabled"), "gray", "enabled,=,0"];
	},

	onload(listview) {
		const can_write = frappe.perm.has_perm(DOCTYPE, 0, "write");
		if (!listview.view_user_settings.sort_by) {
			listview.sort_by = "modified";
			listview.sort_order = "desc";
		}

		const has_header = has_kit("PageHeader");
		if (has_header) {
			listview._sanad_header = new sanad.ui.PageHeader({
				listview,
				title: __("Notifications"),
				description: __("Each notification ties a document event to a message sent automatically from a chosen device."),
				primary: { label: __("New notification"), icon: "es-line-add", perm: "create", handler: () => frappe.new_doc(DOCTYPE) },
				stats: STATS(),
				events: { "wa:device:status": (data, header) => header.refresh() },
			});
		}

		if (has_kit("FilterBar")) {
			new sanad.ui.FilterBar({
				listview,
				actions: ["group_by", "export"],
				intro: has_header ? null : __("Each notification ties a document event to a message sent automatically from a chosen device."),
				presets: [
					{ fieldname: "notification_name", type: "search", fields: ["notification_name", "document_type", "message"], placeholder: __("Search name, document type or text…") },
					{ fieldname: "document_type", type: "select" },
					{ fieldname: "enabled", type: "select", label: __("Status") },
					{ fieldname: "device", type: "select" },
					{ fieldname: "event", type: "select", label: __("Event") },
				],
			});
		}

		if (has_kit("DataList")) {
			listview._sanad_datalist = new sanad.ui.DataList({
				listview,
				columns: COLUMNS(can_write),
				selectable: true,
				page_length: 20,
				row_action: { label: __("View"), handler: open_form },
				on_row_click: open_form,
				footer: { count: (total) => sanad.ui.plural(total, { one: __("{0} notification"), other: __("{0} notifications") }) },
				empty: {
					title: __("No notifications yet"),
					description: __("Send a message automatically when a document is created, submitted or becomes due."),
					action: frappe.perm.has_perm(DOCTYPE, 0, "create") ? { label: __("New notification"), onclick: () => frappe.new_doc(DOCTYPE) } : null,
				},
				mobile: "cards",
			});
		} else if (has_kit("RowActions")) {
			new sanad.ui.RowActions({
				listview,
				actions: [
					{ label: __("Enable"), icon: "es-line-success", condition: (doc) => can_write && !cint(doc.enabled), handler: (doc) => toggle_enabled(doc, listview) },
					{ label: __("Disable"), icon: sanad.ui.icons.cancel, condition: (doc) => can_write && !!cint(doc.enabled), handler: (doc) => toggle_enabled(doc, listview) },
					{ label: __("Open"), icon: sanad.ui.icons.open, handler: open_form },
				],
				on_row_click: open_form,
			});
		}

		// Status chip toggle inside DataList rows (delegated: rows re-render on every refresh).
		listview.$result.off("click.wanotification").on("click.wanotification", ".wa-toggle-enabled", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const name = $(e.currentTarget).data("name");
			const doc = (listview.data || []).find((d) => d.name === name);
			if (doc) toggle_enabled(doc, listview);
		});
	},
};

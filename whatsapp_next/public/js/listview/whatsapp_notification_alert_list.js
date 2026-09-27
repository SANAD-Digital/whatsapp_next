// WhatsApp Notification Alert list (09 row 10c, D-064: same anatomy as the prototype
// "Notification templates" screen): PageHeader (title, "+ New alert", KPIs Alerts · Enabled ·
// Sent · Due in 24 hours) → FilterBar (search, periodicity, status, device, content type) →
// DataList (Alert · Periodicity · Content · Status toggle · Device avatar · Sent · Next run ·
// Last updated · View → the alert editor window, D-139). PageHeader / DataList are guarded with `typeof`.

const DOCTYPE = "WhatsApp Notification Alert";
const has_kit = (name) => typeof sanad.ui[name] === "function";

// a row, "View" and "New alert" open the alert editor window (D-139); the form stays one click away in it
function open_form(doc) {
	whatsapp_next.alerts.open(doc.name);
}

function new_alert() {
	whatsapp_next.alerts.open(null);
}

function toggle_enabled(doc, listview) {
	const enable = !cint(doc.enabled);
	const title = doc.alert_name || doc.name;
	return sanad.ui.ConfirmDialog.ask({
		title: enable ? __("Enable {0}?", [title]) : __("Disable {0}?", [title]),
		message: enable
			? __("The alert will run on its schedule and send its report or message.")
			: __("The alert will not run until it is enabled again."),
		impact: [
			{ label: __("Periodicity"), value: __(doc.periodicity || "") },
			{ label: __("Device"), value: doc.device || "—" },
		],
		confirm_label: enable ? __("Enable") : __("Disable"),
		danger: !enable,
		on_confirm: () => frappe.xcall("frappe.client.set_value", { doctype: DOCTYPE, name: doc.name, fieldname: "enabled", value: enable ? 1 : 0 }),
	})
		.then(() => {
			sanad.ui.Toast.success(enable ? __("Alert enabled") : __("Alert disabled"));
			listview.refresh();
			listview._sanad_header && listview._sanad_header.refresh();
		})
		.catch(() => {});
}

function status_chip(doc, can_write) {
	const enabled = !!cint(doc.enabled);
	const badge = sanad.ui.StatusBadge.html({ label: enabled ? __("Enabled") : __("Disabled"), colour: enabled ? "green" : "gray" });
	if (!can_write) return badge;
	return `<button type="button" class="btn btn-link p-0 wa-toggle-enabled" data-name="${frappe.utils.escape_html(doc.name)}" aria-pressed="${enabled}" aria-label="${frappe.utils.escape_html(enabled ? __("Enabled — click to disable") : __("Disabled — click to enable"))}">${badge}</button>`;
}

const STATS = () => [
	{
		key: "alerts",
		label: __("Alerts"),
		icon: "es-line-reports",
		value: () =>
			Promise.all([frappe.db.count(DOCTYPE), frappe.db.count(DOCTYPE, { filters: { content_type: "Report" } })]).then(
				([total, reports]) => ({ value: total, reports })
			),
		sub: (value, raw) => sanad.ui.plural((raw && raw.reports) || 0, { one: __("{0} report alert"), other: __("{0} report alerts") }),
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
		label: __("Sent"),
		icon: "es-line-chat",
		tone: "blue",
		sum: { doctype: DOCTYPE, field: "send_count" },
		sub: __("Messages sent by alerts"),
		onclick: () => frappe.set_route("List", "WhatsApp Log", { notification_alert: ["is", "set"] }),
	},
	{
		key: "due",
		label: __("Due in 24 hours"),
		icon: "es-line-time",
		tone: "amber",
		count: {
			doctype: DOCTYPE,
			filters: { enabled: 1, next_run_at: ["between", [frappe.datetime.now_datetime(), frappe.datetime.add_days(frappe.datetime.now_datetime(), 1)]] },
		},
		sub: __("Scheduled to run within the next day"),
	},
];

const COLUMNS = (can_write) => [
	{ fieldname: "alert_name", label: __("Alert"), sortable: true, format: (v, doc) => `<strong>${frappe.utils.escape_html(v || doc.name)}</strong>` },
	{ fieldname: "periodicity", label: __("Periodicity"), sortable: true, format: (v) => frappe.utils.escape_html(v ? __(v) : "") },
	{
		fieldname: "report",
		label: __("Content"),
		sortable: true,
		hidden_xs: true,
		format: (v, doc) => frappe.utils.escape_html(doc.content_type === "Report" ? v || __("Report") : __("Static message")),
	},
	{ fieldname: "enabled", label: __("Status"), sortable: true, format: (v, doc) => status_chip(doc, can_write) },
	{ fieldname: "device", label: __("Device"), type: "avatar", sortable: true },
	{ fieldname: "send_count", label: __("Sent"), type: "number", align: "end", sortable: true },
	{ fieldname: "next_run_at", label: __("Next run"), type: "date", sortable: true, format: (v) => (v ? frappe.datetime.str_to_user(v) : "") },
	{ fieldname: "modified", label: __("Last updated"), type: "date", sortable: true, hidden_xs: true, format: (v) => (v ? frappe.datetime.str_to_user(v, false, true) : "") },
];

frappe.listview_settings[DOCTYPE] = {
	add_fields: ["alert_name", "enabled", "periodicity", "content_type", "report", "device", "send_count", "next_run_at", "last_sent_at", "modified"],

	get_indicator(doc) {
		return cint(doc.enabled) ? [__("Enabled"), "green", "enabled,=,1"] : [__("Disabled"), "gray", "enabled,=,0"];
	},

	onload(listview) {
		const can_write = frappe.perm.has_perm(DOCTYPE, 0, "write");
		if (!listview.view_user_settings.sort_by) {
			listview.sort_by = "next_run_at";
			listview.sort_order = "asc";
		}

		const has_header = has_kit("PageHeader");
		if (has_header) {
			listview._sanad_header = new sanad.ui.PageHeader({
				listview,
				title: __("Notification alerts"),
				description: __("Reports and messages sent on a schedule — daily, weekly, monthly — from a chosen device."),
				primary: { label: __("New alert"), icon: "es-line-add", perm: "create", handler: new_alert },
				stats: STATS(),
			});
		}

		if (has_kit("FilterBar")) {
			new sanad.ui.FilterBar({
				listview,
				actions: ["group_by", "export"],
				intro: has_header ? null : __("Reports and messages sent on a schedule from a chosen device."),
				presets: [
					{ fieldname: "alert_name", type: "search", fields: ["alert_name", "report", "message"], placeholder: __("Search alert name, report or text…") },
					{ fieldname: "periodicity", type: "select" },
					{ fieldname: "enabled", type: "select", label: __("Status") },
					{ fieldname: "device", type: "select" },
					{ fieldname: "content_type", type: "select" },
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
				footer: { count: (total) => sanad.ui.plural(total, { one: __("{0} alert"), other: __("{0} alerts") }) },
				empty: {
					title: __("No alerts yet"),
					description: __("Send a report or a message on a schedule to a group of numbers."),
					action: frappe.perm.has_perm(DOCTYPE, 0, "create") ? { label: __("New alert"), onclick: new_alert } : null,
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

		listview.$result.off("click.waalert").on("click.waalert", ".wa-toggle-enabled", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const name = $(e.currentTarget).data("name");
			const doc = (listview.data || []).find((d) => d.name === name);
			if (doc) toggle_enabled(doc, listview);
		});
	},
};

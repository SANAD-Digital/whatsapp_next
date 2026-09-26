// WhatsApp Number list (09 row 13, D-064 option A: the prototype "WhatsApp contacts" screen):
// PageHeader (title, "Open contacts", four KPIs) → FilterBar (grouped by `link_status`) →
// DataList (avatar name, number, link status, contact, last message, since, View → conversation
// drawer). PageHeader / DataList are guarded with `typeof` — until they land the native rows,
// RowActions and the FilterBar intro render instead. Numbers are materialised from messages, so
// there is no "New" button. The actions and the link / convert dialog live in `screens/numbers.js`.

const AGENT_ROLES = ["WhatsApp Agent", "WhatsApp Manager"];
const CONTACT_ROLES = ["WhatsApp Contact User", "WhatsApp Manager", "WhatsApp Agent"];
const DOCTYPE = "WhatsApp Number";

const has_kit = (name) => typeof sanad.ui[name] === "function";

const { open_conversation, quick_send, confirm_conversation, unlink_number, link_convert_dialog } = whatsapp_next.numbers;

const ROW_ACTIONS = (listview) => [
	{
		label: __("Open contact"),
		icon: "es-line-customer",
		condition: (doc) => !!doc.contact,
		handler: (doc) => frappe.set_route("Form", "Contact", doc.contact),
	},
	{
		label: __("Add as contact"),
		icon: "es-line-add-people",
		condition: (doc) => !doc.contact && doc.number_type === "Individual" && frappe.user.has_role(CONTACT_ROLES),
		handler: (doc) => link_convert_dialog(doc, () => listview.refresh()),
	},
	{
		label: __("Open conversation"),
		icon: sanad.ui.icons.conversation,
		condition: () => true,
		handler: (doc) => open_conversation(doc, listview),
	},
	{
		label: __("Quick send"),
		icon: sanad.ui.icons.quick_send,
		condition: (doc) => typeof sanad.ui.QuickSend === "function" && doc.number_type !== "LID" && frappe.user.has_role(AGENT_ROLES),
		handler: (doc) => quick_send(doc),
	},
	{
		label: __("Confirm conversation"),
		icon: "es-line-success",
		condition: (doc) => doc.number_type === "Individual" && frappe.user.has_role(AGENT_ROLES),
		handler: (doc) => confirm_conversation(doc, listview),
	},
	{
		label: __("Unlink"),
		icon: sanad.ui.icons.cancel,
		condition: (doc) => !!doc.contact && frappe.user.has_role("WhatsApp Manager"),
		handler: (doc) => unlink_number(doc, listview),
	},
];

/** KPI cards of the prototype header (client-side counts — no dedicated API). */
const STATS = () => [
	{
		key: "conversations",
		label: __("WhatsApp conversations"),
		icon: "es-line-chat-alt",
		count: { doctype: DOCTYPE },
		sub: __("Numbers that exchanged at least one message with us"),
	},
	{
		key: "registered",
		label: __("Registered in the system"),
		icon: "es-line-success",
		tone: "green",
		count: { doctype: DOCTYPE, filters: { link_status: "Linked" } },
		sub: __("The number has a contact"),
	},
	{
		key: "unknown",
		label: __("Unknown"),
		icon: "es-line-alert-triangle",
		tone: "amber",
		count: { doctype: DOCTYPE, filters: { link_status: "Not Linked" } },
		sub: __("Creating a contact is suggested"),
	},
	{
		key: "rate",
		label: __("Registration rate"),
		icon: "es-line-chart",
		tone: "blue",
		value: () =>
			Promise.all([frappe.db.count(DOCTYPE), frappe.db.count(DOCTYPE, { filters: { link_status: "Linked" } })]).then(
				([total, linked]) => (total ? Math.round((linked / total) * 100) : 0)
			),
		format: (v) => __("{0}%", [sanad.ui.format_int(v || 0)]),
		sub: __("Of WhatsApp conversations"),
	},
];

/** Columns of the prototype table (proto-numbers): name (avatar) · number · link status · contact · last message · since. */
const COLUMNS = () => [
	{
		fieldname: "display_name",
		label: __("Name in WhatsApp"),
		type: "avatar",
		sortable: true,
		format: (value, doc) => frappe.utils.escape_html(value || doc.phone_e164 || doc.jid || doc.name),
	},
	{
		fieldname: "phone_e164",
		label: __("Number"),
		sortable: true,
		format: (value, doc) => `<span class="sanad-tabular" dir="ltr">${frappe.utils.escape_html(value || doc.jid || "")}</span>`,
	},
	{
		fieldname: "link_status",
		label: __("Link status"),
		sortable: true,
		// neutral gray "Not linked" without a warning icon (design gate), green check when linked
		format: (value) => sanad.ui.ConversationDrawer.link_badge(value === "Linked"),
	},
	{ fieldname: "contact", label: __("Contact in the system"), type: "link", sortable: true, hidden_xs: true },
	{ fieldname: "last_seen", label: __("Last message"), type: "date", sortable: true, format: (v) => (v ? frappe.datetime.str_to_user(v) : "") },
	{
		fieldname: "since",
		label: __("Since"),
		sortable: false,
		hidden_xs: true,
		format: (value, doc) => (doc.last_seen ? frappe.utils.escape_html(frappe.datetime.prettyDate(doc.last_seen)) : ""),
	},
];

frappe.listview_settings[DOCTYPE] = {
	hide_name_column: true,
	add_fields: ["phone_e164", "jid", "display_name", "contact", "link_status", "number_type", "last_device", "last_seen", "conversation_confirmed"],

	get_indicator(doc) {
		// "Not linked" is a neutral state, not a warning → gray.
		return doc.link_status === "Linked"
			? [__("Linked"), "green", "link_status,=,Linked"]
			: [__("Not linked"), "gray", "link_status,=,Not Linked"];
	},

	onload(listview) {
		// Numbers are materialised from messages — never created by hand. `can_create = false`
		// makes Desk's own `set_primary_action()` clear the button on every refresh / unselect.
		listview.can_create = false;
		listview.page.clear_primary_action();
		if (!listview.view_user_settings.sort_by) {
			listview.sort_by = "last_seen";
			listview.sort_order = "desc";
		}

		const has_header = has_kit("PageHeader");
		if (has_header) {
			listview._sanad_header = new sanad.ui.PageHeader({
				listview,
				title: __("WhatsApp contacts"),
				description: __("Numbers that exchanged at least one message with us: linked to a contact in the system, or unknown and suggested for creation."),
				primary: {
					label: __("Open contacts"),
					icon: "es-line-people",
					handler: () => frappe.set_route((sanad.ui.config.defaults || {}).contacts_route || "wa-contacts"),
				},
				stats: STATS(),
				events: { "wa:inbound:received": (data, header) => header.refresh(true) },
			});
		}

		if (has_kit("FilterBar")) {
			new sanad.ui.FilterBar({
				listview,
				actions: ["group_by", "export"],
				intro: has_header ? null : __("Every number you have exchanged messages with. Link it to a contact or open the conversation."),
				presets: [
					{ fieldname: "phone_e164", type: "search", fields: ["phone_e164", "display_name"], placeholder: __("Search name or number…") },
					{ fieldname: "link_status", type: "select", label: __("Link status") },
					{ fieldname: "number_type", type: "select" },
					{ fieldname: "last_device", type: "select" },
					{ fieldname: "last_direction", type: "select" },
					{ fieldname: "conversation_confirmed", type: "select", label: __("Confirmed") },
					{ fieldname: "last_seen", type: "period", label: __("Last seen") },
				],
			});
		}

		if (has_kit("DataList")) {
			listview._sanad_datalist = new sanad.ui.DataList({
				listview,
				group_by: ["link_status"], // the rail this list used to carry, now real group rows
				columns: COLUMNS(),
				selectable: true,
				page_length: 20,
				row_action: { label: __("View"), handler: (doc) => open_conversation(doc, listview) },
				on_row_click: (doc) => open_conversation(doc, listview),
				footer: { count: (total) => sanad.ui.plural(total, { one: __("{0} number"), other: __("{0} numbers") }) },
				empty: {
					title: __("No numbers yet"),
					description: __("Numbers appear here after the first message is sent or received."),
				},
				mobile: "cards",
			});
		} else {
			mount_native_rows(listview);
		}

		// Bulk convert (09 G-01): one Contact per unknown individual number, named after its WhatsApp name.
		if (has_kit("BulkActions") && frappe.user.has_role(CONTACT_ROLES)) {
			const unknown = (docs) => docs.filter((d) => !d.contact && d.number_type === "Individual");
			new sanad.ui.BulkActions({
				listview,
				actions: [
					{
						label: (n) => (n ? __("Create contacts ({0})", [sanad.ui.format_int(n)]) : __("Create contacts")),
						condition: (docs) => unknown(docs).length > 0,
						confirm: (names, docs) => {
							const count = unknown(docs).length;
							return {
								title: sanad.ui.plural(count, { one: __("Create a contact for {0} unknown number?"), other: __("Create contacts for {0} unknown numbers?") }),
								message: __("Each contact is named after the name the number uses on WhatsApp; you can rename it later."),
								impact: [
									{ label: __("Contacts to create"), value: sanad.ui.format_int(count), tone: "green" },
									{ label: __("Skipped (already linked or not a person)"), value: sanad.ui.format_int(names.length - count) },
								],
								confirm_label: __("Create contacts"),
							};
						},
						handler: (names, docs) =>
							sanad.ui.call(
								"numbers.convert_many",
								{ phone_e164s: unknown(docs).map((d) => d.phone_e164 || d.name) },
								{ freeze: true, freeze_message: __("Creating contacts…") }
							),
						success: (r) => sanad.ui.plural(r.count || 0, { one: __("{0} contact created"), other: __("{0} contacts created") }),
					},
				],
			});
		}

		// Realtime: a new inbound message may add or move a row — throttled, only while this list is shown.
		sanad.ui.bind_list_realtime(listview, "wa:inbound:received", 3000);
	},

	refresh(listview) {
		listview.page.clear_primary_action();
	},
};

/** Fallback until DataList lands: native rows + RowActions + whole-row click / Enter. */
function mount_native_rows(listview) {
	const has_row_actions = has_kit("RowActions");
	if (has_row_actions) {
		new sanad.ui.RowActions({
			listview,
			actions: ROW_ACTIONS(listview),
			on_row_click: (doc) => open_conversation(doc, listview),
		});
	}
	const doc_of = (el) => {
		const name = sanad.ui.docname_of_row($(el));
		return (listview.data || []).find((d) => d.name === name);
	};
	const is_control = ($t) =>
		$t.is(":checkbox") ||
		$t.closest("a, button, input, select, .sanad-rowactions, [data-toggle='dropdown'], .filterable, .list-row-like, .select-like, .level-right .checkbox").length > 0;
	listview.$result.off("click.sanadnumbers keydown.sanadnumbers");
	listview.$result.on("click.sanadnumbers", ".list-row-container", (e) => {
		if (e.ctrlKey || e.metaKey || e.isDefaultPrevented()) return;
		const $t = $(e.target);
		if (is_control($t)) return;
		if (has_row_actions && $t.closest(".list-row").length) return; // RowActions already handles `.list-row`
		const doc = doc_of(e.currentTarget);
		if (doc) open_conversation(doc, listview);
	});
	listview.$result.on("keydown.sanadnumbers", ".list-row-container", (e) => {
		if (e.key !== "Enter" && e.key !== " ") return;
		if (e.target !== e.currentTarget) return; // only when the row itself is focused
		e.preventDefault();
		const doc = doc_of(e.currentTarget);
		if (doc) open_conversation(doc, listview);
	});
}

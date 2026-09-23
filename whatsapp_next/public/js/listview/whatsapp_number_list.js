// WhatsApp Number list (09 row 13, D-064 option A: the prototype "WhatsApp contacts" screen):
// PageHeader (title, "Open contacts", four KPIs) → FilterBar → TreeGroupBy on `link_status` →
// DataList (avatar name, number, link status, contact, last message, since, View → conversation
// drawer). PageHeader / DataList are guarded with `typeof` — until they land the native rows,
// RowActions and the FilterBar intro render instead. Numbers are materialised from messages, so
// there is no "New" button. The link / convert dialog is page-local for now.

const AGENT_ROLES = ["WhatsApp Agent", "WhatsApp Manager"];
const CONTACT_ROLES = ["WhatsApp Contact User", "WhatsApp Manager", "WhatsApp Agent"];
const DOCTYPE = "WhatsApp Number";

const has_kit = (name) => typeof sanad.ui[name] === "function";

function open_conversation(doc, listview) {
	return sanad.ui.ConversationDrawer.open({
		key: doc.phone_e164 || doc.jid || doc.name,
		device: doc.last_device || undefined,
		on_link: (number) => link_convert_dialog(number || doc, () => listview && listview.refresh()),
		on_close: () => listview && listview.refresh(),
	});
}

function quick_send(doc) {
	if (typeof sanad.ui.QuickSend !== "function") return;
	const args = { device: doc.last_device || undefined };
	if (doc.phone_e164) args.phone = doc.phone_e164;
	else if (doc.jid) args.jid = doc.jid;
	new sanad.ui.QuickSend(args);
}

function confirm_conversation(doc, listview) {
	return sanad.ui.ConversationDrawer.confirm_dialog(doc)
		.then(() => listview.refresh())
		.catch(() => {});
}

function unlink_number(doc, listview) {
	return sanad.ui.ConfirmDialog.ask({
		title: __("Unlink {0}?", [doc.phone_e164]),
		message: __("The number stays in the list as not linked. The contact is not deleted."),
		impact: [
			{ label: __("Contact"), value: doc.contact },
			{ label: __("Number"), value: doc.phone_e164 },
		],
		danger: true,
		confirm_label: __("Unlink"),
		on_confirm: () => sanad.ui.call("numbers.unlink_number", { phone_e164: doc.phone_e164 }),
	})
		.then(() => {
			sanad.ui.Toast.success(__("Number unlinked"));
			listview.refresh();
		})
		.catch(() => {});
}

/** Page-local link / convert dialog: link an existing Contact, or create one from the number. */
function link_convert_dialog(doc, on_done) {
	const phone_e164 = doc.phone_e164 || doc.name;
	let party_search = null;
	const dialog = new frappe.ui.Dialog({
		title: __("Add {0} as a contact", [doc.display_name || phone_e164]),
		size: "small",
		fields: [
			{ fieldtype: "HTML", fieldname: "error_html" },
			{
				fieldtype: "Select",
				fieldname: "mode",
				label: __("Add by"),
				options: [
					{ label: __("Link an existing contact"), value: "link" },
					{ label: __("Create a new contact"), value: "create" },
				],
				default: "link",
				reqd: 1,
			},
			{ fieldtype: "Data", fieldname: "phone_e164", label: __("WhatsApp number"), default: phone_e164, read_only: 1 },
			{ fieldtype: "Section Break", fieldname: "link_section", depends_on: "eval:doc.mode=='link'" },
			{
				fieldtype: "Link",
				fieldname: "contact",
				label: __("Contact"),
				options: "Contact",
				mandatory_depends_on: "eval:doc.mode=='link'",
				description: __("Search by name, email or company."),
			},
			{ fieldtype: "Section Break", fieldname: "create_section", depends_on: "eval:doc.mode=='create'" },
			{ fieldtype: "Data", fieldname: "first_name", label: __("First name"), default: doc.display_name || "", mandatory_depends_on: "eval:doc.mode=='create'" },
			{ fieldtype: "Data", fieldname: "last_name", label: __("Last name") },
			{ fieldtype: "Column Break", fieldname: "party_column" },
			{
				fieldtype: "Select",
				fieldname: "party_type",
				label: __("Linked to"),
				options: [
					{ label: "", value: "" },
					{ label: __("Customer"), value: "Customer" },
					{ label: __("Supplier"), value: "Supplier" },
					{ label: __("Employee"), value: "Employee" },
				],
				change: () => {
					const party_type = dialog.get_value("party_type");
					dialog.set_value("party_name", "");
					dialog.fields_dict.party_name.set_data([]);
					dialog.set_df_property("party_name", "description", party_type ? __("Type to search {0}.", [__(party_type)]) : "");
				},
			},
			{
				fieldtype: "Autocomplete",
				fieldname: "party_name",
				label: __("Linked record"),
				depends_on: "eval:doc.party_type",
			},
		],
		primary_action_label: __("Add as contact"),
		primary_action: (values) => {
			set_error("");
			const $btn = dialog.get_primary_btn().prop("disabled", true);
			const call =
				values.mode === "link"
					? sanad.ui.call("numbers.link_number", { phone_e164, contact: values.contact })
					: sanad.ui.call("numbers.convert_number", {
							phone_e164,
							first_name: values.first_name,
							last_name: values.last_name || null,
							party_type: values.party_type || null,
							party_name: values.party_type ? values.party_name || null : null,
					  });
			call
				.then((r) => {
					dialog.hide();
					sanad.ui.Toast.success(__("Linked to contact {0}", [r.contact]), {
						action: { label: __("Open contact"), onclick: () => frappe.set_route("Form", "Contact", r.contact) },
					});
					on_done && on_done(r);
				})
				.catch((err) => {
					$btn.prop("disabled", false);
					set_error((err && err.message) || __("Something went wrong. Please try again."));
				});
		},
	});
	dialog.$wrapper.addClass("sanad-kit sanad-sheet");
	// Server errors stay visible inside the dialog (a toast alone disappears after 8 s).
	const $error = dialog.get_field("error_html").$wrapper;
	const set_error = (message) => {
		if (!message) {
			$error.empty();
			return;
		}
		$error.html(`<div class="alert alert-danger sanad-link-dialog__error" role="alert" tabindex="-1">${frappe.utils.escape_html(message)}</div>`);
		$error.find("[role=alert]").trigger("focus");
	};
	// Party search goes through the contextual permission layer, not a direct Link on the party DocType.
	party_search = frappe.utils.debounce((txt) => {
		const party_type = dialog.get_value("party_type");
		if (!party_type) return;
		sanad.ui
			.call("contacts.search_party", { party_type, txt: txt || "" }, { silent: true })
			.then((rows) => dialog.fields_dict.party_name.set_data((rows || []).map((r) => ({ value: r.name, label: r.title || r.name }))))
			.catch((err) => set_error((err && err.message) || __("Could not search {0}.", [__(party_type)])));
	}, 250);
	dialog.fields_dict.party_name.$input.on("input focus", (e) => party_search(e.target.value));
	dialog.show();
	return dialog;
}

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

		if (has_kit("TreeGroupBy")) {
			new sanad.ui.TreeGroupBy({ listview, group_by_field: "link_status" });
		}

		if (has_kit("DataList")) {
			listview._sanad_datalist = new sanad.ui.DataList({
				listview,
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

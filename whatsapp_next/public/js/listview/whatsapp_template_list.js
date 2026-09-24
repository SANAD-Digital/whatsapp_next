// WhatsApp Template list (09 row 10a, D-064: the prototype "Message templates" screen):
// PageHeader (title, "+ New template", KPIs Templates · Uses (30d) · Categories) → FilterBar
// (search, category) → DataList (Template · Text start · Category · Uses · Last updated · View →
// form, plus "Use in a message" → QuickSend). PageHeader / DataList are guarded with `typeof`;
// the native rows render until they land.

const DOCTYPE = "WhatsApp Template";
const has_kit = (name) => typeof sanad.ui[name] === "function";
const days_ago = (n) => frappe.datetime.add_days(frappe.datetime.now_date(), -n);

/** Distinct, non-empty categories (Data field — no meta options to read). */
function list_categories() {
	return frappe.db
		.get_list(DOCTYPE, { fields: ["category"], group_by: "category", order_by: "category asc", limit: 100 })
		.then((rows) => (rows || []).map((r) => r.category).filter(Boolean));
}

function open_form(doc) {
	frappe.set_route("Form", DOCTYPE, doc.name);
}

function use_in_message(doc) {
	if (typeof sanad.ui.QuickSend !== "function") return;
	new sanad.ui.QuickSend({ template: doc.name });
}

const STATS = () => [
	{
		key: "templates",
		label: __("Templates"),
		icon: "es-line-template",
		count: { doctype: DOCTYPE },
		sub: __("Ready to pick when sending"),
	},
	{
		key: "uses",
		label: __("Uses (30 days)"),
		icon: "es-line-chat",
		tone: "blue",
		count: { doctype: "WhatsApp Log", filters: { template: ["is", "set"], creation: [">=", days_ago(30)] } },
		sub: __("Messages sent through a template"),
	},
	{
		key: "categories",
		label: __("Categories"),
		icon: "es-line-tag",
		value: () => list_categories().then((names) => ({ value: names.length, names })),
		sub: (value, raw) => ((raw && raw.names && raw.names.length) ? raw.names.join(__(", ")) : __("No categories yet")),
	},
];

const excerpt = (body) => {
	const first = cstr(body || "").split("\n").find((line) => line.trim()) || "";
	return first.length > 80 ? `${first.slice(0, 80)}…` : first;
};

const COLUMNS = () => [
	{
		fieldname: "template_name",
		label: __("Template"),
		sortable: true,
		format: (v, doc) => `<strong>${frappe.utils.escape_html(v || doc.name)}</strong>`,
		sub: (doc) =>
			typeof sanad.ui.QuickSend === "function" && !cint(doc.disabled)
				? `<button type="button" class="btn btn-xs btn-link p-0 wa-template-use" data-name="${frappe.utils.escape_html(doc.name)}">${frappe.utils.icon(sanad.ui.icons.quick_send, "xs")} ${frappe.utils.escape_html(__("Use in a message"))}</button>`
				: "",
	},
	{ fieldname: "body", label: __("Text start"), sortable: false, hidden_xs: true, format: (v) => `<span class="text-muted">${frappe.utils.escape_html(excerpt(v))}</span>` },
	{
		fieldname: "category",
		label: __("Category"),
		sortable: true,
		format: (v) => (v ? sanad.ui.StatusBadge.html({ label: __(v), colour: "gray", icon: false }) : ""),
	},
	{ fieldname: "use_count", label: __("Uses"), type: "number", align: "end", sortable: true },
	{ fieldname: "modified", label: __("Last updated"), type: "date", sortable: true, format: (v) => (v ? frappe.datetime.str_to_user(v, false, true) : "") },
];

frappe.listview_settings[DOCTYPE] = {
	add_fields: ["template_name", "category", "body", "use_count", "message_type", "disabled", "reference_doctype", "last_used_at", "modified"],

	get_indicator(doc) {
		return cint(doc.disabled) ? [__("Disabled"), "gray", "disabled,=,1"] : [__("Enabled"), "green", "disabled,=,0"];
	},

	onload(listview) {
		if (!listview.view_user_settings.sort_by) {
			listview.sort_by = "use_count";
			listview.sort_order = "desc";
		}

		const has_header = has_kit("PageHeader");
		if (has_header) {
			listview._sanad_header = new sanad.ui.PageHeader({
				listview,
				title: __("Message templates"),
				description: __("Ready-made texts to pick when sending. They support Jinja variables and conditions and render as soon as you choose one."),
				primary: { label: __("New template"), icon: "es-line-add", perm: "create", handler: () => frappe.new_doc(DOCTYPE) },
				stats: STATS(),
			});
		}

		if (has_kit("FilterBar")) {
			new sanad.ui.FilterBar({
				listview,
				actions: ["group_by", "export"],
				intro: has_header ? null : __("Ready-made texts to pick when sending; Jinja variables and conditions are supported."),
				presets: [
					{ fieldname: "template_name", type: "search", fields: ["template_name", "body"], placeholder: __("Search template name or text…") },
					{ fieldname: "category", type: "select", options: () => list_categories().then((names) => names.map((n) => ({ value: n, label: __(n) }))) },
					{ fieldname: "message_type", type: "select" },
					{ fieldname: "disabled", type: "select", label: __("Status") },
				],
			});
		}

		if (has_kit("DataList")) {
			listview._sanad_datalist = new sanad.ui.DataList({
				listview,
				columns: COLUMNS(),
				selectable: true,
				page_length: 50,
				on_row_click: open_form,
				footer: { count: (total) => sanad.ui.plural(total, { one: __("{0} template"), other: __("{0} templates") }) },
				empty: {
					title: __("No templates yet"),
					description: __("Create a template once and pick it every time you send."),
					action: frappe.perm.has_perm(DOCTYPE, 0, "create") ? { label: __("New template"), onclick: () => frappe.new_doc(DOCTYPE) } : null,
				},
				mobile: "cards",
			});
		} else if (has_kit("RowActions")) {
			new sanad.ui.RowActions({
				listview,
				actions: [
					{ label: __("Use in a message"), icon: sanad.ui.icons.quick_send, condition: (doc) => typeof sanad.ui.QuickSend === "function" && !cint(doc.disabled), handler: use_in_message },
					{ label: __("Open"), icon: sanad.ui.icons.open, handler: open_form },
				],
				on_row_click: open_form,
			});
		}

		// "Use in a message" inside DataList rows (delegated: rows re-render on every refresh).
		listview.$result.off("click.watemplate").on("click.watemplate", ".wa-template-use", (e) => {
			e.preventDefault();
			e.stopPropagation();
			use_in_message({ name: $(e.currentTarget).data("name") });
		});
	},
};

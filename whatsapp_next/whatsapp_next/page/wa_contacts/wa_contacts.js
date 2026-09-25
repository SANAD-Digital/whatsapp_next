// Screen 12 — Contacts (spec §2 row 12, §4; matrix row 12 §1A/§1B/§1C).
//
// This page exists because of the contextual permission layer: a `WhatsApp Contact User` holds
// zero rows in the `Contact` permission matrix, so a native list view is impossible and every
// read and write goes through `contacts.*` / `numbers.*`, which elevate against a declared field
// set and audit. Nothing here touches `frappe.client`, `frappe.db` or a Contact form.
//
// Anatomy, from `docs/screen/Hub Screen - Contacts.dc.html`: the screen header with its four
// stat cards, the one-line toolbar (search · filters · selection chip and bulk verbs at the
// inline-end), then the prototype's own list — `sanad.ui.DataList` in page mode: checkbox column,
// the ten columns, and the footer count with the pager. A row opens the prototype's detail panel
// (`sanad.ui.OverlayPanel` as a drawer: alert · facts · linked accounts · recent messages · the
// verbs); "New contact" and "Edit" open its edit modal (`editPanel` in the prototype), and the
// two state changes open its smaller modals (`chatPanel`, `statusPanel`). The page owns the
// data; the table only asks for a page, a sort or a selection.

frappe.provide("whatsapp_next.contacts");

const PARTY_TYPES = ["Customer", "Supplier", "Employee", "Sales Person"];
/** `Contact.status` as the DocType declares it — the screen reads it, it never writes it. */
const CONTACT_STATUSES = ["Passive", "Open", "Replied"];
const PAGE_LENGTH = 20;
/** One bulk call never carries more than this, the same cap the kit's BulkActions uses. */
const BULK_CAP = 200;
/** How many of a number's messages the detail panel shows. */
const RECENT_MESSAGES = 5;

/** Roles that may open a conversation / send, mirroring the API's own gates. */
const CAN_SEND = () => frappe.user.has_role(["WhatsApp Agent", "WhatsApp Manager", "System Manager"]);
const CAN_CONFIRM = CAN_SEND;
const CAN_READ_CONVERSATION = () =>
	frappe.user.has_role(["WhatsApp Viewer", "WhatsApp Agent", "WhatsApp Manager", "System Manager"]);
const CAN_WRITE = () =>
	frappe.user.has_role("WhatsApp Contact User") || frappe.perm.has_perm("Contact", 0, "write");
const CAN_CREATE = () =>
	frappe.user.has_role("WhatsApp Contact User") || frappe.perm.has_perm("Contact", 0, "create");

frappe.pages["wa-contacts"].on_page_load = function (wrapper) {
	whatsapp_next.contacts.page = new ContactsPage(wrapper);
};

class ContactsPage {
	constructor(wrapper) {
		this.page = frappe.ui.make_app_page({
			parent: wrapper,
			title: __("Contacts"),
			single_column: true,
		});
		this.wrapper = wrapper;
		this.filters = {};
		this.search = "";
		this.order_by = "modified desc";
		this.current_page = 1;
		this.rows = [];
		this.make();
		this.bind_realtime();
		this.load();
	}

	// ---- layout ---------------------------------------------------------------------------

	make() {
		this.$el = $(`
			<div class="wa-contacts sanad-kit">
				<div class="wa-contacts__head"></div>
				<div class="wa-contacts__toolbar">
					<div class="wa-contacts__filters"></div>
					<div class="wa-contacts__selection" hidden></div>
				</div>
				<div class="wa-contacts__list"></div>
			</div>`);
		this.$el.appendTo(this.page.main);
		this.$selection = this.$el.find(".wa-contacts__selection");

		this.make_header();
		this.make_toolbar();
		this.make_table();
	}

	/**
	 * The screen's four numbers in one audited read. Every card asks for the same promise, so the
	 * row costs one call, not four; `reload()` drops it so the next refresh counts again.
	 */
	stats() {
		if (!this._stats) this._stats = sanad.ui.call("contacts.get_stats", {}, { silent: true });
		return this._stats;
	}

	/** One card's number, read from the shared stats call. */
	stat(key) {
		return () => this.stats().then((s) => cint(s && s[key]));
	}

	make_header() {
		this.header = new sanad.ui.PageHeader({
			wrapper: this.$el.find(".wa-contacts__head"),
			title: __("Contacts"),
			description: __(
				"WhatsApp numbers tied to their ledger accounts. A contact with no account receives no automatic notification."
			),
			primary: CAN_CREATE()
				? { label: __("New contact"), icon: "es-line-add", handler: () => this.open_form(null) }
				: null,
			// the prototype's own four numbers, in its order: linked · not linked · on more than
			// one account · what share of the screen is ready to be notified
			stats: [
				{
					key: "linked",
					label: __("Linked"),
					icon: "es-line-success",
					tone: "green",
					value: this.stat("linked"),
					sub: __("Linked to an account and notified automatically"),
					onclick: () => this.apply({ linked: 1 }),
				},
				{
					key: "unlinked",
					label: __("Not linked"),
					icon: "es-line-alert-triangle",
					tone: "amber",
					value: this.stat("unlinked"),
					sub: __("No account in the ledger"),
					onclick: () => this.apply({ linked: 0 }),
				},
				{
					key: "multi_linked",
					label: __("Linked to more than one account"),
					icon: "es-line-people",
					value: this.stat("multi_linked"),
					sub: __("One number serving two accounts or more"),
					onclick: () => this.apply({}, ""),
				},
				{
					key: "coverage",
					label: __("Coverage"),
					icon: "es-line-chart",
					tone: "blue",
					value: () =>
						this.stats().then((s) =>
							cint(s && s.total) ? Math.round((cint(s.linked) / cint(s.total)) * 100) : 0
						),
					format: (v) => `${sanad.ui.format_int(v)}%`,
					sub: __("Share of contacts ready for notifications"),
					onclick: () => this.apply({}, ""),
				},
			],
		});
	}

	make_toolbar() {
		this.filterbar = new sanad.ui.FilterBar({
			wrapper: this.$el.find(".wa-contacts__filters"),
			doctype: "Contact",
			// the matrix gives this screen five dropdowns; FilterBar shows four and drops the rest
			max_inline: 5,
			presets: [
				{
					fieldname: "search",
					type: "search",
					placeholder: __("Name, number or account…"),
					fields: ["full_name"],
				},
				{
					fieldname: "link_doctype",
					type: "select",
					label: __("Type"),
					multiple: false,
					options: PARTY_TYPES.map((d) => ({ value: d, label: __(d) })),
				},
				{
					fieldname: "linked",
					type: "select",
					label: __("Link status"),
					multiple: false,
					options: [
						{ value: "1", label: __("Linked") },
						{ value: "0", label: __("Not linked") },
					],
				},
				{
					fieldname: "status",
					type: "select",
					label: __("Status"),
					multiple: false,
					options: CONTACT_STATUSES.map((v) => ({ value: v, label: __(v) })),
				},
				{
					fieldname: "has_whatsapp",
					type: "select",
					label: __("WhatsApp"),
					multiple: false,
					options: [
						{ value: "1", label: __("Has a number") },
						{ value: "0", label: __("No number") },
					],
				},
				{
					fieldname: "blacklisted",
					type: "select",
					label: __("Blocked"),
					multiple: false,
					options: [
						{ value: "1", label: __("Blocked") },
						{ value: "0", label: __("Not blocked") },
					],
				},
			],
			on_change: (_f, { values, search }) => {
				if (this.suspend_filters) return;
				this.search = search || "";
				this.filters = {
					link_doctype: values.link_doctype || null,
					linked: this.tri(values.linked),
					status: this.one(values.status),
					has_whatsapp: this.tri(values.has_whatsapp),
					blacklisted: this.tri(values.blacklisted),
				};
				this.current_page = 1;
				this.load();
			},
		});
		// A KPI card sets «حالة الربط» without the dropdown ever being opened, and FilterBar only
		// learns an option's label when it resolves that dropdown — so the button would read
		// "Link status 1". The labels this screen already holds are handed over now.
		(this.filterbar.opts.presets || []).forEach((preset) => {
			if (Array.isArray(preset.options)) this.filterbar.remember(preset.fieldname, preset.options);
		});
	}

	/** A three-state select ("1" / "0" / unset) as the API wants it (true / false / null). */
	tri(value) {
		const v = Array.isArray(value) ? value[0] : value;
		if (v === undefined || v === null || v === "") return null;
		return cint(v) ? 1 : 0;
	}

	/** A single-choice select: the first value, or null when nothing is chosen. */
	one(value) {
		const v = Array.isArray(value) ? value[0] : value;
		return v === undefined || v === null || v === "" ? null : v;
	}

	apply(filters, search) {
		this.filters = Object.assign(
			{ link_doctype: null, linked: null, status: null, has_whatsapp: null, blacklisted: null },
			filters
		);
		if (search !== undefined) this.search = search;
		this.current_page = 1;
		if (this.filterbar) {
			this.suspend_filters = true;
			this.filterbar.clear && this.filterbar.clear();
			Object.entries(filters || {}).forEach(([k, v]) => this.filterbar.set(k, v == null ? null : String(v)));
			this.suspend_filters = false;
		}
		this.load();
	}

	// ---- the table ---------------------------------------------------------------------------

	make_table() {
		this.table = new sanad.ui.DataList({
			wrapper: this.$el.find(".wa-contacts__list"),
			doctype: "Contact",
			columns: this.columns(),
			selectable: CAN_WRITE(),
			page_length: PAGE_LENGTH,
			sort: { fieldname: "modified", order: "desc" },
			mobile: "cards",
			// the prototype's phone card: who, which number, whether it is linked and to what,
			// and whether a conversation exists — the rest stays for the wide table
			mobile_columns: ["full_name", "link_status"],
			// the prototype's row opens the detail panel; Enter does the same from the keyboard
			on_row_click: (doc) => this.open_detail(doc),
			on_page: (page) => {
				this.current_page = page + 1;
				this.load();
			},
			on_sort: (fieldname, order) => {
				this.order_by = `${fieldname} ${order}`;
				this.current_page = 1;
				this.load();
			},
			on_select: () => this.render_selection(),
			footer: {
				count: (total) =>
					sanad.ui.plural(total, { one: __("{0} contact"), other: __("{0} contacts") }),
			},
			empty: {
				title: __("No contact matches"),
				description: __("Change the search or the filters, or add the contact yourself."),
				action: CAN_CREATE()
					? { label: __("New contact"), onclick: () => this.open_form(null) }
					: undefined,
			},
		});
		this.$el.find(".wa-contacts__list").on("change", ".list-row-checkbox", () => this.render_selection());
	}

	columns() {
		const esc = frappe.utils.escape_html;
		const badge = sanad.ui.StatusBadge.html;
		return [
			{
				fieldname: "full_name",
				label: __("Contact"),
				sortable: true,
				format: (v, doc) => {
					const name = doc.full_name || __("No name");
					const linked = (doc.links || []).length > 0;
					return `<span class="wa-contacts__identity">
							<span class="sanad-avatar sanad-avatar--sm ${
								linked ? "wa-contacts__avatar--linked" : ""
							}" aria-hidden="true">${esc(sanad.ui.initials(name))}</span>
							<span class="wa-contacts__names" title="${esc(
								doc.company_name ? __("{0} ({1})", [name, doc.company_name]) : name
							)}"><span class="wa-contacts__name">${esc(name)}</span>${
						doc.company_name ? `<span class="wa-contacts__sub">${esc(doc.company_name)}</span>` : ""
					}</span>
						</span>`;
				},
				// the phone card keeps the title and the badge; the number rides the title's second
				// line there and is hidden on a wide screen, where it has a column of its own
				sub: (doc) => {
					const phone = ContactsPage.phone_of(doc);
					return phone
						? `<span class="wa-contacts__card-only sanad-tabular" dir="ltr">${esc(phone)}</span>`
						: "";
				},
			},
			{
				fieldname: "phone",
				label: __("Number"),
				format: (v, doc) => {
					const phone = ContactsPage.phone_of(doc);
					return phone
						? `<span class="sanad-tabular" dir="ltr">${esc(phone)}</span>`
						: `<span class="wa-contacts__muted">${esc(__("None"))}</span>`;
				},
			},
			{
				fieldname: "link_doctype",
				label: __("Type"),
				format: (v, doc) =>
					(doc.links || []).length
						? `<span class="wa-contacts__type">${esc(__(doc.links[0].link_doctype))}</span>`
						: `<span class="wa-contacts__muted">&mdash;</span>`,
			},
			{
				fieldname: "link_status",
				label: __("Link status"),
				type: "status",
				format: (v, doc) =>
					(doc.links || []).length
						? badge({ label: __("Linked"), colour: "green" })
						: badge({ label: __("Not linked"), colour: "orange" }),
			},
			{
				fieldname: "accounts_count",
				label: __("Account count"),
				align: "end",
				hidden_xs: true,
				format: (v, doc) =>
					`<span class="sanad-tabular">${sanad.ui.format_int((doc.links || []).length)}</span>`,
			},
			{
				fieldname: "accounts",
				label: __("Linked accounts"),
				hidden_xs: true,
				format: (v, doc) => {
					const names = (doc.links || []).map((l) => l.link_title || l.link_name);
					return names.length
						? `<span class="wa-contacts__accounts" title="${esc(names.join(" · "))}">${esc(
								names.join(" · ")
						  )}</span>`
						: `<span class="wa-contacts__muted">&mdash;</span>`;
				},
			},
			{
				fieldname: "status",
				label: __("Status"),
				sortable: true,
				format: (v, doc) =>
					cint(doc.blacklisted)
						? badge({ label: __("Blocked"), colour: "red" })
						: badge({ label: __(doc.status || "Passive"), colour: doc.status === "Open" ? "blue" : "gray" }),
			},
			{
				fieldname: "conversation",
				label: __("Conversation"),
				format: (v, doc) => {
					if (cint(doc.inbound_count)) return badge({ label: __("Inbound recorded"), colour: "green" });
					if (cint(doc.conversation_confirmed))
						return badge({ label: __("Confirmed by hand"), colour: "blue" });
					return badge({ label: __("No conversation"), colour: "gray" });
				},
			},
			{
				fieldname: "last_seen",
				label: __("Last message"),
				type: "date",
				hidden_xs: true,
			},
			{
				fieldname: "since",
				label: __("Since"),
				hidden_xs: true,
				format: (v, doc) =>
					doc.last_seen
						? `<span class="wa-contacts__muted">${frappe.datetime.comment_when(doc.last_seen, true)}</span>`
						: `<span class="wa-contacts__muted">&mdash;</span>`,
			},
		];
	}

	/** A row's primary number: the primary mobile if there is one, else the first phone. */
	static phone_of(row) {
		const phones = (row && row.phone_nos) || [];
		const primary = phones.find((p) => cint(p.is_primary_mobile_no)) || phones[0];
		if (!primary) return null;
		return primary.wa_phone_e164 || primary.phone || null;
	}

	/** What the screen calls the row: its name, or the honest "No name". */
	static title_of(row) {
		return (row && row.full_name) || __("No name");
	}

	/** The conversation state in words, the same three the table's column uses. */
	static conversation_of(row) {
		if (cint(row.inbound_count)) return { text: __("Inbound recorded in the system"), tone: "ok" };
		if (cint(row.conversation_confirmed)) return { text: __("Confirmed by hand"), tone: "info" };
		return { text: __("No conversation"), tone: "muted" };
	}

	/** The link badge the header, the detail and the edit modal all wear. */
	static link_badge(row) {
		return (row.links || []).length
			? { text: __("Linked"), tone: "ok" }
			: { text: __("Not linked"), tone: "warn" };
	}

	// ---- data -----------------------------------------------------------------------------

	/**
	 * Only the filters that are set. Frappe's request layer form-encodes its arguments, so a
	 * `null` reaches the server as an empty string, which `has_whatsapp is not None` accepts and
	 * then reads as `False`.
	 */
	args() {
		const args = { page: this.current_page, page_length: PAGE_LENGTH, order_by: this.order_by };
		const chosen = {
			search: this.search,
			link_doctype: this.filters.link_doctype,
			linked: this.filters.linked,
			status: this.filters.status,
			has_whatsapp: this.filters.has_whatsapp,
			blacklisted: this.filters.blacklisted,
		};
		Object.entries(chosen).forEach(([key, value]) => {
			if (value !== null && value !== undefined && value !== "") args[key] = value;
		});
		return args;
	}

	load() {
		this.table.set_loading(true);
		return sanad.ui
			.call("contacts.list_contacts", this.args())
			.then((r) => {
				this.rows = (r && r.rows) || [];
				this.table.set_rows(this.rows, cint(r && r.total));
				this.render_selection();
			})
			.catch((err) => {
				this.table.set_loading(false);
				this.table.set_rows([], 0);
				new sanad.ui.EmptyState({
					wrapper: this.$el.find(".sanad-datalist__empty, .wa-contacts__list").first(),
					state: "error",
					title: err.message,
					action: { label: __("Retry"), onclick: () => this.load() },
				});
			});
	}

	reload() {
		this._stats = null;
		this.header && this.header.refresh(true);
		return this.load();
	}

	/**
	 * After a change made from the detail panel: refresh the page and put the operator back in
	 * front of the same record, now current. A record that left the page (a filter no longer
	 * matches it) simply stays closed.
	 */
	after_change(name) {
		return this.reload().then(() => {
			const row = name && this.rows.find((r) => r.name === name);
			if (row) this.open_detail(row);
		});
	}

	/** Reopen the detail of `name` from the rows already on the page (after a cancelled modal). */
	back_to_detail(name) {
		const row = name && this.rows.find((r) => r.name === name);
		if (row) this.open_detail(row);
	}

	// ---- the selection chip and its verbs, at the inline-end of the toolbar --------------------

	render_selection() {
		const rows = this.table.get_selected();
		if (!rows.length || !CAN_WRITE()) return this.$selection.prop("hidden", true).empty();
		const esc = frappe.utils.escape_html;
		const count = `<span class="sanad-tabular">${esc(sanad.ui.format_int(rows.length))}</span>`;
		this.$selection.prop("hidden", false).html(`
			<span class="wa-contacts__selected" role="status">
				<span>${__("{0} selected", [count])}</span>
				<button type="button" class="wa-contacts__selected-clear" aria-label="${esc(
					__("Clear selection")
				)}">&times;</button>
			</span>
			<button type="button" class="btn btn-sm sanad-accent-soft wa-contacts__bulk">${esc(
				__("Link to an account")
			)}</button>`);
		this.$selection.find(".wa-contacts__selected-clear").on("click", () => this.table.clear_selection());
		this.$selection.find(".wa-contacts__bulk").on("click", () => this.link_selected(rows));
	}

	link_selected(selected) {
		const names = selected.map((d) => d.name).slice(0, BULK_CAP);
		if (selected.length > BULK_CAP) {
			sanad.ui.Toast.warning(__("Only the first {0} contacts are linked in one go.", [BULK_CAP]));
		}
		this.ask_party({
			title: __("Link {0} contacts to an account", [names.length]),
			subtitle: __("The same account is added to every selected contact."),
		})
			.then(({ link_doctype, link_name, link_title }) =>
				sanad.ui
					.call("contacts.link_many", { names, link_doctype, link_name }, { freeze: true })
					.then((r) => {
						const done = cint(r && r.count);
						const skipped = ((r && r.skipped) || []).length;
						const failed = ((r && r.failed) || []).length;
						sanad.ui.Toast.success(
							__("Linked {0} of {1} contacts to {2}", [done, names.length, link_title || link_name])
						);
						if (skipped) sanad.ui.Toast.warning(__("{0} were already linked to that account.", [skipped]));
						if (failed) {
							sanad.ui.Toast.error(__("{0} could not be linked. Open one of them to see why.", [failed]));
						}
						this.table.clear_selection();
						this.reload();
					})
					.catch((err) => sanad.ui.Toast.error(err))
			)
			.catch(() => {});
	}

	// ---- the party chooser: the prototype's modal with a segment and a choice grid ----------------

	/** `[{value, label, note}]` of one party DocType, as the choice grid and the add row want it. */
	search_party(party_type, txt) {
		return sanad.ui
			.call("contacts.search_party", { party_type, txt: txt || "", page_length: 20 }, { silent: true })
			.then((rows) => (rows || []).map((r) => ({ value: r.name, label: r.title || r.name, note: r.name, note_mono: true })))
			.catch(() => []);
	}

	/** Resolve with `{link_doctype, link_name, link_title}`; rejects with "cancelled" on close. */
	ask_party({ title, subtitle } = {}) {
		return new Promise((resolve, reject) => {
			let settled = false;
			let chosen = null;
			const panel = new sanad.ui.OverlayPanel({
				type: "modal",
				width: "520px",
				title: title || __("Link to an account"),
				subtitle,
				sections: [
					{
						title: __("The account"),
						cols: 1,
						fields: [
							{
								key: "link_doctype",
								type: "segment",
								label: __("Account type"),
								value: PARTY_TYPES[0],
								options: PARTY_TYPES.map((d) => ({ value: d, label: __(d) })),
								on_change: (_v, p) => p.set_value("link_name", "", ""),
							},
							{
								key: "link_name",
								type: "link",
								label: __("Account"),
								required: true,
								placeholder: __("Search by name or ID…"),
								hint: __("Only the accounts you are allowed to see are listed."),
								search: (txt) =>
									this.search_party(panel.get_value("link_doctype"), txt).then((items) => {
										chosen = items;
										return items;
									}),
							},
						],
					},
				],
				actions: [
					{ key: "cancel", label: __("Cancel"), close: true },
					{
						key: "link",
						label: __("Link"),
						variant: "primary",
						handler: (values) => {
							const item = (chosen || []).find((i) => String(i.value) === String(values.link_name));
							settled = true;
							resolve({
								link_doctype: values.link_doctype,
								link_name: values.link_name,
								link_title: item ? item.label : values.link_name,
							});
						},
					},
				],
				on_close: () => !settled && reject(new Error("cancelled")),
			});
			panel.show();
		});
	}

	// ---- the detail: the kit's document drawer (D-084, reference image 01) ---------------------

	/** The party DocTypes' own title fields, so a linked account renders as the party it is. */
	static PARTY_TITLE = { Customer: "customer_name", Supplier: "supplier_name", Employee: "employee_name", "Sales Person": "sales_person_name" };

	open_detail(row) {
		if (this.detail) this.detail.destroy();
		const phone = ContactsPage.phone_of(row);
		const links = row.links || [];
		const blocked = cint(row.blacklisted);
		const conversation = ContactsPage.conversation_of(row);
		const alert = this.detail_alert(row);
		// the row, read as a document: the scalars the identity and the facts need are spelled out
		const doc = Object.assign({}, row, {
			doctype: "Contact",
			phone: phone || "",
			linked_count: links.length,
			// a contact whose number has never been seen carries no counters; zero is still a fact
			outbound_count: cint(row.outbound_count),
			inbound_count: cint(row.inbound_count),
			conversation: conversation.text,
		});
		this.detail_name = row.name;
		this.detail = new sanad.ui.Drawer({
			doctype: "Contact",
			name: row.name,
			mode: "record",
			layout: "document",
			doc,
			width: 560,
			title: __("Contact"),
			open_link: false,
			fields: [
				{ fieldname: "full_name", fieldtype: "Data", label: __("Name") },
				{ fieldname: "phone", fieldtype: "Data", options: "Phone", label: __("WhatsApp number") },
				{ fieldname: "company_name", fieldtype: "Data", label: __("Company") },
				{ fieldname: "designation", fieldtype: "Data", label: __("Designation") },
				{ fieldname: "email_id", fieldtype: "Data", options: "Email", label: __("Email") },
				{ fieldname: "status", fieldtype: "Select", label: __("Status"), options: CONTACT_STATUSES.join("\n") },
				{ fieldname: "linked_count", fieldtype: "Int", label: __("Linked accounts") },
				{ fieldname: "outbound_count", fieldtype: "Int", label: __("Messages sent") },
				{ fieldname: "inbound_count", fieldtype: "Int", label: __("Messages received") },
				{ fieldname: "conversation", fieldtype: "Data", label: __("Conversation") },
				{ fieldname: "salutation", fieldtype: "Data", label: __("Salutation") },
			],
			profile: {
				title: "full_name",
				lines: ["phone", "company_name"],
				image: "image",
				value: false,
				// the badge beside the identity says what an operator asks first: is it reachable, and is it linked
				status: () =>
					blocked
						? { label: __("Blocked"), colour: "red" }
						: links.length
							? { label: __("Linked"), colour: "green" }
							: { label: __("Not linked"), colour: "orange" },
			},
			time_field: "last_seen",
			highlight: alert
				? ($el) =>
						$el.html(
							`<div class="sanad-op__alert sanad-op__alert--${alert.tone}" role="${alert.tone === "danger" ? "alert" : "status"}">
								<span class="sanad-op__alert-title">${frappe.utils.escape_html(alert.title)}</span>
								${alert.lines.map((l) => `<span class="sanad-op__alert-line">${frappe.utils.escape_html(l)}</span>`).join("")}
							</div>`
						)
				: null,
			highlight_label: alert ? __("Needs attention") : undefined,
			facts: [
				{ field: "linked_count", icon: "es-line-link" },
				{ field: "outbound_count", icon: "es-line-send" },
				{ field: "inbound_count", icon: "es-line-inbox" },
				{ field: "conversation", icon: "es-line-chat-alt" },
				{ field: "status", icon: "es-line-flag" },
				{ field: "email_id", icon: "es-line-email" },
			],
			relations: [],
			sections: [
				{
					label: __("Linked accounts"),
					icon: "es-line-customer",
					render: ($el) => this.render_links($el, links, row),
				},
				{
					label: __("Recent messages"),
					icon: "es-line-chat",
					render: ($el) => this.render_messages($el, phone),
				},
			],
			details: ["designation", "salutation"],
			activity: () => this.load_activity(row.name),
			activity_label: __("Activity"),
			actions: this.actions_for(row).map((a) => ({
				label: a.label,
				icon: a.icon,
				primary: a.primary,
				danger: a.danger,
				menu: !!a.menu,
				handler: () => a.handler(row),
			})),
		});
		this.detail.show();
	}

	/** What an operator must know before anything else: the number is blocked, or not linked. */
	detail_alert(row) {
		if (cint(row.blacklisted)) {
			return {
				tone: "danger",
				title: __("This contact is blocked."),
				lines: [__("No message reaches it: no notification, no campaign, no manual send. Unblock it with a note to reach it again.")],
			};
		}
		if (!(row.links || []).length) {
			return {
				tone: "warn",
				title: __("The number is not linked to an account."),
				lines: [
					__("Automatic notifications are not sent, and commands that need a link are refused. Link it to a ledger account and everything works."),
				],
			};
		}
		return null;
	}

	/** Every linked account drawn as the party it is — a customer reads as a customer. */
	render_links($el, links, row) {
		const esc = frappe.utils.escape_html;
		if (!links.length) {
			new sanad.ui.EmptyState({
				wrapper: $el,
				state: "empty",
				size: "sm",
				title: __("No account is linked to this number"),
				description: __("Automatic notifications are not sent until it is linked."),
				action: CAN_WRITE() ? { label: __("Link to an account"), onclick: () => this.link_one(row) } : undefined,
			});
			return;
		}
		const $list = $('<div class="sanad-ent-list sanad-ent-list--row"></div>').appendTo($el);
		Promise.all(links.map((l) => sanad.ui.meta.with_doctype(l.link_doctype).catch(() => null))).then(() => {
			links.forEach((l) => {
				const title_field = ContactsPage.PARTY_TITLE[l.link_doctype] || "title";
				const doc = { doctype: l.link_doctype, name: l.link_name, [title_field]: l.link_title || l.link_name };
				const $item = $('<div class="sanad-ent-list__item"></div>').appendTo($list);
				sanad.ui.Render.mount($item, doc, {
					doctype: l.link_doctype,
					density: "row",
					profile: { title: title_field, lines: [], status: false, value: false, facts: [] },
					vm: { lines: [{ text: __(l.link_doctype) }] },
					href: frappe.perm.has_perm(l.link_doctype, 0, "read") ? undefined : null,
				});
				void esc;
			});
		});
	}

	/** The last messages to and from this number, each drawn as the message record it is. */
	render_messages($el, phone) {
		const esc = frappe.utils.escape_html;
		const empty = (title, description) => new sanad.ui.EmptyState({ wrapper: $el, state: "empty", size: "sm", title, description });
		if (!phone) return empty(__("No WhatsApp number"), __("Add a number to the contact before sending anything."));
		if (!CAN_READ_CONVERSATION()) return empty(__("Conversations are not visible with your role"), __("Reading a conversation needs the WhatsApp Viewer role."));
		const state = new sanad.ui.EmptyState({ wrapper: $el, state: "loading", rows: 2, size: "sm" });
		sanad.ui
			.call("messages.get_conversation", { key: phone, limit: RECENT_MESSAGES }, { silent: true })
			.then((r) => {
				const rows = (r && r.rows) || [];
				if (!rows.length) return state.empty({ title: __("No message yet"), description: __("Nothing has been sent to or received from this number.") });
				state.hide();
				$el.empty();
				const $list = $('<div class="sanad-ent-list sanad-ent-list--compact"></div>').appendTo($el);
				rows.slice(0, RECENT_MESSAGES).forEach((m) => {
					const inbound = m.direction === "Inbound";
					const doctype = inbound ? "WhatsApp Inbound Message" : "WhatsApp Log";
					const doc = Object.assign({}, m, {
						doctype,
						text: (m.body || m.caption || "").trim().slice(0, 140) || __(m.message_type || "No text"),
						when: `${inbound ? __("Received") : __("Sent")} · ${frappe.datetime.prettyDate(m.ts || m.creation, true)}`,
					});
					const $item = $('<div class="sanad-ent-list__item"></div>').appendTo($list);
					sanad.ui.Render.mount($item, doc, {
						doctype,
						kind: "document",
						density: "compact",
						// a message has no initials: the direction's icon stands in the picture's place
						vm: { initials: "" },
						profile: {
							title: "text",
							title_ltr: false,
							lines: ["when"],
							value: false,
							facts: [],
							icon: inbound ? "es-line-inbox" : "es-line-send",
							status: () => (inbound ? { label: __("Received"), colour: "blue" } : { label: __(m.status || "Sent"), colour: ContactsPage.status_colour(m.status) }),
						},
						href: null,
						on_click: () => sanad.ui.ConversationDrawer.open({ key: phone, on_close: () => this.back_to_detail(this.detail_name) }),
					});
				});
				void esc;
			})
			.catch((err) => state.error(err, { action: { label: __("Retry"), onclick: () => this.render_messages($el, phone) } }));
	}

	/** An outbound status in Desk's indicator colours. */
	static status_colour(status) {
		if (["Delivered", "Read", "Sent"].includes(status)) return "green";
		if (["Failed", "Cancelled"].includes(status)) return "red";
		if (["Queued", "Sending", "Paused"].includes(status)) return "orange";
		return "gray";
	}

	/** The audit rows that touched this contact or its numbers, as the timeline wants them. */
	load_activity(name) {
		const tone_of = (r) => {
			if (r.action === "Contact Group Members Changed") return r.blocked ? "red" : "green";
			if (r.action === "Conversation Confirmed") return "blue";
			if (r.action === "Number Linked" || r.action === "Number Converted") return "green";
			return "gray";
		};
		const icon_of = (r) => {
			if (r.action === "Contact Group Members Changed") return "es-line-close-circle";
			if (r.action === "Conversation Confirmed") return "es-line-chat-alt";
			if (r.action === "Number Linked" || r.action === "Number Converted") return "es-line-link";
			return "es-line-edit";
		};
		const title_of = (r) => {
			if (r.action === "Contact Group Members Changed") return r.blocked ? __("Number blocked") : __("Number unblocked");
			if (r.action === "Conversation Confirmed") return r.confirmed ? __("Conversation confirmed by hand") : __("Conversation confirmation removed");
			if (r.action === "Elevated Contact Write") return r.reason === "create" ? __("Contact created") : __("Contact details changed");
			return __(r.summary || r.action);
		};
		// the write audit carries "create" / "update" as its reason: that is the title's job, not a note
		const note_of = (r) => (r.reason && !["create", "update"].includes(r.reason) ? r.reason : "");
		return sanad.ui.call("contacts.get_activity", { name }, { silent: true }).then((rows) =>
			(rows || []).map((r) => ({
				title: title_of(r),
				description: note_of(r),
				time: r.timestamp,
				user: r.user,
				icon: icon_of(r),
				tone: tone_of(r),
			}))
		);
	}

	// ---- row actions --------------------------------------------------------------------------

	actions_for(row) {
		const phone = ContactsPage.phone_of(row);
		const linked = (row.links || []).length > 0;
		const list = [];
		if (!linked && CAN_WRITE()) {
			list.push({ key: "link", label: __("Link to an account"), icon: "es-line-link", primary: true, handler: () => this.link_one(row) });
		}
		if (phone && CAN_SEND() && !cint(row.blacklisted)) {
			list.push({
				key: "send",
				label: __("Send a message"),
				icon: "es-line-chat",
				primary: linked,
				close: false,
				handler: () => new sanad.ui.QuickSend({ phone, contact: row.name, on_sent: () => this.after_change(row.name) }),
			});
		}
		if (CAN_WRITE()) {
			list.push({ key: "edit", label: __("Edit"), icon: "es-line-edit", handler: () => this.open_form(row) });
		}
		if (phone && CAN_WRITE()) {
			list.push({
				key: "block",
				label: cint(row.blacklisted) ? __("Unblock") : __("Block"),
				icon: "es-line-close-circle",
				danger: !cint(row.blacklisted),
				menu: true,
				handler: () => this.toggle_block(row, phone),
			});
		}
		if (phone && CAN_CONFIRM() && !cint(row.inbound_count)) {
			list.push({ key: "chat", label: __("Change conversation state"), icon: "es-line-chat-alt", menu: true, handler: () => this.change_conversation(row, phone) });
		}
		if (phone && CAN_SEND()) {
			list.push({
				key: "simulator",
				label: __("WhatsApp simulator"),
				icon: "es-line-zap",
				menu: true,
				handler: () => {
					frappe.route_options = { contact: row.name, phone };
					frappe.set_route(sanad.ui.config.defaults.simulator_route || "wa-simulator");
				},
			});
		}
		if (phone && CAN_READ_CONVERSATION()) {
			list.push({
				key: "history",
				label: __("Message history"),
				icon: "es-line-chat",
				menu: true,
				handler: () => sanad.ui.ConversationDrawer.open({ key: phone, on_close: () => this.back_to_detail(row.name) }),
			});
		}
		return list;
	}

	link_one(row) {
		this.ask_party({
			title: __("Link «{0}» to an account", [ContactsPage.title_of(row)]),
			subtitle: ContactsPage.phone_of(row) || undefined,
		})
			.then(({ link_doctype, link_name, link_title }) =>
				sanad.ui
					.call("contacts.link_many", { names: [row.name], link_doctype, link_name }, { freeze: true })
					.then(() => {
						sanad.ui.Toast.success(__("Linked to {0}", [link_title || link_name]));
						this.after_change(row.name);
					})
					.catch((err) => {
						sanad.ui.Toast.error(err);
						this.back_to_detail(row.name);
					})
			)
			.catch(() => this.back_to_detail(row.name));
	}

	/** The prototype's `chatPanel`: current state, the new state as a segment, a mandatory note. */
	change_conversation(row, phone) {
		const current = ContactsPage.conversation_of(row);
		const confirmed = cint(row.conversation_confirmed);
		let saved = false;
		new sanad.ui.OverlayPanel({
			type: "modal",
			width: "520px",
			title: __("Change conversation state"),
			subtitle: __("{0} · {1}", [ContactsPage.title_of(row), phone]),
			badge: { text: current.text, tone: current.tone },
			sections: [
				{
					title: __("The state"),
					cols: 1,
					fields: [
						{ key: "current", type: "readonly", label: __("Current state"), value: current.text },
						{
							key: "chat",
							type: "segment",
							label: __("New state"),
							value: confirmed ? "yes" : "no",
							options: [
								{ value: "yes", label: __("There is a conversation") },
								{ value: "no", label: __("There is none") },
							],
							hint: __("Confirm a conversation that happened before the system was connected and was never recorded in it."),
						},
						{
							key: "note",
							type: "textarea",
							label: __("Note"),
							required: true,
							rows: 3,
							placeholder: __("Why it changed — for example: an earlier conversation with the customer on the sales device, before the link."),
							hint: __("Required. It is kept in the audit log with your name."),
						},
					],
				},
			],
			actions: [
				{ key: "cancel", label: __("Cancel"), close: true },
				{
					key: "save",
					label: __("Save the change"),
					variant: "primary",
					handler: (values) =>
						sanad.ui
							.call(
								"numbers.confirm_conversation",
								{ phone_e164: phone, confirmed: values.chat === "yes" ? 1 : 0, note: values.note },
								{ silent: true }
							)
							.then(() => {
								saved = true;
								sanad.ui.Toast.success(__("Conversation state updated"));
							}),
				},
			],
			on_close: () => (saved ? this.after_change(row.name) : this.back_to_detail(row.name)),
		}).show();
	}

	/** The prototype's `statusPanel`: the state now, the state after saving, a mandatory note. */
	toggle_block(row, phone) {
		const blocked = cint(row.blacklisted);
		let saved = false;
		new sanad.ui.OverlayPanel({
			type: "modal",
			width: "520px",
			title: blocked ? __("Unblock the number") : __("Block the number"),
			subtitle: __("{0} · {1}", [ContactsPage.title_of(row), phone]),
			badge: blocked ? { text: __("Blocked"), tone: "danger" } : { text: __("Not blocked"), tone: "ok" },
			sections: [
				{
					title: __("The state"),
					cols: 1,
					fields: [
						{ key: "current", type: "readonly", label: __("Current state"), value: blocked ? __("Blocked") : __("Not blocked") },
						{
							key: "next",
							type: "readonly",
							label: __("After saving"),
							value: blocked ? __("Not blocked") : __("Blocked"),
							hint: blocked
								? __("Notifications, campaigns and manual sends reach it again.")
								: __("No message reaches it: no notification, no campaign, no manual send."),
						},
						{
							key: "note",
							type: "textarea",
							label: __("Note"),
							required: true,
							rows: 3,
							placeholder: blocked
								? __("Why it is unblocked — for example: the customer asked for notifications again.")
								: __("Why it is blocked — for example: the customer asked to stop notifications."),
							hint: __("Required. It is kept with the blacklist entry and in the audit log with your name."),
						},
					],
				},
			],
			actions: [
				{ key: "cancel", label: __("Cancel"), close: true },
				{
					key: "save",
					label: blocked ? __("Unblock") : __("Block"),
					variant: blocked ? "primary" : "danger",
					handler: (values) =>
						sanad.ui
							.call(
								"contacts.toggle_blacklist",
								{ contact: row.name, phone, blocked: blocked ? 0 : 1, note: values.note },
								{ silent: true }
							)
							.then(() => {
								saved = true;
								sanad.ui.Toast.success(blocked ? __("Number unblocked") : __("Number blocked"));
							}),
				},
			],
			on_close: () => (saved ? this.after_change(row.name) : this.back_to_detail(row.name)),
		}).show();
	}

	// ---- the edit modal: the prototype's `editPanel` over the WRITE field set -----------------------

	/** `[{value, label, note}]` of the site's companies, for the Company link. */
	search_company(txt) {
		return sanad.ui
			.call("contacts.search_company", { txt: txt || "", page_length: 20 }, { silent: true })
			.then((rows) => (rows || []).map((r) => ({ value: r.name, label: r.title || r.name, note: r.name })))
			.catch(() => []);
	}

	open_form(row) {
		if (this.form) this.form.destroy();
		const editing = !!row;
		const r = row || {};
		const conversation = editing ? ContactsPage.conversation_of(r) : null;
		const blocked = cint(r.blacklisted);
		const link_rows = (r.links || []).map((l) => ({
			link_doctype: l.link_doctype,
			link_name: l.link_name,
			link_name_title: l.link_title || l.link_name,
		}));
		let saved = false;

		this.form = new sanad.ui.OverlayPanel({
			type: "modal",
			width: "680px",
			title: editing ? __("Edit «{0}»", [ContactsPage.title_of(r)]) : __("New contact"),
			subtitle: editing ? r.name : __("Added straight to the system contacts"),
			subtitle_mono: editing,
			badge: editing ? ContactsPage.link_badge(r) : null,
			sections: [
				{
					title: __("Contact details"),
					cols: 2,
					fields: [
						{ key: "first_name", label: __("First name"), required: true, value: r.first_name, placeholder: __("The person's or the company's name") },
						{ key: "last_name", label: __("Last name"), value: r.last_name },
						{
							key: "company_name",
							label: __("Company"),
							type: "link",
							value: r.company_name,
							display: r.company_name,
							placeholder: __("Choose a company…"),
							search: (txt) => this.search_company(txt),
						},
						{ key: "designation", label: __("Designation"), value: r.designation },
						{
							key: "phone",
							label: __("WhatsApp number"),
							type: "phone",
							required: true,
							value: ContactsPage.phone_of(r) || "",
						},
						{ key: "email_id", label: __("Email"), type: "email", mono: true, value: r.email_id, placeholder: "name@example.com", autocomplete: "off" },
					],
				},
				{
					title: __("Linked accounts"),
					note_end: __("Optional"),
					cols: 1,
					fields: [
						{
							key: "links",
							type: "rows",
							label: "",
							value: link_rows,
							columns: [
								{
									key: "link_doctype",
									label: __("Account type"),
									type: "select",
									width: "150px",
									options: PARTY_TYPES.map((d) => ({ value: d, label: __(d) })),
									resets: ["link_name"],
								},
								{
									key: "link_name",
									label: __("Account"),
									type: "link",
									placeholder: __("Search by name or ID…"),
									search: (txt, current) => this.search_party(current.link_doctype || PARTY_TYPES[0], txt),
								},
							],
							add_label: __("Add an account"),
							empty: __("No account is linked to this number. Automatic notifications are not sent until it is linked."),
							incomplete_text: __("Choose the account on every row, or remove the row."),
							hint: __("One number can serve more than one account."),
						},
					],
				},
				...(editing
					? [
							{
								title: __("The state"),
								cols: 2,
								fields: [
									{
										key: "status_ro",
										type: "readonly",
										label: __("Status"),
										html: sanad.kit.badge(blocked ? __("Blocked") : __(r.status || "Passive"), blocked ? "danger" : r.status === "Open" ? "info" : "muted"),
										hint: __("Changed with the Block action, with a note."),
									},
									{
										key: "chat_ro",
										type: "readonly",
										label: __("Conversation"),
										html: sanad.kit.badge(conversation.text, conversation.tone),
										hint: cint(r.inbound_count)
											? __("A real inbound message exists; this cannot change.")
											: __("Changed with the conversation action, with a note."),
									},
								],
							},
					  ]
					: []),
			],
			actions: [
				{ key: "cancel", label: __("Cancel"), close: true },
				{
					key: "save",
					label: editing ? __("Save") : __("Add contact"),
					variant: "primary",
					requires_dirty: editing,
					handler: (values) => {
						const payload = this.form_payload(values);
						const call = editing
							? sanad.ui.call("contacts.update_contact", { name: r.name, payload }, { silent: true })
							: sanad.ui.call("contacts.create_contact", { payload }, { silent: true });
						return call.then(() => {
							saved = true;
							sanad.ui.Toast.success(editing ? __("Contact saved") : __("Contact added"));
						});
					},
				},
			],
			// an edit returns the operator to the record; a new contact only joins the list, as in
			// the prototype, so adding several in a row costs nothing extra
			on_close: () => {
				if (saved && editing) this.after_change(r.name);
				else if (saved) this.reload();
				else if (editing) this.back_to_detail(r.name);
			},
		});
		this.form.show();
	}

	/** The WRITE payload, and nothing else: the scalars that have a value, the phone, the links. */
	form_payload(values) {
		const out = {};
		["first_name", "last_name", "company_name", "designation", "email_id"].forEach((k) => {
			const v = values[k];
			if (v !== undefined && v !== null && String(v).trim() !== "") out[k] = String(v).trim();
		});
		out.phone_nos = values.phone ? [{ phone: values.phone, is_primary_mobile_no: 1 }] : [];
		const seen = new Set();
		out.links = (values.links || [])
			.filter((l) => l.link_doctype && l.link_name && !seen.has(`${l.link_doctype}:${l.link_name}`) && seen.add(`${l.link_doctype}:${l.link_name}`))
			.map((l) => ({ link_doctype: l.link_doctype, link_name: l.link_name }));
		return out;
	}

	// ---- realtime, and leaving the page -----------------------------------------------------------

	/** The panels live on <body>; leaving the route must take them along. */
	close_overlays() {
		this.detail && this.detail.hide();
		this.form && this.form.hide();
	}

	bind_realtime() {
		this.on_inbound = sanad.ui.throttle(() => this.load(), 4000);
		const subscribe = () => frappe.realtime.on("wa:inbound:received", this.on_inbound);
		const unsubscribe = () => frappe.realtime.off("wa:inbound:received", this.on_inbound);
		subscribe();
		$(this.wrapper).on("show", subscribe);
		$(this.wrapper).on("hide", () => {
			unsubscribe();
			this.close_overlays();
		});
	}
}

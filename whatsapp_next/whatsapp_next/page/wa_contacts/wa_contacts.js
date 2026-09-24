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
// the ten columns, a row that opens its detail panel in place, and the footer count with the
// pager. The page owns the data; the table only asks for a page, a sort or a selection.

frappe.provide("whatsapp_next.contacts");

const PARTY_TYPES = ["Customer", "Supplier", "Employee", "Sales Person"];
/** `Contact.status` as the DocType declares it — the screen reads it, it never writes it. */
const CONTACT_STATUSES = ["Passive", "Open", "Replied"];
const PAGE_LENGTH = 20;
/** One bulk call never carries more than this, the same cap the kit's BulkActions uses. */
const BULK_CAP = 200;

/** Roles that may open a conversation / send, mirroring the API's own gates. */
const CAN_SEND = () => frappe.user.has_role(["WhatsApp Agent", "WhatsApp Manager", "System Manager"]);
const CAN_CONFIRM = CAN_SEND;
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
		// "Link status 1". The labels this screen already holds are handed over now (kit ask in
		// the report: remember statically supplied options at mount).
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
			expand: ($el, doc) => this.render_detail($el, doc),
			on_row_click: (doc) => this.table.expand_row(doc.name),
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
		// DataList tells a page about "select all", but not yet about a single checkbox, so the
		// page listens for that one itself (kit note in the report).
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
				// `type` only places the cell (its own badge is drawn by `format`): on a phone card
				// the status sits beside the title instead of starting a line of its own
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

	// ---- data -----------------------------------------------------------------------------

	/**
	 * Only the filters that are set. Frappe's request layer form-encodes its arguments, so a `null` reaches
	 * the server as an empty string — which `has_whatsapp is not None` accepts and then reads as
	 * `False`. Sending "unset" as a value silently filtered the screen down to the contacts with
	 * no WhatsApp number as soon as any other filter was touched.
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

	// ---- the selection chip and its verbs, at the inline-end of the toolbar --------------------

	render_selection() {
		const rows = this.table.get_selected();
		if (!rows.length || !CAN_WRITE()) return this.$selection.prop("hidden", true).empty();
		const esc = frappe.utils.escape_html;
		// one sentence, not a number glued to a word: the count is placed inside the translated
		// string so Arabic can put it where Arabic puts it
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
		// `clear_selection` unchecks the boxes and calls `on_select`, which redraws this chip
		this.$selection.find(".wa-contacts__selected-clear").on("click", () => this.table.clear_selection());
		this.$selection.find(".wa-contacts__bulk").on("click", () => this.link_selected(rows));
	}

	link_selected(selected) {
		const names = selected.map((d) => d.name).slice(0, BULK_CAP);
		if (selected.length > BULK_CAP) {
			sanad.ui.Toast.warning(__("Only the first {0} contacts are linked in one go.", [BULK_CAP]));
		}
		this.ask_party(__("Link {0} contacts to an account", [names.length])).then(
			({ link_doctype, link_name }) =>
				sanad.ui
					.call("contacts.link_many", { names, link_doctype, link_name }, { freeze: true })
					.then((r) => {
						const done = cint(r && r.count);
						const skipped = ((r && r.skipped) || []).length;
						const failed = ((r && r.failed) || []).length;
						sanad.ui.Toast.success(
							__("Linked {0} of {1} contacts to {2}", [done, names.length, link_name])
						);
						if (skipped) sanad.ui.Toast.warning(__("{0} were already linked to that account.", [skipped]));
						if (failed) {
							sanad.ui.Toast.error(__("{0} could not be linked. Open one of them to see why.", [failed]));
						}
						this.table.clear_selection();
						this.reload();
					})
					.catch((err) => sanad.ui.Toast.error(err))
		);
	}

	// ---- the party picker (contacts.search_party) --------------------------------------------

	/** Resolve with `{link_doctype, link_name}`; rejects when the user cancels. */
	ask_party(title) {
		return new Promise((resolve, reject) => {
			let settled = false;
			const dialog = new frappe.ui.Dialog({
				title: title || __("Link to an account"),
				fields: [
					{
						fieldname: "link_doctype",
						label: __("Account type"),
						fieldtype: "Select",
						options: PARTY_TYPES.map((d) => ({ value: d, label: __(d) })),
						default: PARTY_TYPES[0],
						reqd: 1,
						onchange: () => dialog.set_value("link_name", ""),
					},
					{
						fieldname: "link_name",
						label: __("Account"),
						fieldtype: "Autocomplete",
						reqd: 1,
						description: __("Only the accounts you are allowed to see are listed."),
					},
				],
				primary_action_label: __("Link"),
				primary_action: (values) => {
					if (!values.link_name) return;
					settled = true;
					dialog.hide();
					resolve(values);
				},
			});
			const field = dialog.get_field("link_name");
			const search = frappe.utils.debounce((txt) => {
				sanad.ui
					.call(
						"contacts.search_party",
						{ party_type: dialog.get_value("link_doctype"), txt: txt || "", page_length: 20 },
						{ silent: true }
					)
					.then((rows) =>
						field.set_data(
							(rows || []).map((r) => ({ value: r.name, label: r.title || r.name, description: r.name }))
						)
					)
					.catch(() => field.set_data([]));
			}, 250);
			field.$input.on("input focus", (e) => search(e.target.value));
			dialog.$wrapper.on("hidden.bs.modal", () => !settled && reject(new Error("cancelled")));
			dialog.show();
			search("");
		});
	}

	// ---- the detail panel the row opens in place ------------------------------------------------

	render_detail($el, row) {
		const esc = frappe.utils.escape_html;
		const links = row.links || [];
		const phone = ContactsPage.phone_of(row);
		const alert = this.detail_alert(row);
		$el.empty().addClass("wa-contacts__detail-body");
		$el.append(`<header class="wa-contacts__detail-head">
			<span class="wa-contacts__detail-title">${esc(row.full_name || __("No name"))}</span>
			${phone ? `<span class="wa-contacts__detail-sub sanad-tabular" dir="ltr">${esc(phone)}</span>` : ""}
			${
				links.length
					? sanad.ui.StatusBadge.html({ label: __("Linked"), colour: "green" })
					: sanad.ui.StatusBadge.html({ label: __("Not linked"), colour: "orange" })
			}
		</header>`);
		if (alert) {
			$el.append(`<div class="wa-contacts__alert sanad-tone--${alert.tone}" role="${
				alert.tone === "red" ? "alert" : "status"
			}">
				<span class="wa-contacts__alert-icon" aria-hidden="true">${sanad.ui.icon(alert.icon, "sm")}</span>
				<span><strong>${esc(alert.title)}</strong><span>${esc(alert.text)}</span></span>
			</div>`);
		}
		$el.append(`<dl class="wa-contacts__facts">
			<div><dt>${esc(__("Linked accounts"))}</dt><dd class="sanad-tabular">${sanad.ui.format_int(
			links.length
		)}</dd></div>
			<div><dt>${esc(__("Messages sent"))}</dt><dd class="sanad-tabular">${sanad.ui.format_int(
			row.outbound_count
		)}</dd></div>
			<div><dt>${esc(__("Messages received"))}</dt><dd class="sanad-tabular">${sanad.ui.format_int(
			row.inbound_count
		)}</dd></div>
			<div><dt>${esc(__("Status"))}</dt><dd>${
			cint(row.blacklisted)
				? sanad.ui.StatusBadge.html({ label: __("Blocked"), colour: "red" })
				: sanad.ui.StatusBadge.html({ label: __(row.status || "Passive"), colour: "gray" })
		}</dd></div>
			<div><dt>${esc(__("Email"))}</dt><dd>${
			row.email_id ? `<span dir="ltr">${esc(row.email_id)}</span>` : "&mdash;"
		}</dd></div>
		</dl>`);

		const $blocks = $('<div class="wa-contacts__blocks"></div>').appendTo($el);
		const $accounts = $(
			`<section class="wa-contacts__block"><h3>${esc(__("Linked accounts"))}</h3><div></div></section>`
		).appendTo($blocks);
		if (links.length) {
			$accounts.find("div").html(
				`<ul class="wa-contacts__list-rows">${links
					.map(
						(l) =>
							`<li><span>${esc(l.link_title || l.link_name)}</span><span class="wa-contacts__tag">${esc(
								__(l.link_doctype)
							)}</span></li>`
					)
					.join("")}</ul>`
			);
		} else {
			new sanad.ui.EmptyState({
				wrapper: $accounts.find("div"),
				state: "empty",
				size: "sm",
				title: __("No account is linked to this number"),
				description: __("Automatic notifications are not sent until it is linked."),
				action: CAN_WRITE() ? { label: __("Link to an account"), onclick: () => this.link_one(row) } : undefined,
			});
		}

		const $messages = $(
			`<section class="wa-contacts__block"><h3>${esc(__("Recent messages"))}</h3><div></div></section>`
		).appendTo($blocks);
		this.render_messages($messages.find("div"), phone);

		const $actions = $('<div class="wa-contacts__row-actions"></div>').appendTo($el);
		this.actions_for(row).forEach((a) => {
			$(
				`<button type="button" class="btn btn-sm ${
					a.primary ? "btn-primary" : a.danger ? "btn-danger" : "btn-default"
				}">${a.icon ? sanad.ui.icon(a.icon, "xs") + " " : ""}${esc(a.label)}</button>`
			)
				.on("click", (e) => {
					e.stopPropagation();
					a.handler(row);
				})
				.appendTo($actions);
		});
	}

	detail_alert(row) {
		if (cint(row.blacklisted)) {
			return {
				tone: "red",
				icon: "es-line-close-circle",
				title: __("This contact is blocked."),
				text: __("No message reaches it: no notification, no campaign, no manual send."),
			};
		}
		if (!(row.links || []).length) {
			return {
				tone: "amber",
				icon: "es-line-alert-triangle",
				title: __("The number is not linked to an account."),
				text: __("Automatic notifications are not sent, and commands that need a link are refused."),
			};
		}
		return null;
	}

	render_messages($el, phone) {
		if (!phone) {
			new sanad.ui.EmptyState({
				wrapper: $el,
				state: "empty",
				size: "sm",
				title: __("No WhatsApp number"),
				description: __("Add a number to the contact before sending anything."),
			});
			return;
		}
		if (!frappe.user.has_role(["WhatsApp Viewer", "WhatsApp Agent", "WhatsApp Manager", "System Manager"])) {
			new sanad.ui.EmptyState({
				wrapper: $el,
				state: "empty",
				size: "sm",
				title: __("Conversations are not visible with your role"),
				description: __("Reading a conversation needs the WhatsApp Viewer role."),
			});
			return;
		}
		const state = new sanad.ui.EmptyState({ wrapper: $el, state: "loading", rows: 2, size: "sm" });
		sanad.ui
			.call("messages.get_conversation", { key: phone, limit: 5 }, { silent: true })
			.then((r) => {
				const rows = (r && r.rows) || [];
				if (!rows.length) {
					state.empty({
						title: __("No message yet"),
						description: __("Nothing has been sent to or received from this number."),
					});
					return;
				}
				state.hide();
				$el.html(
					`<ul class="wa-contacts__list-rows wa-contacts__list-rows--messages">${rows
						.slice(0, 5)
						.map(
							(m) =>
								`<li><span class="wa-contacts__msg">${frappe.utils.escape_html(
									(m.body || m.message_type || "").slice(0, 90) || __("No text")
								)}</span><span class="wa-contacts__tag">${frappe.utils.escape_html(
									__(m.direction === "Inbound" ? "Received" : "Sent")
								)} · ${frappe.datetime.comment_when(m.ts || m.creation, true)}</span></li>`
						)
						.join("")}</ul>`
				);
			})
			.catch((err) =>
				state.error(err, { action: { label: __("Retry"), onclick: () => this.render_messages($el, phone) } })
			);
	}

	// ---- row actions --------------------------------------------------------------------------

	actions_for(row) {
		const phone = ContactsPage.phone_of(row);
		const linked = (row.links || []).length > 0;
		const list = [];
		if (!linked && CAN_WRITE()) {
			list.push({
				label: __("Link to an account"),
				icon: "es-line-link",
				primary: true,
				handler: () => this.link_one(row),
			});
		}
		if (phone && CAN_SEND()) {
			list.push({
				label: __("Send a message"),
				icon: "es-line-chat",
				primary: linked,
				handler: () => new sanad.ui.QuickSend({ phone, contact: row.name, on_sent: () => this.reload() }),
			});
		}
		if (CAN_WRITE()) {
			list.push({ label: __("Edit"), icon: "es-line-edit", handler: () => this.open_form(row) });
		}
		if (phone && CAN_CONFIRM() && !cint(row.inbound_count)) {
			list.push({
				label: __("Change conversation state"),
				icon: "es-line-chat-alt",
				handler: () => this.change_conversation(row, phone),
			});
		}
		if (phone) {
			list.push({
				label: __("Message history"),
				icon: "es-line-chat-alt",
				handler: () => sanad.ui.ConversationDrawer.open({ key: phone, on_close: () => this.load() }),
			});
		}
		if (phone && CAN_SEND()) {
			list.push({
				label: __("Open in the simulator"),
				icon: "es-line-zap",
				handler: () => {
					frappe.route_options = { contact: row.name, phone };
					frappe.set_route(sanad.ui.config.defaults.simulator_route || "wa-simulator");
				},
			});
		}
		if (phone && CAN_WRITE()) {
			list.push({
				label: cint(row.blacklisted) ? __("Unblock") : __("Block"),
				icon: "es-line-close-circle",
				danger: !cint(row.blacklisted),
				handler: () => this.toggle_block(row, phone),
			});
		}
		return list;
	}

	link_one(row) {
		this.ask_party(__("Link {0} to an account", [row.full_name || row.name])).then(
			({ link_doctype, link_name }) =>
				sanad.ui
					.call("contacts.link_many", { names: [row.name], link_doctype, link_name }, { freeze: true })
					.then(() => {
						sanad.ui.Toast.success(__("Linked to {0}", [link_name]));
						this.reload();
					})
					.catch((err) => sanad.ui.Toast.error(err))
		);
	}

	change_conversation(row, phone) {
		const confirmed = cint(row.conversation_confirmed);
		sanad.ui.ConfirmDialog.ask({
			title: confirmed ? __("Remove the conversation confirmation?") : __("Confirm an existing conversation?"),
			message: confirmed
				? __("The number goes back to having no recorded conversation.")
				: __("Use this when the conversation happened before this system was connected."),
			impact: [
				{ label: __("Number"), value: phone },
				{ label: __("Current state"), value: confirmed ? __("Confirmed by hand") : __("No conversation") },
			],
			reason_field: {
				label: __("Note"),
				required: true,
				description: __("Required. It is kept in the audit log with your name."),
			},
			confirm_label: confirmed ? __("Remove the confirmation") : __("Confirm the conversation"),
			on_confirm: ({ reason }) =>
				sanad.ui.call("numbers.confirm_conversation", {
					phone_e164: phone,
					confirmed: confirmed ? 0 : 1,
					note: reason,
				}),
		})
			.then(() => {
				sanad.ui.Toast.success(__("Conversation state updated"));
				this.load();
			})
			.catch(() => {});
	}

	toggle_block(row, phone) {
		const blocked = cint(row.blacklisted);
		sanad.ui.ConfirmDialog.ask({
			title: blocked ? __("Unblock this number?") : __("Block this number?"),
			message: blocked
				? __("Notifications, campaigns and manual sends reach it again.")
				: __("No message reaches it: no notification, no campaign, no manual send."),
			impact: [
				{ label: __("Number"), value: phone },
				{ label: __("Contact"), value: row.full_name || row.name },
			],
			reason_field: { label: __("Note"), required: true, description: __("Kept with the blacklist entry.") },
			danger: !blocked,
			confirm_label: blocked ? __("Unblock") : __("Block"),
			on_confirm: ({ reason }) =>
				sanad.ui.call("contacts.toggle_blacklist", {
					contact: row.name,
					phone,
					blocked: blocked ? 0 : 1,
					note: reason,
				}),
		})
			.then(() => {
				sanad.ui.Toast.success(blocked ? __("Number unblocked") : __("Number blocked"));
				this.reload();
			})
			.catch(() => {});
	}

	// ---- the page-owned contact form -----------------------------------------------------------

	open_form(row) {
		if (this.form) this.form.destroy();
		this.form = new ContactForm({ row, page: this, on_saved: () => this.reload() });
		this.form.show();
	}

	// ---- realtime ------------------------------------------------------------------------------

	bind_realtime() {
		this.on_inbound = sanad.ui.throttle(() => this.load(), 4000);
		const subscribe = () => frappe.realtime.on("wa:inbound:received", this.on_inbound);
		const unsubscribe = () => frappe.realtime.off("wa:inbound:received", this.on_inbound);
		subscribe();
		$(this.wrapper).on("show", subscribe);
		$(this.wrapper).on("hide", unsubscribe);
	}
}

// -------------------------------------------------------------------------------------------
// The contact form — a page-owned drawer over CONTACT_WRITE_FIELDS, its phones and its party
// links (backend-plan §9). A Contact User never sees a native Contact form: this panel writes
// only through `contacts.create_contact` / `contacts.update_contact`.
// -------------------------------------------------------------------------------------------

class ContactForm {
	constructor(opts) {
		this.opts = opts;
		this.row = opts.row || null;
		this.links = ((this.row && this.row.links) || []).map((l) => ({
			link_doctype: l.link_doctype,
			link_name: l.link_name,
			link_title: l.link_title,
		}));
		this.id = sanad.ui.uid("wa-contact-form");
		this.make();
	}

	make() {
		const esc = frappe.utils.escape_html;
		const editing = !!this.row;
		this.$backdrop = $('<div class="sanad-backdrop" hidden></div>').appendTo(document.body);
		this.$root = $(`
			<aside class="sanad-panel sanad-kit wa-contact-form" role="dialog" aria-modal="true"
				aria-labelledby="${this.id}-title" hidden>
				<header class="sanad-panel__header">
					<span class="sanad-panel__title" id="${this.id}-title">${esc(
			editing ? __("Edit contact") : __("New contact")
		)}<span class="sanad-panel__subtitle">${esc(
			editing ? this.row.full_name || this.row.name : __("Added straight to the system contacts")
		)}</span></span>
					<button type="button" class="btn btn-xs btn-default wa-contact-form__close"
						aria-label="${esc(__("Close"))}">${sanad.ui.icon("es-line-close", "xs")}</button>
				</header>
				<div class="sanad-panel__body">
					<div class="wa-contact-form__summary" role="alert" tabindex="-1" hidden></div>
					<div class="wa-contact-form__fields"></div>
					<section class="wa-contact-form__block">
						<h3>${esc(__("Linked accounts"))}</h3>
						<p class="wa-contact-form__hint">${esc(
							__("One number can serve more than one account. Add the account and its type.")
						)}</p>
						<div class="wa-contact-form__links"></div>
						<button type="button" class="btn btn-xs btn-default wa-contact-form__add">${sanad.ui.icon(
							"es-line-add",
							"xs"
						)} ${esc(__("Add an account"))}</button>
					</section>
					<dl class="wa-contact-form__readonly"></dl>
				</div>
				<footer class="sanad-panel__footer">
					<button type="button" class="btn btn-sm btn-default wa-contact-form__cancel">${esc(
						__("Cancel")
					)}</button>
					<button type="button" class="btn btn-sm btn-primary wa-contact-form__save">${esc(
						editing ? __("Save") : __("Add contact")
					)}</button>
				</footer>
			</aside>`).appendTo(document.body);

		this.make_fields();
		this.render_links();
		this.render_readonly();
		this.$root.find(".wa-contact-form__close, .wa-contact-form__cancel").on("click", () => this.hide());
		this.$root.find(".wa-contact-form__save").on("click", () => this.save());
		this.$root.find(".wa-contact-form__add").on("click", () => this.add_link());
		this.$backdrop.on("click", () => this.hide());
		this.$root.on("keydown", (e) => e.key === "Escape" && this.hide());
	}

	make_fields() {
		const $fields = this.$root.find(".wa-contact-form__fields");
		const row = this.row || {};
		this.controls = {};
		const dfs = [
			{ fieldname: "first_name", label: __("First name"), fieldtype: "Data", reqd: 1 },
			{ fieldname: "last_name", label: __("Last name"), fieldtype: "Data" },
			{ fieldname: "company_name", label: __("Company"), fieldtype: "Data" },
			{ fieldname: "designation", label: __("Designation"), fieldtype: "Data" },
			{ fieldname: "email_id", label: __("Email"), fieldtype: "Data", options: "Email" },
		];
		dfs.forEach((df) => {
			const control = frappe.ui.form.make_control({ df, parent: $fields, render_input: true });
			control.set_value(row[df.fieldname] == null ? "" : row[df.fieldname]);
			control.refresh();
			// Desk draws the label as a plain <label> with no `for`, so the input has no
			// accessible name of its own; it is given one here
			if (control.$input) control.$input.attr("aria-label", df.label);
			this.controls[df.fieldname] = control;
		});
		const $phone = $('<div class="wa-contact-form__phone"></div>').appendTo($fields);
		this.phone = new sanad.ui.PhoneField({
			wrapper: $phone,
			label: __("WhatsApp number"),
			required: true,
			value: ContactsPage.phone_of(row) || "",
		});
	}

	render_links() {
		const esc = frappe.utils.escape_html;
		const $el = this.$root.find(".wa-contact-form__links");
		if (!this.links.length) {
			$el.html(`<p class="wa-contact-form__empty">${esc(__("No account is linked to this number"))}</p>`);
			return;
		}
		$el.html(
			`<ul class="wa-contact-form__linklist">${this.links
				.map(
					(l, i) =>
						`<li><span>${esc(l.link_title || l.link_name)}</span><span class="wa-contacts__tag">${esc(
							__(l.link_doctype)
						)}</span><button type="button" class="btn btn-xs btn-default" data-remove="${i}"
							aria-label="${esc(__("Remove {0}", [l.link_title || l.link_name]))}">${sanad.ui.icon(
							"es-line-delete",
							"xs"
						)}</button></li>`
				)
				.join("")}</ul>`
		);
		$el.find("[data-remove]").on("click", (e) => {
			this.links.splice(cint($(e.currentTarget).data("remove")), 1);
			this.render_links();
		});
	}

	render_readonly() {
		const esc = frappe.utils.escape_html;
		const row = this.row;
		if (!row) return this.$root.find(".wa-contact-form__readonly").remove();
		const conversation = cint(row.inbound_count)
			? __("Inbound recorded in the system")
			: cint(row.conversation_confirmed)
			? __("Confirmed by hand")
			: __("No conversation");
		this.$root.find(".wa-contact-form__readonly").html(`
			<div><dt>${esc(__("Status"))}</dt><dd>${sanad.ui.StatusBadge.html({
			label: cint(row.blacklisted) ? __("Blocked") : __(row.status || "Passive"),
			colour: cint(row.blacklisted) ? "red" : "gray",
		})}<span class="wa-contact-form__hint">${esc(
			__("Changed with the Block action, and recorded with its note.")
		)}</span></dd></div>
			<div><dt>${esc(__("Conversation"))}</dt><dd>${esc(conversation)}<span class="wa-contact-form__hint">${esc(
			cint(row.inbound_count)
				? __("Cannot be changed: a real inbound message exists from this number.")
				: __("Changed with the conversation action, and recorded with its note.")
		)}</span></dd></div>`);
	}

	add_link() {
		this.opts.page
			.ask_party(__("Add an account"))
			.then(({ link_doctype, link_name }) => {
				if (this.links.some((l) => l.link_doctype === link_doctype && l.link_name === link_name)) return;
				this.links.push({ link_doctype, link_name, link_title: link_name });
				this.render_links();
			})
			.catch(() => {});
	}

	values() {
		const out = {};
		Object.entries(this.controls).forEach(([fieldname, control]) => {
			const value = control.get_value();
			if (value !== undefined && value !== null && value !== "") out[fieldname] = value;
		});
		const phone = this.phone.get_value();
		out.phone_nos = phone.phone_e164 ? [{ phone: phone.phone_e164, is_primary_mobile_no: 1 }] : [];
		out.links = this.links.map((l) => ({ link_doctype: l.link_doctype, link_name: l.link_name }));
		return out;
	}

	save() {
		const values = this.values();
		const missing = [];
		if (!values.first_name) missing.push(__("First name"));
		if (!values.phone_nos.length) missing.push(__("WhatsApp number"));
		const $summary = this.$root.find(".wa-contact-form__summary");
		if (missing.length) {
			$summary
				.prop("hidden", false)
				.html(
					`${frappe.utils.escape_html(__("Fill in the required fields:"))} ${missing
						.map((m) => frappe.utils.escape_html(m))
						.join(", ")}`
				)
				.trigger("focus");
			return;
		}
		$summary.prop("hidden", true).empty();
		const call = this.row
			? sanad.ui.call("contacts.update_contact", { name: this.row.name, payload: values }, { freeze: true })
			: sanad.ui.call("contacts.create_contact", { payload: values }, { freeze: true });
		call
			.then(() => {
				sanad.ui.Toast.success(this.row ? __("Contact saved") : __("Contact added"));
				this.hide();
				this.opts.on_saved && this.opts.on_saved();
			})
			.catch((err) => sanad.ui.Toast.error(err));
	}

	show() {
		this.opener = document.activeElement;
		sanad.ui.overlay.open(this);
		this.$backdrop.prop("hidden", false);
		this.$root.prop("hidden", false);
		$(document.body).addClass("sanad-drawer-open");
		window.requestAnimationFrame(() => this.$root.addClass("sanad-panel--open"));
		this.untrap = sanad.ui.trap_focus(this.$root);
		this.$root.find("input").first().trigger("focus");
		return this;
	}

	hide() {
		if (this.$root.prop("hidden")) return this;
		this.untrap && this.untrap();
		sanad.ui.overlay.close(this);
		this.$root.removeClass("sanad-panel--open");
		window.setTimeout(() => {
			this.$root.prop("hidden", true);
			this.$backdrop.prop("hidden", true);
			if (!sanad.ui.overlay.current) $(document.body).removeClass("sanad-drawer-open");
		}, 160);
		if (this.opener && document.contains(this.opener) && this.opener.focus) this.opener.focus();
		return this;
	}

	destroy() {
		this.hide();
		window.setTimeout(() => {
			this.$root.remove();
			this.$backdrop.remove();
		}, 200);
	}
}

// Screen 12 — Contacts (spec §2 row 12, §4; matrix rows 12 §1A/§1B/§1C).
//
// This page exists because of the contextual permission layer: a `WhatsApp Contact User` holds
// zero rows in the `Contact` permission matrix, so a native list view is impossible and every
// read and write goes through `contacts.*` / `numbers.*`, which elevate against a declared field
// set and audit. Nothing here touches `frappe.client`, `frappe.db` or a Contact form.
//
// Anatomy (docs/screen/Hub Screen - Contacts.dc.html): header + KPI row → toolbar → the table
// (checkbox · contact · number · type · link status · accounts · status · conversation · last
// message · since) with an expandable detail row → count and pager.

frappe.provide("whatsapp_next.contacts");

const PARTY_TYPES = ["Customer", "Supplier", "Employee", "Sales Person"];
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
		this.total = 0;
		this.selected = new Set();
		this.expanded = new Set();
		this.make();
		this.bind_realtime();
		this.load();
	}

	// ---- layout ---------------------------------------------------------------------------

	make() {
		this.$el = $(`
			<div class="wa-contacts sanad-kit">
				<div class="wa-contacts__head"></div>
				<div class="wa-contacts__toolbar"></div>
				<section class="wa-contacts__card" aria-labelledby="wa-contacts-caption">
					<div class="wa-contacts__bulk" hidden></div>
					<div class="wa-contacts__tablewrap sanad-table-wrap">
						<table class="sanad-table wa-contacts__table" role="table">
							<caption id="wa-contacts-caption" class="sanad-visually-hidden">${frappe.utils.escape_html(
								__("Contacts and the accounts they are linked to")
							)}</caption>
							<thead></thead>
							<tbody></tbody>
						</table>
					</div>
					<div class="wa-contacts__state"></div>
					<div class="wa-contacts__footer"></div>
				</section>
			</div>`);
		this.$el.appendTo(this.page.main);
		this.$thead = this.$el.find("thead").attr("role", "rowgroup");
		this.$tbody = this.$el.find("tbody").attr("role", "rowgroup");
		this.$bulk = this.$el.find(".wa-contacts__bulk");
		this.$footer = this.$el.find(".wa-contacts__footer");
		this.$tablewrap = this.$el.find(".wa-contacts__tablewrap");
		this.state = new sanad.ui.EmptyState({ wrapper: this.$el.find(".wa-contacts__state") });

		this.make_header();
		this.make_toolbar();
		this.render_head();
		this.bind_table();
	}

	make_header() {
		const kpi = (args) => () =>
			sanad.ui
				.call("contacts.list_contacts", Object.assign({ page: 1, page_length: 1 }, args), { silent: true })
				.then((r) => cint(r && r.total));
		this.header = new sanad.ui.PageHeader({
			wrapper: this.$el.find(".wa-contacts__head"),
			title: __("Contacts"),
			description: __(
				"WhatsApp numbers tied to their ledger accounts. A contact with no account receives no automatic notification."
			),
			primary: CAN_CREATE()
				? { label: __("New contact"), icon: "es-line-add", handler: () => this.open_form(null) }
				: null,
			stats: [
				{
					key: "total",
					label: __("Contacts"),
					icon: "es-line-people",
					value: kpi({}),
					sub: __("Every contact this screen may read"),
					onclick: () => this.apply({}, ""),
				},
				{
					key: "reachable",
					label: __("On WhatsApp"),
					icon: "es-line-chat",
					tone: "green",
					value: kpi({ has_whatsapp: 1 }),
					sub: (v) => __("Ready for notifications"),
					onclick: () => this.apply({ has_whatsapp: 1 }),
				},
				{
					key: "unreachable",
					label: __("No WhatsApp number"),
					icon: "es-line-alert-triangle",
					tone: "amber",
					value: kpi({ has_whatsapp: 0 }),
					sub: __("Never messaged from this system"),
					onclick: () => this.apply({ has_whatsapp: 0 }),
				},
				{
					key: "blocked",
					label: __("Blocked"),
					icon: "es-line-close-circle",
					tone: "red",
					value: kpi({ blacklisted: 1 }),
					sub: __("On the global blacklist"),
					onclick: () => this.apply({ blacklisted: 1 }),
				},
			],
		});
	}

	make_toolbar() {
		this.filterbar = new sanad.ui.FilterBar({
			wrapper: this.$el.find(".wa-contacts__toolbar"),
			doctype: "Contact",
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
					has_whatsapp: this.tri(values.has_whatsapp),
					blacklisted: this.tri(values.blacklisted),
				};
				this.current_page = 1;
				this.load();
			},
		});
	}

	/** A three-state select ("1" / "0" / unset) as the API wants it (true / false / null). */
	tri(value) {
		const v = Array.isArray(value) ? value[0] : value;
		if (v === undefined || v === null || v === "") return null;
		return cint(v) ? 1 : 0;
	}

	apply(filters, search) {
		this.filters = Object.assign({ link_doctype: null, has_whatsapp: null, blacklisted: null }, filters);
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

	// ---- data -----------------------------------------------------------------------------

	args() {
		return {
			search: this.search || null,
			link_doctype: this.filters.link_doctype || null,
			has_whatsapp: this.filters.has_whatsapp,
			blacklisted: this.filters.blacklisted,
			page: this.current_page,
			page_length: PAGE_LENGTH,
			order_by: this.order_by,
		};
	}

	load() {
		this.$tablewrap.attr("aria-busy", "true");
		if (!this.rows.length) {
			this.$el.find(".wa-contacts__table").prop("hidden", true);
			this.state.loading({ rows: 6 });
		}
		return sanad.ui
			.call("contacts.list_contacts", this.args())
			.then((r) => {
				this.rows = (r && r.rows) || [];
				this.total = cint(r && r.total);
				this.render();
			})
			.catch((err) => {
				this.$el.find(".wa-contacts__table").prop("hidden", true);
				this.$footer.empty();
				this.state.error(err, { action: { label: __("Retry"), onclick: () => this.load() } });
			})
			.finally(() => this.$tablewrap.attr("aria-busy", "false"));
	}

	reload() {
		this.header && this.header.refresh();
		return this.load();
	}

	// ---- table ----------------------------------------------------------------------------

	columns() {
		return [
			{ key: "contact", label: __("Contact"), sort: "full_name" },
			{ key: "phone", label: __("Number") },
			{ key: "type", label: __("Type") },
			{ key: "link_status", label: __("Link status") },
			{ key: "accounts_count", label: __("Account count"), num: true, xs: true, md: true },
			{ key: "accounts", label: __("Linked accounts"), xs: true },
			{ key: "status", label: __("Status") },
			{ key: "conversation", label: __("Conversation") },
			{ key: "last", label: __("Last message"), sort: "modified", xs: true },
		];
	}

	render_head() {
		const cells = this.columns()
			.map((c) => {
				const cls = ContactsPage.cell_class(c);
				if (!c.sort) return `<th scope="col" role="columnheader" class="${cls}">${frappe.utils.escape_html(c.label)}</th>`;
				const active = this.order_by.split(" ")[0] === c.sort;
				const dir = active && this.order_by.endsWith("asc") ? "ascending" : active ? "descending" : "none";
				const next = active && this.order_by.endsWith("desc") ? __("ascending") : __("descending");
				return `<th scope="col" role="columnheader" class="${cls}" aria-sort="${dir}">
					<button type="button" class="wa-contacts__sort" data-sort="${c.sort}"
						aria-label="${frappe.utils.escape_html(__("Sort by {0}, {1}", [c.label, next]))}">
						${frappe.utils.escape_html(c.label)}
						<span aria-hidden="true">${active ? (dir === "ascending" ? "&#9650;" : "&#9660;") : ""}</span>
					</button></th>`;
			})
			.join("");
		this.$thead.html(`<tr role="row">
			<th scope="col" role="columnheader" class="wa-contacts__col-check">
				<input type="checkbox" class="wa-contacts__check-all"
					aria-label="${frappe.utils.escape_html(__("Select every contact on this page"))}">
			</th>
			<th scope="col" role="columnheader" class="wa-contacts__col-expand"><span class="sanad-visually-hidden">${frappe.utils.escape_html(
				__("Details")
			)}</span></th>
			${cells}
			<th scope="col" role="columnheader" class="wa-contacts__col-actions"><span class="sanad-visually-hidden">${frappe.utils.escape_html(
				__("Actions")
			)}</span></th>
		</tr>`);
	}

	render() {
		this.state.hide();
		this.$el.find(".wa-contacts__table").prop("hidden", false);
		this.render_head();
		this.$tbody.empty();
		if (!this.rows.length) {
			this.$el.find(".wa-contacts__table").prop("hidden", true);
			this.state.empty({
				title: __("No contact matches"),
				description: __("Change the search or the filters, or add the contact yourself."),
				action: CAN_CREATE()
					? { label: __("New contact"), onclick: () => this.open_form(null) }
					: undefined,
			});
			this.render_footer();
			return;
		}
		this.rows.forEach((row) => this.$tbody.append(this.row_html(row)));
		this.render_footer();
		this.sync_selection();
		this.expanded.forEach((name) => {
			if (this.rows.some((r) => r.name === name)) this.expand(name, true);
		});
	}

	/** The id of a row's detail row, so its chevron can name what it opens (WCAG 4.1.2). */
	static detail_id(name) {
		return `wa-contacts-detail-${String(name).replace(/[^A-Za-z0-9_-]/g, "-")}`;
	}

	/** Column classes: alignment plus the two widths at which a column steps out of the table. */
	static cell_class(column) {
		return [
			column.num ? "sanad-table__num" : "",
			column.xs ? "wa-contacts__hide-xs" : "",
			column.md ? "wa-contacts__hide-md" : "",
		]
			.filter(Boolean)
			.join(" ");
	}

	/** A row's primary number: the primary mobile if there is one, else the first phone. */
	static phone_of(row) {
		const phones = row.phone_nos || [];
		const primary = phones.find((p) => cint(p.is_primary_mobile_no)) || phones[0];
		if (!primary) return null;
		return primary.wa_phone_e164 || primary.phone || null;
	}

	cell_values(row) {
		const esc = frappe.utils.escape_html;
		const links = row.links || [];
		const phone = ContactsPage.phone_of(row);
		const name = row.full_name || __("No name");
		const linked = links.length > 0;
		const badge = sanad.ui.StatusBadge.html;
		return {
			contact: `<span class="wa-contacts__identity">
					<span class="wa-contacts__avatar ${linked ? "wa-contacts__avatar--linked" : ""}" aria-hidden="true">${esc(
				sanad.ui.initials(name)
			)}</span>
					<span class="wa-contacts__names" title="${esc(
				row.company_name ? __("{0} ({1})", [name, row.company_name]) : name
			)}">
						<span class="wa-contacts__name">${esc(name)}</span>
						${row.company_name ? `<span class="wa-contacts__sub">${esc(row.company_name)}</span>` : ""}
					</span>
				</span>`,
			phone: phone
				? `<span class="sanad-table__ltr wa-contacts__phone">${esc(phone)}</span>`
				: `<span class="wa-contacts__muted">${esc(__("None"))}</span>`,
			type: links.length
				? `<span class="wa-contacts__type">${esc(__(links[0].link_doctype))}</span>`
				: `<span class="wa-contacts__muted">&mdash;</span>`,
			link_status: linked
				? badge({ label: __("Linked"), colour: "green" })
				: badge({ label: __("Not linked"), colour: "orange" }),
			accounts_count: `<span class="sanad-tabular">${sanad.ui.format_int(links.length)}</span>`,
			accounts: links.length
				? `<span class="wa-contacts__accounts" title="${esc(
						links.map((l) => l.link_title || l.link_name).join(" · ")
				  )}">${esc(links.map((l) => l.link_title || l.link_name).join(" · "))}</span>`
				: `<span class="wa-contacts__muted">&mdash;</span>`,
			status: cint(row.blacklisted)
				? badge({ label: __("Blocked"), colour: "red" })
				: badge({ label: __(row.status || "Passive"), colour: row.status === "Open" ? "blue" : "gray" }),
			conversation: this.conversation_badge(row),
			last: row.last_seen
				? `<span class="wa-contacts__nowrap" title="${esc(
						frappe.datetime.str_to_user(row.last_seen)
				  )}">${frappe.datetime.comment_when(row.last_seen, true)}</span>`
				: `<span class="wa-contacts__muted">&mdash;</span>`,
		};
	}

	conversation_badge(row) {
		const badge = sanad.ui.StatusBadge.html;
		if (cint(row.inbound_count)) return badge({ label: __("Inbound recorded"), colour: "green" });
		if (cint(row.conversation_confirmed)) return badge({ label: __("Confirmed by hand"), colour: "blue" });
		return badge({ label: __("No conversation"), colour: "gray" });
	}

	row_html(row) {
		const esc = frappe.utils.escape_html;
		const values = this.cell_values(row);
		const cells = this.columns()
			.map((c) => {
				const cls = ContactsPage.cell_class(c);
				return `<td role="cell" class="${cls}" data-label="${esc(c.label)}">${values[c.key]}</td>`;
			})
			.join("");
		const open = this.expanded.has(row.name);
		return `<tr role="row" class="wa-contacts__row" data-name="${esc(row.name)}">
			<td role="cell" class="wa-contacts__col-check">
				<input type="checkbox" class="wa-contacts__check" data-name="${esc(row.name)}"
					aria-label="${esc(__("Select {0}", [row.full_name || row.name]))}">
			</td>
			<td role="cell" class="wa-contacts__col-expand">
				<button type="button" class="wa-contacts__expand" data-name="${esc(row.name)}"
					aria-expanded="${open ? "true" : "false"}"
					aria-controls="${esc(ContactsPage.detail_id(row.name))}"
					aria-label="${esc(__("Show details of {0}", [row.full_name || row.name]))}">
					${sanad.ui.icon("es-line-down", "xs")}
				</button>
			</td>
			${cells}
			<td role="cell" class="wa-contacts__col-actions">
				<button type="button" class="btn btn-xs btn-default wa-contacts__more" data-name="${esc(row.name)}"
					aria-haspopup="menu" aria-expanded="false"
					aria-label="${esc(__("Actions for {0}", [row.full_name || row.name]))}">
					${sanad.ui.icon("es-line-overflow", "xs")}
				</button>
			</td>
		</tr>`;
	}

	render_footer() {
		const pages = Math.max(1, Math.ceil(this.total / PAGE_LENGTH));
		const count = sanad.ui.plural(this.total, {
			one: __("{0} contact"),
			other: __("{0} contacts"),
		});
		this.$footer.html(`
			<span class="wa-contacts__count" role="status">${frappe.utils.escape_html(count)}</span>
			<div class="wa-contacts__pager">
				<button type="button" class="btn btn-xs btn-default" data-page="prev" ${
					this.current_page <= 1 ? "disabled" : ""
				}>${frappe.utils.escape_html(__("Previous"))}</button>
				<span class="sanad-tabular">${frappe.utils.escape_html(
					__("Page {0} of {1}", [this.current_page, pages])
				)}</span>
				<button type="button" class="btn btn-xs btn-default" data-page="next" ${
					this.current_page >= pages ? "disabled" : ""
				}>${frappe.utils.escape_html(__("Next"))}</button>
			</div>`);
		this.$footer.find("[data-page]").on("click", (e) => {
			const pages_now = Math.max(1, Math.ceil(this.total / PAGE_LENGTH));
			this.current_page =
				$(e.currentTarget).data("page") === "next"
					? Math.min(pages_now, this.current_page + 1)
					: Math.max(1, this.current_page - 1);
			this.load().then(() =>
				sanad.ui.announce(__("Page {0} of {1}", [this.current_page, pages_now]))
			);
		});
	}

	bind_table() {
		this.$el.on("click", ".wa-contacts__sort", (e) => {
			const field = $(e.currentTarget).data("sort");
			const [current, dir] = this.order_by.split(" ");
			this.order_by = current === field && dir === "desc" ? `${field} asc` : `${field} desc`;
			this.current_page = 1;
			this.load();
		});
		this.$el.on("click", ".wa-contacts__expand", (e) => {
			const name = $(e.currentTarget).data("name");
			this.expanded.has(name) ? this.collapse(name) : this.expand(name);
		});
		this.$el.on("change", ".wa-contacts__check", (e) => {
			const name = $(e.currentTarget).data("name");
			e.currentTarget.checked ? this.selected.add(name) : this.selected.delete(name);
			this.sync_selection();
		});
		this.$el.on("change", ".wa-contacts__check-all", (e) => {
			const on = e.currentTarget.checked;
			this.rows.forEach((r) => (on ? this.selected.add(r.name) : this.selected.delete(r.name)));
			this.sync_selection();
		});
		this.$el.on("click", ".wa-contacts__more", (e) => this.open_menu($(e.currentTarget)));
	}

	// ---- selection and bulk actions ---------------------------------------------------------

	sync_selection() {
		this.$el.find(".wa-contacts__check").each((_i, el) => {
			el.checked = this.selected.has($(el).data("name"));
			$(el).closest("tr").attr("aria-selected", el.checked ? "true" : "false");
		});
		const on_page = this.rows.filter((r) => this.selected.has(r.name)).length;
		const $all = this.$el.find(".wa-contacts__check-all")[0];
		if ($all) {
			$all.checked = on_page > 0 && on_page === this.rows.length;
			$all.indeterminate = on_page > 0 && on_page < this.rows.length;
		}
		this.render_bulk();
	}

	render_bulk() {
		const n = this.selected.size;
		if (!n || !CAN_WRITE()) return this.$bulk.prop("hidden", true).empty();
		this.$bulk.prop("hidden", false).html(`
			<span class="wa-contacts__bulk-count" role="status">${frappe.utils.escape_html(
				sanad.ui.plural(n, { one: __("{0} contact selected"), other: __("{0} contacts selected") })
			)}</span>
			<button type="button" class="btn btn-xs btn-primary" data-bulk="link">${frappe.utils.escape_html(
				__("Link {0} to an account", [sanad.ui.format_int(n)])
			)}</button>
			<button type="button" class="btn btn-xs btn-default" data-bulk="clear">${frappe.utils.escape_html(
				__("Clear selection")
			)}</button>`);
		this.$bulk.find('[data-bulk="clear"]').on("click", () => {
			this.selected.clear();
			this.sync_selection();
		});
		this.$bulk.find('[data-bulk="link"]').on("click", () => this.link_selected());
	}

	link_selected() {
		const names = Array.from(this.selected).slice(0, BULK_CAP);
		if (this.selected.size > BULK_CAP) {
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
						if (skipped) {
							sanad.ui.Toast.warning(
								__("{0} were already linked to that account.", [skipped])
							);
						}
						if (failed) {
							sanad.ui.Toast.error(
								__("{0} could not be linked. Open one of them to see why.", [failed])
							);
						}
						this.selected.clear();
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

	// ---- the expandable detail row ------------------------------------------------------------

	collapse(name) {
		this.expanded.delete(name);
		this.$el.find(`.wa-contacts__detail[data-for="${name}"]`).remove();
		this.$el.find(`.wa-contacts__expand[data-name="${name}"]`).attr("aria-expanded", "false");
	}

	expand(name, silent) {
		const row = this.rows.find((r) => r.name === name);
		if (!row) return;
		this.expanded.add(name);
		this.$el.find(`.wa-contacts__expand[data-name="${name}"]`).attr("aria-expanded", "true");
		const $tr = this.$el.find(`.wa-contacts__row[data-name="${name}"]`);
		this.$el.find(`.wa-contacts__detail[data-for="${name}"]`).remove();
		const span = this.columns().length + 3;
		const $detail = $(
			`<tr role="row" class="wa-contacts__detail" id="${ContactsPage.detail_id(
				name
			)}" data-for="${frappe.utils.escape_html(
				name
			)}"><td role="cell" colspan="${span}"><div class="wa-contacts__detail-body"></div></td></tr>`
		);
		$tr.after($detail);
		this.render_detail($detail.find(".wa-contacts__detail-body"), row);
		if (!silent) sanad.ui.announce(__("{0} details opened.", [row.full_name || name]));
	}

	render_detail($el, row) {
		const esc = frappe.utils.escape_html;
		const links = row.links || [];
		const phone = ContactsPage.phone_of(row);
		const alert = this.detail_alert(row);
		$el.empty();
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
			<div><dt>${esc(__("Email"))}</dt><dd>${
			row.email_id ? `<span class="sanad-table__ltr">${esc(row.email_id)}</span>` : "&mdash;"
		}</dd></div>
		</dl>`);

		const $blocks = $('<div class="wa-contacts__blocks"></div>').appendTo($el);
		const $accounts = $(
			`<section class="wa-contacts__block"><h4>${esc(__("Linked accounts"))}</h4><div></div></section>`
		).appendTo($blocks);
		if (links.length) {
			$accounts.find("div").html(
				`<ul class="wa-contacts__list">${links
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
			`<section class="wa-contacts__block"><h4>${esc(__("Recent messages"))}</h4><div></div></section>`
		).appendTo($blocks);
		this.render_messages($messages.find("div"), phone);

		const $actions = $('<div class="wa-contacts__row-actions"></div>').appendTo($el);
		this.actions_for(row).forEach((a) => {
			$(
				`<button type="button" class="btn btn-xs ${a.primary ? "btn-primary" : "btn-default"}">${
					a.icon ? sanad.ui.icon(a.icon, "xs") + " " : ""
				}${esc(a.label)}</button>`
			)
				.on("click", () => a.handler(row))
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
					`<ul class="wa-contacts__list wa-contacts__list--messages">${rows
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
			.catch((err) => state.error(err, { action: { label: __("Retry"), onclick: () => this.render_messages($el, phone) } }));
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

	open_menu($button) {
		this.close_menu();
		const row = this.rows.find((r) => r.name === $button.data("name"));
		if (!row) return;
		const actions = this.actions_for(row);
		if (!actions.length) return;
		const menu_id = sanad.ui.uid("wa-contacts-menu");
		const $menu = $(`<div class="wa-contacts__menu" role="menu" id="${menu_id}"></div>`);
		actions.forEach((a) => {
			$(
				`<button type="button" role="menuitem" class="wa-contacts__menu-item${
					a.danger ? " wa-contacts__menu-item--danger" : ""
				}">${a.icon ? sanad.ui.icon(a.icon, "xs") : ""}<span>${frappe.utils.escape_html(a.label)}</span></button>`
			)
				.on("click", () => {
					this.close_menu();
					a.handler(row);
				})
				.appendTo($menu);
		});
		$menu.appendTo($button.closest("td"));
		$button.attr({ "aria-expanded": "true", "aria-controls": menu_id });
		this.$menu = $menu;
		this.menu_opener = $button;
		this.untrap_menu = sanad.ui.trap_focus($menu);
		$menu.find("button").first().trigger("focus");
		$menu.on("keydown", (e) => {
			const items = $menu.find("button").toArray();
			if (e.key === "Escape") {
				e.stopPropagation();
				this.close_menu();
				return;
			}
			const idx = sanad.ui.roving_index(e, items, items.indexOf(document.activeElement));
			if (idx < 0) return;
			e.preventDefault();
			items[idx].focus();
		});
		this.outside = (e) => {
			if (!$(e.target).closest(".wa-contacts__menu, .wa-contacts__more").length) this.close_menu();
		};
		$(document).on("click.wacontactsmenu", this.outside);
	}

	close_menu() {
		if (!this.$menu) return;
		this.untrap_menu && this.untrap_menu();
		this.$menu.remove();
		this.$menu = null;
		$(document).off("click.wacontactsmenu");
		if (this.menu_opener) {
			this.menu_opener.attr("aria-expanded", "false").removeAttr("aria-controls");
			if (document.contains(this.menu_opener[0])) this.menu_opener.trigger("focus");
			this.menu_opener = null;
		}
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
				{
					label: __("Current state"),
					value: confirmed ? __("Confirmed by hand") : __("No conversation"),
				},
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
		this.form = new ContactForm({
			row,
			page: this,
			on_saved: () => this.reload(),
		});
		this.form.show();
	}

	// ---- realtime ------------------------------------------------------------------------------

	bind_realtime() {
		this.on_inbound = sanad.ui.throttle(() => this.load(), 4000);
		const subscribe = () => frappe.realtime.on("wa:inbound:received", this.on_inbound);
		const unsubscribe = () => frappe.realtime.off("wa:inbound:received", this.on_inbound);
		subscribe();
		$(this.wrapper).on("show", subscribe);
		$(this.wrapper).on("hide", () => {
			unsubscribe();
			this.close_menu();
		});
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
						<h4>${esc(__("Linked accounts"))}</h4>
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
			$el.html(
				`<p class="wa-contact-form__empty">${esc(__("No account is linked to this number"))}</p>`
			);
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
		if (!values.first_name) missing.push({ field: "first_name", label: __("First name") });
		if (!values.phone_nos.length) missing.push({ field: "phone", label: __("WhatsApp number") });
		const $summary = this.$root.find(".wa-contact-form__summary");
		if (missing.length) {
			$summary
				.prop("hidden", false)
				.html(
					`${frappe.utils.escape_html(__("Fill in the required fields:"))} ${missing
						.map((m) => frappe.utils.escape_html(m.label))
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

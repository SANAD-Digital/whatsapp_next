// whatsapp.ui.GroupCreate — create a WhatsApp group from any screen: the device that will own it,
// the group's name and description, and its members — the numbers the host passed in (a selection
// of contacts, contact groups or numbers) plus any chosen with the ContactPicker (local mode).
// After creating, the dialog shows what became of every number: added, needs an invitation (their
// privacy settings refuse being added; the invite link is offered), or not on WhatsApp.
// Data through `wa_groups.*` and `devices.list_devices`; a `contact` option saves the group among
// that contact's numbers.

import ui from "../_core/index.js";

const STATUS = {
	added: { label: () => __("Added"), colour: "green" },
	invite_required: { label: () => __("Needs an invitation"), colour: "orange" },
	not_on_whatsapp: { label: () => __("Not on WhatsApp"), colour: "gray" },
	failed: { label: () => __("Not added"), colour: "red" },
};

whatsapp.ui.GroupCreate = class GroupCreate {
	/**
	 * @param {Object} opts
	 * @param {Array<{phone_e164: string, display_name?: string}>} [opts.members] — numbers to start with
	 * @param {{doctype: string, names: string[]}} [opts.source] — or: read the members behind these records
	 * @param {string} [opts.contact] — save the new group among this Contact's numbers
	 * @param {string} [opts.name] — a suggested group name
	 * @param {Function} [opts.on_created] — `(result) => void`
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({}, opts);
		this.members = new Map();
		(opts.members || []).forEach((m) => this.add(m));
		this.make();
		this.dialog.show();
		this.load();
	}

	add(m) {
		const key = m && (m.phone_e164 || m.phone);
		if (key && !this.members.has(key)) this.members.set(key, { phone_e164: key, display_name: m.display_name || "" });
	}

	make() {
		this.dialog = new frappe.ui.Dialog({
			title: __("Create WhatsApp group"),
			size: "large",
			fields: [
				{ fieldtype: "Data", fieldname: "group_name", label: __("Group name"), reqd: 1, length: 100, default: this.opts.name || "" },
				{ fieldtype: "Select", fieldname: "device", label: __("Device"), reqd: 1, options: [], description: __("The number that creates the group and becomes its admin.") },
				{ fieldtype: "Column Break", fieldname: "col_1" },
				{ fieldtype: "Small Text", fieldname: "description", label: __("Description") },
				{ fieldtype: "Section Break", fieldname: "sec_members", label: __("Members") },
				{ fieldtype: "HTML", fieldname: "members" },
			],
			primary_action_label: __("Create group"),
			primary_action: (values) => this.create(values),
		});
		this.dialog.$wrapper.addClass("whatsapp-kit whatsapp-kit-sheet whatsapp-kit-group-create");
		this.$members = this.dialog.get_field("members").$wrapper;
		this.draw_members();
	}

	load() {
		const devices = ui.call("devices.list_devices", {}, { silent: true }).then((r) => {
			const rows = ((r && r.rows) || r || []).filter((d) => d.status === "Connected" && !cint(d.disabled));
			const field = this.dialog.get_field("device");
			field.df.options = rows.map((d) => ({ value: d.name, label: d.device_name || d.name }));
			field.refresh();
			const preferred = rows.find((d) => cint(d.is_default)) || rows[0];
			if (preferred) this.dialog.set_value("device", preferred.name);
			if (!rows.length) field.set_description(__("No device is connected. Connect one first."));
		});
		const source = this.opts.source;
		const members = source && source.names && source.names.length
			? ui.call("wa_groups.members_from", { source_doctype: source.doctype, names: source.names }).then((r) => {
				((r && r.members) || []).forEach((m) => this.add(m));
				this.draw_members();
			})
			: Promise.resolve();
		return Promise.all([devices, members]);
	}

	draw_members() {
		const esc = ui.escape;
		const rows = [...this.members.values()];
		this.$members.html(`<div class="whatsapp-kit-group-create__members">
			<div class="whatsapp-kit-group-create__bar">
				<span class="whatsapp-kit-group-create__count">${esc(whatsapp.ui.plural(rows.length, { one: __("{0} number"), other: __("{0} numbers") }))}</span>
				<button type="button" class="btn btn-xs btn-default whatsapp-kit-group-create__pick">${ui.icon("es-line-add", "xs")} ${esc(__("Choose numbers"))}</button>
			</div>
			${rows.length
				? `<ul class="whatsapp-kit-group-create__list">${rows.map((m) => `<li data-key="${esc(m.phone_e164)}">
					<span class="whatsapp-kit-group-create__name">${esc(m.display_name || "")}</span>
					<bdi class="whatsapp-kit-tabular" dir="ltr">${esc(whatsapp.ui.phone ? whatsapp.ui.phone(m.phone_e164) : m.phone_e164)}</bdi>
					<button type="button" class="whatsapp-kit-group-create__drop" aria-label="${esc(__("Remove {0}", [m.display_name || m.phone_e164]))}">${ui.icon("es-line-close", "xs")}</button>
				</li>`).join("")}</ul>`
				: `<p class="whatsapp-kit-group-create__empty">${esc(__("No numbers yet. Choose the people to add."))}</p>`}
		</div>`);
		this.$members.find(".whatsapp-kit-group-create__pick").on("click", () => this.pick());
		this.$members.find(".whatsapp-kit-group-create__drop").on("click", (e) => {
			this.members.delete($(e.currentTarget).closest("li").data("key"));
			this.draw_members();
		});
	}

	pick() {
		new whatsapp.ui.ContactPicker({
			title: __("Choose the group's members"),
			existing: [...this.members.keys()],
			on_pick: (rows) => {
				(rows || []).forEach((r) => this.add(r));
				this.draw_members();
			},
		});
	}

	create(values) {
		if (!this.members.size) {
			whatsapp.ui.Toast.error(__("Choose at least one number to add"));
			return;
		}
		ui.call("wa_groups.create_group", {
			device: values.device,
			name: values.group_name,
			description: values.description || null,
			members: [...this.members.keys()],
			contact: this.opts.contact || null,
		}, { freeze: true, freeze_message: __("Creating the group…") })
			.then((r) => {
				this.dialog.hide();
				this.report(r);
				if (this.opts.on_created) this.opts.on_created(r);
			})
			.catch((err) => whatsapp.ui.Toast.error(err));
	}

	/** What became of every number, and the invite link for those who need it. */
	report(r) {
		const esc = ui.escape;
		const members = (r && r.members) || [];
		const names = Object.fromEntries([...this.members.values()].map((m) => [String(m.phone_e164).replace(/^\+/, ""), m.display_name]));
		const rows = members.map((m) => {
			const s = STATUS[m.status] || STATUS.failed;
			return `<li><span class="whatsapp-kit-group-create__name">${esc(names[m.phone] || "")}</span>
				<bdi class="whatsapp-kit-tabular" dir="ltr">${esc("+" + m.phone)}</bdi>
				${whatsapp.ui.StatusBadge.html({ label: s.label(), colour: s.colour })}</li>`;
		}).join("");
		const d = new frappe.ui.Dialog({
			title: __("Group created: {0}", [r.name]),
			size: "large",
			fields: [{ fieldtype: "HTML", fieldname: "body" }],
			primary_action_label: __("Done"),
			primary_action: () => d.hide(),
		});
		d.$wrapper.addClass("whatsapp-kit whatsapp-kit-sheet whatsapp-kit-group-create");
		const invite = r.invite_link
			? `<div class="whatsapp-kit-group-create__invite">
				<p>${esc(__("Some people's privacy settings refuse being added to groups. Send them this link to join:"))}</p>
				<div class="whatsapp-kit-group-create__link"><bdi dir="ltr">${esc(r.invite_link)}</bdi>
				<button type="button" class="btn btn-xs btn-default whatsapp-kit-group-create__copy">${esc(__("Copy"))}</button></div>
			</div>`
			: "";
		const saved = r.saved_to_contact ? `<p class="whatsapp-kit-group-create__saved">${esc(__("The group is saved among the contact's numbers."))}</p>` : "";
		d.get_field("body").$wrapper.html(`${saved}<ul class="whatsapp-kit-group-create__list whatsapp-kit-group-create__list--report">${rows}</ul>${invite}`);
		d.get_field("body").$wrapper.find(".whatsapp-kit-group-create__copy").on("click", () => {
			frappe.utils.copy_to_clipboard(r.invite_link);
		});
		d.show();
	}
};

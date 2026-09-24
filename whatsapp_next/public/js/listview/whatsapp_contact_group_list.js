// WhatsApp Contact Group list (09 row 14, D-064 option A — prototype-faithful): PageHeader (title,
// description, "New group", KPIs Groups · Total members · Blacklists), FilterBar (search, kind,
// source), DataList columns as the prototype (group + description, kind chip, members, source,
// last updated, Edit, View) with an expandable row showing the first 10 members
// (`picker.get_group_members`) and the description note. The kind indicator here is the one
// colour source (read through `sanad.ui.indicator_for`). Until `sanad.ui.DataList` lands, the
// native rows keep RowActions.

const KIND_COLOUR = { Blacklist: "red", Marketing: "blue", "Mailing List": "green", Professional: "green", Other: "green" };
const MEMBER_PEEK = 10;
const esc = (v) => sanad.ui.escape(v);
const fmt_int = (v) => sanad.ui.format_int(v);
const can_send = () => frappe.user.has_role("WhatsApp Manager") || frappe.user.has_role("System Manager");

function campaign_for_group(name, group_name) {
	frappe.flags.wa_picker_group = name;
	frappe.new_doc("WhatsApp Campaign", { campaign_name: __("Campaign for {0}", [group_name || name]) });
}

/** Expandable row: first 10 members + the description note. */
function expand_group($el, doc) {
	const state = new sanad.ui.EmptyState({ wrapper: $el, state: "loading", size: "sm", rows: 2 });
	return sanad.ui
		.call("picker.get_group_members", { group: doc.name, page: 1, page_length: MEMBER_PEEK }, { silent: true })
		.then((r) => {
			const rows = (r && r.rows) || [];
			const total = cint(r && r.total);
			state.hide();
			const $box = $('<div class="wa-group-expand"></div>');
			if (doc.description) $box.append(`<p class="text-muted small">${esc(doc.description)}</p>`);
			if (!rows.length) {
				$box.append(`<p class="text-muted small">${esc(__("This group has no members yet."))}</p>`);
			} else {
				const $wrap = $('<div class="sanad-table-wrap"></div>');
				let html = `<table class="sanad-table"><thead><tr><th scope="col">${esc(__("Name"))}</th><th scope="col">${esc(__("Phone"))}</th><th scope="col">${esc(__("Contact"))}</th></tr></thead><tbody>`;
				rows.forEach((m) => {
					html += `<tr><td>${esc(m.display_name || "")}</td><td class="sanad-table__ltr sanad-tabular">${esc(m.phone_e164 || m.phone || "")}</td><td>${m.contact ? `<a href="/app/contact/${encodeURIComponent(m.contact)}">${esc(m.contact)}</a>` : ""}</td></tr>`;
				});
				html += "</tbody></table>";
				$box.append($wrap.html(html));
				if (total > rows.length) $box.append(`<p class="text-muted small">${esc(__("Showing {0} of {1} members", [fmt_int(rows.length), fmt_int(total)]))}</p>`);
			}
			$(`<button type="button" class="btn btn-default btn-xs">${esc(__("Open members"))}</button>`)
				.on("click", () => frappe.set_route("Form", "WhatsApp Contact Group", doc.name))
				.appendTo($box);
			$el.html($box);
		})
		.catch((err) => state.error(err, { action: { label: __("Retry"), onclick: () => expand_group($el, doc) } }));
}

frappe.listview_settings["WhatsApp Contact Group"] = {
	add_fields: ["group_name", "kind", "disabled", "member_count", "source", "description", "members_changed_at", "modified"],
	hide_name_column: true,

	get_indicator(doc) {
		if (cint(doc.disabled)) return [__("Disabled"), "gray", "disabled,=,1"];
		return [__(doc.kind || "Other"), KIND_COLOUR[doc.kind] || "green", `kind,=,${doc.kind}`];
	},

	onload(listview) {
		const ui = sanad.ui;
		listview.sanad_header = new ui.PageHeader({
			listview,
			title: __("Contact groups"),
			description: __("Lists used as campaign audiences and in command permissions. A blacklist is blocked from every send."),
			primary: { label: __("New group"), icon: "es-line-add", perm: "create", handler: () => frappe.new_doc("WhatsApp Contact Group") },
			stats: [
				{ key: "groups", label: __("Groups"), icon: "es-line-people", count: { doctype: "WhatsApp Contact Group", filters: { disabled: 0 } }, sub: __("All lists defined in the system") },
				{ key: "members", label: __("Total members"), icon: "es-line-people", tone: "blue", sum: { doctype: "WhatsApp Contact Group", field: "member_count", filters: { disabled: 0 } }, sub: __("Members across all groups") },
				{
					key: "blacklist",
					label: __("Blacklists"),
					icon: "es-line-alert-triangle",
					tone: "amber",
					count: { doctype: "WhatsApp Contact Group", filters: { kind: "Blacklist", disabled: 0 } },
					sub: __("Blocked from commands and campaigns"),
					onclick: () => listview.filter_area.add([["WhatsApp Contact Group", "kind", "=", "Blacklist"]]),
				},
			],
		});

		if (typeof ui.FilterBar === "function") {
			new ui.FilterBar({
				listview,
				actions: ["group_by", "export"],
				presets: [
					{ fieldname: "group_name", type: "search", fields: ["group_name", "description"], placeholder: __("Group name…") },
					{ fieldname: "kind", type: "select" },
					{ fieldname: "source", type: "select" },
				],
			});
		}

		const columns = [
			{ fieldname: "group_name", label: __("Group"), sortable: true, format: (v, doc) => esc(v || doc.name), sub: (doc) => esc(doc.description || "") },
			{ fieldname: "kind", label: __("Kind"), type: "status", sortable: true, format: (v, doc) => ui.StatusBadge.html({ label: __(v || "Other"), colour: ui.indicator_for("WhatsApp Contact Group", Object.assign({ doctype: "WhatsApp Contact Group" }, doc)).colour, icon: false }) },
			{ fieldname: "member_count", label: __("Members"), type: "number", align: "end", sortable: true },
			{ fieldname: "source", label: __("Source"), sortable: true, format: (v) => esc(v ? __(v) : "") },
			{ fieldname: "members_changed_at", label: __("Last updated"), type: "date", sortable: true, format: (v, doc) => esc(frappe.datetime.str_to_user((v || doc.modified || "").split(" ")[0])) },
			{ fieldname: "_edit", label: __("Edit"), sortable: false, format: (v, doc) => `<a class="btn btn-default btn-xs" href="/app/whatsapp-contact-group/${encodeURIComponent(doc.name)}">${esc(__("Edit"))}</a>` },
		];

		if (typeof ui.DataList === "function") {
			listview.sanad_datalist = new ui.DataList({
				listview,
				columns,
				selectable: true,
				on_row_click: (doc) => frappe.set_route("Form", "WhatsApp Contact Group", doc.name),
				expand: expand_group,
				page_length: 50,
				footer: { count: (total) => ui.plural(total, { one: __("{0} group"), two: __("{0} groups"), few: __("{0} groups"), many: __("{0} groups"), other: __("{0} groups") }) },
				empty: { title: __("No groups yet"), description: __("Create a group or import a CSV to target it from campaigns."), action: frappe.model.can_create("WhatsApp Contact Group") ? { label: __("New group"), onclick: () => frappe.new_doc("WhatsApp Contact Group") } : undefined },
				mobile: "cards",
			});
		} else if (typeof ui.RowActions === "function") {
			new ui.RowActions({
				listview,
				actions: [
					{ label: __("Members"), icon: "es-line-people", handler: (doc) => frappe.set_route("Form", "WhatsApp Contact Group", doc.name) },
					{ label: __("Campaign for this group"), icon: "es-line-email", condition: (doc) => !cint(doc.disabled) && doc.kind !== "Blacklist" && can_send(), handler: (doc) => campaign_for_group(doc.name, doc.group_name) },
				],
			});
		}
	},
};

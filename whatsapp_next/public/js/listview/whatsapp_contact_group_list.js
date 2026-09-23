// WhatsApp Contact Group list (09 row 14): kind indicator (Blacklist red, disabled gray),
// ListStatsCard (groups count + members total via a `sum` aggregate), FilterBar `kind` tabs (when
// the kit's FilterBar is present) and RowActions ("Campaign for this group" → new campaign with
// the group preselected in the ContactPicker; "Members" → form).

const KIND_COLOUR = { Blacklist: "red", Marketing: "blue", "Mailing List": "green", Professional: "green", Other: "green" };

function campaign_for_group(name, group_name) {
	frappe.flags.wa_picker_group = name;
	frappe.new_doc("WhatsApp Campaign", { campaign_name: __("Campaign for {0}", [group_name || name]) });
}

frappe.listview_settings["WhatsApp Contact Group"] = {
	add_fields: ["kind", "disabled", "member_count", "group_name"],

	get_indicator(doc) {
		if (cint(doc.disabled)) return [__("Disabled"), "gray", "disabled,=,1"];
		return [__(doc.kind || "Other"), KIND_COLOUR[doc.kind] || "green", `kind,=,${doc.kind}`];
	},

	onload(listview) {
		listview.sanad_stats = new sanad.ui.ListStatsCard({
			listview,
			cards: [
				{ key: "groups", label: __("Groups"), icon: "es-line-folder", count: { doctype: "WhatsApp Contact Group", filters: { disabled: 0 } } },
				{ key: "members", label: __("Members in total"), icon: "es-line-people", sum: { doctype: "WhatsApp Contact Group", field: "member_count", filters: { disabled: 0 } } },
				{
					key: "blacklist",
					label: __("Blacklisted numbers"),
					icon: "es-line-close-circle",
					tone: "red",
					sum: { doctype: "WhatsApp Contact Group", field: "member_count", filters: { kind: "Blacklist", disabled: 0 } },
					onclick: () => listview.filter_area.add([["WhatsApp Contact Group", "kind", "=", "Blacklist"]]),
				},
			],
		});

		if (typeof sanad.ui.FilterBar === "function") {
			new sanad.ui.FilterBar({ listview, presets: [{ fieldname: "kind", type: "tabs" }] });
		}

		const actions = [
			{ label: __("Members"), icon: "es-line-people", handler: (doc) => frappe.set_route("Form", "WhatsApp Contact Group", doc.name) },
			{ label: __("Campaign for this group"), icon: "es-line-email", condition: (doc) => !cint(doc.disabled) && doc.kind !== "Blacklist" && (frappe.user.has_role("WhatsApp Manager") || frappe.user.has_role("System Manager")), handler: (doc) => campaign_for_group(doc.name, doc.group_name) },
		];
		if (typeof sanad.ui.RowActions === "function") {
			new sanad.ui.RowActions({ listview, actions });
		}
	},
};

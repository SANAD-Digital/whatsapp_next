// WhatsApp Contact Group form (09 row 14): the members child table becomes a PagedChildTable fed
// by `picker.get_group_members {group, page, page_length}` with ContactPicker add / remove; a
// Blacklist group shows an amber banner; the `?import=csv` route (or the list's "Import CSV",
// through `frappe.flags.wa_group_import_csv`) opens the picker on the phone export source with
// CSV preselected once the new group is saved. Tabs: Group · Members.

function is_blacklist(frm) {
	return frm.doc.kind === "Blacklist";
}

function can_change_members(frm) {
	return !frm.is_new() && !frm.is_dirty() && !frm.doc.disabled && frappe.perm.has_perm(frm.doctype, 0, "write", frm.doc);
}

function open_picker(frm, operation, preselect) {
	new sanad.ui.ContactPicker({
		target_doctype: frm.doctype,
		target_name: frm.doc.name,
		operation,
		preselect,
		target_label: frm.doc.group_name || frm.doc.name,
		on_commit: () => frm.reload_doc(),
	});
}

function mount_members(frm) {
	// Shown as visible text next to the buttons when they are disabled (never only a hover title).
	const hint = frm.is_new() || frm.is_dirty() ? __("Save the group to add or remove members.") : frm.doc.disabled ? __("The group is disabled, so members cannot change.") : undefined;
	const toolbar_actions = [
		{ label: __("Add members"), primary: true, icon: "es-line-add", disabled: !can_change_members(frm), hint, handler: () => open_picker(frm, "add") },
		{ label: __("Remove members"), icon: "es-line-delete", condition: () => cint(frm.doc.member_count) > 0, disabled: !can_change_members(frm), hint, handler: () => open_picker(frm, "remove") },
	];
	if (frm.sanad_members && frm.sanad_members.frm === frm && frm.$wrapper.find('.sanad-pct[data-fieldname="members"]').length) {
		frm.sanad_members.update({ toolbar_actions });
		return;
	}
	frm.sanad_members = new sanad.ui.PagedChildTable({
		frm,
		fieldname: "members",
		page_method: "picker.get_group_members",
		args: (s) => ({ group: frm.doc.name, page: s.page, page_length: s.page_length }),
		page_length: 50,
		columns: [{ fieldname: "display_name" }, { fieldname: "phone_e164" }, { fieldname: "contact" }, { fieldname: "source_type" }],
		status_field: null,
		search: false,
		row_actions: [{ label: __("Open contact"), icon: "es-line-people", condition: (row) => !!row.contact, handler: (row) => frappe.set_route("Form", "Contact", row.contact) }],
		toolbar_actions,
		empty_text: __("No members yet"),
	});
}

function render_banner(frm) {
	if (is_blacklist(frm)) {
		frm.dashboard.set_headline(
			`<span>${frappe.utils.icon("es-line-alert-triangle", "sm")} ${frappe.utils.escape_html(__("Members of this group are blocked everywhere: commands, campaigns and quick sends never reach them."))}</span>`,
			"orange"
		);
	} else if (frm.doc.disabled) {
		frm.dashboard.set_headline(frappe.utils.escape_html(__("This group is disabled. It is not offered when choosing recipients.")), "gray");
	} else {
		frm.dashboard.clear_headline();
	}
}

frappe.ui.form.on("WhatsApp Contact Group", {
	onload(frm) {
		const ro = frappe.route_options || {};
		const params = frappe.utils.get_query_params ? frappe.utils.get_query_params() : {};
		if (ro.import === "csv" || params.import === "csv" || (frm.is_new() && frappe.flags.wa_group_import_csv)) {
			frappe.flags.wa_group_import_csv = false;
			frm.sanad_import_csv = true;
			if (ro.import) delete frappe.route_options.import;
		}
	},

	refresh(frm) {
		render_banner(frm);
		mount_members(frm);
		if (!frm.is_new()) {
			frm.add_custom_button(__("Campaign for this group"), () => {
				frappe.flags.wa_picker_group = frm.doc.name;
				frappe.new_doc("WhatsApp Campaign", { campaign_name: __("Campaign for {0}", [frm.doc.group_name || frm.doc.name]) });
			}, __("Actions"));
		}
		if (frm.sanad_import_csv && can_change_members(frm)) {
			frm.sanad_import_csv = false;
			open_picker(frm, "add", { source: "phonebook", kind: "csv" });
		}
	},

	kind(frm) {
		render_banner(frm);
	},
});

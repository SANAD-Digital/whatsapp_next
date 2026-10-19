// WhatsApp Settings form: the `picker_sources` table edits through the same smart editor as the
// settings window (`whatsapp_next.PickerSourceEditor`, owner 2026-10-19) instead of Desk's row form,
// whose plain text boxes asked for field names by heart. Adding opens the editor on a new row;
// opening a row opens the editor on it. What the editor returns is written into the row and the
// form is saved the usual way.

const PICKER_CHILD = "WhatsApp Settings Picker Source";
const PICKER_FIELDS = ["document_type", "label", "phone_source", "phone_fieldname", "contact_fieldname", "name_fieldname", "filters_json", "enabled"];

function picker_editor(frm, cdn) {
	const rows = frm.doc.picker_sources || [];
	const row = cdn ? rows.find((r) => r.name === cdn) : null;
	new whatsapp_next.PickerSourceEditor({
		row: row ? Object.assign({}, row) : {},
		taken: rows.filter((r) => r !== row).map((r) => r.document_type),
		on_save: (values) => {
			const target = row || frappe.model.add_child(frm.doc, PICKER_CHILD, "picker_sources");
			PICKER_FIELDS.forEach((f) => frappe.model.set_value(target.doctype, target.name, f, values[f] == null ? "" : values[f]));
			frm.refresh_field("picker_sources");
			frm.dirty();
		},
	});
}

frappe.ui.form.on("WhatsApp Settings", {
	refresh(frm) {
		const field = frm.fields_dict.picker_sources;
		if (!field || !field.grid) return;
		const grid = field.grid;
		grid.cannot_add_rows = true;
		grid.wrapper.find(".grid-add-row").hide();
		if (!grid.wa_add && frm.perm[0] && frm.perm[0].write) {
			grid.wa_add = grid.add_custom_button(__("Add a source"), () => picker_editor(frm, null));
			grid.wa_add.removeClass("btn-secondary").addClass("btn-default");
		}
		grid.refresh();
	},
});

frappe.ui.form.on(PICKER_CHILD, {
	// Desk opened the row's own form: close it and open the editor on the row instead
	form_render(frm, cdt, cdn) {
		const grid_row = frm.fields_dict.picker_sources.grid.grid_rows_by_docname[cdn];
		setTimeout(() => grid_row && grid_row.toggle_view(false), 0);
		picker_editor(frm, cdn);
	},
});

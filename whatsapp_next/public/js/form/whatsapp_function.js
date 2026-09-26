// WhatsApp Function form (09 §1B row 7): the installed record. Manifest, version and checksum are
// read-only; the settings and outputs children stay editable for a Manager. The storefront, the
// versions and the linked commands live in the Functions Center, opened here on this function.

frappe.ui.form.on("WhatsApp Function", {
	refresh(frm) {
		if (frm.is_new()) return;
		frm.add_custom_button(__("Open in Functions Center"), () => {
			frappe.route_options = { function: frm.doc.name };
			frappe.set_route("wa-functions-center");
		});
	},
});

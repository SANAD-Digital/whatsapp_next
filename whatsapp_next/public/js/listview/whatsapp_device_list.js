// WhatsApp Device list — the native read fallback of screen 3 (09 §1B row 3). The product screen
// is the `wa-devices` page (card grid, pairing); here the status colours match it and the primary
// action opens that page instead of Desk's New, because a device is registered with the platform
// before it exists locally (the controller refuses any other insert).

frappe.listview_settings["WhatsApp Device"] = {
	hide_name_column: true,
	add_fields: ["status", "device_name", "phone_e164", "is_default", "last_seen", "disabled"],

	get_indicator(doc) {
		const colour = { Connected: "green", "Pending QR": "blue", Disconnected: "orange", "Logged Out": "red" }[doc.status] || "gray";
		return [__(doc.status), colour, `status,=,${doc.status}`];
	},

	onload(listview) {
		// Desk re-draws "Add WhatsApp Device" after loading and whenever the selection clears
		// (`ListView.set_primary_action`), so the method itself is replaced on this list.
		listview.set_primary_action = function () {
			this.page.set_primary_action(__("Open Devices page"), () => frappe.set_route("wa-devices"), "es-line-arrow-up-right");
		};
		listview.set_primary_action();
	},

	// Desk calls this instead of opening a new form (the Add button and Ctrl+B).
	primary_action() {
		frappe.set_route("wa-devices");
	},
};

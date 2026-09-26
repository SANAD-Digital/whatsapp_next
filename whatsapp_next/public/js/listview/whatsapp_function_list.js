// WhatsApp Function list — the native view of installed functions (09 §1B row 7). The product
// screen is the Functions Center page; functions are installed from its catalog, never created
// here (no role has create), so the primary action opens the page, and a row opens it on that
// function.

frappe.listview_settings["WhatsApp Function"] = {
	add_fields: ["status", "update_available", "installed_version"],

	get_indicator(doc) {
		if (cint(doc.update_available)) return [__("Update available"), "blue", "update_available,=,1"];
		return doc.status === "Active" ? [__("Active"), "green", "status,=,Active"] : [__("Inactive"), "gray", "status,=,Inactive"];
	},

	onload(listview) {
		const open_center = () => frappe.set_route("wa-functions-center");
		listview.set_primary_action = function () {
			this.page.set_primary_action(__("Open Functions Center"), open_center, "es-line-arrow-up-right");
		};
		listview.set_primary_action();
	},

	primary_action() {
		frappe.set_route("wa-functions-center");
	},
};

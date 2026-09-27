// Screen 15 — Subscription, usage and settings. Since D-138 this is a window
// (`whatsapp_next.settings.open`, public/js/screens/settings.js) that opens over whatever screen
// the user is on. The route stays so old links and bookmarks keep working: it opens the window
// on the section the link names, and closing the window goes back to where the user came from.

frappe.pages["wa-settings"].on_page_load = function (wrapper) {
	frappe.ui.make_app_page({ parent: wrapper, title: __("Settings"), single_column: true });
};

frappe.pages["wa-settings"].on_page_show = function () {
	let section = null;
	try {
		section = new URLSearchParams(window.location.search || "").get("section");
	} catch (e) {
		section = null;
	}
	section = section || (frappe.route_options || {}).section || (frappe.get_route() || [])[1] || null;
	frappe.route_options = null;
	whatsapp_next.settings.open(section, {
		on_close: () => {
			if ((frappe.get_route() || [])[0] !== "wa-settings") return;
			if ((frappe.route_history || []).length > 1 && window.history.length > 1) window.history.back();
			else frappe.set_route("wa-home");
		},
	});
};

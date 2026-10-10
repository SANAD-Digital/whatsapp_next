// Spec #1, the way into the Onboarding Wizard: a System Manager on a site that is not registered
// with its platform yet is sent to the wizard (`frappe.boot.whatsapp_next.setup_redirect`, computed
// by `services.onboarding.should_redirect_to_wizard`). Once per browser session, so the app stays
// reachable after they leave the wizard; Home's setup band keeps pointing back.
//
// It answers on any screen of the product, not Home alone (owner, 2026-10-08): how a person gets
// into the app depends on the apps around it. Frappe's desktop icon opens the sidebar's first link
// (Home), but a theme's app rail can open the workspace itself — on a site with `snd_theme` the
// wizard never showed because Home was never opened.

(function () {
	const KEY = "whatsapp_next:setup_redirected";
	const WIZARD = "wa-onboarding";
	const WORKSPACES = ["WhatsApp", "WhatsApp Next"];
	// the Desk views a DocType of this app can open in
	const DOCTYPE_VIEWS = ["List", "Form", "Tree", "Report", "dashboard-view"];
	let done = false;

	/** Whether `route` is one of this product's screens: its Pages, its workspaces, its DocTypes. */
	function is_ours(route) {
		const [head, name] = route || [];
		if (!head || head === WIZARD) return false;
		if (head.startsWith("wa-")) return true;
		if (head === "Workspaces") return WORKSPACES.includes(name);
		return DOCTYPE_VIEWS.includes(head) && String(name || "").startsWith("WhatsApp ");
	}

	/** Send the person to the wizard when they should go; `true` when it did. */
	function redirect_to_wizard(route = frappe.get_route()) {
		if (done || !(frappe.boot.whatsapp_next || {}).setup_redirect || !is_ours(route)) return false;
		done = true;
		try {
			if (sessionStorage.getItem(KEY)) return false;
			sessionStorage.setItem(KEY, "1");
		} catch (e) {
			// storage blocked: the in-memory flag still limits it to once per page load
		}
		frappe.set_route(WIZARD);
		return true;
	}

	frappe.provide("whatsapp_next.setup");
	whatsapp_next.setup.redirect_to_wizard = redirect_to_wizard;

	$(document).on("page-change", () => redirect_to_wizard());
})();

// The way into the Onboarding Wizard (spec #1): while the product is not set up — the site is not
// signed in to its platform, or the wizard was never finished — every screen and every document of
// the product sends the person back to the setup (owner, 2026-10-19), not only Home and not only once.
// `frappe.boot.whatsapp_next.setup_redirect` says so at login (`services.onboarding.needs_setup`);
// before sending anyone away the state is asked again (`onboarding.get_status`), so a setup
// finished since the login stops the redirect at once, without a reload.
//
// Whoever may run the wizard (System Manager, WhatsApp Manager — `can_setup`) is taken to it; anyone
// else is told the product is not set up yet and taken back to the Desk home, since they could not
// finish it. The wizard itself, and the Settings form for those who may set up, stay reachable.
//
// It answers on any screen of the product (owner, 2026-10-08): how a person gets into the app depends
// on the apps around it — a theme's app rail can open the workspace itself, not Home.

(function () {
	const WIZARD = "wa-onboarding";
	const WORKSPACES = ["WhatsApp", "WhatsApp Next"];
	// the Desk views a DocType of this app can open in
	const DOCTYPE_VIEWS = ["List", "Form", "Tree", "Report", "dashboard-view", "Kanban", "Calendar", "Gantt", "Image", "Inbox"];
	let checking = false;

	const boot = () => frappe.boot.whatsapp_next || {};

	/** Whether `route` is one of this product's screens: its Pages, its workspaces, its DocTypes. */
	function is_ours(route) {
		const [head, name] = route || [];
		if (!head || head === WIZARD) return false;
		if (head.startsWith("wa-")) return true;
		if (head === "Workspaces") return WORKSPACES.includes(name);
		return DOCTYPE_VIEWS.includes(head) && String(name || "").startsWith("WhatsApp ");
	}

	/** What stays open during the setup: the Settings form, for whoever may set the product up. */
	function allowed_during_setup(route) {
		const [head, name] = route || [];
		return !!boot().can_setup && head === "Form" && name === "WhatsApp Settings";
	}

	/** The state now, not at login: `{needs_setup, can_setup}`; the login's answer when the call fails. */
	function current_state() {
		return frappe
			.xcall("whatsapp_next.api.v1.onboarding.get_status")
			.then((r) => ({ needs_setup: !!(r && r.needs_setup), can_setup: !!(r && r.can_setup) }))
			.catch(() => ({ needs_setup: !!boot().setup_redirect, can_setup: !!boot().can_setup }));
	}

	/** Send the person to the setup when the product needs it; resolves `true` when it did. */
	function redirect_to_wizard(route = frappe.get_route()) {
		if (!boot().setup_redirect || checking || !is_ours(route) || allowed_during_setup(route)) return Promise.resolve(false);
		checking = true;
		return current_state()
			.then(({ needs_setup, can_setup }) => {
				if (!needs_setup) {
					// finished since the login: stop asking for the rest of this session
					frappe.boot.whatsapp_next = Object.assign({}, boot(), { setup_redirect: false });
					return false;
				}
				// the person may have moved on while the state was read
				if (!is_ours(frappe.get_route())) return false;
				if (can_setup) {
					frappe.show_alert({ message: __("Finish setting up WhatsApp first."), indicator: "orange" });
					frappe.set_route(WIZARD);
				} else {
					frappe.msgprint({
						title: __("WhatsApp is not set up yet"),
						message: __("Ask your system manager to finish the WhatsApp setup; its screens open once it is done."),
						indicator: "orange",
					});
					frappe.set_route("");
				}
				return true;
			})
			.finally(() => (checking = false));
	}

	frappe.provide("whatsapp_next.setup");
	whatsapp_next.setup.redirect_to_wizard = redirect_to_wizard;

	$(document).on("page-change", () => redirect_to_wizard());
	// a person who lands on a screen of the product straight from a link
	$(() => frappe.after_ajax && frappe.after_ajax(() => redirect_to_wizard()));
})();

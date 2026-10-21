// The decision after the site was linked to another platform account (owner, 2026-10-22: never
// delete silently). Nothing was deleted at the switch: the previous account's devices were only
// switched off. This asks a System Manager, with the counts in front of them, whether to delete
// what that account left (`onboarding.resolve_account_switch`, a background job) or keep it.
// Closing the dialog decides nothing: it asks again on the next visit to Home.

frappe.provide("whatsapp_next.account_switch");

(function () {
	const ASKED_KEY = "wa_account_switch_asked";

	// what the previous account left, in the order a person reads it
	const ROWS = [
		["WhatsApp Device", __("Devices")],
		["WhatsApp Log", __("Sent messages")],
		["WhatsApp Inbound Message", __("Received messages")],
		["WhatsApp Queue Item", __("Queue items")],
		["WhatsApp Number", __("WhatsApp numbers")],
		["WhatsApp Webhook Event", __("Webhook events")],
		["WhatsApp Number Check", __("Number checks")],
		["WhatsApp Status Post", __("Status posts")],
	];

	function asked_this_session() {
		try {
			return window.sessionStorage.getItem(ASKED_KEY) === "1";
		} catch (e) {
			return false;
		}
	}

	function mark_asked() {
		try {
			window.sessionStorage.setItem(ASKED_KEY, "1");
		} catch (e) {
			// storage blocked: it simply asks again
		}
	}

	/**
	 * Ask when a switch is waiting for a decision. `force` asks even if the dialog was already
	 * closed in this session (right after a sign-in). Resolves once the person decided or closed it.
	 */
	function check({ force = false } = {}) {
		if (!frappe.user.has_role("System Manager")) return Promise.resolve(null);
		if (!force && asked_this_session()) return Promise.resolve(null);
		return sanad.ui
			.call("onboarding.get_account_switch", {}, { silent: true })
			.then((info) => (info && info.pending ? ask(info) : null))
			.catch(() => null);
	}

	function ask(info) {
		mark_asked();
		const counts = info.counts || {};
		return sanad.ui.ConfirmDialog.ask({
			title: __("This site is now linked to another account"),
			message: __(
				"Nothing was deleted. The previous account's devices are switched off; its messages, queue and numbers are still here. Delete them, or keep them for reference. Download a backup first if you want its setup (Settings ▸ Backup) — messages are not in a backup."
			),
			impact: ROWS.map(([doctype, label]) => ({ label, value: counts[doctype] || 0 })),
			ack_checkbox: __("I understand the previous account's data will be deleted for good."),
			danger: true,
			confirm_label: __("Delete the previous account's data"),
			cancel_label: __("Keep them"),
			on_confirm: () => sanad.ui.call("onboarding.resolve_account_switch", { action: "delete" }),
			on_cancel: ({ dismissed } = {}) => {
				if (dismissed) return; // closed: decide later
				sanad.ui
					.call("onboarding.resolve_account_switch", { action: "keep" })
					.then(() => sanad.ui.Toast.success(__("The previous account's data is kept.")))
					.catch((err) => sanad.ui.Toast.error(err));
			},
		})
			.then(() => sanad.ui.Toast.success(__("Deleting the previous account's data. It runs in the background.")))
			.catch(() => null);
	}

	Object.assign(whatsapp_next.account_switch, { check });
})();

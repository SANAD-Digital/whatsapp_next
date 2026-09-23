// WhatsApp Log (Outbound) form — phase 5 live kit use: Resend / Cancel / Quick send /
// Open conversation buttons calling `messages.*` and `quick_send.*` (the form itself is read-only
// for users; every state change goes through the dispatcher). The shared helpers live in the
// Outbound list script and are loaded on demand with `frappe.require`.

frappe.ui.form.on("WhatsApp Log", {
	refresh(frm) {
		if (frm.is_new()) return;
		const ui = sanad.ui;
		const doc = frm.doc;
		const TERMINAL = ["Sent", "Delivered", "Read", "Failed", "Cancelled"];
		const is_agent = frappe.user.has_role(["WhatsApp Agent", "WhatsApp Manager", "System Manager"]);
		const is_manager = frappe.user.has_role(["WhatsApp Manager", "System Manager"]);
		const key = doc.phone_e164 || doc.jid;
		const with_helpers = () =>
			whatsapp_next.messages && whatsapp_next.messages.cancel
				? Promise.resolve()
				: frappe.require("/assets/whatsapp_next/js/listview/whatsapp_log_list.js");

		if (is_agent && TERMINAL.includes(doc.status)) {
			frm.add_custom_button(__("Resend"), () => {
				ui.call("messages.resend", { name: doc.name })
					.then((r) => {
						ui.Toast.success(__("Message re-queued"));
						if (r && r.outbound) frappe.set_route("Form", "WhatsApp Log", r.outbound);
					})
					.catch((err) => ui.Toast.error(err));
			});
		}

		if (is_manager && doc.status === "Queued") {
			frm.add_custom_button(__("Cancel"), () => {
				with_helpers().then(() => whatsapp_next.messages.cancel(doc, () => frm.reload_doc()));
			});
		}

		if (is_agent && key) {
			frm.add_custom_button(__("Quick send"), () => {
				const opts = { device: doc.device, contact: doc.contact || undefined };
				if (doc.jid && doc.recipient_type === "Group") opts.jid = doc.jid;
				else opts.phone = key;
				new ui.QuickSend(opts);
			});
		}

		if (key) {
			frm.add_custom_button(__("Open conversation"), () => {
				// The conversation variant is built separately; resolve it at click time.
				if (typeof ui.ConversationDrawer !== "function") {
					ui.Toast.info(__("The conversation view is not available yet."));
					return;
				}
				new ui.ConversationDrawer({ key, device: doc.device });
			});
		}
	},
});

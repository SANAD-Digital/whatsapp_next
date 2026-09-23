// WhatsApp Number form (09 row 13): a materialised, read-mostly record. Adds the conversation
// drawer ("Messages") and Quick send; everything else is the native form.

frappe.ui.form.on("WhatsApp Number", {
	refresh(frm) {
		if (frm.is_new()) return;
		const key = frm.doc.phone_e164 || frm.doc.jid || frm.doc.name;

		frm.add_custom_button(__("Open conversation"), () => {
			sanad.ui.ConversationDrawer.open({
				key,
				device: frm.doc.last_device || undefined,
				on_close: () => frm.reload_doc(),
			});
		});

		const can_send = frappe.user.has_role(["WhatsApp Agent", "WhatsApp Manager"]);
		if (typeof sanad.ui.QuickSend === "function" && can_send && frm.doc.number_type !== "LID") {
			frm.add_custom_button(__("Quick send"), () => {
				const args = { device: frm.doc.last_device || undefined };
				if (frm.doc.phone_e164) args.phone = frm.doc.phone_e164;
				else if (frm.doc.jid) args.jid = frm.doc.jid;
				new sanad.ui.QuickSend(args);
			});
		}
	},
});

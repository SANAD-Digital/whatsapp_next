// WhatsApp Number form (09 row 13): a materialised, read-mostly record. The actions are the
// Numbers list's, from `screens/numbers.js`: open the conversation, quick send, add as contact
// (link or create), confirm the conversation, and unlink (Manager).

frappe.ui.form.on("WhatsApp Number", {
	refresh(frm) {
		if (frm.is_new()) return;
		const N = whatsapp_next.numbers;
		const doc = frm.doc;
		const reload = { refresh: () => frm.reload_doc() };
		const individual = !doc.number_type || doc.number_type === "Individual";

		frm.add_custom_button(__("Open conversation"), () => N.open_conversation(doc, reload));

		const can_send = frappe.user.has_role(["WhatsApp Agent", "WhatsApp Manager", "System Manager"]);
		if (typeof sanad.ui.QuickSend === "function" && can_send && doc.number_type !== "LID") {
			frm.add_custom_button(__("Quick send"), () => N.quick_send(doc));
		}

		if (doc.contact) {
			frm.add_custom_button(__("Open contact"), () => frappe.set_route("Form", "Contact", doc.contact));
			if (frappe.user.has_role(["WhatsApp Manager", "System Manager"])) {
				frm.add_custom_button(__("Unlink"), () => N.unlink_number(doc, reload));
			}
		} else if (individual && frappe.user.has_role(["WhatsApp Contact User", "WhatsApp Manager", "WhatsApp Agent", "System Manager"])) {
			frm.add_custom_button(__("Add as contact"), () => N.link_convert_dialog(doc, () => frm.reload_doc()));
		}

		if (individual && can_send) {
			frm.add_custom_button(doc.conversation_confirmed ? __("Remove confirmation") : __("Confirm conversation"), () => N.confirm_conversation(doc, reload));
		}
	},
});

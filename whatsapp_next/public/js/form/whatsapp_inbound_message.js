// WhatsApp Inbound Message form (09 row 5): read-only by permission; the drawer's verbs as form
// buttons, from `screens/messages.js` — Reply (QuickSend), Open command (the CommandModal, read),
// Add as synonym (Manager, no command matched) and Contact (open it, or link / create one).

frappe.ui.form.on("WhatsApp Inbound Message", {
	refresh(frm) {
		if (frm.is_new()) return;
		const message_helpers = whatsapp_next.messages;
		const doc = frm.doc;
		const reload = () => frm.reload_doc();
		if (message_helpers.is_agent()) frm.add_custom_button(__("Reply"), () => message_helpers.quick_send(doc, reload));
		if (doc.command) frm.add_custom_button(__("Open command"), () => message_helpers.open_command(doc.command));
		else if (message_helpers.is_manager() && doc.body) frm.add_custom_button(__("Add as synonym"), () => message_helpers.add_synonym(doc, reload));
		frm.add_custom_button(doc.contact ? __("Open contact") : __("Add as contact"), () => message_helpers.open_contact(doc, reload));
	},
});

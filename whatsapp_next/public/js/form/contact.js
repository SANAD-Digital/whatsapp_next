// Contact form (Desk): create a WhatsApp group from the contact — its numbers to start with, and
// the new group saved among its numbers. Offered to Managers when the plan includes groups.

frappe.ui.form.on("Contact", {
	refresh(frm) {
		if (frm.is_new() || !(whatsapp_next.wa_groups && whatsapp_next.wa_groups.can_create())) return;
		frm.add_custom_button(__("Create WhatsApp group"), () =>
			whatsapp_next.wa_groups.open({
				source: { doctype: "Contact", names: [frm.doc.name] },
				contact: frm.doc.name,
				name: frm.doc.full_name || frm.doc.name,
				on_created: () => frm.reload_doc(),
			}),
		__("WhatsApp"));
	},
});

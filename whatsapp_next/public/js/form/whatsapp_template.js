// WhatsApp Template form (09 row 10a): tabs Template · Attachment · Preview. The TemplateEditor
// (variables sidebar, sample record picker, live preview) lives in the Preview tab next to what
// drives it (reference DocType, sample context); a variable clicked there is inserted into the
// body on the Template tab. Adds "Open in the editor" (the TemplateWindow) and "Use in a message"
// → QuickSend.

frappe.ui.form.on("WhatsApp Template", {
	refresh(frm) {
		sanad.ui.TemplateEditor.mount({
			frm,
			body_field: "body",
			reference_doctype_field: "reference_doctype",
			sample_field: "sample_context",
			preview_field: "preview_html",
		});

		if (!frm.is_new() && window.whatsapp_next && whatsapp_next.templates) {
			frm.add_custom_button(__("Open in the editor"), () => {
				whatsapp_next.templates.open(frm.doc.name, {
					// a rename or a delete leaves this form behind; anything else just reloads it
					on_saved: (r) => {
						if (r && r.deleted) frappe.set_route("List", frm.doctype);
						else if (r && r.name && r.name !== frm.doc.name) frappe.set_route("Form", frm.doctype, r.name);
						else frm.reload_doc();
					},
				});
			});
		}

		if (!frm.is_new() && !frm.doc.disabled && typeof sanad.ui.QuickSend === "function") {
			frm.add_custom_button(__("Use in a message"), () => {
				new sanad.ui.QuickSend({ template: frm.doc.name });
			});
		}
	},
});

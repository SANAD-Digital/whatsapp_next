// WhatsApp Template form (09 row 10a): mounts the TemplateEditor (variables sidebar, sample
// record picker, live preview) under the Jinja body and adds "Use in a message" → QuickSend.

frappe.ui.form.on("WhatsApp Template", {
	refresh(frm) {
		sanad.ui.TemplateEditor.mount({
			frm,
			body_field: "body",
			reference_doctype_field: "reference_doctype",
			sample_field: "sample_context",
		});

		if (!frm.is_new() && !frm.doc.disabled && typeof sanad.ui.QuickSend === "function") {
			frm.add_custom_button(__("Use in a message"), () => {
				new sanad.ui.QuickSend({ template: frm.doc.name });
			});
		}
	},
});

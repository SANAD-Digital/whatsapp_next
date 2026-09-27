// WhatsApp Template form (09 row 10a): tabs Template · Attachment · Preview. The TemplateEditor
// (variables sidebar, sample record picker, live preview) lives in the Preview tab next to what
// drives it (reference DocType, sample context); a variable clicked there is inserted into the
// body on the Template tab. Adds "Use in a message" → QuickSend.

frappe.ui.form.on("WhatsApp Template", {
	refresh(frm) {
		sanad.ui.TemplateEditor.mount({
			frm,
			body_field: "body",
			reference_doctype_field: "reference_doctype",
			sample_field: "sample_context",
			preview_field: "preview_html",
		});

		if (!frm.is_new() && !frm.doc.disabled && typeof sanad.ui.QuickSend === "function") {
			frm.add_custom_button(__("Use in a message"), () => {
				new sanad.ui.QuickSend({ template: frm.doc.name });
			});
		}
	},
});

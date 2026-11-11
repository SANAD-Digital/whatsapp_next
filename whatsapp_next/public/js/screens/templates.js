// Message templates — the editor window. `whatsapp_next.templates.open(name)` opens
// `whatsapp.ui.TemplateWindow` on a saved template, or on a new one without a name, wired to
// `api/v1/templates.py`. The templates list opens it for "New template", a row and "View"; the
// template form offers it too, and the notification editor opens it to create or edit the
// template a notification uses — a new one pre-filled through `defaults` (its document type, or
// the text written in the notification).

frappe.provide("whatsapp_next.templates");

whatsapp_next.templates.open = function (name, { on_saved, defaults } = {}) {
	// silent: the window says what went wrong itself, so Frappe must not pop the same message up too
	const call = (method, args) => whatsapp.ui.call(`templates.${method}`, args || {}, { silent: true });
	const filled = (r) => {
		Object.entries(defaults || {}).forEach(([k, v]) => {
			if (v != null && v !== "") r.template[k] = v;
		});
		return r;
	};
	return new whatsapp.ui.TemplateWindow({
		name: name || null,
		form_doctype: "WhatsApp Template",
		load: (n) => (n ? call("get_editor", { name: n }) : call("get_editor").then(filled)),
		save: (payload) => call("save_editor", { payload }),
		remove: (n) => call("delete_template", { name: n }),
		preview: (args) => call("preview", args),
		variables: (doctype) => call("list_variables", doctype ? { reference_doctype: doctype } : {}),
		pick_sample: (doctype) => call("pick_sample", { reference_doctype: doctype }),
		use_in_message: typeof whatsapp.ui.QuickSend === "function" ? (n) => new whatsapp.ui.QuickSend({ template: n }) : null,
		on_saved: (r) => {
			if (typeof on_saved === "function") on_saved(r);
			const list = typeof cur_list !== "undefined" && cur_list && cur_list.doctype === "WhatsApp Template" ? cur_list : null;
			if (list) {
				list.refresh();
				list._whatsapp_header && list._whatsapp_header.refresh();
			}
		},
	});
};

// Notification alerts — the editor window (D-139). `whatsapp_next.alerts.open(name)` opens
// `whatsapp.ui.AlertEditor` on a saved alert, or on a new one without a name, wired to
// `api/v1/alerts.py`. The alerts list opens it for "New alert", a row and "View"; the alert form
// offers it too.

frappe.provide("whatsapp_next.alerts");

whatsapp_next.alerts.open = function (name, { on_saved } = {}) {
	// silent: the editor says what went wrong itself, so Frappe must not pop the same message up too
	const call_alerts_api = (method, args) => whatsapp.ui.call(`alerts.${method}`, args || {}, { silent: true });
	return new whatsapp.ui.AlertEditor({
		name: name || null,
		form_doctype: "WhatsApp Notification Alert",
		load: (n) => call_alerts_api("get_editor", n ? { name: n } : {}),
		preview: (payload) => call_alerts_api("preview_draft", { payload }),
		save: (payload) => call_alerts_api("save_editor", { payload }),
		remove: (n) => call_alerts_api("delete_alert", { name: n }),
		send_test: (payload, phone) => call_alerts_api("send_test", { payload, phone }),
		make_file: (payload) => call_alerts_api("make_file", { payload }),
		run_now: (n) => call_alerts_api("run_now", { name: n }),
		search: (kind, txt) => call_alerts_api("search", { kind, txt: txt || "" }),
		report_columns: (report, filters) => call_alerts_api("get_report_columns", { report, filters: filters || {} }),
		report_info: (report) => call_alerts_api("get_report_info", { report }),
		// only a connected device can send
		device_link: { doctype: "WhatsApp Device", filters: { status: "Connected", disabled: 0 } },
		// the template window, over this one: "New template", "Edit this template", a double click
		open_template: whatsapp_next.templates && whatsapp_next.templates.open ? (n, opts) => whatsapp_next.templates.open(n, opts) : null,
		// the product's contact picker, in its local mode: the picks come back, nothing is written
		pick_recipients: ({ existing }) =>
			new Promise((resolve) => {
				let done = false;
				new whatsapp.ui.ContactPicker({
					title: __("Choose who gets the alert"),
					existing,
					on_pick: (rows) => {
						done = true;
						resolve(rows);
					},
					on_close: () => !done && resolve([]),
				});
			}),
		on_saved: (r) => {
			if (typeof on_saved === "function") on_saved(r);
			// `cur_list` is only declared once a list has been opened: the editor also opens from the form
			const list = typeof cur_list !== "undefined" && cur_list && cur_list.doctype === "WhatsApp Notification Alert" ? cur_list : null;
			if (list) {
				list.refresh();
				list._whatsapp_header && list._whatsapp_header.refresh();
			}
		},
	});
};

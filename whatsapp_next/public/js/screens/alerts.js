// Notification alerts — the editor window (D-139). `whatsapp_next.alerts.open(name)` opens
// `sanad.ui.AlertEditor` on a saved alert, or on a new one without a name, wired to
// `api/v1/alerts.py`. The alerts list opens it for "New alert", a row and "View"; the alert form
// offers it too.

frappe.provide("whatsapp_next.alerts");

whatsapp_next.alerts.open = function (name, { on_saved } = {}) {
	// silent: the editor says what went wrong itself, so Frappe must not pop the same message up too
	const call = (method, args) => sanad.ui.call(`alerts.${method}`, args || {}, { silent: true });
	return new sanad.ui.AlertEditor({
		name: name || null,
		load: (n) => call("get_editor", n ? { name: n } : {}),
		preview: (payload) => call("preview_draft", { payload }),
		save: (payload) => call("save_editor", { payload }),
		remove: (n) => call("delete_alert", { name: n }),
		send_test: (payload, phone) => call("send_test", { payload, phone }),
		run_now: (n) => call("run_now", { name: n }),
		search: (kind, txt) => call("search", { kind, txt: txt || "" }),
		report_columns: (report, filters) => call("get_report_columns", { report, filters: filters || {} }),
		report_info: (report) => call("get_report_info", { report }),
		// only a connected device can send
		device_link: { doctype: "WhatsApp Device", filters: { status: "Connected", disabled: 0 } },
		// the product's contact picker, in its local mode: the picks come back, nothing is written
		pick_recipients: ({ existing }) =>
			new Promise((resolve) => {
				let done = false;
				new sanad.ui.ContactPicker({
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
			const list = cur_list && cur_list.doctype === "WhatsApp Notification Alert" ? cur_list : null;
			if (list) {
				list.refresh();
				list._sanad_header && list._sanad_header.refresh();
			}
		},
	});
};

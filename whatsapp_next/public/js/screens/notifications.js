// Notifications — the editor window. `whatsapp_next.notifications.open(name)` opens
// `sanad.ui.NotificationEditor` on a saved notification, or on a new one without a name, wired to
// `api/v1/notifications.py`. The template it uses is created and edited in the templates window
// (`whatsapp_next.templates.open`), recipients come from the product's contact picker. The
// notifications list opens it for "New notification", a row and "View"; the form offers it too.

frappe.provide("whatsapp_next.notifications");

whatsapp_next.notifications.open = function (name, { on_saved } = {}) {
	// silent: the editor says what went wrong itself, so Frappe must not pop the same message up too
	const call = (method, args) => sanad.ui.call(`notifications.${method}`, args || {}, { silent: true });
	return new sanad.ui.NotificationEditor({
		name: name || null,
		load: (n) => call("get_editor", n ? { name: n } : {}),
		setup: (document_type) => call("get_document_setup", { document_type }),
		preview: (payload, reference_name) => call("preview_draft", { payload, reference_name: reference_name || null }),
		save: (payload) => call("save_editor", { payload }),
		remove: (n) => call("delete_notification", { name: n }),
		send_test: (payload, phone, reference_name) => call("send_test", { payload, phone, reference_name: reference_name || null }),
		search: (kind, txt, document_type) => call("search", { kind, txt: txt || "", document_type: document_type || null }),
		// only a connected device can send
		device_link: { doctype: "WhatsApp Device", filters: { status: "Connected", disabled: 0 } },
		open_template: whatsapp_next.templates && whatsapp_next.templates.open ? (n, opts) => whatsapp_next.templates.open(n, opts) : null,
		// the product's contact picker, in its local mode: the picks come back, nothing is written
		pick_recipients: ({ existing }) =>
			new Promise((resolve) => {
				let done = false;
				new sanad.ui.ContactPicker({
					title: __("Choose who gets the notification"),
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
			const list = typeof cur_list !== "undefined" && cur_list && cur_list.doctype === "WhatsApp Notification" ? cur_list : null;
			if (list) {
				list.refresh();
				list._sanad_header && list._sanad_header.refresh();
			}
		},
	});
};

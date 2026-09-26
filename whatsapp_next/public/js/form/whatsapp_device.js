// WhatsApp Device form — native read fallback of screen 3 (09 §1B row 3). Every lifecycle change
// goes through `devices.*` (the provider first, then the local row), never through Save: Pair opens
// the Devices page's pairing dialog for this device, Disconnect and Delete confirm and call the API.

frappe.ui.form.on("WhatsApp Device", {
	refresh(frm) {
		if (frm.is_new()) {
			// Only the device service may create a device (the controller refuses the insert anyway).
			frappe.set_route("wa-devices");
			return;
		}
		const ui = sanad.ui;
		const doc = frm.doc;
		const label = doc.device_name || doc.name;
		frm.add_custom_button(__("Open Devices page"), () => frappe.set_route("wa-devices"));
		if (!frappe.user.has_role(["WhatsApp Manager", "System Manager"])) return;

		frm.add_custom_button(doc.status === "Connected" ? __("Pair again") : __("Pair"), () => {
			frappe.route_options = { pair: doc.name };
			frappe.set_route("wa-devices");
		});

		if (doc.status === "Connected" || doc.status === "Pending QR") {
			frm.add_custom_button(__("Disconnect"), () =>
				ui.ConfirmDialog.ask({
					title: __("Disconnect {0}?", [label]),
					message: __("Messages waiting for this device stop until it is paired again."),
					impact: [{ label: __("Device"), value: label }],
					confirm_label: __("Disconnect"),
					danger: true,
					on_confirm: () => ui.call("devices.disconnect_device", { device: doc.name }),
				})
					.then(() => {
						ui.Toast.success(__("{0} disconnected", [label]));
						frm.reload_doc();
					})
					.catch(() => {})
			);
		}

		frm.add_custom_button(__("Delete device"), () =>
			ui.ConfirmDialog.ask({
				title: __("Delete {0}?", [label]),
				message: __("The device is removed from the platform. Its message history stays in the log."),
				impact: [{ label: __("Device"), value: label }],
				ack_checkbox: __("I understand the device must be paired again to be used."),
				confirm_label: __("Delete"),
				danger: true,
				on_confirm: () => ui.call("devices.delete_device", { device: doc.name }),
			})
				.then(() => {
					ui.Toast.success(__("{0} deleted", [label]));
					frappe.set_route("wa-devices");
				})
				.catch(() => {})
		);
	},
});

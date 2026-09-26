// WhatsApp Queue Item form (09 row 9): entirely read-only; the queue's verbs on this row go
// through `queue.*` — Pause / Resume, Retry (dead letter), Cancel with a reason — plus the message
// it carries.

frappe.ui.form.on("WhatsApp Queue Item", {
	refresh(frm) {
		if (frm.is_new()) return;
		const ui = sanad.ui;
		const doc = frm.doc;
		const reload = () => frm.reload_doc();
		const run = (method, message) =>
			ui
				.call(method, { names: [doc.name] })
				.then(() => {
					ui.Toast.success(message);
					reload();
				})
				.catch((err) => ui.Toast.error(err));

		if (doc.outbound_message) {
			frm.add_custom_button(__("Open message"), () => whatsapp_next.messages.open_outbound_drawer(doc.outbound_message, { after_change: reload }));
		}
		if (!frappe.user.has_role(["WhatsApp Manager", "System Manager"])) return;
		if (doc.status === "Queued") frm.add_custom_button(__("Pause"), () => run("queue.pause_items", __("Message paused")));
		if (doc.status === "Paused") frm.add_custom_button(__("Resume"), () => run("queue.resume_items", __("Message resumed")));
		if (doc.status === "Dead Letter") frm.add_custom_button(__("Retry"), () => run("queue.retry_dead_letter", __("Message re-queued")));
		if (["Queued", "Paused", "Dead Letter"].includes(doc.status)) {
			frm.add_custom_button(__("Cancel this message"), () => whatsapp_next.queue.cancel_item(doc, reload));
		}
	},
});

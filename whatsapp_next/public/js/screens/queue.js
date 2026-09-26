// Queue item verbs shared by the Queue list's drawer and the Queue Item form (09 row 9): cancel
// ("deleted is a state" — the row stays, marked Deleted, and its message Cancelled) with a reason
// that lands in the audit log.

frappe.provide("whatsapp_next.queue");

(function () {
	const ui = sanad.ui;

	whatsapp_next.queue.cancel_item = function (doc, after) {
		return ui.ConfirmDialog.ask({
			title: __("Cancel this message?"),
			message: __("It will not be sent. The row stays in the queue as Deleted and the message is marked Cancelled."),
			impact: [
				{ label: __("Recipient"), value: doc.display_name || doc.phone_e164 || doc.name },
				{ label: __("Status"), value: __(doc.status) },
			],
			reason_field: { label: __("Reason"), required: true },
			confirm_label: __("Cancel message"),
			cancel_label: __("Keep it"),
			danger: true,
			on_confirm: ({ reason }) => ui.call("queue.delete_items", { names: [doc.name], reason }),
		})
			.then(() => {
				ui.Toast.success(__("Message cancelled"));
				after && after();
			})
			.catch(() => {});
	};
})();

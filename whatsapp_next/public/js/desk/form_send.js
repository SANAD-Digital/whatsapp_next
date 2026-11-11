// "New WhatsApp message" beside the form's "New Email" (owner, 2026-11-05): opens QuickSend with the
// document as the message's reference, so templates render over it and the document's timeline
// records the message once it is sent (or could not be). The recipient is pre-filled from the
// document's own contact number when it has one; otherwise the user types it.
// Offered where "New Email" is — to whoever may email this document (`frappe.model.can_email`) —
// and only to the roles the send API accepts. Not on this app's own DocTypes (they have their own
// actions), single or child DocTypes, or an unsaved document.

(function () {
	const AGENT_ROLES = ["WhatsApp Agent", "WhatsApp Manager", "System Manager"];
	// the fields ERPNext and Frappe keep a document's contact number in, most specific first
	const PHONE_FIELDS = ["contact_mobile", "mobile_no", "contact_phone", "phone", "phone_no", "mobile"];

	function offered(frm) {
		const meta = frm.meta || {};
		if (frm.is_new() || meta.issingle || meta.istable) return false;
		if (meta.module === "WhatsApp Next") return false;
		if (typeof whatsapp === "undefined" || !whatsapp.ui || typeof whatsapp.ui.QuickSend !== "function") return false;
		return frappe.user.has_role(AGENT_ROLES) && frappe.model.can_email(null, frm);
	}

	function recipient_of(doc) {
		const phone = PHONE_FIELDS.map((f) => doc[f]).find((v) => typeof v === "string" && v.trim());
		if (!phone) return {};
		// a contact only travels with its number: a contact alone with no WhatsApp number would
		// leave the composer without a field to type one in
		return doc.contact_person ? { phone: phone.trim(), contact: doc.contact_person } : { phone: phone.trim() };
	}

	$(document).on("form-refresh", (_e, frm) => {
		const timeline = frm && frm.timeline;
		if (!timeline || typeof timeline.add_action_button !== "function") return;
		// the timeline is drawn once per form and kept across documents: the button is too
		if (!timeline.wa_send_button) {
			timeline.wa_send_button = timeline.add_action_button(
				__("New WhatsApp message"),
				() =>
					new whatsapp.ui.QuickSend(
						Object.assign(recipient_of(timeline.frm.doc), {
							reference_doctype: timeline.frm.doctype,
							reference_name: timeline.frm.docname,
							on_sent: () => timeline.frm.timeline && timeline.frm.timeline.refresh && timeline.frm.timeline.refresh(),
						})
					),
				"plus",
				"btn-secondary"
			);
		}
		// shown per document: a new one, or one this user may not email, has none
		timeline.wa_send_button.toggle(offered(frm));
		// adding a button shows Frappe's row of them; alone and hidden, the row goes again
		const $row = timeline.timeline_actions_wrapper;
		if ($row) $row.toggle($row.find(".action-btn").filter((_, el) => el.style.display !== "none").length > 0);
	});
})();

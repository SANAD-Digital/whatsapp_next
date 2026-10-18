// "Send message" on the form of any business document (Sales Invoice, Sales Order, Customer …):
// opens QuickSend with the document as the message's reference, so templates render over it and
// the document's timeline records the message once it is sent (or could not be). The recipient is
// pre-filled from the document's own contact number when it has one; otherwise the user types it.
// Not on this app's own DocTypes (they have their own actions), single or child DocTypes, or an
// unsaved document. Offered to the roles the send API accepts.

(function () {
	const AGENT_ROLES = ["WhatsApp Agent", "WhatsApp Manager", "System Manager"];
	// the fields ERPNext and Frappe keep a document's contact number in, most specific first
	const PHONE_FIELDS = ["contact_mobile", "mobile_no", "contact_phone", "phone", "phone_no", "mobile"];

	function offered(frm) {
		const meta = frm.meta || {};
		if (frm.is_new() || meta.issingle || meta.istable) return false;
		if (meta.module === "WhatsApp Next") return false;
		if (typeof sanad === "undefined" || !sanad.ui || typeof sanad.ui.QuickSend !== "function") return false;
		return frappe.user.has_role(AGENT_ROLES);
	}

	function recipient_of(doc) {
		const phone = PHONE_FIELDS.map((f) => doc[f]).find((v) => typeof v === "string" && v.trim());
		if (!phone) return {};
		// a contact only travels with its number: a contact alone with no WhatsApp number would
		// leave the composer without a field to type one in
		return doc.contact_person ? { phone: phone.trim(), contact: doc.contact_person } : { phone: phone.trim() };
	}

	$(document).on("form-refresh", (_e, frm) => {
		if (!frm || !offered(frm)) return;
		frm.add_custom_button(
			__("Send message"),
			() =>
				new sanad.ui.QuickSend(
					Object.assign(recipient_of(frm.doc), {
						reference_doctype: frm.doctype,
						reference_name: frm.docname,
						on_sent: () => frm.timeline && frm.timeline.refresh && frm.timeline.refresh(),
					})
				),
			__("WhatsApp")
		);
	});
})();

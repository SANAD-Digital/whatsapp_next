// Desk-wide display of this app's phone fields without a "+" (owner: no "+" is shown or typed
// anywhere; storage stays E.164). Frappe draws read-only fields, list cells and report cells
// through `frappe.form.formatters.<fieldtype>`; the phone fields here are `Data`, so the Data
// formatter is wrapped — only for the phone fields of this app's DocTypes, never ERPNext's own.

const PHONE_FIELDS = new Set(["phone", "phone_e164", "wa_phone_e164", "sender_phone", "recipient_phone"]);
const E164 = /^\+\d{7,15}$/;

function is_ours(df) {
	const parent = (df && (df.parent || df.doctype)) || "";
	return df && PHONE_FIELDS.has(df.fieldname) && (parent.startsWith("WhatsApp ") || df.fieldname === "wa_phone_e164");
}

frappe.provide("frappe.form.formatters");
const base_data = frappe.form.formatters.Data;
frappe.form.formatters.Data = function (value, df, options, doc) {
	if (value && is_ours(df) && E164.test(String(value).trim())) {
		value = sanad.ui.phone(value);
	}
	return base_data ? base_data(value, df, options, doc) : value;
};

// One number per row in every list: `phone_e164` is the stored, normalised copy of the number that
// matching and de-duplication run on, not something a person needs to read twice. Where a list
// also shows `phone`, the E.164 column goes; where it is the only number, it is simply "Phone".
$(document).on("app_ready", () => {
	if (!window.sanad || !sanad.ui || !sanad.ui.DataList) return;
	const previous = sanad.ui.DataList.adjust_columns;
	sanad.ui.DataList.adjust_columns = (columns, doctype) => {
		let cols = typeof previous === "function" ? previous(columns, doctype) || columns : columns;
		if (!String(doctype || "").startsWith("WhatsApp ")) return cols;
		const has_phone = cols.some((c) => c.fieldname === "phone");
		cols = cols.filter((c) => !(has_phone && c.fieldname === "phone_e164"));
		return cols.map((c) => (c.fieldname === "phone_e164" && c.df && /E\.164/.test(c.df.label || "") && c.label === __(c.df.label) ? Object.assign({}, c, { label: __("Phone") }) : c));
	};
});

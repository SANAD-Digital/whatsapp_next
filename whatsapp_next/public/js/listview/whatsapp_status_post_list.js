// WhatsApp Status Post list: the state as a coloured indicator.
frappe.listview_settings["WhatsApp Status Post"] = {
	add_fields: ["state", "view_count"],
	get_indicator(doc) {
		const colour = { Draft: "gray", Scheduled: "blue", Posting: "orange", Posted: "green", Failed: "red", Deleted: "gray" }[doc.state] || "gray";
		return [__(doc.state), colour, `state,=,${doc.state}`];
	},
};

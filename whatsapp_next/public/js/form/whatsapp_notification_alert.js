// WhatsApp Notification Alert form (09 row 10c, D-016): the report's columns are offered to the
// recipient rows that read a phone from a column (`alerts.get_report_columns`), the dynamic-filter
// tokens are listed under their field with today's value (`alerts.get_dynamic_filter_reference`),
// and Preview / Run now act on the saved alert.

frappe.ui.form.on("WhatsApp Notification Alert", {
	refresh(frm) {
		load_report_columns(frm);
		load_token_reference(frm);
		if (frm.is_new() || !frappe.user.has_role(["WhatsApp Manager", "System Manager"])) return;
		frm.add_custom_button(__("Preview"), () => preview(frm));
		frm.add_custom_button(__("Run now"), () => run_now(frm));
	},
	report(frm) {
		load_report_columns(frm);
	},
	filters_json(frm) {
		load_report_columns(frm);
	},
});

function parse_json(text) {
	try {
		return text ? JSON.parse(text) : {};
	} catch (e) {
		return null;
	}
}

/** Shows the report's columns on the recipient rows' "Report Column" field. */
function load_report_columns(frm) {
	const grid = frm.fields_dict.recipients && frm.fields_dict.recipients.grid;
	if (!grid) return;
	const set_help = (text) => {
		grid.update_docfield_property("report_column", "description", text);
		grid.refresh();
	};
	if (frm.doc.content_type !== "Report" || !frm.doc.report) return set_help(__("Choose a report first; its columns are listed here."));
	const filters = parse_json(frm.doc.filters_json);
	sanad.ui
		.call("alerts.get_report_columns", { report: frm.doc.report, filters: filters || {} })
		.then((cols) => {
			if (!cols || !cols.length) return set_help(__("The report returned no columns with these filters."));
			set_help(__("Columns: {0}", [cols.map((c) => `${c.fieldname} (${__(c.label || c.fieldname)})`).join(", ")]));
		})
		.catch(() => set_help(__("The report could not be run to read its columns.")));
}

/** Lists the dynamic-filter tokens with today's value under `dynamic_filters_json`. */
function load_token_reference(frm) {
	const field = frm.get_field("dynamic_filters_json");
	if (!field || frm._wa_tokens_rendered) return;
	sanad.ui
		.call("alerts.get_dynamic_filter_reference")
		.then((tokens) => {
			frm._wa_tokens_rendered = true;
			const esc = sanad.ui.escape;
			const rows = (tokens || []).map((t) => `<tr><td><code>${esc(t.name)}</code></td><td dir="ltr">${esc(t.example == null ? "" : String(t.example))}</td></tr>`).join("");
			const $help = $(`
				<details class="wa-token-reference mt-2">
					<summary class="text-muted small">${esc(__("Dynamic date tokens"))}</summary>
					<p class="small text-muted mb-1">${esc(__('Use a token as a filter value, e.g. {"posting_date": "today"}. N tokens take a number: "last_days:7".'))}</p>
					<table class="table table-sm small mb-0"><thead><tr><th>${esc(__("Token"))}</th><th>${esc(__("Today"))}</th></tr></thead><tbody>${rows}</tbody></table>
				</details>`);
			field.$wrapper.find(".wa-token-reference").remove();
			field.$wrapper.append($help);
		})
		.catch(() => {});
}

function preview(frm) {
	sanad.ui
		.call("alerts.preview", { name: frm.doc.name }, { freeze: true, freeze_message: __("Running the report…") })
		.then((r) => {
			const esc = sanad.ui.escape;
			const facts = [
				[__("Rows"), sanad.ui.format_int(r.row_count || 0)],
				[__("Recipients"), sanad.ui.format_int(r.recipients_count || 0)],
				[__("Attachment"), r.attachment_name || "—"],
			]
				.map(([k, v]) => `<tr><th class="text-muted" style="width: 30%">${esc(k)}</th><td><bdi dir="auto">${esc(v)}</bdi></td></tr>`)
				.join("");
			const d = new frappe.ui.Dialog({
				title: __("Preview: {0}", [frm.doc.alert_name || frm.doc.name]),
				size: "large",
				fields: [
					{
						fieldtype: "HTML",
						fieldname: "body",
						options: `
							${r.error ? `<p class="text-danger">${esc(r.error)}</p>` : ""}
							<table class="table table-sm">${facts}</table>
							<h6>${esc(__("Message"))}</h6>
							<div dir="auto" style="white-space: pre-wrap">${esc(r.message || "")}</div>`,
					},
				],
			});
			d.$wrapper.addClass("sanad-kit");
			d.show();
		})
		.catch((err) => sanad.ui.Toast.error(err));
}

function run_now(frm) {
	sanad.ui.ConfirmDialog.ask({
		title: __("Run {0} now?", [frm.doc.alert_name || frm.doc.name]),
		message: __("The report runs in the background and the messages are queued; the schedule is not changed."),
		confirm_label: __("Run now"),
		on_confirm: () => sanad.ui.call("alerts.run_now", { name: frm.doc.name }),
	})
		.then(() => sanad.ui.Toast.success(__("The alert is running in the background")))
		.catch(() => {});
}

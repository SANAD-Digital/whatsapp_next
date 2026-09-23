// WhatsApp Campaign list (09 row 6): status indicator (the one colour source, read elsewhere
// through `sanad.ui.indicator_for`), the "Sending now" ListStatsCard with its modal (pause / sent
// messages per row, refreshed on `wa:campaign:status`), and bulk pause / resume / cancel of the
// selected campaigns through `sanad.ui.BulkActions` → `campaigns.*_many`.

const INDICATOR = {
	Draft: "gray",
	Scheduled: "blue",
	Queued: "blue",
	Running: "green",
	Paused: "orange",
	Completed: "green",
	"Partially Failed": "orange",
	Cancelled: "red",
};

const fmt_int = (v) => sanad.ui.format_int(v);
const TERMINAL = ["Completed", "Partially Failed", "Cancelled"];

frappe.listview_settings["WhatsApp Campaign"] = {
	add_fields: ["status", "total_recipients", "sent_count", "scheduled_at"],
	hide_name_column: true,

	get_indicator(doc) {
		return [__(doc.status), INDICATOR[doc.status] || "gray", `status,=,${doc.status}`];
	},

	formatters: {
		sent_count(value, df, doc) {
			const total = cint(doc.total_recipients);
			return total ? `<span class="sanad-tabular">${fmt_int(value)} / ${fmt_int(total)}</span>` : fmt_int(value);
		},
	},

	onload(listview) {
		listview.sanad_stats = new sanad.ui.ListStatsCard({
			listview,
			refresh_seconds: 60,
			events: {
				"wa:campaign:status": function () {
					this.refresh();
				},
			},
			cards: [
				{
					key: "sending",
					label: __("Sending now"),
					icon: "es-line-email",
					method: "campaigns.get_sending_now",
					tone: "green",
					modal: {
						title: __("Sending now"),
						method: "campaigns.get_sending_now",
						columns: [
							{ fieldname: "campaign_name", label: __("Campaign") },
							{ fieldname: "status", label: __("Status"), format: (v, row) => sanad.ui.StatusBadge.html({ label: __(v), colour: sanad.ui.indicator_for("WhatsApp Campaign", Object.assign({ doctype: "WhatsApp Campaign" }, row)).colour }) },
							{ fieldname: "sent_count", label: __("Sent / total"), format: (v, row) => `${fmt_int(v)} / ${fmt_int(row.total_recipients)}` },
							{ fieldname: "started_at", label: __("Started"), format: (v) => (v ? frappe.datetime.prettyDate(v) : "") },
						],
						row_actions: [
							{
								label: __("Pause"),
								method: "campaigns.pause",
								condition: (row) => ["Running", "Queued"].includes(row.status),
								args: (row, { reason }) => ({ name: row.name, reason: reason || null }),
								confirm: { title: __("Pause this campaign?"), reason_field: { label: __("Reason"), required: false }, impact_of: (row) => [{ label: __("Messages that will stop"), value: fmt_int(cint(row.total_recipients) - cint(row.sent_count)) }] },
								success_message: __("Campaign paused"),
							},
							{ label: __("Sent messages"), handler: (row) => frappe.set_route("List", "WhatsApp Log", { campaign: row.name }) },
							{ label: __("Open"), handler: (row) => frappe.set_route("Form", "WhatsApp Campaign", row.name) },
						],
						empty_text: __("No campaign is sending right now"),
					},
				},
			],
		});

		if (typeof sanad.ui.BulkActions !== "function") return;
		// One full string per verb, count always present (no verb + noun concatenation).
		const bulk = (spec) => ({
			label: (n) => spec.label(fmt_int(n)),
			method: spec.method,
			roles: ["WhatsApp Manager", "System Manager"],
			condition: (docs) => docs.some((d) => spec.applies(d.status)),
			args: (names, { reason } = {}) => (spec.reason ? { names, reason } : { names }),
			confirm: (names, docs) => {
				const items = docs.filter((d) => spec.applies(d.status));
				const skipped = docs.length - items.length;
				return {
					title: spec.title(fmt_int(items.length)),
					impact: [
						{ label: __("Campaigns"), value: fmt_int(items.length) },
						{ label: __("Recipients in total"), value: fmt_int(items.reduce((n, d) => n + cint(d.total_recipients), 0)) },
						...(skipped ? [{ label: __("Skipped (status does not apply)"), value: fmt_int(skipped), tone: "amber" }] : []),
					],
					reason_field: spec.reason ? { label: __("Reason"), required: true } : false,
					ack_checkbox: spec.ack || undefined,
					danger: !!spec.danger,
					confirm_label: spec.label(fmt_int(items.length)),
				};
			},
			success: (result) => spec.done(fmt_int(result && result.count != null ? result.count : 0)),
		});
		new sanad.ui.BulkActions({
			listview,
			actions: [
				bulk({
					label: (n) => __("Pause {0}", [n]),
					title: (n) => __("Pause {0} campaigns?", [n]),
					done: (n) => __("Paused {0} campaigns", [n]),
					method: "campaigns.pause_many",
					applies: (s) => ["Running", "Queued"].includes(s),
					reason: true,
				}),
				bulk({
					label: (n) => __("Resume {0}", [n]),
					title: (n) => __("Resume {0} campaigns?", [n]),
					done: (n) => __("Resumed {0} campaigns", [n]),
					method: "campaigns.resume_many",
					applies: (s) => s === "Paused",
				}),
				bulk({
					label: (n) => __("Cancel {0}", [n]),
					title: (n) => __("Cancel {0} campaigns?", [n]),
					done: (n) => __("Cancelled {0} campaigns", [n]),
					method: "campaigns.cancel_many",
					applies: (s) => !TERMINAL.includes(s),
					reason: true,
					ack: __("I understand the remaining messages will not be sent."),
					danger: true,
				}),
			],
		});
	},
};

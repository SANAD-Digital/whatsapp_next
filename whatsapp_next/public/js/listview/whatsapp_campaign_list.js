// WhatsApp Campaign list (09 row 6, D-064 option A — prototype-faithful): PageHeader (title,
// description, "New campaign", "Sending now" strips with progress / pause / sent messages, and the
// next scheduled campaigns as strips), FilterBar (search, status, device, schedule period),
// DataList columns exactly as the prototype (campaign + owner, status, edit chip, progress bar,
// recipients, sent, success %, read, read %) with "View" → form, and BulkActions pause / resume /
// cancel through `campaigns.*_many`. The status indicator here is the one colour source (read
// elsewhere through `sanad.ui.indicator_for`). Until `sanad.ui.DataList` lands, the native rows
// keep their formatters and RowActions.

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
const TERMINAL = ["Completed", "Partially Failed", "Cancelled"];
const STOPPABLE = ["Scheduled", "Queued", "Running"];
const EDITABLE = ["Draft", "Paused"];
const fmt_int = (v) => sanad.ui.format_int(v);
const esc = (v) => sanad.ui.escape(v);
const is_manager = () => frappe.user.has_role("WhatsApp Manager") || frappe.user.has_role("System Manager");
const pct = (part, whole) => (cint(whole) ? frappe.format((cint(part) * 100) / cint(whole), { fieldtype: "Percent", precision: 1 }) : "—");
const badge = (doc) => sanad.ui.StatusBadge.html({ label: __(doc.status), colour: sanad.ui.indicator_for("WhatsApp Campaign", Object.assign({ doctype: "WhatsApp Campaign" }, doc)).colour });

function progress_html(doc, { tone } = {}) {
	const total = cint(doc.total_recipients);
	const sent = cint(doc.sent_count);
	const failed = cint(doc.failed_count);
	const sent_pct = total ? Math.min(100, (sent * 100) / total) : 0;
	const failed_pct = total ? Math.min(100 - sent_pct, (failed * 100) / total) : 0;
	return `<div class="sanad-progress ${tone ? `sanad-progress--${tone}` : ""}" role="img" aria-label="${esc(__("{0} of {1} sent", [fmt_int(sent), fmt_int(total)]))}">
		<div class="sanad-progress__label"><span>${fmt_int(sent)} / ${fmt_int(total)}</span></div>
		<div class="sanad-progress__bar"><div class="sanad-progress__fill" style="width:${sent_pct}%"></div><div class="sanad-progress__fail" style="width:${failed_pct}%"></div></div>
	</div>`;
}

/** "Stop to edit" (running / scheduled), "Edit" (draft / paused) or "—" (ended). */
function edit_chip(doc) {
	if (STOPPABLE.includes(doc.status) && is_manager()) return `<button type="button" class="sanad-chip sanad-chip--sm" data-edit="stop" data-name="${esc(doc.name)}">${esc(__("Stop to edit"))}</button>`;
	if (EDITABLE.includes(doc.status)) return `<button type="button" class="sanad-chip sanad-chip--sm sanad-chip--active" data-edit="open" data-name="${esc(doc.name)}">${esc(__("Edit"))}</button>`;
	return `<span class="text-muted">—</span>`;
}

function stop_to_edit(doc, after) {
	sanad.ui.ConfirmDialog.ask({
		title: __("Stop {0} to edit it?", [doc.campaign_name || doc.name]),
		message: __("Nothing is deleted. Unsent messages stay saved and sending resumes from the same point."),
		impact: [{ label: __("Messages that will stop"), value: fmt_int(cint(doc.total_recipients) - cint(doc.sent_count) - cint(doc.failed_count)) }],
		reason_field: { label: __("Reason"), required: false },
		confirm_label: __("Stop and edit"),
		on_confirm: ({ reason }) => sanad.ui.call("campaigns.pause", { name: doc.name, reason: reason || null }),
	})
		.then(() => {
			sanad.ui.Toast.success(__("Campaign paused"));
			after && after();
			frappe.set_route("Form", "WhatsApp Campaign", doc.name);
		})
		.catch(() => {});
}

function bind_edit_chips($root, listview) {
	$root.off("click.waedit").on("click.waedit", "[data-edit]", (e) => {
		e.stopPropagation();
		const $b = $(e.currentTarget);
		const name = $b.data("name");
		const doc = (listview.data || []).find((d) => d.name === name) || { name };
		if ($b.data("edit") === "open") frappe.set_route("Form", "WhatsApp Campaign", name);
		else stop_to_edit(doc, () => listview.refresh());
	});
}

// ---- header blocks -----------------------------------------------------------------------

function eta_text(p) {
	const r = (p && p.rates) || {};
	const c = (p && p.counters) || {};
	const remaining = cint(c.open);
	const eta = cint(r.eta_seconds);
	const minutes = eta ? Math.max(1, Math.round(eta / 60)) : 0;
	const device = p && p.device ? __("from device {0}", [p.device]) : "";
	if (!remaining) return __("All messages handed to the queue.");
	return [__("{0} messages remaining", [fmt_int(remaining)]), minutes ? __("about {0} min at {1} per minute", [fmt_int(minutes), fmt_int(r.messages_per_minute)]) : "", device].filter(Boolean).join(" — ");
}

function render_sending_now($el, header) {
	const state = new sanad.ui.EmptyState({ wrapper: $el, state: "loading", size: "sm", rows: 1 });
	return sanad.ui
		.call("campaigns.get_sending_now", {}, { silent: true })
		.then((rows) => {
			rows = (rows || []).filter((r) => ["Running", "Queued"].includes(r.status));
			if (!rows.length) return state.hide();
			state.hide();
			const $list = $('<div class="sanad-strip-list"></div>');
			rows.forEach((row) => {
				const c = row.counters || {};
				const total = cint(row.total_recipients);
				const done = cint(c.sent) || cint(row.sent_count);
				const $strip = $(`
					<div class="sanad-strip sanad-strip--green" data-name="${esc(row.name)}">
						<span class="sanad-strip__title sanad-tone--green"><span class="sanad-strip__dot" aria-hidden="true"></span><a href="/app/whatsapp-campaign/${encodeURIComponent(row.name)}">${esc(row.campaign_name || row.name)}</a></span>
						${badge(row)}
						<div class="sanad-strip__grow">${progress_html({ total_recipients: total, sent_count: done, failed_count: cint(c.failed) })}</div>
						<span class="sanad-strip__meta sanad-tabular" dir="auto">
							<span>${esc(__("{0}% · {1} / {2}", [total ? Math.round((done * 100) / total) : 0, fmt_int(done), fmt_int(total)]))}</span>
							<span>${esc(__("Sent {0}", [fmt_int(c.sent)]))}</span><span>${esc(__("Delivered {0}", [fmt_int(c.delivered)]))}</span><span>${esc(__("Read {0}", [fmt_int(c.read)]))}</span><span class="${cint(c.failed) ? "sanad-tone--red" : ""}">${esc(__("Failed {0}", [fmt_int(c.failed)]))}</span>
						</span>
						<div class="sanad-strip__actions"></div>
						<div class="sanad-strip__note" aria-live="polite" dir="auto"></div>
					</div>`);
				const $actions = $strip.find(".sanad-strip__actions");
				if (is_manager()) {
					$(`<button type="button" class="btn btn-default btn-sm">${esc(__("Pause"))}</button>`)
						.on("click", () =>
							sanad.ui.ConfirmDialog.ask({
								title: __("Pause {0}?", [row.campaign_name || row.name]),
								impact: [{ label: __("Messages that will stop"), value: fmt_int(cint(c.open)) }],
								reason_field: { label: __("Reason"), required: false },
								confirm_label: __("Pause"),
								on_confirm: ({ reason }) => sanad.ui.call("campaigns.pause", { name: row.name, reason: reason || null }),
							})
								.then(() => {
									sanad.ui.Toast.success(__("Campaign paused"));
									header.refresh(true);
									header.listview.refresh();
								})
								.catch(() => {})
						)
						.appendTo($actions);
				}
				$(`<button type="button" class="btn btn-primary btn-sm">${esc(__("Sent messages"))}</button>`)
					.on("click", () => frappe.set_route("List", "WhatsApp Log", { campaign: row.name }))
					.appendTo($actions);
				$list.append($strip);
				sanad.ui
					.call("campaigns.get_progress", { name: row.name }, { silent: true })
					.then((p) => $strip.find(".sanad-strip__note").text(eta_text(p)))
					.catch(() => {});
			});
			$el.html($list);
		})
		.catch((err) => state.error(err, { action: { label: __("Retry"), onclick: () => render_sending_now($el, header) } }));
}

function render_scheduled($el, header) {
	const LIMIT = 3;
	return Promise.all([
		frappe.db.get_list("WhatsApp Campaign", {
			filters: { status: "Scheduled" },
			fields: ["name", "campaign_name", "status", "scheduled_at", "total_recipients", "device", "sent_count", "failed_count"],
			order_by: "scheduled_at asc",
			limit: LIMIT,
		}),
		frappe.db.count("WhatsApp Campaign", { filters: { status: "Scheduled" } }),
	])
		.then(([rows, total]) => {
			$el.empty();
			if (!rows.length) return;
			const $list = $('<div class="sanad-strip-list"></div>');
			rows.forEach((row) => {
				const days = row.scheduled_at ? frappe.datetime.get_day_diff(row.scheduled_at, frappe.datetime.now_datetime()) : null;
				const when = days == null ? "" : days <= 0 ? __("today") : sanad.ui.plural(days, { one: __("in {0} day"), two: __("in {0} days"), few: __("in {0} days"), many: __("in {0} days"), other: __("in {0} days") });
				const $strip = $(`
					<div class="sanad-strip" data-name="${esc(row.name)}">
						<span class="sanad-strip__title sanad-tone--blue"><span class="sanad-strip__dot" aria-hidden="true"></span><a href="/app/whatsapp-campaign/${encodeURIComponent(row.name)}">${esc(row.campaign_name || row.name)}</a></span>
						${badge(row)}
						<span class="sanad-strip__meta" dir="auto">
							<span class="sanad-tabular">${esc(frappe.datetime.str_to_user(row.scheduled_at))}</span>
							${when ? `<span>${esc(when)}</span>` : ""}
							<span>${esc(sanad.ui.plural(cint(row.total_recipients), { one: __("{0} recipient"), two: __("{0} recipients"), few: __("{0} recipients"), many: __("{0} recipients"), other: __("{0} recipients") }))}</span>
							${row.device ? `<span>${esc(row.device)}</span>` : ""}
						</span>
						<div class="sanad-strip__actions"></div>
					</div>`);
				const $actions = $strip.find(".sanad-strip__actions");
				if (is_manager()) {
					$(`<button type="button" class="btn btn-default btn-sm">${esc(__("Stop to edit"))}</button>`)
						.on("click", () => stop_to_edit(row, () => header.refresh(true)))
						.appendTo($actions);
				}
				$(`<button type="button" class="btn btn-default btn-sm">${esc(__("Scheduled messages"))}</button>`)
					.on("click", () => frappe.set_route("List", "WhatsApp Log", { campaign: row.name }))
					.appendTo($actions);
				$list.append($strip);
			});
			$el.append($list);
			if (total > rows.length) {
				$el.append(`<p class="sanad-strip-more">${esc(sanad.ui.plural(total - rows.length, { one: __("{0} more scheduled campaign in the list below."), two: __("{0} more scheduled campaigns in the list below."), few: __("{0} more scheduled campaigns in the list below."), many: __("{0} more scheduled campaigns in the list below."), other: __("{0} more scheduled campaigns in the list below.") }))}</p>`);
			}
		})
		.catch((err) => new sanad.ui.EmptyState({ wrapper: $el, state: "error", size: "sm", description: err.message, action: { label: __("Retry"), onclick: () => render_scheduled($el, header) } }));
}

// ---- list settings -----------------------------------------------------------------------

frappe.listview_settings["WhatsApp Campaign"] = {
	add_fields: ["campaign_name", "status", "owner", "device", "scheduled_at", "total_recipients", "sent_count", "delivered_count", "read_count", "failed_count", "started_at"],
	hide_name_column: true,

	get_indicator(doc) {
		return [__(doc.status), INDICATOR[doc.status] || "gray", `status,=,${doc.status}`];
	},

	// Fallback (native rows) until DataList is present.
	formatters: {
		sent_count(value, df, doc) {
			const total = cint(doc.total_recipients);
			return total ? `<span class="sanad-tabular">${fmt_int(value)} / ${fmt_int(total)}</span>` : fmt_int(value);
		},
	},

	onload(listview) {
		const ui = sanad.ui;
		listview.sanad_header = new ui.PageHeader({
			listview,
			title: __("Campaigns"),
			description: __("Bulk sending to a group of contacts from one template, at a controlled rate, with step-by-step tracking."),
			primary: { label: __("New campaign"), icon: "es-line-add", perm: "create", handler: () => frappe.new_doc("WhatsApp Campaign") },
			blocks: [
				{ key: "sending", events: ["wa:campaign:status", "wa:queue:progress"], render: render_sending_now },
				{ key: "scheduled", events: ["wa:campaign:status"], render: render_scheduled },
			],
		});

		if (typeof ui.FilterBar === "function") {
			new ui.FilterBar({
				listview,
				actions: ["group_by", "export"],
				presets: [
					{ fieldname: "campaign_name", type: "search", fields: ["campaign_name", "owner"], placeholder: __("Campaign or owner name…") },
					{ fieldname: "status", type: "select" },
					{ fieldname: "device", type: "select" },
					{ fieldname: "scheduled_at", type: "daterange", label: __("Start") },
				],
			});
		}

		const columns = [
			{ fieldname: "campaign_name", label: __("Campaign"), sortable: true, format: (v, doc) => esc(v || doc.name), sub: (doc) => esc(frappe.user.full_name(doc.owner) || doc.owner || "") },
			{ fieldname: "status", label: __("Status"), type: "status", sortable: true },
			{ fieldname: "_edit", label: __("Edit"), sortable: false, format: (v, doc) => edit_chip(doc) },
			{ fieldname: "sent_count", label: __("Progress"), sortable: false, format: (v, doc) => progress_html(doc, { tone: doc.status === "Paused" ? "amber" : "" }) },
			{ fieldname: "total_recipients", label: __("Recipients"), type: "number", align: "end", sortable: true },
			{ fieldname: "sent_count", label: __("Sent"), type: "number", align: "end", sortable: true },
			{ fieldname: "_ok_rate", label: __("Success %"), align: "end", sortable: false, format: (v, doc) => (cint(doc.sent_count) ? `<span class="sanad-tone--green sanad-tabular">${esc(pct(cint(doc.sent_count) - cint(doc.failed_count), doc.sent_count))}</span>` : "—") },
			{ fieldname: "read_count", label: __("Read"), type: "number", align: "end", sortable: true },
			{ fieldname: "_read_rate", label: __("Read %"), align: "end", sortable: false, format: (v, doc) => (cint(doc.sent_count) ? `<span class="sanad-tone--blue sanad-tabular">${esc(pct(doc.read_count, doc.sent_count))}</span>` : "—") },
			{ fieldname: "failed_count", label: __("Failed"), type: "number", align: "end", sortable: true, hidden_xs: true, format: (v) => (cint(v) ? `<span class="sanad-tone--red sanad-tabular">${fmt_int(v)}</span>` : "0") },
			{ fieldname: "device", label: __("Device"), type: "avatar", sortable: true, hidden_xs: true },
		];

		if (typeof ui.DataList === "function") {
			listview.sanad_datalist = new ui.DataList({
				listview,
				columns,
				selectable: true,
				row_action: { label: __("View"), handler: (doc) => frappe.set_route("Form", "WhatsApp Campaign", doc.name) },
				on_row_click: (doc) => frappe.set_route("Form", "WhatsApp Campaign", doc.name),
				page_length: 20,
				footer: { count: (total) => sanad.ui.plural(total, { one: __("{0} campaign"), two: __("{0} campaigns"), few: __("{0} campaigns"), many: __("{0} campaigns"), other: __("{0} campaigns") }) },
				empty: { title: __("No campaigns yet"), description: __("Create a campaign to send one message to many recipients."), action: is_manager() ? { label: __("New campaign"), onclick: () => frappe.new_doc("WhatsApp Campaign") } : undefined },
				mobile: "cards",
			});
			ui.on_list_render(listview, () => bind_edit_chips(listview.$result, listview));
		} else if (typeof ui.RowActions === "function") {
			new ui.RowActions({
				listview,
				actions: [
					{ label: __("View"), icon: ui.icons.open, handler: (doc) => frappe.set_route("Form", "WhatsApp Campaign", doc.name) },
					{ label: __("Stop to edit"), icon: ui.icons.cancel, condition: (doc) => STOPPABLE.includes(doc.status) && is_manager(), handler: (doc) => stop_to_edit(doc, () => listview.refresh()) },
					{ label: __("Sent messages"), icon: ui.icons.link, handler: (doc) => frappe.set_route("List", "WhatsApp Log", { campaign: doc.name }) },
				],
			});
		}

		ui.bind_list_realtime(listview, "wa:campaign:status");

		if (typeof ui.BulkActions !== "function") return;
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
		new ui.BulkActions({
			listview,
			actions: [
				bulk({ label: (n) => __("Pause {0}", [n]), title: (n) => __("Pause {0} campaigns?", [n]), done: (n) => __("Paused {0} campaigns", [n]), method: "campaigns.pause_many", applies: (s) => ["Running", "Queued"].includes(s), reason: true }),
				bulk({ label: (n) => __("Resume {0}", [n]), title: (n) => __("Resume {0} campaigns?", [n]), done: (n) => __("Resumed {0} campaigns", [n]), method: "campaigns.resume_many", applies: (s) => s === "Paused" }),
				bulk({ label: (n) => __("Cancel {0}", [n]), title: (n) => __("Cancel {0} campaigns?", [n]), done: (n) => __("Cancelled {0} campaigns", [n]), method: "campaigns.cancel_many", applies: (s) => !TERMINAL.includes(s), reason: true, ack: __("I understand the remaining messages will not be sent."), danger: true }),
			],
		});
	},
};

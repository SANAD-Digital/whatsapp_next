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
/** A share as plain text, one decimal, never Frappe's wrapped HTML (it would be escaped). */
const pct = (part, whole) => {
	if (!cint(whole)) return "—";
	const value = (cint(part) * 100) / cint(whole);
	return `${frappe.format(value, { fieldtype: "Float", precision: value % 1 ? 1 : 0 }, { inline: true })}%`;
};
const badge = (doc) => sanad.ui.StatusBadge.html({ label: __(doc.status), colour: sanad.ui.indicator_for("WhatsApp Campaign", Object.assign({ doctype: "WhatsApp Campaign" }, doc)).colour });

function progress_html(doc, { tone } = {}) {
	const total = cint(doc.total_recipients);
	const sent = cint(doc.sent_count);
	const failed = cint(doc.failed_count);
	if (!total) return `<span class="text-muted">—</span>`;
	return `<div class="wa-camp__cell">
		<span class="wa-camp__cell-label sanad-tabular">${esc(fmt_int(sent))} / ${esc(fmt_int(total))}</span>
		${bar_html(total, sent, failed, { paused: tone === "amber" })}
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

// ---- the campaigns console -------------------------------------------------------------------

const OVERVIEW_DAYS = 30;
const overview_state = { promise: null, at: 0 };
const OVERVIEW_TTL = 15000;

/** The screen's own numbers, cached beside the per-campaign reads that share the same tick. */
function overview(fresh = false) {
	if (fresh || (overview_state.promise && Date.now() - overview_state.at > OVERVIEW_TTL)) overview_state.promise = null;
	if (!overview_state.promise) {
		overview_state.at = Date.now();
		overview_state.promise = sanad.ui
			.call("campaigns.get_overview", { days: OVERVIEW_DAYS }, { silent: true })
			.catch(() => null);
	}
	return overview_state.promise;
}

const share = (part, whole) => (cint(whole) ? Math.round((cint(part) * 100) / cint(whole)) : null);

/**
 * What has left the campaign. `Sent`, `Delivered` and `Read` are three stages of the same fact,
 * so progress that counts only `Sent` shows 3 % for a campaign that has handed over a third.
 */
const handed_of = (c) => cint(c.sent) + cint(c.delivered) + cint(c.read);
const pct_text = (part, whole) => {
	const value = share(part, whole);
	return value == null ? "—" : `${fmt_int(value)}%`;
};

/** One cell of the metric row: small capital label, the number, the line that qualifies it. */
function metric(label, value, sub, opts = {}) {
	return `<div class="wa-ops__metric">
		<span class="wa-ops__label">${esc(label)}</span>
		<span class="wa-ops__value${opts.tone ? ` sanad-tone--${opts.tone}` : ""} sanad-tabular">${value}</span>
		<span class="wa-ops__sub">${sub || "&nbsp;"}</span>
	</div>`;
}

/** A campaign's own progress: sent, failed and what is still to go, in one bar. */
function bar_html(total, sent, failed, { paused } = {}) {
	const t = Math.max(cint(total), 1);
	const sent_pct = Math.min(100, (cint(sent) * 100) / t);
	const failed_pct = Math.min(100 - sent_pct, (cint(failed) * 100) / t);
	return `<div class="wa-camp__bar${paused ? " wa-camp__bar--paused" : ""}" role="img"
			aria-label="${esc(__("{0} of {1} sent, {2} failed", [fmt_int(sent), fmt_int(total), fmt_int(failed)]))}">
		<span class="wa-camp__bar-sent" style="inline-size:${sent_pct.toFixed(2)}%"></span>
		<span class="wa-camp__bar-failed" style="inline-size:${failed_pct.toFixed(2)}%"></span>
	</div>`;
}

/** The sentence under a running campaign: what is left, how long it takes, which device sends it. */
function eta_text(p) {
	const r = (p && p.rates) || {};
	const c = (p && p.counters) || {};
	const remaining = cint(c.open);
	const minutes = cint(r.eta_seconds) ? Math.max(1, Math.round(cint(r.eta_seconds) / 60)) : 0;
	if (!remaining) return __("Everything has been handed to the queue.");
	return [
		sanad.ui.plural(remaining, { one: __("{0} message left"), other: __("{0} messages left") }),
		minutes ? __("about {0} min at {1}/min", [fmt_int(minutes), fmt_int(r.messages_per_minute)]) : "",
		p && p.device ? __("device {0}", [p.device]) : "",
	]
		.filter(Boolean)
		.join(" · ");
}

/** The metric row: what every campaign together is doing, and what the last 30 days achieved. */
function metrics_html(o) {
	if (!o) return "";
	const states = o.states || {};
	const totals = o.totals || {};
	const running = cint(states.Running) + cint(states.Queued);
	const paused = cint(states.Paused);
	const per_minute = o.per_minute == null ? null : Math.round(o.per_minute);

	return `
		<div class="wa-ops__metrics">
			<div class="wa-ops__metric wa-ops__metric--state">
				<span class="wa-ops__label">${esc(__("Sending now"))}</span>
				<div class="wa-ops__state-row">
					<span class="wa-ops__state sanad-tone--${running ? "green" : "gray"}">
						${running ? '<span class="wa-ops__pulse" aria-hidden="true"></span>' : ""}${esc(
							running ? sanad.ui.plural(running, { one: __("{0} campaign"), other: __("{0} campaigns") }) : __("Nothing")
						)}
					</span>
				</div>
				<span class="wa-ops__sub">${esc(
					paused
						? sanad.ui.plural(paused, { one: __("{0} paused"), other: __("{0} paused") })
						: running
							? __("handing messages to the queue")
							: __("no campaign is sending")
				)}</span>
			</div>
			${metric(
				__("In flight"),
				esc(fmt_int(o.in_flight)),
				esc(__("recipients not yet sent")),
			)}
			${metric(
				__("Throughput"),
				per_minute == null ? "—" : esc(__("{0}/min", [fmt_int(per_minute)])),
				esc(__("last hour, actual")),
			)}
			${metric(
				__("Delivery rate"),
				esc(pct_text(totals.delivered, totals.sent)),
				esc(__("of {0} sent", [fmt_int(totals.sent)])),
			)}
			${metric(
				__("Read rate"),
				esc(pct_text(totals.read, totals.sent)),
				esc(__("last {0} days", [fmt_int(o.days || OVERVIEW_DAYS)])),
			)}
			${metric(
				__("Failed"),
				esc(fmt_int(totals.failed)),
				cint(totals.failed)
					? `<button type="button" class="wa-ops__link" data-go="failed">${esc(__("See the messages"))}</button>`
					: esc(__("no failures")),
				{ tone: cint(totals.failed) ? "red" : "" },
			)}
		</div>`;
}

/** The line under the console: what is not sending yet. */
function foot_html(o) {
	const states = (o && o.states) || {};
	return `<p class="wa-camp__foot wa-ops__sub">${esc(
		__("{0} scheduled · {1} drafts · {2} finished", [
			fmt_int(states.Scheduled),
			fmt_int(states.Draft),
			fmt_int(cint(states.Completed) + cint(states["Partially Failed"])),
		])
	)}</p>`;
}

/**
 * The lower half: every campaign that is sending right now, one row each — name and state, the
 * bar that says how far it got, the four counters it is judged by, the sentence that says when it
 * ends, and its verbs. When nothing is sending, the next scheduled campaigns take the space, and
 * when there is neither, the block stays empty rather than drawing a band that says nothing.
 */
function render_console($el, header) {
	if (!$el.children().length) new sanad.ui.EmptyState({ wrapper: $el, state: "loading", size: "sm", rows: 2 });
	return Promise.all([overview(), sanad.ui.call("campaigns.get_sending_now", {}, { silent: true })])
		.then(([o, rows]) => {
			const live = (rows || []).filter((r) => ["Running", "Queued", "Paused"].includes(r.status));
			$el.html(`<section class="wa-ops">
				${metrics_html(o)}
				<div class="wa-ops__lower wa-ops__lower--single"></div>
			</section>
			${foot_html(o)}`);
			$el.find("[data-go=failed]").on("click", () => frappe.set_route("List", "WhatsApp Log", { status: "Failed" }));
			const $lower = $el.find(".wa-ops__lower");
			if (!live.length) return render_next($lower);

			const $list = $('<div class="wa-camp__live"></div>');
			live.forEach((row) => {
				const c = row.counters || {};
				const total = cint(row.total_recipients) || cint(c.total);
				const sent = handed_of(c) || cint(row.sent_count);
				const failed = cint(c.failed) || cint(row.failed_count);
				const paused = row.status === "Paused";
				const $row = $(`
					<article class="wa-camp__row" data-name="${esc(row.name)}">
						<header class="wa-camp__head">
							<a class="wa-camp__name" href="/app/whatsapp-campaign/${encodeURIComponent(row.name)}">${esc(row.campaign_name || row.name)}</a>
							${badge(row)}
							<span class="wa-camp__pct sanad-tabular">${esc(pct_text(sent, total))}</span>
						</header>
						${bar_html(total, sent, failed, { paused })}
						<div class="wa-camp__facts">
							<span>${esc(__("Sent"))} <b class="sanad-tabular">${esc(fmt_int(sent))}</b> / <span class="sanad-tabular">${esc(fmt_int(total))}</span></span>
							<span>${esc(__("Delivered"))} <b class="sanad-tabular">${esc(fmt_int(c.delivered))}</b></span>
							<span>${esc(__("Read"))} <b class="sanad-tabular">${esc(fmt_int(c.read))}</b></span>
							<span class="${failed ? "sanad-tone--red" : ""}">${esc(__("Failed"))} <b class="sanad-tabular">${esc(fmt_int(failed))}</b></span>
						</div>
						<p class="wa-camp__note" aria-live="polite" dir="auto"></p>
						<div class="wa-camp__actions"></div>
					</article>`);

				const $actions = $row.find(".wa-camp__actions");
				if (is_manager() && !paused) {
					$(`<button type="button" class="btn btn-default btn-sm">${esc(__("Pause"))}</button>`)
						.on("click", () =>
							sanad.ui.ConfirmDialog.ask({
								title: __("Pause {0}?", [row.campaign_name || row.name]),
								message: __("Nothing is deleted. Unsent messages stay saved and sending resumes from the same point."),
								impact: [{ label: __("Messages that will stop"), value: fmt_int(cint(c.open)) }],
								reason_field: { label: __("Reason"), required: false },
								confirm_label: __("Pause"),
								on_confirm: ({ reason }) => sanad.ui.call("campaigns.pause", { name: row.name, reason: reason || null }),
							})
								.then(() => {
									sanad.ui.Toast.success(__("Campaign paused"));
									refresh_all(header);
								})
								.catch(() => {})
						)
						.appendTo($actions);
				}
				if (is_manager() && paused) {
					$(`<button type="button" class="btn btn-default btn-sm">${esc(__("Resume"))}</button>`)
						.on("click", () =>
							sanad.ui
								.call("campaigns.resume", { name: row.name })
								.then(() => {
									sanad.ui.Toast.success(__("Campaign resumed"));
									refresh_all(header);
								})
								.catch((err) => sanad.ui.Toast.error(err))
						)
						.appendTo($actions);
				}
				$(`<button type="button" class="btn btn-default btn-sm">${esc(__("Messages"))}</button>`)
					.on("click", () => frappe.set_route("List", "WhatsApp Log", { campaign: row.name }))
					.appendTo($actions);

				$list.append($row);
				sanad.ui
					.call("campaigns.get_progress", { name: row.name }, { silent: true })
					.then((p) => $row.find(".wa-camp__note").text(eta_text(p)))
					.catch(() => {});
			});
			$lower.html($list);
		})
		.catch((err) => {
			new sanad.ui.EmptyState({
				wrapper: $el,
				state: "error",
				size: "sm",
				description: err.message,
				action: { label: __("Retry"), onclick: () => render_console($el, header) },
			});
		});
}

/** Nothing is sending: what is next, as plain lines — never a band of empty cards. */
function render_next($el) {
	return frappe.db
		.get_list("WhatsApp Campaign", {
			filters: { status: "Scheduled" },
			fields: ["name", "campaign_name", "scheduled_at", "total_recipients", "device"],
			order_by: "scheduled_at asc",
			limit: 3,
		})
		.then((rows) => {
			$el.empty();
			if (!rows || !rows.length) return;
			const items = rows
				.map(
					(row) => `<li>
						<a href="/app/whatsapp-campaign/${encodeURIComponent(row.name)}">${esc(row.campaign_name || row.name)}</a>
						<span class="sanad-tabular">${esc(frappe.datetime.str_to_user(row.scheduled_at))}</span>
						<span>${esc(sanad.ui.plural(cint(row.total_recipients), { one: __("{0} recipient"), other: __("{0} recipients") }))}</span>
					</li>`
				)
				.join("");
			$el.html(`<div class="wa-camp__next">
				<span class="wa-ops__label">${esc(__("Next scheduled"))}</span>
				<ul>${items}</ul>
			</div>`);
		})
		.catch(() => $el.empty());
}

function refresh_all(header) {
	overview(true);
	header.refresh(true);
	header.listview && header.listview.refresh();
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
		// No title and no description: Desk's breadcrumb names the list and the console's first
		// cell says what the campaigns are doing, which is all a title could have said. "New
		// campaign" goes back to Desk's own primary slot, where a list's create action belongs.
		listview.sanad_header = new ui.PageHeader({
			listview,
			blocks: [{ key: "campaign-console", events: ["wa:campaign:status", "wa:queue:progress"], render: render_console }],
		});
		// Desk rewrites its own "+ Add WhatsApp Campaign" on every refresh, so the screen's label is
		// re-applied after each render rather than once on load
		const set_create = () => {
			if (!frappe.perm.has_perm("WhatsApp Campaign", 0, "create")) return;
			listview.page.set_primary_action(__("New campaign"), () => frappe.new_doc("WhatsApp Campaign"), "es-line-add");
		};
		set_create();
		ui.on_list_render(listview, set_create);

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
			{ fieldname: "campaign_name", label: __("Campaign"), width: 200, sortable: true, format: (v, doc) => esc(v || doc.name), sub: (doc) => esc(frappe.user.full_name(doc.owner) || doc.owner || "") },
			{ fieldname: "status", label: __("Status"), type: "status", width: 110, sortable: true },
			{ fieldname: "_edit", label: __("Edit"), width: 95, sortable: false, format: (v, doc) => edit_chip(doc) },
			{ fieldname: "sent_count", label: __("Progress"), width: 125, sortable: false, format: (v, doc) => progress_html(doc, { tone: doc.status === "Paused" ? "amber" : "" }) },
			{ fieldname: "total_recipients", label: __("Recipients"), type: "number", width: 95, align: "end", sortable: true },
			{ fieldname: "_ok_rate", label: __("Success %"), width: 90, align: "end", sortable: false, format: (v, doc) => (cint(doc.sent_count) ? `<span class="sanad-tone--green sanad-tabular">${esc(pct(cint(doc.sent_count) - cint(doc.failed_count), doc.sent_count))}</span>` : "—") },
			{ fieldname: "_read_rate", label: __("Read %"), width: 80, align: "end", sortable: false, format: (v, doc) => (cint(doc.sent_count) ? `<span class="sanad-tone--blue sanad-tabular">${esc(pct(doc.read_count, doc.sent_count))}</span>` : "—") },
			{ fieldname: "failed_count", label: __("Failures"), type: "number", width: 95, align: "end", sortable: true, hidden_xs: true, format: (v) => (cint(v) ? `<span class="sanad-tone--red sanad-tabular">${fmt_int(v)}</span>` : "0") },
			{ fieldname: "device", label: __("Device"), type: "avatar", width: 140, sortable: true, hidden_xs: true },
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

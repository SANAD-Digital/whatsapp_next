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
/** How much of the screen the console may claim: the prototype's one live strip, three in all. */
const LIVE_STRIPS = 2;
const STRIP_BUDGET = 3;
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

/** The same rule over a campaign document, whose counters are the four disjoint fields. */
const handed_of_doc = (doc) => cint(doc.sent_count) + cint(doc.delivered_count) + cint(doc.read_count);
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

/**
 * The prototype's four-segment bar (`docs/screen/Hub Screen - Campaigns.dc.html`): read, then
 * delivered, then sent-but-not-yet-delivered, then failed — each as a share of the recipients, so
 * the bar is the campaign's funnel and the empty tail is what has not gone out yet.
 */
function bar_html(doc, { paused } = {}) {
	const total = Math.max(cint(doc.total_recipients), 1);
	const w = (n) => `${Math.max(0, (cint(n) * 100) / total).toFixed(2)}%`;
	return `<span class="wa-strip__bar${paused ? " wa-strip__bar--paused" : ""}" role="img"
			aria-label="${esc(__("{0} sent, {1} delivered, {2} read, {3} failed, of {4} recipients", [
				fmt_int(handed_of_doc(doc)), fmt_int(doc.delivered_count), fmt_int(doc.read_count), fmt_int(doc.failed_count), fmt_int(doc.total_recipients),
			]))}">
		<span class="wa-strip__seg wa-strip__seg--read" style="inline-size:${w(doc.read_count)}"></span>
		<span class="wa-strip__seg wa-strip__seg--delivered" style="inline-size:${w(doc.delivered_count)}"></span>
		<span class="wa-strip__seg wa-strip__seg--sent" style="inline-size:${w(doc.sent_count)}"></span>
		<span class="wa-strip__seg wa-strip__seg--failed" style="inline-size:${w(doc.failed_count)}"></span>
	</span>`;
}

/** The same bar inside a table cell, with the prototype's "sent / recipients" label above it. */
function progress_html(doc, { tone } = {}) {
	if (!cint(doc.total_recipients)) return `<span class="text-muted">—</span>`;
	return `<span class="wa-strip__cell">
		<span class="wa-strip__cell-label sanad-tabular">${esc(fmt_int(handed_of_doc(doc)))} / ${esc(fmt_int(doc.total_recipients))}</span>
		${bar_html(doc, { paused: tone === "amber" })}
	</span>`;
}

/** The counters the prototype prints beside the bar: label above the number, four of them. */
function stats_html(doc) {
	const items = [
		{ label: __("Sent"), value: handed_of_doc(doc) },
		{ label: __("Delivered"), value: cint(doc.delivered_count) + cint(doc.read_count) },
		{ label: __("Read"), value: cint(doc.read_count), tone: "green" },
		{ label: __("Failed"), value: cint(doc.failed_count), tone: cint(doc.failed_count) ? "red" : "" },
	];
	return items
		.map(
			(s) => `<span class="wa-strip__stat">
				<span class="wa-strip__stat-label">${esc(s.label)}</span>
				<span class="wa-strip__stat-value sanad-tabular${s.tone ? ` sanad-tone--${s.tone}` : ""}">${esc(fmt_int(s.value))}</span>
			</span>`
		)
		.join("");
}

/** "N messages left — about 12 min at 20/min from device X." */
function eta_text(doc, progress) {
	const rates = (progress && progress.rates) || {};
	const counters = (progress && progress.counters) || {};
	const remaining = counters.open != null ? cint(counters.open) : Math.max(0, cint(doc.total_recipients) - handed_of_doc(doc) - cint(doc.failed_count));
	const rate = cint(rates.messages_per_minute) || cint(doc.messages_per_minute) || 20;
	if (!remaining) return __("Everything has been handed to the queue.");
	const minutes = remaining / Math.max(rate, 1);
	return __("{0} left — about {1} at {2}/min from device {3}.", [
		sanad.ui.plural(remaining, { one: __("{0} message"), other: __("{0} messages") }),
		minutes < 60 ? __("{0} min", [fmt_int(Math.round(minutes))]) : __("{0} h", [fmt_int(Math.round(minutes / 60))]),
		fmt_int(rate),
		esc(device_title(doc.device) || "—"),
	]);
}

/** The running campaign, as the prototype draws it: one line, then the sentence under it. */
function live_strip(row, header) {
	const doc = Object.assign({}, row, counters_as_doc(row));
	const paused = row.status === "Paused";
	const $strip = $(`
		<div class="wa-strip${paused ? " wa-strip--paused" : ""}">
			<div class="wa-strip__line">
				<span class="wa-strip__title">
					<span class="wa-strip__dot" aria-hidden="true"></span>
					<a class="wa-strip__name" href="/app/whatsapp-campaign/${encodeURIComponent(row.name)}">${esc(row.campaign_name || row.name)}</a>
					<span class="wa-strip__badge">${esc(paused ? __("Paused") : __("Running now"))}</span>
				</span>
				<span class="wa-strip__progress">
					${bar_html(doc, { paused })}
					<span class="wa-strip__progress-text sanad-tabular">${esc(fmt_int(handed_of_doc(doc)))} / ${esc(fmt_int(doc.total_recipients))} · ${esc(pct_text(handed_of_doc(doc), doc.total_recipients))}</span>
				</span>
				<span class="wa-strip__stats">${stats_html(doc)}</span>
				<span class="wa-strip__actions"></span>
			</div>
			<p class="wa-strip__foot" aria-live="polite" dir="auto"></p>
		</div>`);

	const $actions = $strip.find(".wa-strip__actions");
	if (is_manager()) {
		const label = paused ? __("Resume") : __("Pause");
		$(`<button type="button" class="btn btn-default btn-sm">${esc(label)}</button>`)
			.on("click", () => (paused ? resume_campaign(row, header) : pause_campaign(row, doc, header)))
			.appendTo($actions);
	}
	$(`<button type="button" class="btn btn-primary btn-sm">${esc(__("Outbound log"))}</button>`)
		.on("click", () => frappe.set_route("List", "WhatsApp Log", { campaign: row.name }))
		.appendTo($actions);

	$strip.find(".wa-strip__foot").text(eta_text(doc, null));
	sanad.ui
		.call("campaigns.get_progress", { name: row.name }, { silent: true })
		.then((p) => $strip.find(".wa-strip__foot").text(eta_text(doc, p)))
		.catch(() => {});
	return $strip;
}

/** A campaign waiting for its hour, as the prototype draws it. */
function scheduled_strip(row, header) {
	const when = row.scheduled_at ? `${frappe.datetime.str_to_user(row.scheduled_at).slice(0, 10)} ${row.scheduled_at.slice(11, 16)}` : "—";
	const days = row.scheduled_at ? frappe.datetime.get_day_diff(row.scheduled_at, frappe.datetime.now_datetime()) : null;
	const relative =
		days == null
			? ""
			: days < 0
				? __("the time has passed — waiting to resume")
				: days === 0
					? __("today")
					: days === 1
						? __("tomorrow")
						: __("in {0} days", [fmt_int(days)]);
	const meta = [
		relative,
		sanad.ui.plural(cint(row.total_recipients), { one: __("{0} recipient"), other: __("{0} recipients") }),
		device_title(row.device),
		cint(row.pause_count) ? __("edited {0} times", [fmt_int(row.pause_count)]) : "",
	]
		.filter(Boolean)
		.join(" · ");

	const $strip = $(`
		<div class="wa-strip wa-strip--scheduled">
			<div class="wa-strip__line">
				<span class="wa-strip__title">
					<span class="wa-strip__dot" aria-hidden="true"></span>
					<a class="wa-strip__name" href="/app/whatsapp-campaign/${encodeURIComponent(row.name)}">${esc(row.campaign_name || row.name)}</a>
					<span class="wa-strip__badge">${esc(__("Scheduled"))}</span>
				</span>
				<span class="wa-strip__when sanad-tabular">${esc(when)}</span>
				<span class="wa-strip__meta">${esc(meta)}</span>
				<span class="wa-strip__actions"></span>
			</div>
		</div>`);

	const $actions = $strip.find(".wa-strip__actions");
	if (is_manager()) {
		$(`<button type="button" class="btn btn-default btn-sm">${esc(__("Stop to edit"))}</button>`)
			.on("click", () => stop_to_edit(row, () => refresh_all(header)))
			.appendTo($actions);
	}
	$(`<button type="button" class="btn btn-default btn-sm wa-strip__btn-blue">${esc(__("Scheduled messages"))}</button>`)
		.on("click", () => frappe.set_route("List", "WhatsApp Log", { campaign: row.name }))
		.appendTo($actions);
	return $strip;
}

/** A device shows by its own name; Frappe caches the link title after the list has fetched it. */
function device_title(name) {
	if (!name) return "";
	const title = frappe.utils.get_link_title && frappe.utils.get_link_title("WhatsApp Device", name);
	return title || name;
}

/** `get_sending_now` returns live counters beside the campaign's own fields. */
function counters_as_doc(row) {
	const c = row.counters || {};
	return {
		total_recipients: cint(row.total_recipients) || cint(c.total),
		sent_count: cint(c.sent),
		delivered_count: cint(c.delivered),
		read_count: cint(c.read),
		failed_count: cint(c.failed) || cint(row.failed_count),
		messages_per_minute: row.messages_per_minute,
		device: row.device,
	};
}

function pause_campaign(row, doc, header) {
	const remaining = Math.max(0, cint(doc.total_recipients) - handed_of_doc(doc) - cint(doc.failed_count));
	sanad.ui.ConfirmDialog.ask({
		title: __("Pause {0}?", [row.campaign_name || row.name]),
		message: __("Nothing is deleted. Unsent messages stay saved and sending resumes from the same point."),
		impact: [{ label: __("Messages that will stop"), value: fmt_int(remaining) }],
		reason_field: { label: __("Reason"), required: false },
		confirm_label: __("Pause"),
		on_confirm: ({ reason }) => sanad.ui.call("campaigns.pause", { name: row.name, reason: reason || null }),
	})
		.then(() => {
			sanad.ui.Toast.success(__("Campaign paused"));
			refresh_all(header);
		})
		.catch(() => {});
}

function resume_campaign(row, header) {
	return sanad.ui
		.call("campaigns.resume", { name: row.name })
		.then(() => {
			sanad.ui.Toast.success(__("Campaign resumed"));
			refresh_all(header);
		})
		.catch((err) => sanad.ui.Toast.error(err));
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

/**
 * The prototype's four-segment bar (`docs/screen/Hub Screen - Campaigns.dc.html`): read, then
 * delivered, then sent-but-not-yet-delivered, then failed — each as a share of the recipients, so
 * the bar is the campaign's funnel and the empty tail is what has not gone out yet.
 */
function bar_html(doc, { paused } = {}) {
	const total = Math.max(cint(doc.total_recipients), 1);
	const w = (n) => `${Math.max(0, (cint(n) * 100) / total).toFixed(2)}%`;
	return `<span class="wa-strip__bar${paused ? " wa-strip__bar--paused" : ""}" role="img"
			aria-label="${esc(__("{0} sent, {1} delivered, {2} read, {3} failed, of {4} recipients", [
				fmt_int(handed_of_doc(doc)), fmt_int(doc.delivered_count), fmt_int(doc.read_count), fmt_int(doc.failed_count), fmt_int(doc.total_recipients),
			]))}">
		<span class="wa-strip__seg wa-strip__seg--read" style="inline-size:${w(doc.read_count)}"></span>
		<span class="wa-strip__seg wa-strip__seg--delivered" style="inline-size:${w(doc.delivered_count)}"></span>
		<span class="wa-strip__seg wa-strip__seg--sent" style="inline-size:${w(doc.sent_count)}"></span>
		<span class="wa-strip__seg wa-strip__seg--failed" style="inline-size:${w(doc.failed_count)}"></span>
	</span>`;
}

/** The same bar inside a table cell, with the prototype's "sent / recipients" label above it. */
function progress_html(doc, { tone } = {}) {
	if (!cint(doc.total_recipients)) return `<span class="text-muted">—</span>`;
	return `<span class="wa-strip__cell">
		<span class="wa-strip__cell-label sanad-tabular">${esc(fmt_int(handed_of_doc(doc)))} / ${esc(fmt_int(doc.total_recipients))}</span>
		${bar_html(doc, { paused: tone === "amber" })}
	</span>`;
}

/** The counters the prototype prints beside the bar: label above the number, four of them. */
function stats_html(doc) {
	const items = [
		{ label: __("Sent"), value: handed_of_doc(doc) },
		{ label: __("Delivered"), value: cint(doc.delivered_count) + cint(doc.read_count) },
		{ label: __("Read"), value: cint(doc.read_count), tone: "green" },
		{ label: __("Failed"), value: cint(doc.failed_count), tone: cint(doc.failed_count) ? "red" : "" },
	];
	return items
		.map(
			(s) => `<span class="wa-strip__stat">
				<span class="wa-strip__stat-label">${esc(s.label)}</span>
				<span class="wa-strip__stat-value sanad-tabular${s.tone ? ` sanad-tone--${s.tone}` : ""}">${esc(fmt_int(s.value))}</span>
			</span>`
		)
		.join("");
}

/** "N messages left — about 12 min at 20/min from device X." */
function eta_text(doc, progress) {
	const rates = (progress && progress.rates) || {};
	const counters = (progress && progress.counters) || {};
	const remaining = counters.open != null ? cint(counters.open) : Math.max(0, cint(doc.total_recipients) - handed_of_doc(doc) - cint(doc.failed_count));
	const rate = cint(rates.messages_per_minute) || cint(doc.messages_per_minute) || 20;
	if (!remaining) return __("Everything has been handed to the queue.");
	const minutes = remaining / Math.max(rate, 1);
	return __("{0} left — about {1} at {2}/min from device {3}.", [
		sanad.ui.plural(remaining, { one: __("{0} message"), other: __("{0} messages") }),
		minutes < 60 ? __("{0} min", [fmt_int(Math.round(minutes))]) : __("{0} h", [fmt_int(Math.round(minutes / 60))]),
		fmt_int(rate),
		esc(device_title(doc.device) || "—"),
	]);
}

/** The running campaign, as the prototype draws it: one line, then the sentence under it. */
function live_strip(row, header) {
	const doc = Object.assign({}, row, counters_as_doc(row));
	const paused = row.status === "Paused";
	const $strip = $(`
		<div class="wa-strip${paused ? " wa-strip--paused" : ""}">
			<div class="wa-strip__line">
				<span class="wa-strip__title">
					<span class="wa-strip__dot" aria-hidden="true"></span>
					<a class="wa-strip__name" href="/app/whatsapp-campaign/${encodeURIComponent(row.name)}">${esc(row.campaign_name || row.name)}</a>
					<span class="wa-strip__badge">${esc(paused ? __("Paused") : __("Running now"))}</span>
				</span>
				<span class="wa-strip__progress">
					${bar_html(doc, { paused })}
					<span class="wa-strip__progress-text sanad-tabular">${esc(fmt_int(handed_of_doc(doc)))} / ${esc(fmt_int(doc.total_recipients))} · ${esc(pct_text(handed_of_doc(doc), doc.total_recipients))}</span>
				</span>
				<span class="wa-strip__stats">${stats_html(doc)}</span>
				<span class="wa-strip__actions"></span>
			</div>
			<p class="wa-strip__foot" aria-live="polite" dir="auto"></p>
		</div>`);

	const $actions = $strip.find(".wa-strip__actions");
	if (is_manager()) {
		const label = paused ? __("Resume") : __("Pause");
		$(`<button type="button" class="btn btn-default btn-sm">${esc(label)}</button>`)
			.on("click", () => (paused ? resume_campaign(row, header) : pause_campaign(row, doc, header)))
			.appendTo($actions);
	}
	$(`<button type="button" class="btn btn-primary btn-sm">${esc(__("Outbound log"))}</button>`)
		.on("click", () => frappe.set_route("List", "WhatsApp Log", { campaign: row.name }))
		.appendTo($actions);

	$strip.find(".wa-strip__foot").text(eta_text(doc, null));
	sanad.ui
		.call("campaigns.get_progress", { name: row.name }, { silent: true })
		.then((p) => $strip.find(".wa-strip__foot").text(eta_text(doc, p)))
		.catch(() => {});
	return $strip;
}

/** A campaign waiting for its hour, as the prototype draws it. */
function scheduled_strip(row, header) {
	const when = row.scheduled_at ? `${frappe.datetime.str_to_user(row.scheduled_at).slice(0, 10)} ${row.scheduled_at.slice(11, 16)}` : "—";
	const days = row.scheduled_at ? frappe.datetime.get_day_diff(row.scheduled_at, frappe.datetime.now_datetime()) : null;
	const relative =
		days == null
			? ""
			: days < 0
				? __("the time has passed — waiting to resume")
				: days === 0
					? __("today")
					: days === 1
						? __("tomorrow")
						: __("in {0} days", [fmt_int(days)]);
	const meta = [
		relative,
		sanad.ui.plural(cint(row.total_recipients), { one: __("{0} recipient"), other: __("{0} recipients") }),
		device_title(row.device),
		cint(row.pause_count) ? __("edited {0} times", [fmt_int(row.pause_count)]) : "",
	]
		.filter(Boolean)
		.join(" · ");

	const $strip = $(`
		<div class="wa-strip wa-strip--scheduled">
			<div class="wa-strip__line">
				<span class="wa-strip__title">
					<span class="wa-strip__dot" aria-hidden="true"></span>
					<a class="wa-strip__name" href="/app/whatsapp-campaign/${encodeURIComponent(row.name)}">${esc(row.campaign_name || row.name)}</a>
					<span class="wa-strip__badge">${esc(__("Scheduled"))}</span>
				</span>
				<span class="wa-strip__when sanad-tabular">${esc(when)}</span>
				<span class="wa-strip__meta">${esc(meta)}</span>
				<span class="wa-strip__actions"></span>
			</div>
		</div>`);

	const $actions = $strip.find(".wa-strip__actions");
	if (is_manager()) {
		$(`<button type="button" class="btn btn-default btn-sm">${esc(__("Stop to edit"))}</button>`)
			.on("click", () => stop_to_edit(row, () => refresh_all(header)))
			.appendTo($actions);
	}
	$(`<button type="button" class="btn btn-default btn-sm wa-strip__btn-blue">${esc(__("Scheduled messages"))}</button>`)
		.on("click", () => frappe.set_route("List", "WhatsApp Log", { campaign: row.name }))
		.appendTo($actions);
	return $strip;
}

/** A device shows by its own name; Frappe caches the link title after the list has fetched it. */
function device_title(name) {
	if (!name) return "";
	const title = frappe.utils.get_link_title && frappe.utils.get_link_title("WhatsApp Device", name);
	return title || name;
}

/** `get_sending_now` returns live counters beside the campaign's own fields. */
function counters_as_doc(row) {
	const c = row.counters || {};
	return {
		total_recipients: cint(row.total_recipients) || cint(c.total),
		sent_count: cint(c.sent),
		delivered_count: cint(c.delivered),
		read_count: cint(c.read),
		failed_count: cint(c.failed) || cint(row.failed_count),
		messages_per_minute: row.messages_per_minute,
		device: row.device,
	};
}

function pause_campaign(row, doc, header) {
	const remaining = Math.max(0, cint(doc.total_recipients) - handed_of_doc(doc) - cint(doc.failed_count));
	sanad.ui.ConfirmDialog.ask({
		title: __("Pause {0}?", [row.campaign_name || row.name]),
		message: __("Nothing is deleted. Unsent messages stay saved and sending resumes from the same point."),
		impact: [{ label: __("Messages that will stop"), value: fmt_int(remaining) }],
		reason_field: { label: __("Reason"), required: false },
		confirm_label: __("Pause"),
		on_confirm: ({ reason }) => sanad.ui.call("campaigns.pause", { name: row.name, reason: reason || null }),
	})
		.then(() => {
			sanad.ui.Toast.success(__("Campaign paused"));
			refresh_all(header);
		})
		.catch(() => {});
}

function resume_campaign(row, header) {
	return sanad.ui
		.call("campaigns.resume", { name: row.name })
		.then(() => {
			sanad.ui.Toast.success(__("Campaign resumed"));
			refresh_all(header);
		})
		.catch((err) => sanad.ui.Toast.error(err));
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
			// `Paused` is stated by the metric row ("2 paused"); the strips are for what moves
			const live = (rows || []).filter((r) => ["Running", "Queued"].includes(r.status));
			$el.html(`<section class="wa-ops">${metrics_html(o)}</section>
				<div class="wa-strips"></div>`);
			$el.find("[data-go=failed]").on("click", () => frappe.set_route("List", "WhatsApp Log", { status: "Failed" }));

			// The console must not eat the table. The prototype shows the campaign that is sending
			// and the next scheduled ones — not one strip per campaign in flight — so at most two
			// live strips are drawn and the rest are counted in a line (owner: five strips pushed
			// the table down to two clipped rows, 2026-09-24).
			const $strips = $el.find(".wa-strips").data("header", header);
			const shown = live.slice(0, LIVE_STRIPS);
			shown.forEach((row) => $strips.append(live_strip(row, header)));
			if (live.length > shown.length) {
				$strips.append(
					`<p class="wa-strips__more">${esc(
						sanad.ui.plural(live.length - shown.length, {
							one: __("{0} more campaign is sending — it is in the list below."),
							other: __("{0} more campaigns are sending — they are in the list below."),
						})
					)}</p>`
				);
			}
			return render_next($strips, shown.length);
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

/** The campaigns waiting for their hour — the prototype shows up to three, then counts the rest. */
function render_next($strips, live_count) {
	const LIMIT = Math.max(1, STRIP_BUDGET - live_count);
	return Promise.all([
		frappe.db.get_list("WhatsApp Campaign", {
			filters: { status: "Scheduled" },
			fields: ["name", "campaign_name", "status", "scheduled_at", "total_recipients", "device", "pause_count"],
			order_by: "scheduled_at asc",
			limit: LIMIT,
		}),
		frappe.db.count("WhatsApp Campaign", { filters: { status: "Scheduled" } }),
	])
		.then(([rows, total]) => {
			(rows || []).forEach((row) => $strips.append(scheduled_strip(row, $strips.data("header"))));
			const rest = cint(total) - (rows || []).length;
			if (rest > 0) {
				$strips.append(
					`<p class="wa-strips__more">${esc(
						sanad.ui.plural(rest, {
							one: __("{0} more scheduled campaign in the list below."),
							other: __("{0} more scheduled campaigns in the list below."),
						})
					)}</p>`
				);
			}
		})
		.catch(() => {});
}

function refresh_all(header) {
	overview(true);
	header.refresh(true);
	header.listview && header.listview.refresh();
}

// ---- list settings -----------------------------------------------------------------------

frappe.listview_settings["WhatsApp Campaign"] = {
	add_fields: [
		"campaign_name", "status", "owner", "device", "scheduled_at", "messages_per_minute",
		"total_recipients", "initial_recipients", "pause_count", "queued_count",
		"sent_count", "delivered_count", "read_count", "failed_count", "cancelled_count",
		"first_message_at", "last_message_at", "started_at", "ended_at", "creation",
	],
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
				actions: ["group_by", "columns", "export"],
				presets: [
					{ fieldname: "campaign_name", type: "search", fields: ["campaign_name", "owner"], placeholder: __("Campaign or owner name…") },
					{ fieldname: "status", type: "select" },
					{ fieldname: "device", type: "select" },
					{ fieldname: "owner", type: "select", label: __("Owner") },
					// the same date control as Inbound and Outbound — operators, presets and a range
					// calendar — not a bare input
					{
						fieldname: "started_at",
						type: "date",
						label: __("Start"),
						default_op: "between",
						date_fields: ["started_at", "scheduled_at", "creation", "first_message_at", "last_message_at"],
					},
				],
			});
		}

		// ---- the table: every column the prototype draws (09 §1C row 6) ------------------------

		const dt = (v) => (v ? esc(whatsapp_next.fmt.dt(v)) : dash());
		const dash = () => `<span class="text-muted">—</span>`;
		const num = (v) => `<span class="sanad-tabular">${esc(fmt_int(v))}</span>`;
		const rate_cell = (part, whole, tone) =>
			cint(whole) ? `<span class="sanad-tabular${tone ? ` sanad-tone--${tone}` : ""}">${esc(pct(part, whole))}</span>` : dash();

		/** How long a campaign needs at its own rate, and how long it actually took. */
		const est_minutes = (doc) => {
			const rate = cint(doc.messages_per_minute) || cint(frappe.boot.sanad_rate) || 20;
			return cint(doc.total_recipients) / Math.max(rate, 1);
		};
		const act_minutes = (doc) => {
			if (!doc.started_at) return null;
			const end = doc.ended_at ? frappe.datetime.str_to_obj(doc.ended_at) : ["Running", "Paused", "Queued"].includes(doc.status) ? new Date() : null;
			if (!end) return null;
			return Math.max(0, (end - frappe.datetime.str_to_obj(doc.started_at)) / 60000);
		};
		const dur_text = (minutes) =>
			minutes < 60
				? __("{0} min", [fmt_int(Math.round(minutes))])
				: __("{0} h {1} min", [fmt_int(Math.floor(minutes / 60)), fmt_int(Math.round(minutes % 60))]);

		const columns = [
			{ fieldname: "campaign_name", label: __("Campaign"), width: 240, sortable: true, format: (v, doc) => esc(v || doc.name), sub: (doc) => esc(frappe.user.full_name(doc.owner) || doc.owner || "") },
			{ fieldname: "status", label: __("Status"), type: "status", width: 120, sortable: true },
			{ fieldname: "_edit", label: __("Edit"), width: 104, sortable: false, format: (v, doc) => edit_chip(doc) },
			{ fieldname: "sent_count", label: __("Progress"), width: 170, sortable: false, format: (v, doc) => progress_html(doc, { tone: doc.status === "Paused" ? "amber" : "" }) },
			{ fieldname: "total_recipients", label: __("Recipients"), type: "number", width: 110, align: "end", sortable: true },
			{ fieldname: "_handed", label: __("Sent"), width: 100, align: "end", sortable: false, format: (v, doc) => num(handed_of_doc(doc)) },
			{ fieldname: "_ok_rate", label: __("Success %"), width: 110, align: "end", sortable: false, format: (v, doc) => rate_cell(handed_of_doc(doc), handed_of_doc(doc) + cint(doc.failed_count), "green") },
			{ fieldname: "read_count", label: __("Read"), type: "number", width: 100, align: "end", sortable: true },
			{ fieldname: "_read_rate", label: __("Read %"), width: 115, align: "end", sortable: false, format: (v, doc) => rate_cell(doc.read_count, cint(doc.delivered_count) + cint(doc.read_count), "blue") },
			{ fieldname: "failed_count", label: __("Failures"), type: "number", width: 90, align: "end", sortable: true, format: (v) => (cint(v) ? `<span class="sanad-tone--red sanad-tabular">${fmt_int(v)}</span>` : num(0)) },
			{ fieldname: "_fail_rate", label: __("Failure %"), width: 110, align: "end", sortable: false, format: (v, doc) => rate_cell(doc.failed_count, handed_of_doc(doc) + cint(doc.failed_count), cint(doc.failed_count) ? "red" : "") },
			{ fieldname: "device", label: __("Device"), type: "avatar", width: 150, sortable: true },
			{ fieldname: "_start_kind", label: __("Start type"), width: 110, sortable: false, format: (v, doc) => sanad.ui.StatusBadge.html({ label: doc.scheduled_at ? __("Scheduled") : __("Immediate"), colour: doc.scheduled_at ? "blue" : "gray" }) },
			{ fieldname: "scheduled_at", label: __("Scheduled for"), width: 150, align: "end", sortable: true, format: (v) => (v ? dt(v) : `<span class="text-muted">${esc(__("Immediate"))}</span>`) },
			{ fieldname: "creation", label: __("Created"), width: 150, align: "end", sortable: true, format: (v) => dt(v) },
			{ fieldname: "started_at", label: __("Started"), width: 150, align: "end", sortable: true, format: (v) => dt(v) },
			{ fieldname: "_edited", label: __("Edited after approval"), width: 145, sortable: false, format: (v, doc) => (cint(doc.pause_count) ? sanad.ui.StatusBadge.html({ label: sanad.ui.plural(cint(doc.pause_count), { one: __("Yes — once"), other: __("Yes — {0} times") }), colour: "orange" }) : sanad.ui.StatusBadge.html({ label: __("No"), colour: "gray" })) },
			{ fieldname: "initial_recipients", label: __("Recipients at start"), type: "number", width: 140, align: "end", sortable: true, format: (v) => (cint(v) ? num(v) : dash()) },
			{ fieldname: "_edit_pct", label: __("Change %"), width: 110, align: "end", sortable: false, format: (v, doc) => {
				const start = cint(doc.initial_recipients);
				if (!start || start === cint(doc.total_recipients)) return dash();
				const change = ((cint(doc.total_recipients) - start) * 100) / start;
				return `<span class="sanad-tabular sanad-tone--${change < 0 ? "red" : "green"}">${change < 0 ? "−" : "+"}${esc(pct(Math.abs(change), 100))}</span>`;
			} },
			{ fieldname: "first_message_at", label: __("First message"), width: 150, align: "end", sortable: true, format: (v) => dt(v) },
			{ fieldname: "last_message_at", label: __("Last message"), width: 150, align: "end", sortable: true, format: (v) => dt(v) },
			{ fieldname: "_est_dur", label: __("Estimated time"), width: 120, align: "end", sortable: false, format: (v, doc) => (cint(doc.total_recipients) ? `<span class="sanad-tabular">${esc(dur_text(est_minutes(doc)))}</span>` : dash()) },
			{ fieldname: "_act_dur", label: __("Actual time"), width: 120, align: "end", sortable: false, format: (v, doc) => {
				const minutes = act_minutes(doc);
				return minutes == null ? dash() : `<span class="sanad-tabular">${esc(dur_text(minutes))}</span>`;
			} },
			{ fieldname: "_dur_diff", label: __("Time difference"), width: 115, align: "end", sortable: false, format: (v, doc) => {
				const actual = act_minutes(doc);
				if (actual == null || !doc.ended_at || !cint(doc.total_recipients)) return dash();
				const diff = actual - est_minutes(doc);
				const tone = diff > 1 ? "red" : diff < -1 ? "green" : "";
				return `<span class="sanad-tabular${tone ? ` sanad-tone--${tone}` : ""}">${diff >= 0 ? "+" : "−"}${esc(dur_text(Math.abs(diff)))}</span>`;
			} },
		];

		if (typeof ui.DataList === "function") {
			listview.sanad_datalist = new ui.DataList({
				listview,
				columns,
				selectable: true,
				groupable: true,
				pinnable: true,
				row_action: { label: __("View"), handler: (doc) => frappe.set_route("Form", "WhatsApp Campaign", doc.name) },
				on_row_click: (doc) => frappe.set_route("Form", "WhatsApp Campaign", doc.name),
				page_length: 50,
				mobile_columns: ["campaign_name", "status", "sent_count"],
				footer: {
					count: (total) => sanad.ui.plural(total, { one: __("{0} campaign"), two: __("{0} campaigns"), few: __("{0} campaigns"), many: __("{0} campaigns"), other: __("{0} campaigns") }),
					// the prototype totals the recipients of what is on screen
					extra: ($el, rows) =>
						$el.text(
							__("{0} recipients on this page", [
								fmt_int((rows || []).reduce((n, d) => n + cint(d.total_recipients), 0)),
							])
						),
				},
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

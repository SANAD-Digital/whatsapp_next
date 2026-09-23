// Campaign screens — everything the Campaigns list console and the campaign form say about one
// campaign: how far it got (the prototype's four-segment funnel bar), the counters it is judged by,
// the sentence that says when it ends, and the verbs that change its state with the confirmation
// each of them owes the reader.
//
// It is part of the app bundle, so it is loaded on every Desk route: the list and the form call
// the same functions, and a campaign therefore reads the same on both screens — one bar, one set
// of counters, one wording for "pause", wherever the reader meets it.

frappe.provide("whatsapp_next.campaigns");

(function () {
	const ui = sanad.ui;
	const C = whatsapp_next.campaigns;
	const esc = (v) => ui.escape(v);
	const fmt_int = (v) => ui.format_int(v);

	C.DOCTYPE = "WhatsApp Campaign";
	/** Ended: nothing can change any more. */
	C.TERMINAL = ["Completed", "Partially Failed", "Cancelled"];
	/** In flight: editing means stopping first. */
	C.STOPPABLE = ["Scheduled", "Queued", "Running"];
	/** Open for editing. */
	C.EDITABLE = ["Draft", "Paused"];
	C.INDICATOR = {
		Draft: "gray",
		Scheduled: "blue",
		Queued: "blue",
		Running: "green",
		Paused: "orange",
		Completed: "green",
		"Partially Failed": "orange",
		Cancelled: "red",
	};

	C.is_manager = () => frappe.user.has_role("WhatsApp Manager") || frappe.user.has_role("System Manager");

	// ---- reading a campaign -----------------------------------------------------------------

	C.share = (part, whole) => (cint(whole) ? Math.round((cint(part) * 100) / cint(whole)) : null);

	C.pct_text = (part, whole) => {
		const value = C.share(part, whole);
		return value == null ? "—" : `${fmt_int(value)}%`;
	};

	/**
	 * What has left the campaign. `Sent`, `Delivered` and `Read` are three stages of the same fact,
	 * so progress that counts only `Sent` shows 3 % for a campaign that has handed over a third.
	 */
	C.handed_of = (row) => cint(row.sent) + cint(row.delivered) + cint(row.read);

	/** The same rule over a campaign document, whose counters are the four disjoint fields. */
	C.handed_of_doc = (doc) => cint(doc.sent_count) + cint(doc.delivered_count) + cint(doc.read_count);

	/** What is still to go out: the recipients that have neither left, failed nor been cancelled. */
	C.remaining_of_doc = (doc) =>
		Math.max(0, cint(doc.total_recipients) - C.handed_of_doc(doc) - cint(doc.failed_count) - cint(doc.cancelled_count));

	/** A device shows by its own name; Frappe caches the link title after a list has fetched it. */
	C.device_title = (name) => {
		if (!name) return "";
		const title = frappe.utils.get_link_title && frappe.utils.get_link_title("WhatsApp Device", name);
		return title || name;
	};

	/** `get_sending_now` returns live counters beside the campaign's own fields. */
	C.counters_as_doc = (row) => {
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
	};

	C.badge = (doc) =>
		ui.StatusBadge.html({
			label: __(doc.status),
			colour: ui.indicator_for(C.DOCTYPE, Object.assign({ doctype: C.DOCTYPE }, doc)).colour,
		});

	// ---- drawing a campaign -----------------------------------------------------------------

	/**
	 * The prototype's four-segment bar (`docs/screen/Hub Screen - Campaigns.dc.html`): read, then
	 * delivered, then sent-but-not-yet-delivered, then failed — each as a share of the recipients,
	 * so the bar is the campaign's funnel and the empty tail is what has not gone out yet.
	 */
	C.bar_html = (doc, { paused } = {}) => {
		const total = Math.max(cint(doc.total_recipients), 1);
		const w = (n) => `${Math.max(0, (cint(n) * 100) / total).toFixed(2)}%`;
		return `<span class="wa-strip__bar${paused ? " wa-strip__bar--paused" : ""}" role="img"
				aria-label="${esc(__("{0} sent, {1} delivered, {2} read, {3} failed, of {4} recipients", [
					fmt_int(C.handed_of_doc(doc)), fmt_int(doc.delivered_count), fmt_int(doc.read_count), fmt_int(doc.failed_count), fmt_int(doc.total_recipients),
				]))}">
			<span class="wa-strip__seg wa-strip__seg--read" style="inline-size:${w(doc.read_count)}"></span>
			<span class="wa-strip__seg wa-strip__seg--delivered" style="inline-size:${w(doc.delivered_count)}"></span>
			<span class="wa-strip__seg wa-strip__seg--sent" style="inline-size:${w(doc.sent_count)}"></span>
			<span class="wa-strip__seg wa-strip__seg--failed" style="inline-size:${w(doc.failed_count)}"></span>
		</span>`;
	};

	/** The same bar inside a table cell, with the prototype's "sent / recipients" label above it. */
	C.progress_html = (doc, { tone } = {}) => {
		if (!cint(doc.total_recipients)) return `<span class="text-muted">—</span>`;
		return `<span class="wa-strip__cell">
			<span class="wa-strip__cell-label sanad-tabular">${esc(fmt_int(C.handed_of_doc(doc)))} / ${esc(fmt_int(doc.total_recipients))}</span>
			${C.bar_html(doc, { paused: tone === "amber" })}
		</span>`;
	};

	/** The counters the prototype prints beside the bar: label above the number, four of them. */
	C.stats_html = (doc) =>
		[
			{ label: __("Sent"), value: C.handed_of_doc(doc) },
			{ label: __("Delivered"), value: cint(doc.delivered_count) + cint(doc.read_count) },
			{ label: __("Read"), value: cint(doc.read_count), tone: "green" },
			{ label: __("Failed"), value: cint(doc.failed_count), tone: cint(doc.failed_count) ? "red" : "" },
		]
			.map(
				(s) => `<span class="wa-strip__stat">
					<span class="wa-strip__stat-label">${esc(s.label)}</span>
					<span class="wa-strip__stat-value sanad-tabular${s.tone ? ` sanad-tone--${s.tone}` : ""}">${esc(fmt_int(s.value))}</span>
				</span>`
			)
			.join("");

	/** "N messages left — about 12 min at 20/min from device X." */
	C.eta_text = (doc, progress) => {
		const rates = (progress && progress.rates) || {};
		const counters = (progress && progress.counters) || {};
		// `open` counts the outbound rows already created and still moving; the recipients that have
		// not been enqueued yet are not among them, so the campaign's own arithmetic decides when it
		// says more is left than the queue currently holds
		const remaining = Math.max(cint(counters.open), C.remaining_of_doc(doc));
		const rate = cint(rates.messages_per_minute) || cint(doc.messages_per_minute) || 20;
		if (!remaining) return __("Everything has been handed to the queue.");
		const minutes = remaining / Math.max(rate, 1);
		return __("{0} left — about {1} at {2}/min from device {3}.", [
			ui.plural(remaining, { one: __("{0} message"), other: __("{0} messages") }),
			minutes < 60 ? __("{0} min", [fmt_int(Math.round(minutes))]) : __("{0} h", [fmt_int(Math.round(minutes / 60))]),
			fmt_int(rate),
			C.device_title(doc.device) || "—",
		]);
	};

	// ---- changing a campaign ------------------------------------------------------------------
	// One wording per verb, wherever it is pressed. Each returns a promise that resolves when the
	// campaign has changed (and never rejects on a cancelled dialog — the reader said no).

	function run(method, args, { success, after }) {
		return ui
			.call(method, args)
			.then((r) => {
				if (success) ui.Toast.success(success);
				after && after(r);
				return r;
			})
			.catch((err) => {
				ui.Toast.error(err);
				return Promise.reject(err);
			});
	}

	function ask(opts, method, doc, { after, args } = {}) {
		return ui.ConfirmDialog
			.ask(
				Object.assign({}, opts, {
					on_confirm: ({ reason }) =>
						ui.call(method, Object.assign({ name: doc.name }, args || {}, opts.reason_field ? { reason: reason || null } : {})),
				})
			)
			.then((r) => {
				if (opts.success) ui.Toast.success(opts.success);
				after && after(r);
				return r;
			})
			.catch(() => {});
	}

	const title_of = (doc) => doc.campaign_name || doc.name;

	/** Start now. The impact is what it will cost: recipients × messages. */
	C.start = (doc, { after, messages = 1 } = {}) =>
		ask(
			{
				title: __("Start {0} now?", [title_of(doc)]),
				message: __("Messages are handed to the queue and go out at the campaign's rate."),
				impact: [
					{ label: __("Recipients"), value: fmt_int(doc.total_recipients) },
					{ label: __("Messages per recipient"), value: fmt_int(messages) },
					{ label: __("Messages in total"), value: fmt_int(cint(doc.total_recipients) * cint(messages)) },
				],
				confirm_label: __("Start"),
				success: __("Campaign started"),
			},
			"campaigns.start",
			doc,
			{ after }
		);

	/** Give it an hour. */
	C.schedule = (doc, { after } = {}) =>
		new Promise((resolve) => {
			const d = new frappe.ui.Dialog({
				title: __("Schedule {0}", [title_of(doc)]),
				fields: [
					{
						fieldtype: "Datetime",
						fieldname: "scheduled_at",
						label: __("Start at"),
						reqd: 1,
						default: doc.scheduled_at || frappe.datetime.add_days(frappe.datetime.now_datetime(), 1),
						description: __("The campaign starts by itself at this time."),
					},
				],
				primary_action_label: __("Schedule"),
				primary_action: ({ scheduled_at }) =>
					run("campaigns.schedule", { name: doc.name, scheduled_at }, { success: __("Campaign scheduled"), after })
						.then((r) => {
							d.hide();
							resolve(r);
						})
						.catch(() => {}),
			});
			d.show();
		});

	C.unschedule = (doc, { after } = {}) => run("campaigns.unschedule", { name: doc.name }, { success: __("Schedule removed"), after });

	/** Pause. Nothing is lost — that is the first thing the dialog says. */
	C.pause = (doc, { after } = {}) =>
		ask(
			{
				title: __("Pause {0}?", [title_of(doc)]),
				message: __("Nothing is deleted. Unsent messages stay saved and sending resumes from the same point."),
				impact: [{ label: __("Messages that will stop"), value: fmt_int(C.remaining_of_doc(doc)) }],
				reason_field: { label: __("Reason"), required: false },
				confirm_label: __("Pause"),
				success: __("Campaign paused"),
			},
			"campaigns.pause",
			doc,
			{ after }
		);

	C.resume = (doc, { after } = {}) =>
		ask(
			{
				title: __("Resume {0}?", [title_of(doc)]),
				impact: [{ label: __("Messages that will be sent"), value: fmt_int(C.remaining_of_doc(doc)) }],
				confirm_label: __("Resume"),
				success: __("Campaign resumed"),
			},
			"campaigns.resume",
			doc,
			{ after }
		);

	/** Stop it in order to change it, then open the campaign. */
	C.stop_to_edit = (doc, { after } = {}) =>
		ask(
			{
				title: __("Stop {0} to edit it?", [title_of(doc)]),
				message: __("Nothing is deleted. Unsent messages stay saved and sending resumes from the same point."),
				impact: [{ label: __("Messages that will stop"), value: fmt_int(C.remaining_of_doc(doc)) }],
				reason_field: { label: __("Reason"), required: false },
				confirm_label: __("Stop and edit"),
				success: __("Campaign paused"),
			},
			"campaigns.pause",
			doc,
			{
				after: () => {
					after && after();
					frappe.set_route("Form", C.DOCTYPE, doc.name);
				},
			}
		);

	/** Cancel: the one verb that cannot be undone, so it asks for a reason and an acknowledgement. */
	C.cancel = (doc, { after } = {}) =>
		ask(
			{
				title: __("Cancel {0}?", [title_of(doc)]),
				impact: [{ label: __("Messages that will not be sent"), value: fmt_int(C.remaining_of_doc(doc)), tone: "red" }],
				reason_field: { label: __("Reason"), required: true },
				ack_checkbox: __("I understand the remaining messages will not be sent."),
				danger: true,
				confirm_label: __("Cancel campaign"),
				success: __("Campaign cancelled"),
			},
			"campaigns.cancel",
			doc,
			{ after }
		);

	/**
	 * The verbs a campaign offers in its current state, as button specs
	 * (`{key, label, tone, run}`) — the list strip and the form console render the same set, so a
	 * campaign never offers a verb on one screen and hides it on the other.
	 */
	C.verbs = (doc, { after, messages = 1 } = {}) => {
		if (!C.is_manager()) return [];
		const s = doc.status;
		const out = [];
		if (C.EDITABLE.includes(s)) out.push({ key: "start", label: __("Start"), tone: "primary", run: () => C.start(doc, { after, messages }) });
		if (s === "Draft") out.push({ key: "schedule", label: __("Schedule"), run: () => C.schedule(doc, { after }) });
		if (s === "Scheduled") out.push({ key: "unschedule", label: __("Unschedule"), run: () => C.unschedule(doc, { after }) });
		if (["Running", "Queued"].includes(s)) out.push({ key: "pause", label: __("Pause"), run: () => C.pause(doc, { after }) });
		if (s === "Paused") out.push({ key: "resume", label: __("Resume"), tone: "primary", run: () => C.resume(doc, { after }) });
		if (!C.TERMINAL.includes(s)) out.push({ key: "cancel", label: __("Cancel campaign"), tone: "danger", run: () => C.cancel(doc, { after }) });
		return out;
	};
})();

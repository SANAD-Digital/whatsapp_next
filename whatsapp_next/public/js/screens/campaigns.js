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
	/** What `campaign_runner.start` accepts (a paused campaign resumes, it does not start). */
	C.STARTABLE = ["Draft", "Scheduled"];
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

	/**
	 * Every message the campaign has, in any state: one per recipient × message, all created when it
	 * starts. The counters count messages, so their denominator is this, never the recipients — a
	 * campaign of three messages to three people is "9 / 9" when done, not "9 / 3". 0 before start.
	 */
	C.messages_of_doc = (doc) =>
		cint(doc.queued_count) + C.handed_of_doc(doc) + cint(doc.failed_count) + cint(doc.cancelled_count);

	/** What is still to go out: the messages that have neither left, failed nor been cancelled
	 * (before the messages exist, the recipients not reached yet). */
	C.remaining_of_doc = (doc) =>
		C.messages_of_doc(doc)
			? cint(doc.queued_count)
			: Math.max(0, cint(doc.total_recipients) - C.handed_of_doc(doc) - cint(doc.failed_count) - cint(doc.cancelled_count));

	/** "sent / messages", kept left to right inside an Arabic line ("9 / 3" must not read "3 / 9"). */
	C.progress_text = (doc) => `\u2066${fmt_int(C.handed_of_doc(doc))} / ${fmt_int(C.messages_of_doc(doc))}\u2069`;

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
			queued_count: cint(c.queued),
			sent_count: cint(c.sent),
			delivered_count: cint(c.delivered),
			read_count: cint(c.read),
			failed_count: cint(c.failed) || cint(row.failed_count),
			cancelled_count: cint(c.cancelled),
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
	 * delivered, then sent-but-not-yet-delivered, then failed — each as a share of the messages,
	 * so the bar is the campaign's funnel and the empty tail is what has not gone out yet.
	 */
	C.bar_html = (doc, { paused } = {}) => {
		const total = Math.max(C.messages_of_doc(doc), 1);
		const w = (n) => `${Math.max(0, (cint(n) * 100) / total).toFixed(2)}%`;
		return `<span class="wa-strip__bar${paused ? " wa-strip__bar--paused" : ""}" role="img"
				aria-label="${esc(__("{0} sent, {1} delivered, {2} read, {3} failed, of {4} messages", [
					fmt_int(C.handed_of_doc(doc)), fmt_int(doc.delivered_count), fmt_int(doc.read_count), fmt_int(doc.failed_count), fmt_int(C.messages_of_doc(doc)),
				]))}">
			<span class="wa-strip__seg wa-strip__seg--read" style="inline-size:${w(doc.read_count)}"></span>
			<span class="wa-strip__seg wa-strip__seg--delivered" style="inline-size:${w(doc.delivered_count)}"></span>
			<span class="wa-strip__seg wa-strip__seg--sent" style="inline-size:${w(doc.sent_count)}"></span>
			<span class="wa-strip__seg wa-strip__seg--failed" style="inline-size:${w(doc.failed_count)}"></span>
		</span>`;
	};

	/** The same bar inside a table cell, with a "sent / messages" label above it. */
	C.progress_html = (doc, { tone } = {}) => {
		if (!C.messages_of_doc(doc)) return `<span class="text-muted">—</span>`;
		return `<span class="wa-strip__cell" title="${esc(__("Messages sent out of all the campaign's messages"))}">
			<span class="wa-strip__cell-label sanad-tabular">${esc(C.progress_text(doc))}</span>
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
		// whole minutes, rounded up: 3 messages at 20/min are "about 1 min", never "about 0 min",
		// and 90 minutes are "1 h 30 min", not "2 h"
		const minutes = Math.max(1, Math.ceil(remaining / Math.max(rate, 1)));
		const hours = Math.floor(minutes / 60);
		return __("{0} left — about {1} at {2}/min from device {3}.", [
			ui.plural(remaining, { one: __("{0} message"), other: __("{0} messages") }),
			minutes < 60
				? __("{0} min", [fmt_int(minutes)])
				: minutes % 60
					? __("{0} h {1} min", [fmt_int(hours), fmt_int(minutes % 60)])
					: __("{0} h", [fmt_int(hours)]),
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
						// the control holds system time and shows it in the reader's zone: a default
						// built from the reader's clock would land hours off when the two differ
						// (`frappe.datetime.add_days` returns a date: the default was midnight, shown without a time)
						default: doc.scheduled_at || moment(frappe.datetime.system_datetime()).add(1, "days").seconds(0).format("YYYY-MM-DD HH:mm:ss"),
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

	/** Stop it in order to change it, then open the campaign. A scheduled campaign is stopped by
	 * dropping its schedule (it goes back to Draft) — `pause` refuses anything that is not sending. */
	C.stop_to_edit = (doc, { after } = {}) =>
		doc.status === "Scheduled"
			? ask(
				{
					title: __("Stop {0} to edit it?", [title_of(doc)]),
					message: __("The schedule is removed and the campaign goes back to draft. Schedule or start it again when you are done."),
					confirm_label: __("Stop and edit"),
					success: __("Schedule removed"),
				},
				"campaigns.unschedule",
				doc,
				{
					after: () => {
						after && after();
						frappe.set_route("Form", C.DOCTYPE, doc.name);
					},
				}
			)
			: ask(
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
		if (C.STARTABLE.includes(s)) out.push({ key: "start", label: __("Start"), tone: "primary", run: () => C.start(doc, { after, messages }) });
		if (s === "Draft") out.push({ key: "schedule", label: __("Schedule"), run: () => C.schedule(doc, { after }) });
		if (s === "Scheduled") out.push({ key: "unschedule", label: __("Unschedule"), run: () => C.unschedule(doc, { after }) });
		if (["Running", "Queued"].includes(s)) out.push({ key: "pause", label: __("Pause"), run: () => C.pause(doc, { after }) });
		if (s === "Paused") out.push({ key: "resume", label: __("Resume"), tone: "primary", run: () => C.resume(doc, { after }) });
		if (!C.TERMINAL.includes(s)) out.push({ key: "cancel", label: __("Cancel campaign"), tone: "danger", run: () => C.cancel(doc, { after }) });
		return out;
	};
})();

// WhatsApp Queue Item list — screen 9 (09 §1B/§1C row 9, D-064 prototype anatomy). What is only
// this screen's lives here: the PageHeader (Pause / Resume sending with a ConfirmDialog fed by
// `queue.get_summary`, the paused / running banner, the KPIs In queue now · Expected drain time ·
// Charged from plan, and the send-rate slider → `queue.set_rate`), the row enrichment with the
// linked outbound's document, and the bulk verbs over `queue.*_items` / `retry_dead_letter`.
// The toolbar and the table come from the shared message-list scaffold, so this screen carries the
// same search · filters · date filter · grouping · columns · export as Outbound and Inbound; a row
// opens the linked message's drawer, which also carries this queue's own Pause / Resume / Retry.

(function () {
	const ui = sanad.ui;
	const DT = "WhatsApp Queue Item";
	const MANAGER_ROLES = ["WhatsApp Manager", "System Manager"];
	const LIVE = ["Queued", "Sending", "Paused"];
	const RATE_MIN = 5;
	const RATE_MAX = 60;
	const RECOMMENDED = { low: 12, high: 35 }; // prototype: < 12 slow and safe · > 35 high ban risk

	const is_manager = () => frappe.user.has_role(MANAGER_ROLES);
	const count_of = (docs, statuses) => docs.filter((d) => statuses.includes(d.status)).length;
	const fmt_dt = whatsapp_next.fmt.dt;

	const run = (method, args, message, after) =>
		ui.call(method, args)
			.then((r) => {
				ui.Toast.success(typeof message === "function" ? message(r) : message);
				after && after(r);
				return r;
			})
			.catch((err) => {
				if (err && err.message !== "cancelled") ui.Toast.error(err);
			});

	/** The queue's own verbs on one row, shown inside the message drawer the row opens. */
	const queue_actions = (doc, refresh) => [
		{ label: __("Pause"), icon: "es-line-time", condition: () => is_manager() && doc.status === "Queued", handler: () => run("queue.pause_items", { names: [doc.name] }, __("Message paused"), refresh) },
		{ label: __("Resume"), icon: "es-line-zap", condition: () => is_manager() && doc.status === "Paused", handler: () => run("queue.resume_items", { names: [doc.name] }, __("Message resumed"), refresh) },
		{ label: __("Retry"), icon: ui.icons.resend, condition: () => is_manager() && doc.status === "Dead Letter", handler: () => run("queue.retry_dead_letter", { names: [doc.name] }, __("Message re-queued"), refresh) },
	];

	const open_drawer = (doc, refresh, listview) => {
		if (!doc.outbound_message) {
			ui.Toast.info(__("This queue item has no message linked to it."));
			return;
		}
		return whatsapp_next.messages.open_outbound_drawer(doc.outbound_message, { after_change: refresh, listview, extra_actions: queue_actions(doc, refresh) });
	};

	// ---- queue summary (one in-flight call per refresh cycle, shared by banner / block / dialogs) --

	const state = { summary: null, promise: null, listview: null, at: 0 };
	const SUMMARY_TTL = 2000; // the banner, the KPI cards and the rate block all ask on mount
	const summary = (fresh = false) => {
		if (fresh || (state.promise && Date.now() - state.at > SUMMARY_TTL)) state.promise = null;
		if (!state.promise) {
			state.at = Date.now();
			state.promise = ui.call("queue.get_summary", {}, { silent: true }).then((s) => {
				const was_paused = !!(state.summary && state.summary.paused);
				state.summary = s;
				// "Expected send" shows Paused while the queue is paused: re-render rows when that flips.
				const datalist = state.listview && state.listview._sanad_datalist;
				if (datalist && datalist.refresh && was_paused !== !!s.paused) datalist.refresh();
				return s;
			});
		}
		return state.promise;
	};
	const queued_of = (s) => cint(s && s.counts_by_status && s.counts_by_status.Queued);
	const rate_of = (s) => cint(s && s.rate) || RATE_MIN;
	const per_minute = (rate) => __("{0} / minute", [ui.format_int(rate)]);

	/** "Nothing to send" · "Less than a minute" · "18 minutes" · "1 h 20 min". */
	const eta_text = (queued, rate) => {
		if (!queued) return __("Nothing to send");
		const minutes = queued / Math.max(rate, 1);
		if (minutes < 1) return __("Less than a minute");
		if (minutes < 60) return ui.plural(Math.round(minutes), { one: __("{0} minute"), other: __("{0} minutes") });
		return __("{0} h {1} min", [ui.format_int(Math.floor(minutes / 60)), ui.format_int(Math.round(minutes % 60))]);
	};

	const rate_verdict = (rate) => {
		if (rate > RECOMMENDED.high) return { label: __("High ban risk"), tone: "red" };
		if (rate < RECOMMENDED.low) return { label: __("Slow and safe"), tone: "gray" };
		return { label: __("Within recommended"), tone: "green" };
	};

	// ---- pause / resume (ConfirmDialog impact from the summary) ---------------------------------

	const ask_pause = (after) =>
		summary(true).then((s) =>
			ui.ConfirmDialog.ask({
				title: __("Pause sending?"),
				message: __("Pausing deletes nothing. Messages keep their order and resume from the same point."),
				impact: [
					{ label: __("Messages that stop immediately"), value: ui.format_int(queued_of(s)), tone: "amber" },
					{ label: __("Current rate"), value: per_minute(rate_of(s)) },
					{ label: __("Time left to drain"), value: eta_text(queued_of(s), rate_of(s)) },
				],
				reason_field: { label: __("Reason (shown in the audit log)"), required: false, description: __("Example: avoiding a ban while testing the campaign") },
				confirm_label: __("Pause sending"),
				on_confirm: ({ reason }) => ui.call("queue.pause_queue", { reason }),
			})
				.then(() => {
					ui.Toast.success(__("Sending paused"));
					after && after();
				})
				.catch(() => {})
		);

	const ask_resume = (after) =>
		summary(true).then((s) => {
			const remaining = s.platform_queue && s.platform_queue.messages_remaining;
			const impact = [
				{ label: __("Messages sent immediately"), value: ui.format_int(queued_of(s)) },
				{ label: __("Send rate"), value: per_minute(rate_of(s)) },
				{ label: __("Charged from the plan"), value: ui.format_int(queued_of(s)), tone: "amber" },
			];
			if (remaining != null) impact.push({ label: __("Balance after sending"), value: ui.format_int(Math.max(0, cint(remaining) - queued_of(s))) });
			return ui.ConfirmDialog.ask({
				title: __("Resume sending?"),
				message: __("Resuming starts from the oldest pending message. You can pause again at any time."),
				impact,
				confirm_label: __("Resume sending"),
				on_confirm: () => ui.call("queue.resume_queue"),
			})
				.then(() => {
					ui.Toast.success(__("Sending resumed"));
					after && after();
				})
				.catch(() => {});
		});

	// ---- header pieces ------------------------------------------------------------------------

	const banner_for = (s) => {
		if (!s) return null;
		if (s.paused) {
			const since = s.paused_at ? frappe.datetime.prettyDate(s.paused_at) : "";
			const by = s.paused_by ? frappe.user.full_name(s.paused_by) : __("an administrator");
			return {
				tone: "amber",
				icon: "es-line-alert-triangle",
				text: s.reason
					? __("Sending has been paused {0} by {1}. Recorded reason: “{2}”. Nothing is sent until you resume.", [since, by, s.reason])
					: __("Sending has been paused {0} by {1}. Nothing is sent until you resume.", [since, by]),
			};
		}
		return {
			tone: "green",
			icon: "es-line-success",
			text: __("The queue is running at {0} messages per minute. Statuses below advance automatically from Sending to Sent and Delivered.", [ui.format_int(rate_of(s))]),
		};
	};

	/** The send-rate card: slider bounded by the plan rate, verdict chip, drain estimate. */
	const render_rate_block = ($el, header) => {
		summary().then((s) => {
			const rate = rate_of(s);
			const max = Math.min(RATE_MAX, cint(s.plan_rate) || RATE_MAX);
			const verdict = rate_verdict(rate);
			const id = ui.uid("wa-rate");
			$el.html(`
				<div class="sanad-kit wa-queue-rate card"><div class="card-body">
					<div class="d-flex flex-wrap justify-content-between align-items-baseline" style="gap: var(--sanad-gap-sm)">
						<h3 class="h6 mb-0" id="${id}-label">${ui.escape(__("Send rate"))}</h3>
						<span class="text-muted small">${ui.escape(__("A higher rate raises the platform's ban risk. Recommended: {0}–{1} messages per minute.", [RECOMMENDED.low + 8, RECOMMENDED.high - 5]))}</span>
					</div>
					<div class="d-flex align-items-center mt-3" style="gap: var(--sanad-gap-lg)">
						<input type="range" class="custom-range flex-grow-1" id="${id}" min="${RATE_MIN}" max="${max}" step="1" value="${rate}" aria-labelledby="${id}-label" aria-valuetext="${ui.escape(per_minute(rate))}" ${is_manager() ? "" : "disabled"}>
						<strong class="sanad-tabular wa-queue-rate__value" style="font-size: var(--text-xl, 20px); min-width: 7ch" aria-live="polite">${ui.escape(__("{0}/min", [ui.format_int(rate)]))}</strong>
						<span class="wa-queue-rate__chip">${ui.StatusBadge.html({ label: verdict.label, colour: verdict.tone, size: "md" })}</span>
					</div>
					<p class="mb-0 mt-3 wa-queue-rate__eta">${ui.escape(__("At this rate, draining the current queue takes {0}.", [eta_text(queued_of(s), rate)]))}</p>
				</div></div>`);
			const $input = $el.find(`#${id}`);
			const paint = (value) => {
				const v = rate_verdict(value);
				$el.find(".wa-queue-rate__value").text(__("{0}/min", [ui.format_int(value)]));
				$el.find(".wa-queue-rate__chip").html(ui.StatusBadge.html({ label: v.label, colour: v.tone, size: "md" }));
				$el.find(".wa-queue-rate__eta").text(__("At this rate, draining the current queue takes {0}.", [eta_text(queued_of(state.summary), value)]));
				$input.attr("aria-valuetext", per_minute(value));
			};
			$input.on("input", () => paint(cint($input.val())));
			$input.on("change", () => {
				const value = cint($input.val());
				ui.call("queue.set_rate", { messages_per_minute: value })
					.then((r) => {
						ui.Toast.success(__("Send rate set to {0}", [per_minute(r.messages_per_minute)]));
						summary(true).then(() => header && header.refresh && header.refresh(true));
					})
					.catch((err) => {
						ui.Toast.error(err);
						paint(rate);
						$input.val(rate);
					});
			});
		}).catch((err) => new ui.EmptyState({ wrapper: $el, state: "error", size: "sm", description: err.message, action: { label: __("Retry"), onclick: () => render_rate_block($el, header) } }));
	};

	const make_header = (listview) => {
		const refresh_all = () => {
			summary(true);
			header.refresh(true);
			listview.refresh();
		};
		const header = new ui.PageHeader({
			listview,
			title: __("Queue"),
			description: __("Pending messages in send order. The order changes live while sending."),
			primary: is_manager()
				? {
						label: __("Pause sending"),
						icon: "es-line-time",
						roles: MANAGER_ROLES,
						handler: () => summary().then((s) => (s.paused ? ask_resume(refresh_all) : ask_pause(refresh_all))),
				  }
				: undefined,
			stats: [
				{ key: "queued", label: __("In queue now"), icon: "es-line-time", sub: __("Waiting to be sent"), method: "queue.get_summary", format: (v, s) => ui.format_int(queued_of(s)) },
				{ key: "eta", label: __("Expected drain time"), icon: "es-line-time", tone: "blue", sub: __("At the current rate"), method: "queue.get_summary", format: (v, s) => eta_text(queued_of(s), rate_of(s)) },
				{
					key: "plan",
					label: __("Charged from plan"),
					icon: "es-line-zap",
					tone: "amber",
					method: "queue.get_summary",
					format: (v, s) => ui.format_int(queued_of(s)),
					sub: (v, s) => {
						const remaining = s && s.platform_queue && s.platform_queue.messages_remaining;
						return remaining != null ? __("Balance after: {0}", [ui.format_int(Math.max(0, cint(remaining) - queued_of(s)))]) : __("One message per queued row");
					},
				},
			],
			banner: () => summary().then(banner_for),
			blocks: [{ key: "rate", render: render_rate_block, events: ["wa:queue:progress"] }],
			events: { "wa:queue:progress": (data, h) => summary(true).then(() => h.refresh()) },
		});
		// The primary verb follows the pause state (contract gap: no `set_primary` yet → best effort).
		const sync_primary = () =>
			summary().then((s) => {
				const label = s.paused ? __("Resume sending") : __("Pause sending");
				if (typeof header.set_primary === "function") header.set_primary({ label, tone: s.paused ? "amber" : undefined });
				else if (header.$el) header.$el.find(".btn-primary").first().text(label).toggleClass("btn-warning", !!s.paused);
			});
		sync_primary();
		const original_refresh = header.refresh.bind(header);
		header.refresh = (...a) => {
			const out = original_refresh(...a);
			sync_primary();
			return out;
		};
		return header;
	};

	// ---- rows: enrich with the linked outbound's document + open the drawer -----------------

	/** Document type / no. live on the linked outbound: fetch them for the page once per render. */
	const enrich_rows = (listview, datalist) => {
		const rows = (listview.data || []).filter((d) => d.outbound_message && d._ref === undefined);
		if (!rows.length) return;
		rows.forEach((d) => (d._ref = null));
		frappe.db
			.get_list("WhatsApp Log", { fields: ["name", "reference_doctype", "reference_name"], filters: { name: ["in", rows.map((d) => d.outbound_message)] }, limit: rows.length })
			.then((logs) => {
				const map = {};
				(logs || []).forEach((l) => (map[l.name] = l));
				rows.forEach((d) => (d._ref = map[d.outbound_message] || {}));
				datalist && datalist.refresh && datalist.refresh();
			})
			.catch(() => {});
	};

	/** The same toolbar and table as the other message screens; the queue adds its own columns. */
	const make_list = (listview, refresh, bulk) => {
		const page_start = () => cint(listview.start) || 0;
		const open = (doc) => open_drawer(doc, refresh, listview);
		return whatsapp_next.screens.message_list(listview, {
			open,
			bulk,
			realtime: "wa:queue:progress",
			datalist: { selectable: true },
			search: { fieldname: "search", fields: ["display_name", "phone_e164", "outbound_message"], placeholder: __("Name, number or document no.…") },
			filters: [
				{ fieldname: "status", type: "select" },
				{ fieldname: "device", type: "select" },
				{ fieldname: "campaign", type: "select" },
			],
			date: { label: __("Expected send"), fieldname: "scheduled_at" },
			columns: [
				{ fieldname: "name", label: "#", width: 40, align: "end", sortable: false, type: "number", format: (v, doc) => ui.format_int(page_start() + (listview.data || []).indexOf(doc) + 1) },
				whatsapp_next.columns.party({ width: 200, fallback: __("No name — from the device directory") }),
				{ fieldname: "_ref_doctype", label: __("Document type"), width: 110, sortable: false, format: (v, doc) => (doc._ref && doc._ref.reference_doctype ? ui.escape(__(doc._ref.reference_doctype)) : "—") },
				{ fieldname: "_ref_name", label: __("Document no."), width: 100, sortable: false, format: (v, doc) => (doc._ref && doc._ref.reference_name ? frappe.utils.get_form_link(doc._ref.reference_doctype, doc._ref.reference_name, true) : "—") },
				{ fieldname: "status", label: __("Status"), width: 100, type: "status", sortable: true },
				whatsapp_next.columns.device({ width: 130 }),
				{
					fieldname: "scheduled_at",
					label: __("Expected send"),
					width: 130,
					sortable: true,
					// a paused queue has no expected time: say so instead of showing a stale one
					format: (v, doc) => (doc.status === "Paused" || (state.summary && state.summary.paused) ? ui.escape(__("Paused")) : ui.escape(fmt_dt(v))),
				},
			],
			mobile_columns: ["display_name", "status"],
			count: (total) => ui.plural(total, { one: __("{0} pending message"), other: __("{0} pending messages") }),
			empty: { title: __("The queue is empty"), description: __("Everything scheduled has gone out. New messages appear here the moment a form or campaign creates them."), action: { label: __("Go to campaigns"), onclick: () => frappe.set_route("List", "WhatsApp Campaign") } },
		});
	};

	const bulk_actions = (refresh) => {
		const plural = (n, one, other) => ui.plural(n, { one, other });
		return [
			{
				label: (n) => (n ? __("Pause ({0})", [ui.format_int(n)]) : __("Pause")),
				method: "queue.pause_items",
				condition: (docs) => count_of(docs, ["Queued"]) > 0,
				args: (names, { docs }) => ({ names: docs.filter((d) => d.status === "Queued").map((d) => d.name) }),
				success: (r) => plural(r.count || 0, __("{0} message paused"), __("{0} messages paused")),
			},
			{
				label: (n) => (n ? __("Resume ({0})", [ui.format_int(n)]) : __("Resume")),
				method: "queue.resume_items",
				condition: (docs) => count_of(docs, ["Paused"]) > 0,
				args: (names, { docs }) => ({ names: docs.filter((d) => d.status === "Paused").map((d) => d.name) }),
				success: (r) => plural(r.count || 0, __("{0} message resumed"), __("{0} messages resumed")),
			},
			{
				label: (n) => (n ? __("Retry after giving up ({0})", [ui.format_int(n)]) : __("Retry after giving up")),
				method: "queue.retry_dead_letter",
				condition: (docs) => count_of(docs, ["Dead Letter"]) > 0,
				args: (names, { docs }) => ({ names: docs.filter((d) => d.status === "Dead Letter").map((d) => d.name) }),
				success: (r) => plural(r.count || 0, __("{0} message re-queued"), __("{0} messages re-queued")),
			},
			{
				label: (n) => (n ? __("Cancel ({0})", [ui.format_int(n)]) : __("Cancel")),
				method: "queue.delete_items",
				condition: (docs) => count_of(docs, ["Queued", "Paused"]) > 0,
				confirm: (names, docs) => {
					const n = count_of(docs, ["Queued", "Paused"]);
					return {
						title: plural(n, __("Cancel {0} message?"), __("Cancel {0} messages?")),
						message: __("The messages leave the queue and their status becomes Cancelled."),
						impact: [
							{ label: __("Will be cancelled"), value: ui.format_int(n), tone: "red" },
							{ label: __("Ignored (already sent or removed)"), value: ui.format_int(names.length - n) },
						],
						reason_field: true,
						ack_checkbox: __("I understand these messages will not be sent."),
						danger: true,
						confirm_label: __("Cancel messages"),
						cancel_label: __("Keep them"),
					};
				},
				args: (names, { docs }) => ({ names: docs.filter((d) => ["Queued", "Paused"].includes(d.status)).map((d) => d.name) }),
				success: (r) => plural(r.count || 0, __("{0} message cancelled"), __("{0} messages cancelled")),
			},
		];
	};

	frappe.listview_settings[DT] = {
		hide_name_column: true,
		add_fields: ["status", "outbound_message", "device", "campaign", "phone_e164", "display_name", "priority", "scheduled_at", "attempts", "max_attempts", "last_error_code"],

		// The one status → colour rule; badges read it through `sanad.ui.indicator_for`.
		get_indicator(doc) {
			const colour = { Queued: "blue", Sending: "blue", Paused: "orange", Completed: "green", Deleted: "gray", "Dead Letter": "red" }[doc.status] || "gray";
			return [__(doc.status), colour, `status,=,${doc.status}`];
		},

		formatters: {
			status(value, df, doc) {
				const ind = ui.indicator_for(DT, Object.assign({ doctype: DT }, doc));
				return ui.StatusBadge.html({ label: __(value), colour: ind.colour });
			},
		},

		onload(listview) {
			const refresh = () => listview.refresh();
			const settings = frappe.listview_settings[DT];

			// Default to the live statuses once per session (the user may clear it afterwards).
			if (!settings._defaulted && !frappe.route_options && !listview.filter_area.get().some((f) => f[1] === "status")) {
				settings._defaulted = true;
				listview.filter_area.add([[DT, "status", "in", LIVE]]);
			}

			state.listview = listview;
			state.promise = null;
			listview._sanad_header = make_header(listview);

			const bulk = is_manager() ? bulk_actions(refresh) : [];
			listview._sanad_datalist = make_list(listview, refresh, bulk);
			ui.on_list_render(listview, () => enrich_rows(listview, listview._sanad_datalist));
		},
	};
})();

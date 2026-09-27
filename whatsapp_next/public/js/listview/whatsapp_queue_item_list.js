// WhatsApp Queue Item list — screen 9 (09 §1B/§1C row 9). What is only this screen's lives here:
// the operations console (status · depth with its breakdown as filters · the throughput actually
// achieved, drawn minute by minute from `queue.get_throughput` · the drain clock · failures · what
// is left of the plan · the send-rate control over its recommended band → `queue.set_rate`), the
// Pause / Resume verb as the screen's primary action with a ConfirmDialog fed by
// `queue.get_summary`, the row enrichment with the linked outbound's document, and the bulk verbs
// over `queue.*_items` / `retry_dead_letter`. The header, its title, description, banner and blocks
// come from the kit's PageHeader, so the screen is composed, not decorated.
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
		{ label: __("Cancel this message"), icon: ui.icons.cancel, danger: true, condition: () => is_manager() && ["Queued", "Paused", "Dead Letter"].includes(doc.status), handler: () => whatsapp_next.queue.cancel_item(doc, refresh) },
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

	/** Who paused it, when, and why — the one thing a "Paused" chip cannot say on its own. */
	const paused_title = (s) => {
		if (!s || !s.paused) return __("Messages are going out automatically.");
		const since = s.paused_at ? frappe.datetime.prettyDate(s.paused_at) : "";
		const by = s.paused_by ? frappe.user.full_name(s.paused_by) : __("an administrator");
		return s.reason
			? __("Sending has been paused {0} by {1}. Recorded reason: “{2}”. Nothing is sent until you resume.", [since, by, s.reason])
			: __("Sending has been paused {0} by {1}. Nothing is sent until you resume.", [since, by]);
	};

	// ---- the operations console -----------------------------------------------------------------

	/** The live pipeline, in the order a message travels it — the breakdown under the depth. */
	const FLOW = [
		{ status: "Queued", tone: "blue", label: () => __("Waiting") },
		{ status: "Sending", tone: "cyan", label: () => __("Sending") },
		{ status: "Paused", tone: "amber", label: () => __("Held back") },
		{ status: "Dead Letter", tone: "red", label: () => __("Given up") },
	];

	const count_by = (s, status) => cint(s && s.counts_by_status && s.counts_by_status[status]);
	const depth_of = (s) => count_by(s, "Queued") + count_by(s, "Sending");

	/** The clock the queue empties at — a horizon an operator can hold against a meeting. */
	const drain_clock = (queued, rate) => {
		if (!queued || typeof moment === "undefined") return "";
		const at = moment().add(queued / Math.max(rate, 1), "minutes");
		return at.isSame(moment(), "day") ? at.format("HH:mm") : at.format("D MMM HH:mm");
	};

	/** The span `eta_text` states, worded to sit inside a sentence. */
	const eta_phrase = (queued, rate) => {
		const minutes = queued / Math.max(rate, 1);
		if (minutes < 1) return __("under a minute");
		if (minutes < 60) return ui.plural(Math.round(minutes), { one: __("{0} minute"), other: __("{0} minutes") });
		return __("{0} h {1} min", [ui.format_int(Math.floor(minutes / 60)), ui.format_int(Math.round(minutes % 60))]);
	};

	// ---- throughput (its own cache: heavier than the summary and it moves slower) ---------------

	const THROUGHPUT_WINDOW = 60;
	const THROUGHPUT_TTL = 20000;
	const flow_state = { promise: null, at: 0 };
	const throughput = (fresh = false) => {
		if (fresh || (flow_state.promise && Date.now() - flow_state.at > THROUGHPUT_TTL)) flow_state.promise = null;
		if (!flow_state.promise) {
			flow_state.at = Date.now();
			flow_state.promise = ui
				.call("queue.get_throughput", { minutes: THROUGHPUT_WINDOW }, { silent: true })
				.catch(() => ({ buckets: [], sent: 0, peak: 0, per_minute: 0, minutes: THROUGHPUT_WINDOW }));
		}
		return flow_state.promise;
	};

	/**
	 * The console above the list: one instrument panel, read left to right in the order an
	 * operator asks the questions — is it running · how much is in it · how fast is it really
	 * going · when is it empty · what failed · what does it cost — then the evidence (what left
	 * the queue each of the last sixty minutes) beside the one control that changes it.
	 *
	 * Deliberately not a band of cards: cards state numbers and stop there. Here the numbers carry
	 * their own sub-line, the depth carries its breakdown as filters on the list below, and the
	 * rate is shown against the rate actually being achieved.
	 */
	const make_console = (listview) => {
		const refresh_all = () => {
			con.refresh(true);
			listview.refresh();
		};

		const header = new sanad.ui.PageHeader({
			listview,
			// no title and no description: the console's first cell states what the queue is doing,
			// which is the only thing a title could have said (owner, 2026-09-23)
			banner: () => summary().then((s) => (s && s.paused ? { tone: "amber", text: paused_title(s) } : null)),
			blocks: [
				{
					key: "queue-console",
					events: ["wa:queue:progress"],
					render: ($el) => Promise.all([summary(), throughput()]).then(([s, t]) => paint($el, s, t)),
				},
			],
		});

		/**
		 * The one verb sits in the Status cell, beside the state it changes, and its label says
		 * which way it will go. A manager who cannot change the queue never sees a dead button.
		 */
		const verb_html = (paused) =>
			is_manager()
				? `<button type="button" class="btn btn-default btn-sm wa-ops__verb">
						${ui.icon(paused ? "es-line-zap" : "es-line-time", "xs")} ${ui.escape(paused ? __("Resume sending") : __("Pause sending"))}
					</button>`
				: "";

		// ---- the metric row ---------------------------------------------------------------------

		const metric = (label, value, sub, opts = {}) => `
			<div class="wa-ops__metric${opts.wide ? " wa-ops__metric--wide" : ""}">
				<span class="wa-ops__label">${ui.escape(label)}</span>
				<span class="wa-ops__value${opts.tone ? ` sanad-tone--${opts.tone}` : ""} sanad-tabular">${value}</span>
				<span class="wa-ops__sub">${sub || "&nbsp;"}</span>
			</div>`;

		/** The depth's own breakdown: four counts that are also the list's filters. */
		const breakdown_html = (s) => {
			const active = (listview.filter_area ? listview.filter_area.get() : []).filter((f) => f[1] === "status");
			const is_on = (status) => active.some((f) => f[2] === "=" && f[3] === status);
			const parts = FLOW.filter((f) => count_by(s, f.status) || is_on(f.status)).map(
				(f) => `<button type="button" class="wa-ops__part" data-status="${ui.escape(f.status)}" aria-pressed="${is_on(f.status)}">
					<span class="wa-ops__dot sanad-tone--${f.tone}" aria-hidden="true"></span>${ui.escape(f.label())}
					<span class="sanad-tabular">${ui.escape(ui.format_int(count_by(s, f.status)))}</span>
				</button>`
			);
			return parts.length ? parts.join("") : `<span class="wa-ops__sub">${ui.escape(__("Nothing is waiting."))}</span>`;
		};

		// ---- the evidence: what actually left the queue, minute by minute -------------------------

		const chart_html = (t, rate) => {
			const buckets = (t && t.buckets) || [];
			const peak = Math.max(cint(t && t.peak), 1);
			const scale = Math.max(peak, rate);
			const caption = __("Sent per minute — last {0} minutes", [ui.format_int(t && t.minutes ? t.minutes : THROUGHPUT_WINDOW)]);
			// an empty window still gets its plot: a panel that collapses when nothing happened
			// reads as broken, and the baseline plus the target line are the answer to "how fast?"
			const empty = !buckets.length || !cint(t && t.sent);
			const series = buckets.length ? buckets : new Array(THROUGHPUT_WINDOW).fill(0);
			const bars = series
				.map((n, i) => `<rect x="${(i + 0.15).toFixed(2)}" y="${(100 - (n / scale) * 100).toFixed(2)}" width="0.7" height="${((n / scale) * 100).toFixed(2)}"></rect>`)
				.join("");
			return `<figure class="wa-ops__chart">
				<figcaption class="wa-ops__label">
					${ui.escape(caption)}
					${empty ? "" : `<span class="wa-ops__peak sanad-tabular">${ui.escape(__("peak {0}/min", [ui.format_int(peak)]))}</span>`}
				</figcaption>
				<div class="wa-ops__plot" style="--wa-target:${Math.min((rate / scale) * 100, 96).toFixed(2)}%">
					<svg viewBox="0 0 ${series.length} 100" preserveAspectRatio="none" aria-hidden="true">${bars}</svg>
					<span class="wa-ops__target" aria-hidden="true"></span>
				</div>
				<p class="sanad-visually-hidden">${ui.escape(
					empty
						? __("Nothing has left the queue in the last {0} minutes.", [ui.format_int(t && t.minutes ? t.minutes : THROUGHPUT_WINDOW)])
						: __("{0} messages left the queue in the last {1} minutes; the busiest minute sent {2}.", [
								ui.format_int(cint(t.sent)),
								ui.format_int(t.minutes || THROUGHPUT_WINDOW),
								ui.format_int(peak),
							])
				)}</p>
				<div class="wa-ops__axis" aria-hidden="true">
					<span>${ui.escape(__("{0} min ago", [ui.format_int(t && t.minutes ? t.minutes : THROUGHPUT_WINDOW)]))}</span>
					<span class="wa-ops__axis-note">${ui.escape(empty ? __("nothing sent in this window") : __("dashed line: the rate you set"))}</span>
					<span>${ui.escape(__("now"))}</span>
				</div>
			</figure>`;
		};

		// ---- the one control ---------------------------------------------------------------------

		const rate_html = (s, rate, max, t) => {
			const id = ui.uid("wa-rate");
			const span = Math.max(max - RATE_MIN, 1);
			const zone_from = ((Math.max(RECOMMENDED.low, RATE_MIN) - RATE_MIN) / span) * 100;
			const zone_to = ((Math.min(RECOMMENDED.high, max) - RATE_MIN) / span) * 100;
			const verdict = rate_verdict(rate);
			const achieved = t && t.per_minute != null ? t.per_minute : null;
			return `<div class="wa-ops__rate">
				<div class="wa-ops__rate-head">
					<label class="wa-ops__label" for="${id}">${ui.escape(__("Send rate"))}</label>
					<output class="wa-ops__rate-value sanad-tabular" for="${id}">${ui.escape(__("{0}/min", [ui.format_int(rate)]))}</output>
				</div>
				<div class="wa-ops__track">
					<span class="wa-ops__zone" style="--wa-from:${zone_from.toFixed(2)}%;--wa-to:${zone_to.toFixed(2)}%" aria-hidden="true"></span>
					<input type="range" class="wa-ops__slider" id="${id}" min="${RATE_MIN}" max="${max}" step="1" value="${rate}"
						aria-describedby="${id}-note" aria-valuetext="${ui.escape(per_minute(rate))}" ${is_manager() ? "" : "disabled"}>
				</div>
				<div class="wa-ops__scale" aria-hidden="true">
					<span class="sanad-tabular">${ui.escape(ui.format_int(RATE_MIN))}</span>
					<span class="wa-ops__scale-zone">${ui.escape(__("Recommended {0}–{1}", [ui.format_int(RECOMMENDED.low), ui.format_int(RECOMMENDED.high)]))}</span>
					<span class="sanad-tabular">${ui.escape(ui.format_int(max))}</span>
				</div>
				<p class="wa-ops__rate-note" id="${id}-note">
					<span class="wa-ops__verdict">${sanad.ui.StatusBadge.html({ label: verdict.label, colour: verdict.tone })}</span>
					${ui.escape(achieved == null ? __("A higher rate raises the platform's ban risk.") : __("Achieving {0}/min over the last hour.", [ui.format_int(Math.round(achieved))]))}
				</p>
			</div>`;
		};

		// ---- paint --------------------------------------------------------------------------------

		const paint = ($el, s, t) => {
			if (!s) return;
			// a realtime tick must never replace the slider under a hand that is dragging it: the
			// old input then fires its `change` with the value it was abandoned at (seen in the
			// audit log as two rate changes 68 ms apart). Defer the repaint to the release.
			if (con.interacting) {
				con.pending = true;
				return;
			}
			const depth = depth_of(s);
			const rate = rate_of(s);
			const max = Math.min(RATE_MAX, cint(s.plan_rate) || RATE_MAX);
			const paused = !!s.paused;
			const failed = count_by(s, "Dead Letter");
			const remaining = s.platform_queue && s.platform_queue.messages_remaining;
			const achieved = t && t.per_minute != null ? Math.round(t.per_minute) : null;
			const clock = paused || !depth ? "—" : drain_clock(depth, rate) || __("now");

			const state_cell = `
				<div class="wa-ops__metric wa-ops__metric--state">
					<span class="wa-ops__label">${ui.escape(__("Status"))}</span>
					<div class="wa-ops__state-row">
						<span class="wa-ops__state sanad-tone--${paused ? "amber" : "green"}">
							<span class="wa-ops__pulse" aria-hidden="true"></span>${ui.escape(paused ? __("Paused") : __("Running"))}
						</span>
						${verb_html(paused)}
					</div>
					<span class="wa-ops__sub">${ui.escape(paused ? __("Nothing is going out.") : __("Messages go out automatically."))}</span>
				</div>`;

			$el.html(`
				<section class="wa-ops${paused ? " wa-ops--paused" : ""}" aria-label="${ui.escape(__("Queue status"))}">
					<div class="wa-ops__metrics">
						${state_cell}
						${metric(__("In queue"), ui.escape(ui.format_int(depth)), `<span class="wa-ops__parts">${breakdown_html(s)}</span>`, { wide: true })}
						${metric(__("Throughput"), achieved == null ? "—" : ui.escape(__("{0}/min", [ui.format_int(achieved)])), ui.escape(__("last hour, actual")))}
						${metric(__("Drains by"), ui.escape(clock), ui.escape(paused ? __("sending is paused") : depth ? __("in {0}", [eta_phrase(depth, rate)]) : __("queue is empty")))}
						${metric(__("Given up"), ui.escape(ui.format_int(failed)), failed ? `<button type="button" class="wa-ops__link" data-status="Dead Letter">${ui.escape(__("Review and retry"))}</button>` : ui.escape(__("no failures")), { tone: failed ? "red" : "" })}
						${metric(
							__("Plan left"),
							remaining == null ? "—" : ui.escape(ui.format_int(Math.max(0, cint(remaining) - depth))),
							`<button type="button" class="wa-ops__link" data-go="billing">${ui.escape(
								remaining == null ? __("plan reading unavailable") : depth ? __("after this queue sends") : __("messages available")
							)}</button>`
						)}
					</div>
					<div class="wa-ops__lower">
						${chart_html(t, rate)}
						${rate_html(s, rate, max, t)}
					</div>
				</section>`);

			$el.find("[data-go=billing]").on("click", () => whatsapp_next.settings.open("subscription"));
			$el.find("[data-status]").on("click", function () {
				const status = $(this).data("status");
				const on = $(this).attr("aria-pressed") === "true";
				const area = listview.filter_area;
				Promise.resolve(area.remove("status")).then(() => {
					if (!on) area.add([[DT, "status", "=", status]]);
				});
			});
			$el.find(".wa-ops__verb").on("click", () => (paused ? ask_resume(refresh_all) : ask_pause(refresh_all)));
			bind_rate($el, rate, max);
		};

		const bind_rate = ($el, rate, max) => {
			const $input = $el.find(".wa-ops__slider");
			const hold = () => (con.interacting = true);
			const release = () => {
				con.interacting = false;
				if (!con.pending) return;
				con.pending = false;
				con.refresh(true);
			};
			$input.on("pointerdown focusin", hold);
			$input.on("pointerup pointercancel focusout", release);
			const $value = $el.find(".wa-ops__rate-value");
			const $verdict = $el.find(".wa-ops__verdict");
			const track = $el.find(".wa-ops__track").get(0);
			const fill = (value) => track && track.style.setProperty("--wa-fill", `${(((value - RATE_MIN) / Math.max(max - RATE_MIN, 1)) * 100).toFixed(2)}%`);
			const paint_rate = (value) => {
				const v = rate_verdict(value);
				$value.text(__("{0}/min", [ui.format_int(value)]));
				$verdict.html(sanad.ui.StatusBadge.html({ label: v.label, colour: v.tone }));
				$input.attr("aria-valuetext", per_minute(value));
				fill(value);
			};
			fill(rate);
			$input.on("input", () => paint_rate(cint($input.val())));
			$input.on("change", () => {
				const value = cint($input.val());
				if (value === rate) return; // a repaint mid-drag can land the input back where it was
				ui.call("queue.set_rate", { messages_per_minute: value })
					.then((r) => {
						ui.Toast.success(__("Send rate set to {0}", [per_minute(r.messages_per_minute)]));
						con.interacting = false;
						con.pending = false;
						con.refresh(true);
					})
					.catch((err) => {
						ui.Toast.error(err);
						$input.val(rate);
						paint_rate(rate);
					});
			});
		};

		const con = {
			header,
			refresh(fresh = false) {
				return Promise.all([summary(fresh), throughput(fresh)]).then(() => header.refresh(true));
			},
		};

		return con;
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
			// the table may hold finished rows too (the live-status filter is a default, not a rule),
			// so the count says what it counts and never calls a completed row pending
			count: (total) => ui.plural(total, { one: __("{0} message"), other: __("{0} messages") }),
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
			listview._sanad_console = make_console(listview);

			const bulk = is_manager() ? bulk_actions(refresh) : [];
			listview._sanad_datalist = make_list(listview, refresh, bulk);
			ui.on_list_render(listview, () => enrich_rows(listview, listview._sanad_datalist));
		},
	};
})();

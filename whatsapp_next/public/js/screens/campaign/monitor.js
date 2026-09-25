// CampaignMonitor — what the campaign is doing, once it has left the wizard.
//
// The rule this screen is built on: **"100%" is not one fact.** A message is produced, then it
// leaves the device, then it arrives, then it is read — and a campaign that has handed every
// message to the queue has not delivered anything yet. So the five stages are named, counted and
// given their own denominator ("of what left the device"), and nothing here ever prints a single
// percentage that could be read as "everyone got it".
//
// The funnel and the status distribution are deliberately two different pictures. The funnel is
// history: how many survived each step. The distribution is now: where every message currently
// stands, in buckets that do not overlap. Mixing them is the usual way a delivery screen lies.
//
// Five tabs, because five questions: how is it going, which message did it, who received it, what
// failed, and what happened when.

frappe.provide("whatsapp_next.campaign");

(function () {
	const ui = sanad.ui;
	const C = whatsapp_next.campaign;
	const K = whatsapp_next.campaigns;
	const esc = C.esc;
	const fmt_int = C.fmt_int;

	const TONE = { gray: "muted", blue: "info", green: "ok", orange: "warn", red: "danger" };

	/** What each failure code means to the person reading it, not to the dispatcher. */
	const ERROR_TEXT = {
		recipient_not_registered: () => __("The number is not on WhatsApp"),
		device_disconnected: () => __("The device was disconnected"),
		timeout: () => __("The provider did not answer in time"),
		platform_rejected: () => __("The provider refused the message"),
		invalid_template: () => __("The message could not be rendered"),
		insufficient_balance: () => __("The subscription has no balance left"),
		invalid_phone: () => __("The number could not be read"),
		blacklisted: () => __("The number is blacklisted"),
		unknown_number_policy: () => __("Excluded: never had a conversation"),
		rate_limited: () => __("The provider rate-limited the sending"),
		auth: () => __("The connection to the provider was refused"),
		unknown: () => __("An unknown error"),
	};
	const error_text = (code) => (ERROR_TEXT[code] || (() => code))();

	/** What each timeline event says. */
	const EVENT_TEXT = {
		created: () => __("The campaign was created"),
		scheduled: () => __("Scheduled to start by itself"),
		started: () => __("The campaign started"),
		paused: () => __("Paused"),
		resumed: () => __("Resumed"),
		cancelled: () => __("Cancelled"),
		recipients_changed: () => __("Recipients changed"),
		first_message: () => __("The first message left"),
		last_message: () => __("The last message left"),
		ended: () => __("The campaign ended"),
		event: () => __("An event"),
	};

	C.Monitor = class CampaignMonitor {
		constructor({ wrapper, ctx }) {
			this.$wrapper = $(wrapper);
			this.ctx = ctx;
			this.tab = ctx.frm.wa_monitor_tab || "overview";
			if (!this.tabs().some((t) => t.key === this.tab)) this.tab = "overview";
			this.data = {};
			this.render();
		}

		get doc() {
			return this.ctx.doc;
		}

		tabs() {
			return [
				{ key: "overview", label: __("Overview"), icon: "chart" },
				{ key: "messages", label: __("Messages", null, "campaign"), icon: "chat" },
				{ key: "recipients", label: __("Recipients", null, "campaign"), icon: "users" },
				{ key: "errors", label: __("Failures", null, "campaign"), icon: "warn", count: cint(this.doc.failed_count) },
			];
		}

		render() {
			const tabs = this.tabs()
				.map(
					(t) => `
					<button type="button" role="tab" class="wa-cb__tab${t.key === this.tab ? " wa-cb__tab--on" : ""}" data-tab="${esc(t.key)}" aria-selected="${t.key === this.tab}">
						${ui.ico(t.icon, "sm")}<span>${esc(t.label)}</span>
						${t.count ? `<span class="wa-cb__tab-count sanad-tabular" dir="ltr">${esc(fmt_int(t.count))}</span>` : ""}
					</button>`
				)
				.join("");
			// The tabs are the head of the panel they open, not a strip floating above it: one
			// surface, one border, nothing between them — and the tabs pin under the header band
			// while the page scrolls.
			this.$wrapper.html(`
				<div class="wa-cb__monitor">
					<div data-block="band"></div>
					<div class="wa-cb__panel">
						<div class="wa-cb__tabs" role="tablist" aria-label="${esc(__("Campaign"))}">${tabs}</div>
						<div class="wa-cb__pane" role="tabpanel" data-pane></div>
					</div>
				</div>`);
			this.$wrapper.find("[data-tab]").on("click", (e) => this.go($(e.currentTarget).attr("data-tab")));
			this.render_band();
			this.render_pane();
			return this;
		}

		go(tab) {
			this.tab = tab;
			this.ctx.frm.wa_monitor_tab = tab;
			this.$wrapper.find("[data-tab]").each((i, el) => {
				const on = $(el).attr("data-tab") === tab;
				$(el).toggleClass("wa-cb__tab--on", on).attr("aria-selected", on);
			});
			this.render_pane();
		}

		/** Live counters overlay the document's own — `get_progress` answers with fresher ones. */
		tallies() {
			const d = Object.assign({}, this.doc, this.data.progress || {});
			const read = cint(d.read_count);
			const delivered_only = cint(d.delivered_count);
			const sent_only = cint(d.sent_count);
			const queued = cint(d.queued_count);
			const failed = cint(d.failed_count);
			const cancelled = cint(d.cancelled_count);
			const left = sent_only + delivered_only + read;
			return {
				read,
				delivered_only,
				sent_only,
				queued,
				failed,
				cancelled,
				left,
				arrived: delivered_only + read,
				produced: left + queued + failed + cancelled,
				processed: left + failed + cancelled,
			};
		}

		// ---- the band --------------------------------------------------------------------------

		render_band() {
			const doc = this.doc;
			const t = this.tallies();
			const tone = TONE[K.INDICATOR[doc.status]] || "muted";
			const running = ["Running", "Queued"].includes(doc.status);
			this.$wrapper.find('[data-block="band"]').html(`
				<div class="wa-cb__band wa-cb__band--${tone}">
					<div class="wa-cb__band-state">
						<span class="wa-cb__band-dot${running ? " wa-cb__band-dot--live" : ""}" aria-hidden="true"></span>
						<span class="wa-cb__band-text">
							<b>${esc(__(doc.status, null, "campaign"))}</b>
							<span dir="auto">${esc(this.state_sub())}</span>
						</span>
						<span class="wa-cb__band-verbs" data-verbs></span>
					</div>
					<p class="wa-cb__band-line" aria-live="polite" dir="auto">${esc(t.produced ? K.eta_text(doc, this.data.progress) : __("Nothing has been produced yet."))}</p>
				</div>`);
			this.render_verbs();
		}

		/**
		 * What can be done to a running campaign, beside the state it changes (D-088). The words
		 * and the confirmations are the shared ones, so a campaign is paused the same way here as
		 * it is from the list.
		 */
		render_verbs() {
			const $host = this.$wrapper.find("[data-verbs]");
			if (!$host.length) return;
			const ctx = this.ctx;
			const after = () => ctx.frm.reload_doc();
			const dirty = ctx.frm.is_dirty();
			// a paused campaign may still be edited — its messages, its audience — before it resumes
			if (this.doc.status === "Paused" && K.is_manager() && ctx.can_edit()) {
				$(ui.btn({ label: __("Edit the campaign"), icon: "doc", variant: "secondary", size: "sm", disabled: dirty }))
					.on("click", () => ctx.edit(true))
					.appendTo($host);
			}
			K.verbs(this.doc, { after, messages: Math.max(1, C.messages_of(this.doc)) })
				.filter((v) => !["start", "schedule", "unschedule"].includes(v.key))
				.forEach((v) => {
					$(ui.btn({
						label: v.label,
						variant: v.key === "resume" ? "primary" : v.tone === "danger" ? "danger" : "secondary",
						size: "sm",
						disabled: dirty,
						title: dirty ? __("Save your changes first.") : "",
					}))
						.on("click", () => v.run())
						.appendTo($host);
				});
			if (cint(this.doc.total_recipients)) {
				$(ui.btn({ label: __("Outbound log"), icon: "table", size: "sm" }))
					.on("click", () => frappe.set_route("List", "WhatsApp Log", { campaign: this.doc.name }))
					.appendTo($host);
			}
		}

		state_sub() {
			const doc = this.doc;
			if (doc.status === "Paused") return doc.pause_reason ? __("paused: {0}", [doc.pause_reason]) : __("paused — nothing is going out");
			if (doc.status === "Cancelled") return doc.cancel_reason ? __("cancelled: {0}", [doc.cancel_reason]) : __("cancelled");
			if (K.TERMINAL.includes(doc.status)) return doc.ended_at ? __("ended {0}", [whatsapp_next.fmt.dt(doc.ended_at)]) : __("ended");
			if (doc.status === "Scheduled" && doc.scheduled_at) return __("starts {0}", [String(doc.scheduled_at).slice(0, 16)]);
			return __("handing messages to the queue");
		}

		// ---- the panes -------------------------------------------------------------------------

		render_pane() {
			const $pane = this.$wrapper.find("[data-pane]").empty();
			const render = {
				overview: () => this.pane_overview($pane),
				messages: () => this.pane_messages($pane),
				recipients: () => this.pane_recipients($pane),
				errors: () => this.pane_errors($pane),
			}[this.tab] || (() => this.pane_overview($pane));
			render && render();
		}

		skeleton($pane) {
			$pane.html(`<div class="sanad-skeleton" style="block-size:180px"></div>`);
		}

		// -- overview ---------------------------------------------------------------------------

		/**
		 * The five stages, each with the number, the share, and **what the share is of**. A stage
		 * that reads "86%" with no denominator is the whole problem this screen exists to avoid.
		 */
		stages(t) {
			return [
				{ key: "processed", label: __("Processed"), value: t.processed, of: t.produced, of_label: __("of everything produced"), tone: "muted" },
				{ key: "left", label: __("Left the device"), value: t.left, of: t.produced, of_label: __("of everything produced"), tone: "info" },
				{ key: "arrived", label: __("Arrived"), value: t.arrived, of: t.left, of_label: __("of what left the device"), tone: "ok" },
				{ key: "read", label: __("Read", null, "campaign"), value: t.read, of: t.arrived, of_label: __("of what arrived"), tone: "pri" },
				{ key: "failed", label: __("Failed", null, "campaign"), value: t.failed, of: t.produced, of_label: __("of everything produced"), tone: "danger" },
			];
		}

		pane_overview($pane) {
			const t = this.tallies();
			const share = (a, b) => (cint(b) ? (cint(a) * 100) / cint(b) : null);
			const pct = (v) => (v == null ? "—" : `${v >= 10 || !v ? Math.round(v) : v.toFixed(1)}%`);

			const readings = this.stages(t)
				.map(
					(s) => `
					<div class="wa-cb__stage wa-cb__stage--${s.tone}">
						<span class="wa-cb__stage-label">${esc(s.label)}</span>
						<span class="wa-cb__stage-value sanad-tabular" dir="ltr">${esc(fmt_int(s.value))}<span class="wa-cb__stage-of">/ ${esc(fmt_int(s.of))}</span></span>
						<span class="wa-cb__stage-share sanad-tabular" dir="ltr">${esc(pct(share(s.value, s.of)))}</span>
						<span class="wa-cb__stage-note">${esc(s.of_label)}</span>
					</div>`
				)
				.join("");

			// the funnel: history, each step a share of the step above it
			const funnel = [
				{ label: __("Messages produced"), value: t.produced, of: t.produced },
				{ label: __("Left the device"), value: t.left, of: t.produced },
				{ label: __("Arrived"), value: t.arrived, of: t.left },
				{ label: __("Read", null, "campaign"), value: t.read, of: t.arrived },
			]
				.map((s, i) => {
					const width = t.produced ? (s.value / t.produced) * 100 : 0;
					return `
					<div class="wa-cb__funnel-row">
						<span class="wa-cb__funnel-label">${esc(s.label)}</span>
						<span class="wa-cb__funnel-track"><span class="wa-cb__funnel-bar" style="inline-size:${width.toFixed(2)}%"></span></span>
						<span class="wa-cb__funnel-value sanad-tabular" dir="ltr">${esc(fmt_int(s.value))}</span>
						<span class="wa-cb__funnel-share sanad-tabular" dir="ltr">${esc(i === 0 ? "" : pct(share(s.value, s.of)))}</span>
					</div>`;
				})
				.join("");

			// the distribution: now, in buckets that do not overlap
			const buckets = [
				{ label: __("Read", null, "campaign"), value: t.read, tone: "pri" },
				{ label: __("Delivered", null, "campaign"), value: t.delivered_only, tone: "ok" },
				{ label: __("Sent", null, "campaign"), value: t.sent_only, tone: "info" },
				{ label: __("In the queue"), value: t.queued, tone: "muted" },
				{ label: __("Failed", null, "campaign"), value: t.failed, tone: "danger" },
				{ label: __("Cancelled", null, "campaign"), value: t.cancelled, tone: "warn" },
			].filter((b) => b.value > 0);
			const bar = buckets
				.map((b) => `<span class="wa-cb__dist-seg wa-cb__dist-seg--${b.tone}" style="flex-basis:${((b.value / Math.max(t.produced, 1)) * 100).toFixed(2)}%" title="${esc(`${b.label} · ${fmt_int(b.value)}`)}"></span>`)
				.join("");
			const legend = buckets
				.map((b) => `<span class="wa-cb__dist-key"><span class="wa-cb__dist-dot wa-cb__dist-seg--${b.tone}"></span>${esc(b.label)}<b class="sanad-tabular" dir="ltr">${esc(fmt_int(b.value))}</b></span>`)
				.join("");

			$pane.html(`
				<div class="wa-cb__stack">
					${C.card({
						key: "stages",
						icon: "chart",
						title: __("How far each message got"),
						note: __("one message per recipient, per message of the campaign"),
						body: `<div class="wa-cb__stages">${readings}</div>`,
					})}
					<div class="wa-cb__two">
						${C.card({ key: "funnel", icon: "sigma", title: __("Delivery funnel"), note: __("each step of the one above it"), body: `<div class="wa-cb__funnel">${funnel}</div>` })}
						${C.card({
							key: "dist",
							icon: "cards",
							title: __("Where they stand now"),
							note: __("these do not overlap"),
							body: buckets.length
								? `<div class="wa-cb__dist"><span class="wa-cb__dist-bar">${bar}</span><div class="wa-cb__dist-legend">${legend}</div></div>`
								: `<p class="wa-cb__readings-foot">${esc(__("Nothing has been produced yet."))}</p>`,
						})}
					</div>
					${
						t.failed
							? C.note({
									tone: "danger",
									icon: "error",
									text: __("{0} failed — {1} of everything produced.", [C.messages_text(t.failed), pct(share(t.failed, t.produced))]),
									cta: { key: "errors", label: __("See why") },
								})
							: ""
					}
					<div data-block="mini-timeline"></div>
				</div>`);
			$pane.find('[data-note-cta="errors"]').on("click", () => this.go("errors"));
			this.load_timeline($pane.find('[data-block="mini-timeline"]'), { limit: 4 });
		}

		// -- messages ---------------------------------------------------------------------------

		pane_messages($pane) {
			this.skeleton($pane);
			ui.call("campaigns.get_message_stats", { name: this.doc.name }, { silent: true })
				.then((r) => {
					if (!$pane.closest("body").length) return;
					const rows = (r.rows || [])
						.map((row) => {
							const counts = row.counts || {};
							const done = ["Sent", "Delivered", "Read"].reduce((n, s) => n + cint(counts[s]), 0);
							const failed = cint(counts.Failed);
							const total = cint(row.total);
							return `
							<div class="wa-cb__mrow">
								<span class="wa-cb__mrow-num sanad-tabular" dir="ltr">${esc(fmt_int(row.idx))}</span>
								<span class="wa-cb__mrow-text">
									<span class="wa-cb__mrow-type">${esc(__(row.message_type))}${row.delay_seconds ? ` · ${esc(__("after {0}s", [fmt_int(row.delay_seconds)]))}` : ""}</span>
									<span class="wa-cb__mrow-body" dir="auto">${esc(row.preview || (row.attachment ? __("a file") : "—"))}</span>
								</span>
								<span class="wa-cb__mrow-counts">
									<span class="wa-cb__mrow-count"><b class="sanad-tabular" dir="ltr">${esc(fmt_int(done))}</b>${esc(__("left"))}</span>
									<span class="wa-cb__mrow-count${failed ? " sanad-tone--red" : ""}"><b class="sanad-tabular" dir="ltr">${esc(fmt_int(failed))}</b>${esc(__("failed"))}</span>
									<span class="wa-cb__mrow-count"><b class="sanad-tabular" dir="ltr">${esc(fmt_int(total))}</b>${esc(__("in total"))}</span>
								</span>
							</div>`;
						})
						.join("");
					$pane.html(
						C.card({
							key: "messages",
							icon: "chat",
							title: __("Each message, and what became of it"),
							body: rows || `<p class="wa-cb__readings-foot">${esc(__("Nothing has been sent yet."))}</p>`,
						})
					);
				})
				.catch((err) => $pane.html(`<p class="wa-cb__test-errors" role="alert">${esc(err.message)}</p>`));
		}

		// -- recipients -------------------------------------------------------------------------

		pane_recipients($pane) {
			this.audience = new C.Audience({ wrapper: $pane, ctx: this.ctx });
		}

		// -- failures ---------------------------------------------------------------------------

		pane_errors($pane) {
			this.skeleton($pane);
			ui.call("campaigns.get_failures", { name: this.doc.name }, { silent: true })
				.then((r) => {
					if (!$pane.closest("body").length) return;
					this.data.failures = r;
					if (!cint(r.total)) {
						$pane.html(C.card({ key: "failures", icon: "tick", title: __("Failures", null, "campaign"), body: `<p class="wa-cb__readings-foot">${esc(__("Nothing has failed."))}</p>` }));
						return;
					}
					const rows = (r.rows || [])
						.map(
							(row) => `
							<div class="wa-cb__frow">
								<span class="wa-cb__frow-count sanad-tabular" dir="ltr">${esc(fmt_int(row.count))}</span>
								<span class="wa-cb__frow-text">
									<span class="wa-cb__frow-label">${esc(error_text(row.error_code))}</span>
									<span class="wa-cb__frow-code sanad-tabular" dir="ltr">${esc(row.error_code)}${row.retryable ? ` · ${esc(__("can be retried"))}` : ""}</span>
								</span>
								<span class="wa-cb__frow-share sanad-tabular" dir="ltr">${esc(row.share)}%</span>
								<button type="button" class="wa-cb__frow-go" data-code="${esc(row.error_code)}">${esc(__("See the messages"))}</button>
							</div>`
						)
						.join("");
					const can_retry = cint(r.retryable) && K.is_manager() && this.doc.status !== "Cancelled";
					$pane.html(`
						<div class="wa-cb__stack">
							${C.card({
								key: "failures",
								icon: "warn",
								title: __("Why they failed"),
								note: __("{0} in total", [fmt_int(r.total)]),
								body: rows,
							})}
							${
								can_retry
									? C.card({
											key: "retry",
											icon: "queue",
											title: __("Send them again"),
											body: `
												<p class="wa-cb__readings-foot">${esc(__("{0} failed for a passing reason — a disconnected device, a timeout, a rate limit. Sending again creates a new message for each of them; the failed one stays in the log.", [C.messages_text(r.retryable)]))}</p>
												<div class="wa-cb__row-actions">${ui.btn({ label: __("Retry {0}", [fmt_int(r.retryable)]), variant: "primary", size: "sm", attrs: { "data-retry": "1" } })}</div>`,
										})
									: ""
							}
						</div>`);
					$pane.find("[data-code]").on("click", (e) => frappe.set_route("List", "WhatsApp Log", { campaign: this.doc.name, status: "Failed", error_code: $(e.currentTarget).attr("data-code") }));
					$pane.find("[data-retry]").on("click", () => this.retry());
				})
				.catch((err) => $pane.html(`<p class="wa-cb__test-errors" role="alert">${esc(err.message)}</p>`));
		}

		retry() {
			const r = this.data.failures || {};
			ui.ConfirmDialog.ask({
				title: __("Send {0} failed messages again?", [fmt_int(r.retryable)]),
				message: __("Each one becomes a new message in the queue. The failed attempt stays in the log, so the campaign's totals count both."),
				impact: [{ label: __("Messages to resend"), value: fmt_int(r.retryable) }],
				confirm_label: __("Retry {0}", [fmt_int(r.retryable)]),
				on_confirm: () => ui.call("campaigns.retry_failed", { name: this.doc.name }),
			})
				.then((res) => {
					ui.Toast.success(__("{0} sent again.", [fmt_int((res && res.retried) || 0)]));
					this.ctx.frm.reload_doc();
				})
				.catch(() => {});
		}

		// -- activity ---------------------------------------------------------------------------

		/** The timeline, in words a reader knows — the raw log is a tab of its own. */
		load_timeline($host, { limit }) {
			if (!$host.length) return;
			// one fetch per visit, shared by the overview's short list and the log's full one; a
			// re-render (progress arriving, a tab switch) draws from it instead of asking again
			if (!this.data.timeline) {
				$host.html(`<div class="sanad-skeleton" style="block-size:120px"></div>`);
				this.data.timeline = ui.call("campaigns.get_timeline", { name: this.doc.name }, { silent: true }).catch((err) => {
					this.data.timeline = null;
					throw err;
				});
			}
			this.data.timeline
				.then((r) => {
					if (!$host.closest("body").length) return;
					let events = r.events || [];
					if (limit && events.length > limit) events = events.slice(-limit);
					const rows = events
						.map(
							(e) => `
							<li class="wa-cb__event">
								<span class="wa-cb__event-dot" aria-hidden="true"></span>
								<span class="wa-cb__event-text">
									<span class="wa-cb__event-label">${esc((EVENT_TEXT[e.key] || EVENT_TEXT.event)())}${e.reason ? ` — ${esc(e.reason)}` : ""}</span>
									<span class="wa-cb__event-when sanad-tabular">${esc(whatsapp_next.fmt.dt(e.at))}${e.user && e.user !== "Administrator" ? ` · ${esc(e.user)}` : ""}</span>
								</span>
							</li>`
						)
						.join("");
					$host.html(
						C.card({
							key: "timeline",
							icon: "clock",
							title: __("What happened"),
							note: limit ? __("the latest") : "",
							body: rows ? `<ol class="wa-cb__timeline">${rows}</ol>` : `<p class="wa-cb__readings-foot">${esc(__("Nothing has happened yet."))}</p>`,
						})
					);
				})
				.catch(() => $host.empty());
		}

		// ---- keeping up ---------------------------------------------------------------------------

		/** Fresher counters than the document carries, for the band and the overview. */
		load_progress() {
			return ui
				.call("campaigns.get_progress", { name: this.doc.name }, { silent: true })
				.then((p) => {
					this.data.progress = p;
					this.render_band();
					if (this.tab === "overview") this.render_pane();
				})
				.catch(() => {});
		}

		refresh() {
			this.data.timeline = null; // the document changed: what happened may have grown
			this.render_band();
			if (this.tab === "recipients" && this.audience) this.audience.refresh();
			else this.render_pane();
		}
	};
})();

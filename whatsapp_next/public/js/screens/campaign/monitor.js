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
	const ui = whatsapp.ui;
	const campaign_builder = whatsapp_next.campaign;
	const campaign_helpers = whatsapp_next.campaigns;
	const escape_html = campaign_builder.escape_html;
	const format_integer = campaign_builder.format_integer;

	const TONE = { gray: "muted", blue: "info", green: "ok", orange: "warn", red: "danger" };

	const error_text = (code) => whatsapp_next.message_formatters.error_text(code);

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

	campaign_builder.Monitor = class CampaignMonitor {
		constructor({ wrapper, ctx }) {
			this.$wrapper = $(wrapper);
			this.ctx = ctx;
			this.tab = ctx.frm.wa_monitor_tab || "overview";
			if (!this.build_tab_list().some((t) => t.key === this.tab)) this.tab = "overview";
			this.data = {};
			this.render();
		}

		get doc() {
			return this.ctx.doc;
		}

		build_tab_list() {
			return [
				{ key: "overview", label: __("Overview"), icon: "chart" },
				{ key: "messages", label: __("Messages", null, "campaign"), icon: "chat" },
				{ key: "recipients", label: __("Recipients", null, "campaign"), icon: "users" },
				{ key: "errors", label: __("Failures", null, "campaign"), icon: "warn", count: cint(this.doc.failed_count) },
			];
		}

		render() {
			const tabs = this.build_tab_list()
				.map(
					(t) => `
					<button type="button" role="tab" class="whatsapp-campaign-builder__tab${t.key === this.tab ? " whatsapp-campaign-builder__tab--on" : ""}" data-tab="${escape_html(t.key)}" aria-selected="${t.key === this.tab}">
						${ui.inline_icon_html(t.icon, "sm")}<span>${escape_html(t.label)}</span>
						${t.count ? `<span class="whatsapp-campaign-builder__tab-count whatsapp-kit-tabular" dir="ltr">${escape_html(format_integer(t.count))}</span>` : ""}
					</button>`
				)
				.join("");
			// The tabs are the head of the panel they open, not a strip floating above it: one
			// surface, one border, nothing between them — and the tabs pin under the header band
			// while the page scrolls.
			this.$wrapper.html(`
				<div class="whatsapp-campaign-builder__monitor">
					<div data-block="band"></div>
					<div class="whatsapp-campaign-builder__panel">
						<div class="whatsapp-campaign-builder__tabs" role="tablist" aria-label="${escape_html(__("Campaign"))}">${tabs}</div>
						<div class="whatsapp-campaign-builder__pane" role="tabpanel" data-pane></div>
					</div>
				</div>`);
			this.$wrapper.find("[data-tab]").on("click", (e) => this.switch_to_tab($(e.currentTarget).attr("data-tab")));
			this.render_band();
			this.render_pane();
			return this;
		}

		switch_to_tab(tab) {
			this.tab = tab;
			this.ctx.frm.wa_monitor_tab = tab;
			this.$wrapper.find("[data-tab]").each((i, el) => {
				const on = $(el).attr("data-tab") === tab;
				$(el).toggleClass("whatsapp-campaign-builder__tab--on", on).attr("aria-selected", on);
			});
			this.render_pane();
		}

		/**
		 * The document with the live counters laid over its own. `get_progress` returns them as
		 * `counters{queued, sent, …}`, not as the document's `*_count` fields, so they are mapped —
		 * merged as they came, they changed nothing and the monitor kept the counts of the last
		 * reload while messages moved.
		 */
		live_doc() {
			const p = this.data.progress;
			if (!p || !p.counters) return this.doc;
			const c = p.counters;
			return Object.assign({}, this.doc, {
				queued_count: cint(c.queued),
				sent_count: cint(c.sent),
				delivered_count: cint(c.delivered),
				read_count: cint(c.read),
				failed_count: cint(c.failed),
				cancelled_count: cint(c.cancelled),
			});
		}

		/** Live counters overlay the document's own — `get_progress` answers with fresher ones. */
		tallies() {
			const d = this.live_doc();
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
			const tone = TONE[campaign_helpers.INDICATOR[doc.status]] || "muted";
			const running = ["Running", "Queued"].includes(doc.status);
			this.$wrapper.find('[data-block="band"]').html(`
				<div class="whatsapp-campaign-builder__band whatsapp-campaign-builder__band--${tone}">
					<div class="whatsapp-campaign-builder__band-state">
						<span class="whatsapp-campaign-builder__band-dot${running ? " whatsapp-campaign-builder__band-dot--live" : ""}" aria-hidden="true"></span>
						<span class="whatsapp-campaign-builder__band-text">
							<b>${escape_html(__(doc.status, null, "campaign"))}</b>
							<span dir="auto">${escape_html(this.describe_status_detail())}</span>
						</span>
						<span class="whatsapp-campaign-builder__band-verbs" data-verbs></span>
					</div>
					<p class="whatsapp-campaign-builder__band-line" aria-live="polite" dir="auto">${escape_html(t.produced ? campaign_helpers.eta_text(this.live_doc(), this.data.progress) : __("Nothing has been produced yet."))}</p>
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
			if (this.doc.status === "Paused" && campaign_helpers.is_manager() && ctx.can_edit()) {
				$(ui.button_html({ label: __("Edit the campaign"), icon: "doc", variant: "secondary", size: "sm", disabled: dirty }))
					.on("click", () => ctx.set_editing_mode(true))
					.appendTo($host);
			}
			campaign_helpers.available_verbs(this.doc, { after, messages: Math.max(1, campaign_builder.messages_of(this.doc)) })
				.filter((v) => !["start", "schedule", "unschedule"].includes(v.key))
				.forEach((v) => {
					$(ui.button_html({
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
				$(ui.button_html({ label: __("Outbound log"), icon: "table", size: "sm" }))
					.on("click", () => frappe.set_route("List", "WhatsApp Log", { campaign: this.doc.name }))
					.appendTo($host);
			}
		}

		describe_status_detail() {
			const doc = this.doc;
			if (doc.status === "Paused") return doc.pause_reason ? __("paused: {0}", [doc.pause_reason]) : __("paused — nothing is going out");
			if (doc.status === "Cancelled") return doc.cancel_reason ? __("cancelled: {0}", [doc.cancel_reason]) : __("cancelled");
			if (campaign_helpers.TERMINAL.includes(doc.status)) return doc.ended_at ? __("ended {0}", [whatsapp_next.message_formatters.format_datetime(doc.ended_at)]) : __("ended");
			if (doc.status === "Scheduled" && doc.scheduled_at) return __("starts {0}", [whatsapp_next.message_formatters.format_datetime(doc.scheduled_at)]);
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
			$pane.html(`<div class="whatsapp-kit-skeleton" style="block-size:180px"></div>`);
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
					<div class="whatsapp-campaign-builder__stage whatsapp-campaign-builder__stage--${s.tone}">
						<span class="whatsapp-campaign-builder__stage-label">${escape_html(s.label)}</span>
						<span class="whatsapp-campaign-builder__stage-value whatsapp-kit-tabular" dir="ltr">${escape_html(format_integer(s.value))}<span class="whatsapp-campaign-builder__stage-of">/ ${escape_html(format_integer(s.of))}</span></span>
						<span class="whatsapp-campaign-builder__stage-share whatsapp-kit-tabular" dir="ltr">${escape_html(pct(share(s.value, s.of)))}</span>
						<span class="whatsapp-campaign-builder__stage-note">${escape_html(s.of_label)}</span>
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
					<div class="whatsapp-campaign-builder__funnel-row">
						<span class="whatsapp-campaign-builder__funnel-label">${escape_html(s.label)}</span>
						<span class="whatsapp-campaign-builder__funnel-track"><span class="whatsapp-campaign-builder__funnel-bar" style="inline-size:${width.toFixed(2)}%"></span></span>
						<span class="whatsapp-campaign-builder__funnel-value whatsapp-kit-tabular" dir="ltr">${escape_html(format_integer(s.value))}</span>
						<span class="whatsapp-campaign-builder__funnel-share whatsapp-kit-tabular" dir="ltr">${escape_html(i === 0 ? "" : pct(share(s.value, s.of)))}</span>
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
				.map((b) => `<span class="whatsapp-campaign-builder__dist-seg whatsapp-campaign-builder__dist-seg--${b.tone}" style="flex-basis:${((b.value / Math.max(t.produced, 1)) * 100).toFixed(2)}%" title="${escape_html(`${b.label} · ${format_integer(b.value)}`)}"></span>`)
				.join("");
			const legend = buckets
				.map((b) => `<span class="whatsapp-campaign-builder__dist-key"><span class="whatsapp-campaign-builder__dist-dot whatsapp-campaign-builder__dist-seg--${b.tone}"></span>${escape_html(b.label)}<b class="whatsapp-kit-tabular" dir="ltr">${escape_html(format_integer(b.value))}</b></span>`)
				.join("");

			$pane.html(`
				<div class="whatsapp-campaign-builder__stack">
					${campaign_builder.card_html({
						key: "stages",
						icon: "chart",
						title: __("How far each message got"),
						note: __("one message per recipient, per message of the campaign"),
						body: `<div class="whatsapp-campaign-builder__stages">${readings}</div>`,
					})}
					<div class="whatsapp-campaign-builder__two">
						${campaign_builder.card_html({ key: "funnel", icon: "sigma", title: __("Delivery funnel"), note: __("each step of the one above it"), body: `<div class="whatsapp-campaign-builder__funnel">${funnel}</div>` })}
						${campaign_builder.card_html({
							key: "dist",
							icon: "cards",
							title: __("Where they stand now"),
							note: __("these do not overlap"),
							body: buckets.length
								? `<div class="whatsapp-campaign-builder__dist"><span class="whatsapp-campaign-builder__dist-bar">${bar}</span><div class="whatsapp-campaign-builder__dist-legend">${legend}</div></div>`
								: `<p class="whatsapp-campaign-builder__readings-foot">${escape_html(__("Nothing has been produced yet."))}</p>`,
						})}
					</div>
					${
						t.failed
							? campaign_builder.note_html({
									tone: "danger",
									icon: "error",
									text: __("{0} failed — {1} of everything produced.", [campaign_builder.messages_text(t.failed), pct(share(t.failed, t.produced))]),
									cta: { key: "errors", label: __("See why") },
								})
							: ""
					}
					<div data-block="mini-timeline"></div>
				</div>`);
			$pane.find('[data-note-cta="errors"]').on("click", () => this.switch_to_tab("errors"));
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
							<div class="whatsapp-campaign-builder__mrow">
								<span class="whatsapp-campaign-builder__mrow-num whatsapp-kit-tabular" dir="ltr">${escape_html(format_integer(row.idx))}</span>
								<span class="whatsapp-campaign-builder__mrow-text">
									<span class="whatsapp-campaign-builder__mrow-type">${escape_html(__(row.message_type))}${row.delay_seconds ? ` · ${escape_html(__("after {0}s", [format_integer(row.delay_seconds)]))}` : ""}</span>
									<span class="whatsapp-campaign-builder__mrow-body" dir="auto">${escape_html(row.preview || (row.attachment ? __("a file") : "—"))}</span>
								</span>
								<span class="whatsapp-campaign-builder__mrow-counts">
									<span class="whatsapp-campaign-builder__mrow-count"><b class="whatsapp-kit-tabular" dir="ltr">${escape_html(format_integer(done))}</b>${escape_html(__("left"))}</span>
									<span class="whatsapp-campaign-builder__mrow-count${failed ? " whatsapp-kit-tone--red" : ""}"><b class="whatsapp-kit-tabular" dir="ltr">${escape_html(format_integer(failed))}</b>${escape_html(__("failed"))}</span>
									<span class="whatsapp-campaign-builder__mrow-count"><b class="whatsapp-kit-tabular" dir="ltr">${escape_html(format_integer(total))}</b>${escape_html(__("in total"))}</span>
								</span>
							</div>`;
						})
						.join("");
					$pane.html(
						campaign_builder.card_html({
							key: "messages",
							icon: "chat",
							title: __("Each message, and what became of it"),
							body: rows || `<p class="whatsapp-campaign-builder__readings-foot">${escape_html(__("Nothing has been sent yet."))}</p>`,
						})
					);
				})
				.catch((err) => $pane.html(`<p class="whatsapp-campaign-builder__test-errors" role="alert">${escape_html(err.message)}</p>`));
		}

		// -- recipients -------------------------------------------------------------------------

		pane_recipients($pane) {
			this.audience = new campaign_builder.Audience({ wrapper: $pane, ctx: this.ctx });
		}

		// -- failures ---------------------------------------------------------------------------

		pane_errors($pane) {
			this.skeleton($pane);
			ui.call("campaigns.get_failures", { name: this.doc.name }, { silent: true })
				.then((r) => {
					if (!$pane.closest("body").length) return;
					this.data.failures = r;
					if (!cint(r.total)) {
						$pane.html(campaign_builder.card_html({ key: "failures", icon: "tick", title: __("Failures", null, "campaign"), body: `<p class="whatsapp-campaign-builder__readings-foot">${escape_html(__("Nothing has failed."))}</p>` }));
						return;
					}
					const rows = (r.rows || [])
						.map(
							(row) => `
							<div class="whatsapp-campaign-builder__frow">
								<span class="whatsapp-campaign-builder__frow-count whatsapp-kit-tabular" dir="ltr">${escape_html(format_integer(row.count))}</span>
								<span class="whatsapp-campaign-builder__frow-text">
									<span class="whatsapp-campaign-builder__frow-label">${escape_html(error_text(row.error_code))}</span>
									<span class="whatsapp-campaign-builder__frow-code whatsapp-kit-tabular" dir="ltr">${escape_html(row.error_code)}${row.retryable ? ` · ${escape_html(__("can be retried"))}` : ""}</span>
								</span>
								<span class="whatsapp-campaign-builder__frow-share whatsapp-kit-tabular" dir="ltr">${escape_html(row.share)}%</span>
								<button type="button" class="whatsapp-campaign-builder__frow-go" data-code="${escape_html(row.error_code)}">${escape_html(__("See the messages"))}</button>
							</div>`
						)
						.join("");
					const can_retry = cint(r.retryable) && campaign_helpers.is_manager() && this.doc.status !== "Cancelled";
					$pane.html(`
						<div class="whatsapp-campaign-builder__stack">
							${campaign_builder.card_html({
								key: "failures",
								icon: "warn",
								title: __("Why they failed"),
								note: __("{0} in total", [format_integer(r.total)]),
								body: rows,
							})}
							${
								can_retry
									? campaign_builder.card_html({
											key: "retry",
											icon: "queue",
											title: __("Send them again"),
											body: `
												<p class="whatsapp-campaign-builder__readings-foot">${escape_html(__("{0} failed for a passing reason — a disconnected device, a timeout, a rate limit. Sending again creates a new message for each of them; the failed one stays in the log.", [campaign_builder.messages_text(r.retryable)]))}</p>
												<div class="whatsapp-campaign-builder__row-actions">${ui.button_html({ label: __("Retry {0}", [format_integer(r.retryable)]), variant: "primary", size: "sm", attrs: { "data-retry": "1" } })}</div>`,
										})
									: ""
							}
						</div>`);
					$pane.find("[data-code]").on("click", (e) => frappe.set_route("List", "WhatsApp Log", { campaign: this.doc.name, status: "Failed", error_code: $(e.currentTarget).attr("data-code") }));
					$pane.find("[data-retry]").on("click", () => this.retry());
				})
				.catch((err) => $pane.html(`<p class="whatsapp-campaign-builder__test-errors" role="alert">${escape_html(err.message)}</p>`));
		}

		retry() {
			const r = this.data.failures || {};
			ui.ConfirmDialog.ask_for_confirmation({
				title: __("Send {0} failed messages again?", [format_integer(r.retryable)]),
				message: __("Each one becomes a new message in the queue. The failed attempt stays in the log, so the campaign's totals count both."),
				impact: [{ label: __("Messages to resend"), value: format_integer(r.retryable) }],
				confirm_label: __("Retry {0}", [format_integer(r.retryable)]),
				on_confirm: () => ui.call("campaigns.retry_failed", { name: this.doc.name }),
			})
				.then((res) => {
					ui.Toast.success(__("{0} sent again.", [format_integer((res && res.retried) || 0)]));
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
				$host.html(`<div class="whatsapp-kit-skeleton" style="block-size:120px"></div>`);
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
							<li class="whatsapp-campaign-builder__event">
								<span class="whatsapp-campaign-builder__event-dot" aria-hidden="true"></span>
								<span class="whatsapp-campaign-builder__event-text">
									<span class="whatsapp-campaign-builder__event-label">${escape_html((EVENT_TEXT[e.key] || EVENT_TEXT.event)())}${e.reason ? ` — ${escape_html(e.reason)}` : ""}</span>
									<span class="whatsapp-campaign-builder__event-when whatsapp-kit-tabular">${escape_html(whatsapp_next.message_formatters.format_datetime(e.at))}${e.user && e.user !== "Administrator" ? ` · ${escape_html(e.user)}` : ""}</span>
								</span>
							</li>`
						)
						.join("");
					$host.html(
						campaign_builder.card_html({
							key: "timeline",
							icon: "clock",
							title: __("What happened"),
							note: limit ? __("the latest") : "",
							body: rows ? `<ol class="whatsapp-campaign-builder__timeline">${rows}</ol>` : `<p class="whatsapp-campaign-builder__readings-foot">${escape_html(__("Nothing has happened yet."))}</p>`,
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

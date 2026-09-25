// CampaignReview — step 4. Everything, once, before anything is sent.
//
// A review screen exists to answer one question: if I press the green button, what happens? So it
// says the plan as a sentence first — how many messages, from which device, at what rate, for how
// long — and then repeats the parts underneath in case one of them is wrong. The checklist is the
// same five checks the aside carries, at full size, because this is the moment they decide
// something: the sticky bar's verb is disabled until they pass, and the reason is on this screen
// and not in a toast after the refusal.

frappe.provide("whatsapp_next.campaign");

(function () {
	const ui = sanad.ui;
	const C = whatsapp_next.campaign;
	const K = whatsapp_next.campaigns;
	const esc = C.esc;

	C.Review = class CampaignReview {
		constructor({ wrapper, ctx }) {
			this.$wrapper = $(wrapper);
			this.ctx = ctx;
			this.render();
		}

		when_text() {
			const at = this.ctx.doc.scheduled_at;
			if (!at) return __("As soon as you start it");
			return `${String(at).slice(0, 10)} · ${String(at).slice(11, 16)}`;
		}

		plan_text() {
			const e = this.ctx.estimate();
			if (!e.total) return __("There is nothing to send yet — the campaign has no recipients or no messages.");
			return __("{0} will be created and handed to the queue at {1}/min from {2}. That takes about {3}.", [
				C.messages_text(e.total),
				C.fmt_int(e.rate),
				K.device_title(this.ctx.doc.device) || __("no device"),
				C.dur_text(e.minutes),
			]);
		}

		render() {
			const doc = this.ctx.doc;
			const e = this.ctx.estimate();
			const per = C.messages_of(doc);
			const scheduled = !!doc.scheduled_at;
			const cap = cint(this.ctx.cap);
			const tiles = [
				{ tone: "pri", icon: "users", label: __("Recipients"), value: C.fmt_int(doc.total_recipients), of: __("chosen for sending"), badge: cint(doc.total_recipients) ? __("ready") : __("none") },
				{ tone: "info", icon: "chat", label: __("Messages", null, "campaign"), value: C.fmt_int(per), of: __("{0} in total", [C.fmt_int(e.total)]), badge: __("per recipient") },
				{ tone: "warn", icon: "bolt", label: __("Sending rate"), value: __("{0}/min", [C.fmt_int(e.rate)]), of: cap ? __("the queue allows {0}", [C.fmt_int(cap)]) : "", badge: cap && e.rate >= cap ? __("at the cap") : __("steady") },
				{ tone: "ok", icon: "clock", label: __("Estimated duration"), value: C.dur_text(e.minutes), of: scheduled ? __("from {0}", [this.when_text()]) : __("from the moment it starts"), badge: scheduled ? __("scheduled") : __("on start") },
			];
			const tile = (t) => `
				<div class="wa-cb__tile wa-cb__tile--${esc(t.tone)}">
					<span class="wa-cb__tile-icon" aria-hidden="true">${ui.ico(t.icon, "sm")}</span>
					<span class="wa-cb__tile-text">
						<span class="wa-cb__tile-label">${esc(t.label)}</span>
						<span class="wa-cb__tile-value sanad-tabular">${esc(t.value)}</span>
						${t.of ? `<span class="wa-cb__tile-of">${esc(t.of)}</span>` : ""}
					</span>
					${t.badge ? `<span class="wa-cb__tile-badge">${esc(t.badge)}</span>` : ""}
				</div>`;
			const details = [
				{ label: __("Campaign name"), value: doc.campaign_name || doc.name },
				{ label: __("Sending device"), value: K.device_title(doc.device) || __("Not chosen") },
				{ label: __("Send time"), value: this.when_text() },
				{ label: __("Unknown numbers"), value: cint(doc.exclude_unknown_numbers) ? __("Excluded") : __("Included") },
			];
			const ends = e.minutes ? this.ends_text(e.minutes) : "";
			const plan = [
				{ key: "created", label: __("The campaign was created"), when: doc.creation ? whatsapp_next.fmt.dt(doc.creation) : "", done: true },
				{ key: "start", label: scheduled ? __("Starts by itself") : __("Starts when you press the button"), when: scheduled ? this.when_text() : "", done: false },
				{ key: "end", label: __("Expected to finish"), when: ends, done: false },
			];

			this.$wrapper.html(`
				<div class="wa-cb__stack wa-cb__review">
					<div data-block="verdict"></div>
					<div class="wa-cb__tiles">${tiles.map(tile).join("")}</div>
					<div class="wa-cb__review-grid">
						<section class="wa-cb__rcard" data-block="checks-card">
							<div data-block="checks"></div>
							<div class="wa-cb__rcard-foot" data-block="verbs"></div>
						</section>
						${C.card({ key: "sequence", icon: "chat", title: __("As the recipient will receive it"), note: C.messages_text(per), body: this.thread(), cls: "wa-cb__rcard" })}
						<section class="wa-cb__rcard">
							${C.card({ key: "details", icon: "doc", title: __("Campaign details"), body: `<div class="wa-cb__pairs wa-cb__pairs--one">${details.map(C.pair).join("")}</div>` })}
							${C.card({
								key: "plan",
								icon: "calendar",
								title: __("Timeline"),
								body: `<ol class="wa-cb__timeline wa-cb__timeline--plan">${plan
									.map(
										(p) => `<li class="wa-cb__event${p.done ? "" : " wa-cb__event--todo"}"><span class="wa-cb__event-dot" aria-hidden="true"></span><span class="wa-cb__event-text"><span class="wa-cb__event-label">${esc(p.label)}</span>${p.when ? `<span class="wa-cb__event-when sanad-tabular">${esc(p.when)}</span>` : ""}</span></li>`
									)
									.join("")}</ol>`,
							})}
							${cint(doc.exclude_unknown_numbers) ? C.note({ tone: "warn", icon: "warn", text: __("Unknown numbers are excluded: a recipient who has never had a conversation on WhatsApp is marked and counted, and nothing is sent to them.") }) : ""}
						</section>
					</div>
				</div>`);

			this.checks = new C.Readiness({ wrapper: this.$wrapper.find('[data-block="checks"]'), ctx: this.ctx, title: __("Before it can start") });
			this.render_send();
			return this;
		}

		/** When it should be over, from now or from the scheduled moment. */
		ends_text(minutes) {
			const from = this.ctx.doc.scheduled_at ? frappe.datetime.str_to_obj(this.ctx.doc.scheduled_at) : new Date();
			const end = new Date(from.getTime() + minutes * 60000);
			return frappe.datetime.str_to_user(frappe.datetime.obj_to_str(end)) + " " + String(frappe.datetime.obj_to_str(end)).slice(11, 16);
		}

		/**
		 * The verdict, first: is this campaign ready or not, in one line — and the verbs it offers
		 * right beside it, worded and coloured by the state the campaign is in: a draft that is not
		 * saved asks to be saved; one whose checks fail points at them; a ready one starts or is
		 * scheduled; a scheduled one can start now or drop its schedule.
		 */
		render_send() {
			const ctx = this.ctx;
			const doc = ctx.doc;
			const unsaved = ctx.frm.is_new() || ctx.frm.is_dirty();
			const fresh = ctx.readiness_is_fresh();
			const ready = fresh && ctx.readiness && ctx.readiness.ok;
			const failing = fresh && ctx.readiness ? (ctx.readiness.checks || []).filter((c) => !c.ok) : [];
			const is_scheduled = doc.status === "Scheduled";
			const is_paused = doc.status === "Paused";
			const will_schedule = !!doc.scheduled_at && !is_scheduled;
			const e = ctx.estimate();
			const STEP_OF = { device: 0, messages: 1, attachments: 1, variables: 1, audience: 2 };
			const NAME = { device: () => __("Device connection"), messages: () => __("Messages complete"), attachments: () => __("Attachments available"), variables: () => __("Variables valid"), audience: () => __("Audience ready") };

			let tone;
			let icon;
			let title;
			let line;
			const verbs = [];
			if (unsaved) {
				tone = "muted";
				icon = "clock";
				title = __("Save first, then the checks run");
				line = __("The campaign is checked against the device, the messages and the audience once it is saved.");
				verbs.push({ key: "back", label: __("Back to editing"), variant: "ghost" });
				if (ctx.can_edit()) verbs.push({ key: "save", label: __("Save the campaign"), variant: "primary", icon: "tick" });
			} else if (!fresh) {
				tone = "muted";
				icon = "clock";
				title = __("Checking…");
				line = __("The campaign is checked against the device, the messages and the audience once it is saved.");
				verbs.push({ key: "back", label: __("Back to editing"), variant: "ghost" });
			} else if (is_paused) {
				tone = "warn";
				icon = "clock";
				title = __("Paused — edit, then resume");
				line = ready ? this.plan_text() : failing.map((c) => (NAME[c.key] ? NAME[c.key]() : c.key)).join(" · ");
				verbs.push({ key: "monitor", label: __("Back to monitoring"), variant: "ghost" });
				verbs.push({ key: "resume", label: __("Resume"), variant: "primary", icon: "send", disabled: !ready });
			} else if (is_scheduled) {
				tone = "info";
				icon = "calendar";
				title = __("Scheduled — it starts by itself at {0}", [this.when_text()]);
				line = this.plan_text();
				verbs.push({ key: "unschedule", label: __("Unschedule"), variant: "danger", icon: "x" });
				verbs.push({ key: "start", label: __("Start now"), variant: "primary", icon: "send", disabled: !ready || !e.total });
			} else if (!ready) {
				tone = "danger";
				icon = "warn";
				title = ui.plural(failing.length, { one: __("{0} thing stands in the way", null, "one"), two: __("{0} things stand in the way", null, "two"), few: __("{0} things stand in the way", null, "few"), many: __("{0} things stand in the way", null, "many"), other: __("{0} things stand in the way") });
				line = failing.map((c) => (NAME[c.key] ? NAME[c.key]() : c.key)).join(" · ");
				const first = failing.find((c) => STEP_OF[c.key] !== undefined);
				verbs.push({ key: "fix", label: __("Fix the problems"), variant: "secondary", icon: "warn", step: first ? STEP_OF[first.key] : 0 });
				verbs.push({ key: "start", label: will_schedule ? __("Schedule the campaign") : __("Start the campaign"), variant: "primary", icon: will_schedule ? "calendar" : "send", disabled: true });
			} else {
				tone = will_schedule ? "info" : "ok";
				icon = will_schedule ? "calendar" : "tick";
				title = will_schedule ? __("Ready — it will start by itself at {0}", [this.when_text()]) : __("Ready to start");
				line = this.plan_text();
				verbs.push({ key: "back", label: __("Back to editing"), variant: "ghost" });
				verbs.push({ key: "start", label: will_schedule ? __("Schedule the campaign") : __("Start the campaign"), variant: "primary", icon: will_schedule ? "calendar" : "send", disabled: !e.total });
			}

			const $band = $(`
				<div class="wa-cb__verdict wa-cb__verdict--${tone}">
					<span class="wa-cb__verdict-mark" aria-hidden="true">${ui.ico(icon, "sm")}</span>
					<span class="wa-cb__verdict-text">
						<b>${esc(title)}</b>
						<span dir="auto">${esc(line)}</span>
					</span>
					${K.is_manager() ? `<span class="wa-cb__verdict-verbs">${verbs.map((v) => ui.btn({ label: v.label, icon: v.icon, variant: v.variant, size: "sm", disabled: !!v.disabled, attrs: { "data-verb": v.key, "data-step": v.step === undefined ? "" : String(v.step) } })).join("")}</span>` : ""}
				</div>`);
			this.$wrapper.find('[data-block="verdict"]').empty().append($band);
			this.$wrapper.find('[data-block="verbs"]').empty();
			$band.find("[data-verb]").on("click", (ev) => {
				const key = ev.currentTarget.dataset.verb;
				if (key === "back") return ctx.go(0);
				if (key === "fix") return ctx.go(cint(ev.currentTarget.dataset.step));
				if (key === "save") return ctx.save();
				if (key === "monitor") return ctx.edit(false);
				if (key === "resume") return K.resume(doc, { after: () => { ctx.editing = false; ctx.frm.reload_doc(); } });
				if (key === "unschedule") return K.unschedule(doc, { after: () => ctx.frm.reload_doc() });
				if (key === "start") return is_scheduled ? K.start(doc, { after: () => ctx.frm.reload_doc(), messages: e.per_recipient }) : this.start();
			});
		}

		start() {
			const ctx = this.ctx;
			const doc = ctx.doc;
			const e = ctx.estimate();
			const after = () => ctx.frm.reload_doc();
			if (!doc.scheduled_at) return K.start(doc, { after, messages: e.per_recipient });
			return ui.ConfirmDialog.ask({
				title: __("Schedule {0}?", [doc.campaign_name || doc.name]),
				message: __("The campaign starts by itself at that time and sends at its own rate."),
				impact: [
					{ label: __("Starts at"), value: String(doc.scheduled_at).slice(0, 16) },
					{ label: __("Recipients"), value: C.fmt_int(doc.total_recipients) },
					{ label: __("Messages in total"), value: C.fmt_int(e.total) },
				],
				confirm_label: __("Schedule", null, "campaign"),
				on_confirm: () => ui.call("campaigns.schedule", { name: doc.name, scheduled_at: doc.scheduled_at }),
			})
				.then(() => {
					ui.Toast.success(__("Campaign scheduled"));
					after();
				})
				.catch(() => {});
		}

		/** The sequence as the thread the recipient will see: a bubble per message, the wait between them. */
		thread() {
			const rows = (this.ctx.doc.messages || []).slice().sort((a, b) => cint(a.idx) - cint(b.idx));
			if (!rows.length) return `<p class="wa-cb__readings-foot">${esc(__("No message yet."))}</p>`;
			const TYPE_ICON = { Text: "chat", Image: "eye", Video: "eye", Document: "doc", Audio: "chat", Poll: "table", Location: "pin", Contact: "user" };
			return `<div class="wa-cb__thread">${rows
				.map((m) => {
					const delay = cint(m.delay_seconds);
					const body = (m.body || m.poll_question || m.caption || "").trim();
					// poll options are stored as a JSON list; an older row may hold one per line
					let options = [];
					if (m.message_type === "Poll" && m.poll_options) {
						try {
							options = JSON.parse(m.poll_options);
							if (!Array.isArray(options)) options = [];
						} catch (e) {
							options = String(m.poll_options).split("\n").filter(Boolean);
						}
					}
					return `
					${delay ? `<div class="wa-cb__thread-wait"><span>${esc(__("wait {0}", [delay < 60 ? __("{0}s", [C.fmt_int(delay)]) : C.dur_text(Math.round(delay / 60))]))}</span></div>` : ""}
					<div class="wa-cb__bubble">
						<span class="wa-cb__bubble-type">${ui.ico(TYPE_ICON[m.message_type] || "chat", "xs")}<span>${esc(__(m.message_type))}</span><span class="wa-cb__bubble-num sanad-tabular" dir="ltr">${esc(C.fmt_int(m.idx))}</span></span>
						${m.attachment ? `<span class="wa-cb__bubble-file">${ui.ico("attach", "xs")}<span dir="ltr">${esc(String(m.attachment).split("/").pop())}</span></span>` : ""}
						<span class="wa-cb__bubble-body" dir="auto">${esc(body || (m.attachment ? "" : __("(empty)")))}</span>
						${options.length ? `<span class="wa-cb__bubble-options">${options.map((o) => `<span>${esc(o)}</span>`).join("")}</span>` : ""}
					</div>`;
				})
				.join("")}</div>`;
		}
	};
})();

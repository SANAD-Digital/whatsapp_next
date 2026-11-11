// Test Lab — the place a manager proves that every part of the product works, with real messages
// and the site's own data. It is a bench, not a second product: each check on this screen calls
// the same service the product uses (`testlab.run_check` → quick send, templates, notifications,
// alerts, the command router, the bulk-send campaign), and the screen only arranges them.
//
// There is no prototype for this screen, so it is built from the product's own grammar: the kit's
// `PageHeader`, the `Cards` readings for the summary, the kit's fields / buttons / badges
// (`wa-*`), `PhoneField` for the target numbers, `OverlayPanel` for the history, `ConfirmDialog`
// before anything is sent, `EmptyState` for loading and errors, and the existing drawers for the
// records a run produces.
//
// Anatomy, top to bottom:
//   1. the header and the notice that these are real messages;
//   2. the setup strip — device, target numbers, cap, pacing (defaults come from the site);
//   3. the checks, grouped: connection and setup (read-only health) · messages (quick send,
//      template, notification, alert) · commands (dry-runs, and a live "write from your phone"
//      check) · campaign · receipts;
//   4. the run — every message as a row that goes waiting → sending → sent → delivered / read or
//      failed with its reason, a summary, and a report to copy or download.
//
// All data comes from `testlab.*` (`api/v1/testlab.py`); the cap, the pacing and the recipients
// are enforced by the server. Realtime events refresh a run at once where the bench has them; a
// poll keeps it moving where it does not.

(() => {
	const ROUTE = "wa-test-lab";
	const ui = whatsapp.ui;
	const kit = whatsapp.kit;
	const escape_html = (v) => ui.escape(v == null ? "" : v);
	const format_integer = (v) => ui.format_integer(v);
	const call_test_lab_api = (fn, args, opts) => ui.call(`testlab.${fn}`, args, opts);
	const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
	// a number is shown the way the rest of the product shows it: grouped, left to right, no "+"
	const phone_text = (v) => ui.PhoneField.format_display(v) || cstr(v);
	const phone = (v) => `<bdi dir="ltr">${escape_html(phone_text(v))}</bdi>`;

	// how long a sent message is given to bring its delivery receipt back before the screen says so
	const RECEIPT_TIMEOUT_MS = 180000;
	const LISTEN_MS = 300000;
	// how long a run that has not settled (a queue that is not moving, a campaign still scheduled) is polled
	const FOLLOW_MS = 1200000;
	const STORE_KEY = "wa-test-lab:setup";

	/** The words and the tone of every state a row can be in. */
	const STATES = {
		waiting: { tone: "muted", label: () => __("Waiting", null, "Test Lab") },
		running: { tone: "info", label: () => __("Sending…", null, "Test Lab") },
		scheduled: { tone: "info", label: () => __("Scheduled", null, "Test Lab") },
		sent: { tone: "info", label: () => __("Sent", null, "Test Lab") },
		delivered: { tone: "ok", label: () => __("Delivered", null, "Test Lab") },
		read: { tone: "ok", label: () => __("Read", null, "Test Lab") },
		passed: { tone: "ok", label: () => __("Passed", null, "Test Lab") },
		blocked: { tone: "warn", label: () => __("Blocked", null, "Test Lab") },
		failed: { tone: "danger", label: () => __("Failed", null, "Test Lab") },
		skipped: { tone: "muted", label: () => __("Skipped", null, "Test Lab") },
	};
	const DONE = ["delivered", "read", "passed", "blocked", "failed", "skipped"];
	const state_badge = (state) => {
		const s = STATES[state] || STATES.waiting;
		return kit.badge(s.label(), s.tone);
	};
	const HEALTH = {
		ok: { tone: "ok", icon: "check", label: () => __("Works") },
		warn: { tone: "warn", icon: "warn", label: () => __("Check this") },
		fail: { tone: "danger", icon: "error", label: () => __("Not working") },
	};
	// A status word of a record (a message, a campaign, a command run) the way this screen says it:
	// the screen's own wording where it has one, else the product's.
	const status_word = (v) => __(v, null, "Test Lab");
	const READINESS = {
		device: () => __("Device"),
		messages: () => __("Messages"),
		attachments: () => __("Attachments"),
		variables: () => __("Variables"),
		audience: () => __("Audience"),
	};
	const seconds = (v) => (v == null ? null : __("{0} s", [Number(v).toFixed(1)]));

	const store = {
		read() {
			try {
				return JSON.parse(window.localStorage.getItem(STORE_KEY) || "{}") || {};
			} catch (e) {
				return {};
			}
		},
		write(value) {
			try {
				window.localStorage.setItem(STORE_KEY, JSON.stringify(value));
			} catch (e) {
				// a private window: the setup is simply not remembered
			}
		},
	};

	class TestLab {
		constructor(page) {
			this.page = page;
			this.$main = $(page.main).addClass("whatsapp-kit whatsapp whatsapp-test-lab");
			this.context = null;
			this.targets = []; // [{phone_e164, name, party, party_type, blacklisted}]
			this.rows = []; // the rows of the run on screen
			this.run = null; // {id, …} of the run on screen
			this.status = null; // last `testlab.get_status`
			this.health = null;
			this.running = false;
			this.stopped = false;
			this.docs = {}; // doctype → [{name, title}]
			this.build_page_skeleton();
			this.load_test_lab_context();
		}

		// ---- skeleton -----------------------------------------------------------------------------

		build_page_skeleton() {
			this.$main.html(`
				<div class="whatsapp-test-lab__head"></div>
				<div class="whatsapp-test-lab__body"></div>`);
			this.$head = this.$main.find(".whatsapp-test-lab__head");
			this.$body = this.$main.find(".whatsapp-test-lab__body");
			this.header = new ui.PageHeader({
				wrapper: this.$head,
				title: __("Test Lab"),
				description: __("Try every part of the product with real messages to your own numbers, and see which parts work."),
				secondary: [{ label: __("Earlier runs"), icon: "es-line-time", handler: () => this.open_history() }],
				banner: {
					tone: "amber",
					text: __("These are real WhatsApp messages. They are sent only to the target numbers you set below, and they count against your plan."),
				},
			});
			$(`<span class="whatsapp-test-lab__mark" aria-hidden="true">${kit.inline_icon_html("shield", "md")}</span>`).prependTo(this.header.$el.find(".whatsapp-kit-page-header__row"));
			this.state = new ui.EmptyState({ wrapper: this.$body, state: "loading", rows: 6 });
		}

		load_test_lab_context() {
			this.state.loading({ rows: 6 });
			return call_test_lab_api("get_context")
				.then((context) => {
					this.context = context;
					this.state.hide();
					this.render();
				})
				.catch((err) => {
					const forbidden = err && (err.http_status === 403 || /PermissionError/.test(err.exc_type || ""));
					this.state.error(err, {
						title: forbidden ? __("The Test Lab is for managers") : __("Could not open the Test Lab"),
						description: forbidden ? __("It sends real messages, so it needs the WhatsApp Manager role.") : err.message,
						action: forbidden ? null : { label: __("Retry"), on_click: () => this.load_test_lab_context() },
					});
				});
		}

		render() {
			const context = this.context;
			const saved = store.read();
			const devices = context.devices || [];
			const connected = devices.find((d) => d.status === "Connected");
			this.device = (devices.find((d) => d.name === saved.device) || {}).name || context.default_device || (connected || devices[0] || {}).name || null;
			this.cap = Math.min(cint(saved.cap) || context.limits.cap, context.limits.cap_max);
			this.pacing = Math.max(context.limits.pacing_min, Math.min(cint(saved.pacing) || context.limits.pacing, context.limits.pacing_max));
			this.$body.html(`
				<section class="whatsapp-test-lab__section" data-section="setup" aria-labelledby="whatsapp-lab-setup-t">
					${this.section_title("whatsapp-lab-setup-t", __("What the test runs with"), __("Filled in from your system — change what you need."))}
					<div class="whatsapp-card whatsapp-test-lab__setup"></div>
				</section>
				<section class="whatsapp-test-lab__section" data-section="health" aria-labelledby="whatsapp-lab-health-t">
					${this.section_title("whatsapp-lab-health-t", __("Connection and setup"), __("Read-only checks. Nothing is sent."))}
					<div class="whatsapp-card whatsapp-test-lab__health"></div>
				</section>
				<section class="whatsapp-test-lab__section" data-section="messages" aria-labelledby="whatsapp-lab-msg-t">
					${this.section_title("whatsapp-lab-msg-t", __("Messages"), __("Each ticked check sends one message to every target number."))}
					<div class="whatsapp-test-lab__grid" data-grid="messages"></div>
				</section>
				<section class="whatsapp-test-lab__section" data-section="commands" aria-labelledby="whatsapp-lab-cmd-t">
					${this.section_title("whatsapp-lab-cmd-t", __("Commands"), __("What a customer gets back when they write a command."))}
					<div class="whatsapp-test-lab__grid whatsapp-test-lab__grid--wide" data-grid="commands"></div>
				</section>
				<section class="whatsapp-test-lab__section" data-section="campaign" aria-labelledby="whatsapp-lab-camp-t">
					${this.section_title("whatsapp-lab-camp-t", __("Campaign and receipts"), __("A small campaign to the target numbers, and the way back from WhatsApp."))}
					<div class="whatsapp-test-lab__grid" data-grid="campaign"></div>
				</section>
				<section class="whatsapp-test-lab__section" data-section="run" aria-labelledby="whatsapp-lab-run-t">
					${this.section_title("whatsapp-lab-run-t", __("The run"), __("Every message of the run, from sending to its delivery receipt."))}
					<div class="whatsapp-test-lab__summary"></div>
					<div class="whatsapp-card whatsapp-test-lab__run"></div>
				</section>
				<div class="whatsapp-test-lab__bar" role="region" aria-label="${escape_html(__("Run"))}"></div>`);
			this.$setup = this.$body.find(".whatsapp-test-lab__setup");
			this.$health = this.$body.find(".whatsapp-test-lab__health");
			this.$summary = this.$body.find(".whatsapp-test-lab__summary");
			this.$run = this.$body.find(".whatsapp-test-lab__run");
			this.$bar = this.$body.find(".whatsapp-test-lab__bar");
			this.render_setup();
			this.render_checks();
			this.render_run();
			this.render_bar();
			this.load_health(false);
			const start = (saved.targets && saved.targets.length ? saved.targets : [ui.test_phone.get() || (context.me && context.me.phone)]).filter(Boolean);
			if (start.length) this.add_targets(start, { quiet: true });
			this.subscribe();
		}

		section_title(id, title, note) {
			return `<div class="whatsapp-test-lab__section-head"><h3 id="${id}" class="whatsapp-test-lab__section-title">${escape_html(title)}</h3><span class="whatsapp-test-lab__section-note">${escape_html(note)}</span></div>`;
		}

		// ---- setup strip --------------------------------------------------------------------------

		devices() {
			return (this.context && this.context.devices) || [];
		}

		current_device() {
			return this.devices().find((d) => d.name === this.device) || null;
		}

		render_setup() {
			const limits = this.context.limits;
			const devices = this.devices();
			this.$setup.html(`
				<div class="whatsapp-test-lab__setup-grid">
					<div class="whatsapp-field whatsapp-test-lab__f-device">
						<label class="whatsapp-field__label" for="whatsapp-lab-device">${escape_html(__("Sending device"))}</label>
						${
							devices.length
								? `<select id="whatsapp-lab-device" class="whatsapp-select">${devices
										.map((d) => `<option value="${escape_html(d.name)}"${d.name === this.device ? " selected" : ""}>${escape_html(d.device_name || d.name)}</option>`)
										.join("")}</select>`
								: `<button type="button" class="whatsapp-button whatsapp-button--secondary" data-act="pair">${escape_html(__("Pair a device"))}</button>`
						}
						<span class="whatsapp-field__hint whatsapp-test-lab__device-state"></span>
					</div>
					<div class="whatsapp-field whatsapp-test-lab__f-targets">
						<span class="whatsapp-field__label" id="whatsapp-lab-targets-l">${escape_html(__("Target numbers"))}</span>
						<div class="whatsapp-test-lab__targets" role="list" aria-labelledby="whatsapp-lab-targets-l"></div>
						<div class="whatsapp-test-lab__target-add">
							<div class="whatsapp-test-lab__target-field"></div>
							${kit.button_html({ label: __("Add"), icon: "plus", variant: "tonal", attrs: { "data-act": "add-target" } })}
						</div>
						<span class="whatsapp-field__hint">${escape_html(__("Your own numbers. Up to {0}; nothing is ever sent to anyone else.", [format_integer(limits.max_targets)]))}</span>
					</div>
					<div class="whatsapp-field whatsapp-test-lab__f-cap">
						<label class="whatsapp-field__label" for="whatsapp-lab-cap">${escape_html(__("Message cap"))}</label>
						<input id="whatsapp-lab-cap" class="whatsapp-input whatsapp-input--mono" type="number" inputmode="numeric" min="1" max="${limits.cap_max}" value="${this.cap}" />
						<span class="whatsapp-field__hint">${escape_html(__("The most one run may send (at most {0}).", [format_integer(limits.cap_max)]))}</span>
					</div>
					<div class="whatsapp-field whatsapp-test-lab__f-pacing">
						<label class="whatsapp-field__label" for="whatsapp-lab-pacing">${escape_html(__("Seconds between messages"))}</label>
						<input id="whatsapp-lab-pacing" class="whatsapp-input whatsapp-input--mono" type="number" inputmode="numeric" min="${limits.pacing_min}" max="${limits.pacing_max}" value="${this.pacing}" />
						<span class="whatsapp-field__hint">${escape_html(__("A pause that keeps the number safe (at least {0}).", [format_integer(limits.pacing_min)]))}</span>
					</div>
				</div>`);
			const device = this.current_device();
			this.phone_field = new ui.PhoneField({
				wrapper: this.$setup.find(".whatsapp-test-lab__target-field"),
				label: "",
				placeholder: __("Mobile number"),
			});
			// the field is drawn without its own label (the group's label names it), so it is named here
			this.$setup.find(".whatsapp-test-lab__target-field input[type='tel']").attr("aria-label", __("Mobile number"));
			// a tester's number is most often in the device's own country: let the field take the
			// country from the device's number, then hand it back empty
			if (device && device.phone_e164) {
				this.phone_field.set_value(device.phone_e164);
				this.phone_field.set_value("");
			}
			this.$setup.find('[data-act="pair"]').on("click", () => frappe.set_route("wa-devices"));
			this.$setup.find("#whatsapp-lab-device").on("change", (e) => {
				this.device = $(e.currentTarget).val();
				this.render_device_state();
				this.remember();
				this.load_health(false);
				this.render_phone_hint();
			});
			this.$setup.find('[data-act="add-target"]').on("click", () => this.add_typed_target());
			this.$setup.find(".whatsapp-test-lab__target-field").on("keydown", "input", (e) => {
				if (e.key !== "Enter") return;
				e.preventDefault();
				this.add_typed_target();
			});
			this.$setup.find("#whatsapp-lab-cap").on("change", (e) => {
				this.cap = Math.max(1, Math.min(cint($(e.currentTarget).val()) || limits.cap, limits.cap_max));
				$(e.currentTarget).val(this.cap);
				this.remember();
				this.render_bar();
			});
			this.$setup.find("#whatsapp-lab-pacing").on("change", (e) => {
				this.pacing = Math.max(limits.pacing_min, Math.min(cint($(e.currentTarget).val()) || limits.pacing, limits.pacing_max));
				$(e.currentTarget).val(this.pacing);
				this.remember();
				this.render_bar();
			});
			this.render_device_state();
			this.render_targets();
		}

		render_device_state() {
			const d = this.current_device();
			const $s = this.$setup.find(".whatsapp-test-lab__device-state");
			if (!d) return $s.html(escape_html(__("No device is set up yet.")));
			const on = d.status === "Connected";
			$s.html(`${kit.badge(on ? __("Connected") : __(d.status || "Disconnected"), on ? "ok" : "warn")} ${d.phone_e164 ? phone(d.phone_e164) : ""}`);
		}

		remember() {
			store.write({ device: this.device, cap: this.cap, pacing: this.pacing, targets: this.targets.map((t) => t.phone_e164) });
		}

		add_typed_target() {
			const v = this.phone_field.get_value();
			if (!v || v.empty) return ui.Toast.warning(__("Type a mobile number first."));
			// a whole international number typed into the national field (967 77…): the server, which
			// has the last word on a number anyway, is asked about it as typed
			const typed = cstr(v.national || v.phone).replace(/[^\d]/g, "");
			const candidate = v.valid ? v.phone_e164 : typed.length >= 10 ? `+${typed}` : null;
			if (!candidate) return ui.Toast.warning(__("This number is not complete."));
			this.add_targets([candidate]).then((added) => added && this.phone_field.set_value(""));
		}

		/** Ask the server who the numbers are, then keep the valid, new, unblocked ones. */
		add_targets(phones, { quiet = false } = {}) {
			const max_targets = this.context.limits.max_targets;
			return call_test_lab_api("identify", { phones }, { silent: true })
				.then((rows) => {
					let added = 0;
					(rows || []).forEach((r) => {
						if (!r.valid) return quiet || ui.Toast.warning(__("{0} is not a valid WhatsApp number.", [r.input]));
						if (this.targets.some((t) => t.phone_e164 === r.phone_e164)) return quiet || ui.Toast.info(__("This number is already a target."));
						if (r.blacklisted) return ui.Toast.warning(__("{0} is on the blacklist and cannot be a test target.", [phone_text(r.phone_e164)]));
						if (this.targets.length >= max_targets) return quiet || ui.Toast.warning(__("A test run takes at most {0} target numbers.", [format_integer(max_targets)]));
						this.targets.push(r);
						added += 1;
						// a number the user typed is the one a test goes to: offered first everywhere else
						if (!quiet) ui.test_phone.set(r.phone_e164);
					});
					if (added) this.targets_changed();
					return added;
				})
				.catch((err) => {
					if (!quiet) ui.Toast.error(err);
					return 0;
				});
		}

		targets_changed() {
			this.remember();
			this.render_targets();
			this.render_senders();
			this.render_phone_hint();
			this.render_bar();
		}

		render_targets() {
			const $t = this.$setup.find(".whatsapp-test-lab__targets");
			if (!this.targets.length) {
				$t.html(`<span class="whatsapp-test-lab__targets-none">${escape_html(__("No target yet — add the number that should receive the test."))}</span>`);
				return;
			}
			$t.html(
				this.targets
					.map((t) => {
						const who = [t.name, t.party ? `${__(t.party_type)}: ${t.party}` : t.contact ? __("Not linked to an account") : __("Not saved as a contact")].filter(Boolean).join(" · ");
						return `<span class="whatsapp-test-lab__target" role="listitem">
							<span class="whatsapp-test-lab__target-text"><strong>${phone(t.phone_e164)}</strong><span>${escape_html(who)}</span></span>
							<button type="button" class="whatsapp-test-lab__target-x" data-remove="${escape_html(t.phone_e164)}" aria-label="${escape_html(__("Remove {0}", [phone_text(t.phone_e164)]))}" title="${escape_html(__("Remove"))}">${kit.inline_icon_html("x", "xs")}</button>
						</span>`;
					})
					.join("")
			);
			$t.find("[data-remove]").on("click", (e) => {
				const key = $(e.currentTarget).attr("data-remove");
				this.targets = this.targets.filter((t) => t.phone_e164 !== key);
				this.targets_changed();
			});
		}

		// ---- health -------------------------------------------------------------------------------

		load_health(live) {
			const state = new ui.EmptyState({ wrapper: this.$health.empty(), state: "loading", rows: 4 });
			return call_test_lab_api("get_health", { device: this.device, live: live ? 1 : 0 }, { silent: true })
				.then((health) => {
					this.health = health;
					state.hide();
					this.render_health();
					return health;
				})
				.catch((err) => {
					state.error(err, { title: __("Could not read the setup"), action: { label: __("Retry"), on_click: () => this.load_health(live) } });
					return null;
				});
		}

		render_health() {
			const health = this.health;
			const counts = { ok: 0, warn: 0, fail: 0 };
			health.checks.forEach((c) => (counts[c.status] = (counts[c.status] || 0) + 1));
			const overall = counts.fail ? "fail" : counts.warn ? "warn" : "ok";
			const headline = counts.fail
				? ui.plural(counts.fail, { one: __("{0} part of the setup is not working"), other: __("{0} parts of the setup are not working") })
				: counts.warn
				? ui.plural(counts.warn, { one: __("The setup works, with {0} thing to check"), other: __("The setup works, with {0} things to check") })
				: __("The setup is ready to send and to hear back");
			this.$health.html(`
				<div class="whatsapp-test-lab__health-head">
					<label class="whatsapp-check"><input type="checkbox" data-check="health"${this.health_on === false ? "" : " checked"} /><span>${escape_html(__("Run these checks first"))}</span></label>
					<span class="whatsapp-test-lab__health-line">${kit.badge(HEALTH[overall].label(), HEALTH[overall].tone)}<strong>${escape_html(headline)}</strong></span>
					${kit.button_html({ label: __("Run the checks"), icon: "scan", variant: "tonal", size: "sm", attrs: { "data-act": "health" } })}
				</div>
				<ul class="whatsapp-test-lab__health-list">${health.checks.map((c) => this.health_row(c)).join("")}</ul>
				<p class="whatsapp-test-lab__health-foot">${escape_html(
					health.live ? __("Checked now against the platform.") : __("Shown from the last known state. «Run the checks» asks the platform now.")
				)}</p>`);
			this.$health.find('[data-act="health"]').on("click", (e) => {
				const $b = $(e.currentTarget).prop("disabled", true);
				this.load_health(true).then((r) => {
					$b.prop("disabled", false);
					if (r) ui.announce(headline);
				});
			});
			this.$health.find("[data-route]").on("click", (e) => {
				const c = health.checks.find((x) => x.key === $(e.currentTarget).attr("data-route"));
				if (!c || !c.route) return;
				if (Array.isArray(c.route)) frappe.set_route(...c.route);
				else frappe.set_route(c.route);
			});
			this.$health.find('[data-check="health"]').on("change", (e) => {
				this.health_on = e.currentTarget.checked;
				this.render_bar();
			});
		}

		health_row(c) {
			const s = HEALTH[c.status] || HEALTH.warn;
			return `<li class="whatsapp-test-lab__health-row whatsapp-test-lab__health-row--${c.status}">
				<span class="whatsapp-test-lab__health-ico whatsapp-test-lab__tone--${s.tone}" aria-hidden="true">${kit.inline_icon_html(s.icon, "sm")}</span>
				<span class="whatsapp-test-lab__health-text">
					<span class="whatsapp-test-lab__health-title">${escape_html(c.title)}<span class="whatsapp-kit-visually-hidden"> — ${escape_html(s.label())}</span></span>
					<span class="whatsapp-test-lab__health-detail">${escape_html(c.detail)}</span>
					${c.fix ? `<span class="whatsapp-test-lab__health-fix">${escape_html(c.fix)}</span>` : ""}
				</span>
				${c.route && c.status !== "ok" ? kit.button_html({ label: c.route_label || __("Open"), variant: "secondary", size: "sm", attrs: { "data-route": c.key } }) : ""}
			</li>`;
		}

		// ---- the checks ---------------------------------------------------------------------------

		/** One check card: a tick to include it, what it does, its own picker, and its result. */
		check_card_html({ key, title, note, body = "", checked = true, wide = false }) {
			return `<article class="whatsapp-card whatsapp-test-lab__check${wide ? " whatsapp-test-lab__check--wide" : ""}" data-card="${key}">
				<header class="whatsapp-test-lab__check-head">
					<label class="whatsapp-check whatsapp-test-lab__check-pick"><input type="checkbox" data-check="${key}"${checked ? " checked" : ""} /><span class="whatsapp-test-lab__check-title">${escape_html(title)}</span></label>
					<span class="whatsapp-test-lab__check-state" data-state="${key}"></span>
				</header>
				<p class="whatsapp-test-lab__check-note">${escape_html(note)}</p>
				<div class="whatsapp-test-lab__check-body">${body}</div>
			</article>`;
		}

		labelled_field_html(label, control, hint) {
			return `<label class="whatsapp-field"><span class="whatsapp-field__label">${escape_html(label)}</span>${control}${hint ? `<span class="whatsapp-field__hint">${escape_html(hint)}</span>` : ""}</label>`;
		}

		select_options_html(rows, { value = "name", label, empty } = {}) {
			return (empty ? `<option value="">${escape_html(empty)}</option>` : "") + rows.map((r) => `<option value="${escape_html(r[value])}">${escape_html(label ? label(r) : r[value])}</option>`).join("");
		}

		render_checks() {
			const context = this.context;
			const render_empty_note = (text, route_label, route) =>
				`<p class="whatsapp-test-lab__none">${escape_html(text)} <button type="button" class="whatsapp-test-lab__link" data-go='${escape_html(JSON.stringify(route))}'>${escape_html(route_label)}</button></p>`;
			const file_row = (kind) => `
				<div class="whatsapp-test-lab__file" data-file="${kind}">
					<span class="whatsapp-test-lab__file-name" data-file-name>${escape_html(__("The app's sample file ({0})", [context.samples[kind].file_name]))}</span>
					${kit.button_html({ label: __("Pick another file"), icon: "attach", variant: "ghost", size: "sm", attrs: { "data-act": "pick-file", "data-kind": kind } })}
				</div>`;
			const preview_box = (key) => `
				<div class="whatsapp-test-lab__actions">${kit.button_html({ label: __("Preview"), icon: "search", variant: "tonal", size: "sm", attrs: { "data-act": "preview", "data-kind": key } })}</div>
				<div class="whatsapp-test-lab__preview" data-preview="${key}" hidden></div>`;
			const doc_field = (key) => `
				<label class="whatsapp-field" data-doc-field="${key}" hidden>
					<span class="whatsapp-field__label" data-doc-label></span>
					<input class="whatsapp-input whatsapp-input--mono" type="text" data-doc="${key}" list="whatsapp-lab-docs-${key}" autocomplete="off" />
					<datalist id="whatsapp-lab-docs-${key}"></datalist>
					<span class="whatsapp-field__hint" data-doc-hint>${escape_html(__("A real record from your system. The newest one you can read is filled in."))}</span>
				</label>`;

			// -- messages
			const messages = [
				this.check_card_html({
					key: "quick_text",
					title: __("Quick text"),
					note: __("One plain text message, the way «Quick send» sends it."),
					body: this.labelled_field_html(__("Message text"), `<textarea class="whatsapp-textarea" rows="2" data-input="quick_text">${escape_html(__("Test Lab · test message"))}</textarea>`),
				}),
				this.check_card_html({
					key: "quick_image",
					title: __("Image"),
					note: __("An image with a caption."),
					checked: false,
					body: file_row("image") + this.labelled_field_html(__("Caption"), `<input class="whatsapp-input" type="text" data-input="quick_image" value="${escape_html(__("Test Lab · test image"))}" />`),
				}),
				this.check_card_html({
					key: "quick_document",
					title: __("Document", null, "Test Lab"),
					note: __("A PDF file with a caption."),
					checked: false,
					body: file_row("document") + this.labelled_field_html(__("Caption"), `<input class="whatsapp-input" type="text" data-input="quick_document" value="${escape_html(__("Test Lab · test document"))}" />`),
				}),
				this.check_card_html({
					key: "template",
					title: __("Template"),
					note: __("A message template filled from a real record."),
					checked: !!context.templates.length,
					body: context.templates.length
						? this.labelled_field_html(__("Template"), `<select class="whatsapp-select" data-pick="template">${this.select_options_html(context.templates, { label: (t) => t.template_name || t.name })}</select>`) + doc_field("template") + preview_box("template")
						: render_empty_note(__("No message template yet."), __("Open templates"), ["List", "WhatsApp Template"]),
				}),
				this.check_card_html({
					key: "notification",
					title: __("Notification", null, "Test Lab"),
					note: __("An automatic notification, tried on a real record and sent to your target numbers instead of the customer."),
					checked: !!context.notifications.length,
					body: context.notifications.length
						? this.labelled_field_html(
								__("Notification", null, "Test Lab"),
								`<select class="whatsapp-select" data-pick="notification">${this.select_options_html(context.notifications, { label: (n) => (cint(n.enabled) ? n.name : __("{0} (switched off)", [n.name])) })}</select>`
						  ) +
						  doc_field("notification") +
						  `<label class="whatsapp-toggle whatsapp-test-lab__real"><input type="checkbox" data-real="notification" /><span class="whatsapp-toggle__track"></span><span class="whatsapp-toggle__label">${escape_html(
								__("Send to the record's real recipients instead")
						  )}</span></label>` +
						  preview_box("notification")
						: render_empty_note(__("No notification yet."), __("Open notifications"), ["List", "WhatsApp Notification"]),
				}),
				this.check_card_html({
					key: "alert",
					title: __("Scheduled alert"),
					note: __("A scheduled alert, run now and sent to your target numbers only."),
					checked: false,
					body: context.alerts.length
						? this.labelled_field_html(__("Alert"), `<select class="whatsapp-select" data-pick="alert">${this.select_options_html(context.alerts, { label: (a) => (cint(a.enabled) ? a.name : __("{0} (switched off)", [a.name])) })}</select>`) + preview_box("alert")
						: render_empty_note(__("No scheduled alert yet."), __("Open alerts"), ["List", "WhatsApp Notification Alert"]),
				}),
			];
			this.$body.find('[data-grid="messages"]').html(messages.join(""));

			// -- commands
			const commands = context.commands || [];
			const command_rows = commands
				.map(
					(cmd, i) => `<li class="whatsapp-test-lab__cmd" data-cmd="${escape_html(cmd.code)}">
						<label class="whatsapp-check"><input type="checkbox" data-cmd-pick="${escape_html(cmd.code)}"${i < 8 ? " checked" : ""} /><span class="whatsapp-kit-visually-hidden">${escape_html(__("Try {0}", [cmd.code]))}</span></label>
						<span class="whatsapp-test-lab__cmd-text">
							<input class="whatsapp-input whatsapp-test-lab__cmd-input" type="text" dir="auto" data-cmd-text="${escape_html(cmd.code)}" value="${escape_html(cmd.code)}" aria-label="${escape_html(__("The message to try for {0}", [cmd.code]))}" />
							<span class="whatsapp-test-lab__cmd-note">${escape_html([cmd.title && cmd.title !== cmd.code ? cmd.title : "", cint(cmd.requires_linked_contact) ? __("needs a linked account") : ""].filter(Boolean).join(" · "))}</span>
						</span>
						<span class="whatsapp-test-lab__cmd-result" data-cmd-result="${escape_html(cmd.code)}"></span>
					</li>`
				)
				.join("");
			const commands_card = this.check_card_html({
				key: "commands",
				title: __("Dry-run the commands"),
				note: __("Each ticked command is run as if the chosen number had written it. Nothing is stored and nothing is sent — you see the reply the customer would get."),
				checked: !!commands.length && !!context.commands_enabled,
				wide: true,
				body: commands.length
					? `<div class="whatsapp-test-lab__cmd-setup">
							${this.labelled_field_html(__("Written by"), `<select class="whatsapp-select" data-pick="sender"></select>`, __("A command answers a number with its own account's records."))}
							<label class="whatsapp-toggle whatsapp-test-lab__real"><input type="checkbox" data-real="command" /><span class="whatsapp-toggle__track"></span><span class="whatsapp-toggle__label">${escape_html(__("Also send the reply to that number for real"))}</span></label>
						</div>
						${context.commands_enabled ? "" : `<p class="whatsapp-test-lab__warn">${escape_html(__("Commands are switched off in the settings: a real message would get no reply."))}</p>`}
						<ul class="whatsapp-test-lab__cmds">${command_rows}</ul>`
					: render_empty_note(__("No active command yet."), __("Open commands"), ["List", "WhatsApp Command"]),
			});
			const phone_card = `<article class="whatsapp-card whatsapp-test-lab__check whatsapp-test-lab__check--wide" data-card="listen">
				<header class="whatsapp-test-lab__check-head">
					<span class="whatsapp-test-lab__check-title">${escape_html(__("Try it from your phone"))}</span>
					<span class="whatsapp-test-lab__check-state" data-state="listen"></span>
				</header>
				<p class="whatsapp-test-lab__check-note" data-phone-hint></p>
				<div class="whatsapp-test-lab__check-body">
					<div class="whatsapp-test-lab__words">${commands.map((cmd) => `<code class="whatsapp-test-lab__word" dir="auto">${escape_html(cmd.code)}</code>`).join("")}</div>
					<div class="whatsapp-test-lab__actions">${kit.button_html({ label: __("Listen for my message"), icon: "chat", variant: "tonal", size: "sm", attrs: { "data-act": "listen" } })}</div>
					<div class="whatsapp-test-lab__inbound" data-inbound aria-live="polite"></div>
				</div>
			</article>`;
			this.$body.find('[data-grid="commands"]').html(commands_card + phone_card);

			// -- campaign and receipts
			const text_templates = context.templates.filter((t) => t.message_type === "Text" && !t.reference_doctype);
			const campaign = this.check_card_html({
				key: "campaign",
				title: __("Mini campaign"),
				note: __("One campaign to all the target numbers through the bulk-send path: readiness, start, progress to completion."),
				checked: false,
				body: `
					${kit.segmented(
						[
							{ value: "text", label: __("Text") },
							{ value: "image", label: __("Image") },
							...(text_templates.length ? [{ value: "template", label: __("Template") }] : []),
						],
						"text",
						{ label: __("What the campaign sends") }
					)}
					<div data-camp="text">${this.labelled_field_html(__("Message text"), `<textarea class="whatsapp-textarea" rows="2" data-input="campaign">${escape_html(__("Test Lab · test campaign"))}</textarea>`)}</div>
					<div data-camp="template" hidden>${this.labelled_field_html(__("Template"), `<select class="whatsapp-select" data-pick="campaign_template">${this.select_options_html(text_templates, { label: (t) => t.template_name || t.name })}</select>`)}</div>
					<label class="whatsapp-toggle whatsapp-test-lab__real"><input type="checkbox" data-real="schedule" /><span class="whatsapp-toggle__track"></span><span class="whatsapp-toggle__label">${escape_html(
						__("Schedule it {0} minutes ahead instead of starting now", [format_integer(context.limits.schedule_minutes)])
					)}</span></label>
					<span class="whatsapp-field__hint">${escape_html(__("A scheduled campaign is started by the scheduler, so this also proves the scheduler works."))}</span>`,
			});
			const receipts = `<article class="whatsapp-card whatsapp-test-lab__check" data-card="receipts">
				<header class="whatsapp-test-lab__check-head">
					<span class="whatsapp-test-lab__check-title">${escape_html(__("Delivery and read receipts"))}</span>
					<span class="whatsapp-test-lab__check-state" data-state="receipts"></span>
				</header>
				<p class="whatsapp-test-lab__check-note">${escape_html(__("A receipt is WhatsApp telling this site that a message arrived or was read. It is checked on the messages of the run — there is nothing to tick."))}</p>
				<div class="whatsapp-test-lab__check-body" data-receipts></div>
			</article>`;
			this.$body.find('[data-grid="campaign"]').html(campaign + receipts);

			this.camp_mode = "text";
			kit.bind_segmented(this.$body.find('[data-card="campaign"] .whatsapp-segmented'), (v) => {
				this.camp_mode = v;
				this.$body.find('[data-camp="text"]').prop("hidden", v === "template");
				this.$body.find('[data-camp="template"]').prop("hidden", v !== "template");
				this.render_bar();
			});
			this.files = {};
			this.bind_checks();
			this.render_senders();
			this.render_phone_hint();
			this.render_receipts();
			["template", "notification"].forEach((key) => this.sync_document(key));
		}

		bind_checks() {
			const $body = this.$body;
			$body.on("change", "[data-check], [data-cmd-pick], [data-real]", () => this.render_bar());
			$body.on("click", "[data-go]", (e) => frappe.set_route(...JSON.parse($(e.currentTarget).attr("data-go"))));
			$body.on("change", '[data-pick="template"]', () => this.sync_document("template"));
			$body.on("change", '[data-pick="notification"]', () => this.sync_document("notification"));
			$body.on("change", '[data-pick="template"], [data-pick="notification"], [data-pick="alert"], [data-doc]', (e) => {
				const key = $(e.currentTarget).attr("data-pick") || $(e.currentTarget).attr("data-doc");
				$body.find(`[data-preview="${key}"]`).prop("hidden", true).empty();
			});
			$body.on(
				"input",
				"[data-doc]",
				ui.debounce((e) => this.search_documents($(e.currentTarget).attr("data-doc"), $(e.currentTarget).val()), 300)
			);
			$body.on("click", '[data-act="preview"]', (e) => this.show_check_preview($(e.currentTarget).attr("data-kind"), $(e.currentTarget)));
			$body.on("click", '[data-act="pick-file"]', (e) => this.pick_file($(e.currentTarget).attr("data-kind")));
			$body.on("click", '[data-act="listen"]', () => this.listen());
			$body.on("change", '[data-real="notification"]', (e) => {
				if (e.currentTarget.checked) ui.Toast.warning(__("The notification will go to the record's real recipients — customers included. You will be asked to confirm."));
			});
		}

		/** The reference DocType of what is picked decides which records the document field offers. */
		doctype_of(key) {
			const name = this.$body.find(`[data-pick="${key}"]`).val();
			if (key === "template") return ((this.context.templates || []).find((t) => t.name === name) || {}).reference_doctype || null;
			return ((this.context.notifications || []).find((n) => n.name === name) || {}).document_type || null;
		}

		sync_document(key) {
			const doctype = this.doctype_of(key);
			const $f = this.$body.find(`[data-doc-field="${key}"]`);
			if (!$f.length) return;
			$f.prop("hidden", !doctype);
			if (!doctype) return;
			$f.find("[data-doc-label]").text(__("{0} to try it on", [__(doctype)]));
			$f.find("[data-doc]").val("");
			this.search_documents(key, "", { fill: true });
		}

		search_documents(key, txt, { fill = false } = {}) {
			const doctype = this.doctype_of(key);
			if (!doctype) return;
			const $f = this.$body.find(`[data-doc-field="${key}"]`);
			call_test_lab_api("search_documents", { doctype, txt: txt || null }, { silent: true })
				.then((r) => {
					if (this.doctype_of(key) !== doctype) return;
					const rows = (r && r.rows) || [];
					$f.find("datalist").html(rows.map((d) => `<option value="${escape_html(d.name)}">${escape_html(d.title || "")}</option>`).join(""));
					const $hint = $f.find("[data-doc-hint]");
					if (r && r.no_access) $hint.text(__("You cannot read {0} records, so this check cannot run.", [__(doctype)]));
					else if (!rows.length && !txt) $hint.text(__("There is no {0} in the system yet.", [__(doctype)]));
					else $hint.text(__("A real record from your system. The newest one you can read is filled in."));
					if (fill && rows.length && !$f.find("[data-doc]").val()) $f.find("[data-doc]").val(rows[0].name);
				})
				.catch(() => {});
		}

		pick_file(kind) {
			new frappe.ui.FileUploader({
				allow_multiple: false,
				make_attachments_public: false,
				restrictions: { allowed_file_types: kind === "image" ? ["image/*"] : [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv", ".txt"] },
				on_success: (file) => {
					this.files[kind] = file.file_url;
					this.$body.find(`[data-file="${kind}"] [data-file-name]`).text(file.file_name || file.file_url);
				},
			});
		}

		render_senders() {
			const $s = this.$body.find('[data-pick="sender"]');
			if (!$s.length) return;
			const current = $s.val();
			$s.html(
				this.targets.length
					? this.targets.map((t) => `<option value="${escape_html(t.phone_e164)}">${escape_html([phone_text(t.phone_e164), t.name, t.party].filter(Boolean).join(" · "))}</option>`).join("")
					: `<option value="">${escape_html(__("Add a target number first"))}</option>`
			);
			if (current && this.targets.some((t) => t.phone_e164 === current)) $s.val(current);
		}

		render_phone_hint() {
			const d = this.current_device();
			const $h = this.$body.find("[data-phone-hint]");
			if (!$h.length) return;
			const to = d && d.phone_e164 ? phone(d.phone_e164) : escape_html(__("the device's number"));
			const from = this.targets.length ? this.targets.map((t) => phone(t.phone_e164)).join(escape_html(__(" or "))) : escape_html(__("a target number"));
			$h.html(__("Write one of these words on WhatsApp from {0} to {1}, then watch it arrive and be answered here.", [from, to]));
		}

		// ---- previews -----------------------------------------------------------------------------

		show_check_preview(kind, $btn) {
			const $p = this.$body.find(`[data-preview="${kind}"]`).prop("hidden", false);
			const state = new ui.EmptyState({ wrapper: $p.empty(), state: "loading", rows: 2, size: "sm" });
			const params = this.params_of(kind);
			$btn.prop("disabled", true);
			call_test_lab_api("preview", { kind, params, target: (this.targets[0] || {}).phone_e164 || null }, { silent: true })
				.then((r) => {
					state.hide();
					$p.html(this.preview_html(kind, r || {}));
				})
				.catch((err) => state.error(err, { title: __("Could not build the preview") }))
				.then(() => $btn.prop("disabled", false));
		}

		preview_html(kind, r) {
			const facts = [];
			const problems = [];
			let message = r.message;
			if (kind === "template") {
				if (r.reference_name) facts.push([__("Record"), r.reference_name]);
				if (r.attachment) facts.push([__("Carries"), r.attachment.print_format ? __("A PDF print ({0})", [r.attachment.print_format]) : status_word(r.attachment.message_type)]);
				(r.errors || []).forEach((e) => problems.push(e));
			} else if (kind === "notification") {
				if (r.no_access) problems.push(__("You cannot read this notification's records."));
				if (r.problem) problems.push(r.problem);
				if (r.reference_name) facts.push([__("Record"), r.reference_name]);
				if (r.reference_name) facts.push([__("Condition", null, "Test Lab"), r.meets_condition ? __("Holds for this record") : __("Does not hold for this record")]);
				facts.push([__("Real recipients"), `${format_integer(r.recipients_count || 0)}${(r.recipients || []).length ? ` (${r.recipients.map((x) => x.phone_e164).join(", ")})` : ""}`]);
				if (r.attachment) facts.push([__("Carries"), r.attachment.file_name || status_word(r.attachment.message_type)]);
				if (r.error) problems.push(r.error);
			} else if (kind === "alert") {
				if (r.problem) problems.push(r.problem);
				facts.push([__("Rows in the report"), format_integer(r.row_count || 0)]);
				facts.push([__("Real recipients"), format_integer(r.recipients_count || 0)]);
				if (r.attachment) facts.push([__("Carries"), r.attachment.file_name]);
				if ((r.next_runs || []).length) facts.push([__("Next run"), frappe.datetime.str_to_user(r.next_runs[0])]);
				if (r.error) problems.push(r.error);
			}
			return `
				${problems.map((p) => `<p class="whatsapp-test-lab__warn" role="alert">${escape_html(p)}</p>`).join("")}
				${message ? `<div class="whatsapp-test-lab__bubble" dir="auto">${escape_html(message)}</div>` : problems.length ? "" : `<p class="whatsapp-test-lab__none">${escape_html(__("The message is empty."))}</p>`}
				<dl class="whatsapp-test-lab__facts">${facts.map((f) => `<div><dt>${escape_html(f[0])}</dt><dd dir="auto">${escape_html(f[1])}</dd></div>`).join("")}</dl>`;
		}

		// ---- the plan -----------------------------------------------------------------------------

		is_check_ticked(key) {
			const $c = this.$body.find(`[data-check="${key}"]`);
			return !!$c.length && $c.is(":checked");
		}

		is_real_send_toggle_on(key) {
			return this.$body.find(`[data-real="${key}"]`).is(":checked");
		}

		input(key) {
			return cstr(this.$body.find(`[data-input="${key}"]`).val()).trim();
		}

		params_of(kind) {
			const read_picked_value = (key) => this.$body.find(`[data-pick="${key}"]`).val() || null;
			const read_document_name = (key) => cstr(this.$body.find(`[data-doc="${key}"]`).val()).trim() || null;
			if (kind === "quick_text") return { body: this.input("quick_text") };
			if (kind === "quick_image") return { body: this.input("quick_image"), attachment: this.files.image || null };
			if (kind === "quick_document") return { body: this.input("quick_document"), attachment: this.files.document || null };
			if (kind === "template") return { template: read_picked_value("template"), reference_name: this.doctype_of("template") ? read_document_name("template") : null };
			if (kind === "notification") return { notification: read_picked_value("notification"), reference_name: read_document_name("notification") };
			if (kind === "alert") return { alert: read_picked_value("alert") };
			if (kind === "campaign") {
				const p = { scheduled: this.is_real_send_toggle_on("schedule") ? 1 : 0, schedule_minutes: this.context.limits.schedule_minutes };
				if (this.camp_mode === "template") p.template = read_picked_value("campaign_template");
				else p.body = this.input("campaign");
				if (this.camp_mode === "image") p.with_image = 1;
				return p;
			}
			return {};
		}

		/** The rows a run would make, in the order they leave. */
		build_run_plan() {
			const targets = this.targets.map((t) => t.phone_e164);
			const rows = [];
			const add_check_rows = (kind, label) => {
				if (!this.is_check_ticked(kind)) return;
				const params = this.params_of(kind);
				const real = kind === "notification" && this.is_real_send_toggle_on("notification");
				if (real) {
					rows.push({ kind, card: kind, target: targets[0], label: __("{0} — real recipients", [label]), params: Object.assign(params, { real_recipients: 1 }), sends: true, real: true, messages: 1 });
					return;
				}
				targets.forEach((target) => rows.push({ kind, card: kind, target, label, params, sends: true, messages: 1 }));
			};
			add_check_rows("quick_text", __("Quick text"));
			add_check_rows("quick_image", __("Image"));
			add_check_rows("quick_document", __("Document", null, "Test Lab"));
			add_check_rows("template", __("Template: {0}", [this.params_of("template").template || ""]));
			add_check_rows("notification", __("Notification: {0}", [this.params_of("notification").notification || ""]));
			add_check_rows("alert", __("Alert: {0}", [this.params_of("alert").alert || ""]));
			if (this.is_check_ticked("commands")) {
				const sender = this.$body.find('[data-pick="sender"]').val();
				const send_reply = this.is_real_send_toggle_on("command");
				this.$body.find("[data-cmd-pick]:checked").each((i, el) => {
					const code = $(el).attr("data-cmd-pick");
					const text = cstr(this.$body.find(`[data-cmd-text="${code}"]`).val()).trim() || code;
					rows.push({ kind: "command", card: "commands", code, target: sender, label: __("Command: {0}", [text]), params: { text, send_reply: send_reply ? 1 : 0 }, sends: send_reply, messages: send_reply ? 1 : 0 });
				});
			}
			if (this.is_check_ticked("campaign")) rows.push({ kind: "campaign", card: "campaign", target: null, label: this.is_real_send_toggle_on("schedule") ? __("Scheduled mini campaign") : __("Mini campaign"), params: this.params_of("campaign"), sends: true, messages: targets.length });
			return rows;
		}

		// ---- the bar ------------------------------------------------------------------------------

		render_bar() {
			if (!this.$bar) return;
			const plan = this.build_run_plan();
			const messages = plan.reduce((n, r) => n + (r.messages || 0), 0);
			const sending = plan.filter((r) => r.sends).length;
			const health = this.is_check_ticked("health");
			const over = messages > this.cap;
			const estimate = Math.max(0, sending - 1) * this.pacing;
			let text;
			if (this.running) text = this.progress_text || __("Running…");
			else if (!plan.length && !health) text = __("Tick the checks you want to run.");
			else
				text = [
					ui.plural(plan.length + (health ? 1 : 0), { one: __("{0} check"), other: __("{0} checks") }),
					ui.plural(messages, { one: __("{0} real message"), other: __("{0} real messages") }),
					estimate ? __("about {0}", [estimate >= 90 ? __("{0} min", [Math.ceil(estimate / 60)]) : __("{0} s", [estimate])]) : null,
				]
					.filter(Boolean)
					.join(" · ");
			// The bar is built once and updated in place. A field that commits on blur (the cap, the
			// pause) re-renders it between the press and the release of a click on «Run selected», and a
			// button replaced under the pointer never receives that click.
			if (!this.$bar.children().length) {
				this.$bar.html(`
					<span class="whatsapp-test-lab__bar-text" role="status"></span>
					${kit.button_html({ label: __("Stop"), icon: "pause", variant: "danger", attrs: { "data-act": "stop" } })}
					${kit.button_html({ label: __("Run selected"), icon: "send", variant: "primary", attrs: { "data-act": "run" } })}`);
				this.$bar.find('[data-act="run"]').on("click", () => this.confirm_and_start_run());
				this.$bar.find('[data-act="stop"]').on("click", () => {
					this.stopped = true;
					this.progress_text = __("Stopping after the current message…");
					this.render_bar();
				});
			}
			const warn = over && !this.running;
			this.$bar
				.find(".whatsapp-test-lab__bar-text")
				.toggleClass("whatsapp-test-lab__bar-text--over", warn)
				.text(warn ? __("{0} messages — more than the cap of {1}. Untick a check or raise the cap.", [format_integer(messages), format_integer(this.cap)]) : text);
			this.$bar.find('[data-act="stop"]').prop("hidden", !this.running);
			this.$bar
				.find('[data-act="run"]')
				.prop("hidden", this.running)
				.prop("disabled", (!plan.length && !health) || over);
		}

		// ---- running ------------------------------------------------------------------------------

		confirm_and_start_run() {
			if (this.running) return;
			const plan = this.build_run_plan();
			const health = this.is_check_ticked("health");
			const messages = plan.reduce((n, r) => n + (r.messages || 0), 0);
			if (plan.length && !this.device) return ui.Toast.warning(__("Pick a sending device first."));
			if (plan.length && !this.targets.length) {
				ui.Toast.warning(__("Add at least one target number."));
				this.phone_field.focus();
				return;
			}
			const missing = plan.find((r) => (r.kind === "notification" && !r.params.reference_name) || (r.kind === "command" && !r.target));
			if (missing) return ui.Toast.warning(__("«{0}» has no record to run on. Pick one, or untick the check.", [missing.label]));
			if (!messages) return this.execute(plan, health);
			const real = plan.find((r) => r.real);
			const device = this.current_device();
			ui.ConfirmDialog.ask_for_confirmation({
				title: ui.plural(messages, { one: __("Send {0} real message?"), other: __("Send {0} real messages?") }),
				message: real
					? __("One of the checks sends a notification to the record's real recipients. Everything else goes to your target numbers only.")
					: __("They go to your target numbers only, one after the other."),
				impact: [
					{ label: __("Sending device"), value: device ? device.device_name || device.name : "—" },
					{ label: __("Target numbers"), value: this.targets.map((t) => phone_text(t.phone_e164)).join(" · ") },
					{ label: __("Messages"), value: format_integer(messages) },
					{ label: __("Pause between messages"), value: __("{0} s", [this.pacing]) },
				],
				ack_checkbox: real ? __("I understand that real customers may receive this notification.") : undefined,
				danger: !!real,
				confirm_label: ui.plural(messages, { one: __("Send {0} message"), other: __("Send {0} messages") }),
			})
				.then(() => this.execute(plan, health))
				.catch(() => {});
		}

		async execute(plan, health) {
			this.running = true;
			this.stopped = false;
			this.progress_text = __("Checking the setup…");
			this.render_bar();
			this.$body.find("[data-state]").empty();
			this.$body.find("[data-cmd-result]").empty();
			try {
				if (health) {
					const h = await this.load_health(true);
					const broken = h ? h.checks.filter((c) => c.status === "fail") : [];
					if (plan.some((r) => r.sends) && broken.length) {
						const go = await ui.ConfirmDialog.ask_for_confirmation({
							title: __("The setup has problems. Continue anyway?"),
							message: __("Messages may wait in the queue or fail."),
							impact: broken.map((c) => ({ label: c.title, value: c.detail, tone: "red" })),
							confirm_label: __("Continue anyway"),
						})
							.then(() => true)
							.catch(() => false);
						if (!go) return;
					}
				}
				if (!plan.length) {
					ui.Toast.success(__("The setup checks are done."));
					return;
				}
				const run = await call_test_lab_api("start_run", { device: this.device, targets: this.targets.map((t) => t.phone_e164), cap: this.cap, pacing: this.pacing }, { silent: true });
				this.run = run;
				this.status = null;
				this.readonly = false;
				this.receipt_deadline = null;
				this.follow_until = null;
				this.rows = plan.map((p, i) => Object.assign({ n: i + 1, state: "waiting" }, p));
				this.render_run();
				this.scroll_to_run();
				this.follow_run_until_settled();
				for (const row of this.rows) {
					if (this.stopped) {
						row.state = "skipped";
						continue;
					}
					await this.run_row(row);
					this.render_run();
					this.refresh_status();
					const more = this.rows.some((r) => r.state === "waiting" && r.sends);
					if (row.sends && row.state !== "failed" && more && !this.stopped) await this.countdown(this.pacing, __("Next message in {0} s"));
				}
				this.receipt_deadline = Date.now() + RECEIPT_TIMEOUT_MS;
				this.follow_until = Date.now() + FOLLOW_MS;
				ui.announce(__("All checks were run. Waiting for the delivery receipts."));
			} catch (err) {
				ui.Toast.error(err);
			} finally {
				this.running = false;
				this.progress_text = null;
				this.render_run();
				this.render_bar();
				this.refresh_status();
			}
		}

		async run_row(row) {
			row.state = "running";
			this.progress_text = __("Running {0} of {1}: {2}", [format_integer(row.n), format_integer(this.rows.length), row.label]);
			this.render_bar();
			this.render_run();
			for (;;) {
				let step;
				try {
					step = await call_test_lab_api("run_check", { run: this.run.id, kind: row.kind, target: row.target, params: Object.assign({ label: row.label }, row.params) }, { silent: true });
				} catch (err) {
					row.state = "failed";
					row.error = err.message || __("Something went wrong. Try again.");
					return;
				}
				// the server holds the next message back until the run's pacing is spent
				if (step && step.wait) {
					await this.countdown(Math.ceil(step.wait), __("Next message in {0} s"));
					if (this.stopped) {
						row.state = "skipped";
						return;
					}
					continue;
				}
				row.idx = step.idx;
				row.step = step;
				row.state = step.dry ? (step.ok ? "passed" : (step.result || {}).status === "Blocked" ? "blocked" : "failed") : step.ok ? "running" : "failed";
				row.error = step.error;
				return;
			}
		}

		async countdown(total, template) {
			for (let left = total; left > 0 && !this.stopped; left--) {
				this.progress_text = __(template, [left]);
				this.$bar.find(".whatsapp-test-lab__bar-text").text(this.progress_text);
				await sleep(1000);
			}
		}

		scroll_to_run() {
			const run_section = this.$body.find('[data-section="run"]')[0];
			if (run_section && run_section.scrollIntoView) run_section.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
		}

		// ---- following the run --------------------------------------------------------------------

		pending() {
			if (!this.run || this.readonly) return false;
			if (this.running) return true;
			if (this.listening_until && Date.now() < this.listening_until) return true;
			// a message on its way, or a campaign waiting for its hour, is followed until it settles
			// (a scheduled campaign starts on the scheduler's next round, minutes later) — but not for ever
			if (this.rows.some((r) => ["waiting", "running", "scheduled"].includes(r.state))) return !this.follow_until || Date.now() < this.follow_until;
			// a sent message is given a while to bring its receipt back, then the screen says so
			if (this.rows.some((r) => r.state === "sent")) return !this.receipt_deadline || Date.now() < this.receipt_deadline;
			return false;
		}

		follow_run_until_settled() {
			window.clearTimeout(this._poll);
			if (this._hidden) return;
			if (!this.pending()) {
				// the last word: a message still without its receipt now says so
				if (this.run) {
					this.render_run();
					this.render_receipts();
					this.render_inbound();
				}
				return;
			}
			// No asking the server on a timer: realtime (message status, inbound, queue, campaign)
			// brings every change. One local wake-up at the receipt deadline re-draws the rows that
			// are still waiting, so "the receipt did not come back" shows without a request.
			if (this.receipt_deadline) this._poll = window.setTimeout(() => this.follow_run_until_settled(), Math.max(0, this.receipt_deadline - Date.now()) + 50);
		}

		refresh_status() {
			if (!this.run) return Promise.resolve();
			const id = this.run.id;
			return call_test_lab_api("get_status", { run: id }, { silent: true })
				.then((status) => {
					if (!this.run || this.run.id !== id) return;
					this.status = status;
					const by_idx = {};
					(status.steps || []).forEach((s) => (by_idx[s.idx] = s));
					this.rows.forEach((row) => {
						const s = row.idx && by_idx[row.idx];
						if (!s) return;
						row.step = s;
						row.state = s.state;
						row.error = s.error;
					});
					// redrawn only when something moved: a poll every few seconds must not take the
					// focus out of the run's buttons, nor close a reply someone has opened
					const seen = JSON.stringify([status.steps, status.receipts, status.inbound, status.webhook_last_event_at]);
					if (seen === this._seen) return;
					this._seen = seen;
					this.render_run();
					this.render_receipts();
					this.render_inbound();
				})
				.catch(() => {});
		}

		/** A run opened from the history: its rows come from the server alone. */
		open_run(id) {
			this.run = { id };
			this.readonly = true;
			this.rows = [];
			this.status = null;
			this.render_run();
			return call_test_lab_api("get_status", { run: id }, { silent: true })
				.then((status) => {
					this.status = status;
					this.run = status.run;
					this.rows = (status.steps || []).map((s, i) => ({ n: i + 1, idx: s.idx, kind: s.kind, card: s.kind === "command" ? "commands" : s.kind, target: s.target, label: s.label || s.kind, sends: !s.dry, state: s.state, error: s.error, step: s }));
					this.render_run();
					this.render_receipts();
					this.scroll_to_run();
				})
				.catch((err) => ui.Toast.error(err));
		}

		row_detail(row) {
			const s = row.step || {};
			const res = s.result || {};
			const lines = [];
			if (row.error) lines.push(`<span class="whatsapp-test-lab__row-error">${escape_html(row.error)}</span>`);
			if (row.kind === "command" && res.status) {
				const facts = [status_word(res.status)];
				if (res.block_reason) facts.push(__("Reason: {0}", [__(res.block_reason)]));
				if (res.function_ms) facts.push(__("{0} ms", [format_integer(res.function_ms)]));
				lines.push(`<span>${escape_html(facts.join(" · "))}</span>`);
				const replies = (res.replies || []).map((r) => r.body || (r.file_name ? `[${r.file_name}]` : "")).filter(Boolean);
				if (replies.length) lines.push(`<details class="whatsapp-test-lab__reply"><summary>${escape_html(__("The reply the customer gets"))}</summary><div class="whatsapp-test-lab__bubble" dir="auto">${escape_html(replies.join("\n\n"))}</div></details>`);
			}
			if (row.kind === "campaign" && s.campaign_row) {
				const campaign_row = s.campaign_row;
				lines.push(
					`<span>${escape_html(
						[status_word(campaign_row.status), __("{0} of {1} delivered", [format_integer(cint(campaign_row.delivered_count) + cint(campaign_row.read_count)), format_integer(campaign_row.total_recipients)]), campaign_row.status === "Scheduled" && campaign_row.scheduled_at ? __("starts {0}", [frappe.datetime.prettyDate(campaign_row.scheduled_at)]) : null]
							.filter(Boolean)
							.join(" · ")
					)}</span>`
				);
				const ready = (res.readiness || {}).checks || [];
				if (ready.length) lines.push(`<span>${escape_html(__("Readiness: {0}", [ready.map((k) => `${k.ok ? "✓" : "✗"} ${(READINESS[k.key] || (() => k.key))()}`).join("  ")]))}</span>`);
			}
			if (res.reference_name) lines.push(`<span>${escape_html(__("Record: {0}", [res.reference_name]))}</span>`);
			(s.messages || []).forEach((m) => {
				const times = [m.send_seconds != null ? __("sent in {0}", [seconds(m.send_seconds)]) : null, m.deliver_seconds != null ? __("delivered in {0}", [seconds(m.deliver_seconds)]) : null].filter(Boolean).join(" · ");
				const reason = m.error_message || m.error_code;
				lines.push(`<span class="whatsapp-test-lab__msg">
					<button type="button" class="whatsapp-test-lab__link" data-log="${escape_html(m.name)}">${escape_html(__("Message"))} ${phone(m.phone_e164)}</button>
					<span class="whatsapp-test-lab__msg-status">${escape_html(status_word(m.status))}</span>
					${times ? `<span class="whatsapp-test-lab__msg-times">${escape_html(times)}</span>` : ""}
					${reason && ["Failed", "Held", "Cancelled"].includes(m.status) ? `<span class="whatsapp-test-lab__row-error">${escape_html(reason)}</span>` : ""}
				</span>`);
			});
			if (row.state === "sent" && this.receipt_deadline && Date.now() > this.receipt_deadline)
				lines.push(`<span class="whatsapp-test-lab__row-error">${escape_html(__("No delivery receipt arrived yet. The phone may be offline, or the webhook is not reaching this site."))}</span>`);
			return lines.join("");
		}

		render_run() {
			if (!this.$run) return;
			if (!this.run) {
				this.$summary.empty();
				this.$run.html(`<div class="whatsapp-test-lab__run-empty"><strong>${escape_html(__("Nothing has been run yet"))}</strong><span>${escape_html(__("Tick the checks above and press «Run selected». Each message shows here as it is sent and delivered."))}</span></div>`);
				return;
			}
			this.render_summary();
			const meta = this.status && this.status.run;
			const head = `
				<div class="whatsapp-test-lab__run-head">
					<span class="whatsapp-test-lab__run-title">${escape_html(this.readonly ? __("An earlier run") : __("This run"))}${meta ? ` · <span dir="ltr">${escape_html(frappe.datetime.str_to_user(meta.started_at))}</span>` : ""}</span>
					<span class="whatsapp-test-lab__run-actions">
						${kit.button_html({ label: __("Refresh", null, "Test Lab"), icon: "clock", variant: "ghost", size: "sm", attrs: { "data-act": "refresh" } })}
						${kit.button_html({ label: __("Copy report"), icon: "copy", variant: "tonal", size: "sm", attrs: { "data-act": "copy" } })}
						${kit.button_html({ label: __("Download"), icon: "doc", variant: "ghost", size: "sm", attrs: { "data-act": "download" } })}
					</span>
				</div>`;
			if (!this.rows.length) {
				this.$run.html(head + ui.skeleton(3));
			} else {
				this.$run.html(
					head +
						`<ol class="whatsapp-test-lab__rows">${this.rows
							.map((row) => {
								const s = row.step || {};
								return `<li class="whatsapp-test-lab__row whatsapp-test-lab__row--${row.state}">
									<span class="whatsapp-test-lab__row-n" aria-hidden="true">${format_integer(row.n)}</span>
									<span class="whatsapp-test-lab__row-main">
										<span class="whatsapp-test-lab__row-title"><strong dir="auto">${escape_html(row.label)}</strong>${row.target ? ` ${phone(row.target)}` : ""}</span>
										<span class="whatsapp-test-lab__row-detail">${this.row_detail(row)}</span>
									</span>
									<span class="whatsapp-test-lab__row-end">
										${state_badge(row.state)}
										${s.campaign ? `<button type="button" class="whatsapp-test-lab__link" data-campaign="${escape_html(s.campaign)}">${escape_html(__("Open the campaign"))}</button>` : ""}
									</span>
								</li>`;
							})
							.join("")}</ol>`
				);
			}
			this.$run.find("[data-log]").on("click", (e) => whatsapp_next.messages.open_outbound_drawer($(e.currentTarget).attr("data-log"), { after_change: () => this.refresh_status() }));
			this.$run.find("[data-campaign]").on("click", (e) => frappe.set_route("Form", "WhatsApp Campaign", $(e.currentTarget).attr("data-campaign")));
			this.$run.find('[data-act="refresh"]').on("click", () => this.refresh_status());
			this.$run.find('[data-act="copy"]').on("click", () => frappe.utils.copy_to_clipboard(this.report()));
			this.$run.find('[data-act="download"]').on("click", () => this.download());
			this.render_card_states();
		}

		/** Each check card wears the state of its own rows; a command row its own verdict. */
		render_card_states() {
			const order = ["failed", "blocked", "running", "waiting", "scheduled", "sent", "delivered", "read", "passed", "skipped"];
			const by_card = {};
			this.rows.forEach((r) => (by_card[r.card] = by_card[r.card] || []).push(r));
			Object.entries(by_card).forEach(([card, rows]) => {
				const worst = order.find((s) => rows.some((r) => r.state === s)) || "waiting";
				this.$body.find(`[data-state="${card}"]`).html(state_badge(worst));
			});
			this.rows
				.filter((r) => r.kind === "command" && r.code)
				.forEach((r) => {
					const res = (r.step || {}).result || {};
					const why = res.block_reason ? __(res.block_reason) : res.function_ms ? __("{0} ms", [format_integer(res.function_ms)]) : "";
					this.$body.find(`[data-cmd-result="${r.code}"]`).html(`${state_badge(r.state)}${why ? `<span class="whatsapp-test-lab__cmd-why">${escape_html(why)}</span>` : ""}`);
				});
		}

		render_summary() {
			const sum = (this.status && this.status.summary) || null;
			const count = (states) => this.rows.filter((r) => states.includes(r.state)).length;
			const passed = count(["passed", "delivered", "read"]);
			const failed = count(["failed"]);
			const waiting = count(["waiting", "running", "sent", "scheduled"]);
			if (this.cards) this.cards.destroy && this.cards.destroy();
			this.cards = new ui.Cards({
				wrapper: this.$summary.empty(),
				density: "compact",
				sections: [
					{
						min: 170,
						cards: [
							{ kind: "stat", icon: "check", tone: "ok", label: __("Passed", null, "Test Lab"), value: format_integer(passed), note: ui.plural(this.rows.length, { one: __("of {0} check"), other: __("of {0} checks") }) },
							{ kind: "stat", icon: "error", tone: failed ? "danger" : undefined, label: __("Failed", null, "Test Lab"), value: format_integer(failed), note: count(["blocked"]) ? __("{0} blocked", [format_integer(count(["blocked"]))]) : count(["skipped"]) ? __("{0} skipped", [format_integer(count(["skipped"]))]) : __("Nothing was refused") },
							{ kind: "stat", icon: "clock", tone: waiting ? "info" : undefined, label: __("In progress"), value: format_integer(waiting), note: waiting ? __("Waiting for sending or receipts") : __("Nothing is waiting") },
							{ kind: "stat", icon: "send", label: __("Time to send"), value: sum && sum.avg_send_seconds != null ? seconds(sum.avg_send_seconds) : "—", note: __("From the press until WhatsApp took it") },
							{ kind: "stat", icon: "read", label: __("Time to deliver"), value: sum && sum.avg_deliver_seconds != null ? seconds(sum.avg_deliver_seconds) : "—", note: __("From the press until it reached the phone") },
						],
					},
				],
			});
		}

		render_receipts() {
			const $r = this.$body.find("[data-receipts]");
			if (!$r.length) return;
			const status = this.status;
			const r = status && status.receipts;
			const last = (status && status.webhook_last_event_at) || null;
			const $state = this.$body.find('[data-state="receipts"]');
			if (!r || !r.messages) {
				$state.html(kit.badge(__("Waits for a run"), "muted"));
				$r.html(`<p class="whatsapp-test-lab__none">${escape_html(__("Send at least one message: its delivery receipt proves that WhatsApp can reach this site."))}</p>`);
				return;
			}
			const timed_out = this.receipt_deadline && Date.now() > this.receipt_deadline;
			const state = r.delivered ? (r.delivered >= r.messages - r.failed ? "ok" : "info") : r.sent && timed_out ? "danger" : "info";
			$state.html(kit.badge(state === "ok" ? __("Receipts arrive") : state === "danger" ? __("No receipt") : __("Waiting…"), state));
			$r.html(`
				<dl class="whatsapp-test-lab__facts">
					<div><dt>${escape_html(__("Left the site"))}</dt><dd>${escape_html(__("{0} of {1}", [format_integer(r.sent), format_integer(r.messages)]))}</dd></div>
					<div><dt>${escape_html(__("Delivered", null, "Test Lab"))}</dt><dd>${escape_html(format_integer(r.delivered))}</dd></div>
					<div><dt>${escape_html(__("Read", null, "Test Lab"))}</dt><dd>${escape_html(format_integer(r.read))}</dd></div>
					<div><dt>${escape_html(__("Last event from the platform"))}</dt><dd>${escape_html(last ? frappe.datetime.prettyDate(last) : __("Nothing yet"))}</dd></div>
				</dl>
				${state === "danger" ? `<p class="whatsapp-test-lab__warn" role="alert">${escape_html(__("Messages left the site but no delivery receipt came back. Check the webhook in the settings, and that the target phone is online."))}</p>` : ""}`);
		}

		// ---- the live check: a real message from the phone ---------------------------------------

		async listen() {
			if (!this.targets.length) return ui.Toast.warning(__("Add at least one target number."));
			if (!this.device) return ui.Toast.warning(__("Pick a sending device first."));
			if (this.running) return;
			try {
				// a run of its own scopes the wait: these numbers, from this moment
				if (!this.run || this.readonly) {
					this.run = await call_test_lab_api("start_run", { device: this.device, targets: this.targets.map((t) => t.phone_e164), cap: this.cap, pacing: this.pacing }, { silent: true });
					this.readonly = false;
					this.rows = [];
					this.status = null;
					this.render_run();
				}
			} catch (err) {
				return ui.Toast.error(err);
			}
			this.listening_until = Date.now() + LISTEN_MS;
			this.render_inbound();
			this.refresh_status().then(() => this.follow_run_until_settled());
		}

		render_inbound() {
			const $i = this.$body.find("[data-inbound]");
			if (!$i.length) return;
			const listening = this.listening_until && Date.now() < this.listening_until;
			const rows = (this.status && this.status.inbound) || [];
			const $state = this.$body.find('[data-state="listen"]');
			const good = rows.some((r) => r.delivered);
			if (!rows.length) {
				$state.html(listening ? kit.badge(__("Listening…"), "info") : "");
				$i.html(listening ? `<p class="whatsapp-test-lab__waiting"><span class="whatsapp-test-lab__pulse" aria-hidden="true"></span>${escape_html(__("Waiting for your message… write a command from your phone now."))}</p>` : this.listening_until ? `<p class="whatsapp-test-lab__warn">${escape_html(__("No message arrived in five minutes. Check that the device is connected and the webhook is active, then try again."))}</p>` : "");
				return;
			}
			$state.html(kit.badge(good ? __("Received and answered") : __("Received", null, "Test Lab"), good ? "ok" : "info"));
			$i.html(
				`<ul class="whatsapp-test-lab__inbound-rows">${rows
					.map((r) => {
						const verdict = r.command_status === "Executed" ? "ok" : r.command_status === "Blocked" ? "warn" : r.command_status === "Failed" ? "danger" : "muted";
						const reply = !r.replies.length ? __("No reply was sent") : r.delivered ? __("Reply delivered") : r.answered ? __("Reply sent") : __("Reply on its way");
						return `<li class="whatsapp-test-lab__inbound-row">
							<span class="whatsapp-test-lab__inbound-text"><strong dir="auto">${escape_html(r.body || status_word(r.message_type))}</strong><span>${phone(r.phone_e164)} · <span dir="ltr">${escape_html(frappe.datetime.prettyDate(r.creation))}</span></span></span>
							<span class="whatsapp-test-lab__inbound-end">${kit.badge(r.command ? `${r.command} · ${status_word(r.command_status)}` : r.command_status && r.command_status !== "None" ? status_word(r.command_status) : __("Not a command"), verdict)}${r.block_reason ? kit.badge(__(r.block_reason), "warn", { dot: false }) : ""}${kit.badge(reply, r.delivered ? "ok" : r.replies.length ? "info" : "muted")}</span>
						</li>`;
					})
					.join("")}</ul>`
			);
		}

		// ---- the report ---------------------------------------------------------------------------

		report() {
			const st = this.status || {};
			const run = st.run || this.run || {};
			const lines = [];
			lines.push(__("WhatsApp Test Lab report"));
			lines.push(`${window.location.host} · ${frappe.datetime.str_to_user(run.started_at || frappe.datetime.now_datetime())}`);
			lines.push(__("Device: {0} · Targets: {1} · Cap: {2} · Pause: {3} s", [run.device || this.device || "—", (run.targets || this.targets.map((t) => t.phone_e164)).map(phone_text).join(", "), run.cap || this.cap, run.pacing || this.pacing]));
			if (this.health) {
				lines.push("");
				lines.push(__("Connection and setup"));
				this.health.checks.forEach((c) => lines.push(`  ${c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✗"} ${c.title} — ${c.detail}${c.status !== "ok" && c.fix ? ` (${c.fix})` : ""}`));
			}
			lines.push("");
			lines.push(__("Checks"));
			this.rows.forEach((row) => {
				const s = row.step || {};
				const state = (STATES[row.state] || STATES.waiting).label();
				lines.push(`  ${row.n}. ${row.label}${row.target ? ` → ${phone_text(row.target)}` : ""}: ${state}${row.error ? ` — ${row.error}` : ""}`);
				const res = s.result || {};
				if (row.kind === "command" && res.status) lines.push(`     ${status_word(res.status)}${res.block_reason ? ` · ${__(res.block_reason)}` : ""}${res.function_ms ? ` · ${res.function_ms} ms` : ""}`);
				(s.messages || []).forEach((m) =>
					lines.push(
						`     ${phone_text(m.phone_e164)} · ${status_word(m.status)}${m.send_seconds != null ? ` · ${__("sent in {0}", [seconds(m.send_seconds)])}` : ""}${m.deliver_seconds != null ? ` · ${__("delivered in {0}", [seconds(m.deliver_seconds)])}` : ""}${
							m.error_message || m.error_code ? ` · ${m.error_message || m.error_code}` : ""
						} [${m.name}]`
					)
				);
				if (s.campaign) lines.push(`     ${__("Campaign")}: ${s.campaign}`);
			});
			const count = (states) => this.rows.filter((r) => states.includes(r.state)).length;
			lines.push("");
			lines.push(
				__("Summary: {0} passed · {1} failed · {2} blocked · {3} skipped · {4} in progress", [count(["passed", "delivered", "read"]), count(["failed"]), count(["blocked"]), count(["skipped"]), count(["waiting", "running", "sent", "scheduled"])])
			);
			const summary = st.summary;
			if (summary && (summary.avg_send_seconds != null || summary.avg_deliver_seconds != null))
				lines.push(__("Average time to send: {0} · to deliver: {1}", [summary.avg_send_seconds != null ? seconds(summary.avg_send_seconds) : "—", summary.avg_deliver_seconds != null ? seconds(summary.avg_deliver_seconds) : "—"]));
			return lines.join("\n");
		}

		download() {
			const blob = new Blob([this.report()], { type: "text/plain;charset=utf-8" });
			const a = document.createElement("a");
			a.href = URL.createObjectURL(blob);
			a.download = `whatsapp-test-lab-${(this.run && this.run.id) || "run"}.txt`;
			document.body.appendChild(a);
			a.click();
			a.remove();
			window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
		}

		// ---- history ------------------------------------------------------------------------------

		open_history() {
			call_test_lab_api("list_runs", {}, { silent: true })
				.then((runs) => {
					const panel = new ui.OverlayPanel({
						type: "drawer",
						width: "460px",
						title: __("Earlier runs"),
						subtitle: __("The last runs of the Test Lab, newest first. They are kept with the audit log."),
						detail: {
							blocks: [
								{
									label: __("Runs", null, "Test Lab"),
									render: ($el) => {
										if (!(runs || []).length) return $el.html(`<p class="whatsapp-test-lab__none">${escape_html(__("No run yet."))}</p>`);
										$el.html(
											`<ul class="whatsapp-test-lab__history">${runs
												.map(
													(r) => `<li><button type="button" class="whatsapp-test-lab__history-row" data-run="${escape_html(r.id)}">
														<span class="whatsapp-test-lab__history-main"><strong dir="ltr">${escape_html(frappe.datetime.str_to_user(r.started_at))}</strong><span>${escape_html(
														[r.user_name, ui.plural(r.checks, { one: __("{0} check"), other: __("{0} checks") }), ui.plural(r.messages, { one: __("{0} message"), other: __("{0} messages") })].join(" · ")
													)}</span></span>
														${r.failed ? kit.badge(__("{0} failed", [format_integer(r.failed)]), "danger") : r.messages ? kit.badge(__("{0} delivered", [format_integer(r.delivered)]), r.delivered >= r.messages ? "ok" : "info") : kit.badge(__("No messages"), "muted")}
													</button></li>`
												)
												.join("")}</ul>`
										);
										$el.find("[data-run]").on("click", (e) => {
											if (this.running) return ui.Toast.warning(__("A run is in progress."));
											panel.hide();
											this.open_run($(e.currentTarget).attr("data-run"));
										});
									},
								},
							],
						},
						actions: [{ key: "close", label: __("Close"), variant: "primary", close: true }],
					});
					panel.show();
				})
				.catch((err) => ui.Toast.error(err));
		}

		// ---- realtime ----------------------------------------------------------------------------

		subscribe() {
			if (this._subscribed) return;
			this._subscribed = true;
			// a change re-reads the run, then settles it (the final render once nothing is pending)
			this._on_change = ui.throttle(() => this.run && !this.readonly && this.refresh_status().then(() => this.follow_run_until_settled()), 1500);
			this._on_device = (p) => {
				const d = p && this.devices().find((x) => x.name === p.device);
				if (!d) return;
				d.status = p.status;
				this.render_device_state();
			};
			["wa:message:status", "wa:inbound:received", "wa:campaign:status", "wa:queue:progress"].forEach((ev) => frappe.realtime.on(ev, this._on_change));
			frappe.realtime.on("wa:device:status", this._on_device);
		}

		unsubscribe() {
			if (!this._subscribed) return;
			["wa:message:status", "wa:inbound:received", "wa:campaign:status", "wa:queue:progress"].forEach((ev) => frappe.realtime.off(ev, this._on_change));
			frappe.realtime.off("wa:device:status", this._on_device);
			this._subscribed = false;
		}

		hide() {
			this._hidden = true;
			window.clearTimeout(this._poll);
			this.unsubscribe();
		}

		show() {
			if (!this._hidden) return;
			this._hidden = false;
			if (!this.context) return;
			this.subscribe();
			this.refresh_status().then(() => this.follow_run_until_settled());
		}
	}

	frappe.pages[ROUTE].on_page_load = function (wrapper) {
		const page = frappe.ui.make_app_page({ parent: wrapper, title: __("Test Lab"), single_column: true });
		wrapper.whatsapp_next = new TestLab(page);
		frappe.provide("whatsapp_next.pages");
		whatsapp_next.pages.test_lab = wrapper.whatsapp_next;
	};

	frappe.pages[ROUTE].on_page_show = function (wrapper) {
		if (wrapper.whatsapp_next) wrapper.whatsapp_next.show();
	};

	frappe.pages[ROUTE].on_page_hide = function (wrapper) {
		if (wrapper.whatsapp_next) wrapper.whatsapp_next.hide();
	};
})();

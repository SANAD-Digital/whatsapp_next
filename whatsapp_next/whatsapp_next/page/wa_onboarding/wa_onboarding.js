// Module role: the Onboarding Wizard (spec §2 row 1, matrix row 1) — the first screen of the
// product: sign up for a platform account, sign in with existing credentials or reset a
// password, then pair the first device, register the webhook and flag the setup complete.
// Every write goes through `api.v1.onboarding` (plus `settings.test_connection` /
// `settings.setup_webhook`) with `sanad.ui.call`; the wizard itself is the kit's Stepper.
// The Home → wizard redirect stays governed by `WhatsApp Settings.redirect_unregistered_to_wizard`
// and is deliberately not wired here (spec #1: it is enabled last, in phase 10).

frappe.provide("whatsapp_next.onboarding");

(() => {
	const ui = sanad.ui;
	const SETUP_ROLES = ["System Manager"];
	const POLL_MS = 4000;
	const SIGNUP_POLL_MS = 5000;

	const can_setup = () => frappe.user.has_role(SETUP_ROLES);

	// which pane of the wizard finishes each step the backend reports
	const STEP_INDEX = { credentials: 1, connection: 1, device: 2, webhook: 3 };

	const STEP_LABEL = {
		credentials: () => __("Credentials"),
		connection: () => __("Connection"),
		device: () => __("Device"),
		webhook: () => __("Webhook"),
	};

	/** The pane's own heading: icon, title, one line of why. */
	function step_head(icon, title, sub) {
		return `
			<header class="wa-onb__step-head">
				<span class="wa-onb__step-icon" aria-hidden="true">${ui.icon(icon, "md")}</span>
				<span class="wa-onb__step-text">
					<h2 class="wa-onb__step-title">${ui.escape(title)}</h2>
					<p class="wa-onb__step-sub">${ui.escape(sub)}</p>
				</span>
			</header>`;
	}

	function field(parent, df, value) {
		const control = frappe.ui.form.make_control({
			parent,
			df: Object.assign({ fieldtype: "Data" }, df),
			render_input: true,
		});
		if (value != null) control.set_value(value);
		// A required field that has never been typed in is not an error yet: Desk suppresses the
		// same red frame inside a dialog until its primary action is pressed (`base_input.js`,
		// `set_mandatory`). The asterisk still says the field is required, and the frame comes
		// back the moment a value is entered and then cleared.
		control.$wrapper.removeClass("has-error");
		return control;
	}

	/**
	 * Arrow-key navigation and a roving tabindex over `[role="radio"]` children (WCAG 2.1.1 / 4.1.2).
	 */
	function bind_radio_group($group) {
		const nodes = () => $group.find('[role="radio"]').toArray();
		const sync = () => {
			const items = nodes();
			const checked = items.find((el) => el.getAttribute("aria-checked") === "true") || items[0];
			items.forEach((el) => el.setAttribute("tabindex", el === checked ? "0" : "-1"));
		};
		$group.on("keydown", '[role="radio"]', (e) => {
			const items = nodes();
			const i = items.indexOf(e.currentTarget);
			if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(e.key)) return;
			e.preventDefault();
			const step = ["ArrowRight", "ArrowDown"].includes(e.key) ? 1 : -1;
			const next = items[(i + step + items.length) % items.length];
			next.setAttribute("tabindex", "0");
			next.focus();
			$(next).trigger("click");
		});
		$group.on("click", '[role="radio"]', sync);
		sync();
	}

	/** An inline, announced error next to the controls that caused it (WCAG 3.3.1). */
	function pane_error($slot, text) {
		$slot.empty();
		if (!text) return;
		$(`<p class="wa-onb__note sanad-tone--red" role="alert" tabindex="-1"><span aria-hidden="true">${ui.icon("es-line-alert-circle", "sm")}</span><span>${ui.escape(text)}</span></p>`).appendTo($slot);
		ui.announce(text, { assertive: true });
	}

	function note($wrapper, tone, text, icon) {
		return $(`<p class="wa-onb__note sanad-tone--${tone}" role="status"><span aria-hidden="true">${ui.icon(icon || "es-line-alert-circle", "sm")}</span><span>${ui.escape(text)}</span></p>`).appendTo($wrapper);
	}

	// -------------------------------------------------------------------------------------------
	// The screen
	// -------------------------------------------------------------------------------------------
	class OnboardingScreen {
		constructor({ page, wrapper }) {
			this.page = page;
			this.wrapper = wrapper;
			this.ctx = { path: null, device: null, webhook: null, connection: null };
			this.$screen = $('<div class="wa-onboarding"></div>').appendTo(page.main);
			this.header = new ui.PageHeader({
				wrapper: this.$screen,
				title: __("WhatsApp setup"),
				description: __("Connect this site to the WhatsApp platform: an account, a paired device and a webhook. It takes a few minutes."),
			});
			this.mark_header();
			this.$panel = $('<div class="wa-onb__panel"></div>').appendTo(this.$screen);
			this.load();
			$(wrapper).on("hide", () => this.unbind());
		}

		/** The prototype's wizard head: the screen's icon on a tinted plate beside its title. */
		mark_header() {
			$(`<span class="wa-onboarding__mark" aria-hidden="true">${ui.icon("es-line-settings", "md")}</span>`).prependTo(
				this.header.$el.find(".sanad-pagehead__row")
			);
		}

		// ---- status -----------------------------------------------------------------------------

		load() {
			const state = new ui.EmptyState({ wrapper: this.$panel, state: "loading", rows: 4 });
			return ui
				.call("onboarding.get_status")
				.then((status) => {
					this.status = status || {};
					this.render();
				})
				.catch((err) => state.error(err, { action: { label: __("Try again"), on_click: () => this.load() } }));
		}

		step_done(key) {
			const step = (this.status.steps || []).find((s) => s.key === key);
			return !!(step && step.done);
		}

		step_detail(key) {
			const step = (this.status.steps || []).find((s) => s.key === key);
			return (step && step.detail) || "";
		}

		render() {
			this.unbind();
			this.$panel.empty();
			if (!can_setup()) return this.render_readonly();
			if (this.status.setup_completed && !this.ctx.rerun) return this.render_complete();
			this.render_wizard();
		}

		/** A WhatsApp Manager may watch the setup, but every write on it is System Manager only. */
		render_readonly() {
			const $el = $('<div class="wa-onb__card"></div>').appendTo(this.$panel);
			$el.append(step_head("es-line-lock", __("Setup status"), __("Only a System Manager can run this setup. These are the steps and where they stand.")));
			this.render_checklist($('<div class="wa-onb__checklist"></div>').appendTo($el));
		}

		render_complete() {
			const $el = $('<div class="wa-onb__card wa-onb__done"></div>').appendTo(this.$panel);
			$el.append(`
				<span class="wa-onb__done-icon sanad-tone--green" aria-hidden="true">${ui.icon("es-line-success", "lg")}</span>
				<h2 class="wa-onb__done-title">${ui.escape(__("Setup is complete"))}</h2>
				<p class="wa-onb__done-sub">${ui.escape(__("This site is connected to the platform. You can send, receive and run campaigns."))}</p>`);
			this.render_checklist($('<div class="wa-onb__checklist"></div>').appendTo($el));
			const $actions = $('<div class="wa-onb__done-actions"></div>').appendTo($el);
			$(`<button type="button" class="btn btn-primary btn-sm">${ui.escape(__("Open devices"))}</button>`)
				.on("click", () => frappe.set_route("wa-devices"))
				.appendTo($actions);
			$(`<button type="button" class="btn btn-default btn-sm">${ui.escape(__("Run the setup again"))}</button>`)
				.on("click", () => {
					this.ctx.rerun = true;
					this.render();
				})
				.appendTo($actions);
		}

		render_checklist($el, { open_step = false } = {}) {
			$el.empty();
			(this.status.steps || []).forEach((step) => {
				const label = (STEP_LABEL[step.key] || (() => step.key))();
				const $row = $(`
					<div class="wa-onb__check${step.done ? " wa-onb__check--done" : ""}">
						<span class="wa-onb__check-icon sanad-tone--${step.done ? "green" : "gray"}" aria-hidden="true">${ui.icon(step.done ? "es-line-check" : "es-line-dot", "sm")}</span>
						<span class="wa-onb__check-text">
							<b>${ui.escape(label)}</b>
							<span>${ui.escape(step.detail || (step.done ? __("Done") : __("Not done yet")))}</span>
						</span>
						<span class="wa-onb__check-state sanad-tone--${step.done ? "green" : "gray"}">${ui.escape(step.done ? __("Done") : __("To do"))}</span>
					</div>`).appendTo($el);
				// the prototype's review opens any group again from the summary; here only the step
				// that is still missing needs the way back
				if (open_step && !step.done && STEP_INDEX[step.key] != null) {
					$(`<button type="button" class="btn btn-default btn-sm wa-onb__check-open" aria-label="${ui.escape(__("Open the {0} step", [label]))}">${ui.escape(__("Open"))}</button>`)
						.on("click", () => this.stepper.go(STEP_INDEX[step.key]))
						.appendTo($row);
				}
			});
		}

		// ---- the wizard --------------------------------------------------------------------------

		render_wizard() {
			const $mount = $('<div class="wa-onb__wizard"></div>').appendTo(this.$panel);
			// credentials already on the site: the way in is "sign in", and the wizard opens on the
			// first step the backend still reports as missing
			if (!this.ctx.path && this.step_done("credentials")) this.ctx.path = "signin";
			const steps = [
				this.step_account(),
				this.step_credentials(),
				this.step_device(),
				this.step_webhook(),
				this.step_review(),
			];
			steps.forEach((step) => {
				const on_show = step.on_show;
				// the rail's completion bar follows the step the wizard is on
				step.on_show = (...args) => {
					this.sync_rail();
					return on_show && on_show(...args);
				};
			});
			this.stepper = new ui.Stepper({
				wrapper: $mount,
				ctx: this.ctx,
				steps,
				start_index: this.start_index(),
				linear: false,
				next_label: __("Next"),
				finish_label: __("Finish setup"),
				on_finish: () => this.finish(),
			});
			this.make_rail();
		}

		/**
		 * The prototype's rail foot: the word, the fraction and the bar that fills with the flow
		 * (`docs/component/Wizard.dc.html`, "ريل جانبي"). The Stepper owns the list; this is the
		 * completion line under it.
		 */
		make_rail() {
			const $header = this.stepper.$el.find(".sanad-stepper__header");
			this.$rail = $(`
				<div class="wa-onb__rail-foot">
					<div class="wa-onb__rail-line">
						<span class="wa-onb__rail-label">${ui.escape(__("Completion"))}</span>
						<span class="wa-onb__rail-count sanad-tabular" data-slot="count"></span>
					</div>
					<div class="wa-onb__rail-track"><span class="wa-onb__rail-bar" data-slot="bar"></span></div>
				</div>`).appendTo($header);
			this.sync_rail();
		}

		sync_rail() {
			if (!this.$rail || !this.stepper) return;
			const total = this.stepper.steps.length;
			const at = Math.max(1, this.stepper.index + 1);
			this.$rail.find('[data-slot="count"]').text(`${at} / ${total}`);
			this.$rail.find('[data-slot="bar"]').css("inline-size", `${Math.round((at / total) * 100)}%`);
		}

		/** Open on the first step the backend still reports as not done. */
		start_index() {
			if (!this.step_done("credentials")) return 0;
			if (!this.step_done("connection")) return 1;
			if (!this.step_done("device")) return 2;
			if (!this.step_done("webhook")) return 3;
			return 4;
		}

		// ---- step 1: which way in ------------------------------------------------------------------

		step_account() {
			const choices = [
				{
					value: "signup",
					icon: "es-line-add-people",
					title: __("Create a new account"),
					sub: __("Sign up on the platform with your mobile number, confirm the code, and the credentials are stored for you."),
					meta: __("~2 min"),
				},
				{
					value: "signin",
					icon: "es-line-lock",
					title: __("I already have an account"),
					sub: __("Enter the platform address and the API keys you were given."),
					meta: __("~1 min"),
				},
				{
					value: "reset",
					icon: "es-line-question",
					title: __("I forgot the password"),
					sub: __("Ask the platform to send reset instructions, then sign in with the new keys."),
				},
			];
			return {
				key: "account",
				label: __("Account"),
				render: ($body, ctx, stepper) => {
					$body.html(step_head("es-line-agent", __("How do you reach the platform?"), __("This decides where the credentials come from. You can change them later in Settings.")));
					if (this.step_done("credentials")) {
						note($body, "green", __("Credentials are already saved on this site. Choose “I already have an account” to change or re-test them."), "es-line-check");
						ctx.path = ctx.path || "signin";
					}
					const $choices = $('<div class="wa-onb__choices" role="radiogroup" aria-label="' + ui.escape(__("Ways to reach the platform")) + '"></div>').appendTo($body);
					choices.forEach((choice) => {
						$(`
							<button type="button" class="wa-onb__choice" role="radio" aria-checked="${ctx.path === choice.value}" data-value="${choice.value}">
								<span class="wa-onb__choice-icon" aria-hidden="true">${ui.icon(choice.icon, "md")}</span>
								<span class="wa-onb__choice-text">
									<b>${ui.escape(choice.title)}</b>
									<span>${ui.escape(choice.sub)}</span>
									${choice.meta ? `<span class="wa-onb__choice-meta sanad-tabular">${ui.escape(choice.meta)}</span>` : ""}
								</span>
								<span class="wa-onb__choice-mark" aria-hidden="true"></span>
							</button>`)
							.on("click", (e) => {
								ctx.path = choice.value;
								$choices.find("[data-value]").attr("aria-checked", "false");
								$(e.currentTarget).attr("aria-checked", "true");
								stepper.set_step_valid(true);
								stepper.clear_error();
							})
							.appendTo($choices);
					});
					bind_radio_group($choices);
					stepper.set_step_valid(!!ctx.path);
				},
				on_show: (body, ctx, stepper) => stepper.set_step_valid(!!ctx.path),
				validate: (ctx) => !!ctx.path || __("Choose one of the three ways to continue."),
			};
		}

		// ---- step 2: credentials, by the chosen way -------------------------------------------------

		step_credentials() {
			return {
				key: "credentials",
				label: __("Credentials"),
				render: ($body) => {
					this.$credentials = $body;
				},
				on_show: () => this.render_credentials(),
				validate: (ctx) => {
					if (ctx.path === "reset") {
						return __("A password reset does not finish the setup. Choose “I already have an account” and enter the new keys.");
					}
					if (ctx.connection && ctx.connection.ok) return true;
					return ui.call("settings.test_connection").then((r) => {
						this.ctx.connection = r;
						this.render_connection_result();
						return r.ok || r.error || __("The platform did not answer. Check the address and the keys.");
					});
				},
			};
		}

		render_credentials() {
			const $el = this.$credentials.empty();
			const path = this.ctx.path;
			if (path === "signup") return this.render_signup($el);
			if (path === "reset") return this.render_reset($el);
			return this.render_signin($el);
		}

		render_signin($el) {
			$el.html(step_head("es-line-lock", __("Platform credentials"), __("The keys are stored encrypted and are never shown again after saving.")));
			const $form = $('<div class="wa-onb__form"></div>').appendTo($el);
			this.credentials = {
				platform_base_url: field($form, {
					fieldtype: "Data",
					label: __("Platform address"),
					placeholder: "https://platform.example.com",
					reqd: 1,
					description: __("The address of the WhatsApp platform this site talks to."),
				}),
				customer_api_key: field($form, { fieldtype: "Password", label: __("Customer API key"), reqd: 1 }),
				api_key: field($form, { fieldtype: "Password", label: __("API key"), reqd: 1 }),
				api_secret: field($form, { fieldtype: "Password", label: __("API secret"), reqd: 1 }),
			};
			if (this.step_done("credentials")) {
				note($el, "green", __("Credentials are already saved. Leave a field empty to keep the value it has."), "es-line-check");
			}
			const $actions = $('<div class="wa-onb__actions"></div>').appendTo($el);
			$(`<button type="button" class="btn btn-default btn-sm">${ui.escape(this.step_done("credentials") ? __("Test the connection") : __("Save and test the connection"))}</button>`)
				.on("click", (e) => this.save_credentials($(e.currentTarget)))
				.appendTo($actions);
			this.$error = $('<div class="wa-onb__error"></div>').appendTo($el);
			this.$result = $('<div class="wa-onb__result"></div>').appendTo($el);
			this.render_connection_result();
		}

		save_credentials($btn) {
			const values = {};
			Object.entries(this.credentials).forEach(([key, control]) => {
				const value = control.get_value();
				if (value) values[key] = value;
			});
			if (!Object.keys(values).length && !this.step_done("credentials")) {
				return pane_error(this.$error, __("Enter the platform address and the keys first."));
			}
			pane_error(this.$error, null);
			$btn.prop("disabled", true);
			// nothing typed over saved credentials: test what is stored instead of saving nothing
			const saved = Object.keys(values).length
				? ui.call("onboarding.save_credentials", values)
				: Promise.resolve();
			return saved
				.then(() => ui.call("settings.test_connection"))
				.then((r) => {
					this.ctx.connection = r;
					this.render_connection_result();
					if (r.ok) {
						ui.Toast.success(__("The platform answered. The connection works."));
						this.stepper.set_step_valid(true);
					}
				})
				.catch((err) => ui.Toast.error(err))
				.finally(() => $btn.prop("disabled", false));
		}

		render_connection_result() {
			if (!this.$result) return;
			const r = this.ctx.connection;
			this.$result.empty();
			if (!r) return;
			if (r.ok) {
				note(
					this.$result,
					"green",
					r.plan_code
						? __("Connected in {0} ms · plan {1}", [ui.format_int(r.latency_ms), r.plan_code])
						: __("Connected in {0} ms", [ui.format_int(r.latency_ms)]),
					"es-line-check"
				);
			} else {
				note(this.$result, "red", r.error || __("The platform did not answer."), "es-line-alert-circle");
			}
		}

		render_signup($el) {
			$el.html(step_head("es-line-add-people", __("Create a platform account"), __("The platform sends a confirmation code to the number you enter. The credentials are stored here once the code is confirmed.")));
			const $form = $('<div class="wa-onb__form"></div>').appendTo($el);
			this.signup = {
				full_name: field($form, { fieldtype: "Data", label: __("Full name"), reqd: 1 }),
				email: field($form, { fieldtype: "Data", options: "Email", label: __("Email"), reqd: 1 }),
				plan_code: field($form, {
					fieldtype: "Data",
					label: __("Plan code"),
					reqd: 1,
					description: __("The plan you agreed with the platform, for example “basic”."),
				}),
				channel: field($form, {
					fieldtype: "Select",
					label: __("Send the code by"),
					options: [
						{ value: "whatsapp", label: __("WhatsApp") },
						{ value: "sms", label: __("SMS") },
						{ value: "email", label: __("Email") },
					],
					default: "whatsapp",
				}, "whatsapp"),
			};
			const $phone = $('<div class="wa-onb__field"></div>').appendTo($form);
			this.signup_phone = new ui.PhoneField({
				wrapper: $phone,
				label: __("Mobile number"),
				required: true,
				on_change: ({ phone_e164, valid }) => (this.ctx.mobile = valid ? phone_e164 : null),
			});
			this.$error = $('<div class="wa-onb__error"></div>').appendTo($el);
			const $actions = $('<div class="wa-onb__actions"></div>').appendTo($el);
			$(`<button type="button" class="btn btn-default btn-sm">${ui.escape(__("Send the code"))}</button>`)
				.on("click", (e) => this.start_signup($(e.currentTarget)))
				.appendTo($actions);
			this.$result = $('<div class="wa-onb__result"></div>').appendTo($el);
		}

		start_signup($btn) {
			const values = {
				full_name: this.signup.full_name.get_value(),
				email: this.signup.email.get_value(),
				plan_code: this.signup.plan_code.get_value(),
				channel: this.signup.channel.get_value() || "whatsapp",
				mobile: this.ctx.mobile,
			};
			if (!values.full_name || !values.email || !values.plan_code || !values.mobile) {
				return pane_error(this.$error, __("Fill in every field before asking for the code."));
			}
			pane_error(this.$error, null);
			$btn.prop("disabled", true);
			return ui
				.call("onboarding.start_signup", values)
				.then((r) => {
					this.ctx.request_key = r.request_key;
					this.render_code_entry(r);
					this.watch_signup();
				})
				.catch((err) => ui.Toast.error(err))
				.finally(() => $btn.prop("disabled", false));
		}

		render_code_entry(state) {
			const $el = this.$result.empty();
			$el.append(`<p class="wa-onb__lead">${ui.escape(__("A code was sent to {0}. Enter it to finish the sign-up.", [ui.PhoneField.format_display(this.ctx.mobile)]))}</p>`);
			const $row = $('<div class="wa-onb__code-row"></div>').appendTo($el);
			const code = field($row, { fieldtype: "Data", label: __("Confirmation code") });
			const $code_error = $('<div class="wa-onb__error"></div>').appendTo($el);
			$(`<button type="button" class="btn btn-primary btn-sm">${ui.escape(__("Confirm the code"))}</button>`)
				.on("click", (e) => {
					const value = (code.get_value() || "").trim();
					if (!value) return pane_error($code_error, __("Enter the code you received."));
					pane_error($code_error, null);
					$(e.currentTarget).prop("disabled", true);
					ui.call("onboarding.complete_signup", { request_key: this.ctx.request_key, code: value })
						.then((r) => {
							if (!r.ok) return ui.Toast.warning(r.status || __("The code was not accepted."));
							this.stop_signup_watch();
							ui.Toast.success(__("The account is ready and the credentials are stored."));
							return ui.call("settings.test_connection").then((conn) => {
								this.ctx.connection = conn;
								this.stepper.set_step_valid(!!conn.ok);
								this.render_connection_result();
							});
						})
						.catch((err) => ui.Toast.error(err))
						.finally(() => $(e.currentTarget).prop("disabled", false));
				})
				.appendTo($row);
			if (state && state.code_ttl) {
				note($el, "amber", __("The code is valid for {0} minutes.", [ui.format_int(Math.round(state.code_ttl / 60))]), "es-line-time");
			}
			this.$result = $el; // connection result renders under the code row
		}

		watch_signup() {
			this.stop_signup_watch();
			this._signup_poll = window.setInterval(() => {
				if (document.hidden || !this.ctx.request_key) return;
				ui.call("onboarding.get_signup_status", { request_key: this.ctx.request_key }, { silent: true })
					.then((r) => {
						if (r && r.status === "Completed") {
							this.stop_signup_watch();
							ui.announce(__("The sign-up is confirmed."), { assertive: true });
						}
					})
					.catch(() => {});
			}, SIGNUP_POLL_MS);
		}

		stop_signup_watch() {
			if (this._signup_poll) window.clearInterval(this._signup_poll);
			this._signup_poll = null;
		}

		render_reset($el) {
			$el.html(step_head("es-line-question", __("Reset the platform password"), __("The platform sends reset instructions to the account owner. Come back here with the new keys.")));
			const $form = $('<div class="wa-onb__form"></div>').appendTo($el);
			const identifier = field($form, {
				fieldtype: "Data",
				label: __("Email or mobile number"),
				reqd: 1,
				description: __("The one the platform account was opened with."),
			});
			const $actions = $('<div class="wa-onb__actions"></div>').appendTo($el);
			$(`<button type="button" class="btn btn-default btn-sm">${ui.escape(__("Send reset instructions"))}</button>`)
				.on("click", (e) => {
					const value = (identifier.get_value() || "").trim();
					if (!value) return pane_error(this.$error, __("Enter the email or the mobile number of the account."));
					pane_error(this.$error, null);
					$(e.currentTarget).prop("disabled", true);
					ui.call("onboarding.start_password_reset", { identifier: value })
						.then(() => note(this.$result.empty(), "green", __("Instructions were sent. Follow them, then sign in with the new keys."), "es-line-check"))
						.catch((err) => ui.Toast.error(err))
						.finally(() => $(e.currentTarget).prop("disabled", false));
				})
				.appendTo($actions);
			$(`<button type="button" class="btn btn-default btn-sm">${ui.escape(__("I have the new keys"))}</button>`)
				.on("click", () => {
					this.ctx.path = "signin";
					this.render_credentials();
				})
				.appendTo($actions);
			this.$error = $('<div class="wa-onb__error"></div>').appendTo($el);
			this.$result = $('<div class="wa-onb__result"></div>').appendTo($el);
		}

		// ---- step 3: the first device ---------------------------------------------------------------

		step_device() {
			return {
				key: "device",
				label: __("Device"),
				render: ($body) => {
					this.$device = $body;
				},
				on_show: () => this.render_device(),
				validate: () =>
					ui.call("devices.list_devices").then((r) => {
						const connected = (r.rows || []).filter((d) => d.status === "Connected");
						return connected.length > 0 || __("Pair one device before continuing. Messages are sent from a device.");
					}),
			};
		}

		render_device() {
			const $el = this.$device.empty();
			const $head = $("<div></div>").appendTo($el);
			const $panel = $('<div class="wa-onb__device"></div>').appendTo($el);
			const state = new ui.EmptyState({ wrapper: $panel, state: "loading", rows: 2 });
			return ui
				.call("devices.list_devices")
				.then((r) => {
					const rows = r.rows || [];
					const connected = rows.filter((d) => d.status === "Connected");
					$head.html(
						connected.length
							? step_head("es-line-mobile", __("A device is connected"), __("Messages go out from a device. You can pair another one now or move on and do it later from the Devices screen."))
							: step_head("es-line-mobile", __("Pair the first device"), __("A device is one WhatsApp number. Scan the code with WhatsApp on that phone, and it stays linked until it is signed out."))
					);
					$panel.empty();
					if (connected.length) {
						this.stepper.set_step_valid(true);
						connected.slice(0, 3).forEach((row) => {
							$panel.append(`
								<div class="wa-onb__device-row">
									<span class="wa-onb__device-name" dir="auto">${ui.escape(row.device_name || row.name)}</span>
									<span class="wa-onb__device-phone sanad-tabular" dir="ltr">${ui.escape(row.phone_e164 ? ui.PhoneField.format_display(row.phone_e164) : __("No number yet"))}</span>
									${ui.StatusBadge.html({ label: __("Connected"), colour: "green" })}
								</div>`);
						});
						const $more = $('<div class="wa-onb__actions"></div>').appendTo($panel);
						$(`<button type="button" class="btn btn-default btn-sm">${ui.escape(__("Pair another device"))}</button>`)
							.on("click", () => this.render_pair_form($panel))
							.appendTo($more);
						$(`<button type="button" class="btn btn-default btn-sm">${ui.escape(__("Open devices"))}</button>`)
							.on("click", () => frappe.set_route("wa-devices"))
							.appendTo($more);
						return;
					}
					this.stepper.set_step_valid(false);
					this.render_pair_form($panel);
				})
				.catch((err) => state.error(err, { action: { label: __("Try again"), on_click: () => this.render_device() } }));
		}

		render_pair_form($panel) {
			$panel.empty();
			const $form = $('<div class="wa-onb__form"></div>').appendTo($panel);
			const name = field($form, {
				fieldtype: "Data",
				label: __("Device name"),
				reqd: 1,
				placeholder: __("e.g. Sales device"),
				description: __("It appears in the message log and wherever a device is chosen."),
			});
			const $modes = $(`<div class="wa-onb__field"><span class="wa-onb__label" id="wa-onb-mode">${ui.escape(__("Pairing method"))}</span><div class="sanad-chip-row" role="radiogroup" aria-labelledby="wa-onb-mode"></div></div>`).appendTo($form);
			const $phone = $('<div class="wa-onb__field" hidden></div>').appendTo($form);
			this.pair_mode = "QR";
			[
				{ value: "QR", label: __("QR code") },
				{ value: "Code", label: __("8-digit code") },
			].forEach((mode) => {
				$(`<button type="button" class="sanad-chip" role="radio" aria-checked="${this.pair_mode === mode.value}" data-mode="${mode.value}">${ui.escape(mode.label)}</button>`)
					.on("click", () => {
						this.pair_mode = mode.value;
						$modes.find("[data-mode]").attr("aria-checked", "false");
						$modes.find(`[data-mode="${mode.value}"]`).attr("aria-checked", "true");
						$phone.attr("hidden", mode.value === "Code" ? null : true);
					})
					.appendTo($modes.find(".sanad-chip-row"));
			});
			bind_radio_group($modes.find(".sanad-chip-row"));
			this.pair_phone = new ui.PhoneField({
				wrapper: $phone,
				label: __("WhatsApp number"),
				required: true,
				on_change: ({ phone_e164, valid }) => (this.ctx.pair_phone = valid ? phone_e164 : null),
			});
			this.$error = $('<div class="wa-onb__error"></div>').appendTo($panel);
			const $actions = $('<div class="wa-onb__actions"></div>').appendTo($panel);
			$(`<button type="button" class="btn btn-primary btn-sm">${ui.escape(__("Create and pair"))}</button>`)
				.on("click", (e) => {
					const value = (name.get_value() || "").trim();
					if (!value) return pane_error(this.$error, __("Name the device first."));
					if (this.pair_mode === "Code" && !this.ctx.pair_phone) {
						return pane_error(this.$error, __("Enter the WhatsApp number that will receive the 8-digit code."));
					}
					pane_error(this.$error, null);
					$(e.currentTarget).prop("disabled", true);
					ui.call("devices.create_device", {
						device_name: value,
						phone: this.pair_mode === "Code" ? this.ctx.pair_phone : null,
						pairing_mode: this.pair_mode,
					})
						.then((r) => {
							this.ctx.device = r.name;
							this.start_pairing($panel);
						})
						.catch((err) => ui.Toast.error(err))
						.finally(() => $(e.currentTarget).prop("disabled", false));
				})
				.appendTo($actions);
			this.$pair = $('<div class="wa-onb__pairing"></div>').appendTo($panel);
		}

		start_pairing($panel) {
			const $el = (this.$pair || $('<div class="wa-onb__pairing"></div>').appendTo($panel)).empty();
			this.stop_pairing_watch();
			const state = new ui.EmptyState({ wrapper: $el, state: "loading", rows: 2 });
			return ui
				.call("devices.start_pairing", { device: this.ctx.device, mode: this.pair_mode })
				.then((payload) => {
					this.render_pairing($el, payload || {});
					this.watch_pairing();
				})
				.catch((err) => state.error(err, { action: { label: __("Try again"), on_click: () => this.start_pairing($panel) } }));
		}

		render_pairing($el, payload) {
			const qr = payload.qr_code || "";
			const is_image = /^(data:image|https?:)/.test(qr);
			const steps = [
				__("Open WhatsApp on the phone."),
				__("Menu → Linked devices → Link a device."),
				this.pair_mode === "Code" ? __("Choose “Link with phone number” and enter the code.") : __("Point the camera at the code."),
			];
			$el.html(`
				<div class="wa-onb__pair-grid">
					<div class="wa-onb__pair-code" data-slot="code"></div>
					<div class="wa-onb__pair-how">
						<ol class="wa-onb__pair-steps">${steps.map((s) => `<li>${ui.escape(s)}</li>`).join("")}</ol>
						<p class="wa-onb__pair-status sanad-tone--amber" data-slot="countdown"></p>
					</div>
				</div>`);
			const $code = $el.find('[data-slot="code"]');
			if (this.pair_mode === "Code" && payload.pair_code) {
				$code.html(`<span class="wa-onb__pin sanad-tabular" dir="ltr">${ui.escape(payload.pair_code)}</span>`);
			} else if (is_image) {
				$code.html(`<img class="wa-onb__qr" src="${ui.escape(qr)}" alt="${ui.escape(__("QR code — scan it with WhatsApp on the phone"))}">`);
			} else if (qr) {
				$code.html(`<code class="wa-onb__raw" dir="ltr">${ui.escape(qr)}</code>`);
			} else {
				new ui.EmptyState({
					wrapper: $code,
					state: "empty",
					size: "sm",
					title: __("No code was returned"),
					description: __("The platform did not return a pairing code for this device."),
					action: { label: __("Try again"), on_click: () => this.start_pairing() },
				});
			}
			this.countdown($el.find('[data-slot="countdown"]'), payload.expires_in || 60);
		}

		countdown($el, seconds) {
			let left = Math.max(0, parseInt(seconds, 10) || 60);
			// a per-second live region would talk over everything: only the milestones are spoken
			const spoken = new Set();
			const tick = () => {
				if ([30, 10].includes(left) && !spoken.has(left)) {
					spoken.add(left);
					ui.announce(__("The pairing code expires in {0} seconds.", [left]));
				}
				if (left <= 0) {
					window.clearInterval(this._countdown);
					$el.empty()
						.removeClass("sanad-tone--amber")
						.addClass("sanad-tone--gray")
						.append(`<span>${ui.escape(__("The code expired."))}</span>`)
						.append($(`<button type="button" class="btn btn-default btn-xs">${ui.escape(__("Get a new code"))}</button>`).on("click", () => this.start_pairing()));
					return;
				}
				$el.html(`<span class="wa-onb__dot" aria-hidden="true"></span><span>${ui.escape(__("Waiting for the scan · the code expires in {0} s", [left]))}</span>`);
				left -= 1;
			};
			window.clearInterval(this._countdown);
			tick();
			this._countdown = window.setInterval(tick, 1000);
		}

		watch_pairing() {
			this.stop_pairing_watch(true);
			this._pair_poll = window.setInterval(() => {
				if (document.hidden) return;
				ui.call("devices.poll_status", { device: this.ctx.device }, { silent: true })
					.then((r) => this.apply_device_status(r && r.status))
					.catch(() => {});
			}, POLL_MS);
			this._pair_realtime = (data) => {
				if (data && data.device === this.ctx.device) this.apply_device_status(data.status);
			};
			frappe.realtime.on("wa:device:status", this._pair_realtime);
		}

		stop_pairing_watch(keep_countdown) {
			if (this._pair_poll) window.clearInterval(this._pair_poll);
			this._pair_poll = null;
			if (!keep_countdown && this._countdown) window.clearInterval(this._countdown);
			if (this._pair_realtime) frappe.realtime.off("wa:device:status", this._pair_realtime);
			this._pair_realtime = null;
		}

		apply_device_status(status) {
			if (status !== "Connected") return;
			this.stop_pairing_watch();
			ui.announce(__("The device is paired."), { assertive: true });
			ui.Toast.success(__("The device is paired."));
			this.stepper.set_step_valid(true);
			this.render_device();
		}

		// ---- step 4: the webhook ---------------------------------------------------------------------

		step_webhook() {
			return {
				key: "webhook",
				label: __("Webhook"),
				render: ($body) => {
					this.$webhook = $body;
				},
				on_show: () => this.render_webhook(),
				validate: () => {
					if (this.ctx.webhook && this.ctx.webhook.status === "Active") return true;
					return ui.call("onboarding.get_status").then((status) => {
						this.status = status;
						return (
							this.step_done("webhook") ||
							__("Register the webhook so replies and delivery reports reach this site.")
						);
					});
				},
			};
		}

		render_webhook() {
			const $el = this.$webhook.empty();
			$el.append(step_head("es-line-link", __("Register the webhook"), __("The platform calls this site when a message is delivered, read or answered. Without it, this site never learns what happened.")));
			const $panel = $('<div class="wa-onb__webhook"></div>').appendTo($el);
			const done = this.step_done("webhook");
			this.stepper.set_step_valid(done);
			if (this.status.webhook_url) {
				$panel.append(`
					<div class="wa-onb__kv">
						<span class="wa-onb__kv-label">${ui.escape(__("Endpoint"))}</span>
						<code class="wa-onb__kv-value" dir="ltr">${ui.escape(this.status.webhook_url)}</code>
					</div>`);
			}
			const detail = this.step_detail("webhook");
			note($panel, done ? "green" : "amber", done ? __("The webhook is active.") : __("The webhook is not registered yet. Register it so replies and delivery reports reach this site."), done ? "es-line-check" : "es-line-alert-circle");
			if (!done && detail && detail !== "Not registered") note($panel, "gray", detail, "es-line-details");
			if (done) return;
			const $actions = $('<div class="wa-onb__actions"></div>').appendTo($panel);
			$(`<button type="button" class="btn btn-primary btn-sm">${ui.escape(__("Register the webhook"))}</button>`)
				.on("click", (e) => {
					$(e.currentTarget).prop("disabled", true);
					ui.call("settings.setup_webhook")
						.then((r) => {
							this.ctx.webhook = r;
							ui.Toast.success(__("The webhook is registered."));
							return ui.call("onboarding.get_status").then((status) => {
								this.status = status;
								this.render_webhook();
							});
						})
						.catch((err) => ui.Toast.error(err))
						.finally(() => $(e.currentTarget).prop("disabled", false));
				})
				.appendTo($actions);
		}

		// ---- step 5: review and finish ----------------------------------------------------------------

		step_review() {
			return {
				key: "review",
				label: __("Finish"),
				render: ($body) => {
					this.$review = $body;
				},
				on_show: () => this.render_review(),
			};
		}

		render_review() {
			const $el = this.$review.empty();
			$el.append(step_head("es-line-check", __("Review and finish"), __("Everything below has to be done before this site is marked as set up.")));
			const $list = $('<div class="wa-onb__checklist"></div>').appendTo($el);
			const state = new ui.EmptyState({ wrapper: $list, state: "loading", rows: 4 });
			return ui
				.call("onboarding.get_status")
				.then((status) => {
					this.status = status;
					this.render_checklist($list, { open_step: true });
					const missing = (status.steps || []).filter((s) => !s.done);
					this.stepper.set_step_valid(!missing.length);
					if (missing.length) {
						note($el, "amber", __("{0} is not done yet. Open that step to finish it.", [(STEP_LABEL[missing[0].key] || (() => missing[0].key))()]), "es-line-alert-circle");
					}
				})
				.catch((err) => state.error(err, { action: { label: __("Try again"), on_click: () => this.render_review() } }));
		}

		finish() {
			return ui.call("onboarding.complete_setup").then(() => {
				ui.Toast.success(__("Setup is complete."));
				this.ctx.rerun = false;
				return this.load();
			});
		}

		unbind() {
			this.stop_pairing_watch();
			this.stop_signup_watch();
		}
	}

	whatsapp_next.onboarding.OnboardingScreen = OnboardingScreen;

	frappe.pages["wa-onboarding"].on_page_load = function (wrapper) {
		const page = frappe.ui.make_app_page({
			parent: wrapper,
			title: __("WhatsApp setup"),
			single_column: true,
		});
		wrapper.wa_onboarding = new OnboardingScreen({ page, wrapper });
	};
})();

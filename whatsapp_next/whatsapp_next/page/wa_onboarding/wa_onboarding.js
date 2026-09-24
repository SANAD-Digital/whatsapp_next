// Module role: the WhatsApp setup screen (spec §2 row 1, matrix row 1), built on the design
// prototype `docs/screen/Hub Page - Onboarding.html` and on the product's own control layer.
//
// The prototype is an account flow drawn as a console: a brand rail down the inline-start edge
// carrying the pitch, the free month and **three** steps — بيانات الحساب · الشروط والأحكام ·
// تفعيل الحساب — and beside it one card at a time on a quiet field. That is what this screen is,
// step for step.
//
// The four things this product needs before it can send anything — the platform keys, a linked
// device, the webhook, the flag that says the site is set up — are not steps of that flow and are
// not in that rail. They come **after** the account is active, in their own card reached from the
// "جاهز للعمل" panel, with their own progress inside that card. An account with no device sends
// nothing, but a person signing up is not thinking about webhooks yet.
//
// Every control is the ported layer's (`ui.btn`, `ui.badge`, `ui.rule`, `ui.segmented`, `ui.ico`,
// `.wa-input`, `.wa-card`), every colour is a `--wa-*` token, and every icon comes from the
// prototype's own glyph family. No `frappe.ui.form.make_control`, no Espresso icon, no Desk button.
//
// Every write goes through `api.v1.onboarding` (plus `settings.test_connection` /
// `settings.setup_webhook` and `devices.*`) with `sanad.ui.call`. What the prototype asks for and
// the API has no field for — the sector, the invite coupon, the sign-up password, a recorded
// acceptance of the terms — is built, gated client-side where that is honest, and marked with a
// `TODO(backend)` naming the endpoint it needs. Nothing here invents one.
//
// The Home → wizard redirect stays governed by `WhatsApp Settings.redirect_unregistered_to_wizard`
// and is deliberately not wired here (spec #1: it is enabled last, in phase 10).

frappe.provide("whatsapp_next.onboarding");

(() => {
	const ui = sanad.ui;
	const esc = (v) => ui.escape(v);
	const ico = (name, size) => ui.ico(name, size);
	const SETUP_ROLES = ["System Manager"];
	const POLL_MS = 4000;
	const SIGNUP_POLL_MS = 5000;
	// The prototype signs every new tenant up on the free plan and says so on the ready panel.
	// No endpoint lists the platform's plan codes, so the code is a constant here.
	// TODO(backend): `onboarding.list_plans()` → `[{code, label, price}]`.
	const SIGNUP_PLAN = "free";
	// The prototype's resend lock: the code lives 240 s, resending opens after the first 30 s.
	const RESEND_LOCK_S = 30;
	const DEFAULT_TTL_S = 240;

	const can_setup = () => frappe.user.has_role(SETUP_ROLES);

	// ---------------------------------------------------------------------------------------------
	// Copy the prototype carries as data
	// ---------------------------------------------------------------------------------------------

	// The sector list of the prototype. Reference copy, not data: no DocType holds it and no
	// endpoint returns it, so it lives with the screen that asks for it.
	// TODO(backend): `onboarding.list_sectors()` once the platform stores a tenant's activity.
	const SECTORS = () => [
		__("Trade and retail"), __("Online stores"), __("Restaurants and cafés"), __("Food and beverages"),
		__("Real estate and property marketing"), __("Contracting and construction"), __("Maintenance and home services"),
		__("Health and clinics"), __("Pharmacies and medical supplies"), __("Dental clinics"), __("Beauty and personal care"),
		__("Salons and fitness centres"), __("Education and training"), __("Nurseries and schools"), __("Travel and tourism"),
		__("Shipping and logistics"), __("Cars and spare parts"), __("Furniture and interiors"), __("Electronics and appliances"),
		__("Clothing and fashion"), __("Jewellery and watches"), __("Children's supplies"), __("Pets"),
		__("Agriculture and nurseries"), __("Electrical and plumbing contracting"), __("Event management"),
		__("Photography and production"), __("Technology and software"), __("Marketing and advertising agencies"),
		__("Consulting and law"), __("Accounting and audit"), __("Human resources and recruitment"),
		__("Financial services and finance"), __("Insurance"), __("Factories and manufacturing"), __("Building materials"),
		__("Government services and follow-up"), __("Associations and non-profits"),
	];
	const SECTOR_OTHER = () => __("Other");

	// The terms panel, section by section. The prototype names a different product in §1; the name
	// here is this product's own.
	const TERMS = () => [
		{ h: __("1. Nature of the service"), p: [
			__("WhatsApp Next is an intermediary platform that connects a company's system to its own WhatsApp account to send and receive messages. The platform is not affiliated with Meta and does not represent it, and the WhatsApp account used stays the company's property and its responsibility."),
			__("The service continues for as long as the company's WhatsApp account stays active and is not restricted by the service provider."),
		] },
		{ h: __("2. Ownership of the number and the account"), p: [
			__("The company confirms that the numbers linked to the platform are owned by it or that it is authorised to use them, and that it does not use impersonated or rented numbers for bulk sending."),
			__("Using the service to operate accounts on behalf of other parties without documented authorisation is not allowed."),
		] },
		{ h: __("3. Recipient consent"), p: [
			__("Messages are sent only to someone who has agreed to receive them from the company, or who has a contractual relationship or existing dealings with it."),
			__("A clear way to stop receiving messages must be offered, and stop requests must be answered within a reasonable time with no further sending afterwards."),
		] },
		{ h: __("4. Prohibited content"), p: [
			__("Sending content that breaks the law, is misleading, carries fake offers, or concerns prohibited products such as weapons, narcotics, unlicensed medical products, gambling and unregulated crypto-currencies is not allowed."),
			__("Impersonating another party or using trademarks the company does not own is not allowed."),
		] },
		{ h: __("5. Sending limits and account protection"), p: [
			__("The platform applies daily limits and a sending rate that protect the number from restriction or a ban, and it may lower those limits automatically when recipient reports rise."),
			__("The platform is not responsible for a ban on the number caused by the company breaking the WhatsApp provider's policies, or by sending unwanted content."),
		] },
		{ h: __("6. Data and privacy"), p: [
			__("Messages, their logs and contacts are stored for operation, support and review. They are processed inside a secure technical infrastructure and are not shared with third parties except under a legal order or with the company's consent."),
			__("The company is the controller of its customers' data and carries the responsibility for collecting and using it lawfully under the Personal Data Protection Law."),
			__("Deletion of the data may be requested after the subscription ends, within the period set out in the retention policy."),
		] },
		{ h: __("7. Subscription, renewal and payment"), p: [
			__("The account starts on the free plan. Any upgrade is counted from the activation date and renews automatically unless the renewal is cancelled before the due date."),
			__("Messages already consumed are not refunded, and unused balances do not carry over into the next cycle unless the plan says so."),
		] },
		{ h: __("8. Suspension and termination"), p: [
			__("The platform may suspend the account temporarily when misuse is suspected or reports arrive repeatedly, with notice to the company and a statement of the reason."),
			__("The company may end the subscription at any time, and can export its data before the account is closed."),
		] },
		{ h: __("9. Liability"), p: [
			__("The service is provided as it is. The platform does not guarantee that every message arrives or that the WhatsApp provider's services stay available, and its liability is limited to the subscription value paid for the period in dispute."),
		] },
		{ h: __("10. Changes and governing law"), p: [
			__("These terms may be updated with notice to the company on its approved WhatsApp number before they take effect, and continuing to use the service counts as acceptance of the update."),
			__("These terms are governed by the laws of the Kingdom of Saudi Arabia, and the competent judicial authorities hear any dispute."),
		] },
	];

	// The rail: three steps, exactly the prototype's, with a terminal beyond the last.
	const FLOW = () => [
		{ key: "account", label: __("Account details"), sub: __("The company, the owner and the mobile") },
		{ key: "terms", label: __("Terms and conditions"), sub: __("Read and accept") },
		{ key: "activate", label: __("Activate the account"), sub: __("One confirmation code") },
	];
	const STAGE_STEP = { login: 0, reset: 0, signup: 0, terms: 1, verify: 2 };
	// Beyond the account: these live in their own card, never in the rail.
	const SITE_STAGES = ["connect", "device", "webhook"];

	// ---------------------------------------------------------------------------------------------
	// Small builders in the layer's idiom
	// ---------------------------------------------------------------------------------------------

	/** A labelled field in the ported field idiom. */
	function field_html({ id, label, type = "text", dir, placeholder = "", value = "", mono, autocomplete, required, extra = "" }) {
		return `
			<div class="wa-field" data-field="${id}">
				<label class="wa-field__label" for="${id}">${esc(label)}${required ? ' <span class="wa-field__req" aria-hidden="true">*</span>' : ""}</label>
				<input class="wa-input${mono ? " wa-input--mono" : ""}" id="${id}" type="${type}"
					${dir ? `dir="${dir}"` : ""} ${autocomplete ? `autocomplete="${autocomplete}"` : ""}
					placeholder="${esc(placeholder)}" value="${esc(value)}" ${extra}>
				<span class="wa-field__hint" data-slot="hint"></span>
			</div>`;
	}

	/** A tone strip. The palette's tone inks are made for their own surface, so the word is tinted. */
	function strip_html(tone, text, { icon, role = "status" } = {}) {
		const glyph = icon || { ok: "tick", warn: "warn", danger: "error", info: "info", muted: "info" }[tone];
		return `
			<p class="wa-onb__strip wa-onb__strip--${tone}" role="${role}">
				<span class="wa-onb__strip-icon">${ico(glyph, "sm")}</span>
				<span class="wa-onb__strip-text">${esc(text)}</span>
			</p>`;
	}

	/** Password strength, scored the way the prototype scores it (0–4). */
	function pw_score(pw) {
		let n = 0;
		if (!pw) return 0;
		if (pw.length >= 8) n += 1;
		if (pw.length >= 12) n += 1;
		if (/[0-9]/.test(pw) && /[a-z]/.test(pw) && /[A-Z]/.test(pw)) n += 1;
		if (/[^A-Za-z0-9]/.test(pw)) n += 1;
		return Math.min(4, n);
	}

	const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
	const COUPON_RE = /^[A-Z]{3,6}-[A-Z0-9]{3,8}$/;

	/** A 14-character password with one of each class, shuffled — the prototype's generator. */
	function generate_password() {
		const up = "ABCDEFGHJKLMNPQRSTUVWXYZ";
		const lo = "abcdefghijkmnopqrstuvwxyz";
		const nu = "23456789";
		const sy = "!@#$%&*?";
		const all = up + lo + nu + sy;
		const pick = (set) => set[Math.floor(Math.random() * set.length)];
		const out = [pick(up), pick(lo), pick(nu), pick(sy)];
		while (out.length < 14) out.push(pick(all));
		return out.sort(() => Math.random() - 0.5).join("");
	}

	function copy_to_clipboard(text) {
		try {
			return navigator.clipboard.writeText(text);
		} catch (e) {
			return Promise.reject(e);
		}
	}

	// ---------------------------------------------------------------------------------------------
	// The screen
	// ---------------------------------------------------------------------------------------------
	class OnboardingScreen {
		constructor({ page, wrapper }) {
			this.page = page;
			this.wrapper = wrapper;
			this.s = {
				stage: "signup",
				busy: false,
				err: "",
				tried: false,
				read: false,
				show_pw: false,
				channel: "whatsapp",
				verify: "idle",
				left: DEFAULT_TTL_S,
				rerun: false,
			};
			this.f = { org: "", sector: "", sector_other: "", person: "", email: "", phone: "", phone_ok: false, password: "", password2: "", coupon: "" };
			this.ctx = {};
			// `.wa` switches the ported controls to the comfortable density
			this.$screen = $('<div class="wa wa-onb"></div>').appendTo(page.main);
			this.make_shell();
			this.load();
			$(wrapper).on("hide", () => this.unbind());
		}

		// ---- the console ---------------------------------------------------------------------------

		make_shell() {
			this.$screen.html(`
				<aside class="wa-onb__brand">
					<div class="wa-onb__brand-id">
						<span class="wa-onb__brand-logo">${ico("whatsapp", "md")}</span>
						<span class="wa-onb__brand-names">
							<b class="wa-onb__brand-name">${esc(__("WhatsApp Next"))}</b>
							<span class="wa-onb__brand-tag">${esc(__("A professional presence in every message"))}</span>
						</span>
					</div>

					<div class="wa-onb__pitch">
						<span class="wa-onb__badge">
							<span class="wa-onb__badge-dot" aria-hidden="true"></span>
							${esc(__("A full month free · no card"))}
						</span>
						<h2 class="wa-onb__pitch-title">${esc(__("Send your first message in two minutes"))}</h2>
						<p class="wa-onb__pitch-body">${esc(__("Connect your company's WhatsApp to your own system and send invoices, reminders and customer replies from one place. Try it for a full month with nothing to commit to, and stop it any time with one click."))}</p>
						<ul class="wa-onb__ticks">
							<li class="wa-onb__tick">${ico("tick", "xs")}${esc(__("A direct link to ERPNext with no code to write"))}</li>
							<li class="wa-onb__tick">${ico("tick", "xs")}${esc(__("Your number stays yours — ban protection and sensible sending limits"))}</li>
							<li class="wa-onb__tick">${ico("tick", "xs")}${esc(__("Arabic support, and open source you can read yourself"))}</li>
						</ul>
					</div>

					<ol class="wa-onb__flow" data-slot="flow"></ol>

					<div class="wa-onb__brand-foot">
						<div class="wa-onb__chips">
							<a class="wa-onb__chip" href="https://sanad.digital/whatsapp-erpnext" target="_blank" rel="noopener">${ico("link", "xs")}${esc(__("Website and documentation"))}</a>
							<a class="wa-onb__chip" href="https://github.com/sanad-digital" target="_blank" rel="noopener">${ico("code", "xs")}${esc(__("Open source"))}</a>
						</div>
						<p class="wa-onb__support">${esc(__("Need help? Support is on 8001234567"))}</p>
						<p class="wa-onb__rights">${esc(__("Sanad Digital · all rights reserved"))}</p>
					</div>
				</aside>

				<div class="wa-onb__main">
					<div class="wa-onb__topbar">
						<span class="wa-onb__topmark">
							<span class="wa-onb__topmark-logo">${ico("whatsapp", "sm")}</span>
							<b>${esc(__("WhatsApp Next"))}</b>
						</span>
						<span class="wa-onb__topbar-spacer"></span>
						<span class="wa-onb__counter" data-slot="counter" aria-live="polite"></span>
						<span data-slot="theme"></span>
					</div>
					<div class="wa-onb__mbar" data-slot="mbar"></div>
					<div class="wa-onb__stage" data-slot="stage"></div>
				</div>`);
			this.$flow = this.$screen.find('[data-slot="flow"]');
			this.$counter = this.$screen.find('[data-slot="counter"]');
			this.$mbar = this.$screen.find('[data-slot="mbar"]');
			this.$stage = this.$screen.find('[data-slot="stage"]');
			this.make_theme_toggle();
		}

		/**
		 * The prototype's corner theme switch. Desk owns the theme, so this drives Desk's own
		 * (`frappe.ui.set_theme` + the user preference), and the palette follows through
		 * `_tokens.scss`'s `[data-theme="dark"]` block.
		 */
		make_theme_toggle() {
			const label = () => (frappe.ui.get_current_theme() === "dark" ? __("Light mode") : __("Dark mode"));
			const $slot = this.$screen.find('[data-slot="theme"]');
			const draw = () => {
				$slot.html(ui.btn({ label: label(), variant: "ghost", size: "sm", attrs: { "data-act": "theme" } }));
			};
			draw();
			$slot.on("click", '[data-act="theme"]', () => {
				const next = frappe.ui.get_current_theme() === "dark" ? "light" : "dark";
				frappe.ui.set_theme(next);
				draw();
				frappe
					.xcall("frappe.core.doctype.user.user.switch_theme", { theme: next === "dark" ? "Dark" : "Light" })
					.catch(() => {});
			});
		}

		// ---- status -------------------------------------------------------------------------------

		load() {
			this.$flow.empty();
			this.$mbar.empty();
			this.$counter.text("");
			this.$stage.html(`<div class="wa-card wa-onb__card wa-onb__card--md">${ui.skeleton(4)}</div>`);
			return ui
				.call("onboarding.get_status")
				.then((status) => {
					this.status = status || {};
					this.resume();
				})
				.catch((err) => this.render_error(err, () => this.load()));
		}

		render_error(err, retry) {
			this.$stage.html(`
				<section class="wa-card wa-onb__card wa-onb__card--sm wa-onb__fail" role="alert">
					<span class="wa-onb__fail-mark">${ico("error", "lg")}</span>
					<h2 class="wa-onb__card-title">${esc(__("The setup could not be read"))}</h2>
					<p class="wa-onb__card-sub">${esc((err && err.message) || __("Something went wrong. Please try again."))}</p>
					<div class="wa-btnbar">${ui.btn({ label: __("Try again"), variant: "primary", attrs: { "data-act": "retry" } })}</div>
				</section>`);
			this.$stage.find('[data-act="retry"]').on("click", () => retry());
		}

		step_done(key) {
			const step = (this.status.steps || []).find((s) => s.key === key);
			return !!(step && step.done);
		}

		step_detail(key) {
			const step = (this.status.steps || []).find((s) => s.key === key);
			return (step && step.detail) || "";
		}

		/** The first part of connecting this site that is still missing. */
		first_open_site_stage() {
			if (!this.step_done("credentials") || !this.step_done("connection")) return "connect";
			if (!this.step_done("device")) return "device";
			if (!this.step_done("webhook")) return "webhook";
			return null;
		}

		/**
		 * Open where this site actually stands. An account that already has its keys is an account
		 * that exists, so the rail is complete and the screen opens on "جاهز للعمل" — with the card
		 * beneath it saying what is left to connect.
		 */
		resume() {
			if (this.status.setup_completed && !this.s.rerun) return this.set_state({ stage: "ready" });
			if (this.step_done("credentials")) return this.set_state({ stage: "ready" });
			return this.set_state({ stage: "signup" });
		}

		set_state(patch, redraw = true) {
			// An error belongs to the card that raised it; moving card clears it unless carried on.
			if (patch.stage && patch.stage !== this.s.stage && patch.err === undefined) patch.err = "";
			Object.assign(this.s, patch);
			if (redraw) this.render();
			return this;
		}

		// ---- the rail ------------------------------------------------------------------------------

		/** `true` once the account exists — the rail is complete and the terminal is showing. */
		account_done() {
			return this.s.stage === "ready" || SITE_STAGES.includes(this.s.stage);
		}

		render_flow() {
			const steps = FLOW();
			const done_all = this.account_done();
			const at = done_all ? steps.length : STAGE_STEP[this.s.stage] || 0;
			this.$flow.empty();
			steps.forEach((step, i) => {
				const done = done_all || i < at;
				const current = !done_all && i === at;
				$(`
					<li class="wa-onb__flow-item${current ? " wa-onb__flow-item--current" : done ? " wa-onb__flow-item--done" : ""}"${current ? ' aria-current="step"' : ""}>
						<span class="wa-onb__flow-num">${done ? ico("tick", "xs") : i + 1}</span>
						<span class="wa-onb__flow-text">
							<span class="wa-onb__flow-label">${esc(step.label)}</span>
							<span class="wa-onb__flow-sub">${esc(step.sub)}</span>
						</span>
						<span class="wa-onb__sr">${esc(done ? __("Done") : current ? __("Current step") : __("Not done yet"))}</span>
					</li>`).appendTo(this.$flow);
			});

			this.$counter.text(done_all ? __("Registration complete") : __("Step {0} of {1}", [at + 1, steps.length]));
			this.$mbar.html(`
				<div class="wa-onb__mbar-track" role="presentation">
					${steps.map((s, i) => `<span class="wa-onb__mbar-seg${done_all || i <= at ? " wa-onb__mbar-seg--on" : ""}"></span>`).join("")}
				</div>
				<p class="wa-onb__mbar-line">
					<b>${esc(done_all ? __("Registration complete") : steps[at].label)}</b>
					<span>${esc(done_all ? __("The account is ready to use") : steps[at].sub)}</span>
				</p>`);
		}

		// ---- the stage ------------------------------------------------------------------------------

		render() {
			this.stop_timers();
			this.render_flow();
			this.$stage.empty();
			if (!can_setup()) return this.card_readonly();
			const by_stage = {
				signup: () => this.card_signup(),
				terms: () => this.card_terms(),
				verify: () => this.card_verify(),
				login: () => this.card_login(),
				reset: () => this.card_reset(),
				ready: () => this.card_ready(),
				connect: () => this.card_connect(),
				device: () => this.card_device(),
				webhook: () => this.card_webhook(),
			};
			(by_stage[this.s.stage] || by_stage.signup)();
		}

		/** A card shell: the prototype's surface, its head, and a slot for the error banner. */
		card(size, { title, sub, badge, aside } = {}) {
			const $card = $(`<section class="wa-card wa-onb__card wa-onb__card--${size}"></section>`).appendTo(this.$stage);
			if (title) {
				$card.append(`
					<div class="wa-onb__card-head">
						<div class="wa-onb__card-heading">
							<div class="wa-onb__card-titles">
								<h2 class="wa-onb__card-title">${esc(title)}</h2>
								${badge || ""}
							</div>
							${sub ? `<p class="wa-onb__card-sub">${esc(sub)}</p>` : ""}
						</div>
						${aside ? `<div class="wa-onb__card-aside">${aside}</div>` : ""}
					</div>`);
			}
			this.$err = $('<div class="wa-onb__errslot"></div>').appendTo($card);
			this.show_error(this.s.err);
			return $card;
		}

		show_error(text) {
			if (!this.$err) return;
			this.s.err = text || "";
			this.$err.empty();
			if (!text) return;
			this.$err.html(strip_html("danger", text, { role: "alert" }));
			ui.announce(text, { assertive: true });
		}

		/** Put a button in its working state and give it back when the promise settles. */
		busy_button($btn, label_busy, promise) {
			const $label = $btn.find("span").last();
			const before = $label.text();
			$btn.prop("disabled", true).addClass("wa-onb__btn--busy");
			if (label_busy) $label.text(label_busy);
			return promise.finally(() => {
				$btn.prop("disabled", false).removeClass("wa-onb__btn--busy");
				$label.text(before);
			});
		}

		// ---- a manager who may watch but not write ---------------------------------------------------

		card_readonly() {
			const $card = this.card("md", {
				title: __("Setup status"),
				sub: __("Only a System Manager can run this setup. These are the steps and where they stand."),
			});
			this.checklist($('<div class="wa-onb__checklist"></div>').appendTo($card));
		}

		checklist($el) {
			const labels = {
				credentials: __("Credentials"),
				connection: __("Connection"),
				device: __("Device"),
				webhook: __("Webhook"),
			};
			$el.empty();
			(this.status.steps || []).forEach((step) => {
				$el.append(`
					<div class="wa-onb__check${step.done ? " wa-onb__check--done" : ""}">
						<span class="wa-onb__check-mark">${ico(step.done ? "tick" : "clock", "sm")}</span>
						<span class="wa-onb__check-text">
							<b>${esc(labels[step.key] || step.key)}</b>
							<span>${esc(step.detail || (step.done ? __("Done") : __("Not done yet")))}</span>
						</span>
						${ui.badge(step.done ? __("Done") : __("To do"), step.done ? "ok" : "muted")}
					</div>`);
			});
		}

		// =============================================================================================
		// Step 1 — account details
		// =============================================================================================

		card_signup() {
			const dev = !!(frappe.boot && frappe.boot.developer_mode);
			const $card = this.card("lg", {
				title: __("Account details"),
				sub: __("One minute, and the registration is done."),
				badge: ui.badge(__("One free month · no card"), "ok"),
				aside: dev
					? ui.btn({
							label: __("Fill in demo data"),
							icon: "note",
							variant: "ghost",
							size: "sm",
							title: __("For testing only — fills the fields with made-up data"),
							attrs: { "data-act": "devfill" },
						})
					: null,
			});

			// ---- the company ----------------------------------------------------------------------
			const $org = $('<div class="wa-onb__group"></div>').appendTo($card);
			$org.append(ui.rule(__("Company details"), __("Required")));
			const $grid = $('<div class="wa-onb__grid"></div>').appendTo($org);
			$grid.append(field_html({ id: "wa-onb-org", label: __("Company name"), placeholder: __("Sanad Trading Company"), value: this.f.org, autocomplete: "organization", required: true, extra: 'data-f="org"' }));
			$grid.append(this.sector_html());
			$grid.append(field_html({ id: "wa-onb-person", label: __("Owner's name"), placeholder: __("Abdullah Al-Fahd"), value: this.f.person, autocomplete: "name", required: true, extra: 'data-f="person"' }));
			$grid.append(field_html({ id: "wa-onb-email", label: __("Email"), type: "email", dir: "ltr", placeholder: "email@company.com", value: this.f.email, autocomplete: "email", required: true, extra: 'data-f="email"' }));
			// the mobile takes the whole row: the country trigger, the hint and the line that says
			// what this number is for need more than half a column
			const $phone = $('<div class="wa-onb__field-wide"></div>').appendTo($grid);
			this.phone = new ui.PhoneField({
				wrapper: $phone,
				label: __("Mobile number (WhatsApp)"),
				required: true,
				value: this.f.phone,
				tip: __("This is the account's own contact number: password recovery, subscription, payment and renewal notices, system alerts and support messages. It is not the device number your customers' messages go out from — that one is linked later, from the Devices screen."),
				on_change: ({ phone_e164, valid }) => {
					this.f.phone = phone_e164 || "";
					this.f.phone_ok = !!valid;
				},
			});

			// ---- the password ------------------------------------------------------------------------
			//
			// The provider already takes a password on `complete_signup`, but the service and the
			// whitelisted endpoint do not forward one, so what is typed here never leaves the browser.
			// It is still asked for: the prototype asks for it, and the rules it teaches belong with
			// the sign-up rather than a later "set your password" e-mail.
			// TODO(backend): `onboarding.complete_signup(request_key, code, password)` →
			// `services.onboarding.complete_signup(..., password)` → `provider.complete_signup(...,
			// password=…)`, which accepts it already (`providers/snd_platform.py:440`).
			const $pw = $('<div class="wa-onb__group"></div>').appendTo($card);
			$pw.append(ui.rule(__("Password"), __("Required")));
			const $pwgrid = $('<div class="wa-onb__grid"></div>').appendTo($pw);
			$pwgrid.append(`
				<div class="wa-field" data-field="wa-onb-pw">
					<span class="wa-onb__label-row">
						<label class="wa-field__label" for="wa-onb-pw">${esc(__("Password"))} <span class="wa-field__req" aria-hidden="true">*</span></label>
						${ui.btn({ label: __("Generate"), icon: "plus", variant: "tonal", size: "sm", title: __("Generate a strong password"), attrs: { "data-act": "genpw" } })}
						${ui.btn({ label: this.s.show_pw ? __("Hide") : __("Show"), variant: "ghost", size: "sm", title: __("Show the password"), attrs: { "data-act": "showpw", "aria-pressed": String(this.s.show_pw) } })}
					</span>
					<input class="wa-input wa-input--mono" id="wa-onb-pw" data-f="password" type="${this.s.show_pw ? "text" : "password"}"
						autocomplete="new-password" placeholder="••••••••" value="${esc(this.f.password)}" aria-describedby="wa-onb-pw-hint">
					<span class="wa-onb__pwbars" data-slot="pwbars" aria-hidden="true">
						<span class="wa-onb__pwbar"></span><span class="wa-onb__pwbar"></span><span class="wa-onb__pwbar"></span><span class="wa-onb__pwbar"></span>
					</span>
					<span class="wa-field__hint" id="wa-onb-pw-hint" data-slot="hint" aria-live="polite"></span>
				</div>`);
			$pwgrid.append(field_html({ id: "wa-onb-pw2", label: __("Confirm the password"), type: this.s.show_pw ? "text" : "password", placeholder: "••••••••", value: this.f.password2, mono: true, autocomplete: "new-password", required: true, extra: 'data-f="password2"' }));

			// ---- the invite coupon ---------------------------------------------------------------------
			//
			// Checked for shape here and going no further: no endpoint accepts one, and `start_signup`
			// has no parameter it could honestly ride on.
			// TODO(backend): `onboarding.apply_coupon(code)`, or a `coupon` parameter on
			// `onboarding.start_signup`, reaching the platform's referral ledger.
			const $cp = $('<div class="wa-onb__group"></div>').appendTo($card);
			$cp.append(ui.rule(__("Invite coupon"), __("Optional")));
			$cp.append(field_html({ id: "wa-onb-coupon", label: __("A coupon a customer invited you with — one extra free month"), dir: "ltr", placeholder: "BSHQ-FREE2", value: this.f.coupon, mono: true, extra: 'data-f="coupon"' }));

			// ---- the verbs -------------------------------------------------------------------------------
			$card.append(`
				<div class="wa-btnbar">
					${ui.btn({ label: __("Next — terms and conditions"), variant: "primary", cls: "wa-onb__grow", attrs: { "data-act": "to-terms" } })}
					${ui.btn({ label: __("I have an account — sign in"), variant: "secondary", attrs: { "data-act": "to-login" } })}
				</div>`);

			this.bind_signup($card);
		}

		/** The activity picker: a combobox with a search box and an "other" escape hatch. */
		sector_html() {
			const other = this.f.sector === SECTOR_OTHER();
			return `
				<div class="wa-field wa-onb__sector-field" data-sec-root="1">
					<span class="wa-field__label" id="wa-onb-sector-label">${esc(__("Activity"))}</span>
					<div class="wa-onb__sector" data-slot="sector">
						${
							other
								? `<span class="wa-affix wa-affix--on-end">
										<input class="wa-input" data-f="sector_other" type="text" placeholder="${esc(__("Write the company's activity"))}" value="${esc(this.f.sector_other)}" aria-labelledby="wa-onb-sector-label">
										<button type="button" class="wa-affix__on wa-affix__on--end" data-act="sector-list">${esc(__("List"))}</button>
									</span>`
								: `<button type="button" class="wa-onb__sector-btn" data-act="sector-toggle" aria-expanded="false"
										aria-haspopup="listbox" aria-labelledby="wa-onb-sector-label wa-onb-sector-value">
										<span class="wa-onb__sector-value" id="wa-onb-sector-value">${esc(this.f.sector || __("Choose the company's activity"))}</span>
										<span class="wa-onb__sector-caret">${ico("caret", "xs")}</span>
									</button>`
						}
					</div>
				</div>`;
		}

		bind_signup($card) {
			const self = this;

			// every input writes straight into the model; only its own hint redraws, so the caret
			// never jumps and a full re-render is never needed while typing
			$card.on("input", "[data-f]", function () {
				const key = $(this).data("f");
				let value = this.value;
				if (key === "coupon") {
					const start = this.selectionStart;
					value = value.toUpperCase();
					if (this.value !== value) {
						this.value = value;
						this.setSelectionRange(start, start);
					}
				}
				self.f[key] = value;
				self.show_error("");
				self.refresh_field($card, key);
			});
			$card.on("blur", '[data-f="coupon"]', function () {
				self.f.coupon = this.value.trim().toUpperCase();
				this.value = self.f.coupon;
				self.refresh_field($card, "coupon");
			});

			$card.on("click", '[data-act="genpw"]', () => {
				const pw = generate_password();
				this.f.password = pw;
				this.f.password2 = pw;
				this.s.show_pw = true;
				$card.find('[data-f="password"], [data-f="password2"]').val(pw).attr("type", "text");
				$card.find('[data-act="showpw"] span').last().text(__("Hide"));
				$card.find('[data-act="showpw"]').attr("aria-pressed", "true");
				this.refresh_field($card, "password");
				this.refresh_field($card, "password2");
				ui.announce(__("A strong password was generated and filled into both fields."));
			});

			$card.on("click", '[data-act="showpw"]', () => {
				this.s.show_pw = !this.s.show_pw;
				$card.find('[data-f="password"], [data-f="password2"]').attr("type", this.s.show_pw ? "text" : "password");
				$card.find('[data-act="showpw"] span').last().text(this.s.show_pw ? __("Hide") : __("Show"));
				$card.find('[data-act="showpw"]').attr("aria-pressed", String(this.s.show_pw));
			});

			$card.on("click", '[data-act="devfill"]', () => {
				Object.assign(this.f, {
					org: __("Sanad Trading Company"),
					sector: SECTORS()[0],
					sector_other: "",
					person: __("Abdullah Al-Fahd"),
					email: "ops@sanad-trading.com",
					password: "Sanad#2026pro",
					password2: "Sanad#2026pro",
					phone: "+966551234567",
					phone_ok: true,
					coupon: "",
				});
				this.s.tried = false;
				this.render();
			});

			$card.on("click", '[data-act="to-terms"]', () => this.to_terms($card));
			$card.on("click", '[data-act="to-login"]', () => this.set_state({ stage: "login" }));

			this.bind_sector($card);
			["org", "person", "email", "password", "password2", "coupon"].forEach((k) => this.refresh_field($card, k));
		}

		/** Redraw one field's hint and frame from the model — never the whole card. */
		refresh_field($card, key) {
			const $input = $card.find(`[data-f="${key}"]`);
			const $field = $input.closest(".wa-field");
			const $hint = $field.find('[data-slot="hint"]');
			const tried = this.s.tried;
			const set = (tone, text) => {
				$field.removeClass("wa-onb__ok wa-onb__bad");
				if (tone) $field.addClass(tone === "ok" ? "wa-onb__ok" : "wa-onb__bad");
				$input.attr("aria-invalid", tone === "bad" ? "true" : null);
				$hint.attr("class", `wa-field__hint${tone ? ` wa-onb__hint--${tone}` : ""}`).html(
					text ? `${tone ? `<span class="wa-onb__hint-icon">${ico(tone === "ok" ? "tick" : "warn", "xs")}</span>` : ""}<span>${esc(text)}</span>` : ""
				);
			};

			if (key === "org") return set(tried && !this.f.org ? "bad" : null, tried && !this.f.org ? __("Enter the company name as it stands in the commercial register") : "");
			if (key === "person") return set(tried && !this.f.person ? "bad" : null, tried && !this.f.person ? __("Enter the name of the person who owns the account") : "");
			if (key === "email") {
				if (!this.f.email) return set(null, "");
				const ok = EMAIL_RE.test(this.f.email);
				return set(ok ? "ok" : "bad", ok ? __("The email format is valid") : __("The email format is not valid — for example email@company.com"));
			}
			if (key === "password") {
				const pw = this.f.password;
				const score = pw_score(pw);
				const tone = !pw ? "" : score <= 1 ? "danger" : score === 2 ? "warn" : "ok";
				$card.find('[data-slot="pwbars"] .wa-onb__pwbar').each((i, bar) => {
					$(bar).attr("class", `wa-onb__pwbar${i < score && tone ? ` wa-onb__pwbar--${tone}` : ""}`);
				});
				const text = !pw
					? __("At least 8 characters, with digits, capitals, small letters and a symbol")
					: score <= 1
						? __("Weak — add digits, capital letters and a symbol")
						: score === 2
							? __("Medium — make it longer or add a symbol")
							: score === 3
								? __("Strong")
								: __("Very strong");
				set(!pw ? null : score <= 1 ? "bad" : score === 2 ? null : "ok", text);
				return this.refresh_field($card, "password2");
			}
			if (key === "password2") {
				const p2 = this.f.password2;
				if (!p2) return set(null, __("Type the password again to confirm it"));
				const ok = p2 === this.f.password;
				return set(ok ? "ok" : "bad", ok ? __("They match") : __("The two passwords do not match"));
			}
			if (key === "coupon") {
				const raw = (this.f.coupon || "").trim();
				if (!raw) return set(null, __("If one of our customers invited you, enter their coupon and start with one extra free month."));
				const ok = COUPON_RE.test(raw);
				return set(ok ? "ok" : "bad", ok ? __("The coupon looks right — it is checked when the account is activated.") : __("The coupon's shape is not right — for example BSHQ-FREE2."));
			}
			return this;
		}

		/** The sector combobox: open, search, pick, or turn the search text into a custom activity. */
		bind_sector($card) {
			const self = this;
			const close = () => {
				$card.find(".wa-onb__sector-pop").remove();
				$card.find('[data-act="sector-toggle"]').attr("aria-expanded", "false");
			};
			this.close_sector = close;

			const open = () => {
				if ($card.find(".wa-onb__sector-pop").length) return close();
				const $pop = $(`
					<div class="wa-onb__sector-pop">
						<div class="wa-onb__sector-search">
							${ico("search", "xs")}
							<input type="text" class="wa-onb__sector-q" placeholder="${esc(__("Search for an activity"))}" aria-label="${esc(__("Search for an activity"))}" role="combobox" aria-expanded="true" aria-controls="wa-onb-sector-list" aria-autocomplete="list">
						</div>
						<ul class="wa-onb__sector-list" id="wa-onb-sector-list" role="listbox" aria-label="${esc(__("Activity"))}"></ul>
					</div>`).appendTo($card.find('[data-slot="sector"]'));
				$card.find('[data-act="sector-toggle"]').attr("aria-expanded", "true");
				const $list = $pop.find(".wa-onb__sector-list");
				const $q = $pop.find(".wa-onb__sector-q");

				const draw = () => {
					const q = ($q.val() || "").trim();
					const all = SECTORS().concat([SECTOR_OTHER()]);
					const rows = q ? all.filter((l) => l.toLowerCase().indexOf(q.toLowerCase()) >= 0) : all;
					$list.empty();
					rows.forEach((label) => {
						$(`<li class="wa-onb__sector-opt${label === self.f.sector ? " wa-onb__sector-opt--on" : ""}" role="option" tabindex="-1" aria-selected="${label === self.f.sector}">${esc(label)}</li>`)
							.on("click", () => {
								self.f.sector = label;
								if (label !== SECTOR_OTHER()) self.f.sector_other = "";
								close();
								self.redraw_sector($card);
							})
							.appendTo($list);
					});
					if (!rows.length && q) {
						$(`<li class="wa-onb__sector-none" role="option" tabindex="-1" aria-selected="false">${esc(__("No match — use «{0}» as a custom activity", [q]))}</li>`)
							.on("click", () => {
								self.f.sector = SECTOR_OTHER();
								self.f.sector_other = q;
								close();
								self.redraw_sector($card);
							})
							.appendTo($list);
					}
				};
				draw();
				$q.on("input", draw);
				$q.on("keydown", (e) => {
					const items = $list.children().toArray();
					if (!items.length) return;
					const at = items.findIndex((el) => el.classList.contains("wa-onb__sector-opt--cursor"));
					if (e.key === "ArrowDown" || e.key === "ArrowUp") {
						e.preventDefault();
						const next = e.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
						items.forEach((el) => el.classList.remove("wa-onb__sector-opt--cursor"));
						items[next].classList.add("wa-onb__sector-opt--cursor");
						items[next].scrollIntoView({ block: "nearest" });
					} else if (e.key === "Enter") {
						e.preventDefault();
						$(items[at >= 0 ? at : 0]).trigger("click");
					}
				});
				window.setTimeout(() => $q.trigger("focus"), 20);
			};

			$card.on("click", '[data-act="sector-toggle"]', open);
			$card.on("click", '[data-act="sector-list"]', () => {
				this.f.sector = "";
				this.f.sector_other = "";
				this.redraw_sector($card);
			});
			$card.on("keydown", '[data-act="sector-toggle"]', (e) => {
				if (e.key === "ArrowDown" || e.key === " " || e.key === "Enter") {
					e.preventDefault();
					open();
				}
			});

			this.on_doc_down = (e) => {
				if (!$(e.target).closest('[data-sec-root="1"]').length) close();
			};
			this.on_doc_esc = (e) => {
				if (e.key === "Escape" && $card.find(".wa-onb__sector-pop").length) {
					e.stopPropagation();
					close();
					$card.find('[data-act="sector-toggle"]').trigger("focus");
				}
			};
			document.addEventListener("mousedown", this.on_doc_down);
			document.addEventListener("keydown", this.on_doc_esc, true);
		}

		redraw_sector($card) {
			$card.find(".wa-onb__sector-field").replaceWith(this.sector_html());
			if (this.f.sector === SECTOR_OTHER()) $card.find('[data-f="sector_other"]').trigger("focus");
			else $card.find('[data-act="sector-toggle"]').trigger("focus");
		}

		/** The gate between the account details and the terms — the prototype's own field rules. */
		to_terms($card) {
			this.s.tried = true;
			["org", "person", "email", "password", "password2"].forEach((k) => this.refresh_field($card, k));
			const problems = [
				[!this.f.org, '[data-f="org"]'],
				[!this.f.person, '[data-f="person"]'],
				[!this.f.phone_ok, ".sanad-phone__input"],
				[!EMAIL_RE.test(this.f.email || ""), '[data-f="email"]'],
				[(this.f.password || "").length < 8, '[data-f="password"]'],
				[this.f.password !== this.f.password2, '[data-f="password2"]'],
			].filter(([bad]) => bad);
			if (problems.length) {
				this.show_error(__("Some fields still need attention before the terms."));
				$card.find(problems[0][1]).trigger("focus");
				return;
			}
			this.set_state({ stage: "terms", tried: false });
		}

		// =============================================================================================
		// Step 2 — the terms
		// =============================================================================================

		card_terms() {
			const $card = this.card("lg", { title: __("Terms of use and the WhatsApp Business policy") });
			$card.find(".wa-onb__card-titles").append('<span data-slot="readmark"></span>');

			const $box = $(`<div class="wa-sunken wa-onb__terms" tabindex="0" role="region" aria-label="${esc(__("Terms of use and the WhatsApp Business policy"))}"></div>`).appendTo($card);
			TERMS().forEach((section) => {
				const $sec = $('<div class="wa-onb__terms-sec"></div>').appendTo($box);
				$sec.append(`<h3 class="wa-onb__terms-h">${esc(section.h)}</h3>`);
				section.p.forEach((line) => $sec.append(`<p class="wa-onb__terms-p">${esc(line)}</p>`));
			});
			$box.append(`<p class="wa-onb__terms-foot">${esc(__("Last updated: 1 September 2026. The full text of the terms is on the «Terms and policies» page inside the system."))}</p>`);

			$card.append(`<p class="wa-onb__consent">${esc(__("By pressing «Create the account» you confirm that you have read and accepted the terms, the privacy policy and the WhatsApp Business policy, that the numbers used belong to the company, and that you agree to receive subscription and support notices on the registered WhatsApp number."))}</p>`);

			const $bar = $('<div class="wa-btnbar"></div>').appendTo($card);
			$bar.append(ui.btn({ label: __("Back to the account details"), variant: "secondary", attrs: { "data-act": "back" } }));

			const draw_gate = () => {
				$card.find('[data-slot="readmark"]').html(
					this.s.read ? ui.badge(__("Read"), "ok") : ui.badge(__("Scroll down to read the terms"), "warn")
				);
				$bar.find('[data-act="signup"], [data-act="jump"]').remove();
				const html = this.s.read
					? ui.btn({ label: __("Create the account"), variant: "primary", cls: "wa-onb__grow", attrs: { "data-act": "signup" } })
					: ui.btn({ label: __("Read the terms to the end to switch on «Create the account»"), icon: "caret", variant: "ghost", cls: "wa-onb__grow wa-onb__gate", attrs: { "data-act": "jump" } });
				$(html).prependTo($bar);
			};
			draw_gate();

			$box.on("scroll", () => {
				if (this.s.read) return;
				const el = $box[0];
				if (el.scrollTop + el.clientHeight >= el.scrollHeight - 12) {
					this.s.read = true;
					draw_gate();
					ui.announce(__("The terms have been read to the end. You can create the account."));
				}
			});
			// a box that does not scroll can never reach its own end: read it as read
			window.setTimeout(() => {
				const el = $box[0];
				if (el && !this.s.read && el.scrollHeight <= el.clientHeight + 12) {
					this.s.read = true;
					draw_gate();
				}
			}, 0);

			$card.on("click", '[data-act="jump"]', () => $box[0].scrollTo({ top: $box[0].scrollHeight, behavior: "smooth" }));
			$card.on("click", '[data-act="back"]', () => this.set_state({ stage: "signup" }));
			$card.on("click", '[data-act="signup"]', (e) => this.start_signup($(e.currentTarget)));
		}

		/**
		 * Ask the platform for an account. It is given what the endpoint takes: the plan, the mobile,
		 * the name, the email and the channel the code should arrive on.
		 *
		 * TODO(backend): the sector (`f.sector` / `sector_other`), the invite coupon (`f.coupon`),
		 * the password (`f.password`) and the fact that the terms were read and accepted all stop
		 * here. They want, in order: `onboarding.start_signup(..., sector, coupon)`,
		 * `onboarding.complete_signup(request_key, code, password)`, and
		 * `onboarding.accept_terms(version)` — or three fields on `WhatsApp Settings`.
		 */
		start_signup($btn) {
			this.show_error("");
			return this.busy_button(
				$btn,
				__("Creating the account…"),
				ui
					.call("onboarding.start_signup", {
						plan_code: SIGNUP_PLAN,
						mobile: this.f.phone,
						full_name: this.f.person,
						email: this.f.email,
						channel: this.s.channel,
					})
					.then((r) => {
						this.ctx.request_key = r.request_key;
						this.ctx.code_ttl = cint(r.code_ttl) || DEFAULT_TTL_S;
						this.set_state({ stage: "verify", verify: "idle", left: this.ctx.code_ttl });
						this.watch_signup();
					})
					.catch((err) => this.show_error(err.message))
			);
		}

		// =============================================================================================
		// Step 3 — the confirmation code
		// =============================================================================================

		card_verify() {
			const $card = this.card("md", {
				title: __("Confirm the mobile number"),
				sub: __("The platform sent a code to the number you registered. Enter it here and the account is activated."),
			});

			$card.append(`
				<div class="wa-sunken wa-onb__route">
					<span class="wa-onb__route-col">
						<span class="wa-onb__route-k">${esc(__("From the platform"))}</span>
						<span class="wa-onb__route-v">${esc(__("WhatsApp Next"))}</span>
					</span>
					<span class="wa-onb__route-arrow">${ico("chevronEnd", "sm")}</span>
					<span class="wa-onb__route-col">
						<span class="wa-onb__route-k">${esc(__("To your registered number"))}</span>
						<span class="wa-onb__route-v wa-onb__route-v--mono" dir="ltr">${esc(ui.PhoneField.format_display(this.f.phone) || this.f.phone)}</span>
					</span>
				</div>

				<div class="wa-sunken wa-onb__codebox">
					<label class="wa-field__label" for="wa-onb-code">${esc(__("Confirmation code"))}</label>
					<input class="wa-onb__code-input" id="wa-onb-code" type="text" dir="ltr" inputmode="numeric"
						autocomplete="one-time-code" placeholder="••••••" aria-describedby="wa-onb-code-state">
					<p class="wa-onb__code-help">${esc(__("The code arrives on the channel below. If it has not arrived, wait for the timer to run down and ask for it again."))}</p>
					<div data-slot="channel"></div>
				</div>
				<div data-slot="state" id="wa-onb-code-state"></div>
				<div class="wa-btnbar">
					${ui.btn({ label: __("Verify now"), variant: "primary", cls: "wa-onb__grow", attrs: { "data-act": "verify" } })}
					${ui.btn({ label: __("Resend the code"), variant: "secondary", attrs: { "data-act": "resend" } })}
					${ui.btn({ label: __("Change the number"), variant: "ghost", attrs: { "data-act": "change" } })}
				</div>`);

			const $chan = $card.find('[data-slot="channel"]');
			$chan.html(
				ui.segmented(
					[
						{ value: "whatsapp", label: __("WhatsApp"), icon: "whatsapp" },
						{ value: "sms", label: __("SMS"), icon: "chat" },
						{ value: "email", label: __("Email"), icon: "send" },
					],
					this.s.channel,
					{ label: __("How the code arrives") }
				)
			);
			ui.bind_segmented($chan.find(".wa-seg"), (value) => (this.s.channel = value));

			this.draw_verify_state($card);
			this.run_countdown($card);

			$card.on("click", '[data-act="verify"]', (e) => this.verify_code($(e.currentTarget), $card));
			$card.on("keydown", "#wa-onb-code", (e) => {
				if (e.key === "Enter") $card.find('[data-act="verify"]').trigger("click");
			});
			$card.on("click", '[data-act="resend"]', (e) => this.resend_code($(e.currentTarget), $card));
			$card.on("click", '[data-act="change"]', () => {
				this.stop_timers();
				this.set_state({ stage: "signup", verify: "idle" });
			});
		}

		draw_verify_state($card) {
			const $slot = $card.find('[data-slot="state"]');
			if (this.s.verify === "ok") return $slot.html(strip_html("ok", __("The code was accepted and the number is confirmed.")));
			if (this.s.verify === "fail") return $slot.html(strip_html("danger", __("That code was not accepted. Check it and try again, or ask for a new one."), { role: "alert" }));
			const m = Math.floor(this.s.left / 60);
			const sec = String(this.s.left % 60).padStart(2, "0");
			return $slot.html(
				strip_html("warn", this.s.left > 0 ? __("Waiting for the code — it expires in {0}:{1}", [m, sec]) : __("The code has expired. Ask for a new one."))
			);
		}

		run_countdown($card) {
			this.stop_timers();
			const $resend = $card.find('[data-act="resend"]');
			const tick = () => {
				const spent = this.ctx.code_ttl - this.s.left;
				const locked = spent < RESEND_LOCK_S && this.s.left > 0;
				$resend.prop("disabled", locked);
				$resend.find("span").last().text(locked ? __("Resend in {0} s", [RESEND_LOCK_S - spent]) : __("Resend the code"));
				if (this.s.verify === "idle") this.draw_verify_state($card);
				if (this.s.left > 0) this.s.left -= 1;
			};
			tick();
			this._tick = window.setInterval(tick, 1000);
		}

		verify_code($btn, $card) {
			const code = ($card.find("#wa-onb-code").val() || "").trim();
			if (!code) {
				this.show_error(__("Enter the code you received."));
				$card.find("#wa-onb-code").trigger("focus");
				return;
			}
			this.show_error("");
			return this.busy_button(
				$btn,
				__("Verifying…"),
				ui
					.call("onboarding.complete_signup", { request_key: this.ctx.request_key, code })
					.then((r) => {
						if (!r || !r.ok) {
							this.s.verify = "fail";
							this.draw_verify_state($card);
							return;
						}
						this.s.verify = "ok";
						this.draw_verify_state($card);
						this.stop_signup_watch();
						ui.announce(__("The number is confirmed."), { assertive: true });
						return this.after_signup(r);
					})
					.catch((err) => {
						this.s.verify = "fail";
						this.draw_verify_state($card);
						this.show_error(err.message);
					})
			);
		}

		/** The account exists now. The rail is complete; what is left is connecting this site. */
		after_signup(result) {
			return ui.call("onboarding.get_status").then((status) => {
				this.status = status || {};
				this.stop_timers();
				if (!result.credentials_stored) {
					this.set_state({ stage: "ready" });
					ui.Toast.warning(__("The platform did not return the keys. Enter them here to finish."));
					return;
				}
				return ui
					.call("settings.test_connection")
					.then((conn) => {
						this.ctx.connection = conn;
						return ui.call("onboarding.get_status");
					})
					.then((s2) => {
						this.status = s2 || this.status;
						this.set_state({ stage: "ready" });
					})
					.catch(() => this.set_state({ stage: "ready" }));
			});
		}

		resend_code($btn, $card) {
			this.show_error("");
			return this.busy_button(
				$btn,
				__("Sending…"),
				ui
					.call("onboarding.start_signup", {
						plan_code: SIGNUP_PLAN,
						mobile: this.f.phone,
						full_name: this.f.person,
						email: this.f.email,
						channel: this.s.channel,
					})
					.then((r) => {
						this.ctx.request_key = r.request_key || this.ctx.request_key;
						this.ctx.code_ttl = cint(r.code_ttl) || DEFAULT_TTL_S;
						this.s.left = this.ctx.code_ttl;
						this.s.verify = "idle";
						this.draw_verify_state($card);
						this.run_countdown($card);
						ui.Toast.success(__("A new code is on its way."));
					})
					.catch((err) => this.show_error(err.message))
			);
		}

		watch_signup() {
			this.stop_signup_watch();
			this._signup_poll = window.setInterval(() => {
				if (document.hidden || !this.ctx.request_key) return;
				ui.call("onboarding.get_signup_status", { request_key: this.ctx.request_key }, { silent: true })
					.then((r) => {
						if (r && r.status === "Completed") {
							this.stop_signup_watch();
							ui.announce(__("The sign-up was confirmed on the platform."));
						}
					})
					.catch(() => {});
			}, SIGNUP_POLL_MS);
		}

		stop_signup_watch() {
			if (this._signup_poll) window.clearInterval(this._signup_poll);
			this._signup_poll = null;
		}

		// =============================================================================================
		// The way in for an account that already exists
		// =============================================================================================

		card_login() {
			const $card = this.card("sm", {
				title: __("Sign in"),
				sub: __("A platform account is reached with its address and its API keys. They are stored encrypted and are never shown again."),
			});
			const $form = $('<div class="wa-onb__stack"></div>').appendTo($card);
			$form.append(field_html({ id: "wa-onb-url", label: __("Platform address"), dir: "ltr", placeholder: "https://platform.example.com", value: this.ctx.platform_base_url || "", required: true, extra: 'data-c="platform_base_url"' }));
			[
				["customer_api_key", __("Customer API key")],
				["api_key", __("API key")],
				["api_secret", __("API secret")],
			].forEach(([key, label]) => {
				$form.append(field_html({ id: `wa-onb-${key}`, label, type: "password", mono: true, autocomplete: "off", required: true, extra: `data-c="${key}"` }));
			});

			$card.append(`
				<div class="wa-onb__loginfoot">
					<span class="wa-onb__lock">${ico("shield", "xs")}${esc(__("The keys are stored encrypted in the app's settings"))}</span>
					${ui.btn({ label: __("Forgot the password?"), variant: "ghost", size: "sm", attrs: { "data-act": "reset" } })}
				</div>
				${ui.btn({ label: __("Sign in"), variant: "primary", block: true, attrs: { "data-act": "save" } })}
				<div data-slot="conn"></div>
				<div class="wa-onb__divider"><span>${esc(__("No account yet?"))}</span></div>
				${ui.btn({ label: __("Create a new account"), variant: "secondary", block: true, attrs: { "data-act": "new" } })}`);

			this.draw_connection($card);
			$card.on("click", '[data-act="save"]', (e) => this.save_credentials($(e.currentTarget), $card, "login"));
			$card.on("click", '[data-act="reset"]', () => this.set_state({ stage: "reset" }));
			$card.on("click", '[data-act="new"]', () => this.set_state({ stage: "signup" }));
		}

		card_reset() {
			const $card = this.card("sm", {
				title: __("Recover the password"),
				sub: __("Enter the email or the mobile the platform account was opened with, and the platform sends the recovery instructions to it."),
			});
			$card.append('<div data-slot="sent"></div>');
			$card.append(field_html({ id: "wa-onb-identifier", label: __("Email or mobile number"), dir: "ltr", placeholder: "email@company.com", value: this.f.email, required: true, extra: 'data-r="identifier"' }));
			$card.append(`
				<div class="wa-btnbar">
					${ui.btn({ label: __("Send the recovery instructions"), variant: "primary", cls: "wa-onb__grow", attrs: { "data-act": "send" } })}
					${ui.btn({ label: __("Back to signing in"), variant: "secondary", attrs: { "data-act": "back" } })}
				</div>
				<p class="wa-onb__foot-note">${esc(__("No longer have the registered email or number? Contact support on 8001234567."))}</p>`);

			$card.on("click", '[data-act="back"]', () => this.set_state({ stage: "login" }));
			$card.on("click", '[data-act="send"]', (e) => {
				const $btn = $(e.currentTarget);
				const identifier = ($card.find('[data-r="identifier"]').val() || "").trim();
				if (!identifier) return this.show_error(__("Enter the email or the mobile number of the account."));
				this.show_error("");
				this.busy_button(
					$btn,
					__("Sending…"),
					ui
						.call("onboarding.start_password_reset", { identifier })
						.then(() => {
							$card.find('[data-slot="sent"]').html(strip_html("ok", __("The recovery instructions were sent. Follow them, then come back with the new keys.")));
							$btn.find("span").last().text(__("Send them again"));
						})
						.catch((err) => this.show_error(err.message))
				);
			});
		}

		// =============================================================================================
		// Ready to work — and, under it, connecting this site
		// =============================================================================================

		card_ready() {
			const plan = (this.ctx.connection && this.ctx.connection.plan_code) || __("Free");
			const org = this.f.org;
			const $card = this.card("ready");
			$card.append(`
				<span class="wa-onb__ready-mark">${ico("tick", "lg")}</span>
				<h2 class="wa-onb__ready-title">${esc(__("Ready to work"))}</h2>
				<p class="wa-onb__ready-sub">${esc(org ? __("The account «{0}» is active on the {1} plan. You can link devices and send your first message.", [org, plan]) : __("This site's account is active on the {0} plan.", [plan]))}</p>

				<div class="wa-onb__ready-note">
					<span class="wa-onb__ready-note-mark">${ico("card", "sm")}</span>
					<span class="wa-onb__ready-note-text">
						<b>${esc(__("Your first month is free, all of it"))}</b>
						<span>${esc(__("No card. You can upgrade or stop at any time from the subscription page."))}</span>
					</span>
				</div>

				<div class="wa-onb__invite">
					<span class="wa-onb__invite-head">
						<span class="wa-onb__invite-mark">${ico("send", "sm")}</span>
						<b>${esc(__("Share and get an extra free month"))}</b>
					</span>
					<p class="wa-onb__invite-body">${esc(__("Send your coupon to any company you know: they start their subscription with a free month, and a free month is added to yours for every company that activates with your coupon — with no limit on invitations."))}</p>
					<p class="wa-onb__invite-slot">
						<span class="wa-onb__invite-k">${esc(__("Invite coupon"))}</span>
						<span class="wa-onb__invite-v">${esc(__("Issued on the subscription page"))}</span>
					</p>
				</div>`);

			// ---- connecting this site: after the account, never in the rail --------------------------
			const open = this.first_open_site_stage();
			const $site = $(`<div class="wa-onb__site"></div>`).appendTo($card);
			$site.append(`
				<div class="wa-onb__site-head">
					<h3 class="wa-onb__site-title">${esc(__("Connect this site"))}</h3>
					${ui.badge(open ? __("Not finished") : __("Done"), open ? "warn" : "ok")}
				</div>
				<p class="wa-onb__site-sub">${esc(__("The account exists. These three connect this site to it, so messages can actually leave and replies can come back."))}</p>`);
			this.checklist($('<div class="wa-onb__checklist"></div>').appendTo($site));
			const $bar = $('<div class="wa-btnbar"></div>').appendTo($site);
			if (open) {
				$bar.append(ui.btn({ label: __("Finish connecting"), variant: "primary", cls: "wa-onb__grow", attrs: { "data-act": "site" } }));
			} else if (!this.status.setup_completed) {
				$bar.append(ui.btn({ label: __("Switch the product on"), variant: "primary", cls: "wa-onb__grow", attrs: { "data-act": "finish" } }));
			} else {
				$bar.append(ui.btn({ label: __("Go to the dashboard"), variant: "primary", cls: "wa-onb__grow", attrs: { "data-act": "home" } }));
			}
			$bar.append(ui.btn({ label: __("Open the subscription page"), variant: "secondary", attrs: { "data-act": "sub" } }));
			if (this.status.setup_completed) {
				$bar.append(ui.btn({ label: __("Run the setup again"), variant: "ghost", attrs: { "data-act": "again" } }));
			}

			$card.on("click", '[data-act="site"]', () => this.set_state({ stage: open }));
			$card.on("click", '[data-act="home"]', () => frappe.set_route("wa-home"));
			$card.on("click", '[data-act="sub"]', () => frappe.set_route("wa-settings"));
			$card.on("click", '[data-act="again"]', () => {
				this.s.rerun = true;
				this.set_state({ stage: "connect" });
			});
			$card.on("click", '[data-act="finish"]', (e) =>
				this.busy_button(
					$(e.currentTarget),
					__("Finishing…"),
					ui
						.call("onboarding.complete_setup")
						.then(() => {
							ui.Toast.success(__("The setup is complete."));
							this.s.rerun = false;
							return this.load();
						})
						.catch((err) => this.show_error(err.message))
				)
			);
		}

		/** The head every site-setup card wears: which of the three it is, and the way back. */
		site_head($card, index) {
			$card.find(".wa-onb__card-titles").append(ui.badge(__("Step {0} of {1}", [index, 3]), "info"));
			$card.on("click", '[data-act="site-back"]', () => this.set_state({ stage: "ready" }));
		}

		// ---- connecting: the platform keys ------------------------------------------------------------

		card_connect() {
			const saved = this.step_done("credentials");
			const $card = this.card("md", {
				title: __("Platform connection"),
				sub: saved
					? __("The keys are already on this site. Test them, or type new ones over them.")
					: __("Enter the address of the platform and the three keys it issued."),
			});
			this.site_head($card, 1);
			const $form = $('<div class="wa-onb__stack"></div>').appendTo($card);
			$form.append(field_html({ id: "wa-onb-url2", label: __("Platform address"), dir: "ltr", placeholder: "https://platform.example.com", value: this.ctx.platform_base_url || "", extra: 'data-c="platform_base_url"' }));
			[
				["customer_api_key", __("Customer API key")],
				["api_key", __("API key")],
				["api_secret", __("API secret")],
			].forEach(([key, label]) => {
				$form.append(field_html({ id: `wa-onb-c-${key}`, label, type: "password", mono: true, autocomplete: "off", placeholder: saved ? __("Stored — leave empty to keep it") : "", extra: `data-c="${key}"` }));
			});
			$card.append('<div data-slot="conn"></div>');
			$card.append(`
				<div class="wa-btnbar">
					${ui.btn({ label: saved ? __("Test the connection") : __("Save and test the connection"), variant: "primary", cls: "wa-onb__grow", attrs: { "data-act": "save" } })}
					${ui.btn({ label: __("Back"), variant: "ghost", attrs: { "data-act": "site-back" } })}
				</div>`);
			this.draw_connection($card);
			$card.on("click", '[data-act="save"]', (e) => this.save_credentials($(e.currentTarget), $card, "connect"));
		}

		save_credentials($btn, $card, from) {
			const values = {};
			$card.find("[data-c]").each((i, el) => {
				const value = (el.value || "").trim();
				if (value) values[$(el).data("c")] = value;
			});
			const saved = this.step_done("credentials");
			if (!Object.keys(values).length && !saved) return this.show_error(__("Enter the platform address and the three keys first."));
			this.show_error("");
			this.ctx.platform_base_url = values.platform_base_url || this.ctx.platform_base_url;
			const write = Object.keys(values).length ? ui.call("onboarding.save_credentials", values) : Promise.resolve();
			return this.busy_button(
				$btn,
				__("Testing…"),
				write
					.then(() => ui.call("settings.test_connection"))
					.then((conn) => {
						this.ctx.connection = conn;
						return ui.call("onboarding.get_status");
					})
					.then((status) => {
						this.status = status || {};
						this.draw_connection($card);
						this.render_flow();
						if (this.ctx.connection && this.ctx.connection.ok) {
							ui.Toast.success(__("The platform answered. The connection works."));
							window.setTimeout(() => this.set_state({ stage: from === "login" ? "ready" : "device" }), 700);
						}
					})
					.catch((err) => this.show_error(err.message))
			);
		}

		draw_connection($card) {
			const $slot = $card.find('[data-slot="conn"]');
			const r = this.ctx.connection;
			$slot.empty();
			if (!r) return;
			$slot.html(
				r.ok
					? strip_html("ok", r.plan_code ? __("Answered in {0} ms · plan {1}", [ui.format_int(r.latency_ms), r.plan_code]) : __("Answered in {0} ms", [ui.format_int(r.latency_ms)]))
					: strip_html("danger", r.error || __("The platform did not answer."), { role: "alert" })
			);
		}

		// ---- connecting: the first device --------------------------------------------------------------

		card_device() {
			const $card = this.card("md", {
				title: __("Link the first device"),
				sub: __("A device is one WhatsApp number. Messages go out from it, and it stays linked until it is signed out."),
			});
			this.site_head($card, 2);
			const $body = $('<div class="wa-onb__stack"></div>').appendTo($card);
			$body.html(ui.skeleton(2));
			return ui
				.call("devices.list_devices")
				.then((r) => {
					const connected = (r.rows || []).filter((d) => d.status === "Connected");
					$body.empty();
					if (connected.length) {
						$card.find(".wa-onb__card-sub").text(__("A device is connected. You can link another one now, or move on."));
						connected.slice(0, 3).forEach((row) => {
							$body.append(`
								<div class="wa-onb__device">
									<span class="wa-onb__device-mark">${ico("device", "sm")}</span>
									<span class="wa-onb__device-text">
										<b dir="auto">${esc(row.device_name || row.name)}</b>
										<span class="wa-onb__device-phone" dir="ltr">${esc(row.phone_e164 ? ui.PhoneField.format_display(row.phone_e164) : __("No number yet"))}</span>
									</span>
									${ui.badge(__("Connected"), "ok")}
								</div>`);
						});
						$card.append(`
							<div class="wa-btnbar">
								${ui.btn({ label: __("Next — the webhook"), variant: "primary", cls: "wa-onb__grow", attrs: { "data-act": "next" } })}
								${ui.btn({ label: __("Link another device"), variant: "secondary", attrs: { "data-act": "pair" } })}
								${ui.btn({ label: __("Back"), variant: "ghost", attrs: { "data-act": "site-back" } })}
							</div>`);
						$card.on("click", '[data-act="next"]', () => this.set_state({ stage: "webhook" }));
						$card.on("click", '[data-act="pair"]', () => this.pair_form($body, $card));
						return;
					}
					this.pair_form($body, $card);
				})
				.catch((err) => this.render_error(err, () => this.render()));
		}

		pair_form($body, $card) {
			$body.empty();
			$card.find(".wa-btnbar").remove();
			this.pair_mode = "QR";
			$body.append(field_html({ id: "wa-onb-device", label: __("Device name"), placeholder: __("e.g. Sales device"), required: true, extra: 'data-d="device_name"' }));
			const $mode = $(`
				<div class="wa-field">
					<span class="wa-field__label" id="wa-onb-mode">${esc(__("Linking method"))}</span>
					<div data-slot="seg"></div>
				</div>`).appendTo($body);
			$mode.find('[data-slot="seg"]').html(
				ui.segmented(
					[
						{ value: "QR", label: __("QR code"), icon: "scan" },
						{ value: "Code", label: __("8-digit code"), icon: "shield" },
					],
					"QR",
					{ label: __("Linking method") }
				)
			);
			const $phone = $('<div class="wa-onb__pairphone" hidden></div>').appendTo($body);
			this.pair_phone = new ui.PhoneField({
				wrapper: $phone,
				label: __("WhatsApp number"),
				required: true,
				on_change: ({ phone_e164, valid }) => (this.ctx.pair_phone = valid ? phone_e164 : null),
			});
			ui.bind_segmented($mode.find(".wa-seg"), (value) => {
				this.pair_mode = value;
				$phone.attr("hidden", value === "Code" ? null : true);
			});

			$card.append(`
				<div class="wa-btnbar">
					${ui.btn({ label: __("Create and link"), variant: "primary", cls: "wa-onb__grow", attrs: { "data-act": "create" } })}
					${ui.btn({ label: __("Do it later"), variant: "secondary", attrs: { "data-act": "later" } })}
					${ui.btn({ label: __("Back"), variant: "ghost", attrs: { "data-act": "site-back" } })}
				</div>`);
			const $pair = $('<div class="wa-onb__pairing"></div>').appendTo($card);

			$card.off("click", '[data-act="later"]').on("click", '[data-act="later"]', () => this.set_state({ stage: "webhook" }));
			$card.off("click", '[data-act="create"]').on("click", '[data-act="create"]', (e) => {
				const $btn = $(e.currentTarget);
				const name = ($card.find('[data-d="device_name"]').val() || "").trim();
				if (!name) return this.show_error(__("Name the device first."));
				if (this.pair_mode === "Code" && !this.ctx.pair_phone) return this.show_error(__("Enter the WhatsApp number that receives the 8-digit code."));
				this.show_error("");
				this.busy_button(
					$btn,
					__("Creating…"),
					ui
						.call("devices.create_device", { device_name: name, phone: this.pair_mode === "Code" ? this.ctx.pair_phone : null, pairing_mode: this.pair_mode })
						.then((r) => {
							this.ctx.device = r.name;
							return this.start_pairing($pair);
						})
						.catch((err) => this.show_error(err.message))
				);
			});
		}

		start_pairing($pair) {
			$pair.html(ui.skeleton(2));
			this.stop_pairing_watch();
			return ui
				.call("devices.start_pairing", { device: this.ctx.device, mode: this.pair_mode })
				.then((payload) => {
					this.render_pairing($pair, payload || {});
					this.watch_pairing();
				})
				.catch((err) => {
					$pair.html(strip_html("danger", (err && err.message) || __("Something went wrong. Please try again."), { role: "alert" }));
					$pair.append(ui.btn({ label: __("Try again"), variant: "secondary", size: "sm", attrs: { "data-act": "repair" } }));
					$pair.find('[data-act="repair"]').on("click", () => this.start_pairing($pair));
				});
		}

		render_pairing($pair, payload) {
			const qr = payload.qr_code || "";
			const is_image = /^(data:image|https?:)/.test(qr);
			const steps = [
				__("Open WhatsApp on the phone."),
				__("Menu → Linked devices → Link a device."),
				this.pair_mode === "Code" ? __("Choose “Link with phone number” and type the code.") : __("Point the camera at the code."),
			];
			$pair.html(`
				<div class="wa-sunken wa-onb__pair">
					<div class="wa-onb__pair-code" data-slot="code"></div>
					<div class="wa-onb__pair-how">
						<ol class="wa-onb__pair-steps">${steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
						<div data-slot="countdown"></div>
					</div>
				</div>`);
			const $code = $pair.find('[data-slot="code"]');
			if (this.pair_mode === "Code" && payload.pair_code) {
				$code.html(`<span class="wa-onb__pin" dir="ltr">${esc(payload.pair_code)}</span>`);
			} else if (is_image) {
				$code.html(`<img class="wa-onb__qr" src="${esc(qr)}" alt="${esc(__("QR code — scan it with WhatsApp on the phone"))}">`);
			} else if (qr) {
				$code.html(`<code class="wa-onb__raw" dir="ltr">${esc(qr)}</code>`);
			} else {
				$code.html(strip_html("warn", __("The platform did not return a linking code for this device.")));
			}
			this.pair_countdown($pair.find('[data-slot="countdown"]'), payload.expires_in || 60, $pair);
		}

		pair_countdown($el, seconds, $pair) {
			let left = Math.max(0, parseInt(seconds, 10) || 60);
			const spoken = new Set();
			const tick = () => {
				if ([30, 10].includes(left) && !spoken.has(left)) {
					spoken.add(left);
					ui.announce(__("The linking code expires in {0} seconds.", [left]));
				}
				if (left <= 0) {
					window.clearInterval(this._pair_countdown);
					$el.html(strip_html("muted", __("The code expired.")));
					$(ui.btn({ label: __("Get a new code"), variant: "secondary", size: "sm", attrs: { "data-act": "recode" } }))
						.on("click", () => this.start_pairing($pair))
						.appendTo($el);
					return;
				}
				$el.html(strip_html("warn", __("Waiting for the scan — the code expires in {0} s", [left])));
				left -= 1;
			};
			window.clearInterval(this._pair_countdown);
			tick();
			this._pair_countdown = window.setInterval(tick, 1000);
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
			if (!keep_countdown && this._pair_countdown) window.clearInterval(this._pair_countdown);
			if (this._pair_realtime) frappe.realtime.off("wa:device:status", this._pair_realtime);
			this._pair_realtime = null;
		}

		apply_device_status(status) {
			if (status !== "Connected") return;
			this.stop_pairing_watch();
			ui.announce(__("The device is linked."), { assertive: true });
			ui.Toast.success(__("The device is linked."));
			ui.call("onboarding.get_status").then((s) => {
				this.status = s || {};
				this.render();
			});
		}

		// ---- connecting: the webhook ---------------------------------------------------------------------

		card_webhook() {
			const done = this.step_done("webhook");
			const $card = this.card("md", {
				title: __("Register the webhook"),
				sub: __("The platform calls this site when a message is delivered, read or answered. Without it, this site never learns what happened."),
			});
			this.site_head($card, 3);
			if (this.status.webhook_url) {
				$card.append(`
					<div class="wa-sunken wa-onb__kv">
						<span class="wa-onb__kv-label">${esc(__("Endpoint"))}</span>
						<code class="wa-onb__kv-value" dir="ltr">${esc(this.status.webhook_url)}</code>
						${ui.btn({ label: __("Copy"), icon: "copy", variant: "ghost", size: "sm", attrs: { "data-act": "copy-url" } })}
					</div>`);
			}
			$card.append(done ? strip_html("ok", __("The webhook is active.")) : strip_html("warn", this.step_detail("webhook") || __("The webhook is not registered yet.")));
			$card.append(`
				<div class="wa-btnbar">
					${done
						? ui.btn({ label: __("Back to «Ready to work»"), variant: "primary", cls: "wa-onb__grow", attrs: { "data-act": "site-back" } })
						: ui.btn({ label: __("Register the webhook"), variant: "primary", cls: "wa-onb__grow", attrs: { "data-act": "register" } })}
					${ui.btn({ label: __("Back to the device"), variant: "ghost", attrs: { "data-act": "back-device" } })}
				</div>`);

			$card.on("click", '[data-act="copy-url"]', (e) => {
				copy_to_clipboard(this.status.webhook_url)
					.then(() => $(e.currentTarget).find("span").last().text(__("Copied")))
					.catch(() => ui.Toast.warning(__("The browser did not allow copying. Select the address and copy it by hand.")));
			});
			$card.on("click", '[data-act="back-device"]', () => this.set_state({ stage: "device" }));
			$card.on("click", '[data-act="register"]', (e) =>
				this.busy_button(
					$(e.currentTarget),
					__("Registering…"),
					ui
						.call("settings.setup_webhook")
						.then(() => ui.call("onboarding.get_status"))
						.then((status) => {
							this.status = status || {};
							ui.Toast.success(__("The webhook is registered."));
							this.render();
						})
						.catch((err) => this.show_error(err.message))
				)
			);
		}

		// ---- housekeeping -----------------------------------------------------------------------------

		stop_timers() {
			if (this._tick) window.clearInterval(this._tick);
			this._tick = null;
		}

		unbind() {
			this.stop_timers();
			this.stop_pairing_watch();
			this.stop_signup_watch();
			if (this.on_doc_down) document.removeEventListener("mousedown", this.on_doc_down);
			if (this.on_doc_esc) document.removeEventListener("keydown", this.on_doc_esc, true);
			this.on_doc_down = null;
			this.on_doc_esc = null;
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

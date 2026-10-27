// Module role: the WhatsApp setup screen (spec §2 row 1, matrix row 1) — the design prototype
// `docs/screen/Hub Page - Onboarding.html`, and nothing beyond it.
//
// The page is three parts: بيانات الحساب · الشروط والأحكام · تفعيل الحساب. They are what the
// brand rail lists, they are the whole flow, and it ends at "اكتمل التسجيل" with the جاهز للعمل
// panel — the free month and the invite coupon — and nothing after them. Connecting this site to
// the platform (the keys, the connection test, the webhook, the account's devices) is not drawn
// here: the sign-up and sign-in calls do it server-side (`services.onboarding.link_site`, D-117)
// and Settings shows the result; the platform address is a default, never asked for.
//
// The way in for an account that already exists is the prototype's sign-in card, exactly as it
// draws it: an e-mail and a password. `onboarding.login` authenticates against the platform and
// stores the keys server-side, so no key is ever typed into or held by this screen.
//
// Every control is the ported layer's (`ui.btn`, `ui.badge`, `ui.rule`, `ui.segmented`, `ui.ico`,
// `.wa-input`, `.wa-card`, `.wa-sunken`), every colour is a `--wa-*` token, and every glyph comes
// from the prototype's own family. No `frappe.ui.form.make_control`, no Espresso icon, no Desk
// button. Dark mode is Desk's: the palette answers `[data-theme="dark"]` and this screen adds no
// control of its own.
//
// Every call goes through `api.v1.onboarding` with `sanad.ui.call`. What the API still has no
// field for — a recorded acceptance of the terms — carries a `TODO(backend)` naming what it
// needs. Nothing here invents an endpoint or fakes a local path.
//
// The Home → wizard redirect is Home's (D-140): `wa-home` sends an unregistered System Manager
// here once per browser session, governed by `WhatsApp Settings.redirect_unregistered_to_wizard`.

frappe.provide("whatsapp_next.onboarding");

(() => {
	const ui = sanad.ui;
	const esc = (v) => ui.escape(v);
	const ico = (name, size) => ui.ico(name, size);
	const SETUP_ROLES = ["System Manager"];
	const POLL_MS = 4000;
	// how long a half-finished sign-up is kept in this browser for a reload to return to
	const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
	// The prototype signs every new tenant up on the free plan and says so on the ready panel. On
	// the platform every new account starts on its free trial whatever is sent; the code sent
	// names the plan the trial renews to, and the trial's own code is refused there. The page
	// sends the first plan of `onboarding.get_signup_bootstrap()` (cheapest first); the server
	// makes the same choice when nothing usable is sent (`services.onboarding.signup_plan_code`).
	// The prototype's resend lock: resending opens 30 s after the code was sent. The code's own
	// life comes from the bootstrap (`code_ttl_minutes`); this is the fallback.
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
			__("WhatsappNext is an intermediary platform that connects a company's system to its own WhatsApp account to send and receive messages. The platform is not affiliated with Meta and does not represent it, and the WhatsApp account used stays the company's property and its responsibility."),
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
	// The copy is the platform's own sign-up, sign-in and recovery (`snd_whatsapp_platform`
	// `views/Signup.vue`, `Login.vue`, `Reset.vue`), word for word (owner, 2026-10-08); only the
	// terms step, which the platform does not have, keeps this screen's words.
	const FLOW = () => [
		{ key: "account", label: __("Your details"), sub: __("Name and WhatsApp number") },
		{ key: "terms", label: __("Terms and conditions"), sub: __("Read and accept") },
		{ key: "activate", label: __("Confirm your number"), sub: __("Send one code from your WhatsApp") },
	];
	const RESET_FLOW = () => [
		{ key: "account", label: __("Your account"), sub: __("Mobile number or email") },
		{ key: "verify", label: __("Confirm it's you"), sub: __("Send one code from your WhatsApp") },
		{ key: "password", label: __("New password"), sub: __("And you are signed in") },
	];
	// the brand panel's words, per stage, as the platform's AuthLayout carries them
	const RAIL = () => ({
		signup: {
			eyebrow: __("First month free · no card"),
			headline: __("Your invoices reach your customers on WhatsApp."),
			lead: __("Send invoices, reminders and statements from ERPNext as you do today, and they reach your customer on WhatsApp with their PDF. Your invoices stay in your system; we only deliver the message."),
			points: [__("Your first month is free, no card needed"), __("Customers get the invoice and its PDF within seconds"), __("You decide what is sent, and when")],
		},
		login: {
			eyebrow: __("Your customers are waiting for your messages"),
			headline: __("Every invoice delivered, and read."),
			lead: __("Sign in to watch your messages leave ERPNext and get read by your customers, with your balance and devices on one screen."),
			points: [__("Messages go out on their own, from your documents"), __("The read ticks tell you who opened it, and when"), __("The SANAD team is with you from your first message")],
		},
		reset: {
			eyebrow: __("Account recovery"),
			headline: __("Back into your account in three steps."),
			lead: __("We confirm it is you with your own WhatsApp number. No waiting for an email."),
			points: [__("Only your own WhatsApp number can confirm the change"), __("Other devices are signed out when the password changes")],
		},
	});
	const STAGE_STEP = { login: 0, reset: 0, signup: 0, terms: 1, verify: 2 };

	// ---------------------------------------------------------------------------------------------
	// Small builders in the layer's idiom
	// ---------------------------------------------------------------------------------------------

	/** A labelled field in the ported field idiom. */
	function field_html({ id, label, type = "text", dir, placeholder = "", value = "", mono, autocomplete, required, hint = "", extra = "" }) {
		return `
			<div class="wa-field" data-field="${id}">
				<label class="wa-field__label" for="${id}">${esc(label)}${required ? ' <span class="wa-field__req" aria-hidden="true">*</span>' : ""}</label>
				<input class="wa-input${mono ? " wa-input--mono" : ""}" id="${id}" type="${type}"
					${dir ? `dir="${dir}"` : ""} ${autocomplete ? `autocomplete="${autocomplete}"` : ""}
					placeholder="${esc(placeholder)}" value="${esc(value)}" ${extra}>
				<span class="wa-field__hint" data-slot="hint">${esc(hint)}</span>
			</div>`;
	}

	/** A tone strip. The palette's tone inks are made for their own surface, so the word is tinted. */
	function strip_html(tone, text, { icon, role = "status", link } = {}) {
		const glyph = icon || { ok: "tick", warn: "warn", danger: "error", info: "info", muted: "info" }[tone];
		const action = link
			? ` <a class="wa-onb__strip-link" href="${esc(link)}" target="_blank" rel="noopener">${ico("whatsapp", "xs")}${esc(__("Send it on WhatsApp"))}</a>`
			: "";
		return `
			<p class="wa-onb__strip wa-onb__strip--${tone}" role="${role}">
				<span class="wa-onb__strip-icon">${ico(glyph, "sm")}</span>
				<span class="wa-onb__strip-text">${esc(text)}${action}</span>
			</p>`;
	}

	/** WhatsApp opened on the platform's number with the confirmation message already typed. */
	// the word before the code in the message the person sends (owner, 2026-10-19: "WN", for
	// WhatsappNext); the platform reads the six digits with or without it (`signup.CODE_PATTERN`)
	const CODE_PREFIX = "WN";

	function wa_send_link(platform_phone, code) {
		const digits = cstr(platform_phone).replace(/\D/g, "");
		return digits && code ? `https://wa.me/${digits}?text=${encodeURIComponent(`${CODE_PREFIX} ${code}`)}` : "";
	}

	/** Password strength, scored the way the prototype scores it (0–4). */
	/** A number as the person types it: never with "+" (owner); an email or username as it is. */
	function no_plus(value) {
		return cstr(value).trim().replace(/^\+(?=\d)/, "");
	}

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

	// the support line, written the way a person dials it
	const SUPPORT_PHONE = "967 777 103 456";

	/** A number inside an Arabic sentence, kept left to right (a left-to-right isolate). */
	const ltr = (text) => `\u2066${text}\u2069`;

	function copy_to_clipboard(text) {
		try {
			return navigator.clipboard.writeText(text);
		} catch (e) {
			return Promise.reject(e);
		}
	}

	/**
	 * The message to send, drawn as a code (owner, 2026-10-19): the `CODE_PREFIX` word as a tag, each digit in
	 * a tile of its own, and the whole of it one button that copies the message. `bind_code_copy`
	 * gives it the click; the hint under the tiles says "Copied" for a moment after it.
	 */
	function code_html(code) {
		const digits = cstr(code).split("");
		return `<button type="button" class="wa-onb__code" data-copy="${esc(`${CODE_PREFIX} ${code}`)}" dir="ltr"
				aria-label="${esc(__("Copy the message {0}", [`${CODE_PREFIX} ${code}`]))}">
				<span class="wa-onb__code-tiles" dir="ltr">
					<span class="wa-onb__code-tag">${CODE_PREFIX}</span>
					${digits.map((d) => `<span class="wa-onb__code-digit">${esc(d)}</span>`).join("")}
				</span>
				<span class="wa-onb__code-hint" aria-live="polite">${ico("copy", "xs")}<span class="wa-onb__code-hint-text">${esc(__("Click the code to copy it"))}</span></span>
			</button>`;
	}

	/** Copy the code on a click, and say so on the code itself. */
	function bind_code_copy($card) {
		$card.on("click", ".wa-onb__code", (e) => {
			const $btn = $(e.currentTarget);
			const $hint = $btn.find(".wa-onb__code-hint-text");
			copy_to_clipboard($btn.attr("data-copy"))
				.then(() => {
					$btn.addClass("is-copied");
					$hint.text(__("Copied — paste it in WhatsApp"));
					clearTimeout($btn.data("t"));
					$btn.data("t", setTimeout(() => {
						$btn.removeClass("is-copied");
						$hint.text(__("Click the code to copy it"));
					}, 2200));
				})
				.catch(() => ui.Toast.warning(__("The browser did not allow copying. Select the code and copy it by hand.")));
		});
	}

	// ---------------------------------------------------------------------------------------------
	// The screen
	// ---------------------------------------------------------------------------------------------
	class OnboardingScreen {
		constructor({ page, wrapper }) {
			this.page = page;
			this.wrapper = wrapper;
			this.s = {
				stage: "login",
				busy: false,
				err: "",
				tried: false,
				read: false,
				show_pw: false,
				channel: "whatsapp",
				verify: "idle",
				left: DEFAULT_TTL_S,
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
					<!-- The brand panel of the platform's sign-in (AuthLayout.vue): the mark as a watermark,
					     Petrol Deep on Petrol, one tone and no effects (BRAND.md). -->
					<span class="wa-onb__watermark" aria-hidden="true">${whatsapp_next.brand.mark(620, "ghost")}</span>

					<div class="wa-onb__pitch" data-slot="pitch"></div>

					<ol class="wa-onb__flow" data-slot="flow"></ol>

					<ul class="wa-onb__ticks" data-slot="ticks"></ul>

					<div class="wa-onb__brand-foot">
						<div class="wa-onb__chips">
							<a class="wa-onb__chip" href="https://sanad.digital/whatsapp-erpnext" target="_blank" rel="noopener">${ico("link", "xs")}${esc(__("Website and documentation"))}</a>
							<a class="wa-onb__chip" href="https://github.com/sanad-digital" target="_blank" rel="noopener">${ico("code", "xs")}${esc(__("Open source"))}</a>
						</div>
						<p class="wa-onb__support">${esc(__("Need help? Support is on {0}", [ltr(SUPPORT_PHONE)]))}</p>
						<p class="wa-onb__rights">${esc(__("Sanad Digital · all rights reserved"))}</p>
					</div>
				</aside>

				<div class="wa-onb__main">
					<div class="wa-onb__topbar">
						<span class="wa-onb__topmark">
							<span class="wa-onb__topmark-logo">${whatsapp_next.brand.mark(28)}</span>
							<b>${whatsapp_next.brand.wordmark()}</b>
							<span class="wa-onb__topmark-tag">${esc(__("A professional presence in every message"))}</span>
						</span>
						<span class="wa-onb__topbar-spacer"></span>
						<span class="wa-onb__counter" data-slot="counter" aria-live="polite"></span>
					</div>
					<div class="wa-onb__mbar" data-slot="mbar"></div>
					<div class="wa-onb__stage" data-slot="stage"></div>
					<p class="wa-onb__trust">${ico("lock", "xs")}${esc(__("We never ask for your WhatsApp password."))}</p>
				</div>`);
			this.$flow = this.$screen.find('[data-slot="flow"]');
			this.$pitch = this.$screen.find('[data-slot="pitch"]');
			this.$ticks = this.$screen.find('[data-slot="ticks"]');
			this.$counter = this.$screen.find('[data-slot="counter"]');
			this.$mbar = this.$screen.find('[data-slot="mbar"]');
			this.$stage = this.$screen.find('[data-slot="stage"]');
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
					// what the form needs before anything is typed: the platform's plans and how
					// long a code lives. It only refines the screen, so a failure never blocks it.
					return ui
						.call("onboarding.get_signup_bootstrap", {}, { silent: true })
						.then((boot) => {
							this.boot = boot || {};
							const ttl = cint(this.boot.code_ttl_minutes) * 60;
							if (ttl) this.ctx.code_ttl = ttl;
							this.prefill(this.boot.prefill);
						})
						.catch(() => {});
				})
				.catch((err) => this.render_error(err, () => this.load()));
		}

		/**
		 * Fill the sign-up form from what the system already knows (`signup_bootstrap().prefill`: the
		 * company, the person's user). Only fields still empty, so a draft or anything typed wins; the
		 * form is drawn again when it is the one on screen.
		 */
		prefill(known) {
			known = known || {};
			let changed = false;
			["org", "person", "email"].forEach((key) => {
				if (known[key] && !cstr(this.f[key]).trim()) {
					this.f[key] = known[key];
					changed = true;
				}
			});
			if (known.sector && !this.f.sector && SECTORS().includes(__(known.sector))) {
				this.f.sector = __(known.sector);
				changed = true;
			}
			if (known.phone && !this.f.phone) {
				this.f.phone = known.phone;
				this.f.phone_ok = true;
				changed = true;
			}
			// the mobile field starts on the company's country
			if (known.country && !this.f.phone) changed = true;
			if (changed && this.s.stage === "signup") this.render();
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

		/**
		 * Open where this site actually stands. An account whose keys are already on this site is
		 * an account that exists, so the rail is complete and the screen opens on "جاهز للعمل".
		 */
		/**
		 * The site is linked now. The boot this page was loaded with still says "send to the wizard"
		 * (`desk/setup_redirect.js`); left as it is, opening Home bounced the person straight back here.
		 */
		mark_linked() {
			if (frappe.boot.whatsapp_next) frappe.boot.whatsapp_next.setup_redirect = false;
		}

		resume() {
			if (this.step_done("credentials")) {
				this.mark_linked();
				this.clear_draft();
				return this.set_state({ stage: "ready" });
			}
			// A reload returns to the step it left, with what was typed — like any sign-up flow. A first
			// visit opens on signing in (owner, 2026-10-08): most sites belong to an account that
			// already exists, and "Create a free account" is one press away.
			const d = this.load_draft();
			if (!d) return this.set_state({ stage: "login" });
			Object.assign(this.f, d.f || {});
			Object.assign(this.ctx, d.ctx || {});
			const stage = d.stage === "verify" && !this.ctx.request_key ? "signup" : d.stage || "login";
			const patch = { stage, read: !!d.read, channel: d.channel || this.s.channel, verify: "idle" };
			if (stage === "verify") {
				patch.left = Math.max(0, Math.round(((this.ctx.code_expires || 0) - Date.now()) / 1000));
			}
			this.set_state(patch);
			if (stage === "verify") this.watch_signup();
			return this;
		}

		// ---- the draft: where the sign-up got to, kept across a reload ------------------------------
		//
		// Per site and per user, in this browser, for a day. Everything typed is kept EXCEPT the
		// password, which never touches storage; a reload on the confirmation step asks for it again
		// (only there, only if the finish needs it). `ctx` keeps the platform request so the same
		// confirmation continues instead of a new one being opened.

		draft_key() {
			return `wa-onb:${(frappe.boot && frappe.boot.sitename) || location.host}:${frappe.session.user}`;
		}

		save_draft() {
			try {
				if (this.s.stage === "ready") return this.clear_draft();
				const { password, password2, login_password, ...f } = this.f; // eslint-disable-line no-unused-vars
				const ctx = {
					request_key: this.ctx.request_key,
					route: this.ctx.route,
					code_ttl: this.ctx.code_ttl,
					code_expires: this.ctx.code_expires,
					reset: this.ctx.reset,
				};
				localStorage.setItem(
					this.draft_key(),
					JSON.stringify({ v: 1, at: Date.now(), stage: this.s.stage, read: this.s.read, channel: this.s.channel, f, ctx })
				);
			} catch (e) {
				// storage full or blocked: the flow works without it
			}
		}

		load_draft() {
			try {
				const d = JSON.parse(localStorage.getItem(this.draft_key()) || "null");
				if (!d || d.v !== 1 || Date.now() - (d.at || 0) > DRAFT_TTL_MS) return null;
				return d;
			} catch (e) {
				return null;
			}
		}

		clear_draft() {
			try {
				localStorage.removeItem(this.draft_key());
			} catch (e) {
				// nothing to clear
			}
		}

		/** The plan the free trial renews to: the platform's first (cheapest) plan. */
		plan() {
			const plans = (this.boot && this.boot.plans) || [];
			return plans[0] || null;
		}

		plan_code() {
			const p = this.plan();
			return (p && (p.plan_code || p.code)) || undefined;
		}

		/** What the account is on right after sign-up: the free trial, whatever it renews to. */
		plan_label() {
			return __("Free trial");
		}

		set_state(patch, redraw = true) {
			// An error belongs to the card that raised it; moving card clears it unless carried on.
			if (patch.stage && patch.stage !== this.s.stage && patch.err === undefined) patch.err = "";
			// so does "a check was attempted": the recovery card's failed attempt must not paint a
			// fresh sign-up card red
			if (patch.stage && patch.stage !== this.s.stage && patch.tried === undefined) patch.tried = false;
			Object.assign(this.s, patch);
			this.save_draft();
			if (redraw) this.render();
			return this;
		}

		// ---- the rail ------------------------------------------------------------------------------

		/** `true` once the account exists — the rail is complete and the terminal is showing. */
		account_done() {
			return this.s.stage === "ready";
		}

		/** The panel's words for the stage: sign-in, recovery, or the sign-up for everything else. */
		render_rail() {
			const stage = this.s.stage;
			const copy = RAIL()[stage === "login" || stage === "reset" ? stage : "signup"];
			this.$pitch.html(`
				<span class="wa-onb__badge"><span class="wa-onb__badge-dot" aria-hidden="true"></span>${esc(copy.eyebrow)}</span>
				<h2 class="wa-onb__pitch-title">${esc(copy.headline)}</h2>
				<p class="wa-onb__pitch-body">${esc(copy.lead)}</p>`);
			this.$ticks.html(copy.points.map((p) => `<li class="wa-onb__tick">${ico("tick", "xs")}${esc(p)}</li>`).join(""));
		}

		render_flow() {
			this.render_rail();
			// Signing in has no steps on the platform; recovery has its own three.
			const login = this.s.stage === "login";
			const reset = this.s.stage === "reset" ? this.ctx.reset : undefined;
			const steps = this.s.stage === "reset" ? RESET_FLOW() : FLOW();
			const done_all = this.account_done();
			const at = done_all ? steps.length : this.s.stage === "reset" ? (!reset ? 0 : reset.verified ? 2 : 1) : STAGE_STEP[this.s.stage] || 0;
			this.$flow.prop("hidden", login);
			this.$mbar.prop("hidden", login);
			this.$counter.prop("hidden", login);
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
			};
			(by_stage[this.s.stage] || by_stage.signup)();
		}

		/** A card shell: the prototype's surface, its head, and a slot for the error banner. */
		card(size, { title, sub, badge } = {}) {
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
			this.card("md", {
				title: __("Setup status"),
				sub: __("Only a System Manager can register an account for this site."),
			});
		}

		// =============================================================================================
		// Step 1 — account details
		// =============================================================================================

		card_signup() {
			const $card = this.card("lg", {
				title: __("Create your account"),
				sub: __("Start with a free trial. It takes about two minutes."),
				badge: ui.badge(__("First month free · no card"), "ok"),
			});

			// One screen, no scrolling (owner, 2026-10-08): every field sits in one two-column grid
			// without section rules, the coupon opens on demand, and the verbs stay pinned at the
			// bottom of the window. The required stars say what the rules used to.
			const $grid = $('<div class="wa-onb__grid wa-onb__grid--signup"></div>').appendTo($card);
			$grid.append(field_html({ id: "wa-onb-org", label: __("Company name"), placeholder: __("Sanad Trading Company"), value: this.f.org, autocomplete: "organization", required: true, extra: 'data-f="org"' }));
			$grid.append(this.sector_html());
			$grid.append(field_html({ id: "wa-onb-person", label: __("Your name"), placeholder: __("Abdullah Al-Fahd"), value: this.f.person, autocomplete: "name", required: true, extra: 'data-f="person"' }));
			$grid.append(field_html({ id: "wa-onb-email", label: __("Email (optional)"), type: "email", dir: "ltr", placeholder: "email@company.com", value: this.f.email, autocomplete: "email", extra: 'data-f="email"' }));
			// the mobile takes the whole row: the country trigger and the number need the width
			const $phone = $('<div class="wa-onb__field-wide"></div>').appendTo($grid);
			this.phone = new ui.PhoneField({
				wrapper: $phone,
				label: __("WhatsApp number"),
				required: true,
				value: this.f.phone,
				// the company's country, when the system knows it
				country_default: ((this.boot || {}).prefill || {}).country || undefined,
				tip: __("This is the account's own contact number: password recovery, subscription, payment and renewal notices, system alerts and support messages. It is not the device number your customers' messages go out from — that one is linked later, from the Devices screen."),
				on_change: ({ phone_e164, valid }) => {
					this.f.phone = phone_e164 || "";
					this.f.phone_ok = !!valid;
					this.save_draft();
					// the error forced by "Next" goes as soon as the number is right
					if (valid && this.phone && this.phone.opts.invalid) {
						this.phone.opts.invalid = false;
						this.phone.render();
					}
				},
			});

			// ---- the password ------------------------------------------------------------------------
			//
			// The password the account is created with. It goes to the platform with the confirmation
			// code (`onboarding.complete_signup(request_key, code, password)`), never to this site.
			this.password_fields($grid);

			// ---- the invite coupon ---------------------------------------------------------------------
			//
			// Checked against the platform as it is typed (`onboarding.validate_coupon` says whether a
			// code is usable and what it gives, without redeeming it), and sent with the sign-up. Folded
			// behind "I have a coupon" until asked for, or while one is already typed.
			const open = !!this.f.coupon || this.s.coupon_open;
			const $cp = $(`<div class="wa-onb__field-wide wa-onb__coupon"></div>`).appendTo($grid);
			$cp.append(`<button type="button" class="wa-onb__coupon-toggle" data-act="coupon-toggle" aria-expanded="${open}" aria-controls="wa-onb-coupon-slot">${ico("plus", "xs")}<span>${esc(__("I have a coupon"))}</span></button>`);
			const $slot = $(`<div id="wa-onb-coupon-slot"${open ? "" : " hidden"}></div>`).appendTo($cp);
			$slot.append(field_html({ id: "wa-onb-coupon", label: __("Coupon code"), dir: "ltr", placeholder: "BSHQ-FREE2", value: this.f.coupon, mono: true, extra: 'data-f="coupon"' }));
			$cp.on("click", '[data-act="coupon-toggle"]', (e) => {
				const opened = $slot.prop("hidden");
				this.s.coupon_open = opened;
				$slot.prop("hidden", !opened);
				$(e.currentTarget).attr("aria-expanded", String(opened));
				if (opened) $slot.find("input").trigger("focus");
			});

			// ---- the verbs -------------------------------------------------------------------------------
			$card.append(`
				<div class="wa-btnbar wa-onb__pinned">
					${ui.btn({ label: __("Next — terms and conditions"), variant: "primary", cls: "wa-onb__grow", attrs: { "data-act": "to-terms" } })}
					${ui.btn({ label: `${__("Already have an account?")} ${__("Sign in")}`, variant: "secondary", attrs: { "data-act": "to-login" } })}
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

		/**
		 * The password pair, exactly as sign-up draws it — the generator, show / hide, the strength
		 * bars and hint, the match check — for any card that sets a password (sign-up, recovery).
		 * It writes `this.f.password` / `password2`, which are never stored in the draft.
		 */
		password_group($card, { title = __("Password") } = {}) {
			const $pw = $('<div class="wa-onb__group"></div>').appendTo($card);
			$pw.append(ui.rule(title, __("Required")));
			const $pwgrid = $('<div class="wa-onb__grid"></div>').appendTo($pw);
			this.password_fields($pwgrid);
			return $pw;
		}

		/** The two password fields alone, into any two-column grid (the sign-up puts them in its own). */
		password_fields($pwgrid) {
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
		}

		/** Generate / show for the pair; inputs are handled by the card's own `[data-f]` binding. */
		bind_password($card) {
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
				self.save_draft();
				self.show_error("");
				self.refresh_field($card, key);
			});
			$card.on("blur", '[data-f="coupon"]', function () {
				self.f.coupon = this.value.trim().toUpperCase();
				this.value = self.f.coupon;
				self.refresh_field($card, "coupon");
			});

			this.bind_password($card);

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
				if (!this.f.email) return set(null, __("For invoices and account recovery."));
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
				// an empty required field reads as missing once "Next" was pressed, like the others
				if (!pw && tried) set("bad", __("Choose a password for the account"));
				else set(!pw ? null : score <= 1 ? "bad" : score === 2 ? null : "ok", text);
				return this.refresh_field($card, "password2");
			}
			if (key === "password2") {
				const p2 = this.f.password2;
				if (!p2) return set(tried ? "bad" : null, __("Type the password again to confirm it"));
				const ok = p2 === this.f.password;
				return set(ok ? "ok" : "bad", ok ? __("They match") : __("The two passwords do not match"));
			}
			if (key === "coupon") {
				const raw = (this.f.coupon || "").trim();
				this.coupon_ok = false;
				if (!raw) return set(null, __("If one of our customers invited you, enter their coupon and start with one extra free month."));
				if (!COUPON_RE.test(raw)) return set("bad", __("The coupon's shape is not right — for example BSHQ-FREE2."));
				set(null, __("Checking the coupon…"));
				return this.check_coupon($card, raw);
			}
			return this;
		}

		/**
		 * Ask the platform whether a coupon is usable, and say what it gives. It is only checked
		 * here — redeeming happens with the sign-up. Debounced, and a late answer for a code that
		 * has since been retyped is dropped.
		 */
		check_coupon($card, code) {
			if (!this._coupon_debounce) {
				this._coupon_debounce = ui.debounce((raw) => {
					this._coupon_seq = (this._coupon_seq || 0) + 1;
					const seq = this._coupon_seq;
					ui.call("onboarding.validate_coupon", { code: raw }, { silent: true })
						.then((r) => {
							if (seq !== this._coupon_seq || (this.f.coupon || "").trim() !== raw) return;
							// `{ok, valid, message, reason}` — an unusable coupon answers normally
							const ok = !!(r && r.valid);
							this.coupon_ok = ok;
							const text =
								(r && (r.message || r.reason)) ||
								(ok
									? __("Valid coupon — the extra free month is added when the account is activated.")
									: __("This coupon is not valid or has expired. Check it against the one you were sent."));
							this.set_coupon_hint($card, ok ? "ok" : "bad", text);
						})
						.catch((err) => {
							if (seq !== this._coupon_seq) return;
							this.coupon_ok = false;
							this.set_coupon_hint($card, "bad", err.message);
						});
				}, 450);
			}
			this._coupon_debounce(code);
			return this;
		}

		set_coupon_hint($card, tone, text) {
			const $field = $card.find('[data-f="coupon"]').closest(".wa-field");
			$field.removeClass("wa-onb__ok wa-onb__bad").addClass(tone === "ok" ? "wa-onb__ok" : "wa-onb__bad");
			$field
				.find('[data-slot="hint"]')
				.attr("class", `wa-field__hint wa-onb__hint--${tone}`)
				.html(`<span class="wa-onb__hint-icon">${ico(tone === "ok" ? "tick" : "warn", "xs")}</span><span>${esc(text)}</span>`);
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

			// one pair of document listeners at a time: every redraw of this card (the demo data,
			// "back" from the terms) added another pair and none was ever taken off
			this.unbind_sector();
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
				[!!this.f.email && !EMAIL_RE.test(this.f.email), '[data-f="email"]'],
				// the same rule as recovery: a password the strength bar calls weak does not pass
				[(this.f.password || "").length < 8 || pw_score(this.f.password) <= 1, '[data-f="password"]'],
				[this.f.password !== this.f.password2, '[data-f="password2"]'],
			].filter(([bad]) => bad);
			// the mobile is the kit's field: its error line is forced on, like the other fields'
			if (this.phone) {
				this.phone.opts.invalid = !this.f.phone_ok;
				this.phone.render();
			}
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
		 * The coupon, the company name and its activity ride along here; the password goes with the
		 * confirmation code.
		 *
		 * TODO(backend): the fact that the terms were read and accepted still stops here — it wants
		 * `onboarding.accept_terms(version)` or a field on the platform's sign-up request.
		 */
		start_signup($btn) {
			this.show_error("");
			return this.busy_button(
				$btn,
				__("Creating the account…"),
				ui
					.call("onboarding.start_signup", {
						plan_code: this.plan_code(),
						mobile: this.f.phone,
						full_name: this.f.person,
						email: this.f.email,
						channel: this.s.channel,
						coupon_code: (this.f.coupon || "").trim() || undefined,
						company_name: (this.f.org || "").trim() || undefined,
						business_activity: (this.f.sector === SECTOR_OTHER() ? this.f.sector_other : this.f.sector) || undefined,
					}, { silent: true })
					.then((r) => {
						this.ctx.request_key = r.request_key;
						this.ctx.code_ttl = cint(r.code_ttl) || cint(this.ctx.code_ttl) || DEFAULT_TTL_S;
						this.ctx.route = this.route_of(r);
						this._finishing = false;
						this.set_state({ stage: "verify", verify: "idle", left: this.ctx.code_ttl });
						this.watch_signup();
					})
					.catch((err) => this.signup_failed(err))
			);
		}

		// =============================================================================================
		// Step 3 — the confirmation code
		// =============================================================================================

		/**
		 * How the platform proves the number — its choice, not the form's (`api.onboarding.start_signup`
		 * → `services.onboarding.verification_route`):
		 * - `whatsapp`: nothing is sent to the user. The user sends the shown code FROM the registered
		 *   number TO the platform's number; the sender is the proof, and `watch_signup` sees it land.
		 * - `email`: the platform's signup device is offline and it mailed the code instead.
		 */
		route_of(r) {
			// when the code dies, as a clock time: a reload recomputes the countdown from it
			this.ctx.code_expires = Date.now() + (cint(this.ctx.code_ttl) || DEFAULT_TTL_S) * 1000;
			return {
				channel: (r && r.channel) || "email",
				code: r && r.code,
				platform_phone: r && r.platform_phone,
				email: r && r.email,
				link_sent: !!(r && r.link_sent),
			};
		}

		card_verify() {
			const route = this.ctx.route || this.route_of(null);
			const by_whatsapp = route.channel === "whatsapp" && route.code && route.platform_phone;
			// WhatsApp confirmation is down on the platform: a link went to the email instead, and
			// this page finishes by itself once it is opened, on any device (owner, 2026-10-08)
			const by_link = !by_whatsapp && route.link_sent;
			const own = ui.PhoneField.format_display(this.f.phone) || this.f.phone;
			const $card = this.card("md", {
				title: __("Confirm the mobile number"),
				sub: by_whatsapp
					? __("Send the code below from your WhatsApp on the number you registered. The account is activated as soon as it arrives.")
					: by_link
						? __("Confirmation by WhatsApp is not available right now, so the platform sent a link to your email. Open it on any device, and this page finishes by itself.")
						: __("The platform sent a code to your email. Enter it here and the account is activated."),
			});

			const col = (k, v, mono) =>
				`<span class="wa-onb__route-col">
					<span class="wa-onb__route-k">${esc(k)}</span>
					<span class="wa-onb__route-v${mono ? " wa-onb__route-v--mono" : ""}" dir="ltr">${esc(v)}</span>
				</span>`;
			const route_box = by_whatsapp
				? col(__("From your registered number"), own, true) +
				  `<span class="wa-onb__route-arrow">${ico("chevronEnd", "sm")}</span>` +
				  col(__("To the platform's number"), ui.PhoneField.format_display(route.platform_phone) || route.platform_phone, true)
				: col(__("From the platform"), __("WhatsappNext")) +
				  `<span class="wa-onb__route-arrow">${ico("chevronEnd", "sm")}</span>` +
				  col(__("To your email"), route.email || this.f.email, true);

			const text = by_whatsapp ? `${CODE_PREFIX} ${route.code}` : "";
			const wa_link = by_whatsapp ? wa_send_link(route.platform_phone, route.code) : "";
			const codebox = by_whatsapp
				? `<div class="wa-sunken wa-onb__codebox">
					<span class="wa-field__label">${esc(__("The message to send"))}</span>
					${code_html(route.code)}
					<p class="wa-onb__code-help">${esc(__("Send it from {0} exactly as written. Nothing is sent to you: the message you send is the confirmation.", [ltr(own)]))}</p>
					<div class="wa-btnbar">
						<a class="btn btn-primary wa-onb__grow" href="${esc(wa_link)}" target="_blank" rel="noopener">${ico("whatsapp", "sm")} <span>${esc(__("Open WhatsApp and send the code"))}</span></a>
						${ui.btn({ label: __("Copy the message"), variant: "secondary", attrs: { "data-act": "copy-code" } })}
					</div>
				</div>`
				: by_link
				? `<div class="wa-sunken wa-onb__codebox">
					<span class="wa-field__label">${esc(__("Check your email"))}</span>
					<p class="wa-onb__code-help">${esc(__("Open the link in the email from WhatsappNext. Not there? Check the spam folder, or send the link again."))}</p>
				</div>`
				: `<div class="wa-sunken wa-onb__codebox">
					<label class="wa-field__label" for="wa-onb-code">${esc(__("Verification code"))}</label>
					<input class="wa-onb__code-input" id="wa-onb-code" type="text" dir="ltr" inputmode="numeric"
						autocomplete="one-time-code" placeholder="••••••" aria-describedby="wa-onb-code-state">
					<p class="wa-onb__code-help">${esc(__("Check your inbox, and the spam folder, for a message from the platform. If it has not arrived, wait for the timer to run down and ask for it again."))}</p>
				</div>`;

			// the password is never stored: after a reload it is asked for here, once, to finish
			const password_box = this.f.password
				? ""
				: `<div class="wa-sunken wa-onb__codebox">
					<label class="wa-field__label" for="wa-onb-repw">${esc(__("Your password"))}</label>
					<input class="wa-input wa-input--mono" id="wa-onb-repw" type="password" autocomplete="new-password" placeholder="••••••••">
					<p class="wa-onb__code-help">${esc(__("The page was reloaded, so enter the password you chose once more. It is needed to finish creating the account."))}</p>
					${by_whatsapp || by_link ? `<div class="wa-btnbar">${ui.btn({ label: __("Finish"), variant: "primary", cls: "wa-onb__grow", attrs: { "data-act": "finish" } })}</div>` : ""}
				</div>`;

			$card.append(`
				<div class="wa-sunken wa-onb__route">${route_box}</div>
				<div data-slot="change-number" hidden></div>
				${codebox}
				${password_box}
				<div data-slot="state" id="wa-onb-code-state"></div>
				<div class="wa-btnbar">
					${by_whatsapp || by_link ? "" : ui.btn({ label: __("Confirm code"), variant: "primary", cls: "wa-onb__grow", attrs: { "data-act": "verify" } })}
					${ui.btn({ label: by_link ? __("Send the link again") : __("Get a new code"), variant: "secondary", attrs: { "data-act": "resend" } })}
					${ui.btn({ label: __("Change my number"), variant: "ghost", attrs: { "data-act": "change" } })}
				</div>`);

			$card.on("input", "#wa-onb-repw", (e) => {
				this.f.password = e.currentTarget.value;
				this.f.password2 = e.currentTarget.value;
			});
			$card.on("click", '[data-act="finish"]', () => this.finish_verified());

			bind_code_copy($card);
			$card.on("click", '[data-act="copy-code"]', () =>
				navigator.clipboard
					.writeText(text)
					.then(() => ui.Toast.success(__("Copied")))
					.catch(() => ui.Toast.warning(__("The browser did not allow copying. Select the code and copy it by hand.")))
			);

			this.draw_verify_state($card);
			this.run_countdown($card);

			$card.on("click", '[data-act="verify"]', (e) => this.verify_code($(e.currentTarget), $card));
			$card.on("keydown", "#wa-onb-code", (e) => {
				if (e.key === "Enter") $card.find('[data-act="verify"]').trigger("click");
			});
			$card.on("click", '[data-act="resend"]', (e) => this.resend_code($(e.currentTarget), $card));
			// The number is changed here, on this step: the rest of the sign-up (company, owner, email,
			// password) stands. The platform ties a sign-up request to its number and has no way to
			// re-point one, so the new number gets a new request with the same details; the old one
			// simply expires unconfirmed (nothing exists on the platform until confirmation).
			$card.on("click", '[data-act="change"]', () => this.open_change_number($card));
		}

		draw_verify_state($card) {
			const $slot = $card.find('[data-slot="state"]');
			if (this.s.verify === "ok") return $slot.html(strip_html("ok", __("The code was accepted and the number is confirmed.")));
			if (this.s.verify === "confirmed")
				return $slot.html(strip_html("ok", this.f.password ? __("Your number is confirmed. Finishing your account…") : __("Your number is confirmed. Enter your password and press Finish.")));
			if (this.s.verify === "fail") return $slot.html(strip_html("danger", __("That code was not accepted. Check it and try again, or ask for a new one."), { role: "alert" }));
			const m = Math.floor(this.s.left / 60);
			const sec = String(this.s.left % 60).padStart(2, "0");
			const route = this.ctx.route;
			const by_whatsapp = route && route.channel === "whatsapp";
			// while waiting, the way to send it stays one press away (owner, 2026-10-08); a new code
			// redraws this strip, so the link always carries the code that is live
			const link = by_whatsapp && this.s.left > 0 ? wa_send_link(route.platform_phone, route.code) : "";
			return $slot.html(
				strip_html(
					"warn",
					this.s.left <= 0
						? __("The code has expired. Ask for a new one.")
						: by_whatsapp
							? __("Waiting for your message — the code expires in {0}:{1}", [m, sec])
							: route && route.link_sent
								? __("Waiting for the link to be opened — it expires in {0}:{1}", [m, sec])
								: __("Waiting for the code — it expires in {0}:{1}", [m, sec]),
					{ link }
				)
			);
		}

		run_countdown($card) {
			this.stop_timers();
			const $resend = $card.find('[data-act="resend"]');
			const tick = () => {
				// counted from the code's own expiry, not decremented: a background tab runs its
				// timers once a minute at best, and the count then fell behind the real code
				if (this.ctx.code_expires) this.s.left = Math.max(0, Math.round((this.ctx.code_expires - Date.now()) / 1000));
				const spent = this.ctx.code_ttl - this.s.left;
				const locked = spent < RESEND_LOCK_S && this.s.left > 0;
				$resend.prop("disabled", locked);
				$resend.find("span").last().text(locked ? __("Resend in {0} s", [RESEND_LOCK_S - spent]) : __("Resend the code"));
				if (this.s.verify === "idle") this.draw_verify_state($card);
				if (!this.ctx.code_expires && this.s.left > 0) this.s.left -= 1;
			};
			tick();
			this._tick = window.setInterval(tick, 1000);
		}

		/** `true` when a password is at hand to finish with; otherwise says so and points at the field. */
		need_password() {
			if ((this.f.password || "").length >= 8) return true;
			this.show_error(__("Enter the password you chose to finish creating the account."));
			this.$stage.find("#wa-onb-repw").trigger("focus");
			return false;
		}

		verify_code($btn, $card) {
			if (!this.need_password()) return;
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
					.call("onboarding.complete_signup", { request_key: this.ctx.request_key, code, password: this.f.password }, { silent: true })
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
					// The account exists, but this site holds no keys for it: "ready" would be a
					// dead end (it has nowhere to enter keys, and a reload fell back to an empty
					// sign-up). Signing in with the new account is what fetches and stores them.
					this.f.login_id = no_plus(this.f.phone) || this.f.email;
					this.set_state({ stage: "login", err: __("The account was created, but this site is not linked to it yet. Sign in with the password you just chose to finish.") });
					return;
				}
				// `complete_signup` already tested the connection, registered the webhook and brought
				// the account's devices in (`services.onboarding.link_site`); the status shows the result.
				this.ctx.connection = result.connection;
				this.mark_linked();
				this.set_state({ stage: "ready" });
			});
		}

		/**
		 * A refused sign-up. When the number or email belongs to a confirmed account
		 * (`WAAccountExistsError`) the answer is the sign-in step; the reset there starts from the
		 * number that was typed. Any other refusal is shown as it is.
		 */
		signup_failed(err) {
			if (!err || err.exc_type !== "WAAccountExistsError") return this.show_error(err && err.message);
			// The number or email belongs to a confirmed account: the answer is the way in, not an
			// error — say so in a toast and open the sign-in step.
			this.stop_timers();
			this.stop_signup_watch();
			this.f.reset_identifier = no_plus(this.f.phone) || this.f.email;
			ui.Toast.info(__("You already have an account. Sign in to continue."));
			this.set_state({ stage: "login" });
		}

		/** The inline number editor of the confirmation step. */
		open_change_number($card) {
			const $slot = $card.find('[data-slot="change-number"]');
			if (!$slot.prop("hidden")) return $slot.find("input").first().trigger("focus");
			let next = { phone_e164: "", valid: false };
			$slot.prop("hidden", false).html(`
				<div class="wa-sunken wa-onb__codebox">
					<div data-slot="phone"></div>
					<div class="wa-btnbar">
						${ui.btn({ label: __("Send to this number"), variant: "primary", cls: "wa-onb__grow", attrs: { "data-act": "change-save" } })}
						${ui.btn({ label: __("Cancel"), variant: "ghost", attrs: { "data-act": "change-cancel" } })}
					</div>
				</div>`);
			new ui.PhoneField({
				wrapper: $slot.find('[data-slot="phone"]'),
				label: __("The new mobile number (WhatsApp)"),
				required: true,
				value: this.f.phone,
				on_change: (v) => (next = v),
			});
			$slot.find("input").first().trigger("focus");
			$slot.on("click", '[data-act="change-cancel"]', () => $slot.prop("hidden", true).off().empty());
			$slot.on("click", '[data-act="change-save"]', (e) => {
				if (!next.valid || !next.phone_e164) {
					this.show_error(__("Enter a valid mobile number."));
					return;
				}
				if (next.phone_e164 === this.f.phone) {
					$slot.prop("hidden", true).off().empty();
					return;
				}
				this.change_number($(e.currentTarget), next.phone_e164);
			});
		}

		/** A new request for the new number, with everything else as entered; stays on this step. */
		change_number($btn, phone) {
			this.show_error("");
			return this.busy_button(
				$btn,
				__("Sending…"),
				ui
					.call("onboarding.start_signup", {
						plan_code: this.plan_code(),
						mobile: phone,
						full_name: this.f.person,
						email: this.f.email,
						channel: this.s.channel,
						coupon_code: (this.f.coupon || "").trim() || undefined,
						company_name: (this.f.org || "").trim() || undefined,
						business_activity: (this.f.sector === SECTOR_OTHER() ? this.f.sector_other : this.f.sector) || undefined,
					}, { silent: true })
					.then((r) => {
						this.f.phone = phone;
						this.f.phone_ok = true;
						this.ctx.request_key = r.request_key;
						this.ctx.code_ttl = cint(r.code_ttl) || cint(this.ctx.code_ttl) || DEFAULT_TTL_S;
						this.ctx.route = this.route_of(r);
						this._finishing = false;
						this.set_state({ stage: "verify", verify: "idle", left: this.ctx.code_ttl });
						this.watch_signup();
						ui.Toast.success(__("The number was changed."));
					})
					// the old number and its request stand when the platform refuses the new one
					.catch((err) => this.signup_failed(err))
			);
		}

		resend_code($btn, $card) {
			this.show_error("");
			return this.busy_button(
				$btn,
				__("Sending…"),
				ui
					.call("onboarding.start_signup", {
						plan_code: this.plan_code(),
						mobile: this.f.phone,
						full_name: this.f.person,
						email: this.f.email,
						channel: this.s.channel,
						coupon_code: (this.f.coupon || "").trim() || undefined,
						company_name: (this.f.org || "").trim() || undefined,
						business_activity: (this.f.sector === SECTOR_OTHER() ? this.f.sector_other : this.f.sector) || undefined,
					}, { silent: true })
					.then((r) => {
						this.ctx.request_key = r.request_key || this.ctx.request_key;
						this.ctx.code_ttl = cint(r.code_ttl) || cint(this.ctx.code_ttl) || DEFAULT_TTL_S;
						this.ctx.route = this.route_of(r);
						this.s.left = this.ctx.code_ttl;
						this.s.verify = "idle";
						// the platform may answer on another channel this time: redraw the panel
						this.save_draft();
						this.render();
						ui.Toast.success(
							this.ctx.route.channel === "whatsapp" ? __("A new code is ready. Send it from your number.") : __("A new code is on its way.")
						);
					})
					.catch((err) => this.signup_failed(err))
			);
		}

		watch_signup() {
			this.stop_signup_watch();
			const seen = (status, expires_in) => {
				// the platform's own clock: the countdown follows what is really left
				if (expires_in != null && status === "Pending Verification") this.ctx.code_expires = Date.now() + cint(expires_in) * 1000;
				if (status === "Verified" && this.s.stage === "verify" && !this._finishing) {
					// the number is confirmed: nothing more to wait for. With the password at hand the
					// account is finished once, here; after a reload the strip says so and «Finish» waits
					this.stop_signup_watch();
					this.s.verify = "confirmed";
					this.draw_verify_state(this.$stage);
					if ((this.f.password || "").length >= 8) this.finish_verified();
				} else if (status === "Completed") {
					this.stop_signup_watch();
					ui.announce(__("The sign-up was confirmed on the platform."));
				}
			};
			const read = () =>
				this.ctx.request_key &&
				ui.call("onboarding.get_signup_status", { request_key: this.ctx.request_key }, { silent: true })
					.then((r) => seen(r && r.status, r && r.expires_in))
					.catch(() => {});
			// the platform's call (webhooks/v1/signup.py), passed on the moment it arrives; the page
			// reads the request only when the connection comes back or the person returns to the tab
			this._stop_signup_listen = ui.listen(
				"wa:signup:status",
				(data) => {
					if (data && data.request_key === this.ctx.request_key) seen(data.status);
				},
				{ on_connect: read }
			);
			// once right away: after a reload the number may be confirmed already
			read();
		}

		/** The platform saw the confirming message: set the password and link the site. */
		finish_verified() {
			if (!this.need_password()) {
				// the number is confirmed; only the password (not kept across a reload) is missing
				this.stop_signup_watch();
				return;
			}
			if (this.s.verify !== "confirmed") {
				// «Finish» after a reload, before the platform has the code: asking now could only be
				// refused ("Verify your account first"). The password is kept and the page goes on
				// waiting; the account is finished by itself the moment the number is confirmed.
				this.show_error(__("Send the code from your WhatsApp first. The account is finished by itself the moment your number is confirmed."));
				return;
			}
			this._finishing = true;
			this.stop_signup_watch();
			return ui
				.call("onboarding.complete_signup", { request_key: this.ctx.request_key, password: this.f.password }, { silent: true })
				.then((r) => {
					if (!r || !r.ok) throw new Error(__("The platform did not finish the sign-up. Try again."));
					this.s.verify = "ok";
					ui.announce(__("The number is confirmed."), { assertive: true });
					return this.after_signup(r);
				})
				.catch((err) => {
					// The number is confirmed already: asking the platform again cannot change the
					// answer, so nothing is retried on its own (it was every 5 s, without end). The
					// reason is shown, and «Finish» tries once more when the person presses it.
					this._finishing = false;
					this.show_error((err && err.message) || __("The platform did not finish the sign-up. Try again."));
					let $finish = this.$stage.find('[data-act="finish"]');
					if (!$finish.length) {
						// the password was at hand, so the card drew no «Finish»: give the one try back
						$finish = $(ui.btn({ label: __("Finish"), variant: "primary", cls: "wa-onb__grow", attrs: { "data-act": "finish" } }));
						this.$stage.find('[data-slot="state"]').after($('<div class="wa-btnbar"></div>').append($finish));
					}
					$finish.prop("disabled", false);
				});
		}

		stop_signup_watch() {
			if (this._stop_signup_listen) this._stop_signup_listen();
			this._stop_signup_listen = null;
		}

		// =============================================================================================
		// The way in for an account that already exists
		// =============================================================================================

		/**
		 * The prototype's sign-in card, drawn as it draws it: an e-mail, a password with the reveal
		 * inside the field, the line that says where the details are kept, "نسيت كلمة المرور؟",
		 * the divider and the way to a new account. No platform address and no API keys — the
		 * platform authenticates the person, and `onboarding.login` stores the keys server-side.
		 */
		card_login() {
			// the field is drawn empty, so the model is too: a password typed on an earlier visit to
			// this card is not sent behind an empty-looking field
			this.f.login_password = "";
			const $card = this.card("sm", {
				title: __("Welcome back"),
				sub: __("Sign in to see your messages, your balance and your numbers."),
			});
			$card.append(
				field_html({ id: "wa-onb-login-email", label: __("Mobile number or email"), hint: __("Mobile number with the country code"), dir: "ltr", placeholder: "967 7XX XXX XXX", value: no_plus(this.f.login_id !== undefined ? this.f.login_id : this.f.phone || this.f.email), autocomplete: "username", extra: 'data-l="login_id"' })
			);
			$card.append(`
				<div class="wa-field">
					<label class="wa-field__label" for="wa-onb-login-pw">${esc(__("Password"))}</label>
					<!-- the password is written left to right, so the field and its "Show" are too: the
					     button takes the end the input reserves room at, not the page's end -->
					<span class="wa-affix wa-onb__pwaffix" dir="ltr">
						<input class="wa-input" id="wa-onb-login-pw" data-l="login_password" type="password" dir="ltr"
							autocomplete="current-password" placeholder="••••••••">
						<span class="wa-affix__in wa-affix__in--end wa-onb__reveal-slot">
							<button type="button" class="wa-onb__reveal" data-act="reveal" aria-pressed="false"
								aria-controls="wa-onb-login-pw" dir="auto">${esc(__("Show"))}</button>
						</span>
					</span>
				</div>
				<div class="wa-onb__loginfoot">
					<span class="wa-onb__lock">${ico("shield", "xs")}${esc(__("Sign-in details are kept in the app's settings"))}</span>
					${ui.btn({ label: __("Forgot password?"), variant: "ghost", size: "sm", attrs: { "data-act": "reset" } })}
				</div>
				${ui.btn({ label: __("Sign in"), variant: "primary", block: true, attrs: { "data-act": "login" } })}
				<div class="wa-onb__divider"><span>${esc(__("New to WhatsappNext?"))}</span></div>
				${ui.btn({ label: __("Create a free account"), variant: "secondary", block: true, attrs: { "data-act": "new" } })}
				${this.s.switching ? ui.btn({ label: __("Back to the current account"), variant: "ghost", block: true, attrs: { "data-act": "stay" } }) : ""}`);

			$card.on("input", "[data-l]", (e) => {
				this.f[$(e.currentTarget).data("l")] = e.currentTarget.value;
				this.save_draft(); // the email survives a reload; the password is never stored
				this.show_error("");
			});
			$card.on("click", '[data-act="reveal"]', (e) => {
				const $b = $(e.currentTarget);
				const on = $b.attr("aria-pressed") !== "true";
				$b.attr("aria-pressed", String(on)).text(on ? __("Hide") : __("Show"));
				$card.find('[data-l="login_password"]').attr("type", on ? "text" : "password");
			});
			$card.on("keydown", "[data-l]", (e) => {
				if (e.key === "Enter") $card.find('[data-act="login"]').trigger("click");
			});
			$card.on("click", '[data-act="reset"]', () => this.set_state({ stage: "reset" }));
			$card.on("click", '[data-act="new"]', () => this.set_state({ stage: "signup" }));
			$card.on("click", '[data-act="stay"]', () => this.set_state({ stage: "ready", switching: false }));
			$card.on("click", '[data-act="login"]', (e) => this.do_login($(e.currentTarget)));
		}

		/**
		 * `onboarding.login(platform_base_url, email, password)` authenticates against the platform
		 * and stores the keys with `set_password`; it returns only whether it worked and who the
		 * customer is. Nothing is kept in the browser.
		 */
		do_login($btn) {
			// the platform takes the mobile number (any format), the username or the email. The
			// field opens on the sign-up's number or email; once it is edited, what it holds is the
			// answer — an emptied field is empty, not silently the sign-up's number again.
			const email = cstr(this.f.login_id !== undefined ? this.f.login_id : this.f.phone || this.f.email).trim();
			// The sign-in password is its own field: it shared `f.password` with sign-up, so a
			// password chosen on the sign-up card was sent as the sign-in password without being
			// typed here, and a sign-in attempt overwrote the one chosen for the new account.
			const password = this.f.login_password || "";
			if (!email || !password) return this.show_error(__("Enter your mobile number or email, and your password."));
			this.show_error("");
			return this.busy_button(
				$btn,
				__("Signing in…"),
				ui
					.call(
						"onboarding.login",
						{
							// The prototype's card has no address field, because the platform this
							// site talks to is a setting, not something a person retypes to sign in.
							// `services.onboarding.login` keeps the stored address when this is
							// empty and only overwrites it when a different one is passed.
							platform_base_url: "",
							email,
							password,
						},
						// a refusal belongs in this card, not in a Desk dialog over it
						{ silent: true }
					)
					.then((r) => {
						if (r && r.verification_required) return this.confirm_unfinished(r, email, password);
						if (r && r.ok === false) return this.show_error(r.message || __("The mobile number, email or password is not correct."));
						if (r && r.customer_name) this.f.org = r.customer_name;
						ui.Toast.success(__("Signed in."));
						// An account that already exists has nothing left to set up here: straight to the
						// app's own workspace, not back through this screen (owner, 2026-10-08).
						this.mark_linked();
						this.clear_draft();
						frappe.set_route("wa-home");
					})
					.catch((err) => this.show_error(err.message))
			);
		}

		/**
		 * The account was created but its number never confirmed (owner, 2026-10-20): the platform
		 * opened a new confirmation for it, so this goes to the sign-up's confirmation step. The
		 * password just typed is the one the account is finished with once the number is confirmed;
		 * then the site is linked as after any sign-up.
		 */
		confirm_unfinished(r, identifier, password) {
			if (!r.request_key) return this.show_error(r.message);
			this.ctx.request_key = r.request_key;
			this.ctx.route = this.route_of(r);
			this.f.password = password;
			this.f.password2 = password;
			const digits = cstr(identifier).replace(/\D/g, "");
			if (!cstr(identifier).includes("@") && digits.length >= 8) {
				this.f.phone = `+${digits}`;
				this.f.phone_ok = true;
			}
			this._finishing = false;
			ui.Toast.info ? ui.Toast.info(r.message) : ui.Toast.success(r.message);
			ui.announce(r.message, { assertive: true });
			this.set_state({ stage: "verify", verify: "idle", left: this.ctx.code_ttl, err: "" });
			this.watch_signup();
		}

		/**
		 * Password recovery, end to end, like a subscription platform: the account's email or
		 * number → a code (by email, typed here; or on WhatsApp, where the person replies with it)
		 * → a new password → signed in and this site linked (`onboarding.finish_password_reset`).
		 * The open request is kept in the draft, so a reload returns to it.
		 */
		card_reset() {
			const reset = this.ctx.reset;
			// the password step takes sign-up's width: its pair of fields needs the room
			const $card = this.card(reset && reset.verified ? "md" : "sm", {
				title: reset && reset.verified ? __("It's you. Choose a new password") : __("Reset your password"),
				sub: !reset
					? __("Tell us which account, and we'll confirm it is you through WhatsApp.")
					: reset.verified
						? __("You will be signed out everywhere else and signed in here.")
						: __("Tell us which account, and we'll confirm it is you through WhatsApp."),
			});
			if (!reset) return this.reset_ask($card);
			if (reset.verified) return this.reset_password($card, reset);

			const by_email = reset.channel === "email" || !reset.code;
			if (by_email) {
				$card.append(`
					<div class="wa-sunken wa-onb__codebox">
						<p class="wa-onb__code-help">${esc(__("A recovery code was sent to {0}. Check the inbox and the spam folder.", [reset.email || __("the account's email")]))}</p>
						<label class="wa-field__label" for="wa-onb-reset-code">${esc(__("Recovery code"))}</label>
						<input class="wa-onb__code-input" id="wa-onb-reset-code" type="text" dir="ltr" inputmode="numeric" autocomplete="one-time-code" placeholder="••••••">
					</div>
					<div class="wa-btnbar">
						${ui.btn({ label: __("Verify the code"), variant: "primary", cls: "wa-onb__grow", attrs: { "data-act": "reset-verify" } })}
						${ui.btn({ label: __("Send the code again"), variant: "secondary", attrs: { "data-act": "reset-again" } })}
					</div>`);
				$card.on("keydown", "#wa-onb-reset-code", (e) => {
					if (e.key === "Enter") $card.find('[data-act="reset-verify"]').trigger("click");
				});
				$card.on("click", '[data-act="reset-verify"]', (e) => {
					const code = ($card.find("#wa-onb-reset-code").val() || "").trim();
					if (!code) return this.show_error(__("Enter the recovery code you received."));
					this.show_error("");
					return this.busy_button(
						$(e.currentTarget),
						__("Verifying…"),
						ui
							.call("onboarding.verify_code", { request_key: reset.request_key, code, purpose: "Password Reset" }, { silent: true })
							.then((r) => {
								if (!r || !r.ok) return this.show_error(__("That code was not accepted. Check it and try again, or ask for a new one."));
								this.reset_verified();
							})
							.catch((err) => this.show_error(err.message))
					);
				});
			} else {
				// the sign-up's proof, for the same account: nothing arrives on WhatsApp — the person
				// sends the shown message from the account's number, and the sender is the proof
				const text = `${CODE_PREFIX} ${reset.code}`;
				const platform = ui.PhoneField.format_display(reset.platform_phone) || reset.platform_phone;
				const link = wa_send_link(reset.platform_phone, reset.code);
				$card.append(`
					<div class="wa-sunken wa-onb__route">
						<span class="wa-onb__route-col">
							<span class="wa-onb__route-k">${esc(__("From the account's number"))}</span>
							<span class="wa-onb__route-v wa-onb__route-v--mono" dir="ltr">${esc(reset.mobile_hint || reset.identifier || "")}</span>
						</span>
						<span class="wa-onb__route-arrow">${ico("chevronEnd", "sm")}</span>
						<span class="wa-onb__route-col">
							<span class="wa-onb__route-k">${esc(__("To the platform's number"))}</span>
							<span class="wa-onb__route-v wa-onb__route-v--mono" dir="ltr">${esc(platform)}</span>
						</span>
					</div>
					<div class="wa-sunken wa-onb__codebox">
						<span class="wa-field__label">${esc(__("The message to send"))}</span>
						${code_html(reset.code)}
						<p class="wa-onb__code-help">${esc(__("Send it from the account's WhatsApp number exactly as written. Nothing is sent to you: the message you send is the confirmation."))}</p>
						<div class="wa-btnbar">
							<a class="btn btn-primary wa-onb__grow" href="${esc(link)}" target="_blank" rel="noopener">${ico("whatsapp", "sm")} <span>${esc(__("Open WhatsApp and send the code"))}</span></a>
							${ui.btn({ label: __("Copy the message"), variant: "secondary", attrs: { "data-act": "copy-reset" } })}
						</div>
					</div>
					<div data-slot="reset-state">${strip_html("warn", __("Waiting for your message on WhatsApp… The next step opens by itself when it arrives."), { link })}</div>
					<div class="wa-btnbar">
						${ui.btn({ label: __("Send the code again"), variant: "secondary", attrs: { "data-act": "reset-again" } })}
					</div>`);
				bind_code_copy($card);
				$card.on("click", '[data-act="copy-reset"]', () =>
					navigator.clipboard
						.writeText(text)
						.then(() => ui.Toast.success(__("Copied")))
						.catch(() => ui.Toast.warning(__("The browser did not allow copying. Select the code and copy it by hand.")))
				);
				this.watch_reset();
			}

			$card.append(`
				<div class="wa-btnbar">
					${ui.btn({ label: __("Use a different account"), variant: "ghost", attrs: { "data-act": "reset-other" } })}
					${ui.btn({ label: `${__("Remembered it?")} ${__("Sign in")}`, variant: "ghost", attrs: { "data-act": "back" } })}
				</div>`);
			this.bind_reset_nav($card, reset);
		}

		/** The code (email) or the person's message (WhatsApp) confirmed it: on to the password. */
		reset_verified() {
			this.stop_reset_watch();
			if (!this.ctx.reset) return;
			this.ctx.reset.verified = true;
			this.f.password = "";
			this.f.password2 = "";
			ui.Toast.success(__("Confirmed. Choose the new password."));
			this.set_state({ stage: "reset" });
		}

		/** Step two: the same password fields as sign-up, then save and sign in. */
		reset_password($card, reset) {
			$card.append(`<div>${strip_html("ok", __("Confirmed — this is your account."))}</div>`);
			this.password_group($card, { title: __("New password") });
			$card.append(`
				<div class="wa-btnbar">
					${ui.btn({ label: __("Save and sign in"), variant: "primary", cls: "wa-onb__grow", attrs: { "data-act": "reset-finish" } })}
				</div>
				<div class="wa-btnbar">
					${ui.btn({ label: __("Use another email or number"), variant: "ghost", attrs: { "data-act": "reset-other" } })}
					${ui.btn({ label: `${__("Remembered it?")} ${__("Sign in")}`, variant: "ghost", attrs: { "data-act": "back" } })}
				</div>`);
			// the same live checks as sign-up: strength bars and hint, the match line
			$card.on("input", "[data-f]", (e) => {
				const key = $(e.currentTarget).data("f");
				this.f[key] = e.currentTarget.value;
				this.show_error("");
				this.refresh_field($card, key);
			});
			this.bind_password($card);
			["password", "password2"].forEach((k) => this.refresh_field($card, k));
			this.bind_reset_nav($card, reset);

			$card.on("click", '[data-act="reset-finish"]', (e) => {
				this.s.tried = true;
				const pw = this.f.password || "";
				if (pw.length < 8 || pw_score(pw) <= 1) {
					this.refresh_field($card, "password");
					$card.find('[data-f="password"]').trigger("focus");
					return this.show_error(__("Choose a stronger password: at least 8 characters, with digits, capitals, small letters and a symbol."));
				}
				if (pw !== this.f.password2) {
					this.refresh_field($card, "password2");
					$card.find('[data-f="password2"]').trigger("focus");
					return this.show_error(__("The two passwords do not match"));
				}
				this.show_error("");
				return this.busy_button(
					$(e.currentTarget),
					__("Saving…"),
					ui
						.call("onboarding.finish_password_reset", { request_key: reset.request_key, password: pw }, { silent: true })
						.then((r) => {
							if (r && r.ok === false) return this.show_error(r.message || __("The password was changed, but signing in failed. Sign in with it."));
							this.ctx.reset = null;
							if (r && r.customer_name) this.f.org = r.customer_name;
							ui.Toast.success(__("The password was changed and you are signed in."));
							return this.load();
						})
						.catch((err) => this.show_error(err.message))
				);
			});
		}

		bind_reset_nav($card, reset) {
			$card.on("click", '[data-act="back"]', () => {
				this.stop_reset_watch();
				this.ctx.reset = null;
				this.set_state({ stage: "login" });
			});
			$card.on("click", '[data-act="reset-other"]', () => {
				this.stop_reset_watch();
				this.ctx.reset = null;
				this.set_state({ stage: "reset" });
			});
			$card.on("click", '[data-act="reset-again"]', (e) => this.send_reset($(e.currentTarget), reset.identifier));
		}

		/** The first half of recovery: which account. */
		reset_ask($card) {
			$card.append(field_html({ id: "wa-onb-identifier", label: __("Mobile number or email"), hint: __("The mobile number, email or username of your account."), dir: "ltr", placeholder: "967 7XX XXX XXX", value: no_plus(this.f.reset_identifier || this.f.login_id || this.f.phone || this.f.email), required: true, extra: 'data-r="identifier"' }));
			$card.append(`
				<div class="wa-btnbar">
					${ui.btn({ label: __("Continue"), variant: "primary", cls: "wa-onb__grow", attrs: { "data-act": "send" } })}
					${ui.btn({ label: `${__("Remembered it?")} ${__("Sign in")}`, variant: "secondary", attrs: { "data-act": "back" } })}
				</div>
				<p class="wa-onb__foot-note">${esc(__("No longer have the registered email or number? Contact support on {0}.", [ltr(SUPPORT_PHONE)]))}</p>`);
			$card.on("input", '[data-r="identifier"]', (e) => {
				this.f.reset_identifier = e.currentTarget.value;
				this.save_draft();
			});
			$card.on("click", '[data-act="back"]', () => this.set_state({ stage: "login" }));
			$card.on("click", '[data-act="send"]', (e) => {
				const identifier = ($card.find('[data-r="identifier"]').val() || "").trim();
				if (!identifier) return this.show_error(__("Enter the email or the mobile number of the account."));
				this.send_reset($(e.currentTarget), identifier);
			});
		}

		send_reset($btn, identifier) {
			this.show_error("");
			return this.busy_button(
				$btn,
				__("Sending…"),
				ui
					.call("onboarding.start_password_reset", { identifier }, { silent: true })
					.then((r) => {
						this.stop_reset_watch();
						this.ctx.reset = {
							request_key: r.request_key,
							channel: r.channel,
							email: r.email,
							code: r.code,
							platform_phone: r.platform_phone,
							mobile_hint: r.mobile_hint,
							identifier,
						};
						this.set_state({ stage: "reset" });
						ui.Toast.success(r.channel === "whatsapp" ? __("Send the code shown from your WhatsApp.") : __("A recovery code was sent."));
					})
					.catch((err) => this.show_error(err.message))
			);
		}

		/** WhatsApp recovery: the reply confirms the request; poll until it does. */
		/** WhatsApp recovery: the person's message confirms the request; poll, then move on. */
		/** The reset is confirmed by the same call as a sign-up (services/onboarding.start_password_reset). */
		watch_reset() {
			this.stop_reset_watch();
			const confirmed = (status) => {
				const reset = this.ctx.reset;
				if (reset && !reset.verified && (status === "Verified" || status === "Completed")) this.reset_verified();
			};
			this._stop_reset_listen = ui.listen(
				"wa:signup:status",
				(data) => {
					const reset = this.ctx.reset;
					if (data && reset && data.request_key === reset.request_key) confirmed(data.status);
				},
				{
					on_connect: () => {
						const reset = this.ctx.reset;
						if (!reset || reset.verified) return;
						ui.call("onboarding.get_password_reset_status", { request_key: reset.request_key }, { silent: true })
							.then((r) => confirmed(r && r.status))
							.catch(() => {});
					},
				}
			);
		}

		stop_reset_watch() {
			if (this._stop_reset_listen) this._stop_reset_listen();
			this._stop_reset_listen = null;
		}

		// =============================================================================================
		// Ready to work — and, under it, connecting this site
		// =============================================================================================

		/**
		 * The prototype's last panel, and the end of this screen: the tick, the plan, the free
		 * month, and the invite card with the customer's own referral coupon. Nothing follows it —
		 * connecting the site to the platform is not part of signing up and is not drawn here.
		 */
		card_ready() {
			// a sign-in to another account: what the previous one left is decided here, never deleted silently
			whatsapp_next.account_switch.check({ force: true });
			const plan = this.plan_label();
			const org = this.f.org;
			const $card = this.card("ready");
			$card.append(`
				<span class="wa-onb__ready-mark">${ico("tick", "lg")}</span>
				<h2 class="wa-onb__ready-title">${esc(__("Your account is ready"))}</h2>
				<p class="wa-onb__ready-sub">${esc(org ? __("The account «{0}» is active on the {1} plan. You can link devices and send your first message.", [org, plan]) : __("This site's account is active on the {0} plan.", [plan]))}</p>

				<div class="wa-onb__ready-note">
					<span class="wa-onb__ready-note-mark">${ico("card", "sm")}</span>
					<span class="wa-onb__ready-note-text">
						<b>${esc(__("Your first month is free, no card needed"))}</b>
						<span>${esc(__("No card. You can upgrade or stop at any time from the subscription page."))}</span>
					</span>
				</div>

				<div class="wa-onb__invite">
					<span class="wa-onb__invite-head">
						<span class="wa-onb__invite-mark">${ico("send", "sm")}</span>
						<b>${esc(__("Share and get an extra free month"))}</b>
					</span>
					<p class="wa-onb__invite-body">${esc(__("Send your coupon to any company you know: they start their subscription with a free month, and a free month is added to yours for every company that activates with your coupon — with no limit on invitations."))}</p>
					<div data-slot="referral">${ui.skeleton(1, { lines: 1 })}</div>
					<p class="wa-onb__invite-note">${esc(__("The free month is added to your balance as soon as the invited account is activated, and shows on the subscription page."))}</p>
				</div>

				${ui.btn({ label: __("Go to the dashboard"), variant: "primary", block: true, attrs: { "data-act": "home" } })}
				${can_setup() ? ui.btn({ label: __("Sign in with another account"), variant: "ghost", block: true, attrs: { "data-act": "switch" } }) : ""}
				${can_setup() ? ui.btn({ label: __("Sign out"), variant: "ghost", block: true, attrs: { "data-act": "sign-out" } }) : ""}`);

			$card.on("click", '[data-act="home"]', () => frappe.set_route("wa-home"));
			$card.on("click", '[data-act="switch"]', () => this.switch_account());
			$card.on("click", '[data-act="sign-out"]', () => this.sign_out());
			this.load_referral($card);
			this.mark_setup_complete();
		}

		/**
		 * Sign this site out of its platform account (`onboarding.sign_out`): its keys and webhook
		 * secret are deleted, so nothing is sent or received until it signs in again; devices,
		 * messages and everything set up on the site stay. The product's screens then send everyone
		 * back to this page until it is linked again.
		 */
		sign_out() {
			return ui.ConfirmDialog.ask({
				title: __("Sign out of the WhatsApp account?"),
				message: __("This site stops sending and receiving WhatsApp messages until it signs in again. Devices, messages and what you set up stay on the site."),
				confirm_label: __("Sign out"),
				danger: true,
				on_confirm: () => ui.call("onboarding.sign_out", {}, { freeze: true }),
			}).then(
				() => {
					// every screen of the product sends back here until the site signs in again
					frappe.boot.whatsapp_next = Object.assign({}, frappe.boot.whatsapp_next || {}, { setup_redirect: true });
					ui.Toast.success(__("Signed out of the WhatsApp account"));
					this.f.login_id = "";
					this.set_state({ stage: "login", switching: false, err: "" });
				},
				() => null
			);
		}

		/**
		 * Link this site to another platform account (owner, 2026-10-10): the sign-in card, with a
		 * way back. Nothing is deleted when the other account signs in (D-145): the previous
		 * account's devices are switched off, and a System Manager is then asked whether to delete
		 * what it left or keep it (`account_switch.js`). A backup can be downloaded first.
		 */
		switch_account() {
			const dialog = new frappe.ui.Dialog({
				title: __("Sign in with another account?"),
				size: "small",
				fields: [{ fieldtype: "HTML", fieldname: "body" }],
				primary_action_label: __("Continue to sign in"),
				primary_action: () => {
					dialog.hide();
					this.f.login_id = "";
					this.set_state({ stage: "login", switching: true });
				},
				secondary_action_label: __("Cancel"),
				secondary_action: () => dialog.hide(),
			});
			// kept by reference: the sign-in waits on it while a backup downloads
			const $go = dialog.get_primary_btn();
			const $body = dialog.fields_dict.body.$wrapper;
			$body.html(`
				<div class="wa-onb__switch">
					<p>${esc(__("This site will work with the account you sign in with. Nothing is deleted when you sign in: the current account's devices are switched off, and its messages, queue and WhatsApp numbers stay on this site."))}</p>
					<p>${esc(__("Afterwards this site asks whether to delete what the previous account left or keep it. Templates, document notifications, alerts, commands and contact groups always stay."))}</p>
					<div class="wa-onb__switch-backup">
						<span>${esc(__("Keep a copy of what this site set up before you continue."))}</span>
						${ui.btn({ label: __("Download a backup"), variant: "secondary", size: "sm", attrs: { "data-act": "backup" } })}
					</div>
				</div>`);
			// continuing while the backup is still being prepared would leave without it: the
			// sign-in waits until the file is saved (or the download failed)
			$body.on("click", '[data-act="backup"]', (e) => {
				$go.prop("disabled", true);
				whatsapp_next.backup
					.download($(e.currentTarget))
					.catch((err) => ui.Toast.error(err))
					.finally(() => $go.prop("disabled", false));
			});

			dialog.show();
		}

		/**
		 * `WhatsApp Settings.setup_completed` is the site's record that setup is finished (R-042:
		 * no screen ever set it, so the flag stayed empty on working sites). The ready panel is
		 * where setup ends, so it is set here — only once all four steps are really done
		 * (`onboarding.complete_setup` checks them again and refuses otherwise). Right after a
		 * sign-up no device is paired yet; Home sets it later, the first time a System Manager
		 * opens it with every step done. Quiet: nothing on this panel depends on it.
		 */
		mark_setup_complete() {
			const status = this.status || {};
			const steps = status.steps || [];
			if (status.setup_completed || !steps.length || !steps.every((s) => s.done)) return;
			ui.call("onboarding.complete_setup", {}, { silent: true })
				.then(() => (status.setup_completed = true))
				.catch(() => {});
		}

		/** The customer's own coupon, from the platform. Nothing about it is invented here. */
		load_referral($card) {
			const $slot = $card.find('[data-slot="referral"]');
			return ui
				.call("onboarding.get_referral_coupon", {}, { silent: true })
				.then((r) => {
					const coupon = (r && r.coupon) || {};
					const code = coupon.code || "";
					if (!code) {
						$slot.html(strip_html("warn", __("No invite coupon has been issued for this account yet.")));
						return;
					}
					const link = coupon.share_url || coupon.url || "";
					const message = link
						? __("Try WhatsappNext for your company's WhatsApp messages — use coupon {0} for a free month: {1}", [code, link])
						: __("Try WhatsappNext for your company's WhatsApp messages — use coupon {0} for a free month.", [code]);
					$slot.html(`
						<div class="wa-onb__invite-row">
							<span class="wa-onb__invite-slot">
								<span class="wa-onb__invite-k">${esc(__("Invite coupon"))}</span>
								<span class="wa-onb__invite-code" dir="ltr">${esc(code)}</span>
								${ui.btn({ label: __("Copy"), icon: "copy", variant: "primary", size: "sm", attrs: { "data-act": "copy-code" } })}
							</span>
							<a class="wa-btn wa-btn--primary wa-btn--sm" href="${esc(`https://wa.me/?text=${encodeURIComponent(message)}`)}" target="_blank" rel="noopener">${ico("whatsapp", "sm")}<span>${esc(__("Share on WhatsApp"))}</span></a>
						</div>`);
					const flash = ($b, text) => {
						const $l = $b.find("span").last();
						const before = $l.text();
						$l.text(text);
						window.setTimeout(() => $l.text(before), 1800);
					};
					$slot.on("click", '[data-act="copy-code"]', (e) =>
						copy_to_clipboard(code)
							.then(() => flash($(e.currentTarget), __("Copied")))
							.catch(() => ui.Toast.warning(__("The browser did not allow copying. Select the code and copy it by hand.")))
					);
				})
				.catch((err) => $slot.html(strip_html("danger", err.message, { role: "alert" })));
		}

		// ---- housekeeping -----------------------------------------------------------------------------

		stop_timers() {
			if (this._tick) window.clearInterval(this._tick);
			this._tick = null;
		}

		unbind() {
			this.stop_timers();
			this.stop_signup_watch();
			this.stop_reset_watch();
			this.unbind_sector();
		}

		unbind_sector() {
			if (this.on_doc_down) document.removeEventListener("mousedown", this.on_doc_down);
			if (this.on_doc_esc) document.removeEventListener("keydown", this.on_doc_esc, true);
			this.on_doc_down = null;
			this.on_doc_esc = null;
		}
	}

	whatsapp_next.onboarding.OnboardingScreen = OnboardingScreen;

	// The screen is exactly as tall as what scrolls it (owner, 2026-10-26: a gap under it, over and
	// over). `100dvh` is the window, not Desk's `.main-section`: a horizontal scrollbar, a banner or
	// a zoom made them differ, and a strip of the page under the panel showed — or the page
	// overflowed and opened scrolled down from the screen before it. The scroller's own height is
	// measured instead (`--wa-onb-h`, read in `_onboarding.scss` and `_shell.scss`), kept on resize,
	// and every show starts at the top.
	function fit_to_scroller(wrapper) {
		const scroller = $(wrapper).closest(".main-section")[0] || document.scrollingElement;
		const set = () => wrapper.style.setProperty("--wa-onb-h", `${scroller.clientHeight}px`);
		set();
		scroller.scrollTop = 0;
		if (!wrapper._wa_fit && typeof ResizeObserver === "function") {
			wrapper._wa_fit = new ResizeObserver(set);
			wrapper._wa_fit.observe(scroller);
		}
	}

	frappe.pages["wa-onboarding"].on_page_load = function (wrapper) {
		const page = frappe.ui.make_app_page({
			parent: wrapper,
			title: __("WhatsApp setup"),
			single_column: true,
		});
		wrapper.wa_onboarding = new OnboardingScreen({ page, wrapper });
		fit_to_scroller(wrapper);
	};

	// Leaving the page stops its timers and polls (`unbind` on "hide"); coming back re-reads where
	// the site stands and redraws, which restarts the countdown, the sign-up / recovery watch and
	// the activity picker's listeners. Without it a return to the confirmation step sat on a
	// frozen timer and never noticed the confirming message, and an account linked meanwhile (in
	// Settings, or another tab) still showed the sign-up form.
	frappe.pages["wa-onboarding"].on_page_show = function (wrapper) {
		fit_to_scroller(wrapper);
		const screen = wrapper.wa_onboarding;
		if (!screen) return;
		if (!screen._shown) {
			screen._shown = true; // the first show follows `on_page_load`, which already loaded
			return;
		}
		screen.load();
	};
})();

// PARKED — not loaded, not wired, kept so it can be picked up when it has a home.
//
// This is the "connect this site" half of the old setup screen: the platform credentials and the
// connection test, linking the first device (QR or 8-digit code, with the realtime watch), and
// registering the webhook. It was lifted out of `wa_onboarding.js` unchanged when the owner ruled
// that the setup screen is the prototype's three panels and nothing else — بيانات الحساب ·
// الشروط والأحكام · تفعيل الحساب — ending at "جاهز للعمل".
//
// Frappe serves exactly one script per page (`core/doctype/page/page.py` reads `<page_name>.js`,
// `<page_name>.css`, any `.html` in the folder as a template, and the `page_js` hooks), so this
// file sits beside the page without ever being sent to the browser. Nothing imports it.
//
// It still speaks the API it always did — `onboarding.save_credentials`,
// `settings.test_connection`, `settings.setup_webhook`, `devices.list_devices`,
// `devices.create_device`, `devices.start_pairing`, `devices.poll_status` and the
// `wa:device:status` realtime event — and it is written against the product's control layer
// (`ui.btn`, `ui.badge`, `ui.segmented`, `ui.ico`, `.wa-input`, `.wa-card`, `.wa-sunken`) and the
// `--wa-*` palette, so wherever it lands it will look like the rest of the product.
//
// To re-mount it: `Object.assign(HostScreen.prototype, Object.getOwnPropertyDescriptors(
// SiteSetup.prototype))`, or simply move the methods back. The host must provide `card(size, o)`,
// `show_error`, `busy_button`, `set_state`, `status`, `ctx`, `step_done`, `step_detail`,
// `render`, `render_flow` and `checklist`, plus `strip_html`, `field_html` and
// `copy_to_clipboard` in module scope — all of which `wa_onboarding.js` still has except
// `checklist`, which went with this code.
//
// The styles these markups use (`.wa-onb__device*`, `__pair*`, `__pin`, `__qr`, `__raw`, `__kv*`,
// `__checklist`, `__check*`) were removed from `screens/_onboarding.scss` in the same commit and
// have to come back with the markup.

/* eslint-disable */

export class SiteSetup {
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
}

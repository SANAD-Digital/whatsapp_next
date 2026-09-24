// Module role: the Devices screen (spec §2 row 3, matrix row 3) — the product screen for the
// device fleet. One card per device: live status, the 30-day traffic read from
// `devices.get_device_stats`, the pairing flow (QR image or 8-digit code with an expiry
// countdown) and the lifecycle actions, each one calling `api.v1.devices` through
// `sanad.ui.call`. No business logic lives here; the native `WhatsApp Device` list stays as
// the read fallback.

frappe.provide("whatsapp_next.devices");

(() => {
	const ui = sanad.ui;
	const MANAGER = ["WhatsApp Manager", "System Manager"];
	const AGENT_UP = ["WhatsApp Agent", "WhatsApp Manager", "System Manager"];
	const OFFLINE = ["Disconnected", "Logged Out"];
	const STATS_DAYS = 30;
	const POLL_MS = 4000;

	const is_manager = () => frappe.user.has_role(MANAGER);
	const is_agent = () => frappe.user.has_role(AGENT_UP);

	// Tones follow matrix §6: Connected green · Pending QR blue · Disconnected amber · Logged Out red.
	const STATUS = {
		Connected: { tone: "green", label: () => __("Connected") },
		"Pending QR": { tone: "blue", label: () => __("Not paired") },
		Disconnected: { tone: "amber", label: () => __("Disconnected") },
		"Logged Out": { tone: "red", label: () => __("Signed out") },
	};
	const status_of = (row) => STATUS[row.status] || { tone: "gray", label: () => __("Unknown") };
	const ago = (value) => (value ? frappe.datetime.prettyDate(value) : null);
	const percent = (rate) => `${(Number(rate || 0) * 100).toFixed(1)}%`;

	/** Two letters for the card's avatar: one per word, or the first two of a single word. */
	function initials(name) {
		const words = String(name || "").trim().split(/\s+/).filter(Boolean);
		if (!words.length) return "؟";
		if (words.length === 1) return words[0].slice(0, 2);
		return words[0][0] + words[1][0];
	}

	/** Overflow menu next to a card's status, drawn with the kit's menu styles. */
	function open_menu($btn, items) {
		close_menu();
		const $menu = $(`<div class="sanad-kit sanad-rowactions__menu" role="menu" aria-label="${ui.escape(__("Device actions"))}"></div>`);
		items.forEach((item) => {
			$(`<button type="button" class="sanad-rowactions__item${item.danger ? " sanad-rowactions__item--danger" : ""}" role="menuitem" tabindex="-1">${item.icon ? `<span class="sanad-rowactions__icon" aria-hidden="true">${ui.icon(item.icon, "sm")}</span>` : ""}<span>${ui.escape(item.label)}</span></button>`)
				.on("click", (e) => {
					e.preventDefault();
					close_menu(true);
					Promise.resolve(item.handler()).catch((err) => {
						if (err && err.message) ui.Toast.error(err);
					});
				})
				.appendTo($menu);
		});
		$menu.appendTo(document.body);
		const rect = $btn[0].getBoundingClientRect();
		const w = $menu.outerWidth();
		const h = $menu.outerHeight();
		let x = ui.is_rtl() ? rect.left : rect.right - w;
		x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
		let y = rect.bottom + 4;
		if (y + h > window.innerHeight - 8) y = Math.max(8, rect.top - h - 4);
		const tx = ui.is_rtl() ? -(window.innerWidth - (x + w)) : x;
		$menu[0].style.setProperty("--sanad-menu-x", `${Math.round(tx)}px`);
		$menu[0].style.setProperty("--sanad-menu-y", `${Math.round(y)}px`);
		$btn.attr("aria-expanded", "true");
		open_menu.current = { $menu, $btn };
		$menu.on("keydown", (e) => {
			const nodes = $menu.find('[role="menuitem"]').toArray();
			const i = nodes.indexOf(document.activeElement);
			if (e.key === "Escape") {
				e.preventDefault();
				close_menu(true);
			} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				const next = e.key === "ArrowDown" ? (i + 1) % nodes.length : (i - 1 + nodes.length) % nodes.length;
				nodes[next] && nodes[next].focus();
			}
		});
		window.setTimeout(() => {
			$(document).on("mousedown.wadevmenu", (e) => {
				if (!$(e.target).closest(".sanad-rowactions__menu").length) close_menu();
			});
			$(window).on("resize.wadevmenu scroll.wadevmenu", () => close_menu());
		}, 0);
		$menu.find('[role="menuitem"]').first().attr("tabindex", "0").trigger("focus");
	}

	/**
	 * Arrow-key navigation and a roving tabindex over `[role="radio"]` children, so a radio group
	 * behaves the way a screen reader and a keyboard user expect (WCAG 2.1.1 / 4.1.2).
	 */
	function bind_radio_group($group, on_pick) {
		const nodes = () => $group.find('[role="radio"]').toArray();
		const focus_at = (i) => {
			const items = nodes();
			const next = items[(i + items.length) % items.length];
			items.forEach((el) => el.setAttribute("tabindex", el === next ? "0" : "-1"));
			next.focus();
			on_pick && on_pick($(next));
		};
		const sync = () => {
			const items = nodes();
			const checked = items.find((el) => el.getAttribute("aria-checked") === "true") || items[0];
			items.forEach((el) => el.setAttribute("tabindex", el === checked ? "0" : "-1"));
		};
		$group.on("keydown", '[role="radio"]', (e) => {
			const items = nodes();
			const i = items.indexOf(e.currentTarget);
			if (["ArrowRight", "ArrowDown"].includes(e.key)) {
				e.preventDefault();
				focus_at(i + 1);
			} else if (["ArrowLeft", "ArrowUp"].includes(e.key)) {
				e.preventDefault();
				focus_at(i - 1);
			}
		});
		$group.on("click", '[role="radio"]', sync);
		sync();
		return sync;
	}

	function close_menu(restore_focus) {
		const current = open_menu.current;
		if (!current) return;
		current.$menu.remove();
		current.$btn.attr("aria-expanded", "false");
		if (restore_focus) current.$btn.trigger("focus");
		open_menu.current = null;
		$(document).off(".wadevmenu");
		$(window).off(".wadevmenu");
	}

	// -------------------------------------------------------------------------------------------
	// Pairing — the prototype's three steps (name the device · scan the code · paired), as a
	// Stepper inside a Desk dialog. Reads `devices.create_device`, `start_pairing`, `poll_status`
	// and the `wa:device:status` event; the payload is never stored (60 s server cache).
	// -------------------------------------------------------------------------------------------
	class PairingDialog {
		/** @param {{device?: string, device_name?: string, on_done?: Function}} opts */
		constructor(opts = {}) {
			this.opts = opts;
			this.ctx = {
				device: opts.device || null,
				device_name: opts.device_name || "",
				mode: "QR",
				phone: null,
				paired: false,
			};
		}

		show() {
			const repair = !!this.ctx.device;
			this.dialog = new frappe.ui.Dialog({
				title: repair ? __("Pair {0}", [this.ctx.device_name]) : __("Add a device"),
				size: "large",
			});
			this.dialog.$wrapper.addClass("sanad-sheet wa-pairing-dialog");
			this.dialog.onhide = () => this.destroy();
			const $body = $(this.dialog.body).empty();
			$(`<p class="wa-pairing__lead">${ui.escape(__("Three steps: name the device, scan the code from WhatsApp, then start sending."))}</p>`).appendTo($body);
			const $mount = $('<div class="wa-pairing"></div>').appendTo($body);
			const steps = [];
			if (!repair) steps.push(this.step_name());
			steps.push(this.step_pair(), this.step_done());
			this.stepper = new ui.Stepper({
				wrapper: $mount,
				ctx: this.ctx,
				steps,
				next_label: __("Next"),
				finish_label: __("Close"),
				cancel_label: __("Cancel"),
				on_cancel: () => this.dialog.hide(),
				on_finish: () => {
					this.dialog.hide();
					return Promise.resolve(this.opts.on_done && this.opts.on_done(this.ctx));
				},
			});
			this.dialog.show();
			return this;
		}

		// ---- step 1: the device's name and how it pairs -----------------------------------------

		step_name() {
			return {
				key: "name",
				label: __("Device"),
				render: ($body, ctx) => {
					$body.html(`
						<p class="wa-pairing__hint">${ui.escape(__("The name appears in the message log and wherever a device is chosen. The WhatsApp number is read automatically once the device is paired."))}</p>
						<div class="wa-pairing__field" data-slot="name"></div>
						<div class="wa-pairing__field">
							<span class="wa-pairing__label" id="wa-pair-mode">${ui.escape(__("Pairing method"))}</span>
							<div class="sanad-chip-row" role="radiogroup" aria-labelledby="wa-pair-mode" data-slot="mode"></div>
						</div>
						<div class="wa-pairing__field" data-slot="phone" hidden></div>`);
					this.name_control = frappe.ui.form.make_control({
						parent: $body.find('[data-slot="name"]'),
						df: {
							fieldtype: "Data",
							label: __("Device name"),
							fieldname: "device_name",
							reqd: 1,
							placeholder: __("e.g. Sales device"),
						},
						render_input: true,
					});
					this.name_control.set_value(ctx.device_name || "");
					const $modes = $body.find('[data-slot="mode"]');
					const $phone = $body.find('[data-slot="phone"]');
					const $mode_hint = $('<p class="wa-pairing__mode-hint" id="wa-pair-mode-hint"></p>').insertAfter($modes);
					const MODES = [
						{ value: "QR", label: __("QR code"), hint: __("The phone scans a code shown on this screen. Fastest way in.") },
						{ value: "Code", label: __("8-digit code"), hint: __("WhatsApp asks for an 8-digit code on the phone — no camera needed.") },
					];
					$modes.attr("aria-describedby", "wa-pair-mode-hint");
					MODES.forEach((mode) => {
						$(`<button type="button" class="sanad-chip" role="radio" aria-checked="${ctx.mode === mode.value}" data-mode="${mode.value}">${ui.escape(mode.label)}</button>`)
							.on("click", () => {
								ctx.mode = mode.value;
								$modes.find("[data-mode]").attr("aria-checked", "false");
								$modes.find(`[data-mode="${mode.value}"]`).attr("aria-checked", "true");
								$phone.attr("hidden", ctx.mode !== "Code" ? true : null);
								$mode_hint.text(mode.hint);
							})
							.appendTo($modes);
					});
					$mode_hint.text((MODES.find((m) => m.value === ctx.mode) || MODES[0]).hint);
					bind_radio_group($modes, ($btn) => $btn.trigger("click"));
					this.phone_field = new ui.PhoneField({
						wrapper: $phone,
						label: __("WhatsApp number"),
						required: true,
						on_change: ({ phone_e164, valid }) => {
							ctx.phone = valid ? phone_e164 : null;
						},
					});
				},
				validate: (ctx) => {
					const name = (this.name_control.get_value() || "").trim();
					if (!name) return __("Name the device first.");
					if (ctx.mode === "Code" && !ctx.phone) {
						return __("Enter the WhatsApp number that will receive the 8-digit code.");
					}
					ctx.device_name = name;
					return ui
						.call("devices.create_device", {
							device_name: name,
							phone: ctx.mode === "Code" ? ctx.phone : null,
							pairing_mode: ctx.mode,
						})
						.then((r) => {
							ctx.device = r.name;
							return true;
						});
				},
			};
		}

		// ---- step 2: the code, its countdown and the live status --------------------------------

		step_pair() {
			return {
				key: "pair",
				label: __("Pair"),
				render: ($body) => {
					this.$pair = $body;
				},
				on_show: () => this.start_pairing(),
				validate: (ctx) => {
					if (ctx.paired) return true;
					return ui
						.call("devices.poll_status", { device: ctx.device })
						.then((r) => (r.status === "Connected" ? true : __("The device is not paired yet. Scan the code with WhatsApp on the phone.")));
				},
			};
		}

		start_pairing() {
			const $el = this.$pair.empty();
			this.stop_watch();
			const state = new ui.EmptyState({ wrapper: $el, state: "loading", rows: 2 });
			return ui
				.call("devices.start_pairing", { device: this.ctx.device, mode: this.ctx.mode })
				.then((payload) => {
					this.render_pairing($el, payload || {});
					this.watch();
				})
				.catch((err) =>
					state.error(err, {
						action: { label: __("Try again"), on_click: () => this.start_pairing() },
					})
				);
		}

		render_pairing($el, payload) {
			const qr = payload.qr_code || "";
			const is_image = /^(data:image|https?:)/.test(qr);
			const steps =
				this.ctx.mode === "Code"
					? [__("Open WhatsApp on the phone."), __("Menu → Linked devices → Link a device."), __("Choose “Link with phone number” and enter the code.")]
					: [__("Open WhatsApp on the phone."), __("Menu → Linked devices → Link a device."), __("Point the camera at the code below.")];
			$el.html(`
				<div class="wa-pairing__grid">
					<div class="wa-pairing__code" data-slot="code"></div>
					<div class="wa-pairing__how">
						<ol class="wa-pairing__steps">${steps.map((s) => `<li>${ui.escape(s)}</li>`).join("")}</ol>
						<p class="wa-pairing__status sanad-tone--amber" data-slot="countdown"></p>
					</div>
				</div>`);
			const $code = $el.find('[data-slot="code"]');
			if (this.ctx.mode === "Code" && payload.pair_code) {
				$code.html(`<span class="wa-pairing__pin sanad-tabular" dir="ltr">${ui.escape(payload.pair_code)}</span><span class="wa-pairing__caption">${ui.escape(__("Enter this code on the phone."))}</span>`);
			} else if (is_image) {
				$code.html(`<img class="wa-pairing__qr" src="${ui.escape(qr)}" alt="${ui.escape(__("QR code — scan it with WhatsApp on the phone"))}">`);
			} else if (qr) {
				$code.html(`<code class="wa-pairing__raw" dir="ltr">${ui.escape(qr)}</code><span class="wa-pairing__caption">${ui.escape(__("Copy this value into a QR reader."))}</span>`);
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
						.append(
							$(`<button type="button" class="btn btn-default btn-xs">${ui.escape(__("Get a new code"))}</button>`).on("click", () => this.start_pairing())
						);
					ui.announce(__("The pairing code expired."));
					return;
				}
				$el.html(`<span class="wa-pairing__dot" aria-hidden="true"></span><span>${ui.escape(__("Waiting for the scan · the code expires in {0} s", [left]))}</span>`);
				left -= 1;
			};
			window.clearInterval(this._countdown);
			tick();
			this._countdown = window.setInterval(tick, 1000);
		}

		watch() {
			this.stop_watch(true);
			this._poll = window.setInterval(() => {
				if (document.hidden) return;
				ui.call("devices.poll_status", { device: this.ctx.device }, { silent: true })
					.then((r) => this.apply_status(r && r.status))
					.catch(() => {});
			}, POLL_MS);
			this._realtime = (data) => {
				if (data && data.device === this.ctx.device) this.apply_status(data.status);
			};
			frappe.realtime.on("wa:device:status", this._realtime);
		}

		stop_watch(keep_countdown) {
			if (this._poll) window.clearInterval(this._poll);
			this._poll = null;
			if (!keep_countdown && this._countdown) window.clearInterval(this._countdown);
			if (this._realtime) frappe.realtime.off("wa:device:status", this._realtime);
			this._realtime = null;
		}

		apply_status(status) {
			if (status !== "Connected" || this.ctx.paired) return;
			this.ctx.paired = true;
			this.stop_watch();
			ui.announce(__("The device is paired."), { assertive: true });
			this.stepper.set_step_valid(true);
			this.stepper.go(this.stepper.steps.length - 1);
		}

		// ---- step 3: paired ---------------------------------------------------------------------

		step_done() {
			return {
				key: "done",
				label: __("Done"),
				render: ($body) => {
					this.$done = $body;
				},
				on_show: () => this.render_done(),
			};
		}

		render_done() {
			const $el = this.$done.empty();
			const state = new ui.EmptyState({ wrapper: $el, state: "loading", rows: 1 });
			return ui
				.call("devices.list_devices")
				.then((r) => {
					const row = (r.rows || []).find((d) => d.name === this.ctx.device) || {};
					const number = row.phone_e164 ? ui.PhoneField.format_display(row.phone_e164) : __("Not read yet");
					$el.html(`
						<div class="wa-pairing__done">
							<span class="wa-pairing__done-icon sanad-tone--green" aria-hidden="true">${ui.icon("es-line-success", "lg")}</span>
							<h3 class="wa-pairing__done-title">${ui.escape(__("The device is paired"))}</h3>
							<p class="wa-pairing__done-sub">${ui.escape(__("It can now be chosen in templates, campaigns and quick sends."))}</p>
							<dl class="wa-pairing__rows">
								<div><dt>${ui.escape(__("Name"))}</dt><dd>${ui.escape(row.device_name || this.ctx.device_name)}</dd></div>
								<div><dt>${ui.escape(__("Number read"))}</dt><dd class="sanad-tabular" dir="ltr">${ui.escape(number)}</dd></div>
							</dl>
						</div>`);
				})
				.catch((err) => state.error(err));
		}

		destroy() {
			this.stop_watch();
			this.stepper && this.stepper.destroy();
		}
	}

	// -------------------------------------------------------------------------------------------
	// The card — the prototype's device tile: identity, 30-day traffic, freshness and the verbs.
	// -------------------------------------------------------------------------------------------
	class DeviceCard {
		constructor(screen, row) {
			this.screen = screen;
			this.row = row;
		}

		render() {
			const row = this.row;
			const status = status_of(row);
			const offline = OFFLINE.includes(row.status);
			const pending = row.status === "Pending QR";
			this.$el = $(`
				<article class="wa-device${offline ? " wa-device--offline" : ""}${row.status === "Logged Out" ? " wa-device--signed-out" : ""}" data-device="${ui.escape(row.name)}" aria-label="${ui.escape(row.device_name || row.name)}">
					<header class="wa-device__head">
						<span class="wa-device__avatar sanad-tone--${status.tone}" aria-hidden="true">${ui.escape(initials(row.device_name))}</span>
						<span class="wa-device__name" title="${ui.escape(row.device_name || row.name)}">${ui.escape(row.device_name || row.name)}</span>
						<span class="wa-device__phone sanad-tabular" dir="ltr" title="${ui.escape(row.phone_e164 || "")}">${ui.escape(row.phone_e164 ? ui.PhoneField.format_display(row.phone_e164) : __("No number yet"))}</span>
						<span class="wa-device__flags" data-slot="flags"></span>
					</header>
					<div class="wa-device__tiles" data-slot="tiles"></div>
					<div class="wa-device__meta" data-slot="meta"></div>
					<footer class="wa-device__actions" data-slot="actions"></footer>
				</article>`);
			this.render_flags();
			this.render_tiles();
			this.render_meta();
			if (pending) this.render_notice();
			this.render_actions();
			return this.$el;
		}

		render_flags() {
			const row = this.row;
			const status = status_of(row);
			const $flags = this.$el.find('[data-slot="flags"]');
			$flags.append(ui.StatusBadge.html({ label: status.label(), colour: status.tone }));
			if (row.is_default) {
				$flags.append(`<span class="wa-device__flag sanad-tone--gray">${ui.escape(__("Default"))}</span>`);
			}
			if (row.disabled) {
				$flags.append(`<span class="wa-device__flag sanad-tone--gray">${ui.escape(__("Disabled"))}</span>`);
			}
			const items = this.menu_items();
			if (!items.length) return;
			$(`<button type="button" class="btn btn-xs btn-default wa-device__more" aria-haspopup="menu" aria-expanded="false" aria-label="${ui.escape(__("Actions for {0}", [row.device_name || row.name]))}">${ui.icon(ui.icons.more, "sm")}</button>`)
				.on("click", (e) => open_menu($(e.currentTarget), this.menu_items()))
				.appendTo($flags);
		}

		menu_items() {
			const row = this.row;
			const screen = this.screen;
			const items = [];
			if (is_agent()) {
				items.push({
					label: __("Check status now"),
					icon: "es-line-reload",
					handler: () => screen.poll(row),
				});
			}
			if (!is_manager()) return items;
			if (!row.is_default) {
				items.push({
					label: __("Make it the default device"),
					icon: "es-line-star",
					handler: () => screen.set_default(row),
				});
			}
			items.push({
				label: row.disabled ? __("Enable sending") : __("Pause sending from this device"),
				icon: row.disabled ? "es-line-success" : "es-line-slash",
				handler: () => screen.set_disabled(row, !row.disabled),
			});
			return items;
		}

		render_tiles() {
			const $tiles = this.$el.find('[data-slot="tiles"]');
			const title = this.row.device_name || this.row.name;
			const tiles = [
				{
					key: "sent",
					label: __("Sent ({0}d)", [STATS_DAYS]),
					route: {},
					name: __("Open the outbound log of {0}", [title]),
				},
				{
					key: "failed",
					label: __("Failures"),
					route: { status: "Failed" },
					name: __("Open the failed messages of {0}", [title]),
				},
				{ key: "rate", label: __("Failure rate") },
			];
			tiles.forEach((tile) => {
				const clickable = !!tile.route;
				const tag = clickable ? "button" : "span";
				const $tile = $(`<${tag} class="wa-device__tile" data-tile="${tile.key}"${clickable ? ` type="button" aria-label="${ui.escape(tile.name)}" title="${ui.escape(tile.name)}"` : ""}><span class="wa-device__tile-label">${ui.escape(tile.label)}</span><span class="wa-device__tile-value sanad-tabular" data-slot="value">${ui.skeleton(1, { lines: 1 })}</span></${tag}>`);
				if (clickable) {
					$tile.on("click", () =>
						frappe.set_route("List", "WhatsApp Log", Object.assign({ device: this.row.name }, tile.route))
					);
				}
				$tiles.append($tile);
			});
		}

		/** Fill the three tiles and the "last message" line once `get_device_stats` answers. */
		set_stats(stats) {
			if (!this.$el) return;
			const high = Number(stats.fail_rate || 0) > 0.08;
			this.$el.find('[data-tile="sent"] [data-slot="value"]').text(ui.format_int(stats.sent));
			this.$el
				.find('[data-tile="failed"] [data-slot="value"]')
				.text(ui.format_int(stats.failed))
				.toggleClass("wa-device__tile-value--alert", high);
			this.$el
				.find('[data-tile="rate"] [data-slot="value"]')
				.text(percent(stats.fail_rate))
				.toggleClass("wa-device__tile-value--alert", high);
			this.$el
				.find('[data-meta="message"] [data-slot="value"]')
				.text(stats.last_message_at ? ago(stats.last_message_at) : __("No messages"));
		}

		set_stats_error() {
			if (!this.$el) return;
			this.$el.find(".wa-device__tile [data-slot='value']").text("—");
			this.$el.find('[data-meta="message"] [data-slot="value"]').text("—");
		}

		render_meta() {
			const row = this.row;
			const offline = OFFLINE.includes(row.status);
			const since = offline ? row.disconnected_at || row.logged_out_at || row.last_seen : row.last_seen;
			const pairs = [
				{
					key: "seen",
					label: offline ? __("Offline since") : __("Last seen"),
					value: ago(since) || __("Never"),
					alert: offline,
				},
				{ key: "message", label: __("Last message"), value: ui.skeleton(1, { lines: 1 }), html: true },
			];
			const $meta = this.$el.find('[data-slot="meta"]');
			pairs.forEach((pair) => {
				const $pair = $(`<div class="wa-device__meta-item" data-meta="${pair.key}"><span class="wa-device__meta-label">${ui.escape(pair.label)}</span><span class="wa-device__meta-value${pair.alert ? " wa-device__meta-value--alert" : ""}" data-slot="value"></span></div>`);
				if (pair.html) $pair.find('[data-slot="value"]').html(pair.value);
				else $pair.find('[data-slot="value"]').text(pair.value);
				$meta.append($pair);
			});
		}

		render_notice() {
			$(`<div class="wa-device__notice sanad-tone--blue" role="status"><span class="wa-device__notice-icon" aria-hidden="true">${ui.icon("es-line-alert-circle", "sm")}</span><span class="wa-device__notice-text"><b>${ui.escape(__("The code has not been scanned yet"))}</b><span>${ui.escape(__("Open pairing again to scan a fresh code."))}</span></span></div>`).insertBefore(this.$el.find('[data-slot="actions"]'));
		}

		render_actions() {
			const row = this.row;
			const screen = this.screen;
			const connected = row.status === "Connected";
			const pending = row.status === "Pending QR";
			const actions = [];
			if (is_manager()) {
				actions.push(
					connected
						? { label: __("Disconnect"), handler: () => screen.disconnect(row) }
						: {
								label: pending ? __("Show code") : __("Pair again"),
								primary: true,
								handler: () => screen.pair(row),
						  }
				);
			}
			actions.push(
				{ label: __("Outbound"), handler: () => frappe.set_route("List", "WhatsApp Log", { device: row.name }) },
				{ label: __("Inbound"), handler: () => frappe.set_route("List", "WhatsApp Inbound Message", { device: row.name }) }
			);
			if (is_manager()) {
				actions.push({ label: __("Delete"), danger: true, handler: () => screen.remove(row) });
			}
			const $actions = this.$el.find('[data-slot="actions"]');
			actions.forEach((action) => {
				$(`<button type="button" class="btn btn-sm ${action.primary ? "btn-primary" : "btn-default"}${action.danger ? " wa-device__btn--danger" : ""}">${ui.escape(action.label)}</button>`)
					.on("click", action.handler)
					.appendTo($actions);
			});
		}
	}

	// -------------------------------------------------------------------------------------------
	// The screen
	// -------------------------------------------------------------------------------------------
	class DevicesScreen {
		constructor({ page, wrapper }) {
			this.page = page;
			this.wrapper = wrapper;
			this.filter = "all";
			this.cards = [];
			this.stats = {};
			this.$screen = $('<div class="wa-devices"></div>').appendTo(page.main);
			this.make_page_actions();
			this.header = new ui.PageHeader({
				wrapper: this.$screen,
				description: __("Every device is its own WhatsApp number. Messages are routed to one of them by the template or the campaign."),
				banner: () => this.banner(),
				blocks: [{ key: "devices", render: ($el) => this.render_block($el) }],
			});
			this.bind_realtime();
			$(wrapper).on("hide", () => this.unbind_realtime());
		}

		make_page_actions() {
			if (is_manager()) {
				this.page.set_primary_action(__("Add device"), () => this.pair(null), "add");
			}
			this.page.add_action_icon("es-line-reload", () => this.refresh({ remote: true }), "", __("Refresh from the platform"));
			// `add_action_icon` only sets a title: an icon-only control also needs a name (WCAG 4.1.2)
			this.page.icon_group.find(".icon-btn").last().attr("aria-label", __("Refresh from the platform"));
		}

		// ---- data -------------------------------------------------------------------------------

		load() {
			if (!this._rows) {
				const remote = this._remote;
				this._remote = false;
				this._rows = ui.call("devices.list_devices", remote ? { refresh: 1 } : {}).then((r) => {
					this.rows = r.rows || [];
					return this.rows;
				});
			}
			return this._rows;
		}

		stats_of(device) {
			if (!this.stats[device]) {
				this.stats[device] = ui.call("devices.get_device_stats", { device, days: STATS_DAYS });
			}
			return this.stats[device];
		}

		refresh({ remote = false } = {}) {
			this._rows = null;
			this.stats = {};
			this._remote = remote;
			return this.header.refresh();
		}

		// ---- realtime ---------------------------------------------------------------------------

		bind_realtime() {
			if (this._on_status) return;
			this._on_status = ui.throttle((data) => {
				const row = (this.rows || []).find((d) => d.name === (data && data.device));
				if (row && data.status) {
					ui.announce(__("{0} is now {1}", [row.device_name || row.name, (STATUS[data.status] || { label: () => data.status }).label()]));
				}
				this.refresh();
			}, 1500);
			frappe.realtime.on("wa:device:status", this._on_status);
		}

		unbind_realtime() {
			if (!this._on_status) return;
			frappe.realtime.off("wa:device:status", this._on_status);
			this._on_status = null;
			close_menu();
		}

		// ---- banner -----------------------------------------------------------------------------

		banner() {
			return this.load().then((rows) => {
				const offline = rows.filter((row) => OFFLINE.includes(row.status));
				if (!offline.length) return null;
				if (offline.length === 1) {
					const row = offline[0];
					const since = ago(row.disconnected_at || row.logged_out_at || row.last_seen);
					return {
						tone: "amber",
						text: since
							? __("Device {0} has been offline since {1}. Messages for it stay in the queue until it is paired again.", [row.device_name || row.name, since])
							: __("Device {0} is offline. Messages for it stay in the queue until it is paired again.", [row.device_name || row.name]),
						action: is_manager() ? { label: __("Pair again"), handler: () => this.pair(row) } : null,
					};
				}
				return {
					tone: "amber",
					text: __("{0} devices are not connected. Messages for them stay in the queue until they are paired again.", [ui.format_int(offline.length)]),
					action: { label: __("Show them"), handler: () => this.set_filter("offline") },
				};
			});
		}

		// ---- the grid ---------------------------------------------------------------------------

		render_block($el) {
			$el.empty();
			const $filters = $('<div class="wa-devices__filters sanad-chip-row" role="group" aria-label="' + ui.escape(__("Filter by status")) + '"></div>').appendTo($el);
			const $grid = $('<div class="wa-devices__grid"></div>').appendTo($el);
			const state = new ui.EmptyState({ wrapper: $grid, state: "loading", rows: 3 });
			return this.load()
				.then((rows) => {
					this.render_filters($filters, rows);
					this.render_grid($grid, rows);
				})
				.catch((err) => {
					$filters.empty();
					state.error(err, { action: { label: __("Try again"), on_click: () => this.refresh() } });
				});
		}

		counts(rows) {
			return {
				all: rows.length,
				Connected: rows.filter((r) => r.status === "Connected").length,
				"Pending QR": rows.filter((r) => r.status === "Pending QR").length,
				offline: rows.filter((r) => OFFLINE.includes(r.status)).length,
			};
		}

		render_filters($el, rows) {
			$el.empty();
			if (!rows.length) return;
			const counts = this.counts(rows);
			[
				{ key: "all", label: __("All") },
				{ key: "Connected", label: __("Connected") },
				{ key: "Pending QR", label: __("Not paired") },
				{ key: "offline", label: __("Not connected") },
			].forEach((chip) => {
				const count = counts[chip.key];
				$(`<button type="button" class="sanad-chip" aria-pressed="${this.filter === chip.key}"${count ? "" : " disabled"}><span>${ui.escape(chip.label)}</span><span class="sanad-chip__count sanad-tabular">${ui.escape(ui.format_int(count))}</span></button>`)
					.on("click", () => this.set_filter(chip.key))
					.appendTo($el);
			});
		}

		set_filter(key) {
			this.filter = key;
			this.header.refresh();
		}

		matches(row) {
			if (this.filter === "all") return true;
			if (this.filter === "offline") return OFFLINE.includes(row.status);
			return row.status === this.filter;
		}

		render_grid($grid, rows) {
			$grid.empty();
			this.cards = [];
			if (!rows.length) {
				new ui.EmptyState({
					wrapper: $grid,
					state: "empty",
					title: __("No devices yet"),
					description: __("Pair a phone to start sending. Pairing takes less than a minute."),
					action: is_manager() ? { label: __("Add device"), primary: true, on_click: () => this.pair(null) } : null,
				});
				return;
			}
			const shown = rows.filter((row) => this.matches(row));
			if (!shown.length) {
				new ui.EmptyState({
					wrapper: $grid,
					state: "empty",
					title: __("No device is in this state"),
					description: __("Choose another status, or show every device."),
					action: { label: __("Show all devices"), on_click: () => this.set_filter("all") },
				});
				return;
			}
			shown.forEach((row) => {
				const card = new DeviceCard(this, row);
				$grid.append(card.render());
				this.cards.push(card);
				this.stats_of(row.name)
					.then((stats) => card.set_stats(stats || {}))
					.catch(() => card.set_stats_error());
			});
			ui.announce(__("Showing {0} of {1} devices", [ui.format_int(shown.length), ui.format_int(rows.length)]));
		}

		// ---- actions ----------------------------------------------------------------------------

		pair(row) {
			new PairingDialog({
				device: row ? row.name : null,
				device_name: row ? row.device_name : "",
				on_done: () => this.refresh(),
			}).show();
		}

		poll(row) {
			return ui.call("devices.poll_status", { device: row.name }).then((r) => {
				const label = (STATUS[r.status] || { label: () => r.status }).label();
				ui.Toast.success(__("{0} is {1}", [row.device_name || row.name, label]));
				if (r.changed) this.refresh();
			});
		}

		set_default(row) {
			return ui.call("devices.set_default", { device: row.name }).then(() => {
				ui.Toast.success(__("{0} is the default device now", [row.device_name || row.name]));
				this.refresh();
			});
		}

		set_disabled(row, disabled) {
			return ui.call("devices.set_disabled", { device: row.name, disabled: disabled ? 1 : 0 }).then(() => {
				ui.Toast.success(
					disabled
						? __("Sending from {0} is paused", [row.device_name || row.name])
						: __("Sending from {0} is on again", [row.device_name || row.name])
				);
				this.refresh();
			});
		}

		disconnect(row) {
			const title = row.device_name || row.name;
			return ui.ConfirmDialog.ask({
				title: __("Disconnect {0}?", [title]),
				message: __("Sending from this number stops at once. Queued messages stay in the queue until the device is paired again; nothing is deleted."),
				load_impact: () =>
					Promise.all([
						frappe.db.count("WhatsApp Queue Item", { filters: { device: row.name, status: ["in", ["Queued", "Paused", "Held"]] } }),
						frappe.db.count("WhatsApp Notification", { filters: { device: row.name } }),
						frappe.db.count("WhatsApp Campaign", { filters: { device: row.name } }),
					]).then(([queued, notifications, campaigns]) => [
						{ label: __("Messages that stop being sent"), value: ui.format_int(queued), tone: "amber" },
						{ label: __("Templates bound to this device"), value: ui.format_int(notifications) },
						{ label: __("Campaigns bound to this device"), value: ui.format_int(campaigns) },
					]),
				confirm_label: __("Disconnect"),
				on_confirm: () =>
					ui.call("devices.disconnect_device", { device: row.name }).then(() => {
						ui.Toast.warning(__("{0} was disconnected", [title]), {
							action: { label: __("Pair again"), on_click: () => this.pair(row) },
						});
						this.refresh();
					}),
			}).catch(() => {});
		}

		remove(row) {
			const title = row.device_name || row.name;
			return ui.ConfirmDialog.ask({
				title: __("Delete {0}?", [title]),
				message: __("Deleting cannot be undone. The message log stays for auditing, but templates and campaigns bound to this device need another one before they work again."),
				danger: true,
				ack_checkbox: __("I understand this device will be removed from the platform."),
				load_impact: () =>
					Promise.all([
						frappe.db.count("WhatsApp Log", { filters: { device: row.name } }),
						frappe.db.count("WhatsApp Notification", { filters: { device: row.name } }),
						frappe.db.count("WhatsApp Campaign", { filters: { device: row.name } }),
					]).then(([messages, notifications, campaigns]) => [
						{ label: __("Messages kept in the log"), value: ui.format_int(messages) },
						{ label: __("Templates that lose their device"), value: ui.format_int(notifications), tone: "red" },
						{ label: __("Campaigns that stop working"), value: ui.format_int(campaigns), tone: "red" },
					]),
				confirm_label: __("Delete device"),
				on_confirm: () =>
					ui.call("devices.delete_device", { device: row.name }).then(() => {
						ui.Toast.success(__("{0} was deleted", [title]));
						this.refresh();
					}),
			}).catch(() => {});
		}
	}

	whatsapp_next.devices.DevicesScreen = DevicesScreen;
	whatsapp_next.devices.PairingDialog = PairingDialog;

	frappe.pages["wa-devices"].on_page_load = function (wrapper) {
		const page = frappe.ui.make_app_page({
			parent: wrapper,
			title: __("Devices"),
			single_column: true,
		});
		wrapper.wa_devices = new DevicesScreen({ page, wrapper });
	};

	frappe.pages["wa-devices"].on_page_show = function (wrapper) {
		if (!wrapper.wa_devices) return;
		wrapper.wa_devices.bind_realtime();
		wrapper.wa_devices.refresh();
	};
})();

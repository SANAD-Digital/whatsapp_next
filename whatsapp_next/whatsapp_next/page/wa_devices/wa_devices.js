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
	// above this share of attempts the failure reading turns red and the delivery bar with it
	const FAIL_ALERT = 0.08;

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
	// The card
	//
	// One device read top to bottom in four bands whose order never changes: who it is, what it
	// sent, how fresh it is, what you can do about it. The fixed order is what makes a wall of ten
	// cards scannable — the eye learns the shape once and afterwards only reads what moved.
	//
	// The state is never carried by colour alone (WCAG 1.4.1). A device says it three times over:
	// the rail down its inline-start edge, the ring around its avatar, and the pill that carries
	// both a dot and the word itself.
	// -------------------------------------------------------------------------------------------
	class DeviceCard {
		constructor(screen, row) {
			this.screen = screen;
			this.row = row;
		}

		render() {
			const row = this.row;
			const status = status_of(row);
			const title = row.device_name || row.name;
			const number = row.phone_e164 ? ui.PhoneField.format_display(row.phone_e164) : __("No number yet");
			this.$el = $(`
				<article class="wa-device wa-device--${status.tone}" data-device="${ui.escape(row.name)}" aria-label="${ui.escape(title)}">
					<span class="wa-device__rail" aria-hidden="true"></span>
					<header class="wa-device__head">
						<span class="wa-device__avatar" aria-hidden="true">${ui.escape(initials(row.device_name))}</span>
						<span class="wa-device__identity">
							<h3 class="wa-device__name" dir="auto" title="${ui.escape(title)}">${ui.escape(title)}</h3>
							<span class="wa-device__phone sanad-tabular" dir="ltr" title="${ui.escape(row.phone_e164 || "")}">${ui.escape(number)}</span>
						</span>
						<span class="wa-device__head-end" data-slot="more"></span>
					</header>
					<div class="wa-device__tags" data-slot="tags"></div>
					<div class="wa-device__panel" data-slot="panel"></div>
					<dl class="wa-device__meta" data-slot="meta"></dl>
					<footer class="wa-device__actions" data-slot="actions"></footer>
				</article>`);
			this.render_tags();
			this.render_panel();
			// a device still waiting for its first code has no freshness to report: "last seen" and
			// "last message" would both read "never", which says less than the notice that replaces
			// them and tells the reader what to do instead
			if (row.status === "Pending QR") this.render_notice();
			else this.render_meta();
			this.render_actions();
			return this.$el;
		}

		// ---- who it is --------------------------------------------------------------------------

		/**
		 * The state pill and the standing flags, on their own line under the name. The prototype
		 * puts the pill at the end of the name's line; at a Desk page's card width that line has to
		 * hold a two-word name, a nine-character number, a pill and a menu, and the name is what
		 * loses. Giving the pill its own line costs one 26 px band and buys the name the card.
		 */
		render_tags() {
			const row = this.row;
			const status = status_of(row);
			const $tags = this.$el.find('[data-slot="tags"]');
			$(`<span class="wa-device__state"><span class="wa-device__state-dot" aria-hidden="true"></span>${ui.escape(status.label())}</span>`).appendTo($tags);
			if (row.is_default) {
				$(`<span class="wa-device__flag" title="${ui.escape(__("New messages use this device unless another one is chosen."))}">${ui.icon("es-line-star", "xs")}${ui.escape(__("Default"))}</span>`).appendTo($tags);
			}
			if (row.disabled) {
				$(`<span class="wa-device__flag wa-device__flag--muted" title="${ui.escape(__("Nothing is sent from this device until it is enabled again."))}">${ui.icon("es-line-slash", "xs")}${ui.escape(__("Sending paused"))}</span>`).appendTo($tags);
			}
			const items = this.menu_items();
			if (!items.length) return;
			$(`<button type="button" class="wa-device__more" aria-haspopup="menu" aria-expanded="false" aria-label="${ui.escape(__("Actions for {0}", [row.device_name || row.name]))}">${ui.icon(ui.icons.more, "sm")}</button>`)
				.on("click", (e) => open_menu($(e.currentTarget), this.menu_items()))
				.appendTo(this.$el.find('[data-slot="more"]'));
		}

		menu_items() {
			const row = this.row;
			const screen = this.screen;
			const items = [];
			if (is_agent()) {
				items.push({ label: __("Check status now"), icon: "es-line-reload", handler: () => screen.poll(row) });
			}
			if (!is_manager()) return items;
			if (!row.is_default) {
				items.push({ label: __("Make it the default device"), icon: "es-line-star", handler: () => screen.set_default(row) });
			}
			items.push({
				label: row.disabled ? __("Enable sending") : __("Pause sending from this device"),
				icon: row.disabled ? "es-line-success" : "es-line-slash",
				handler: () => screen.set_disabled(row, !row.disabled),
			});
			items.push({ label: __("Delete device"), icon: "es-line-delete", danger: true, handler: () => screen.remove(row) });
			return items;
		}

		// ---- what it sent -----------------------------------------------------------------------

		/**
		 * One sunken panel rather than three floating boxes: three readings divided by hairlines,
		 * and under them the bar that gives the third reading its meaning. A failure rate is a
		 * number nobody has a feel for; the same rate drawn as the red end of a delivery bar is
		 * read without being read.
		 */
		render_panel() {
			const $panel = this.$el.find('[data-slot="panel"]');
			const title = this.row.device_name || this.row.name;
			const readings = [
				{ key: "sent", label: __("Sent · {0}d", [STATS_DAYS]), route: {}, name: __("Open the outbound log of {0}", [title]) },
				{ key: "failed", label: __("Failures"), route: { status: "Failed" }, name: __("Open the failed messages of {0}", [title]) },
				{ key: "rate", label: __("Failure rate") },
			];
			const $row = $('<div class="wa-device__stats"></div>').appendTo($panel);
			readings.forEach((r) => {
				const clickable = !!r.route;
				const tag = clickable ? "button" : "span";
				const $stat = $(`<${tag} class="wa-device__stat" data-stat="${r.key}"${clickable ? ` type="button" aria-label="${ui.escape(r.name)}" title="${ui.escape(r.name)}"` : ""}><span class="wa-device__stat-label">${ui.escape(r.label)}</span><span class="wa-device__stat-value sanad-tabular" data-slot="value">${ui.skeleton(1, { lines: 1 })}</span></${tag}>`);
				if (clickable) {
					$stat.on("click", () => frappe.set_route("List", "WhatsApp Log", Object.assign({ device: this.row.name }, r.route)));
				}
				$row.append($stat);
			});
			$(`
				<div class="wa-device__bar wa-device__bar--idle" data-slot="bar" role="img" aria-label="${ui.escape(__("Delivery over the last {0} days", [STATS_DAYS]))}">
					<span class="wa-device__bar-seg wa-device__bar-seg--ok" data-slot="ok"></span>
					<span class="wa-device__bar-seg wa-device__bar-seg--bad" data-slot="bad"></span>
				</div>`).appendTo($panel);
		}

		/** Fill the three readings, the delivery bar, the "last message" line and the inbound count. */
		set_stats(stats) {
			if (!this.$el) return;
			const sent = Number(stats.sent || 0);
			const failed = Number(stats.failed || 0);
			const rate = Number(stats.fail_rate || 0);
			const attempted = sent + failed;
			const high = rate > FAIL_ALERT;
			this.$el.find('[data-stat="sent"] [data-slot="value"]').text(ui.format_int(sent));
			this.$el
				.find('[data-stat="failed"] [data-slot="value"]')
				.text(ui.format_int(failed))
				.toggleClass("wa-device__stat-value--alert", high);
			this.$el
				.find('[data-stat="rate"] [data-slot="value"]')
				.text(percent(rate))
				.toggleClass("wa-device__stat-value--alert", high);
			const $bar = this.$el.find('[data-slot="bar"]');
			$bar.toggleClass("wa-device__bar--idle", !attempted);
			$bar.find('[data-slot="ok"]').css("flex-basis", attempted ? `${((sent / attempted) * 100).toFixed(2)}%` : "0%");
			$bar.find('[data-slot="bad"]').css("flex-basis", attempted ? `${((failed / attempted) * 100).toFixed(2)}%` : "0%");
			// one atomic sentence, not a bare number: the bar is the only thing on the card that
			// carries a proportion, and a screen reader has to be told it in words
			$bar.attr(
				"aria-label",
				attempted
					? __("{0} of {1} messages arrived over the last {2} days; {3} failed.", [ui.format_int(sent), ui.format_int(attempted), STATS_DAYS, ui.format_int(failed)])
					: __("Nothing was sent over the last {0} days.", [STATS_DAYS])
			);
			this.$el
				.find('[data-meta="message"] [data-slot="value"]')
				.text(stats.last_message_at ? ago(stats.last_message_at) : __("No messages"));
			const inbound = Number(stats.inbound || 0);
			this.$el
				.find('[data-verb="inbound"] [data-slot="count"]')
				.text(inbound ? ui.format_int(inbound) : "")
				.toggleClass("wa-device__btn-count--empty", !inbound);
		}

		set_stats_error() {
			if (!this.$el) return;
			this.$el.find(".wa-device__stat [data-slot='value']").text("—");
			this.$el.find('[data-slot="bar"]').addClass("wa-device__bar--idle").attr("aria-label", __("The traffic of this device could not be read."));
			this.$el.find('[data-meta="message"] [data-slot="value"]').text("—");
		}

		// ---- how fresh it is --------------------------------------------------------------------

		render_meta() {
			const row = this.row;
			const offline = OFFLINE.includes(row.status);
			const since = offline ? row.disconnected_at || row.logged_out_at || row.last_seen : row.last_seen;
			const pairs = [
				{
					key: "seen",
					icon: offline ? "es-line-wifi-off" : "es-line-time",
					label: offline ? __("Offline since") : __("Last seen"),
					value: ago(since) || __("Never"),
					alert: offline,
				},
				{ key: "message", icon: "es-line-chat", label: __("Last message"), value: ui.skeleton(1, { lines: 1 }), html: true },
			];
			const $meta = this.$el.find('[data-slot="meta"]');
			pairs.forEach((pair) => {
				const $pair = $(`
					<div class="wa-device__meta-item" data-meta="${pair.key}">
						<dt class="wa-device__meta-label"><span class="wa-device__meta-icon" aria-hidden="true">${ui.icon(pair.icon, "xs")}</span>${ui.escape(pair.label)}</dt>
						<dd class="wa-device__meta-value${pair.alert ? " wa-device__meta-value--alert" : ""}" data-slot="value"></dd>
					</div>`);
				if (pair.html) $pair.find('[data-slot="value"]').html(pair.value);
				else $pair.find('[data-slot="value"]').text(pair.value);
				$meta.append($pair);
			});
		}

		render_notice() {
			$(`
				<div class="wa-device__notice sanad-tone--blue" role="status">
					<span class="wa-device__notice-icon" aria-hidden="true">${ui.icon("es-line-security", "sm")}</span>
					<span class="wa-device__notice-text">
						<b class="wa-device__notice-title">${ui.escape(__("The code has not been scanned yet"))}</b>
						<span class="wa-device__notice-line">${ui.escape(__("Open pairing again to scan a fresh code."))}</span>
					</span>
				</div>`).insertBefore(this.$el.find('[data-slot="actions"]'));
		}

		// ---- what you can do ----------------------------------------------------------------------

		/**
		 * Three verbs, each with the icon that says it before the word is read: the one that moves
		 * the device on leads and, when it is the encouraged one, wears the accent; the two that
		 * only open a log stay quiet. Deleting is not among them — it lives in the overflow menu
		 * with the other settings, one step further from the hand than an action that cannot be
		 * undone should ever be, which also leaves the three that remain room for their whole word
		 * on one line in English as well as in Arabic.
		 */
		render_actions() {
			const row = this.row;
			const screen = this.screen;
			const connected = row.status === "Connected";
			const pending = row.status === "Pending QR";
			const verbs = [];
			if (is_manager()) {
				verbs.push(
					connected
						? { key: "disconnect", label: __("Disconnect"), icon: "es-line-wifi-off", handler: () => screen.disconnect(row) }
						: pending
						? { key: "code", label: __("Show code"), icon: "es-line-security", primary: true, handler: () => screen.pair(row) }
						: { key: "pair", label: __("Pair again"), icon: "es-line-link", primary: true, handler: () => screen.pair(row) }
				);
			}
			verbs.push(
				{ key: "outbound", label: __("Outbound"), icon: "es-line-arrow-up-right", handler: () => frappe.set_route("List", "WhatsApp Log", { device: row.name }) },
				{ key: "inbound", label: __("Inbound"), icon: "es-line-inbox", count: true, handler: () => frappe.set_route("List", "WhatsApp Inbound Message", { device: row.name }) }
			);
			const $actions = this.$el.find('[data-slot="actions"]');
			verbs.forEach((verb) => {
				$(`<button type="button" class="wa-device__btn${verb.primary ? " wa-device__btn--primary" : ""}" data-verb="${verb.key}" title="${ui.escape(verb.label)}" aria-label="${ui.escape(verb.label)}"><span class="wa-device__btn-icon" aria-hidden="true">${ui.icon(verb.icon, "sm")}</span><span class="wa-device__btn-label">${ui.escape(verb.label)}</span>${verb.count ? '<span class="wa-device__btn-count wa-device__btn-count--empty sanad-tabular" data-slot="count"></span>' : ""}</button>`)
					.on("click", verb.handler)
					.appendTo($actions);
			});
		}

		destroy() {
			this.$el && this.$el.remove();
			this.$el = null;
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
			this.$screen = $('<div class="sanad-kit wa-devices"></div>').appendTo(page.main);
			this.header = new ui.PageHeader({
				wrapper: this.$screen,
				title: __("Devices"),
				description: __("Every device is its own WhatsApp number. Messages are routed to one of them by the template or the campaign."),
				primary: is_manager()
					? { label: __("Add device"), icon: "es-line-add", handler: () => this.pair(null) }
					: null,
				secondary: [
					{ label: __("Refresh"), icon: "es-line-reload", handler: () => this.refresh({ remote: true }) },
				],
				blocks: [
					{ key: "alert", render: ($el) => this.render_alert($el) },
					{ key: "devices", render: ($el) => this.render_block($el) },
				],
			});
			this.mark_header();
			this.bind_realtime();
			$(wrapper).on("hide", () => this.unbind_realtime());
		}

		/** The screen's mark: the tinted plate carrying the screen's icon beside its title. */
		mark_header() {
			$(`<span class="wa-devices__mark" aria-hidden="true">${ui.icon("es-line-mobile", "md")}</span>`).prependTo(
				this.header.$el.find(".sanad-pagehead__row")
			);
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
			return this.header.refresh(true);
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

		// ---- the incident strip -------------------------------------------------------------------

		/**
		 * What is wrong, before anything else on the screen: the fact in one bold line, what it
		 * costs in the second, and the verb that ends it. Amber once a connection drops, red once a
		 * device was signed out on the phone (matrix §6 tones), and the tone is carried by the rail
		 * and the icon as well as the fill, so it survives a greyscale screen.
		 */
		render_alert($el) {
			return this.load().then((rows) => {
				const offline = rows.filter((row) => OFFLINE.includes(row.status));
				$el.empty();
				if (!offline.length) return;
				const signed_out = offline.some((row) => row.status === "Logged Out");
				const tone = signed_out ? "red" : "amber";
				const one = offline.length === 1 ? offline[0] : null;
				const since = one && ago(one.disconnected_at || one.logged_out_at || one.last_seen);
				const title = one
					? since
						? __("Device {0} has been offline since {1}.", [one.device_name || one.name, since])
						: __("Device {0} is offline.", [one.device_name || one.name])
					: __("{0} devices are not connected.", [ui.format_int(offline.length)]);
				const line = one
					? __("Messages addressed to it stay in the queue and are not sent until it is paired again.")
					: __("Messages addressed to them stay in the queue and are not sent until they are paired again.");
				const action =
					one && is_manager()
						? { label: __("Pair again"), icon: "es-line-link", handler: () => this.pair(one), strong: true }
						: { label: __("Show them"), icon: "es-line-filter", handler: () => this.set_filter("offline") };
				const $alert = $(`
					<div class="wa-devices__alert wa-devices__alert--${tone}" role="${tone === "red" ? "alert" : "status"}">
						<span class="wa-devices__alert-icon" aria-hidden="true">${ui.icon("es-line-alert-triangle", "sm")}</span>
						<span class="wa-devices__alert-text">
							<b class="wa-devices__alert-title">${ui.escape(title)}</b>
							<span class="wa-devices__alert-line">${ui.escape(line)}</span>
						</span>
					</div>`).appendTo($el);
				$(`<button type="button" class="wa-devices__alert-action${action.strong ? " wa-devices__alert-action--strong" : ""}"><span aria-hidden="true">${ui.icon(action.icon, "sm")}</span><span class="wa-devices__alert-label">${ui.escape(action.label)}</span></button>`)
					.on("click", action.handler)
					.appendTo($alert);
			});
		}

		// ---- the fleet ----------------------------------------------------------------------------

		render_block($el) {
			const first = !$el.children().length;
			if (first) {
				$el.html('<div class="wa-devices__rail" data-slot="rail"></div><div class="wa-devices__grid" data-slot="grid"></div>');
			}
			const $rail = $el.find('[data-slot="rail"]');
			const $grid = $el.find('[data-slot="grid"]');
			// the cards are replaced, not emptied and refilled: holding the grid's height across a
			// refresh is what keeps the page from jumping under the pointer (CLS)
			if (first) this.render_skeleton($grid);
			return this.load()
				.then((rows) => {
					this.render_rail($rail, rows);
					this.render_grid($grid, rows);
				})
				.catch((err) => {
					$rail.empty();
					$grid.empty();
					new ui.EmptyState({
						wrapper: $grid,
						state: "error",
						description: err.message,
						action: { label: __("Try again"), on_click: () => this.refresh() },
					});
				});
		}

		/** Cards of the right shape while the fleet loads, so nothing on the page moves after it. */
		render_skeleton($grid) {
			$grid.empty();
			for (let i = 0; i < 3; i++) {
				$grid.append(`
					<div class="wa-device wa-device--skeleton" aria-hidden="true">
						<span class="wa-device__rail"></span>
						<div class="wa-device__head"><span class="wa-device__avatar"></span><span class="wa-device__identity"><span class="sanad-skeleton__line" style="inline-size:55%"></span><span class="sanad-skeleton__line" style="inline-size:38%;block-size:9px"></span></span></div>
						<div class="wa-device__tags"><span class="sanad-skeleton__line" style="inline-size:82px;block-size:22px;border-radius:999px"></span></div>
						<div class="wa-device__panel"><div class="wa-device__stats"><span class="wa-device__stat"></span><span class="wa-device__stat"></span><span class="wa-device__stat"></span></div><div class="wa-device__bar wa-device__bar--idle"></div></div>
						<div class="wa-device__meta"><span class="sanad-skeleton__line" style="inline-size:70%"></span><span class="sanad-skeleton__line" style="inline-size:70%"></span></div>
						<div class="wa-device__actions"><span class="sanad-skeleton__line" style="block-size:36px;border-radius:8px"></span></div>
					</div>`);
			}
		}

		counts(rows) {
			return {
				all: rows.length,
				Connected: rows.filter((r) => r.status === "Connected").length,
				"Pending QR": rows.filter((r) => r.status === "Pending QR").length,
				offline: rows.filter((r) => OFFLINE.includes(r.status)).length,
			};
		}

		/**
		 * The fleet rail: one segmented control that is both the summary and the filter. Four
		 * segments, each a state with its own dot and its own count — read left to right it says
		 * how the fleet stands; clicked it says what to show. A state nothing is in stays readable
		 * and is not clickable, which is truer than hiding it.
		 */
		render_rail($el, rows) {
			$el.empty();
			if (!rows.length) return;
			const counts = this.counts(rows);
			const $group = $(`<div class="wa-devices__segments" role="group" aria-label="${ui.escape(__("Filter by status"))}"></div>`).appendTo($el);
			[
				{ key: "all", label: __("All"), tone: "gray" },
				{ key: "Connected", label: __("Connected"), tone: "green" },
				{ key: "Pending QR", label: __("Not paired"), tone: "blue" },
				{ key: "offline", label: __("Not connected"), tone: "amber" },
			].forEach((seg) => {
				const count = counts[seg.key];
				$(`<button type="button" class="wa-devices__segment wa-devices__segment--${seg.tone}" aria-pressed="${this.filter === seg.key}"${count ? "" : " disabled"}>${seg.key === "all" ? "" : '<span class="wa-devices__segment-dot" aria-hidden="true"></span>'}<span class="wa-devices__segment-label">${ui.escape(seg.label)}</span><span class="wa-devices__segment-count sanad-tabular">${ui.escape(ui.format_int(count))}</span></button>`)
					.on("click", () => this.set_filter(seg.key))
					.appendTo($group);
			});
		}

		set_filter(key) {
			this.filter = key;
			this.header.refresh(true);
		}

		matches(row) {
			if (this.filter === "all") return true;
			if (this.filter === "offline") return OFFLINE.includes(row.status);
			return row.status === this.filter;
		}

		render_grid($grid, rows) {
			this.cards.forEach((card) => card.destroy());
			this.cards = [];
			$grid.empty();
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

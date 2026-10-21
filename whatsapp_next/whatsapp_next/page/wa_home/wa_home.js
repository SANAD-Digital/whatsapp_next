// Module role: the Home screen (spec §2 row 2, matrix row 2) — the one screen that answers
// "is it working right now?" before anything else. It is not a workspace of shortcuts: the
// Workspace already lists the doctypes. Home reads live state that no list can show at a
// glance — which devices are up, whether the queue is moving, which campaigns are sending,
// what failed and why, and what is left of the plan — and every number on it clicks through
// to the screen that owns it.
//
// The bands, in the prototype's order (`docs/screen/Hub Screen - Home.dc.html`):
//   1. the board head — what this screen is, the period it is showing, and the period control
//   2. the operating state — six cards that are true *now*, each one a door
//   3. what needs attention — the paused queue and the offline device, with the verb that fixes it
//   4. the period's five KPIs, each with the shape of its own period beside the number
//   5. the evidence — message volume per day split by status, beside failures by error
//   6. the three panels — live flow, active campaigns, devices
//
// Everything comes from `home.get_dashboard` in one call, plus Frappe's own permission-checked
// reads for what that call does not return yet (the per-status and per-error counts of a period,
// the per-day series behind the chart, the last five movements and the scheduled campaigns).
// No business logic and no new endpoint lives here — see the report for the API gap.
//
// The visual language is the operations console of the Queue and Campaign screens
// (`public/js/screens/console.js`, `public/scss/screens/_console.scss`): small capital labels,
// tabular figures, hairlines instead of boxes inside boxes, and a text alternative under every
// drawing.

frappe.provide("whatsapp_next.home");

(() => {
	const ui = sanad.ui;
	const C = whatsapp_next.campaigns;

	const OUT = "WhatsApp Log";
	const IN = "WhatsApp Inbound Message";
	const DEV = "WhatsApp Device";
	const CAMP = "WhatsApp Campaign";
	const QUEUE = "WhatsApp Queue Item";

	const MANAGER = ["WhatsApp Manager", "System Manager"];
	const AGENT_UP = ["WhatsApp Agent", "WhatsApp Manager", "System Manager"];

	/** Sent, Delivered and Read are three stages of one fact: everything that left. */
	const HANDED = ["Sent", "Delivered", "Read"];
	const ARRIVED = ["Delivered", "Read"];
	const WAITING = ["Queued", "Sending"];
	const OFFLINE = ["Disconnected", "Logged Out"];
	/** Devices that are down against the owner's wish — a disabled device is off on purpose. */
	const offline_of = (rows) => rows.filter((r) => OFFLINE.includes(r.status) && !cint(r.disabled));
	const FEED_LIMIT = 5;
	const PANEL_LIMIT = 5;
	const FAIL_LIMIT = 6;

	const PERIODS = [
		{ key: "today", days: 0, grain: "hour", label: () => __("Today"), window: () => __("today") },
		{ key: "7d", days: 6, grain: "day", label: () => __("7 days"), window: () => __("the last 7 days") },
		{ key: "30d", days: 29, grain: "day", label: () => __("30 days"), window: () => __("the last 30 days") },
	];

	// Matrix §6: the message lifecycle drawn with Espresso tones, label always beside the colour.
	const OUT_TONE = {
		Sent: "green", Delivered: "green", Read: "green",
		Queued: "blue", Sending: "blue",
		Unsent: "amber", Held: "amber",
		Failed: "red", Cancelled: "red",
	};
	// Matrix row 3: Connected green · Pending QR blue · Disconnected amber · Logged Out red.
	const DEVICE_STATE = {
		Connected: { tone: "green", label: () => __("Connected") },
		"Pending QR": { tone: "blue", label: () => __("Not paired") },
		Disconnected: { tone: "amber", label: () => __("Disconnected") },
		"Logged Out": { tone: "red", label: () => __("Signed out") },
	};

	/**
	 * The five bands of the volume chart — the lifecycle in the order it happens, read at the
	 * top of the column first. `seg` is the CSS modifier that carries the band's own colour.
	 */
	const BANDS = [
		{ key: "Read", seg: "read", label: () => __("Read") },
		{ key: "Delivered", seg: "delivered", label: () => __("Delivered") },
		{ key: "Sent", seg: "sent", label: () => __("Sent") },
		{ key: "Waiting", seg: "waiting", label: () => __("Waiting") },
		{ key: "Failed", seg: "failed", label: () => __("Failed") },
	];

	/** The canonical `error_code` vocabulary (`services/errors.py`) in the reader's words. */
	const ERROR_LABEL = {
		recipient_not_registered: () => __("Number not on WhatsApp"),
		device_disconnected: () => __("Device disconnected"),
		device_offline: () => __("Device disconnected"),
		timeout: () => __("Timed out"),
		platform_rejected: () => __("Rejected by the platform"),
		invalid_template: () => __("Template not accepted"),
		insufficient_balance: () => __("Out of balance"),
		invalid_phone: () => __("Invalid number"),
		blacklisted: () => __("Blocked recipient"),
		unknown_number_policy: () => __("Unknown number blocked"),
		rate_limited: () => __("Rate limited"),
		auth: () => __("Credentials rejected"),
		unknown: () => __("Unclassified"),
	};

	const esc = ui.escape;
	const int = ui.format_int;
	const is_manager = () => frappe.user.has_role(MANAGER);
	const is_agent = () => frappe.user.has_role(AGENT_UP);
	const period_of = (key) => PERIODS.find((p) => p.key === key) || PERIODS[1];
	const sum_of = (counts, keys) => keys.reduce((n, k) => n + cint(counts[k]), 0);
	const ago = (value) => (value ? frappe.datetime.prettyDate(value) : "");

	/**
	 * The site's own calendar day. Every period is cut by the server in the site's time zone
	 * (`nowdate()`), and the series comes back keyed by site-local hours and days, so the empty
	 * columns have to be laid out on the same calendar. `get_today()` is the *user's* day: with a
	 * user zone other than the site's, the buckets and the server's keys drifted a day apart.
	 */
	const site_today = () => frappe.datetime.system_datetime().slice(0, 10);

	/** A stored (site-zone) time as the reader's wall clock, `YYYY-MM-DD HH:mm:ss`. */
	const local = (value) => frappe.datetime.convert_to_user_tz(value);

	/**
	 * A date in the reader's language ("الأربعاء", "30 سبتمبر"), Gregorian and with Latin digits
	 * like every number in the app. `moment` has no Arabic locale loaded in Desk, so its "ddd" and
	 * "MMM" came out as "Wed" and "Sep" on an Arabic screen.
	 */
	const DATE_OPTS = {
		weekday: { weekday: "short" },
		day_month: { day: "numeric", month: "short" },
		day_month_year: { day: "numeric", month: "short", year: "numeric" },
		day: { day: "numeric" },
		time: { hour: "numeric", minute: "2-digit" },
	};
	const date_text = (value, kind) => {
		const d = value instanceof Date ? value : frappe.datetime.str_to_obj(String(value));
		try {
			return new Intl.DateTimeFormat(`${frappe.boot.lang || "en"}-u-ca-gregory-nu-latn`, DATE_OPTS[kind]).format(d);
		} catch (e) {
			return moment(d).format({ weekday: "ddd", day_month: "D MMM", day_month_year: "D MMM YYYY", day: "D", time: "LT" }[kind]);
		}
	};

	/** Clock time for anything that happened today, "3 Sep, 14:02" before that. */
	const clock = (value) => {
		if (!value) return "";
		// stored times are the site's wall clock; "today" and the time shown are the reader's
		const at = local(value);
		return at.slice(0, 10) === frappe.datetime.now_date()
			? date_text(at, "time")
			: __("{0}, {1}", [date_text(at, "day_month"), date_text(at, "time")]);
	};

	/** "8.4%" — one decimal, through Frappe's formatter so the locale decides the separator. */
	const rate_text = (part, whole) =>
		cint(whole)
			? frappe.format((cint(part) * 100) / cint(whole), { fieldtype: "Percent", precision: 1 }, { inline: true })
			: "—";

	/** A bare number with one decimal, through Frappe's formatter (locale decimal separator). */
	const pct_text = (value) => frappe.format(value, { fieldtype: "Float", precision: 1 }, { inline: true });

	/**
	 * The axis maximum: the smallest "round" number at or above the tallest column that also
	 * divides into three whole gridlines, so the axis reads 0 / 250 / 500 / 750 and never
	 * 0 / 141 / 283 / 424.
	 */
	const nice_step = (value) => {
		const third = Math.max(cint(value), 3) / 3;
		const magnitude = Math.pow(10, Math.floor(Math.log10(third)));
		const multiple = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((m) => m * magnitude >= third) || 10;
		return Math.ceil(multiple * magnitude);
	};

	/**
	 * The loading state of a card body — drawn only when the body is empty. The board is re-read
	 * on every realtime tick; a skeleton on each one made the chart and the panels flash while
	 * messages moved. A re-read keeps what is on screen until the new answer replaces it.
	 */
	const body_state = ($body, rows) => {
		if (!$body.children().length) return new ui.EmptyState({ wrapper: $body, state: "loading", rows, size: "sm" });
		const state = new ui.EmptyState({ wrapper: $("<div></div>"), state: "loading", rows, size: "sm" });
		state.$wrapper = $body;
		return state;
	};

	const error_label = (code) => {
		if (!code) return __("No code recorded");
		const known = ERROR_LABEL[code];
		return known ? known() : frappe.unscrub(String(code));
	};

	/** The Outbound list, filtered — the one place a message on this screen leads to. */
	const open_outbound = (filters) => frappe.set_route("List", OUT, filters || {});
	const open_queue = () => frappe.set_route("List", QUEUE, { status: ["in", ["Queued", "Sending", "Paused"]] });

	/**
	 * What is still in the queue: the same three statuses `open_queue` lists, so the number on a
	 * card is the number of rows its click opens. A global pause leaves rows `Queued`; a paused
	 * device or campaign moves them to `Paused` — both are waiting.
	 */
	const queue_open = (q) => cint(q.queued) + cint(q.sending) + cint(q.paused);

	/** The chosen period as a list filter: every figure of a period opens on that same window. */
	const since = (t) => (t && t.from ? { creation: [">=", t.from] } : {});

	// ---------------------------------------------------------------------------------------
	// Reads. `home.get_dashboard` is the screen's main call; the rest are Frappe's own
	// permission-checked reads for what it does not return yet (see the report's API gaps).
	// ---------------------------------------------------------------------------------------

	/** Counts of `WhatsApp Log` by one field inside a window, as `{value: count}`. */
	// ---- the period, as buckets -------------------------------------------------------------

	/**
	 * The empty columns of the chart: one per hour for today, one per day otherwise. They exist
	 * before the data does, so a quiet day still draws its place on the axis instead of the
	 * chart silently narrowing.
	 */
	const bucket_defs = (period) => {
		const p = period_of(period);
		const today = site_today();
		const out = [];
		if (p.grain === "hour") {
			for (let h = 0; h < 24; h++) {
				const hh = String(h).padStart(2, "0");
				out.push({
					key: hh,
					from: `${today} ${hh}:00:00`,
					// the list compares microseconds: a row at 10:59:59.4 belongs to 10:00
					to: `${today} ${hh}:59:59.999999`,
					tick: h % 4 === 0 ? `${hh}:00` : "",
					name: date_text(`${today} ${hh}:00:00`, "time"),
					counts: {},
				});
			}
			return out;
		}
		for (let i = p.days; i >= 0; i--) {
			const day = frappe.datetime.add_days(today, -i);
			out.push({
				key: day,
				// `between` on a Datetime runs to the END of its second date, so a day is [day, day]
				// — [day, day + 1] opened two days of messages under one column
				from: day,
				to: day,
				// 7 days name every column; a month names one in five, or the axis turns to mush
				tick: p.days <= 6 ? date_text(day, "weekday") : i % 5 === 0 ? date_text(day, "day_month") : "",
				name: __("{0}, {1}", [date_text(day, "weekday"), date_text(day, "day_month")]),
				counts: {},
			});
		}
		return out;
	};

	/** Which band a status belongs to — everything unknown is left out of the drawing. */
	const band_of = (status) => {
		if (HANDED.includes(status)) return status;
		if (WAITING.includes(status)) return "Waiting";
		if (status === "Failed") return "Failed";
		return null;
	};

	// ---------------------------------------------------------------------------------------
	// The screen
	// ---------------------------------------------------------------------------------------

	class HomeScreen {
		constructor({ page, wrapper }) {
			this.page = page;
			this.wrapper = wrapper;
			this.period = "7d";
			this.$screen = $('<div class="wa-home"></div>').appendTo(page.main);
			this.make_page_actions();
			this.header = new ui.PageHeader({
				wrapper: this.$screen,
				stats: this.stat_cards(),
				blocks: [
					{ key: "alerts", render: ($el) => this.render_alerts($el) },
					{ key: "kpis", render: ($el) => this.render_kpis($el) },
					{ key: "evidence", render: ($el) => this.render_evidence($el) },
					{ key: "panels", render: ($el) => this.render_panels($el) },
				],
			});
			// PageHeader mounts itself as the first child of its wrapper, so the board head is
			// put in front of it once the header exists.
			this.render_board();
			this.bind_realtime();
			$(wrapper).on("hide", () => this.destroy());
		}

		make_page_actions() {
			if (is_agent()) {
				this.page.set_primary_action(
					__("Send a message"),
					() => new ui.QuickSend({ on_sent: () => this.refresh() }),
					ui.icons.quick_send
				);
			}
			this.page.add_action_icon("es-line-reload", () => this.refresh(), "", __("Refresh"));
			// `add_action_icon` only sets a title: an icon-only control also needs a name (WCAG 4.1.2)
			this.page.icon_group.find(".icon-btn").last().attr("aria-label", __("Refresh"));
		}

		// ---- the board head: what the screen is, and the period every number below it means ----

		render_board() {
			this.$board = $(`
				<div class="wa-home__board">
					<p class="wa-home__lede">
						<span class="wa-home__lede-text">${esc(
							__("What is running right now — devices, the queue, campaigns and everything that went out.")
						)}</span>
						<span class="wa-home__range sanad-tabular"></span>
					</p>
					<div class="wa-home__period sanad-chip-row" role="radiogroup" aria-label="${esc(__("Period"))}"></div>
				</div>`).prependTo(this.$screen);
			this.render_period();
		}

		/** "18 – 24 Sep 2026" — the window the period control is currently on. */
		range_text() {
			const p = period_of(this.period);
			const today = site_today();
			if (!p.days) return date_text(today, "day_month_year");
			const from_day = frappe.datetime.add_days(today, -p.days);
			// `formatRange` prints the shared month and year once, in the reader's own order:
			// "Sep 24 – 30, 2026" in English, "24–30 سبتمبر 2026" in Arabic (the prototype's form).
			// Building it by hand gave "24 – Sep 30, 2026" in English.
			try {
				return new Intl.DateTimeFormat(`${frappe.boot.lang || "en"}-u-ca-gregory-nu-latn`, DATE_OPTS.day_month_year).formatRange(
					frappe.datetime.str_to_obj(from_day),
					frappe.datetime.str_to_obj(today)
				);
			} catch (e) {
				return __("{0} – {1}", [date_text(from_day, "day_month"), date_text(today, "day_month_year")]);
			}
		}

		render_period() {
			const $row = this.$board.find(".wa-home__period");
			this.$board.find(".wa-home__range").text(this.range_text());
			$row.empty();
			PERIODS.forEach((p) => {
				const on = p.key === this.period;
				$(
					`<button type="button" class="sanad-chip" role="radio" aria-checked="${on}" tabindex="${
						on ? 0 : -1
					}" data-key="${p.key}">${esc(p.label())}</button>`
				)
					.on("click", () => this.set_period(p.key))
					.appendTo($row);
			});
			$row.off("keydown.waperiod").on("keydown.waperiod", "[role=radio]", (e) => {
				const keys = PERIODS.map((p) => p.key);
				const next = ui.roving_index(e, keys, keys.indexOf(this.period));
				if (next < 0) return;
				e.preventDefault();
				this.set_period(keys[next]);
				$row.find(`[data-key="${keys[next]}"]`).trigger("focus");
			});
		}

		set_period(key) {
			if (key === this.period || !PERIODS.some((p) => p.key === key)) return;
			this.period = key;
			this._activity = null;
			this._traffic = null;
			this._series = null;
			this.render_period();
			ui.announce(__("Showing {0}.", [period_of(key).window()]));
			// another period is another chart: show it loading rather than the old one standing in
			this.$screen.find(".wa-home__evidence .wa-home__card-body").empty();
			["kpis", "evidence"].forEach((k) => {
				const block = this.header.opts.blocks.find((b) => b.key === k);
				if (block) this.header.render_block(block);
			});
		}

		// ---- data -----------------------------------------------------------------------------

		/** One call for the whole screen; every panel shares this promise. */
		dashboard() {
			if (!this._dashboard) {
				this._dashboard = ui.call("home.get_dashboard");
				this._dashboard.then((data) => this.mark_setup_complete(data)).catch(() => {});
			}
			return this._dashboard;
		}

		/**
		 * R-042: `setup_completed` was never set by any screen, so a working site read as
		 * unfinished to anything that trusts the flag. The first time a System Manager (the role
		 * `onboarding.complete_setup` takes) sees Home with all four steps done, it is recorded —
		 * once, quietly; the server checks the steps again and refuses if one is missing.
		 */
		mark_setup_complete(data) {
			const setup = (data && data.setup) || {};
			const steps = setup.steps || [];
			if (this._setup_marked || setup.setup_completed || !frappe.user.has_role("System Manager")) return;
			if (!steps.length || !steps.every((s) => s.done)) return;
			this._setup_marked = true;
			ui.call("onboarding.complete_setup", {}, { silent: true }).catch(() => {});
		}

		/**
		 * Everything that depends on the period, in one call (`home.get_activity`, A-3): exact
		 * status / error totals for it and the period before, its shape per hour or day (grouped in
		 * the database), the scheduled campaigns, the last send and the live feed.
		 */
		activity() {
			if (!this._activity) this._activity = ui.call("home.get_activity", { period: this.period });
			return this._activity;
		}

		/** Exact per-status and per-error totals for the chosen period, and the one before it. */
		traffic() {
			if (!this._traffic) this._traffic = this.activity().then((a) => a.traffic);
			return this._traffic;
		}

		/** The shape of the period: its hours (today) or days, each with its status bands. */
		series() {
			if (this._series) return this._series;
			this._series = this.activity().then((a) => {
				const buckets = bucket_defs(this.period);
				const index = {};
				buckets.forEach((b) => (index[b.key] = b));
				(a.series || []).forEach((r) => {
					const band = band_of(r.status);
					const bucket = index[r.key];
					if (!band || !bucket) return;
					bucket.counts[band] = cint(bucket.counts[band]) + cint(r.count);
				});
				buckets.forEach((b) => {
					b.total = BANDS.reduce((n, band) => n + cint(b.counts[band.key]), 0);
				});
				return { buckets };
			});
			return this._series;
		}

		/** Campaigns waiting for their hour — `campaigns_sending` only returns the live ones. */
		scheduled() {
			if (!this._scheduled) this._scheduled = this.activity().then((a) => a.scheduled || []);
			return this._scheduled;
		}

		/** When a message last left, whatever period is on screen. */
		last_sent() {
			if (!this._last_sent) this._last_sent = this.activity().then((a) => a.last_sent || null);
			return this._last_sent;
		}

		/** The last five movements in both directions — the prototype's live flow. */
		feed() {
			if (!this._feed) {
				this._feed = this.activity().then((a) =>
					(a.feed || []).map((r) => Object.assign({ _direction: r.direction, _at: r.at }, r))
				);
			}
			return this._feed;
		}

		refresh() {
			this._dashboard = null;
			this._activity = null;
			this._traffic = null;
			this._series = null;
			this._feed = null;
			this._scheduled = null;
			this._last_sent = null;
			return this.header.refresh(true);
		}

		// ---- band 2: the operating state — six cards, each one a door --------------------------

		stat_cards() {
			const d = () => this.dashboard();
			return [
				{
					key: "devices",
					label: __("Devices"),
					icon: "es-line-laptop",
					tone: "blue",
					value: () =>
						d().then((data) => {
							const rows = data.devices || [];
							const connected = rows.filter((r) => r.status === "Connected").length;
							const off = offline_of(rows).length;
							// "every device is connected" only when it is true: a device still waiting
							// for its QR is neither connected nor offline
							const unpaired = rows.length - connected - off;
							return { value: connected, tone: off || !connected ? "amber" : "green", total: rows.length, off, unpaired };
						}),
					format: (v, raw) => (raw.total ? __("{0} of {1}", [int(v), int(raw.total)]) : __("None")),
					sub: (v, raw) =>
						!raw.total
							? __("Pair a phone to start sending")
							: raw.off
								? ui.plural(raw.off, { one: __("{0} device is offline"), other: __("{0} devices are offline") })
								: raw.unpaired > 0
									? ui.plural(raw.unpaired, { one: __("{0} device is not paired yet"), other: __("{0} devices are not paired yet") })
									: __("Every device is connected"),
					onclick: () => frappe.set_route("wa-devices"),
				},
				{
					key: "queue",
					label: __("Queue"),
					icon: "es-line-progress",
					tone: "gray",
					value: () =>
						d().then((data) => {
							const q = data.queue || {};
							const waiting = queue_open(q);
							return {
								value: waiting,
								tone: q.paused_globally ? "amber" : waiting ? "blue" : "gray",
								paused: !!q.paused_globally,
								rate: cint(q.rate),
							};
						}),
					format: (v, raw) => (raw.paused ? __("Paused") : v ? __("Sending") : __("Idle")),
					sub: (v, raw) =>
						raw.paused
							? ui.plural(v, { one: __("{0} message is waiting"), other: __("{0} messages are waiting") })
							: v
								? __("{0} waiting · {1} / minute", [int(v), int(raw.rate)])
								: __("Nothing is waiting"),
					onclick: open_queue,
				},
				{
					key: "last_sent",
					label: __("Last sent"),
					icon: ui.icons.quick_send,
					tone: "green",
					value: () =>
						Promise.all([this.last_sent(), d()]).then(([at, data]) => ({
							value: at ? 1 : 0,
							at,
							today: cint((data.today || {}).sent),
						})),
					format: (v, raw) => (raw.at ? ago(raw.at) : __("Never")),
					sub: (v, raw) =>
						raw.at
							? ui.plural(raw.today, { one: __("{0} message sent today"), other: __("{0} messages sent today") })
							: __("Nothing has been sent yet"),
					onclick: () => open_outbound({}),
				},
				{
					// the twin of "Last sent": when the site last heard from the platform, which is
					// what the webhook is for — its status is the line under it
					key: "webhook",
					label: __("Last received"),
					icon: "es-line-web",
					tone: "blue",
					value: () =>
						d().then((data) => ({
							value: data.webhook_status === "Active" ? 1 : 0,
							tone: data.webhook_status === "Active" ? "green" : "red",
							status: data.webhook_status,
							at: data.last_webhook_event_at,
						})),
					format: (v, raw) => (!v ? (raw.status ? __(raw.status) : __("Not set up")) : raw.at ? ago(raw.at) : __("Never")),
					sub: (v, raw) => (v ? (raw.at ? __("The webhook is active") : __("No event received yet")) : __("Delivery updates do not arrive")),
					onclick: () => whatsapp_next.settings.open("webhook"),
				},
				{
					key: "platform",
					label: __("Platform"),
					icon: "es-line-web-link",
					tone: "blue",
					value: () =>
						d().then((data) => {
							const steps = (data.setup || {}).steps || [];
							const linked = (steps.find((s) => s.key === "credentials") || {}).done;
							const step = steps.find((s) => s.key === "connection") || {};
							// 2 = connected, 1 = linked but unreachable, 0 = no account linked at all
							return { value: !linked ? 0 : step.done ? 2 : 1, tone: step.done ? "green" : linked ? "red" : "amber", detail: step.detail };
						}),
					format: (v) => (v === 2 ? __("Healthy") : v === 1 ? __("Unreachable") : __("No account")),
					sub: (v, raw) =>
						v === 2 ? __("Credentials accepted") : v === 1 ? raw.detail || __("Check the credentials in settings") : __("Create an account or sign in"),
					onclick: () =>
						d().then((data) => {
							const linked = (((data.setup || {}).steps || []).find((s) => s.key === "credentials") || {}).done;
							return linked ? whatsapp_next.settings.open("provider") : frappe.set_route("wa-onboarding");
						}),
				},
				{
					key: "plan",
					label: __("Plan usage"),
					icon: "es-line-payments",
					tone: "gray",
					value: () =>
						d().then((data) => {
							const plan = data.plan || {};
							const limit = cint(plan.message_limit);
							const used = cint(plan.messages_used);
							const share = limit ? Math.round((used * 100) / limit) : null;
							return { value: share, tone: share == null ? "gray" : share > 80 ? "amber" : "blue", limit, used };
						}),
					format: (v) => (v == null ? __("Not read") : __("{0}%", [int(v)])),
					sub: (v, raw) =>
						raw.limit ? __("{0} of {1} messages", [int(raw.used), int(raw.limit)]) : __("Sync the subscription to see it"),
					onclick: () => whatsapp_next.settings.open("subscription"),
				},
			];
		}

		// ---- band 3: what needs attention now ---------------------------------------------------

		/**
		 * Up to three things that are wrong right now, most urgent first. Each one states what it
		 * costs and carries the single verb that fixes it; a reader with no permission for the verb
		 * still reads the fact.
		 */
		render_alerts($el) {
			return Promise.all([this.dashboard(), this.traffic()])
				.then(([data, t]) => {
					const alerts = [];
					const queue = data.queue || {};
					const devices = data.devices || [];
					const setup = data.setup || {};
					const offline = offline_of(devices);

					if (queue.paused_globally) {
						const waiting = queue_open(queue);
						const by = queue.paused_by ? frappe.user.full_name(queue.paused_by) : __("an administrator");
						alerts.push({
							key: "queue",
							tone: "amber",
							icon: "es-line-alert-triangle",
							title: ui.plural(waiting, {
								one: __("Sending is paused — {0} message is waiting"),
								other: __("Sending is paused — {0} messages are waiting"),
							}),
							note: queue.reason
								? __("Paused {0} by {1}. Reason: “{2}”.", [ago(queue.paused_at), by, queue.reason])
								: __("Paused {0} by {1}.", [ago(queue.paused_at), by]),
							action: is_manager() ? { label: __("Resume sending"), primary: true, handler: () => this.resume_queue() } : null,
						});
					}
					if (offline.length) {
						const first = offline[0];
						const attempted = sum_of(t.now, HANDED) + cint(t.now.Failed);
						const rate = cint(t.now.Failed) ? __("Failures in this period: {0}.", [rate_text(t.now.Failed, attempted)]) : "";
						alerts.push({
							key: "device",
							tone: "red",
							icon: "es-line-alert-circle",
							title:
								offline.length === 1
									? __("{0} is offline", [first.device_name || first.name])
									: __("{0} devices are offline", [int(offline.length)]),
							note: [
								offline.length === 1 && first.last_seen ? __("Last seen {0}.", [ago(first.last_seen)]) : "",
								offline.length === 1
									? __("Messages routed to it fail until it is paired again.")
									: __("Messages routed to them fail until they are paired again."),
								rate,
							]
								.filter(Boolean)
								.join(" "),
							action: { label: __("Open device diagnostics"), handler: () => frappe.set_route("wa-devices") },
						});
					}
					if (!devices.length) {
						alerts.push({
							key: "no-device",
							tone: "blue",
							icon: "es-line-alert-circle",
							title: __("No device is paired"),
							note: __("Every message goes out through a device. Pair a phone to start sending."),
							action: is_manager() ? { label: __("Pair a device"), primary: true, handler: () => frappe.set_route("wa-devices") } : null,
						});
					} else if (
						!setup.setup_completed &&
						is_manager() &&
						(setup.steps || []).some((s) => !s.done)
					) {
						// no screen sets `setup_completed` yet, so the steps themselves decide (D-140)
						const steps = setup.steps || [];
						const done = steps.filter((s) => s.done).length;
						const linked = (steps.find((s) => s.key === "credentials") || {}).done;
						// Not linked to any account: that is not "setup", it is "you have no account
						// here yet" — say so, and lead straight to creating one or signing in.
						if (!linked) alerts.push({
							key: "setup",
							tone: "blue",
							icon: "es-line-alert-circle",
							title: __("This site is not connected to a WhatsApp account"),
							note: __("Create a free account (a full month, no card) or sign in to the one you have, and this site starts sending."),
							action: { label: __("Create an account or sign in"), handler: () => frappe.set_route("wa-onboarding") },
						});
						else alerts.push({
							key: "setup",
							tone: "blue",
							icon: "es-line-alert-circle",
							title: __("Setup is not finished — {0} of {1} steps done", [int(done), int(steps.length)]),
							note: (steps.find((s) => !s.done) || {}).detail || __("Finish the remaining steps to send reliably."),
							action: { label: __("Open setup"), handler: () => frappe.set_route("wa-onboarding") },
						});
					}

					// `role="alert"` re-announces on every re-render, and this block re-renders on
					// every realtime tick — so the band is only rewritten when it actually changed.
					const signature = alerts.map((a) => [a.key, a.title, a.note].join("|")).join("~");
					if (signature === this._alert_signature && $el.children().length === (alerts.length ? 1 : 0)) return;
					this._alert_signature = signature;
					$el.empty();
					if (!alerts.length) return;
					const $list = $('<div class="wa-home__alerts"></div>').appendTo($el);
					alerts.slice(0, 3).forEach((a) => {
						const $alert = $(`
							<div class="wa-home__alert sanad-tone--${a.tone}" role="${a.tone === "red" ? "alert" : "status"}">
								<span class="wa-home__alert-icon" aria-hidden="true">${ui.icon(a.icon, "sm")}</span>
								<div class="wa-home__alert-text">
									<strong class="wa-home__alert-title">${esc(a.title)}</strong>
									<span class="wa-home__alert-note">${esc(a.note)}</span>
								</div>
							</div>`).appendTo($list);
						if (a.action) {
							$(
								`<button type="button" class="btn btn-sm ${
									a.action.primary ? "btn-primary" : "btn-default"
								} wa-home__alert-action">${esc(a.action.label)}</button>`
							)
								.on("click", a.action.handler)
								.appendTo($alert);
						}
					});
				})
				.catch((err) => {
					$el.empty();
					new ui.EmptyState({
						wrapper: $el,
						state: "error",
						size: "sm",
						description: err.message,
						action: { label: __("Retry"), onclick: () => this.refresh() },
					});
				});
		}

		/** The resume confirmation states its cost before it runs (matrix §1B row 2). */
		resume_queue() {
			return ui.ConfirmDialog.ask({
				title: __("Resume sending?"),
				message: __("Resuming starts from the oldest pending message. You can pause again at any time from the queue."),
				load_impact: () =>
					ui.call("queue.get_summary").then((s) => {
						const waiting = cint((s.counts_by_status || {}).Queued) || cint(s.queued);
						const remaining = s.platform_queue && s.platform_queue.messages_remaining;
						const rows = [
							{ label: __("Messages sent immediately"), value: int(waiting) },
							{ label: __("Send rate"), value: __("{0} / minute", [int(s.rate)]) },
							{ label: __("Charged from the plan"), value: int(waiting), tone: "amber" },
						];
						if (remaining != null) rows.push({ label: __("Balance after sending"), value: int(Math.max(0, cint(remaining) - waiting)) });
						return rows;
					}),
				confirm_label: __("Resume sending"),
				on_confirm: () => ui.call("queue.resume_queue"),
			})
				.then(() => {
					ui.Toast.success(__("Sending resumed"));
					this.refresh();
				})
				.catch(() => {});
		}

		// ---- band 4: the period's five numbers, each with the shape behind it -------------------

		render_kpis($el) {
			if (!$el.find(".wa-home__kpis").length) {
				$el.html(`<div class="wa-home__kpis" role="group" aria-label="${esc(__("Message traffic"))}"></div>`);
			}
			const $row = $el.find(".wa-home__kpis");
			if (!$row.children().length) $row.html(ui.skeleton(5, { lines: 3 }));

			return Promise.all([this.traffic(), this.series(), this.dashboard()])
				.then(([t, s, data]) => this.paint_kpis($row, t, s, data))
				.catch((err) => {
					$row.empty();
					new ui.EmptyState({
						wrapper: $row,
						state: "error",
						size: "sm",
						description: err.message,
						action: { label: __("Retry"), onclick: () => this.refresh() },
					});
				});
		}

		/**
		 * One card per question an operator asks of a period, in the order they ask it: how much
		 * left, how much arrived, how much was opened, how much failed, how much is still moving.
		 * The sparkline is the same period's shape — never the only carrier of a value, which is
		 * always printed beside it.
		 */
		paint_kpis($row, t, s, data) {
			const counts = t.now;
			const handed = sum_of(counts, HANDED);
			const arrived = sum_of(counts, ARRIVED);
			const read = cint(counts.Read);
			const failed = cint(counts.Failed);
			const attempted = handed + failed;
			const previous = sum_of(t.previous, HANDED);
			const delta = previous ? Math.round(((handed - previous) * 1000) / previous) / 10 : null;
			const queue = data.queue || {};
			const in_flight = queue_open(queue);
			const period_filter = since(t);
			const series = (keys) => s.buckets.map((b) => keys.reduce((n, k) => n + cint(b.counts[k]), 0));

			const cards = [
				{
					key: "sent",
					label: __("Messages sent"),
					tone: "blue",
					icon: ui.icons.quick_send,
					value: int(handed),
					note:
						delta == null
							? __("no traffic in the period before")
							: delta >= 0
								? __("{0}% more than last period", [pct_text(Math.abs(delta))])
								: __("{0}% less than last period", [pct_text(Math.abs(delta))]),
					note_tone: delta == null ? "" : delta >= 0 ? "green" : "red",
					note_icon: delta == null ? "" : delta >= 0 ? "es-line-up" : "es-line-down",
					series: series(HANDED),
					goes: __("Opens the outbound log"),
					onclick: () => open_outbound({ ...period_filter, status: ["in", HANDED] }),
				},
				{
					key: "delivered",
					label: __("Delivery rate"),
					tone: "green",
					icon: "es-line-success",
					value: rate_text(arrived, handed),
					note: __("{0} of {1} arrived", [int(arrived), int(handed)]),
					series: series(ARRIVED),
					goes: __("Opens the messages that arrived"),
					onclick: () => open_outbound({ ...period_filter, status: ["in", ARRIVED] }),
				},
				{
					key: "read",
					label: __("Read rate"),
					tone: "cyan",
					icon: "es-line-double-check",
					value: rate_text(read, handed),
					note: ui.plural(read, { one: __("{0} message was opened"), other: __("{0} messages were opened") }),
					series: series(["Read"]),
					goes: __("Opens the messages that were opened"),
					onclick: () => open_outbound({ ...period_filter, status: "Read" }),
				},
				{
					key: "failed",
					label: __("Failure rate"),
					tone: "red",
					icon: "es-line-close-circle",
					value: rate_text(failed, attempted),
					value_tone: failed ? "red" : "",
					note: failed ? __("{0} of {1} attempts", [int(failed), int(attempted)]) : __("nothing failed"),
					series: series(["Failed"]),
					goes: __("Opens the failed messages"),
					onclick: () => open_outbound({ ...period_filter, status: "Failed" }),
				},
				{
					key: "waiting",
					label: __("In processing"),
					tone: "amber",
					icon: "es-line-progress",
					value: int(in_flight),
					note: queue.paused_globally ? __("Sending is paused") : in_flight ? __("waiting to go out") : __("the queue is empty"),
					note_tone: queue.paused_globally ? "amber" : "",
					series: series(["Waiting"]),
					goes: __("Opens the queue"),
					onclick: open_queue,
				},
			];

			$row.empty();
			cards.forEach((card) => {
				const $card = $(`
					<button type="button" class="wa-home__kpi" data-key="${esc(card.key)}">
						<span class="wa-home__kpi-head">
							<span class="wa-home__kpi-dot sanad-tone--${esc(card.tone)}" aria-hidden="true"></span>
							<span class="wa-home__kpi-label">${esc(card.label)}</span>
							<span class="wa-home__kpi-icon sanad-tone--${esc(card.tone)}" aria-hidden="true">${ui.icon(card.icon, "sm")}</span>
						</span>
						<span class="wa-home__kpi-value sanad-tabular${card.value_tone ? ` sanad-tone--${esc(card.value_tone)}` : ""}">${esc(
							card.value
						)}</span>
						<span class="wa-home__kpi-foot">
							<span class="wa-home__kpi-note${card.note_tone ? ` sanad-tone--${esc(card.note_tone)}` : ""}">${
								card.note_icon ? ui.icon(card.note_icon, "xs") : ""
							}${esc(card.note)}</span>
							${this.spark_html(card.series, card.tone)}
						</span>
						<span class="sanad-visually-hidden">${esc(card.goes)}</span>
					</button>`).appendTo($row);
				$card.on("click", card.onclick);
			});
		}

		/**
		 * The period's shape in 56 × 22 px. The SVG does not flip with the document, so it is
		 * mirrored by hand in RTL (`_home.scss`) — otherwise the oldest bucket would sit under
		 * "now". A flat or empty series still draws its baseline: a card that loses its line
		 * reads as broken.
		 */
		spark_html(values, tone) {
			const points = (values || []).map((n) => cint(n));
			if (points.length < 2) return '<span class="wa-home__kpi-spark" aria-hidden="true"></span>';
			const max = Math.max.apply(null, points.concat([1]));
			const step = 100 / (points.length - 1);
			const path = points.map((n, i) => `${(i * step).toFixed(2)},${(100 - (n / max) * 92 - 4).toFixed(2)}`).join(" ");
			return `<span class="wa-home__kpi-spark sanad-tone--${esc(tone)}" aria-hidden="true">
				<svg viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false">
					<polyline points="${path}"></polyline>
				</svg>
			</span>`;
		}

		// ---- band 5: the evidence — volume over the period, beside the failures that explain it --

		render_evidence($el) {
			const p = period_of(this.period);
			if (!$el.find(".wa-home__evidence").length) {
				$el.html(`
					<div class="wa-home__evidence">
						<section class="wa-home__card wa-home__volume" aria-labelledby="wa-home-vol-title">
							<header class="wa-home__card-head">
								<div class="wa-home__card-text">
									<h3 class="wa-home__card-title" id="wa-home-vol-title"></h3>
									<p class="wa-home__card-note"></p>
								</div>
								<div class="wa-home__card-aside">
									<span class="wa-home__card-total sanad-tabular"></span>
									<button type="button" class="wa-ops__link wa-home__volume-all">${esc(__("See all"))}</button>
								</div>
							</header>
							<div class="wa-home__card-body"></div>
						</section>
						<section class="wa-home__card wa-home__failures" aria-labelledby="wa-home-fail-title">
							<header class="wa-home__card-head">
								<div class="wa-home__card-text">
									<h3 class="wa-home__card-title" id="wa-home-fail-title">${esc(__("Failures by error"))}</h3>
									<p class="wa-home__card-note">${esc(__("Largest first — open a row for just those messages."))}</p>
								</div>
								<div class="wa-home__card-aside">
									<button type="button" class="wa-ops__link wa-home__failures-all">${esc(__("See all"))}</button>
								</div>
							</header>
							<div class="wa-home__card-body"></div>
						</section>
					</div>`);
				// bound once, read at click time: the period may have changed since
				$el.find(".wa-home__volume-all").on("click", () => open_outbound(since(this._shown_traffic)));
				$el.find(".wa-home__failures-all").on("click", () => open_outbound({ ...since(this._shown_traffic), status: "Failed" }));
			}
			$el.find("#wa-home-vol-title").text(__("Message volume — {0}", [p.window()]));
			$el.find(".wa-home__volume .wa-home__card-note").text(
				p.grain === "hour"
					? __("One column per hour — open a column for that hour's messages.")
					: __("One column per day — open a column for that day's messages.")
			);

			const $vol = $el.find(".wa-home__volume .wa-home__card-body");
			const $fails = $el.find(".wa-home__failures .wa-home__card-body");
			const vol_state = body_state($vol, 4);
			const fail_state = body_state($fails, 4);

			return Promise.all([this.traffic(), this.series()])
				.then(([t, s]) => {
					this._shown_traffic = t;
					// the total is the sum of the columns under it, so it counts every band drawn —
					// the waiting one too
					$el.find(".wa-home__card-total").text(__("{0} messages", [int(sum_of(t.now, [...HANDED, ...WAITING, "Failed"]))]));
					this.paint_volume($vol, vol_state, s);
					this.paint_failures($fails, fail_state, t);
				})
				.catch((err) => {
					vol_state.error(err, { action: { label: __("Retry"), onclick: () => this.refresh() } });
					fail_state.hide();
				});
		}

		/**
		 * The period drawn as one column per bucket, each column split by what became of the
		 * messages that started in it. Colour names a band in the legend and in every column's
		 * own label, so the drawing is never the only place the split exists; the column is a
		 * button, because "what happened on Tuesday" is a question with an answer.
		 */
		paint_volume($el, state, s) {
			const buckets = s.buckets || [];
			const total = buckets.reduce((n, b) => n + cint(b.total), 0);
			if (!total) {
				state.set("empty", {
					title: __("No messages in this period"),
					description: __("Nothing was sent or received in this period. Try a wider one."),
					size: "sm",
				});
				return;
			}
			state.hide();
			$el.empty();

			const peak = Math.max.apply(null, buckets.map((b) => cint(b.total)).concat([1]));
			const step = nice_step(peak);
			const max = step * 3;
			const ticks = [max, step * 2, step, 0];
			const legend = BANDS.map(
				(band) =>
					`<li class="wa-home__legend-item"><span class="wa-home__swatch wa-home__swatch--${band.seg}" aria-hidden="true"></span>${esc(
						band.label()
					)}</li>`
			).join("");

			const columns = buckets
				.map((b) => {
					const parts = BANDS.filter((band) => cint(b.counts[band.key])).map((band) =>
						__("{0} {1}", [band.label(), int(b.counts[band.key])])
					);
					const title = cint(b.total)
						? __("{0}: {1} messages — {2}", [b.name, int(b.total), parts.join(__(", "))])
						: __("{0}: no messages", [b.name]);
					const stack = BANDS.filter((band) => cint(b.counts[band.key]))
						.map(
							(band) =>
								`<span class="wa-home__seg wa-home__seg--${band.seg}" style="block-size:${((cint(b.counts[band.key]) / max) * 100).toFixed(
									2
								)}%"></span>`
						)
						.join("");
					return `<li class="wa-home__col">
						<button type="button" class="wa-home__col-btn" data-from="${esc(b.from)}" data-to="${esc(b.to)}" title="${esc(title)}" aria-label="${esc(title)}">
							<span class="wa-home__stack">${stack || '<span class="wa-home__seg wa-home__seg--none"></span>'}</span>
						</button>
						<span class="wa-home__col-tick" aria-hidden="true">${esc(b.tick)}</span>
					</li>`;
				})
				.join("");

			const $fig = $(`
				<figure class="wa-home__plot">
					<ul class="wa-home__legend">${legend}</ul>
					<div class="wa-home__grid">
						<div class="wa-home__rules" aria-hidden="true">
							${ticks.map((v) => `<span class="wa-home__rule"><i class="sanad-tabular">${esc(int(v))}</i></span>`).join("")}
						</div>
						<ol class="wa-home__cols">${columns}</ol>
					</div>
					<figcaption class="sanad-visually-hidden">${esc(
						__("{0} messages over {1} columns; the busiest column holds {2}.", [int(total), int(buckets.length), int(peak)])
					)}</figcaption>
				</figure>`).appendTo($el);

			$fig.find(".wa-home__col-btn").on("click", function () {
				// one bucket: its own window replaces the period's
				const $b = $(this);
				open_outbound({ creation: ["between", [$b.data("from"), $b.data("to")]] });
			});
		}

		/**
		 * Failures by error, largest first — a horizontal bar per error with its own count and
		 * share, because a reader has to know which one error is worth chasing. Each row is the
		 * filter that opens exactly those messages.
		 */
		paint_failures($el, state, t) {
			const period_filter = since(t);
			const rows = Object.entries(t.errors)
				.map(([code, count]) => ({ code, count: cint(count), label: error_label(code) }))
				.filter((r) => r.count)
				.sort((a, b) => b.count - a.count);
			const total = rows.reduce((n, r) => n + r.count, 0);
			const attempted = sum_of(t.now, HANDED) + cint(t.now.Failed);

			if (!rows.length) {
				state.set("empty", {
					title: __("Nothing failed"),
					description: __("Everything that was sent in this period was accepted. Try a wider period to chase an older error."),
					size: "sm",
				});
				return;
			}
			state.hide();
			$el.empty();
			const max = rows[0].count;
			const $fig = $(`
				<div class="wa-home__fails">
					<ul class="wa-home__fail-list"></ul>
					<div class="wa-home__fails-foot">
						<span>${esc(__("Total failures"))}</span>
						<span class="sanad-tabular sanad-tone--red">${esc(int(total))}</span>
						<span>${esc(__("Failure rate"))}</span>
						<span class="sanad-tabular sanad-tone--red">${esc(rate_text(total, attempted))}</span>
					</div>
				</div>`).appendTo($el);
			const $list = $fig.find(".wa-home__fail-list");
			rows.slice(0, FAIL_LIMIT).forEach((r) => {
				$(`
					<li>
						<button type="button" class="wa-home__fail" data-code="${esc(r.code)}">
							<span class="wa-home__fail-label">${esc(r.label)}</span>
							<span class="wa-home__fail-bar" aria-hidden="true"><span style="inline-size:${((r.count / max) * 100).toFixed(1)}%"></span></span>
							<span class="wa-home__fail-share sanad-tabular">${esc(rate_text(r.count, total))}</span>
							<span class="wa-home__fail-count sanad-tabular">${esc(int(r.count))}</span>
						</button>
					</li>`).appendTo($list);
			});
			$list.find(".wa-home__fail").on("click", function () {
				const code = $(this).data("code");
				// "No code recorded" is its own row, so it opens only the failures without a code
				open_outbound({ ...period_filter, status: "Failed", error_code: code ? code : ["is", "not set"] });
			});
		}

		// ---- band 6: the four panels -------------------------------------------------------

		render_panels($el) {
			if (!$el.find(".wa-home__panels").length) {
				$el.html('<div class="wa-home__panels"></div>');
			}
			const $grid = $el.find(".wa-home__panels");
			const panel = (key) => {
				let $p = $grid.find(`[data-panel="${key}"]`);
				if (!$p.length) {
					$p = $(`
						<section class="wa-home__card wa-home__panel" data-panel="${key}">
							<header class="wa-home__card-head">
								<div class="wa-home__card-text">
									<h3 class="wa-home__card-title"></h3>
									<p class="wa-home__card-note"></p>
								</div>
								<div class="wa-home__card-aside"></div>
							</header>
							<div class="wa-home__card-body"></div>
						</section>`).appendTo($grid);
				}
				return $p;
			};
			const head = ($p, title, note, cta) => {
				$p.find(".wa-home__card-title").text(title);
				$p.find(".wa-home__card-note").text(note || "");
				const $cta = $p.find(".wa-home__card-aside").empty();
				if (!cta) return;
				$(`<button type="button" class="wa-ops__link wa-home__card-link">${esc(cta.label)}</button>`)
					.on("click", cta.handler)
					.appendTo($cta);
			};

			return Promise.all([
				this.render_feed(panel("feed"), head),
				this.render_campaigns(panel("campaigns"), head),
				this.render_devices(panel("devices"), head),
			]);
		}

		render_feed($p, head) {
			head(
				$p,
				__("Live flow"),
				__("The last five movements, in and out"),
				is_agent() ? { label: __("Send a message"), handler: () => new ui.QuickSend({ on_sent: () => this.refresh() }) } : null
			);
			const $body = $p.find(".wa-home__card-body");
			const state = body_state($body, 5);
			return Promise.all([ui.meta.with_doctype(OUT), ui.meta.with_doctype(IN), this.feed()])
				.then(([, , rows]) => {
					if (!rows.length) {
						return state.set("empty", {
							title: __("No messages yet"),
							description: __("Everything sent or received shows up here as it happens."),
							size: "sm",
							action: is_agent() ? { label: __("Send a message"), onclick: () => new ui.QuickSend({ on_sent: () => this.refresh() }) } : undefined,
						});
					}
					state.hide();
					ui.Render.list($body, rows, {
						density: "row",
						profile: {
							status: (doc) =>
								doc._direction === "in"
									? { label: __("Received"), colour: "green" }
									: { label: __(doc.status), colour: OUT_TONE[doc.status] || "gray" },
							lines: [
								(doc) => __("{0} · {1}", [doc._direction === "in" ? __("Inbound") : __("Outbound"), clock(doc._at)]),
							],
							value: false,
							facts: false,
						},
						on_click: (doc) =>
							doc.doctype === OUT
								? whatsapp_next.messages.open_outbound_drawer(doc.name, { after_change: () => this.refresh() })
								: frappe.set_route("Form", IN, doc.name),
					});
				})
				.catch((err) => state.error(err, { action: { label: __("Retry"), onclick: () => this.refresh() } }));
		}

		render_campaigns($p, head) {
			const $body = $p.find(".wa-home__card-body");
			const state = body_state($body, 4);
			return Promise.all([ui.meta.with_doctype(CAMP), this.dashboard(), this.scheduled()])
				.then(([, data, scheduled]) => {
					const live = (data.campaigns_sending || []).map((r) => Object.assign({ doctype: CAMP }, r, C.counters_as_doc(r)));
					const order = { Running: 0, Queued: 1, Paused: 2, Scheduled: 3 };
					const rows = live
						.concat((scheduled || []).map((r) => Object.assign({ doctype: CAMP }, r)))
						.sort((a, b) => cint(order[a.status]) - cint(order[b.status]))
						.slice(0, PANEL_LIMIT);
					head($p, __("Active campaigns"), rows.length ? __("Running, paused and scheduled") : __("Nothing is scheduled"), {
						label: __("See all"),
						handler: () => frappe.set_route("List", CAMP),
					});
					if (!rows.length) {
						return state.set("empty", {
							title: __("No campaign is active"),
							description: __("A campaign sends one message to many numbers at a controlled rate."),
							size: "sm",
							action: C.is_manager() ? { label: __("New campaign"), onclick: () => frappe.new_doc(CAMP) } : undefined,
						});
					}
					state.hide();
					ui.Render.list($body, rows, {
						density: "row",
						profile: {
							progress: false,
							value: false,
							facts: false,
							status: (doc) => ({ label: __(doc.status), colour: C.INDICATOR[doc.status] || "gray" }),
							lines: [
								(doc) =>
									doc.status === "Scheduled"
										? __("{0} recipients · starts {1}", [int(doc.total_recipients), clock(doc.scheduled_at)])
										: __("{0} of {1} recipients", [int(C.handed_of_doc(doc)), int(doc.total_recipients)]),
							],
						},
						on_click: (doc) => frappe.set_route("Form", CAMP, doc.name),
					});
				})
				.catch((err) => state.error(err, { action: { label: __("Retry"), onclick: () => this.refresh() } }));
		}

		render_devices($p, head) {
			const $body = $p.find(".wa-home__card-body");
			const state = body_state($body, 4);
			return Promise.all([ui.meta.with_doctype(DEV), this.dashboard()])
				.then(([, data]) => {
					const rows = (data.devices || []).map((r) => Object.assign({ doctype: DEV }, r));
					const connected = rows.filter((r) => r.status === "Connected").length;
					head($p, __("Device status"), rows.length ? __("{0} of {1} connected", [int(connected), int(rows.length)]) : __("None paired"), {
						label: __("See all"),
						handler: () => frappe.set_route("wa-devices"),
					});
					if (!rows.length) {
						return state.set("empty", {
							title: __("No device is paired"),
							description: __("Every message goes out through a device."),
							size: "sm",
							action: is_manager() ? { label: __("Pair a device"), onclick: () => frappe.set_route("wa-devices") } : undefined,
						});
					}
					state.hide();
					ui.Render.list($body, rows.slice(0, PANEL_LIMIT), {
						density: "row",
						profile: {
							value: false,
							facts: false,
							status: (doc) => {
								const s = DEVICE_STATE[doc.status] || { tone: "gray", label: () => __(doc.status || "Unknown") };
								return { label: s.label(), colour: s.tone };
							},
							lines: [
								(doc) =>
									doc.status === "Connected"
										? doc.last_seen
											? __("Seen {0}", [ago(doc.last_seen)])
											: __("Connected")
										: doc.last_error || __("Not sending"),
							],
						},
						on_click: () => frappe.set_route("wa-devices"),
					});
				})
				.catch((err) => state.error(err, { action: { label: __("Retry"), onclick: () => this.refresh() } }));
		}

		// ---- realtime (matrix §1C row 2) ------------------------------------------------------

		bind_realtime() {
			if (this._handlers) return;
			const refresh = ui.throttle(() => this.refresh(), 2000);
			this._handlers = {
				"wa:device:status": (data) => {
					const state = DEVICE_STATE[data && data.status];
					if (state) ui.announce(__("A device is now {0}.", [state.label()]));
					refresh();
				},
				"wa:queue:progress": () => refresh(),
				"wa:message:status": () => refresh(),
				"wa:campaign:status": () => refresh(),
				"wa:inbound:received": () => refresh(),
			};
			Object.entries(this._handlers).forEach(([event, fn]) => frappe.realtime.on(event, fn));
			// Not everything the board shows raises an event (plan usage, the platform's health,
			// "last sent … ago"): the whole board is re-read once a minute, while it can be seen.
			this._tick = window.setInterval(() => {
				if (document.visibilityState === "visible") refresh();
			}, 60 * 1000);
		}

		unbind_realtime() {
			if (!this._handlers) return;
			Object.entries(this._handlers).forEach(([event, fn]) => frappe.realtime.off(event, fn));
			this._handlers = null;
			window.clearInterval(this._tick);
			this._tick = null;
		}

		destroy() {
			this.unbind_realtime();
		}
	}

	whatsapp_next.home.HomeScreen = HomeScreen;

	// Spec #1: the redirect to the Onboarding Wizard lives in `desk/setup_redirect.js`, for every
	// screen of the product. Home asks it before building, so its reads never run behind the redirect.
	const redirect_to_wizard = () => whatsapp_next.setup.redirect_to_wizard(["wa-home"]);

	frappe.pages["wa-home"].on_page_load = function (wrapper) {
		wrapper.wa_page = frappe.ui.make_app_page({ parent: wrapper, title: __("Home"), single_column: true });
		// the screen is built only once the redirect has answered, so its reads never run behind it
		wrapper.wa_waiting = true;
		redirect_to_wizard().then((sent) => {
			wrapper.wa_waiting = false;
			if (!sent && !wrapper.wa_home) wrapper.wa_home = new HomeScreen({ page: wrapper.wa_page, wrapper });
			// the site was linked to another account and what the previous one left waits for a decision
			if (!sent) whatsapp_next.account_switch.check();
		});
	};

	frappe.pages["wa-home"].on_page_show = function (wrapper) {
		if (wrapper.wa_waiting) return;
		if (!wrapper.wa_home) {
			wrapper.wa_home = new HomeScreen({ page: wrapper.wa_page, wrapper });
			return;
		}
		wrapper.wa_home.bind_realtime();
		wrapper.wa_home.refresh();
	};
})();

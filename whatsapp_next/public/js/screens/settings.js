// Screen 15 — Subscription, usage and settings (spec §2 row 15, §5.7; D-138).
//
// A window, not a page: `sanad.ui.SettingsWindow` in claude.ai's shape — search, the sections in
// two groups ("Account": subscription, usage, audit log; "Settings": the platform link and every
// sending setting), one pane that scrolls by itself. It opens over whatever screen the user is on,
// from the sidebar's "Settings" item and from every link that used to route to the page; the
// `wa-settings` route itself only opens it.
//
// The window adds no storage: it is a presentation layer over the existing `WhatsApp Settings`
// Single. Every value is read with `settings.get_settings(section)` and written with
// `settings.save_settings(section, values)`; the labels, types and options of the fields come
// from the Single's own meta, never from a list written here. Secrets are never displayed: the
// API returns `has_<field>` booleans and this window draws "Stored" / "Not set" (.claude/rules/
// security.md). Billing actions (top up the wallet, upgrade the plan, invoice settings) are not
// rendered until the platform ships them (backend G-6 / OQ-6).

frappe.provide("whatsapp_next.settings");

const SINGLE = "WhatsApp Settings";

const IS_SM = () => frappe.user.has_role("System Manager");
const IS_MGR = () => frappe.user.has_role(["WhatsApp Manager", "System Manager"]);

// Fields the generic form never draws, because this window gives them a control of their own.
const SKIP_IN_FORM = ["webhook_events", "picker_sources"];

// How a few fields differ from what their docfield says. Everything else follows the docfield's
// own `read_only` flag, so the form stays meta-driven rather than hand-listed.
const OWNED_ELSEWHERE = {
	webhook_events: "events_checklist", // settings.set_webhook_events
	picker_sources: "picker_editor", // its own table editor
	messages_per_minute: "read_only", // queue.set_rate, on the Queue screen
	plan_features: "json_list",
	last_connection_error: "long_text",
	queue_pause_reason: "long_text",
};

// the section a link from before the window asked for, by its old key
const ALIASES = { billing: "subscription", plan: "subscription" };

class SettingsView {
	constructor() {
		this.sections = this.section_list();
		this.win = new sanad.ui.SettingsWindow({
			title: __("Settings"),
			cls: "wa-settings-window",
			groups: this.groups(),
			render: (key, $pane) => this.draw(key, $pane),
			on_close: () => {
				this.unbind_realtime();
				const after = this.after_close;
				this.after_close = null;
				if (typeof after === "function") after();
			},
		});
	}

	/**
	 * Open the window on `key` (or where it was left). The Single's meta is loaded once.
	 * `on_close` runs once, when this opening of the window is closed.
	 */
	open(key, { on_close } = {}) {
		this.after_close = on_close || null;
		key = ALIASES[key] || key;
		if (key && !this.sections.find((s) => s.key === key)) key = null;
		this.bind_realtime();
		const ready = this.meta ? Promise.resolve() : sanad.ui.meta.with_doctype(SINGLE).then((m) => (this.meta = m));
		return ready.then(() => this.win.show_window(key || null));
	}

	// ---- the section list -------------------------------------------------------------------

	section_list() {
		const all = [
			{ key: "subscription", group: "account", label: __("Subscription and plan"), icon: "card", manager: true, keywords: __("wallet renewal billing") },
			{ key: "usage", group: "account", label: __("Usage", null, "Settings window"), icon: "chart", keywords: __("messages per day consumption") },
			{ key: "audit", group: "account", label: __("Audit log"), icon: "note", manager: true },
			{ key: "provider", group: "settings", label: __("Platform link"), icon: "link", manager: true },
			{ key: "credentials", group: "settings", label: __("Credentials"), icon: "shield", manager: true, keywords: __("keys secret") },
			{ key: "webhook", group: "settings", label: __("Webhook"), icon: "hook", manager: true },
			{ key: "queue", group: "settings", label: __("Queue"), icon: "queue", manager: true, keywords: __("rate retry pause") },
			{ key: "commands", group: "settings", label: __("Commands"), icon: "bolt", manager: true },
			{ key: "policy", group: "settings", label: __("Policy"), icon: "gear", manager: true, keywords: __("blacklist country device") },
			{ key: "picker", group: "settings", label: __("Picker sources"), icon: "users", manager: true },
			{ key: "retention", group: "settings", label: __("Retention"), icon: "clock", manager: true },
		];
		return all.filter((s) => !s.manager || IS_MGR());
	}

	groups() {
		const labels = { account: __("Account"), settings: __("Settings") };
		return ["account", "settings"]
			.map((g) => ({ label: labels[g], items: this.sections.filter((s) => s.group === g) }))
			.filter((g) => g.items.length);
	}

	/** Navigate inside the window — the renderers call this after a save or to point elsewhere. */
	show(key) {
		return this.win.show(key);
	}

	get current() {
		return this.win.current;
	}

	draw(key, $pane) {
		const section = this.sections.find((s) => s.key === key) || this.sections[0];
		this.$root = $('<div class="wa-settings"></div>').appendTo($pane);
		this.$root.append(sanad.ui.SettingsWindow.head_html(section.label, this.blurb(section.key)));
		this.$content = $('<div class="wa-settings__pane-body"></div>').appendTo(this.$root);
		this.state = new sanad.ui.EmptyState({ wrapper: this.$content, state: "loading", rows: 4 });
		const renderer = this[`render_${section.key}`];
		if (typeof renderer !== "function") return this.state.empty({ title: __("Nothing to show") });
		return Promise.resolve(renderer.call(this, this.$content)).catch((err) =>
			this.state.error(err, { action: { label: __("Retry"), onclick: () => this.show(section.key) } })
		);
	}

	/** True when the last connection check passed — the platform calls are worth making. */
	static linked(status) {
		return !!((status || {}).steps || []).find((s) => s.key === "connection" && s.done);
	}

	blurb(key) {
		return {
			provider: __("Which platform sends your messages, and whether this site can reach it."),
			credentials: __("Stored encrypted and shown once when they are generated. They are never displayed again."),
			webhook: __("Without it no inbound message and no status update reaches this site."),
			queue: __("How fast messages leave, how often a failure is retried, and whether sending is paused."),
			commands: __("Replies to keywords arriving on WhatsApp."),
			policy: __("The default device and country, the global blacklist and who may be messaged."),
			picker: __("The system screens the contact picker may select recipients from."),
			retention: __("How long messages, queue rows, webhook events and the audit log are kept."),
			subscription: __("Messages come out of the plan first; what goes beyond it comes out of the wallet. Billing is handled on the platform."),
			usage: __("What this site sent day by day: delivered, read and failed."),
			audit: __("Every elevated write: who did it, to what, and when."),
		}[key] || "";
	}

	// ---- the meta-driven form ----------------------------------------------------------------

	docfield(fieldname) {
		return (this.meta.fields || []).find((df) => df.fieldname === fieldname) || null;
	}

	/**
	 * Draw one section's values: read-only fields as a definition list, writable ones as real
	 * Frappe controls with one Save. `skip` names the fields the caller draws itself.
	 */
	render_fields($el, section, values, skip = []) {
		const esc = frappe.utils.escape_html;
		const fieldnames = Object.keys(values || {}).filter(
			(f) => !f.startsWith("has_") && !skip.includes(f) && this.docfield(f)
		);
		const controls = {};
		const $read = $('<dl class="wa-settings__facts"></dl>');
		const $form = $('<div class="wa-settings__form"></div>');
		fieldnames.forEach((fieldname) => {
			const df = this.docfield(fieldname);
			if (sanad.ui.meta.is_layout(df)) return;
			const special = OWNED_ELSEWHERE[fieldname];
			const read_only = !!df.read_only || special === "read_only" || !IS_SM();
			if (read_only) {
				$read.append(
					`<div><dt>${esc(__(df.label || fieldname))}</dt><dd>${this.read_value(
						df,
						values[fieldname],
						special
					)}</dd></div>`
				);
				return;
			}
			const control = frappe.ui.form.make_control({
				df: Object.assign({}, df, { depends_on: null, read_only: 0 }),
				parent: $form,
				render_input: true,
			});
			control.set_value(values[fieldname] == null ? "" : values[fieldname]);
			control.refresh();
			// Desk draws the label as a plain <label> with no `for`, so the input has no
			// accessible name of its own; it is given one here
			if (control.$input) control.$input.attr("aria-label", __(df.label || fieldname));
			// a row in Claude's shape: the explanation sits under the title, not under the input
			control.$wrapper.find(".control-input-wrapper > .help-box").insertAfter(control.$wrapper.find(".clearfix"));
			controls[fieldname] = control;
		});
		const has_controls = Object.keys(controls).length > 0;
		if ($read.children().length) {
			if (has_controls) {
				$el.append(
					`<h4 class="wa-settings__subhead">${esc(__("Read only"))}</h4>`
				);
			}
			$el.append($read);
		}
		if (has_controls) {
			if ($read.children().length) {
				$el.append(`<h4 class="wa-settings__subhead">${esc(__("Editable"))}</h4>`);
			}
			$el.append($form);
			const $save = $(
				`<div class="wa-settings__actions"><button type="button" class="btn btn-sm btn-primary">${esc(
					__("Save changes")
				)}</button></div>`
			).appendTo($el);
			$save.find("button").on("click", () => {
				const payload = {};
				Object.entries(controls).forEach(([f, c]) => (payload[f] = c.get_value()));
				sanad.ui
					.call("settings.save_settings", { section, values: payload }, { freeze: true })
					.then((r) =>
						sanad.ui.Toast.success(
							r && r.changed && r.changed.length
								? sanad.ui.plural(r.changed.length, {
										one: __("Saved {0} setting"),
										other: __("Saved {0} settings"),
								  })
								: __("Nothing to save")
						)
					)
					.catch((err) => sanad.ui.Toast.error(err));
			});
		}
		if (!$read.children().length && !has_controls) {
			new sanad.ui.EmptyState({
				wrapper: $el,
				state: "empty",
				size: "sm",
				title: __("Nothing to configure here"),
			});
		}
		return controls;
	}

	read_value(df, value, special) {
		const esc = frappe.utils.escape_html;
		if (value == null || value === "") return `<span class="wa-settings__muted">&mdash;</span>`;
		if (special === "json_list") {
			let data = value;
			try {
				data = typeof value === "string" ? JSON.parse(value) : value;
			} catch (e) {
				return esc(String(value));
			}
			const entries = Object.entries(data || {});
			if (!entries.length) return `<span class="wa-settings__muted">&mdash;</span>`;
			return `<ul class="wa-settings__minilist">${entries
				.map(([k, v]) => `<li><span>${esc(k)}</span><span>${esc(String(v))}</span></li>`)
				.join("")}</ul>`;
		}
		if (special === "long_text") return `<span class="wa-settings__longtext">${esc(String(value))}</span>`;
		if (df.fieldtype === "Check") return esc(cint(value) ? __("Yes") : __("No"));
		return sanad.ui.meta.format(value, df) || esc(String(value));
	}

	// ---- shared pieces ------------------------------------------------------------------------

	banner($el, { tone, icon, title, text, action }) {
		const esc = frappe.utils.escape_html;
		const $b = $(`<div class="wa-settings__banner sanad-tone--${sanad.ui.tone(tone)}" role="${
			tone === "red" ? "alert" : "status"
		}">
			<span class="wa-settings__banner-icon" aria-hidden="true">${sanad.ui.icon(icon, "md")}</span>
			<span class="wa-settings__banner-text"><strong>${esc(title)}</strong><span>${esc(text || "")}</span></span>
		</div>`).appendTo($el);
		if (action) {
			$(
				`<button type="button" class="btn btn-sm ${
					action.primary ? "btn-primary" : "btn-default"
				}">${esc(action.label)}</button>`
			)
				.on("click", () => action.handler())
				.appendTo($b);
		}
		return $b;
	}

	panel($el, { title, note, action }) {
		const esc = frappe.utils.escape_html;
		const $p = $(`<section class="wa-settings__panel">
			<header>
				<span><strong>${esc(title)}</strong>${note ? `<span>${esc(note)}</span>` : ""}</span>
			</header>
			<div class="wa-settings__panel-body"></div>
		</section>`).appendTo($el);
		if (action) {
			$(`<button type="button" class="btn btn-xs btn-default">${esc(action.label)}</button>`)
				.on("click", () => action.handler())
				.appendTo($p.find("header"));
		}
		return $p.find(".wa-settings__panel-body");
	}

	/**
	 * A panel's label / value rows. `ltr` isolates a number or a URL, `stacked` puts a long value
	 * on its own line, `badge` draws a StatusBadge instead of text. Values are plain strings —
	 * nothing here renders HTML a Frappe helper produced.
	 */
	rows($el, rows) {
		const esc = frappe.utils.escape_html;
		$el.html(
			`<ul class="wa-settings__rows">${rows
				.map(
					(r) =>
						`<li class="${r.stacked ? "wa-settings__row--stacked" : ""}"><span class="wa-settings__row-label">${esc(
							r.label
						)}${r.sub ? `<span>${esc(r.sub)}</span>` : ""}</span><span class="wa-settings__row-value${
							r.ltr ? " sanad-table__ltr" : ""
						}">${
							r.badge
								? sanad.ui.StatusBadge.html({ label: r.badge, colour: r.colour || "gray" })
								: esc(r.value == null || r.value === "" ? "—" : String(r.value))
						}</span></li>`
				)
				.join("")}</ul>`
		);
	}

	// ---- 1. platform link -----------------------------------------------------------------------

	render_provider($el) {
		return Promise.all([
			sanad.ui.call("settings.get_settings", { section: "provider" }),
			sanad.ui.call("onboarding.get_status"),
		]).then(([data, status]) => {
			const values = data.provider || {};
			this.state.hide();
			$el.empty();
			const ok = values.connection_status === "OK";
			const tested = values.last_connection_test_at;
			this.banner($el, {
				tone: ok ? "green" : values.connection_status === "Failed" ? "red" : "amber",
				icon: ok ? "es-line-success" : "es-line-alert-triangle",
				title: ok
					? __("The platform link is live.")
					: values.connection_status === "Failed"
					? __("The platform cannot be reached.")
					: __("The platform link has not been tested."),
				text: tested
					? values.last_connection_latency_ms
						? __("Last check {0} · answered in {1} ms", [
								frappe.datetime.str_to_user(tested),
								sanad.ui.format_int(values.last_connection_latency_ms),
						  ])
						: __("Last check {0}", [frappe.datetime.str_to_user(tested)])
					: __("Run a check to see whether the credentials and the address work."),
				action: IS_MGR()
					? {
							label: __("Test the connection"),
							handler: () =>
								sanad.ui
									.call("settings.test_connection", {}, { freeze: true })
									.then((r) => {
										r && r.ok
											? sanad.ui.Toast.success(__("Connection is healthy ({0} ms)", [r.latency_ms]))
											: sanad.ui.Toast.error(r && r.error ? r.error : __("The connection failed"));
										this.show("provider");
									})
									.catch((err) => sanad.ui.Toast.error(err)),
					  }
					: null,
			});

			const $cols = $('<div class="wa-settings__cols"></div>').appendTo($el);
			const $connection = this.panel($cols, {
				title: __("Connection"),
				note: __("Written by the last test, never by hand."),
			});
			// the stored enum is a machine value ("OK"); the row says it the way a person would
			const CONNECTION = {
				OK: __("Healthy"),
				Failed: __("Not reachable"),
				Untested: __("Not tested yet"),
			};
			this.rows($connection, [
				{
					label: __("Status"),
					badge: CONNECTION[values.connection_status] || CONNECTION.Untested,
					colour: ok ? "green" : values.connection_status === "Failed" ? "red" : "orange",
				},
				{
					label: __("Last test"),
					value: tested ? frappe.datetime.str_to_user(tested) : __("Not tested yet"),
				},
				{
					label: __("Response time"),
					value: values.last_connection_latency_ms
						? __("{0} ms", [sanad.ui.format_int(values.last_connection_latency_ms)])
						: null,
				},
				{ label: __("Last error"), value: values.last_connection_error },
			]);
			const $steps = this.panel($cols, {
				title: __("Setup steps"),
				note: __("{0} of {1} done", [
					(status.steps || []).filter((s) => s.done).length,
					(status.steps || []).length,
				]),
			});
			const STEP_LABEL = {
				credentials: __("Platform credentials"),
				connection: __("Connection to the platform"),
				device: __("A connected device"),
				webhook: __("An active webhook"),
			};
			this.rows(
				$steps,
				(status.steps || []).map((s) => ({
					label: STEP_LABEL[s.key] || s.key,
					sub: s.detail || "",
					badge: s.done ? __("Done") : __("Missing"),
					colour: s.done ? "green" : "orange",
				}))
			);
			const $form = $('<section class="wa-settings__panel"></section>').appendTo($el);
			$form.append(
				`<header><span><strong>${frappe.utils.escape_html(__("Provider"))}</strong><span>${frappe.utils.escape_html(
					__("Which provider this site sends through, and where it lives.")
				)}</span></span></header>`
			);
			this.render_fields(
				$('<div class="wa-settings__panel-body wa-settings__pane-body"></div>').appendTo($form),
				"provider",
				values,
				["connection_status", "last_connection_test_at", "last_connection_latency_ms", "last_connection_error"]
			);
		});
	}

	// ---- 2. credentials ---------------------------------------------------------------------------

	render_credentials($el) {
		return Promise.all([
			sanad.ui.call("settings.get_settings", { section: "credentials" }),
			sanad.ui.call("settings.get_settings", { section: "webhook" }),
			frappe.db.count("WhatsApp Device"),
		]).then(([creds, webhook, devices]) => {
			const values = creds.credentials || {};
			this.state.hide();
			$el.empty();
			// no banner here: the section's own blurb already says the keys are stored encrypted and
			// shown once, and the panel's note repeats it beside the rotate action. A banner that
			// carries no state is a third copy of the same sentence.
			const $body = this.panel($el, {
				title: __("Credentials"),
				note: __("Stored encrypted · shown once when generated"),
				action: IS_SM()
					? { label: __("Rotate credentials"), handler: () => this.rotate_credentials(devices, webhook.webhook) }
					: null,
			});
			this.rows($body, [
				{
					label: __("Customer API key"),
					badge: values.has_customer_api_key ? __("Stored") : __("Not set"),
					colour: values.has_customer_api_key ? "green" : "orange",
				},
				{
					label: __("Customer API secret"),
					badge: values.has_customer_api_secret ? __("Stored") : __("Not set"),
					colour: values.has_customer_api_secret ? "green" : "orange",
				},
				{
					label: __("API key"),
					badge: values.has_api_key ? __("Stored") : __("Not set"),
					colour: values.has_api_key ? "green" : "orange",
				},
				{
					label: __("API secret"),
					badge: values.has_api_secret ? __("Stored") : __("Not set"),
					colour: values.has_api_secret ? "green" : "orange",
				},
			]);
			if (!IS_SM()) {
				$el.append(
					`<p class="wa-settings__muted">${frappe.utils.escape_html(
						__("Only a System Manager can change the credentials.")
					)}</p>`
				);
			}
		});
	}

	rotate_credentials(devices, webhook) {
		sanad.ui.ConfirmDialog.ask({
			title: __("Rotate the platform credentials?"),
			message: __(
				"New keys are shown once. Every integration still using the old keys stops immediately — tell the developer before you rotate."
			),
			impact: [
				{ label: __("Keys to be replaced"), value: 4, tone: "red" },
				{ label: __("Paired devices"), value: devices },
				{
					label: __("Webhook"),
					value:
						(webhook && webhook.webhook_status) === "Active"
							? __("Active — its secret needs updating")
							: __("Not active"),
					tone: (webhook && webhook.webhook_status) === "Active" ? "amber" : undefined,
				},
			],
			ack_checkbox: __("I understand the current integrations stop until the keys are updated."),
			danger: true,
			confirm_label: __("Enter the new keys"),
		})
			.then(() => this.credentials_dialog())
			.catch(() => {});
	}

	credentials_dialog() {
		const dialog = new frappe.ui.Dialog({
			title: __("New platform credentials"),
			fields: [
				{
					fieldname: "platform_base_url",
					label: __("Platform address"),
					fieldtype: "Data",
					description: __("For example https://platform.example.com"),
				},
				{ fieldname: "customer_api_key", label: __("Customer API key"), fieldtype: "Password" },
				{ fieldname: "customer_api_secret", label: __("Customer API secret"), fieldtype: "Password" },
				{ fieldname: "api_key", label: __("API key"), fieldtype: "Password" },
				{ fieldname: "api_secret", label: __("API secret"), fieldtype: "Password" },
			],
			primary_action_label: __("Save credentials"),
			primary_action: (values) => {
				sanad.ui
					.call("onboarding.save_credentials", values, { freeze: true })
					.then(() => {
						dialog.hide();
						sanad.ui.Toast.success(__("Credentials saved"));
						this.show("credentials");
					})
					.catch((err) => sanad.ui.Toast.error(err));
			},
		});
		dialog.show();
	}

	// ---- 3. webhook --------------------------------------------------------------------------------

	render_webhook($el) {
		return Promise.all([
			sanad.ui.call("settings.get_settings", { section: "webhook" }),
			sanad.ui.call("onboarding.get_status"),
		]).then(([data, status]) => {
			const values = data.webhook || {};
			this.state.hide();
			$el.empty();
			const active = values.webhook_status === "Active";
			const url = values.webhook_endpoint_url || status.webhook_url;
			this.banner($el, {
				tone: active ? "green" : "red",
				// the same triangle the platform banner uses: a circled "i" reads as a note, and an
				// inactive webhook is the screen's loudest problem
				icon: active ? "es-line-success" : "es-line-alert-triangle",
				title: active ? __("The webhook is active.") : __("The webhook is not active."),
				text: active
					? __("Status updates and inbound messages reach this site.")
					: __("Without it no inbound message arrives and no status ever changes past “Sent”."),
				action: IS_SM()
					? active
						? { label: __("Copy the receiver URL"), handler: () => this.copy(url) }
						: { label: __("Turn it on now"), primary: true, handler: () => this.enable_webhook() }
					: null,
			});

			const $cols = $('<div class="wa-settings__cols"></div>').appendTo($el);
			const $endpoint = this.panel($cols, {
				title: __("Receiver"),
				note: __("POST · JSON"),
				action: url ? { label: __("Copy"), handler: () => this.copy(url) } : null,
			});
			this.rows($endpoint, [
				{ label: __("URL"), value: url || __("Not registered"), ltr: true, stacked: true },
				{ label: __("Signature"), value: "HMAC-SHA256", ltr: true },
				{
					label: __("Signing secret"),
					badge: values.has_webhook_secret ? __("Stored") : __("Not set"),
					colour: values.has_webhook_secret ? "green" : "orange",
				},
				{
					label: __("Status"),
					badge: __(values.webhook_status || "Not registered"),
					colour: active ? "green" : "orange",
				},
				{
					label: __("Last event"),
					value: values.webhook_last_event_at
						? frappe.datetime.str_to_user(values.webhook_last_event_at)
						: __("None yet"),
				},
			]);

			const $events = this.panel($cols, {
				title: __("Received events"),
				note: __("Fewer events, less load on your server."),
			});
			if (SettingsView.linked(status)) {
				this.render_events($events);
			} else {
				new sanad.ui.EmptyState({
					wrapper: $events,
					state: "empty",
					size: "sm",
					title: __("The event list comes from the platform"),
					description: __("Connect to the platform first; the events it can send are read from it."),
					action: { label: __("Open the platform link"), onclick: () => this.show("provider") },
				});
			}

			const $tools = $('<div class="wa-settings__actions"></div>').appendTo($el);
			if (IS_MGR()) {
				$(`<button type="button" class="btn btn-sm btn-default">${frappe.utils.escape_html(
					__("Send a test event")
				)}</button>`)
					.on("click", () =>
						sanad.ui
							.call("settings.test_webhook", {}, { freeze: true })
							.then((r) =>
								r && r.status === "ok"
									? sanad.ui.Toast.success(__("The platform delivered the test event"))
									: sanad.ui.Toast.warning(
											r && r.http_status_code
												? __("The test event was not delivered (HTTP {0})", [r.http_status_code])
												: __("The test event was not delivered")
									  )
							)
							.catch((err) => sanad.ui.Toast.error(err))
					)
					.appendTo($tools);
			}
			if (IS_SM()) {
				$(`<button type="button" class="btn btn-sm btn-default">${frappe.utils.escape_html(
					__("Rotate the signing secret")
				)}</button>`)
					.on("click", () => this.rotate_secret())
					.appendTo($tools);
			}
			$(`<button type="button" class="btn btn-sm btn-default">${frappe.utils.escape_html(
				__("Recent attempts")
			)}</button>`)
				.on("click", () => frappe.set_route("List", "WhatsApp Webhook Event"))
				.appendTo($tools);

			const $form = $('<section class="wa-settings__panel"></section>').appendTo($el);
			$form.append(
				`<header><span><strong>${frappe.utils.escape_html(__("Delivery"))}</strong><span>${frappe.utils.escape_html(
					__("How many times a failed delivery is retried.")
				)}</span></span></header>`
			);
			this.render_fields(
				$('<div class="wa-settings__panel-body wa-settings__pane-body"></div>').appendTo($form),
				"webhook",
				values,
				SKIP_IN_FORM.concat([
					"webhook_endpoint",
					"webhook_endpoint_url",
					"webhook_status",
					"webhook_synced_at",
					"webhook_last_event_at",
				])
			);
		});
	}

	render_events($el) {
		const state = new sanad.ui.EmptyState({ wrapper: $el, state: "loading", rows: 3, size: "sm" });
		return sanad.ui
			.call("settings.list_webhook_events_available", {}, { silent: true })
			.then((rows) => {
				if (!rows || !rows.length) {
					state.empty({
						title: __("The platform listed no events"),
						description: __("Connect to the platform first, then the list arrives from it."),
					});
					return;
				}
				state.hide();
				const esc = frappe.utils.escape_html;
				const $list = $(
					`<fieldset class="wa-settings__checks"><legend class="sanad-visually-hidden">${esc(
						__("Received events")
					)}</legend></fieldset>`
				).appendTo($el);
				rows.forEach((row) => {
					const id = sanad.ui.uid("ev");
					$(`<label class="wa-settings__check" for="${id}">
						<input type="checkbox" id="${id}" value="${esc(row.event_name)}"
							${row.subscribed ? "checked" : ""} ${row.enabled === false || !IS_SM() ? "disabled" : ""}>
						<span>${esc(row.event_name)}${
						row.disabled_reason ? `<span>${esc(row.disabled_reason)}</span>` : ""
					}</span>
					</label>`).appendTo($list);
				});
				if (!IS_SM()) return;
				const $save = $(
					`<button type="button" class="btn btn-xs btn-primary wa-settings__check-save">${esc(
						__("Save the event list")
					)}</button>`
				).appendTo($el);
				$save.on("click", () => {
					const events = $list
						.find("input:checked")
						.toArray()
						.map((el) => el.value);
					if (!events.length) return sanad.ui.Toast.warning(__("Choose at least one event"));
					sanad.ui
						.call("settings.set_webhook_events", { events }, { freeze: true })
						.then((r) =>
							sanad.ui.Toast.success(
								sanad.ui.plural((r.events || []).length, {
									one: __("Subscribed to {0} event"),
									other: __("Subscribed to {0} events"),
								})
							)
						)
						.catch((err) => sanad.ui.Toast.error(err));
				});
			})
			.catch((err) => state.error(err, { action: { label: __("Retry"), onclick: () => this.render_events($el) } }));
	}

	enable_webhook() {
		sanad.ui
			.call("settings.setup_webhook", {}, { freeze: true })
			.then(() => sanad.ui.call("settings.set_webhook_status", { status: "Active" }))
			.then(() => {
				sanad.ui.Toast.success(__("The webhook is on"));
				this.show("webhook");
			})
			.catch((err) => sanad.ui.Toast.error(err));
	}

	rotate_secret() {
		sanad.ui.ConfirmDialog.ask({
			title: __("Rotate the webhook signing secret?"),
			message: __("Events signed with the old secret are refused as soon as the new one is in place."),
			ack_checkbox: __("I understand deliveries fail until the platform uses the new secret."),
			danger: true,
			confirm_label: __("Rotate the secret"),
			on_confirm: () => sanad.ui.call("settings.rotate_webhook_secret"),
		})
			.then(() => {
				sanad.ui.Toast.success(__("Signing secret rotated"));
				this.show("webhook");
			})
			.catch(() => {});
	}

	copy(text) {
		if (!text) return sanad.ui.Toast.warning(__("There is no receiver URL yet"));
		frappe.utils.copy_to_clipboard(text);
		sanad.ui.Toast.success(__("Receiver URL copied"));
	}

	// ---- 4–8. the plain sections ------------------------------------------------------------------

	plain(section, $el, extra) {
		return sanad.ui.call("settings.get_settings", { section }).then((data) => {
			this.state.hide();
			$el.empty();
			const values = data[section] || {};
			if (extra) extra.call(this, $el, values);
			this.render_fields($el, section, values, SKIP_IN_FORM);
		});
	}

	render_queue($el) {
		return this.plain("queue", $el, function ($wrap, values) {
			if (cint(values.queue_paused)) {
				this.banner($wrap, {
					tone: "amber",
					icon: "es-line-alert-triangle",
					title: __("Sending is paused."),
					text: values.queue_pause_reason || __("Nothing leaves the queue until it is resumed."),
					action: { label: __("Open the queue"), handler: () => frappe.set_route("List", "WhatsApp Queue Item") },
				});
			}
		});
	}

	render_commands($el) {
		return this.plain("commands", $el);
	}

	render_policy($el) {
		return this.plain("policy", $el, function ($wrap, values) {
			// R-028 / D-125: Frappe ships `Contact` open to role All. Removing that is the site
			// admin's step (never done by the app), so the page says so while it is still there.
			const open = values.contact_open_to_all || [];
			if (!open.length) return;
			this.banner($wrap, {
				tone: "amber",
				icon: "es-line-alert-triangle",
				title: __("Every user can open Contacts directly."),
				text: __("Role All still has {0} on Contact, so a WhatsApp Contact User can bypass the scoped contact screens. Remove those rights for All in the Role Permission Manager.", [open.map((p) => __(frappe.unscrub(p))).join(", ")]),
				action: IS_SM() ? { label: __("Open Role Permission Manager"), handler: () => frappe.set_route("permission-manager", "Contact") } : undefined,
			});
		});
	}

	render_retention($el) {
		return this.plain("retention", $el);
	}

	// ---- 7. picker sources -------------------------------------------------------------------------

	render_picker($el) {
		return sanad.ui.call("settings.get_settings", { section: "picker" }).then((data) => {
			this.state.hide();
			$el.empty();
			this.sources = ((data.picker || {}).picker_sources || []).slice();
			this.draw_sources($el);
		});
	}

	draw_sources($el) {
		const esc = frappe.utils.escape_html;
		$el.empty();
		const $panel = this.panel($el, {
			title: __("Sources"),
			note: __("The contact picker offers these system screens, and only these."),
			action: IS_SM() ? { label: __("Add a source"), handler: () => this.source_dialog(null) } : null,
		});
		if (!this.sources.length) {
			new sanad.ui.EmptyState({
				wrapper: $panel,
				state: "empty",
				size: "sm",
				title: __("No source is configured"),
				description: __("Until one is added, the picker offers groups, contacts and files only."),
				action: IS_SM() ? { label: __("Add a source"), onclick: () => this.source_dialog(null) } : undefined,
			});
			return;
		}
		$panel.html(`<div class="sanad-table-wrap"><table class="sanad-table">
			<thead><tr>
				<th scope="col">${esc(__("Document type"))}</th>
				<th scope="col">${esc(__("Label"))}</th>
				<th scope="col">${esc(__("Number source"))}</th>
				<th scope="col">${esc(__("Enabled"))}</th>
				<th scope="col"><span class="sanad-visually-hidden">${esc(__("Actions"))}</span></th>
			</tr></thead><tbody></tbody></table></div>`);
		const $body = $panel.find("tbody");
		this.sources.forEach((row, i) => {
			const $tr = $(`<tr>
				<td>${esc(row.document_type || "")}</td>
				<td>${esc(row.label || "")}</td>
				<td>${esc(row.phone_source === "Contact" ? __("Linked contact") : row.phone_fieldname || "")}</td>
				<td>${sanad.ui.StatusBadge.html({
					label: cint(row.enabled) ? __("Enabled") : __("Disabled"),
					colour: cint(row.enabled) ? "green" : "gray",
				})}</td>
				<td class="sanad-table__num"></td>
			</tr>`).appendTo($body);
			if (!IS_SM()) return;
			$(`<button type="button" class="btn btn-xs btn-default">${esc(__("Edit"))}</button>`)
				.on("click", () => this.source_dialog(i))
				.appendTo($tr.find("td").last());
			$(`<button type="button" class="btn btn-xs btn-default">${esc(__("Remove"))}</button>`)
				.on("click", () => {
					this.sources.splice(i, 1);
					this.save_sources($el);
				})
				.appendTo($tr.find("td").last());
		});
	}

	source_dialog(index) {
		const row = index == null ? {} : this.sources[index];
		const dialog = new frappe.ui.Dialog({
			title: index == null ? __("Add a picker source") : __("Edit the picker source"),
			fields: [
				{
					fieldname: "document_type",
					label: __("Document type"),
					fieldtype: "Link",
					options: "DocType",
					reqd: 1,
					default: row.document_type,
					get_query: () => ({ filters: { issingle: 0, istable: 0 } }),
					onchange: () => this.fill_source_fields(dialog),
				},
				{ fieldname: "label", label: __("Label"), fieldtype: "Data", default: row.label },
				{
					fieldname: "phone_source",
					label: __("Where the number comes from"),
					fieldtype: "Select",
					options: ["Field", "Contact"],
					default: row.phone_source || "Field",
				},
				{ fieldname: "phone_fieldname", label: __("Number field"), fieldtype: "Select", default: row.phone_fieldname },
				{ fieldname: "name_fieldname", label: __("Name field"), fieldtype: "Select", default: row.name_fieldname },
				{
					fieldname: "contact_fieldname",
					label: __("Contact field"),
					fieldtype: "Select",
					default: row.contact_fieldname,
				},
				{
					fieldname: "filters_json",
					label: __("Server filters"),
					fieldtype: "Code",
					options: "JSON",
					default: row.filters_json,
					description: __("Always applied on top of what the user chooses."),
				},
				{ fieldname: "enabled", label: __("Enabled"), fieldtype: "Check", default: cint(row.enabled) },
			],
			primary_action_label: index == null ? __("Add") : __("Save"),
			primary_action: (values) => {
				if (index == null) this.sources.push(values);
				else this.sources[index] = Object.assign({}, this.sources[index], values);
				dialog.hide();
				this.save_sources(this.$content);
			},
		});
		dialog.show();
		if (row.document_type) this.fill_source_fields(dialog);
	}

	fill_source_fields(dialog) {
		const document_type = dialog.get_value("document_type");
		if (!document_type) return;
		sanad.ui
			.call("settings.get_doctype_fields", { document_type }, { silent: true })
			.then((fields) => {
				const options = (fields || []).map((f) => ({ value: f.fieldname, label: `${f.label} (${f.fieldname})` }));
				["phone_fieldname", "name_fieldname", "contact_fieldname"].forEach((f) => {
					const control = dialog.get_field(f);
					const current = control.get_value();
					control.df.options = [{ value: "", label: __("Not set") }].concat(options);
					control.refresh();
					if (current) control.set_value(current);
				});
			})
			.catch(() => {});
	}

	save_sources($el) {
		sanad.ui
			.call("settings.save_settings", { section: "picker", values: { picker_sources: this.sources } }, { freeze: true })
			.then(() => {
				sanad.ui.Toast.success(__("Picker sources saved"));
				this.draw_sources($el);
			})
			.catch((err) => sanad.ui.Toast.error(err));
	}

	// ---- 9. subscription and plan ------------------------------------------------------------------

	render_subscription($el) {
		return sanad.ui.call("settings.get_settings", { section: "subscription" }).then((data) => {
			const values = (data && data.subscription) || {};
			const SW = sanad.ui.SettingsWindow;
			const esc = frappe.utils.escape_html;
			this.state.hide();
			$el.empty();
			this.subscription_cards($el, values);

			$el.append(SW.section_html(__("Plan details"), values.plan_name || values.plan_code || __("Not synced yet")));
			const $plan = $('<div class="wa-settings__plan"></div>').appendTo($el);
			this.rows($plan, [
				{ label: __("Monthly allowance"), value: sanad.ui.format_int(values.message_limit), ltr: true },
				{ label: __("Used this cycle"), value: sanad.ui.format_int(values.messages_used), ltr: true },
				{ label: __("Remaining"), value: sanad.ui.format_int(values.messages_remaining), ltr: true },
				{ label: __("Devices allowed"), value: sanad.ui.format_int(values.device_limit), ltr: true },
				{
					label: __("Rate limit"),
					value: __("{0} per minute", [sanad.ui.format_int(values.plan_messages_per_minute)]),
				},
				{ label: __("Cycle starts"), value: values.subscription_start ? frappe.datetime.str_to_user(values.subscription_start) : null },
				{ label: __("Cycle ends"), value: values.subscription_end ? frappe.datetime.str_to_user(values.subscription_end) : null },
			]);

			$el.append(SW.section_html(__("Sync")));
			const synced = values.subscription_synced_at
				? __("Last synced {0}.", [frappe.datetime.str_to_user(values.subscription_synced_at)])
				: __("Never synced.");
			$(
				SW.row_html(
					__("Read the plan from the platform"),
					`${synced} ${__("The plan is read again every hour on its own.")}`,
					`<button type="button" class="btn btn-sm btn-default" data-act="sync">${esc(__("Sync now"))}</button>`
				)
			)
				.appendTo($el)
				.find("[data-act=sync]")
				.on("click", () => this.sync_subscription());
			$el.append(
				SW.row_html(
					__("Wallet, plan changes and invoices"),
					__("Topping up the wallet, changing the plan and invoice settings are done on the platform; they are not available from here yet.")
				)
			);
		});
	}

	subscription_cards($el, values) {
		const limit = cint(values.message_limit);
		const used = cint(values.messages_used);
		const left = cint(values.messages_remaining);
		const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
		const esc = frappe.utils.escape_html;
		const status = values.subscription_status || "Unknown";
		const tone = { Active: "green", Trial: "blue", Expired: "red", Suspended: "red", Cancelled: "red" }[status] || "gray";
		// the plan meter first — how much of the month is gone — then three facts under it
		$el.append(`
			<section class="wa-settings__meter" aria-label="${esc(__("Plan used"))}">
				<div class="wa-settings__meter-line">
					<span class="wa-settings__meter-title">${esc(__("Plan used"))}</span>
					${sanad.ui.StatusBadge.html({ label: __(status), colour: tone })}
				</div>
				<div class="wa-settings__meter-value"><strong class="sanad-tabular" dir="ltr">${pct}%</strong><span>${esc(
					__("{0} of {1} messages", [sanad.ui.format_int(used), sanad.ui.format_int(limit)])
				)}</span></div>
				<div class="wa-settings__meter-track${pct > 80 ? " is-high" : ""}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${esc(
					__("Plan used")
				)}"><span style="inline-size: ${pct}%"></span></div>
			</section>
			<div class="wa-settings__facts3">
				<div><span>${esc(__("Messages left"))}</span><strong class="sanad-tabular" dir="ltr">${esc(
					sanad.ui.format_int(left)
				)}</strong><em>${esc(__("Before the plan runs out"))}</em></div>
				<div><span>${esc(__("Wallet"))}</span><strong class="sanad-tabular">${frappe.format(
					values.wallet_balance || 0,
					{ fieldtype: "Currency", options: values.wallet_currency },
					{ inline: true }
				)}</strong><em>${esc(__("Covers the messages beyond the plan"))}</em></div>
				<div><span>${esc(__("Renewal"))}</span><strong>${esc(
					values.subscription_end ? frappe.datetime.str_to_user(values.subscription_end) : "—"
				)}</strong><em>${esc(values.subscription_end ? __("The next cycle starts then") : __("No renewal date yet"))}</em></div>
			</div>`);
	}

	sync_subscription() {
		sanad.ui
			.call("settings.sync_subscription", {}, { freeze: true })
			.then(() => {
				sanad.ui.Toast.success(__("Subscription refreshed"));
				this.show("subscription");
			})
			.catch((err) => sanad.ui.Toast.error(err));
	}

	// ---- 10. usage -----------------------------------------------------------------------------------

	render_usage($el) {
		this.state.hide();
		$el.empty();
		this.usage_days = this.usage_days || 14;
		const $seg = $('<div class="wa-settings__period" role="radiogroup"></div>')
			.attr("aria-label", __("Period"))
			.appendTo($el);
		[7, 14, 30].forEach((d) => {
			$(`<button type="button" role="radio" aria-checked="${d === this.usage_days}" class="${
				d === this.usage_days ? "is-on" : ""
			}">${frappe.utils.escape_html(__("Last {0} days", [d]))}</button>`)
				.on("click", () => {
					this.usage_days = d;
					this.show("usage");
				})
				.appendTo($seg);
		});
		const $body = $('<div class="wa-settings__usage"></div>').appendTo($el);
		return this.load_usage($body, this.usage_days);
	}

	/** Counted from this site's own outbound log, so it is there whether or not the platform reports. */
	load_usage($el, days) {
		const state = new sanad.ui.EmptyState({ wrapper: $el, state: "loading", rows: 4, size: "sm" });
		const to_date = frappe.datetime.now_date();
		const from_date = frappe.datetime.add_days(to_date, -(days - 1));
		return sanad.ui
			.call("settings.get_site_usage", { from_date, to_date })
			.then((r) => {
				const rows = (r && r.rows) || [];
				const any = rows.some((x) => cint(x.sent) + cint(x.failed));
				if (!any) {
					state.empty({
						title: __("Nothing sent in this period"),
						description: __("Messages this site sends appear here day by day."),
					});
					return;
				}
				state.hide();
				this.draw_usage($el, rows);
			})
			.catch((err) =>
				state.error(err, { action: { label: __("Retry"), onclick: () => this.load_usage($el, days) } })
			);
	}

	draw_usage($el, rows) {
		const esc = frappe.utils.escape_html;
		const max = Math.max(1, ...rows.map((r) => cint(r.sent) + cint(r.failed)));
		const total = rows.reduce((n, r) => n + cint(r.sent), 0);
		const failed = rows.reduce((n, r) => n + cint(r.failed), 0);
		const average = Math.round(total / rows.length);
		const peak = rows.reduce((best, r) => (cint(r.sent) > cint(best.sent) ? r : best), rows[0]);
		const delivered = rows.reduce((n, r) => n + cint(r.delivered), 0);
		const read = rows.reduce((n, r) => n + cint(r.read), 0);
		const pct = (n) => (total ? `${Math.round((n / total) * 100)}%` : "—");
		$el.html(`
			<div class="wa-settings__facts3 wa-settings__facts3--4">
				<div><span>${esc(__("Sent"))}</span><strong class="sanad-tabular" dir="ltr">${esc(
					sanad.ui.format_int(total)
				)}</strong><em>${esc(__("{0} a day on average", [sanad.ui.format_int(average)]))}</em></div>
				<div><span>${esc(__("Delivered", null, "campaign"))}</span><strong class="sanad-tabular" dir="ltr">${esc(
					pct(delivered)
				)}</strong><em>${esc(__("{0} messages", [sanad.ui.format_int(delivered)]))}</em></div>
				<div><span>${esc(__("Read", null, "campaign"))}</span><strong class="sanad-tabular" dir="ltr">${esc(
					pct(read)
				)}</strong><em>${esc(__("{0} messages", [sanad.ui.format_int(read)]))}</em></div>
				<div><span>${esc(__("Failed"))}</span><strong class="sanad-tabular${failed ? " is-bad" : ""}" dir="ltr">${esc(
					sanad.ui.format_int(failed)
				)}</strong><em>${esc(total + failed ? __("{0}% of attempts", [Math.round((failed / (total + failed)) * 100)]) : "—")}</em></div>
			</div>
			<p class="wa-settings__note">${esc(
				__("Counted from this site's own message log. Busiest day: {0}.", [frappe.datetime.str_to_user(peak.key)])
			)}</p>
			${sanad.ui.SettingsWindow.section_html(__("Messages per day"))}
			<div class="wa-settings__chart" role="img" aria-label="${esc(
				__("{0} messages over {1} days, {2} a day on average", [
					sanad.ui.format_int(total),
					rows.length,
					sanad.ui.format_int(average),
				])
			)}">
				${rows
					.map((r) => {
						const all = cint(r.sent) + cint(r.failed);
						const h = Math.max(2, Math.round((all / max) * 100));
						const fh = all ? Math.round((cint(r.failed) / all) * h) : 0;
						return `<span class="wa-settings__bar" title="${esc(
							__("{0}: {1} sent, {2} failed", [frappe.datetime.str_to_user(r.key), cint(r.sent), cint(r.failed)])
						)}">
								<span class="wa-settings__bar-col${all ? "" : " is-zero"}" style="block-size: ${h}%">
									${fh ? `<span class="wa-settings__bar-fail" style="block-size: ${Math.round((fh / h) * 100)}%"></span>` : ""}
								</span>
								<span class="wa-settings__bar-label">${esc(String(r.key).slice(-2))}</span>
							</span>`;
					})
					.join("")}
			</div>
			<div class="wa-settings__legend"><span><i class="is-sent"></i>${esc(__("Sent"))}</span><span><i class="is-fail"></i>${esc(
				__("Failed")
			)}</span></div>
			<table class="sanad-visually-hidden"><caption>${esc(__("Messages per day"))}</caption>
				<thead><tr><th>${esc(__("Day"))}</th><th>${esc(__("Sent"))}</th><th>${esc(__("Failed"))}</th></tr></thead>
				<tbody>${rows
					.map((r) => `<tr><td>${esc(r.key)}</td><td>${cint(r.sent)}</td><td>${cint(r.failed)}</td></tr>`)
					.join("")}</tbody></table>`);
	}

	// ---- 11. audit log --------------------------------------------------------------------------------

	render_audit($el) {
		this.audit_filters = this.audit_filters || {};
		this.audit_page = 1;
		this.state.hide();
		$el.empty();
		this.$audit_filters = $('<div class="wa-settings__audit-filters"></div>').appendTo($el);
		this.$audit_body = $('<div class="wa-settings__audit"></div>').appendTo($el);
		$(`<button type="button" class="btn btn-xs btn-default wa-settings__audit-open">${frappe.utils.escape_html(
			__("Open the full audit log")
		)}</button>`)
			.on("click", () => frappe.set_route("List", "WhatsApp Audit Log"))
			.appendTo($el);
		return sanad.ui.meta.with_doctype("WhatsApp Audit Log").then((meta) => {
			this.make_audit_filters(meta);
			return this.load_audit();
		});
	}

	make_audit_filters(meta) {
		const action_df = (meta.fields || []).find((df) => df.fieldname === "action") || {};
		const fields = [
			{ fieldname: "action", label: __("Action"), fieldtype: "Select", options: `\n${action_df.options || ""}` },
			{ fieldname: "user", label: __("User"), fieldtype: "Link", options: "User" },
			{ fieldname: "from", label: __("From"), fieldtype: "Date" },
			{ fieldname: "to", label: __("To"), fieldtype: "Date" },
		];
		this.audit_controls = {};
		fields.forEach((df) => {
			const control = frappe.ui.form.make_control({
				df: Object.assign({}, df, {
					change: () => {
						this.audit_filters[df.fieldname] = control.get_value() || null;
						this.audit_page = 1;
						this.load_audit();
					},
				}),
				parent: this.$audit_filters,
				render_input: true,
			});
			control.refresh();
			if (control.$input) control.$input.attr("aria-label", df.label);
			this.audit_controls[df.fieldname] = control;
		});
	}

	load_audit() {
		const state = new sanad.ui.EmptyState({ wrapper: this.$audit_body, state: "loading", rows: 5, size: "sm" });
		const filters = {};
		Object.entries(this.audit_filters).forEach(([k, v]) => v && (filters[k] = v));
		return sanad.ui
			.call("settings.list_audit_log", { filters, page: this.audit_page, page_length: 20 })
			.then((r) => {
				const rows = (r && r.rows) || [];
				if (!rows.length) {
					state.empty({
						title: __("No entry matches"),
						description: __("Change the action, the user or the period."),
					});
					return;
				}
				state.hide();
				this.draw_audit(rows, cint(r.total));
			})
			.catch((err) => state.error(err, { action: { label: __("Retry"), onclick: () => this.load_audit() } }));
	}

	draw_audit(rows, total) {
		const esc = frappe.utils.escape_html;
		const TONE = { Info: "gray", Warning: "orange", Critical: "red" };
		const pages = Math.max(1, Math.ceil(total / 20));
		this.$audit_body.html(`<div class="sanad-table-wrap"><table class="sanad-table">
			<thead><tr>
				<th scope="col">${esc(__("Action"))}</th>
				<th scope="col">${esc(__("Record"))}</th>
				<th scope="col">${esc(__("User"))}</th>
				<th scope="col">${esc(__("When"))}</th>
			</tr></thead><tbody>${rows
				.map(
					(row) => `<tr>
					<td>${sanad.ui.StatusBadge.html({
						label: __(row.action),
						colour: TONE[row.severity] || "gray",
					})}</td>
					<td>${this.audit_record(row)}</td>
					<td>${esc(row.user || "—")}</td>
					<td class="wa-settings__nowrap">${esc(frappe.datetime.str_to_user(row.timestamp))}</td>
				</tr>`
				)
				.join("")}</tbody></table></div>
			<div class="wa-settings__pager">
				<span role="status">${esc(
					sanad.ui.plural(total, { one: __("{0} entry"), other: __("{0} entries") })
				)}</span>
				<span>
					<button type="button" class="btn btn-xs btn-default" data-page="prev" ${
						this.audit_page <= 1 ? "disabled" : ""
					}>${esc(__("Previous"))}</button>
					<span class="sanad-tabular">${esc(__("Page {0} of {1}", [this.audit_page, pages]))}</span>
					<button type="button" class="btn btn-xs btn-default" data-page="next" ${
						this.audit_page >= pages ? "disabled" : ""
					}>${esc(__("Next"))}</button>
				</span>
			</div>`);
		this.$audit_body.find("[data-page]").on("click", (e) => {
			this.audit_page =
				$(e.currentTarget).data("page") === "next"
					? Math.min(pages, this.audit_page + 1)
					: Math.max(1, this.audit_page - 1);
			this.load_audit();
		});
	}

	/** What an audit row acted on: the record it references, else what it wrote, else its reason. */
	audit_record(row) {
		const esc = frappe.utils.escape_html;
		const label = (doctype, name) =>
			frappe.utils.get_form_link(doctype, name, true, esc(`${__(doctype)} · ${name}`));
		if (row.reference_doctype && row.reference_name) return label(row.reference_doctype, row.reference_name);
		if (row.target_doctype && row.target_name) return label(row.target_doctype, row.target_name);
		if (row.fields_written) return `<span class="wa-settings__muted">${esc(row.fields_written)}</span>`;
		if (row.count != null) return esc(sanad.ui.plural(row.count, { one: __("{0} row"), other: __("{0} rows") }));
		return `<span class="wa-settings__muted">${esc(row.reason || "—")}</span>`;
	}

	// ---- realtime ---------------------------------------------------------------------------------

	bind_realtime() {
		if (this.on_device) return;
		this.on_device = sanad.ui.throttle(() => {
			if (this.win.open && ["provider", "webhook"].includes(this.current)) this.show(this.current);
		}, 5000);
		frappe.realtime.on("wa:device:status", this.on_device);
	}

	unbind_realtime() {
		if (!this.on_device) return;
		frappe.realtime.off("wa:device:status", this.on_device);
		this.on_device = null;
	}
}

/**
 * Open the settings window, on `section` when given ("subscription", "usage", "provider", …).
 * Every screen and link of the app opens settings through this one call.
 */
whatsapp_next.settings.open = function (section, opts) {
	if (!whatsapp_next.settings.view) whatsapp_next.settings.view = new SettingsView();
	return whatsapp_next.settings.view.open(section, opts);
};

// The sidebar's "Settings" item is a link to the `wa-settings` page; it opens the window over the
// screen the user is on instead of leaving it. Capture phase, so Desk's router never sees the click.
document.addEventListener(
	"click",
	(e) => {
		if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
		const a = e.target && e.target.closest && e.target.closest("a[href]");
		if (!a || !a.closest(".body-sidebar, .desk-sidebar, .layout-side-section, .sidebar-items, .standard-sidebar")) return;
		let url;
		try {
			url = new URL(a.getAttribute("href"), window.location.origin);
		} catch (err) {
			return;
		}
		if (url.origin !== window.location.origin || !/^\/(app|desk)\/wa-settings\/?$/.test(url.pathname)) return;
		e.preventDefault();
		e.stopPropagation();
		whatsapp_next.settings.open(url.searchParams.get("section"));
	},
	true
);

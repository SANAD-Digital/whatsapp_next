// WhatsApp Simulator (09 row 11) — the testing bench of the product. Two things happen here, and
// the screen never lets them be confused:
//
//   • "Message on behalf" (`simulator.simulate_inbound`) writes a message *as if the contact had
//     sent it*, runs the command router over it and stores the reply — all marked simulated, and
//     nothing ever leaves the site. This is how an operator checks what a customer would get.
//   • The composer's send (`simulator.send_test`) sends one real WhatsApp message from the chosen
//     device, straight away, as the prototype does for a single recipient (D-135).
//
// Anatomy, value for value from the prototype (`docs/screen/Hub Screen - WhatsApp Simulator.dc.html`,
// D-134): edge to edge, the conversation list (330 px) on the inline-start — "Conversations" with
// the "Bulk message" button, a pill search, rows with avatar, name, time, last message and the
// party-type badge (which opens "who is this"); "Send a bulk message" opens `whatsapp.ui.BulkSend`,
// D-136) — and the thread on the rest: the green header with
// the device picker, the note line, the kit's `ChatThread` over `messages.get_conversation`, and
// the prototype's composer (the "#" message-on-behalf button above "+", the rounded field, the round
// send). Under 900 px the list and the thread take the screen in turn, with a way back.

(() => {
	const ROUTE = "wa-simulator";
	// how often the open conversation is read again while realtime is unavailable
	const escape_html = (v) => whatsapp.ui.escape(v);
	const format_integer = (v) => whatsapp.ui.format_int(v);
	const PAGE_LENGTH = 50;
	const LIST_LENGTH = 60;
	const SEND_ICON =
		'<svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 10.5l13-6-5 13-2-5-6-2z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"></path></svg>';
	// the send button tells what happened to the press (owner, 2026-10-08): a spinner while the
	// message is handed over, a tick once it is, then the arrow again for the next one
	const SENDING_ICON = '<span class="whatsapp-simulator__spinner" aria-hidden="true"></span>';
	const SENT_ICON =
		'<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4.5 10.5l3.5 3.5 7.5-8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
	const SEARCH_ICON =
		'<svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="5.5" stroke="currentColor" stroke-width="1.6"></circle><path d="M13.5 13.5L17 17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path></svg>';

	/** The list row title: a name when the number has one, the number itself otherwise. */
	const title_of = (row) => cstr(row.display_name) || whatsapp.ui.phone(cstr(row.phone_e164) || cstr(row.name));
	/**
	 * The row's time in the reader's time zone, as the thread draws it (`ChatThread.moment_of`):
	 * the prototype's `hhmm` for a message of today; an older one would read as today's under a
	 * bare time, so it carries "Yesterday" or its date instead.
	 */
	const format_row_time = (ts) => {
		const m = ts ? whatsapp.ui.ChatThread.moment_of(ts) : null;
		if (!m || !m.isValid()) return "";
		const day = whatsapp.ui.ChatThread.day_of(ts);
		return day.key === moment().format("YYYY-MM-DD") ? m.format("HH:mm") : day.label;
	};
	/** A stored datetime in the reader's time zone and date format (the panel's "Last message"). */
	const user_datetime = (ts) => frappe.datetime.str_to_user(frappe.datetime.convert_to_user_tz(cstr(ts)));

	/** The badge the prototype puts on a row: the party type, or what the number is not. */
	const badge_of = (row) => {
		// a group is carried like a number, but it is never an "unknown number"
		if (row.number_type === "Group" || whatsapp.ui.is_group(row.phone_e164)) return { text: __("Group"), tone: "grp" };
		if (!row.contact) return { text: __("Unknown number", null, "Simulator"), tone: "nf" };
		if (!row.party_type) return { text: __("No classification"), tone: "wn" };
		return { text: __(row.party_type), tone: "muted" };
	};

	// ---- the "message on behalf" panel ---------------------------------------------------------

	/**
	 * The prototype's panel: a searchable grid of the commands the site answers (the words a real
	 * sender writes) or a message typed by hand; nothing is sent.
	 */
	function on_behalf_panel({ contact, device, commands, commands_enabled, draft, on_done }) {
		const sections = [];
		if (commands_enabled && commands.length) {
			sections.push({
				title: __("A command from the available commands"),
				cols: 1,
				fields: [
					{
						key: "cmd",
						label: __("Command"),
						type: "choice",
						cols: 2,
						placeholder: __("Search the commands…"),
						empty: __("No command matches the search."),
						options: commands.map((c) => ({
							value: c.code,
							label: c.code,
							mono: true,
							note: [c.title && c.title !== c.code ? c.title : c.function, cstr(c.synonyms).split("\n").filter(Boolean).slice(0, 2).join(" / ")].filter(Boolean).join(" · "),
						})),
					},
				],
			});
		}
		sections.push({
			title: commands_enabled && commands.length ? __("Or an ordinary message that is not a command") : __("The message"),
			note: commands_enabled
				? __("It is recorded in the conversation and in the outbound and inbound logs marked «message on behalf», without a real send.")
				: __("Commands are switched off in the settings, so the message is only stored."),
			note_tone: "info",
			cols: 1,
			fields: [
				{
					key: "body",
					label: __("Message text"),
					type: "textarea",
					rows: 3,
					value: draft || "",
					placeholder: __("Write the message as the customer would…"),
					hint: __("Typing here clears the chosen command; a text that matches no command gets the default reply."),
				},
			],
		});
		const panel = new whatsapp.ui.OverlayPanel({
			type: "modal",
			width: "46%",
			title: __("Message on behalf"),
			subtitle: __("Simulate an incoming message from «{0}» to see the reply it would get", [title_of(contact)]),
			badge: { text: __("Nothing is really sent"), tone: "info" },
			sections,
			on_change: (key, value, p) => {
				if (key === "body" && cstr(value).trim() && p.get_value("cmd")) p.set_value("cmd", "");
			},
			actions: [
				{ key: "cancel", label: __("Cancel"), close: true },
				{
					key: "send",
					label: __("Send on behalf"),
					variant: "primary",
					handler: (values) => {
						const text = cstr(values.body).trim() || cstr(values.cmd).trim();
						if (!text) {
							whatsapp.ui.Toast.warning(__("Pick a command or write the message the contact would send."));
							return false;
						}
						return whatsapp.ui
							.call("simulator.simulate_inbound", { device, sender_phone: contact.phone_e164, text, run_commands: commands_enabled ? 1 : 0 }, { silent: true })
							.then((r) => on_done(r, text));
					},
				},
			],
		});
		panel.show();
		return panel;
	}

	// ---- the "who is this" panel ---------------------------------------------------------------

	/**
	 * Who the number is, in the compact record layout (owner, 2026-10-01: the prototype's
	 * `contactPanel` rows were a tall list of one fact per line): its facts two to a row, then what
	 * it is linked to — its accounts and the contact groups it belongs to — as one short list.
	 */
	function identity_panel(row) {
		whatsapp.ui
			.call("simulator.get_identity", { phone_e164: row.phone_e164 || row.name })
			.then((who) => {
				if (who.is_group) return group_panel(who);
				const unknown = !who.contact;
				const badge = unknown
					? { text: __("Unknown number", null, "Simulator"), tone: "info" }
					: who.party_type
					? { text: __(who.party_type), tone: "muted" }
					: { text: __("No classification"), tone: "warn" };
				const facts = [
					{ k: __("Classification"), v: unknown ? __("Not saved") : who.party_type ? __(who.party_type) : __("No classification") },
					{ k: __("Linked to an account"), v: who.link_status === "Linked" ? __("Linked") : __("Not linked"), tone: who.link_status === "Linked" ? "ok" : "" },
					{ k: __("Messages", null, "Simulator"), v: __("{0} sent · {1} received", [format_integer(who.outbound_count), format_integer(who.inbound_count)]) },
					...(who.last_seen ? [{ k: __("Last message"), v: user_datetime(who.last_seen) }] : []),
				];
				const list = []
					.concat(
						(who.accounts || []).map((a) => ({ avatar: whatsapp.ui.initials(a.title), text: a.title, sub: __("{0} in the system", [__(a.doctype)]) })),
						(who.groups || []).map((g) => ({
							avatar: whatsapp.ui.initials(g.label),
							text: g.label,
							sub: g.kind === "Blacklist" ? __("Blacklist") : __("Contact group · {0} contacts", [format_integer(g.member_count)]),
							badge: g.kind === "Blacklist" ? __("Blacklist") : "",
							badge_tone: "danger",
						}))
					);
				new whatsapp.ui.OverlayPanel({
					type: "modal",
					width: "420px",
					compact: true,
					title: who.name || whatsapp.ui.phone(who.phone_e164),
					subtitle: whatsapp.ui.phone(who.phone_e164),
					subtitle_mono: true,
					badge,
					detail: {
						alert: unknown ? { tone: "info", title: __("A number not saved as a contact"), text: __("Commands that need a linked account will refuse it.") } : null,
						facts,
						blocks: [{ label: __("What it is linked to"), list, empty: __("No accounts and no groups are linked to this contact yet") }],
					},
					actions: [{ key: "close", label: __("Close"), variant: "primary", close: true }],
				}).show();
			})
			.catch((err) => whatsapp.ui.Toast.error(err));
	}

	/** The same panel for a WhatsApp group: the contact it is linked to, its messages, its accounts. */
	function group_panel(who) {
		const facts = [
			{ k: __("Linked to a contact"), v: who.contact || __("Not linked"), tone: who.contact ? "ok" : "" },
			{ k: __("Messages", null, "Simulator"), v: __("{0} sent · {1} received", [format_integer(who.outbound_count), format_integer(who.inbound_count)]) },
			...(who.last_seen ? [{ k: __("Last message"), v: user_datetime(who.last_seen) }] : []),
		];
		const list = (who.accounts || []).map((a) => ({ avatar: whatsapp.ui.initials(a.title), text: a.title, sub: __("{0} in the system", [__(a.doctype)]) }));
		new whatsapp.ui.OverlayPanel({
			type: "modal",
			width: "420px",
			compact: true,
			title: who.name || whatsapp.ui.phone(who.phone_e164),
			subtitle: whatsapp.ui.phone(who.phone_e164),
			subtitle_mono: true,
			badge: { text: __("Group"), tone: "info" },
			detail: {
				facts,
				blocks: [
					{
						label: __("What it is linked to"),
						list,
						empty: who.contact ? __("The linked contact has no accounts") : __("Link the group to a contact from WhatsApp numbers"),
					},
				],
			},
			actions: [{ key: "close", label: __("Close"), variant: "primary", close: true }],
		}).show();
	}

	// ---- the page ------------------------------------------------------------------------------

	class Simulator {
		constructor(page) {
			this.page = page;
			this.contact = null;
			this.device = null;
			this.search = "";
			this.rows = [];
			this.context = null;
			this.$main = $(page.main).addClass("whatsapp-kit whatsapp-simulator");
			this.build_simulator_layout();
			this.load_context();
		}

		build_simulator_layout() {
			this.$main.html(`
				<section class="whatsapp-simulator__list-pane" aria-label="${escape_html(__("Conversations"))}">
					<div class="whatsapp-simulator__list-head">
						<div class="whatsapp-simulator__list-line">
							<h2 class="whatsapp-simulator__list-title">${escape_html(__("Conversations"))}</h2>
							<button type="button" class="whatsapp-simulator__bulk">${SEND_ICON}<span>${escape_html(__("Send a bulk message"))}</span></button>
						</div>
						<label class="whatsapp-simulator__search">
							${SEARCH_ICON}
							<input type="search" dir="auto" data-whatsapp-bare placeholder="${escape_html(__("Search by name or number…"))}" aria-label="${escape_html(__("Search by name or number"))}" />
						</label>
					</div>
					<div class="whatsapp-simulator__list" role="list"></div>
				</section>
				<section class="whatsapp-simulator__main" aria-label="${escape_html(__("Conversation"))}">
					<div class="whatsapp-simulator__head"></div>
					<div class="whatsapp-simulator__note" role="status"></div>
					<div class="whatsapp-simulator__thread"></div>
					<div class="whatsapp-simulator__composer"></div>
				</section>`);
			this.$list = this.$main.find(".whatsapp-simulator__list");
			this.$head = this.$main.find(".whatsapp-simulator__head");
			this.$note = this.$main.find(".whatsapp-simulator__note");
			this.$thread = this.$main.find(".whatsapp-simulator__thread");
			this.$composer = this.$main.find(".whatsapp-simulator__composer");
			this.$search = this.$main.find(".whatsapp-simulator__search input");
			this.list_state = new whatsapp.ui.EmptyState({ wrapper: this.$list, state: "loading", rows: 5 });
			this.$main.find(".whatsapp-simulator__bulk").on("click", () => this.open_bulk());
			this.$search.on(
				"input",
				whatsapp.ui.debounce(() => {
					this.search = cstr(this.$search.val()).trim();
					this.load_list();
				}, 300)
			);
		}

		/** The prototype's "Send a bulk message" window (D-136): the send becomes a campaign. */
		open_bulk() {
			const call = (method, args) => whatsapp.ui.call(`bulk_send.${method}`, args);
			return new whatsapp.ui.BulkSend({
				load: () => call("get_context"),
				estimate: (sel) => call("estimate", sel),
				search_contacts: (txt) => call("search_contacts", { txt }),
				send: (payload) => call("send", { payload }),
				on_sent: () => this.load_list(),
				on_templates: () => frappe.set_route("List", "WhatsApp Template"),
			});
		}

		// ---- context ---------------------------------------------------------------------------

		load_context() {
			return whatsapp.ui
				.call("simulator.get_context")
				.then((context) => {
					this.context = context;
					const devices = context.devices || [];
					const connected = devices.find((d) => d.status === "Connected");
					this.device = context.default_device || (connected || devices[0] || {}).name || null;
					this.render_head();
					this.render_composer();
					this.load_list();
					this.load_thread();
					this.subscribe();
					if (this._pending_open) this.open_number(this._pending_open);
					this._pending_open = null;
				})
				.catch((err) => {
					this.$thread.empty();
					new whatsapp.ui.EmptyState({ wrapper: this.$thread, state: "error" }).error(err, {
						title: __("Could not open the simulator"),
						action: { label: __("Retry"), on_click: () => this.load_context() },
					});
				});
		}

		devices() {
			return (this.context && this.context.devices) || [];
		}

		current_device() {
			return this.devices().find((d) => d.name === this.device) || null;
		}

		/**
		 * `frappe.route_options = {phone}` — QuickSend's "Open in the simulator" and the Contacts
		 * screen's menu — opens that number's conversation. A route read back from the address bar
		 * carries the value JSON-quoted, so it is unquoted first.
		 */
		open_from_route() {
			const opts = frappe.route_options;
			if (!opts || !opts.phone) return;
			frappe.route_options = null;
			let key = cstr(opts.phone);
			try {
				const parsed = JSON.parse(key);
				if (typeof parsed === "string") key = parsed;
			} catch (e) {
				// already a bare value
			}
			if (!this.context) this._pending_open = key;
			else this.open_number(key);
		}

		/** Open one number's conversation: its list row when it has one, else a new conversation. */
		open_number(key) {
			const guess = whatsapp.ui.is_group(key) ? { valid: true, phone_e164: key } : whatsapp.ui.PhoneField.normalize_phone_number(key);
			if (!guess || !guess.valid) return Promise.resolve();
			const phone = guess.phone_e164;
			return whatsapp.ui
				.call("simulator.list_conversations", { txt: phone, limit: 5 }, { silent: true })
				.then((r) => ((r && r.rows) || []).find((row) => row.phone_e164 === phone))
				.catch(() => null)
				.then((row) => this.select(row || { name: phone, phone_e164: phone, display_name: "", link_status: "Not Linked", typed: true }));
		}

		// ---- the conversation list -------------------------------------------------------------

		load_list({ quiet = false } = {}) {
			// a timed re-read keeps what is on screen instead of flashing the loading rows
			if (!quiet) this.list_state.loading({ rows: 5 });
			// a search typed on while an older one is in flight: only the newest answer draws
			const seq = (this._list_seq = (this._list_seq || 0) + 1);
			return whatsapp.ui
				.call("simulator.list_conversations", { txt: this.search || null, limit: LIST_LENGTH })
				.then((r) => {
					if (seq !== this._list_seq) return;
					this.rows = (r && r.rows) || [];
					this.total = r && r.total;
					this.list_state.hide();
					this.render_list();
				})
				.catch((err) => {
					if (seq !== this._list_seq) return;
					this.list_state.error(err, {
						title: __("Could not load the numbers"),
						action: { label: __("Retry"), on_click: () => this.load_list() },
					});
				});
		}

		/** A number typed into the search is a valid conversation even when it was never seen. */
		typed_number() {
			if (!this.search) return null;
			const guess = whatsapp.ui.PhoneField.normalize_phone_number(this.search);
			if (!guess.valid) return null;
			if (this.rows.some((r) => r.phone_e164 === guess.phone_e164)) return null;
			return { name: guess.phone_e164, phone_e164: guess.phone_e164, display_name: "", link_status: "Not Linked", typed: true };
		}

		render_list() {
			const typed = this.typed_number();
			const rows = typed ? [typed].concat(this.rows) : this.rows;
			if (!rows.length) {
				this.$list.html(`<span class="whatsapp-simulator__none">${escape_html(this.search ? __("No results match the search.") : __("No conversation yet. Numbers appear here once a message has been exchanged with them."))}</span>`);
				return;
			}
			this.$list.html(
				rows
					.map((row) => {
						const on = this.contact && this.contact.phone_e164 === row.phone_e164;
						const unsaved = !row.display_name;
						const b = badge_of(row);
						const preview = row.typed ? __("A new number — type a message to start") : cstr(row.last_body).split("\n")[0] || whatsapp.ui.phone(row.phone_e164);
						return `<div class="whatsapp-simulator__row${on ? " is-on" : ""}" role="listitem">
							<button type="button" class="whatsapp-simulator__row-main" data-key="${escape_html(row.phone_e164)}" aria-current="${on ? "true" : "false"}">
								<span class="whatsapp-simulator__avatar${!row.contact ? " whatsapp-simulator__avatar--nf" : ""}" aria-hidden="true">${escape_html(unsaved ? "#" : whatsapp.ui.initials(title_of(row)))}</span>
								<span class="whatsapp-simulator__row-text">
									<span class="whatsapp-simulator__row-line">
										<span class="whatsapp-simulator__row-name"${unsaved ? ' dir="ltr"' : ""}>${escape_html(title_of(row))}</span>
										<span class="whatsapp-simulator__row-at" dir="ltr">${escape_html(format_row_time(row.last_at))}</span>
									</span>
									<span class="whatsapp-simulator__row-sub" dir="auto">${escape_html(preview)}</span>
								</span>
							</button>
							${row.typed ? "" : `<button type="button" class="whatsapp-simulator__badge whatsapp-simulator__badge--${b.tone}" data-who="${escape_html(row.phone_e164)}" title="${escape_html(__("Contact details"))}">${escape_html(b.text)}</button>`}
						</div>`;
					})
					.join("") +
					(this.total != null && this.total > rows.length
						? `<p class="whatsapp-simulator__more">${escape_html(__("Showing {0} of {1}. Search to narrow the list.", [format_integer(this.rows.length), format_integer(this.total)]))}</p>`
						: "")
			);
			this.$list.find("[data-key]").on("click", (ev) => {
				const row = rows.find((r) => r.phone_e164 === $(ev.currentTarget).data("key"));
				if (row) this.select(row);
			});
			this.$list.find("[data-who]").on("click", (ev) => {
				ev.stopPropagation();
				const row = rows.find((r) => r.phone_e164 === $(ev.currentTarget).data("who"));
				if (row) identity_panel(row);
			});
		}

		select(row) {
			this.contact = row;
			this.attach = null;
			this.$main.addClass("whatsapp-simulator--open");
			this.render_list();
			this.render_head();
			this.render_composer();
			this.load_thread();
			whatsapp.ui.announce(__("Conversation with {0} opened.", [title_of(row)]));
		}

		close_conversation() {
			this.contact = null;
			this.$main.removeClass("whatsapp-simulator--open");
			this.render_list();
			this.render_head();
			this.render_composer();
			this.load_thread();
		}

		// ---- the green header ------------------------------------------------------------------

		render_head() {
			const c = this.contact;
			const devices = this.devices();
			const device = this.current_device();
			const sub = c
				? `${whatsapp.ui.phone(c.phone_e164)}${c.link_status === "Linked" ? ` · ${__("Linked to an account", null, "Command Editor")}` : ""}`
				: __("Pick a contact from the list, then write the message");
			this.$head.html(`
				${c ? `<button type="button" class="whatsapp-simulator__back" title="${escape_html(__("All conversations"))}" aria-label="${escape_html(__("All conversations"))}">${whatsapp.ui.is_rtl() ? "→" : "←"}</button>` : ""}
				<span class="whatsapp-simulator__head-icon" aria-hidden="true">${SEND_ICON.replace('width="14" height="14"', 'width="18" height="18"')}</span>
				<button type="button" class="whatsapp-simulator__head-text"${c ? "" : " disabled"}>
					<span class="whatsapp-simulator__head-title">${c && !c.display_name ? `<bdi dir="ltr">${escape_html(title_of(c))}</bdi>` : escape_html(c ? title_of(c) : __("WhatsApp simulator"))}${c ? whatsapp.ui.group_tag(c.phone_e164) : ""}</span>
					<span class="whatsapp-simulator__head-sub"${c ? ' dir="auto"' : ""}>${escape_html(sub)}</span>
				</button>
				${
					devices.length
						? `<span class="whatsapp-simulator__device">
								<span class="whatsapp-simulator__dot${device && device.status === "Connected" ? " is-on" : ""}" aria-hidden="true"></span>
								<select class="whatsapp-simulator__device-select" title="${escape_html(__("Sending device"))}" aria-label="${escape_html(__("Sending device"))}">${devices
									.map((d) => `<option value="${escape_html(d.name)}" ${d.name === this.device ? "selected" : ""}>${escape_html((d.device_name || d.name) + (d.status === "Connected" ? "" : ` — ${__("not connected")}`))}</option>`)
									.join("")}</select>
							</span>`
						: `<button type="button" class="whatsapp-simulator__device whatsapp-simulator__pair">${escape_html(__("Pair a device"))}</button>`
				}`);
			this.$head.find(".whatsapp-simulator__back").on("click", () => this.close_conversation());
			this.$head.find(".whatsapp-simulator__head-text").on("click", () => c && identity_panel(c));
			this.$head.find(".whatsapp-simulator__pair").on("click", () => frappe.set_route("wa-devices"));
			this.$head.find(".whatsapp-simulator__device-select").on("change", (ev) => {
				this.device = $(ev.currentTarget).val();
				this.render_head();
			});
			this.render_note();
		}

		/** The prototype's note line: what this screen will do next. */
		render_note() {
			const device = this.current_device();
			let text;
			if (!this.devices().length) text = __("No device is set up yet. Pair a phone to send a test message.");
			else if (!this.contact) text = __("Pick a contact to enable sending, or use «Send a bulk message» for several groups and numbers at once.");
			else if (device && device.status !== "Connected")
				text = __("{0} is not connected. A real send needs a connected device; a message on behalf does not.", [device.device_name || device.name]);
			else text = __("Sending is real — the «Message on behalf» button simulates a message from the contact without sending.");
			this.$note.html(`<span class="whatsapp-simulator__note-dot" aria-hidden="true"></span><span>${escape_html(text)}</span>`);
		}

		// ---- the thread ------------------------------------------------------------------------

		empty_thread(title, text) {
			this.$thread.html(`<div class="whatsapp-simulator__empty"><strong>${escape_html(title)}</strong><span>${escape_html(text)}</span></div>`);
		}

		load_thread() {
			this.thread = null;
			this.next_cursor = null;
			// a conversation picked while the previous one is still loading: only its own page draws
			const seq = (this._thread_seq = (this._thread_seq || 0) + 1);
			if (!this.contact) {
				this.empty_thread(__("Pick a conversation"), __("The contacts are in the list beside. To send to several groups and numbers at once use «Send a bulk message»."));
				return Promise.resolve();
			}
			if (this.contact.typed) {
				this.empty_thread(__("No messages yet"), __("Write in the box below to start the conversation — it shows here as the recipient gets it."));
				return Promise.resolve();
			}
			this.$thread.empty();
			const state = new whatsapp.ui.EmptyState({ wrapper: this.$thread, state: "loading", rows: 4 });
			return this.fetch_page()
				.then((page) => {
					if (seq !== this._thread_seq) return;
					const rows = ((page && page.rows) || []).slice().reverse();
					this.next_cursor = page && page.has_more ? page.next_cursor : null;
					state.hide();
					this.$thread.empty();
					if (!rows.length) {
						this.empty_thread(__("No messages yet"), __("Write in the box below to start the conversation — it shows here as the recipient gets it."));
						return;
					}
					this.thread = new whatsapp.ui.ChatThread({
						wrapper: this.$thread,
						rows,
						has_more: !!this.next_cursor,
						on_load_more: () => this.load_older(),
						// no `on_row_click`: the simulator is a conversation, not a way into the message logs
						empty_text: __("No messages yet"),
					});
				})
				.catch((err) => {
					if (seq !== this._thread_seq) return;
					const forbidden = err && (err.http_status === 403 || /PermissionError/.test(err.exc_type || ""));
					state.set_state("error", {
						title: forbidden ? __("No access to conversations") : __("Could not load the conversation"),
						description: forbidden ? __("You do not have permission to read messages. Ask an administrator for access.") : err.message,
						action: forbidden ? null : { label: __("Retry"), on_click: () => this.load_thread() },
					});
				});
		}

		fetch_page(before) {
			const args = { key: this.contact.phone_e164, limit: PAGE_LENGTH };
			if (before) args.before = before;
			return whatsapp.ui.call("messages.get_conversation", args, { silent: true });
		}

		load_older() {
			if (!this.next_cursor || !this.thread) return Promise.resolve();
			const thread = this.thread;
			return this.fetch_page(this.next_cursor).then((page) => {
				if (thread !== this.thread) return;
				const rows = ((page && page.rows) || []).slice().reverse();
				this.next_cursor = page && page.has_more ? page.next_cursor : null;
				const added = this.thread.prepend(rows);
				this.thread.set_has_more(!!this.next_cursor);
				if (added) whatsapp.ui.announce(whatsapp.ui.plural(added, { one: __("{0} older message loaded."), other: __("{0} older messages loaded.") }));
			});
		}

		/** After a send or a simulation the newest page carries the rows we just created. */
		refresh_newest() {
			if (!this.contact) return Promise.resolve();
			if (!this.thread) return this.load_thread();
			if (this._refreshing) return Promise.resolve();
			this._refreshing = true;
			const thread = this.thread;
			return this.fetch_page()
				.then((page) => {
					if (thread !== this.thread) return;
					const { added } = this.thread.merge(((page && page.rows) || []).slice().reverse());
					if (added) whatsapp.ui.announce(whatsapp.ui.plural(added, { one: __("{0} new message."), other: __("{0} new messages.") }));
				})
				.catch(() => {})
				.then(() => {
					this._refreshing = false;
				});
		}

		// ---- the composer ----------------------------------------------------------------------

		/**
		 * The prototype's composer (`docs/component/Chat Thread.dc.html`): the round "#" (message on
		 * behalf) above the round "+" (`whatsapp.ui.AttachMenu`: image · video · document · voice note ·
		 * location · contact card, D-137), the chip of what "+" picked, the rounded two-line field with
		 * its clear (the caption of a file), and the round send.
		 */
		render_composer() {
			const enabled = !!this.contact;
			this.$composer.html(`
				<span class="whatsapp-simulator__attach" data-slot="attach">${whatsapp.ui.AttachMenu.chip_html(this.attach)}</span>
				<span class="whatsapp-simulator__composer-row">
					<span class="whatsapp-simulator__tools">
						${enabled ? `<button type="button" class="whatsapp-simulator__round whatsapp-simulator__round--info whatsapp-simulator__behalf" title="${escape_html(__("Message on behalf — simulate a message from the contact without a real send"))}" aria-label="${escape_html(__("Message on behalf"))}">#</button>` : ""}
						<button type="button" class="whatsapp-simulator__round whatsapp-simulator__round--plain whatsapp-simulator__plus" title="${escape_html(__("Message type"))}" aria-label="${escape_html(__("Message type"))}" aria-haspopup="dialog"${enabled ? "" : " disabled"}>+</button>
					</span>
					<span class="whatsapp-simulator__field">
						<label class="whatsapp-kit-visually-hidden" for="whatsapp-simulator-body">${escape_html(__("Message"))}</label>
						<textarea id="whatsapp-simulator-body" class="whatsapp-simulator__input" rows="2" placeholder="${escape_html(
							enabled
								? this.attach && ["buttons", "list"].includes(this.attach.kind)
									? __("The message text, above the buttons…")
									: this.attach && this.attach.kind !== "location"
										? __("Caption (optional)…")
										: __("Write your message…")
								: __("Pick a contact from the list first…")
						)}"${enabled ? "" : " disabled"}></textarea>
						<button type="button" class="whatsapp-simulator__clear" aria-label="${escape_html(__("Clear the text"))}" title="${escape_html(__("Clear the text"))}">×</button>
					</span>
					<button type="button" class="whatsapp-simulator__round whatsapp-simulator__round--pri whatsapp-simulator__send" title="${escape_html(__("Send"))}" aria-label="${escape_html(__("Send"))}">${SEND_ICON}</button>
				</span>`);
			this.$input = this.$composer.find(".whatsapp-simulator__input");
			this.$composer.find(".whatsapp-simulator__clear").on("click", () => this.$input.val("").trigger("focus"));
			this.$composer.find(".whatsapp-simulator__send").on("click", () => this.ask_send());
			this.$composer.find(".whatsapp-simulator__behalf").on("click", () => this.ask_behalf());
			this.$composer.find("[data-attach-clear]").on("click", () => this.set_attach(null));
			this.$composer.find(".whatsapp-simulator__plus").on("click", (ev) =>
				new whatsapp.ui.AttachMenu({
					anchor: ev.currentTarget,
					// buttons and lists only when the plan includes them
					kinds: ["image", "video", "document", "audio", "location", "contact"].concat(
						((frappe.boot.whatsapp_next || {}).features || {}).interactive ? ["buttons", "list"] : []
					),
					search_contacts: (txt) =>
						whatsapp.ui.call("contacts.list_contacts", { search: txt || null, page_length: 20 }, { silent: true }).then((r) =>
							((r && r.rows) || []).map((c) => ({
								name: c.name,
								label: c.full_name || c.name,
								phone: ((c.phone_nos || []).find((p) => p.wa_phone_e164) || {}).wa_phone_e164 || "",
							}))
						),
					on_pick: (v) => this.set_attach(v),
				})
			);
			// Ctrl / Cmd + Enter sends, so a multi-line message can still be written comfortably
			this.$input.on("keydown", (ev) => {
				if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
					ev.preventDefault();
					this.ask_send();
				}
			});
		}

		/** What "+" picked (or nothing): the chip and the field's placeholder follow it; typed text stays. */
		set_attach(value) {
			const text = this.$input ? this.$input.val() : "";
			this.attach = value;
			this.render_composer();
			this.$input.val(text).trigger("focus");
		}

		/** The three guards the prototype states, each naming what to do about it. */
		guard({ need_device = true } = {}) {
			if (!this.contact) {
				new whatsapp.ui.Toast({ tone: "warning", title: __("No conversation is open"), message: __("Pick a contact from the list.") });
				return false;
			}
			if (!need_device) return true;
			if (!cstr(this.$input.val()).trim() && !this.attach) {
				new whatsapp.ui.Toast({ tone: "warning", title: __("The message is empty"), message: __("Write the message text, or pick a file, a location or a contact with «+».") });
				return false;
			}
			const device = this.current_device();
			if (!device || device.status !== "Connected") {
				new whatsapp.ui.Toast({
					tone: "warning",
					title: device ? __("The device is not connected") : __("No device is set up yet"),
					message: device ? __("Pick a connected device from the list at the top of the conversation.") : __("Pair a phone before sending a test."),
					action: { label: __("Open devices"), on_click: () => frappe.set_route("wa-devices") },
				});
				return false;
			}
			return true;
		}

		/**
		 * One message to the open conversation goes straight out, as in the prototype — it asks only
		 * before a many-recipient or scheduled send, which this composer does not make (D-135). The
		 * button waits while the request runs, so a double click cannot send twice.
		 */
		ask_send() {
			if (!this.guard() || this._sending) return;
			const body = cstr(this.$input.val()).trim();
			const $send = this.$composer.find(".whatsapp-simulator__send").prop("disabled", true).attr("aria-busy", "true").html(SENDING_ICON);
			this._sending = true;
			const a = this.attach || {};
			whatsapp.ui
				.call("simulator.send_test", {
					device: this.device,
					phone: this.contact.phone_e164,
					body,
					kind: a.kind || "text",
					attachment: a.attachment || null,
					contact: a.contact || null,
					location: a.location || null,
					interactive: a.interactive || null,
				})
				.then((r) => {
					this.$input.val("");
					if (this.attach) this.set_attach(null);
					this.sent_outbound = r && r.outbound;
					// no toast: it covered the composer and its button, and "queued" read as "not sent";
					// the button's tick and the message in the thread say it was handed over
					$send.addClass("is-sent").attr("aria-label", __("Sent")).html(SENT_ICON);
					whatsapp.ui.announce(__("The message was sent to the device."));
					if (this.contact.typed) {
						this.contact.typed = false;
						this.load_list();
					}
					this.refresh_newest();
				})
				.catch((err) => whatsapp.ui.Toast.error(err))
				.then(() => {
					this._sending = false;
					$send.prop("disabled", false).removeAttr("aria-busy");
					// the tick stays a moment, long enough to be seen, then the button is ready again
					window.setTimeout(() => $send.removeClass("is-sent").attr("aria-label", __("Send")).html(SEND_ICON), $send.hasClass("is-sent") ? 1400 : 0);
				});
		}

		ask_behalf() {
			if (!this.guard({ need_device: false })) return;
			if (!this.current_device()) {
				new whatsapp.ui.Toast({
					tone: "warning",
					title: __("No device is set up yet"),
					message: __("A simulated message is still recorded against a device."),
					action: { label: __("Open devices"), on_click: () => frappe.set_route("wa-devices") },
				});
				return;
			}
			const context = this.context || {};
			on_behalf_panel({
				contact: this.contact,
				device: this.device,
				commands: context.commands || [],
				commands_enabled: !!context.commands_enabled,
				draft: cstr(this.$input.val()).trim(),
				on_done: (r) => {
					this.$input.val("");
					this.behalf_toast(r);
					if (this.contact.typed) this.contact.typed = false;
					this.load_list();
					this.load_thread();
				},
			});
		}

		/** The simulation's own answer, said once: which command matched, or why it was refused. */
		behalf_toast(r) {
			const detail = r.block_reason
				? __("Refused: {0}", [__(r.block_reason)])
				: r.command
				? __("Command: {0}", [r.command])
				: __("No command matched this message.");
			new whatsapp.ui.Toast({ tone: r.block_reason ? "warning" : "success", title: __("Simulated — nothing was sent"), message: detail });
		}

		// ---- realtime ----------------------------------------------------------------------------

		subscribe() {
			if (this._subscribed) return;
			this._subscribed = true;
			this._on_status = (p) => {
				if (!p || !p.outbound) return;
				if (this.thread) this.thread.update_status(p.outbound, p.status);
				if (this.sent_outbound && p.outbound === this.sent_outbound && p.status === "Failed")
					new whatsapp.ui.Toast({ tone: "error", title: __("Test message {0}", [__(p.status)]), message: p.error_code ? __("Error: {0}", [p.error_code]) : "" });
			};
			this._on_inbound = whatsapp.ui.throttle(() => {
				this.refresh_newest();
				this.load_list();
			}, 1500);
			this._on_device = (p) => {
				if (!p || !p.device) return;
				const device = this.devices().find((d) => d.name === p.device);
				if (!device) return;
				device.status = p.status;
				this.render_head();
			};
			// every change on screen is announced: ticks (`wa:message:status`), new messages, edits and
			// deletions (`wa:inbound:received`), the device. The thread and the list are read again only
			// when the connection comes back or the person returns to the tab — never on a timer.
			const reread = () => {
				this.refresh_newest();
				this.load_list({ quiet: true });
			};
			this._stops = [
				whatsapp.ui.listen("wa:message:status", this._on_status),
				whatsapp.ui.listen("wa:inbound:received", this._on_inbound),
				whatsapp.ui.listen("wa:device:status", this._on_device),
				whatsapp.ui.on_reconnect(reread),
			];
		}

		unsubscribe() {
			if (!this._subscribed) return;
			(this._stops || []).forEach((stop) => stop());
			this._stops = null;
			this._subscribed = false;
		}

		destroy() {
			this.unsubscribe();
		}
	}

	frappe.pages[ROUTE].on_page_load = function (wrapper) {
		const page = frappe.ui.make_app_page({ parent: wrapper, title: __("WhatsApp Simulator"), single_column: true });
		wrapper.whatsapp_next = new Simulator(page);
		frappe.provide("whatsapp_next.pages");
		whatsapp_next.pages.simulator = wrapper.whatsapp_next;
		$(wrapper).on("hide", () => wrapper.whatsapp_next && wrapper.whatsapp_next.unsubscribe());
	};

	frappe.pages[ROUTE].on_page_show = function (wrapper) {
		const sim = wrapper.whatsapp_next;
		if (!sim) return;
		if (sim.context) {
			// back on the page: what arrived while it was hidden (realtime was off) is read again
			if (sim._hidden) {
				sim.load_list();
				sim.refresh_newest();
			}
			sim.subscribe();
		}
		sim._hidden = false;
		sim.open_from_route();
	};

	frappe.pages[ROUTE].on_page_hide = function (wrapper) {
		if (!wrapper.whatsapp_next) return;
		wrapper.whatsapp_next.unsubscribe();
		wrapper.whatsapp_next._hidden = true;
	};
})();

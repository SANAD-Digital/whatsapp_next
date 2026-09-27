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
// party-type badge (which opens "who is this"); "Send a bulk message" opens `sanad.ui.BulkSend`,
// D-136) — and the thread on the rest: the green header with
// the device picker, the note line, the kit's `ChatThread` over `messages.get_conversation`, and
// the prototype's composer (the "#" message-on-behalf button above "+", the rounded field, the round
// send). Under 900 px the list and the thread take the screen in turn, with a way back.

(() => {
	const ROUTE = "wa-simulator";
	const esc = (v) => sanad.ui.escape(v);
	const fmt_int = (v) => sanad.ui.format_int(v);
	const PAGE_LENGTH = 50;
	const LIST_LENGTH = 60;
	const SEND_ICON =
		'<svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 10.5l13-6-5 13-2-5-6-2z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"></path></svg>';
	const SEARCH_ICON =
		'<svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="5.5" stroke="currentColor" stroke-width="1.6"></circle><path d="M13.5 13.5L17 17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path></svg>';

	/** The list row title: a name when the number has one, the number itself otherwise. */
	const title_of = (row) => cstr(row.display_name) || cstr(row.phone_e164) || cstr(row.name);
	const hhmm = (ts) => (ts ? frappe.datetime.str_to_obj(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "");

	/** The badge the prototype puts on a row: the party type, or what the number is not. */
	const badge_of = (row) => {
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
		const panel = new sanad.ui.OverlayPanel({
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
							sanad.ui.Toast.warning(__("Pick a command or write the message the contact would send."));
							return false;
						}
						return sanad.ui
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
	 * The prototype's contact panel (`contactPanel`): who the number is — name, classification,
	 * account link, messages, last message — and what it is linked to (its accounts and the contact
	 * groups it belongs to), both in the rows layout: the label at the start, the value at the end.
	 */
	function identity_panel(row) {
		sanad.ui
			.call("simulator.get_identity", { phone_e164: row.phone_e164 || row.name })
			.then((who) => {
				const unknown = !who.contact;
				const badge = unknown
					? { text: __("Unknown number", null, "Simulator"), tone: "info" }
					: who.party_type
					? { text: __(who.party_type), tone: "muted" }
					: { text: __("No classification"), tone: "warn" };
				const ro = (key, label, value, extra = {}) => Object.assign({ key, label, type: "readonly", value }, extra);
				const facts = [
					ro("name", __("Name", null, "Simulator"), who.name || (unknown ? __("Not saved in contacts") : __("No name"))),
					ro("type", __("Classification"), unknown ? __("Not saved") : who.party_type ? __(who.party_type) : __("No classification — neither a customer nor a supplier")),
					ro("linked", __("Linked to an account"), who.link_status === "Linked" ? __("Linked to an account in the system") : __("Not linked")),
					ro("msgs", __("Messages", null, "Simulator"), __("{0} sent · {1} received", [fmt_int(who.outbound_count), fmt_int(who.inbound_count)])),
				];
				if (who.last_seen) facts.push(ro("last", __("Last message"), frappe.datetime.str_to_user(who.last_seen)));
				const links = []
					.concat(
						(who.accounts || []).map((a, i) => ro(`acc${i}`, a.title, __("{0} in the system", [__(a.doctype)]))),
						(who.groups || []).map((g, i) =>
							ro(`grp${i}`, g.label, g.kind === "Blacklist" ? __("Blacklist") : __("Contact group · {0} contacts", [fmt_int(g.member_count)]))
						)
					);
				if (!links.length)
					links.push(
						ro(
							"none",
							unknown ? __("A number not saved as a contact") : __("Nothing linked"),
							unknown ? __("No accounts and no groups — commands that need a linked account will refuse it") : __("No accounts and no groups are linked to this contact yet")
						)
					);
				new sanad.ui.OverlayPanel({
					type: "modal",
					width: "44%",
					title: who.name || who.phone_e164,
					subtitle: who.phone_e164,
					subtitle_mono: true,
					badge,
					sections: [
						{ title: __("Who this is"), layout: "rows", fields: facts },
						{ title: __("What it is linked to"), layout: "rows", fields: links },
					],
					actions: [{ key: "close", label: __("Close"), variant: "primary", close: true }],
				}).show();
			})
			.catch((err) => sanad.ui.Toast.error(err));
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
			this.$main = $(page.main).addClass("sanad-kit wa-sim");
			this.build();
			this.load_context();
		}

		build() {
			this.$main.html(`
				<section class="wa-sim__list-pane" aria-label="${esc(__("Conversations"))}">
					<div class="wa-sim__list-head">
						<div class="wa-sim__list-line">
							<h2 class="wa-sim__list-title">${esc(__("Conversations"))}</h2>
							<button type="button" class="wa-sim__bulk">${SEND_ICON}<span>${esc(__("Send a bulk message"))}</span></button>
						</div>
						<label class="wa-sim__search">
							${SEARCH_ICON}
							<input type="search" dir="auto" data-sanad-bare placeholder="${esc(__("Search by name or number…"))}" aria-label="${esc(__("Search by name or number"))}" />
						</label>
					</div>
					<div class="wa-sim__list" role="list"></div>
				</section>
				<section class="wa-sim__main" aria-label="${esc(__("Conversation"))}">
					<div class="wa-sim__head"></div>
					<div class="wa-sim__note" role="status"></div>
					<div class="wa-sim__thread"></div>
					<div class="wa-sim__composer"></div>
				</section>`);
			this.$list = this.$main.find(".wa-sim__list");
			this.$head = this.$main.find(".wa-sim__head");
			this.$note = this.$main.find(".wa-sim__note");
			this.$thread = this.$main.find(".wa-sim__thread");
			this.$composer = this.$main.find(".wa-sim__composer");
			this.$search = this.$main.find(".wa-sim__search input");
			this.list_state = new sanad.ui.EmptyState({ wrapper: this.$list, state: "loading", rows: 5 });
			this.$main.find(".wa-sim__bulk").on("click", () => this.open_bulk());
			this.$search.on(
				"input",
				sanad.ui.debounce(() => {
					this.search = cstr(this.$search.val()).trim();
					this.load_list();
				}, 300)
			);
		}

		/** The prototype's "Send a bulk message" window (D-136): the send becomes a campaign. */
		open_bulk() {
			const call = (method, args) => sanad.ui.call(`bulk_send.${method}`, args);
			return new sanad.ui.BulkSend({
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
			return sanad.ui
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
				})
				.catch((err) => {
					this.$thread.empty();
					new sanad.ui.EmptyState({ wrapper: this.$thread, state: "error" }).error(err, {
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

		// ---- the conversation list -------------------------------------------------------------

		load_list() {
			this.list_state.loading({ rows: 5 });
			return sanad.ui
				.call("simulator.list_conversations", { txt: this.search || null, limit: LIST_LENGTH })
				.then((r) => {
					this.rows = (r && r.rows) || [];
					this.total = r && r.total;
					this.list_state.hide();
					this.render_list();
				})
				.catch((err) =>
					this.list_state.error(err, {
						title: __("Could not load the numbers"),
						action: { label: __("Retry"), on_click: () => this.load_list() },
					})
				);
		}

		/** A number typed into the search is a valid conversation even when it was never seen. */
		typed_number() {
			if (!this.search) return null;
			const guess = sanad.ui.PhoneField.normalize(this.search);
			if (!guess.valid) return null;
			if (this.rows.some((r) => r.phone_e164 === guess.phone_e164)) return null;
			return { name: guess.phone_e164, phone_e164: guess.phone_e164, display_name: "", link_status: "Not Linked", typed: true };
		}

		render_list() {
			const typed = this.typed_number();
			const rows = typed ? [typed].concat(this.rows) : this.rows;
			if (!rows.length) {
				this.$list.html(`<span class="wa-sim__none">${esc(this.search ? __("No results match the search.") : __("No conversation yet. Numbers appear here once a message has been exchanged with them."))}</span>`);
				return;
			}
			this.$list.html(
				rows
					.map((row) => {
						const on = this.contact && this.contact.phone_e164 === row.phone_e164;
						const unsaved = !row.display_name;
						const b = badge_of(row);
						const preview = row.typed ? __("A new number — type a message to start") : cstr(row.last_body).split("\n")[0] || row.phone_e164;
						return `<div class="wa-sim__row${on ? " is-on" : ""}" role="listitem">
							<button type="button" class="wa-sim__row-main" data-key="${esc(row.phone_e164)}" aria-current="${on ? "true" : "false"}">
								<span class="wa-sim__avatar${!row.contact ? " wa-sim__avatar--nf" : ""}" aria-hidden="true">${esc(unsaved ? "#" : sanad.ui.initials(title_of(row)))}</span>
								<span class="wa-sim__row-text">
									<span class="wa-sim__row-line">
										<span class="wa-sim__row-name"${unsaved ? ' dir="ltr"' : ""}>${esc(title_of(row))}</span>
										<span class="wa-sim__row-at" dir="ltr">${esc(hhmm(row.last_at))}</span>
									</span>
									<span class="wa-sim__row-sub" dir="auto">${esc(preview)}</span>
								</span>
							</button>
							${row.typed ? "" : `<button type="button" class="wa-sim__badge wa-sim__badge--${b.tone}" data-who="${esc(row.phone_e164)}" title="${esc(__("Contact details"))}">${esc(b.text)}</button>`}
						</div>`;
					})
					.join("") +
					(this.total != null && this.total > rows.length
						? `<p class="wa-sim__more">${esc(__("Showing {0} of {1}. Search to narrow the list.", [fmt_int(this.rows.length), fmt_int(this.total)]))}</p>`
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
			this.$main.addClass("wa-sim--open");
			this.render_list();
			this.render_head();
			this.render_composer();
			this.load_thread();
			sanad.ui.announce(__("Conversation with {0} opened.", [title_of(row)]));
		}

		back() {
			this.contact = null;
			this.$main.removeClass("wa-sim--open");
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
				? `${c.phone_e164}${c.link_status === "Linked" ? ` · ${__("Linked to an account", null, "Command Editor")}` : ""}`
				: __("Pick a contact from the list, then write the message");
			this.$head.html(`
				${c ? `<button type="button" class="wa-sim__back" title="${esc(__("All conversations"))}" aria-label="${esc(__("All conversations"))}">→</button>` : ""}
				<span class="wa-sim__head-icon" aria-hidden="true">${SEND_ICON.replace('width="14" height="14"', 'width="18" height="18"')}</span>
				<button type="button" class="wa-sim__head-text"${c ? "" : " disabled"}>
					<span class="wa-sim__head-title">${c && !c.display_name ? `<bdi dir="ltr">${esc(title_of(c))}</bdi>` : esc(c ? title_of(c) : __("WhatsApp simulator"))}</span>
					<span class="wa-sim__head-sub"${c ? ' dir="auto"' : ""}>${esc(sub)}</span>
				</button>
				${
					devices.length
						? `<span class="wa-sim__device">
								<span class="wa-sim__dot${device && device.status === "Connected" ? " is-on" : ""}" aria-hidden="true"></span>
								<select class="wa-sim__device-select" title="${esc(__("Sending device"))}" aria-label="${esc(__("Sending device"))}">${devices
									.map((d) => `<option value="${esc(d.name)}" ${d.name === this.device ? "selected" : ""}>${esc((d.device_name || d.name) + (d.status === "Connected" ? "" : ` — ${__("not connected")}`))}</option>`)
									.join("")}</select>
							</span>`
						: `<button type="button" class="wa-sim__device wa-sim__pair">${esc(__("Pair a device"))}</button>`
				}`);
			this.$head.find(".wa-sim__back").on("click", () => this.back());
			this.$head.find(".wa-sim__head-text").on("click", () => c && identity_panel(c));
			this.$head.find(".wa-sim__pair").on("click", () => frappe.set_route("wa-devices"));
			this.$head.find(".wa-sim__device-select").on("change", (ev) => {
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
			this.$note.html(`<span class="wa-sim__note-dot" aria-hidden="true"></span><span>${esc(text)}</span>`);
		}

		// ---- the thread ------------------------------------------------------------------------

		empty_thread(title, text) {
			this.$thread.html(`<div class="wa-sim__empty"><strong>${esc(title)}</strong><span>${esc(text)}</span></div>`);
		}

		load_thread() {
			this.thread = null;
			this.next_cursor = null;
			if (!this.contact) {
				this.empty_thread(__("Pick a conversation"), __("The contacts are in the list beside. To send to several groups and numbers at once use «Send a bulk message»."));
				return Promise.resolve();
			}
			if (this.contact.typed) {
				this.empty_thread(__("No messages yet"), __("Write in the box below to start the conversation — it shows here as the recipient gets it."));
				return Promise.resolve();
			}
			this.$thread.empty();
			const state = new sanad.ui.EmptyState({ wrapper: this.$thread, state: "loading", rows: 4 });
			return this.fetch_page()
				.then((page) => {
					const rows = ((page && page.rows) || []).slice().reverse();
					this.next_cursor = page && page.has_more ? page.next_cursor : null;
					state.hide();
					this.$thread.empty();
					if (!rows.length) {
						this.empty_thread(__("No messages yet"), __("Write in the box below to start the conversation — it shows here as the recipient gets it."));
						return;
					}
					this.thread = new sanad.ui.ChatThread({
						wrapper: this.$thread,
						rows,
						has_more: !!this.next_cursor,
						on_load_more: () => this.load_older(),
						on_row_click: (row) => frappe.set_route("Form", row.direction === "Outbound" ? "WhatsApp Log" : "WhatsApp Inbound Message", row.name),
						empty_text: __("No messages yet"),
					});
				})
				.catch((err) => {
					const forbidden = err && (err.http_status === 403 || /PermissionError/.test(err.exc_type || ""));
					state.set("error", {
						title: forbidden ? __("No access to conversations") : __("Could not load the conversation"),
						description: forbidden ? __("You do not have permission to read messages. Ask an administrator for access.") : err.message,
						action: forbidden ? null : { label: __("Retry"), on_click: () => this.load_thread() },
					});
				});
		}

		fetch_page(before) {
			const args = { key: this.contact.phone_e164, limit: PAGE_LENGTH };
			if (before) args.before = before;
			return sanad.ui.call("messages.get_conversation", args, { silent: true });
		}

		load_older() {
			if (!this.next_cursor || !this.thread) return Promise.resolve();
			return this.fetch_page(this.next_cursor).then((page) => {
				const rows = ((page && page.rows) || []).slice().reverse();
				this.next_cursor = page && page.has_more ? page.next_cursor : null;
				const added = this.thread.prepend(rows);
				this.thread.set_has_more(!!this.next_cursor);
				if (added) sanad.ui.announce(sanad.ui.plural(added, { one: __("{0} older message loaded."), other: __("{0} older messages loaded.") }));
			});
		}

		/** After a send or a simulation the newest page carries the rows we just created. */
		refresh_newest() {
			if (!this.contact) return Promise.resolve();
			if (!this.thread) return this.load_thread();
			if (this._refreshing) return Promise.resolve();
			this._refreshing = true;
			return this.fetch_page()
				.then((page) => {
					const added = this.thread.append(((page && page.rows) || []).slice().reverse());
					if (added) sanad.ui.announce(sanad.ui.plural(added, { one: __("{0} new message."), other: __("{0} new messages.") }));
				})
				.catch(() => {})
				.then(() => {
					this._refreshing = false;
				});
		}

		// ---- the composer ----------------------------------------------------------------------

		/**
		 * The prototype's composer (`docs/component/Chat Thread.dc.html`): the round "#" (message on
		 * behalf) above the round "+", the rounded two-line field with its clear, and the round send.
		 * "+" chooses the kind of message in the prototype; `simulator.send_test` takes a text body
		 * only (Gap G-04), so it is drawn disabled with that reason rather than drawn dead.
		 */
		render_composer() {
			const enabled = !!this.contact;
			this.$composer.html(`
				<span class="wa-sim__tools">
					${enabled ? `<button type="button" class="wa-sim__round wa-sim__round--info wa-sim__behalf" title="${esc(__("Message on behalf — simulate a message from the contact without a real send"))}" aria-label="${esc(__("Message on behalf"))}">#</button>` : ""}
					<button type="button" class="wa-sim__round wa-sim__round--plain" disabled title="${esc(__("Attachments are not supported in a test send yet"))}" aria-label="${esc(__("Message type"))}">+</button>
				</span>
				<span class="wa-sim__field">
					<label class="sanad-visually-hidden" for="wa-sim-body">${esc(__("Message"))}</label>
					<textarea id="wa-sim-body" class="wa-sim__input" rows="2" placeholder="${esc(enabled ? __("Write your message…") : __("Pick a contact from the list first…"))}"${enabled ? "" : " disabled"}></textarea>
					<button type="button" class="wa-sim__clear" aria-label="${esc(__("Clear the text"))}" title="${esc(__("Clear the text"))}">×</button>
				</span>
				<button type="button" class="wa-sim__round wa-sim__round--pri wa-sim__send" title="${esc(__("Send"))}" aria-label="${esc(__("Send"))}">${SEND_ICON}</button>`);
			this.$input = this.$composer.find(".wa-sim__input");
			this.$composer.find(".wa-sim__clear").on("click", () => this.$input.val("").trigger("focus"));
			this.$composer.find(".wa-sim__send").on("click", () => this.ask_send());
			this.$composer.find(".wa-sim__behalf").on("click", () => this.ask_behalf());
			// Ctrl / Cmd + Enter sends, so a multi-line message can still be written comfortably
			this.$input.on("keydown", (ev) => {
				if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
					ev.preventDefault();
					this.ask_send();
				}
			});
		}

		/** The three guards the prototype states, each naming what to do about it. */
		guard({ need_device = true } = {}) {
			if (!this.contact) {
				new sanad.ui.Toast({ tone: "warning", title: __("No conversation is open"), message: __("Pick a contact from the list.") });
				return false;
			}
			if (!need_device) return true;
			if (!cstr(this.$input.val()).trim()) {
				new sanad.ui.Toast({ tone: "warning", title: __("The message is empty"), message: __("Write the message text.") });
				return false;
			}
			const device = this.current_device();
			if (!device || device.status !== "Connected") {
				new sanad.ui.Toast({
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
			const $send = this.$composer.find(".wa-sim__send").prop("disabled", true);
			this._sending = true;
			sanad.ui
				.call("simulator.send_test", { device: this.device, phone: this.contact.phone_e164, body })
				.then((r) => {
					this.$input.val("");
					this.sent_outbound = r && r.outbound;
					sanad.ui.Toast.success(__("Message queued"));
					if (this.contact.typed) {
						this.contact.typed = false;
						this.load_list();
					}
					this.refresh_newest();
				})
				.catch((err) => sanad.ui.Toast.error(err))
				.then(() => {
					this._sending = false;
					$send.prop("disabled", false);
				});
		}

		ask_behalf() {
			if (!this.guard({ need_device: false })) return;
			if (!this.current_device()) {
				new sanad.ui.Toast({
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
			new sanad.ui.Toast({ tone: r.block_reason ? "warning" : "success", title: __("Simulated — nothing was sent"), message: detail });
		}

		// ---- realtime ----------------------------------------------------------------------------

		subscribe() {
			if (this._subscribed) return;
			this._subscribed = true;
			this._on_status = (p) => {
				if (!p || !p.outbound) return;
				if (this.thread) this.thread.update_status(p.outbound, p.status);
				if (this.sent_outbound && p.outbound === this.sent_outbound && p.status === "Failed")
					new sanad.ui.Toast({ tone: "error", title: __("Test message {0}", [__(p.status)]), message: p.error_code ? __("Error: {0}", [p.error_code]) : "" });
			};
			this._on_inbound = sanad.ui.throttle(() => {
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
			frappe.realtime.on("wa:message:status", this._on_status);
			frappe.realtime.on("wa:inbound:received", this._on_inbound);
			frappe.realtime.on("wa:device:status", this._on_device);
		}

		unsubscribe() {
			if (!this._subscribed) return;
			frappe.realtime.off("wa:message:status", this._on_status);
			frappe.realtime.off("wa:inbound:received", this._on_inbound);
			frappe.realtime.off("wa:device:status", this._on_device);
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
		if (wrapper.whatsapp_next && wrapper.whatsapp_next.context) wrapper.whatsapp_next.subscribe();
	};

	frappe.pages[ROUTE].on_page_hide = function (wrapper) {
		if (wrapper.whatsapp_next) wrapper.whatsapp_next.unsubscribe();
	};
})();

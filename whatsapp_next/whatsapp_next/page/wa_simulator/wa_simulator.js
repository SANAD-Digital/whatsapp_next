// WhatsApp Simulator (09 row 11) — the testing bench of the product. Two things happen here, and
// the screen never lets them be confused:
//
//   • "Message on behalf" (`simulator.simulate_inbound`) writes a message *as if the contact had
//     sent it*, runs the command router over it and stores the reply — all marked simulated, and
//     nothing ever leaves the site. This is how an operator checks what a customer would get.
//   • "Send test" (`simulator.send_test`) sends one real WhatsApp message from a chosen device.
//     It is confirmed first, because it cannot be recalled.
//
// Anatomy, from the prototype (`docs/screen/Hub Screen - WhatsApp Simulator.dc.html`): the
// conversation rail with its search on the inline-start, the identity header with the device
// picker, the thread (the kit's `ChatThread` over `messages.get_conversation`), the result strip
// and the composer. Page-local: SimulatorComposer; everything else is kit or API.

(() => {
	const ROUTE = "wa-simulator";
	const esc = (v) => sanad.ui.escape(v);
	const fmt_int = (v) => sanad.ui.format_int(v);
	const PAGE_LENGTH = 50;
	const RAIL_LENGTH = 30;

	const device_tone = (status) => (status === "Connected" ? "green" : status === "Disconnected" ? "amber" : "red");
	const link_tone = (status) => (status === "Linked" ? "green" : status === "Not Linked" ? "amber" : "gray");

	/** The rail row title: a name when the number has one, the number itself otherwise. */
	const title_of = (row) => cstr(row.display_name) || cstr(row.phone_e164) || cstr(row.name);

	// ---- the "message on behalf" dialog --------------------------------------------------------

	/**
	 * A message written in the contact's name. The commands the site runs are offered as a grid —
	 * the words a real sender would write — and anything else can be typed by hand; the note says
	 * plainly that nothing is sent.
	 */
	function on_behalf_dialog({ contact, device, commands, commands_enabled, on_done }) {
		const dialog = new frappe.ui.Dialog({
			title: __("Message on behalf"),
			size: "large",
			fields: [
				{ fieldtype: "HTML", fieldname: "intro" },
				{ fieldtype: "HTML", fieldname: "commands" },
				{
					fieldtype: "Small Text",
					fieldname: "body",
					label: __("Message text"),
					reqd: 1,
					description: __("Typing here clears the chosen command. A text that matches no command gets the default reply."),
				},
				{
					fieldtype: "Check",
					fieldname: "run_commands",
					label: __("Run the commands over this message"),
					default: commands_enabled ? 1 : 0,
					read_only: commands_enabled ? 0 : 1,
				},
			],
			primary_action_label: __("Send on behalf"),
			primary_action: (values) => {
				const text = cstr(values.body).trim();
				if (!text) return sanad.ui.Toast.warning(__("Write the message the contact would send."));
				const $btn = dialog.get_primary_btn().prop("disabled", true);
				sanad.ui
					.call("simulator.simulate_inbound", {
						device,
						sender_phone: contact.phone_e164,
						text,
						run_commands: values.run_commands ? 1 : 0,
					})
					.then((r) => {
						dialog.hide();
						on_done(r, text);
					})
					.catch((err) => {
						$btn.prop("disabled", false);
						sanad.ui.Toast.error(err);
					});
			},
		});
		dialog.$wrapper.addClass("sanad-kit sanad-sheet wa-sim-behalf");
		dialog.get_field("intro").$wrapper.html(`
			<p class="wa-sim-behalf__intro">${esc(
				__("Simulate a message from {0} to see the reply it would get.", [title_of(contact)])
			)}</p>
			<span class="sanad-chip sanad-chip--sm sanad-tone--blue">${esc(__("Nothing is sent"))}</span>`);
		const $commands = dialog.get_field("commands").$wrapper;
		if (!commands_enabled) {
			$commands.html(
				`<p class="wa-sim-behalf__note" role="status">${esc(
					__("Commands are switched off in the settings, so the message is only stored.")
				)}</p>`
			);
		} else if (!commands.length) {
			new sanad.ui.EmptyState({
				wrapper: $commands,
				state: "empty",
				size: "sm",
				title: __("No active command"),
				description: __("A command carries the word a sender writes. Create one to test a reply."),
				action: { label: __("Open commands"), on_click: () => frappe.set_route("List", "WhatsApp Command") },
			});
		} else {
			$commands.html(`
				<span class="wa-sim-behalf__label">${esc(__("A command the site answers"))}</span>
				<div class="wa-sim-behalf__grid">${commands
					.map(
						(c) =>
							`<button type="button" class="wa-sim-behalf__cmd" data-code="${esc(c.code)}" aria-pressed="false">
								<code>${esc(c.code)}</code>
								<span>${esc(c.title || c.function || "")}</span>
								${c.synonyms ? `<span class="wa-sim-behalf__syn">${esc(cstr(c.synonyms).split("\n").slice(0, 2).join(" / "))}</span>` : ""}
							</button>`
					)
					.join("")}</div>`);
			$commands.find("[data-code]").on("click", (ev) => {
				const code = $(ev.currentTarget).data("code");
				dialog.set_value("body", code);
				$commands.find("[data-code]").attr("aria-pressed", "false");
				$(ev.currentTarget).attr("aria-pressed", "true");
			});
		}
		dialog.show();
		return dialog;
	}

	// ---- the identity panel --------------------------------------------------------------------

	/** "Who is this?" — the number, what it is linked to, and what has passed between us. */
	function identity_dialog(row) {
		const dialog = new frappe.ui.Dialog({
			title: title_of(row),
			fields: [{ fieldtype: "HTML", fieldname: "body" }],
		});
		dialog.$wrapper.addClass("sanad-kit sanad-sheet wa-sim-who");
		const $body = dialog.get_field("body").$wrapper;
		const state = new sanad.ui.EmptyState({ wrapper: $body, state: "loading", rows: 3 });
		dialog.show();
		const render = (number, contact) => {
			const facts = [
				[__("Number"), `<span dir="ltr" class="sanad-tabular">${esc(number.phone_e164 || number.name)}</span>`],
				[__("Name"), esc(number.display_name || (contact && contact.full_name) || __("Not saved in contacts"))],
				[
					__("Linked to an account"),
					sanad.ui.StatusBadge.html({
						label: __(number.link_status || "Not Linked"),
						colour: link_tone(number.link_status),
					}),
				],
				[
					__("Messages"),
					`<span class="sanad-tabular">${esc(
						__("{0} sent · {1} received", [fmt_int(number.outbound_count), fmt_int(number.inbound_count)])
					)}</span>`,
				],
				[
					__("Last message"),
					esc(number.last_seen ? frappe.datetime.str_to_user(number.last_seen) : __("None yet")),
				],
				[
					__("Conversation confirmed"),
					esc(number.conversation_confirmed ? __("Yes") : __("No")),
				],
			];
			const links = (contact && contact.links) || [];
			const linked_html = links.length
				? `<ul class="wa-sim-who__links">${links
						.map(
							(l) =>
								`<li><span class="sanad-chip sanad-chip--sm">${esc(__(l.link_doctype))}</span> ${esc(
									l.link_title || l.link_name
								)}</li>`
						)
						.join("")}</ul>`
				: `<p class="wa-sim-who__muted">${esc(
						number.contact
							? __("This contact is not linked to any account.")
							: __("This number is not saved as a contact, so commands that need an account will refuse it.")
				  )}</p>`;
			$body.html(`
				<dl class="wa-sim-who__facts">${facts
					.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`)
					.join("")}</dl>
				<h3 class="wa-sim-who__title">${esc(__("What it is linked to"))}</h3>
				${linked_html}`);
		};
		sanad.ui
			.call("numbers.get_number", { phone_e164: row.phone_e164 || row.name })
			.then((number) => {
				const contact = number.contact_summary;
				state.hide();
				if (!number.contact || !contact) return render(number, null);
				return sanad.ui
					.call("contacts.get_contact", { name: number.contact }, { silent: true })
					.then((full) => render(number, full))
					.catch(() => render(number, contact));
			})
			.catch((err) =>
				state.error(err, {
					title: __("Could not read this number"),
					description: __("It has not been seen in a message yet."),
				})
			);
		return dialog;
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
				<div class="wa-sim__rail">
					<div class="wa-sim__rail-head">
						<h2 class="wa-sim__rail-title">${esc(__("Conversations"))}</h2>
						<p class="wa-sim__rail-sub">${esc(__("Numbers this site has exchanged messages with."))}</p>
						<input type="search" class="form-control wa-sim__search" dir="auto"
							placeholder="${esc(__("Search a name or a number…"))}"
							aria-label="${esc(__("Search a name or a number"))}" />
					</div>
					<div class="wa-sim__list"></div>
				</div>
				<div class="wa-sim__main">
					<div class="wa-sim__head"></div>
					<div class="wa-sim__hint" role="status"></div>
					<div class="wa-sim__result" role="status" hidden></div>
					<div class="wa-sim__thread"></div>
					<div class="wa-sim__composer"></div>
				</div>`);
			this.$rail = this.$main.find(".wa-sim__rail");
			this.$list = this.$main.find(".wa-sim__list");
			this.$head = this.$main.find(".wa-sim__head");
			this.$hint = this.$main.find(".wa-sim__hint");
			this.$result = this.$main.find(".wa-sim__result");
			this.$thread = this.$main.find(".wa-sim__thread");
			this.$composer = this.$main.find(".wa-sim__composer");
			this.$search = this.$main.find(".wa-sim__search");
			this.list_state = new sanad.ui.EmptyState({ wrapper: this.$list, state: "loading", rows: 5 });
			this.thread_state = new sanad.ui.EmptyState({ wrapper: this.$thread, state: "loading", rows: 4 });
			this.$search.on(
				"input",
				sanad.ui.debounce(() => {
					this.search = cstr(this.$search.val()).trim();
					this.load_rail();
				}, 300)
			);
		}

		// ---- context ---------------------------------------------------------------------------

		load_context() {
			return sanad.ui
				.call("simulator.get_context")
				.then((context) => {
					this.context = context;
					const devices = context.devices || [];
					this.device = context.default_device || (devices[0] || {}).name || null;
					this.render_head();
					this.render_composer();
					this.load_rail();
					this.load_thread();
					this.subscribe();
				})
				.catch((err) => {
					this.thread_state.error(err, {
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

		// ---- the rail --------------------------------------------------------------------------

		load_rail() {
			this.list_state.loading({ rows: 5 });
			return sanad.ui
				.call("numbers.search_numbers", { txt: this.search || null, page: 1, page_length: RAIL_LENGTH })
				.then((r) => {
					this.rows = (r && r.rows) || [];
					this.list_state.hide();
					this.render_rail(r && r.total);
				})
				.catch((err) =>
					this.list_state.error(err, {
						title: __("Could not load the numbers"),
						action: { label: __("Retry"), on_click: () => this.load_rail() },
					})
				);
		}

		/** A number typed into the search is a valid conversation even when it was never seen. */
		typed_number() {
			if (!this.search) return null;
			const guess = sanad.ui.PhoneField.normalize(this.search);
			if (!guess.valid) return null;
			if (this.rows.some((r) => r.phone_e164 === guess.phone_e164)) return null;
			return { name: guess.phone_e164, phone_e164: guess.phone_e164, display_name: "", link_status: "Not Linked" };
		}

		render_rail(total) {
			const typed = this.typed_number();
			const rows = typed ? [typed].concat(this.rows) : this.rows;
			if (!rows.length) {
				this.$list.empty();
				new sanad.ui.EmptyState({
					wrapper: this.$list,
					state: "empty",
					size: "sm",
					title: this.search ? __("No number matches") : __("No number yet"),
					description: this.search
						? __("Type a full number with its country code to message it anyway.")
						: __("Numbers appear here once a message has been exchanged with them."),
				});
				return;
			}
			this.$list.html(
				rows
					.map((row) => {
						const on = this.contact && this.contact.phone_e164 === row.phone_e164;
						const name = title_of(row);
						const unsaved = !row.display_name;
						return `<button type="button" class="wa-sim__row${on ? " wa-sim__row--on" : ""}"
							data-key="${esc(row.phone_e164)}" aria-current="${on ? "true" : "false"}">
							<span class="wa-sim__avatar" aria-hidden="true">${esc(unsaved ? "#" : sanad.ui.initials(name))}</span>
							<span class="wa-sim__row-text">
								<span class="wa-sim__row-line">
									<span class="wa-sim__row-name"${unsaved ? ' dir="ltr"' : ""}>${esc(name)}</span>
									<span class="wa-sim__row-at">${esc(
										row.last_seen ? frappe.datetime.prettyDate(row.last_seen, true) : ""
									)}</span>
								</span>
								<span class="wa-sim__row-line">
									<span class="wa-sim__row-sub" dir="ltr">${esc(row.phone_e164)}</span>
									${sanad.ui.StatusBadge.html({
										label: __(row.link_status || "Not Linked"),
										colour: link_tone(row.link_status),
										icon: false,
									})}
								</span>
							</span>
						</button>`;
					})
					.join("")
			);
			this.$list.find("[data-key]").on("click", (ev) => {
				const key = $(ev.currentTarget).data("key");
				const row = rows.find((r) => r.phone_e164 === key);
				if (row) this.select(row);
			});
			if (total != null && total > rows.length) {
				$(`<p class="wa-sim__more">${esc(
					__("Showing {0} of {1}. Search to narrow the list.", [fmt_int(rows.length), fmt_int(total)])
				)}</p>`).appendTo(this.$list);
			}
		}

		select(row) {
			this.contact = row;
			this.$main.addClass("wa-sim--open");
			this.render_rail();
			this.render_head();
			this.render_composer();
			this.hide_result();
			this.load_thread();
			sanad.ui.announce(__("Conversation with {0} opened.", [title_of(row)]));
		}

		back() {
			this.contact = null;
			this.$main.removeClass("wa-sim--open");
			this.render_rail();
			this.render_head();
			this.render_composer();
			this.load_thread();
		}

		// ---- the header ------------------------------------------------------------------------

		render_head() {
			const c = this.contact;
			const devices = this.devices();
			const device = this.current_device();
			const options = devices
				.map(
					(d) =>
						`<option value="${esc(d.name)}" ${d.name === this.device ? "selected" : ""}>${esc(
							d.status === "Connected"
								? d.device_name || d.name
								: __("{0} — not connected", [d.device_name || d.name])
						)}</option>`
				)
				.join("");
			this.$head.html(`
				<button type="button" class="wa-sim__back btn btn-default btn-xs">${esc(__("Back to the list"))}</button>
				<div class="wa-sim__identity">
					<span class="wa-sim__avatar wa-sim__avatar--lg" aria-hidden="true">${esc(
						c ? (c.display_name ? sanad.ui.initials(title_of(c)) : "#") : "?"
					)}</span>
					<span class="wa-sim__identity-text">
						<span class="wa-sim__identity-name">${esc(c ? title_of(c) : __("WhatsApp simulator"))}</span>
						<span class="wa-sim__identity-sub"${c ? ' dir="ltr"' : ""}>${esc(
							c ? c.phone_e164 : __("Pick a contact from the list, then write the message.")
						)}</span>
					</span>
					${
						c
							? `<button type="button" class="btn btn-default btn-xs wa-sim__who">${esc(__("Who is this?"))}</button>`
							: ""
					}
				</div>
				<div class="wa-sim__device">
					${
						devices.length
							? `<span class="wa-sim__dot sanad-tone--${device_tone(device && device.status)}" aria-hidden="true"></span>
								<label class="sanad-visually-hidden" for="wa-sim-device">${esc(__("Device"))}</label>
								<select class="form-control wa-sim__device-select" id="wa-sim-device">${options}</select>
								<button type="button" class="btn btn-default btn-xs wa-sim__devices">${esc(__("Devices"))}</button>`
							: `<button type="button" class="btn btn-primary btn-xs wa-sim__devices">${esc(__("Pair a device"))}</button>`
					}
				</div>`);
			this.$head.find(".wa-sim__back").on("click", () => this.back());
			this.$head.find(".wa-sim__who").on("click", () => identity_dialog(this.contact));
			this.$head.find(".wa-sim__devices").on("click", () => frappe.set_route("wa-devices"));
			this.$head.find(".wa-sim__device-select").on("change", (ev) => {
				this.device = $(ev.currentTarget).val();
				this.render_head();
				this.render_hint();
			});
			this.render_hint();
		}

		/** One line that says what this screen will do next — the prototype's note strip. */
		render_hint() {
			const device = this.current_device();
			if (!this.devices().length) {
				this.$hint.html(esc(__("No device is set up yet. Pair a phone to send a test message.")));
				return;
			}
			if (!this.contact) {
				this.$hint.html(esc(__("Pick a contact to open its conversation and enable sending.")));
				return;
			}
			if (device && device.status !== "Connected") {
				this.$hint.html(
					esc(__("{0} is not connected. A test send needs a connected device; a message on behalf does not.", [
						device.device_name || device.name,
					]))
				);
				return;
			}
			this.$hint.html(
				esc(__("Sending is real. “Message on behalf” only simulates an incoming message and sends nothing."))
			);
		}

		// ---- the thread ------------------------------------------------------------------------

		load_thread() {
			this.thread = null;
			this.next_cursor = null;
			if (!this.contact) {
				this.$thread.empty();
				this.thread_state = new sanad.ui.EmptyState({
					wrapper: this.$thread,
					state: "empty",
					title: __("Pick a conversation"),
					description: __("The numbers on the side are the ones this site has messaged. Pick one to see its thread."),
				});
				return Promise.resolve();
			}
			this.$thread.empty();
			this.thread_state = new sanad.ui.EmptyState({ wrapper: this.$thread, state: "loading", rows: 4 });
			return this.fetch_page()
				.then((page) => {
					const rows = ((page && page.rows) || []).slice().reverse();
					this.next_cursor = page && page.has_more ? page.next_cursor : null;
					this.thread_state.hide();
					this.$thread.empty();
					this.thread = new sanad.ui.ChatThread({
						wrapper: this.$thread,
						rows,
						has_more: !!this.next_cursor,
						on_load_more: () => this.load_older(),
						on_row_click: (row) =>
							frappe.set_route(
								"Form",
								row.direction === "Outbound" ? "WhatsApp Log" : "WhatsApp Inbound Message",
								row.name
							),
						empty_text: __("No message yet"),
						empty_description: __("Write below to send a test, or simulate one on behalf of this contact."),
					});
				})
				.catch((err) => {
					const forbidden = err && (err.http_status === 403 || /PermissionError/.test(err.exc_type || ""));
					this.thread_state.set("error", {
						title: forbidden ? __("No access to conversations") : __("Could not load the conversation"),
						description: forbidden
							? __("You do not have permission to read messages. Ask an administrator for access.")
							: err.message,
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
				if (added)
					sanad.ui.announce(
						sanad.ui.plural(added, { one: __("{0} older message loaded."), other: __("{0} older messages loaded.") })
					);
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
					const rows = ((page && page.rows) || []).slice().reverse();
					const added = this.thread.append(rows);
					if (added)
						sanad.ui.announce(
							sanad.ui.plural(added, { one: __("{0} new message."), other: __("{0} new messages.") })
						);
				})
				.catch(() => {})
				.then(() => {
					this._refreshing = false;
				});
		}

		// ---- the composer ----------------------------------------------------------------------

		render_composer() {
			const enabled = !!this.contact;
			this.$composer.html(`
				<label class="sanad-visually-hidden" for="wa-sim-body">${esc(__("Message"))}</label>
				<textarea id="wa-sim-body" class="form-control wa-sim__input" rows="2" dir="auto"
					placeholder="${esc(
						enabled ? __("Write the message…") : __("Pick a contact from the list first…")
					)}"></textarea>
				<div class="wa-sim__actions">
					${
						enabled
							? `<button type="button" class="btn btn-default btn-sm wa-sim__behalf">${esc(
									__("Message on behalf")
							  )}</button>`
							: ""
					}
					<button type="button" class="btn btn-default btn-sm wa-sim__clear">${esc(__("Clear text"))}</button>
					<button type="button" class="btn btn-primary btn-sm wa-sim__send">${esc(__("Send test"))}</button>
				</div>`);
			this.$input = this.$composer.find(".wa-sim__input");
			this.$composer.find(".wa-sim__clear").on("click", () => {
				this.$input.val("").focus();
			});
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
				new sanad.ui.Toast({
					tone: "warning",
					title: __("No conversation is open"),
					message: __("Pick a contact from the list."),
				});
				return false;
			}
			const body = cstr(this.$input.val()).trim();
			if (!body && need_device) {
				new sanad.ui.Toast({
					tone: "warning",
					title: __("The message is empty"),
					message: __("Write the message text."),
				});
				return false;
			}
			if (need_device) {
				const device = this.current_device();
				if (!device) {
					new sanad.ui.Toast({
						tone: "warning",
						title: __("No device is set up yet"),
						message: __("Pair a phone before sending a test."),
						action: { label: __("Open devices"), on_click: () => frappe.set_route("wa-devices") },
					});
					return false;
				}
				if (device.status !== "Connected") {
					new sanad.ui.Toast({
						tone: "warning",
						title: __("The device is not connected"),
						message: __("Pick a connected device above the conversation."),
						action: { label: __("Open devices"), on_click: () => frappe.set_route("wa-devices") },
					});
					return false;
				}
			}
			return true;
		}

		ask_send() {
			if (!this.guard()) return;
			const body = cstr(this.$input.val()).trim();
			const device = this.current_device();
			sanad.ui.ConfirmDialog.ask({
				title: __("Send a real message to {0}?", [title_of(this.contact)]),
				message: __("One WhatsApp message leaves the device now. It counts against the plan and cannot be recalled."),
				impact: [
					{ label: __("Recipient"), value: this.contact.phone_e164 },
					{ label: __("Device"), value: device.device_name || device.name },
					{ label: __("Message"), value: body.length > 60 ? `${body.slice(0, 60)}…` : body },
				],
				ack_checkbox: __("I understand a real message will be sent."),
				confirm_label: __("Send message"),
				on_confirm: () =>
					sanad.ui.call("simulator.send_test", {
						device: this.device,
						phone: this.contact.phone_e164,
						body,
					}),
			})
				.then((r) => {
					this.$input.val("");
					sanad.ui.Toast.success(__("Test message queued"));
					this.show_send_result(r && r.outbound);
					this.refresh_newest();
				})
				.catch(() => {});
		}

		ask_behalf() {
			if (!this.guard({ need_device: false })) return;
			const device = this.current_device();
			if (!device) {
				new sanad.ui.Toast({
					tone: "warning",
					title: __("No device is set up yet"),
					message: __("A simulated message is still recorded against a device."),
					action: { label: __("Open devices"), on_click: () => frappe.set_route("wa-devices") },
				});
				return;
			}
			const context = this.context || {};
			const dialog = on_behalf_dialog({
				contact: this.contact,
				device: this.device,
				commands: context.commands || [],
				commands_enabled: !!context.commands_enabled,
				on_done: (r, text) => {
					this.$input.val("");
					this.show_behalf_result(r, text);
					this.refresh_newest();
				},
			});
			const draft = cstr(this.$input.val()).trim();
			if (draft) dialog.set_value("body", draft);
		}

		// ---- the result strip --------------------------------------------------------------------

		hide_result() {
			this.$result.attr("hidden", true).empty();
			this.result_outbound = null;
		}

		strip({ tone, title, lines, open }) {
			this.$result.removeAttr("hidden").html(`
				<div class="wa-sim__strip sanad-tone--${tone}">
					<span class="wa-sim__strip-title">${esc(title)}</span>
					${(lines || []).map((l) => `<span class="wa-sim__strip-line">${esc(l)}</span>`).join("")}
					<span class="wa-sim__strip-actions">
						${open ? `<button type="button" class="btn btn-default btn-xs wa-sim__open">${esc(__("Open in the log"))}</button>` : ""}
						<button type="button" class="btn btn-default btn-xs wa-sim__hide">${esc(__("Hide"))}</button>
					</span>
				</div>`);
			this.$result.find(".wa-sim__hide").on("click", () => this.hide_result());
			if (open) this.$result.find(".wa-sim__open").on("click", () => frappe.set_route("Form", open.doctype, open.name));
		}

		show_send_result(outbound) {
			this.result_outbound = outbound;
			this.strip({
				tone: "blue",
				title: __("Test message queued"),
				lines: [__("Status: {0}", [__("Queued")])],
				open: outbound ? { doctype: "WhatsApp Log", name: outbound } : null,
			});
		}

		/** The simulation's own answer: which command matched, why it was blocked, what it replied. */
		show_behalf_result(r, text) {
			const blocked = !!r.block_reason;
			const matched = !!r.command;
			const lines = [__("Sent on behalf: {0}", [text.length > 60 ? `${text.slice(0, 60)}…` : text])];
			if (blocked) lines.push(__("Blocked: {0}", [__(r.block_reason)]));
			else if (matched) lines.push(__("Command: {0}", [r.command]));
			else lines.push(__("No command matched this message."));
			if (r.reply_body) lines.push(__("Reply: {0}", [r.reply_body.split("\n")[0]]));
			else if (r.error) lines.push(__("Error: {0}", [r.error]));
			this.strip({
				tone: blocked ? "amber" : matched ? "green" : "gray",
				title: __("Simulated — nothing was sent"),
				lines,
				open: r.inbound ? { doctype: "WhatsApp Inbound Message", name: r.inbound } : null,
			});
		}

		// ---- realtime ----------------------------------------------------------------------------

		subscribe() {
			if (this._subscribed) return;
			this._subscribed = true;
			this._on_status = (p) => {
				if (!p || !p.outbound) return;
				if (this.thread) this.thread.update_status(p.outbound, p.status);
				if (this.result_outbound && p.outbound === this.result_outbound) {
					this.strip({
						tone: p.status === "Failed" ? "red" : "green",
						title: __("Test message {0}", [__(p.status)]),
						lines: p.error_code ? [__("Error: {0}", [p.error_code])] : [],
						open: { doctype: "WhatsApp Log", name: p.outbound },
					});
					this.result_outbound = p.outbound;
				}
			};
			this._on_inbound = sanad.ui.throttle(() => this.refresh_newest(), 1500);
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
		const page = frappe.ui.make_app_page({
			parent: wrapper,
			title: __("WhatsApp Simulator"),
			single_column: true,
		});
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

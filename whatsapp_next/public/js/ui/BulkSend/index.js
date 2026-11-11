// whatsapp.ui.BulkSend — the prototype's "Send a bulk message" window (`docs/component/Send Message
// Dialog.dc.html` around `docs/component/Bulk Send.dc.html`): a full-height modal with a white
// header (title, the sentence that says the send is real, close) over two panes.
//
//   Recipients (330 px)  the Groups · Contacts · Numbers segments with their counts, a pill search,
//                        rows with a round check, the numbers box ("one per line"), and the footer
//                        "Selected N" · show the selected · remove all.
//   The message          the green header (who it goes to, the "Send settings" pill that opens the
//                        template · device · rate · timing form), the first recipient as the
//                        preview's identity, the note that the send is real, the message as it
//                        will arrive, the composer, and the bar of estimates with the send pill.
//
// Portable: the host passes the data source as functions (`load`, `estimate`, `search_contacts`,
// `send`). It draws on `CommandEditor`'s shell (layer, modal, composer bits).

frappe.provide("whatsapp.ui");

(function () {
	const esc = (v) => whatsapp.ui.escape(v);
	const SEND_ICON =
		'<svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 10.5l13-6-5 13-2-5-6-2z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"></path></svg>';
	const SEARCH_ICON =
		'<svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="5.5" stroke="currentColor" stroke-width="1.6"></circle><path d="M13.5 13.5L17 17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path></svg>';
	const GEAR_ICON =
		'<svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="2.4" stroke="currentColor" stroke-width="1.6"></circle><path d="M10 3.6v2M10 14.4v2M3.6 10h2M14.4 10h2M5.5 5.5l1.4 1.4M13.1 13.1l1.4 1.4M14.5 5.5l-1.4 1.4M6.9 13.1L5.5 14.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path></svg>';
	const norm = (p) => String(p || "").replace(/[\s\-()]/g, "");
	const valid = (p) => /^\+?\d{9,15}$/.test(norm(p));

	class BulkSend {
		/**
		 * @param {Object} opts
		 * @param {Function} opts.load — `() → {groups[{name, group_name, kind, description, member_count}],
		 *   templates[{name, template_name, category, body}], devices[{name, device_name, status}],
		 *   default_device, rate, messages_remaining}`
		 * @param {Function} opts.estimate — `({groups, contacts, numbers}) → {total, excluded, invalid}`
		 * @param {Function} opts.search_contacts — `(txt) → [{name, label, phone, party_type}]`
		 * @param {Function} opts.send — `(payload) → {campaign, status, recipients}`
		 * @param {Object} [opts.prefill] — `{groups[], contacts[{name, label, phone}], numbers[]}`
		 * @param {string} [opts.title] · [opts.subtitle]
		 * @param {Function} [opts.on_sent] `(result)` · [opts.on_templates] · [opts.on_close]
		 */
		constructor(opts = {}) {
			this.opts = opts;
			const pf = opts.prefill || {};
			this.state = {
				src: "groups",
				q: "",
				numbers_text: "",
				groups: (pf.groups || []).slice(),
				contacts: (pf.contacts || []).slice(),
				numbers: (pf.numbers || []).slice(),
				results: [],
				loading: false,
				settings: false,
				template: "",
				device: null,
				rate: null,
				when: "now",
				at: "",
				body: "",
				attach: null,
				estimate: null,
			};
			this.show();
		}

		// ---- shell ---------------------------------------------------------------------------------

		show() {
			this.id = whatsapp.ui.uid("whatsapp-kit-bulk-send");
			this.previous_focus = document.activeElement;
			this.$root = $(`
				<div class="whatsapp-kit whatsapp-kit-command-editor-layer whatsapp-kit-bulk-send-layer" role="presentation">
					<div class="whatsapp-kit-command-editor-backdrop" data-act="close"></div>
					<div class="whatsapp-kit-command-editor whatsapp-kit-bulk-send" role="dialog" aria-modal="true" aria-labelledby="${this.id}-title">
						<div class="whatsapp-kit-bulk-send__top">
							<span class="whatsapp-kit-bulk-send__top-text">
								<span class="whatsapp-kit-bulk-send__title" id="${this.id}-title">${esc(this.opts.title || __("Send a bulk message"))}</span>
								<span class="whatsapp-kit-bulk-send__subtitle">${esc(this.opts.subtitle || __("Pick the recipients, write the message, then send. The send is real and counts against the plan."))}</span>
							</span>
							<button type="button" class="whatsapp-kit-command-editor__x" data-act="close" title="${esc(__("Close (Esc)"))}" aria-label="${esc(__("Close"))}">×</button>
						</div>
						<div class="whatsapp-kit-bulk-send__body" data-slot="body"><div class="whatsapp-kit-command-editor__loading">${esc(__("Loading…"))}</div></div>
					</div>
				</div>`).appendTo(document.body);
			this.$body = this.$root.find("[data-slot=body]");
			$("body").addClass("whatsapp-kit-command-editor-open");
			this.$root.on("click", "[data-act]", (e) => this.on_act(e));
			this.$root.on("click", "[data-attach-clear]", () => {
				this.state.attach = null;
				this.render();
			});
			this.$root.on("input", "[data-in]", (e) => this.on_input(e));
			this.$root.on("change", "[data-ch]", (e) => this.on_change(e));
			this.$root.on("keydown", (e) => this.on_key(e));
			if (whatsapp.ui.overlay) whatsapp.ui.overlay.open(this);
			this.load();
		}

		hide() {
			if (!this.$root) return;
			this.$root.remove();
			this.$root = null;
			if (!$(".whatsapp-kit-command-editor-layer").length) $("body").removeClass("whatsapp-kit-command-editor-open");
			if (whatsapp.ui.overlay) whatsapp.ui.overlay.close(this);
		}

		close() {
			this.hide();
			if (this.previous_focus && this.previous_focus.focus && document.body.contains(this.previous_focus)) this.previous_focus.focus();
			this.opts.on_close && this.opts.on_close();
		}

		async load() {
			try {
				this.ctx = await this.opts.load();
				const devices = this.ctx.devices || [];
				const connected = devices.find((d) => d.status === "Connected");
				this.state.device = this.ctx.default_device || (connected || devices[0] || {}).name || null;
				this.state.rate = cint(this.ctx.rate) || 20;
				this.render();
				this.refresh_estimate();
				const s = this.$root.find("[data-f=q]").get(0);
				s && s.focus();
			} catch (err) {
				this.$body.html(`<div class="whatsapp-kit-command-editor__loading" role="alert"><span>${esc(err && err.message ? err.message : __("Something went wrong. Please try again."))}</span></div>`);
			}
		}

		// ---- derived ------------------------------------------------------------------------------

		group(name) {
			return ((this.ctx && this.ctx.groups) || []).find((g) => g.name === name) || { name, group_name: name };
		}

		device() {
			return ((this.ctx && this.ctx.devices) || []).find((d) => d.name === this.state.device) || null;
		}

		template() {
			return ((this.ctx && this.ctx.templates) || []).find((t) => t.name === this.state.template) || null;
		}

		picked_count() {
			const s = this.state;
			return s.groups.length + s.contacts.length + s.numbers.length;
		}

		total() {
			const e = this.state.estimate;
			if (e) return cint(e.total);
			return this.state.contacts.length + this.state.numbers.length;
		}

		// ---- render -------------------------------------------------------------------------------

		render() {
			if (!this.$root || !this.ctx) return;
			const restore = whatsapp.ui.hold_focus(this.$root);
			this.$body.html(`<div class="whatsapp-kit-bulk-send__grid">${this.render_list()}${this.render_message()}</div>`);
			restore();
		}

		render_list() {
			const s = this.state;
			const tabs = [
				{ key: "groups", label: __("Groups", null, "Bulk Send"), count: s.groups.length },
				{ key: "contacts", label: __("Contacts", null, "Bulk Send"), count: s.contacts.length },
				{ key: "manual", label: __("Numbers", null, "Bulk Send"), count: s.numbers.length },
			];
			const selected = s.src === "selected";
			const placeholder = s.src === "groups" ? __("Search the groups…") : selected ? __("Search the selected…") : __("Search by name or number…");
			let body;
			if (s.src === "manual") {
				body = `<div class="whatsapp-kit-bulk-send__manual">
					<textarea class="whatsapp-kit-bulk-send__numbers" dir="ltr" rows="6" data-f="numbers" data-in="numbers" placeholder="${esc(__("One number per line, or separated by commas."))}">${esc(s.numbers_text)}</textarea>
					<button type="button" class="whatsapp-kit-command-editor__btn" data-act="add-numbers">${esc(__("Add the numbers"))}</button>
					<span class="whatsapp-kit-command-editor__note">${esc(__("Invalid and repeated numbers are skipped. The added ones show under «Selected»."))}</span>
				</div>`;
			} else {
				const rows = this.rows();
				body = rows.length
					? rows.map((r) => this.row_html(r)).join("")
					: `<span class="whatsapp-kit-bulk-send__none">${esc(s.loading ? __("Loading…") : selected ? __("No recipient selected yet.") : __("No results match the search."))}</span>`;
			}
			const n = this.picked_count();
			return `<section class="whatsapp-kit-bulk-send__list-pane" aria-label="${esc(__("Recipients", null, "Bulk Send"))}">
				<div class="whatsapp-kit-bulk-send__list-head">
					<span class="whatsapp-kit-bulk-send__list-title">${esc(__("Recipients", null, "Bulk Send"))}</span>
					<span class="whatsapp-kit-bulk-send__segs" role="tablist">${tabs
						.map(
							(t) => `<button type="button" role="tab" class="whatsapp-kit-bulk-send__seg${s.src === t.key ? " is-sel" : ""}" aria-selected="${s.src === t.key}" data-act="src" data-key="${t.key}">${esc(t.label)}${
								t.count ? `<span class="whatsapp-kit-bulk-send__seg-n" dir="ltr">${whatsapp.ui.format_int(t.count)}</span>` : ""
							}</button>`
						)
						.join("")}</span>
					${
						s.src === "manual"
							? ""
							: `<label class="whatsapp-kit-bulk-send__search">${SEARCH_ICON}<input type="text" data-whatsapp-bare data-f="q" data-in="q" value="${esc(s.q)}" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" autocomplete="off" /></label>`
					}
				</div>
				<div class="whatsapp-kit-bulk-send__list" data-scroll="list" role="list">${body}</div>
				<div class="whatsapp-kit-bulk-send__list-foot">
					<span class="whatsapp-kit-bulk-send__picked">${esc(__("Selected", null, "Bulk Send"))} <span dir="ltr" class="whatsapp-kit-bulk-send__picked-n">${whatsapp.ui.format_int(this.total())}</span></span>
					${
						n
							? `<button type="button" class="whatsapp-kit-bulk-send__show${selected ? " is-on" : ""}" data-act="show-selected">${esc(selected ? __("Back to picking") : __("Show the selected"))}</button>
								<button type="button" class="whatsapp-kit-bulk-send__clear" data-act="clear">${esc(__("Remove all"))}</button>`
							: ""
					}
				</div>
			</section>`;
		}

		/** The rows of the current segment, already shaped for drawing. */
		rows() {
			const s = this.state;
			const q = s.q.trim().toLowerCase();
			const match = (...parts) => !q || parts.some((p) => String(p || "").toLowerCase().includes(q) || norm(p).includes(norm(q)));
			if (s.src === "groups") {
				return ((this.ctx && this.ctx.groups) || [])
					.filter((g) => match(g.group_name, g.name))
					.map((g) => {
						const on = s.groups.includes(g.name);
						const black = g.kind === "Blacklist";
						return {
							key: g.name,
							act: "toggle-group",
							name: g.group_name || g.name,
							sub: g.description || __(g.source || ""),
							initials: whatsapp.ui.initials(g.group_name || g.name),
							badge: black ? __("Blacklist") : __("{0} contacts", [whatsapp.ui.format_int(g.member_count)]),
							badge_tone: black ? "wn" : "muted",
							on,
						};
					});
			}
			if (s.src === "contacts") {
				return (s.results || []).map((c) => ({
					key: c.name,
					act: "toggle-contact",
					name: c.label || __("Unnamed"),
					sub: whatsapp.ui.phone(c.phone || ""),
					sub_ltr: true,
					initials: whatsapp.ui.initials(c.label || "?"),
					badge: c.party_type ? __(c.party_type) : "",
					badge_tone: "muted",
					on: s.contacts.some((x) => x.name === c.name),
				}));
			}
			// the selected: what was picked, each removable
			return []
				.concat(
					s.groups.map((name) => {
						const g = this.group(name);
						return { key: name, act: "rm-group", name: g.group_name || name, sub: __("{0} contacts", [whatsapp.ui.format_int(g.member_count)]), initials: whatsapp.ui.initials(g.group_name || name), badge: __("Group", null, "Bulk Send"), badge_tone: "pri", remove: true };
					}),
					s.contacts.map((c) => ({ key: c.name, act: "rm-contact", name: c.label || c.name, sub: whatsapp.ui.phone(c.phone || ""), sub_ltr: true, initials: whatsapp.ui.initials(c.label || "?"), badge: __("Picked contact"), badge_tone: "pri", remove: true })),
					s.numbers.map((p) => ({ key: p, act: "rm-number", name: __("Number added by hand"), sub: whatsapp.ui.phone(p), sub_ltr: true, initials: "#", avatar_tone: "nf", badge: __("Manual number"), badge_tone: "nf", remove: true }))
				)
				.filter((r) => match(r.name, r.sub));
		}

		row_html(r) {
			return `<button type="button" role="listitem" class="whatsapp-kit-bulk-send__row${r.on ? " is-on" : ""}" data-act="${r.act}" data-key="${esc(r.key)}" aria-pressed="${!!r.on}">
				<span class="whatsapp-kit-bulk-send__avatar${r.avatar_tone ? ` whatsapp-kit-bulk-send__avatar--${r.avatar_tone}` : ""}${r.on || r.remove ? " is-on" : ""}" aria-hidden="true">${esc(r.initials)}</span>
				<span class="whatsapp-kit-bulk-send__row-text">
					<span class="whatsapp-kit-bulk-send__row-name">${esc(r.name)}</span>
					<span class="whatsapp-kit-bulk-send__row-sub${r.sub_ltr ? " whatsapp-kit-command-editor__mono" : ""}"${r.sub_ltr ? ' dir="ltr"' : ""}>${esc(r.sub || "")}</span>
				</span>
				${r.badge ? `<span class="whatsapp-kit-bulk-send__badge whatsapp-kit-bulk-send__badge--${r.badge_tone}">${esc(r.badge)}</span>` : ""}
				<span class="whatsapp-kit-bulk-send__mark${r.remove ? " is-rm" : r.on ? " is-on" : ""}" aria-hidden="true">${r.remove ? "×" : r.on ? "✓" : ""}</span>
			</button>`;
		}

		render_message() {
			const s = this.state;
			const total = this.total();
			const dev = this.device();
			const tpl = this.template();
			const e = s.estimate || {};
			const parts = [
				s.groups.length ? __("{0} groups", [whatsapp.ui.format_int(s.groups.length)]) : "",
				s.contacts.length ? __("{0} contacts", [whatsapp.ui.format_int(s.contacts.length)]) : "",
				s.numbers.length ? __("{0} numbers", [whatsapp.ui.format_int(s.numbers.length)]) : "",
				cint(e.excluded) ? __("{0} excluded", [whatsapp.ui.format_int(e.excluded)]) : "",
			].filter(Boolean);
			const head_title = total ? __("Broadcast to {0} recipients", [whatsapp.ui.format_int(total)]) : __("Send a message");
			const head_sub = total ? `${parts.join(" · ")} · ${dev ? dev.device_name || dev.name : "—"}` : __("Pick the recipients from the list, then write the message");
			const first = s.contacts[0] || (s.numbers[0] ? { label: __("Number added by hand"), phone: s.numbers[0] } : null) || (s.groups[0] ? { label: this.group(s.groups[0]).group_name, phone: __("{0} contacts", [whatsapp.ui.format_int(this.group(s.groups[0]).member_count)]) } : null);
			const remaining = this.ctx.messages_remaining;
			const mins = total / Math.max(1, cint(s.rate) || 20);
			const eta = !total ? "—" : mins < 1 ? __("under a minute") : mins < 60 ? __("{0} minutes", [Math.round(mins)]) : __("{0} hours", [Math.round(mins / 60)]);
			const ready = total > 0 && (!!s.body.trim() || !!s.attach) && dev && dev.status === "Connected";
			const send_label = s.when === "later" ? __("Schedule the send") : total ? __("Send to {0}", [whatsapp.ui.format_int(total)]) : __("Send", null, "Bulk Send");
			return `<section class="whatsapp-kit-bulk-send__main" aria-label="${esc(__("The message"))}">
				<div class="whatsapp-kit-bulk-send__head">
					<span class="whatsapp-kit-bulk-send__head-icon" aria-hidden="true">${SEND_ICON.replace('width="14" height="14"', 'width="18" height="18"')}</span>
					<span class="whatsapp-kit-bulk-send__head-text">
						<span class="whatsapp-kit-bulk-send__head-title">${esc(head_title)}</span>
						<span class="whatsapp-kit-bulk-send__head-sub">${esc(head_sub)}</span>
					</span>
					<button type="button" class="whatsapp-kit-bulk-send__settings-btn" data-act="settings" aria-expanded="${s.settings}">${GEAR_ICON}<span>${esc(s.settings ? __("Hide the settings") : tpl ? tpl.template_name || tpl.name : __("Send settings"))}</span></button>
				</div>
				${s.settings ? this.render_settings() : ""}
				<div class="whatsapp-kit-bulk-send__who">
					<span class="whatsapp-kit-command-editor__avatar${first ? "" : " whatsapp-kit-bulk-send__avatar--q"}" aria-hidden="true">${esc(first ? whatsapp.ui.initials(first.label || "#") : "?")}</span>
					<span class="whatsapp-kit-command-editor__switch-text"><span class="whatsapp-kit-command-editor__card-name">${esc(first ? first.label || __("First recipient") : __("No recipient yet", null, "Bulk Send"))}</span><span class="whatsapp-kit-command-editor__opt-sub"${first ? ' dir="auto"' : ""}>${esc(first ? first.phone || "" : __("The preview shows once a recipient is picked"))}</span></span>
					<span class="whatsapp-kit-command-editor__tag ${first ? "" : "whatsapp-kit-command-editor__tag--warn"}">${esc(first ? __("Preview of the first recipient") : __("No recipients"))}</span>
				</div>
				<div class="whatsapp-kit-bulk-send__note"><span class="whatsapp-kit-bulk-send__note-dot" aria-hidden="true"></span><span>${esc(__("The send is real — the text is sent as it is to every recipient."))}</span></div>
				<div class="whatsapp-kit-bulk-send__thread">
					${
						s.body.trim() || s.attach
							? `<span class="whatsapp-kit-bulk-send__day">${esc(__("Today"))}</span><div class="whatsapp-kit-bulk-send__bubble" dir="auto">${
									s.attach
										? `<span class="whatsapp-kit-bulk-send__bubble-file">${whatsapp.ui.AttachMenu.icon(s.attach.kind)}<bdi>${esc(s.attach.file_name || s.attach.contact_label || whatsapp.ui.AttachMenu.label(s.attach.kind))}</bdi></span>`
										: ""
							  }${esc(s.body)}<span class="whatsapp-kit-bulk-send__bubble-at" dir="ltr">${esc(frappe.datetime.now_time().slice(0, 5))} 🕓</span></div>`
							: `<div class="whatsapp-kit-bulk-send__empty"><strong>${esc(__("Write the message"))}</strong><span>${esc(__("Write in the box below or pick a template from the send settings — it shows here as the recipient gets it."))}</span></div>`
					}
				</div>
				${s.attach && whatsapp.ui.AttachMenu ? `<div class="whatsapp-kit-bulk-send__attach">${whatsapp.ui.AttachMenu.chip_html(s.attach)}</div>` : ""}
				<div class="whatsapp-kit-bulk-send__composer">
					<span class="whatsapp-kit-bulk-send__tools"><button type="button" class="whatsapp-kit-bulk-send__round whatsapp-kit-bulk-send__round--plain" data-act="plus" title="${esc(__("Message type"))}" aria-label="${esc(__("Message type"))}" aria-haspopup="dialog">+</button></span>
					<span class="whatsapp-kit-bulk-send__field">
						<textarea class="whatsapp-kit-bulk-send__input" rows="2" data-f="body" data-in="body" placeholder="${esc(s.attach ? __("Caption (optional)…") : __("Write your message…"))}" aria-label="${esc(__("Message"))}">${esc(s.body)}</textarea>
						<button type="button" class="whatsapp-kit-bulk-send__clear-x" data-act="clear-body" aria-label="${esc(__("Clear the text"))}" title="${esc(__("Clear the text"))}">×</button>
					</span>
					<button type="button" class="whatsapp-kit-bulk-send__round whatsapp-kit-bulk-send__round--pri" data-act="send" title="${esc(__("Send", null, "Bulk Send"))}" aria-label="${esc(__("Send", null, "Bulk Send"))}">${SEND_ICON}</button>
				</div>
				<div class="whatsapp-kit-bulk-send__bar">
					<span class="whatsapp-kit-bulk-send__estimates">
						<span class="whatsapp-kit-bulk-send__est"><span class="whatsapp-kit-bulk-send__est-k">${esc(__("Recipients", null, "Bulk Send"))}</span><span class="whatsapp-kit-bulk-send__est-v whatsapp-kit-command-editor__mono" dir="ltr">${whatsapp.ui.format_int(total)}</span></span>
						<span class="whatsapp-kit-bulk-send__est"><span class="whatsapp-kit-bulk-send__est-k">${esc(__("Expected time"))}</span><span class="whatsapp-kit-bulk-send__est-v">${esc(eta)}</span></span>
						<span class="whatsapp-kit-bulk-send__est"><span class="whatsapp-kit-bulk-send__est-k">${esc(__("From the plan"))}</span><span class="whatsapp-kit-bulk-send__est-v whatsapp-kit-command-editor__mono" dir="ltr">${remaining == null ? "—" : whatsapp.ui.format_int(Math.min(total, cint(remaining)))}</span></span>
					</span>
					<button type="button" class="whatsapp-kit-bulk-send__send${ready ? " is-ready" : ""}" data-act="send">${esc(send_label)}</button>
				</div>
			</section>`;
		}

		render_settings() {
			const s = this.state;
			const ctx = this.ctx;
			const dev = this.device();
			return `<div class="whatsapp-kit-bulk-send__settings">
				<div class="whatsapp-kit-bulk-send__form">
					<label class="whatsapp-kit-bulk-send__fld"><span class="whatsapp-kit-command-editor__label">${esc(__("Message template"))}</span>
						<select class="whatsapp-kit-command-editor__input whatsapp-kit-command-editor__select whatsapp-kit-bulk-send__ctl" data-ch="template">
							<option value="">${esc(__("No template — free text"))}</option>
							${(ctx.templates || []).map((t) => `<option value="${esc(t.name)}" ${t.name === s.template ? "selected" : ""}>${esc((t.template_name || t.name) + (t.category ? ` · ${t.category}` : ""))}</option>`).join("")}
						</select></label>
					<label class="whatsapp-kit-bulk-send__fld"><span class="whatsapp-kit-command-editor__label">${esc(__("Sending device"))}</span>
						<select class="whatsapp-kit-command-editor__input whatsapp-kit-command-editor__select whatsapp-kit-bulk-send__ctl" data-ch="device">
							${(ctx.devices || []).map((d) => `<option value="${esc(d.name)}" ${d.name === s.device ? "selected" : ""}>${esc((d.device_name || d.name) + (d.status === "Connected" ? "" : ` — ${__("not connected")}`))}</option>`).join("")}
						</select>
						${dev && dev.status !== "Connected" ? `<span class="whatsapp-kit-command-editor__note whatsapp-kit-command-editor__note--warn">${esc(__("The device is not connected."))}</span>` : ""}</label>
					<label class="whatsapp-kit-bulk-send__fld"><span class="whatsapp-kit-command-editor__label">${esc(__("Rate (messages/minute)"))}</span>
						<input type="number" min="1"${ctx.max_rate ? ` max="${cint(ctx.max_rate)}"` : ""} class="whatsapp-kit-command-editor__input whatsapp-kit-bulk-send__ctl whatsapp-kit-command-editor__mono" data-f="rate" data-in="rate" value="${esc(s.rate || "")}" />
						<span class="whatsapp-kit-command-editor__note${this.rate_problem() || cint(s.rate) > 30 ? " whatsapp-kit-command-editor__note--warn" : ""}">${esc(
							this.rate_problem() || (cint(s.rate) > 30 ? __("A high rate — raises the risk of a ban.") : __("Recommended 20–30."))
						)}</span></label>
					<div class="whatsapp-kit-bulk-send__fld"><span class="whatsapp-kit-command-editor__label">${esc(__("Timing"))}</span>
						<span class="whatsapp-kit-bulk-send__segs whatsapp-kit-bulk-send__segs--sm">
							<button type="button" class="whatsapp-kit-bulk-send__seg${s.when === "now" ? " is-sel" : ""}" data-act="when" data-key="now">${esc(__("Now", null, "Bulk Send"))}</button>
							<button type="button" class="whatsapp-kit-bulk-send__seg${s.when === "later" ? " is-sel" : ""}" data-act="when" data-key="later">${esc(__("At a time"))}</button>
						</span></div>
					${
						s.when === "later"
							? `<label class="whatsapp-kit-bulk-send__fld"><span class="whatsapp-kit-command-editor__label">${esc(__("Start time"))}</span><input type="datetime-local" class="whatsapp-kit-command-editor__input whatsapp-kit-bulk-send__ctl" data-ch="at" value="${esc(s.at)}" /></label>`
							: ""
					}
				</div>
				${this.opts.on_templates ? `<button type="button" class="whatsapp-kit-command-editor__link" data-act="templates">${esc(__("Manage message templates"))}</button>` : ""}
			</div>`;
		}

		/** The rate above the site's queue rate is refused by the campaign; say so before sending. */
		rate_problem() {
			const max = cint(this.ctx && this.ctx.max_rate);
			return max && cint(this.state.rate) > max ? __("The site's queue sends at most {0} messages a minute.", [max]) : "";
		}

		// ---- data ---------------------------------------------------------------------------------

		search_contacts() {
			const s = this.state;
			s.loading = true;
			clearTimeout(this._q);
			const q = s.q;
			this._q = setTimeout(async () => {
				try {
					const rows = await this.opts.search_contacts(q);
					if (s.q !== q || s.src !== "contacts") return;
					s.results = rows || [];
				} catch (err) {
					s.results = [];
				}
				s.loading = false;
				this.render();
			}, 220);
		}

		refresh_estimate() {
			clearTimeout(this._est);
			// a slower answer to an older selection must not overwrite the newer one's count
			const seq = (this._est_seq = (this._est_seq || 0) + 1);
			this._est = setTimeout(async () => {
				const s = this.state;
				if (!this.picked_count()) {
					s.estimate = { total: 0, excluded: 0 };
					return this.render();
				}
				let estimate = null;
				try {
					estimate = await this.opts.estimate({ groups: s.groups, contacts: s.contacts.map((c) => c.name), numbers: s.numbers });
				} catch (err) {
					estimate = null;
				}
				if (seq !== this._est_seq || !this.$root) return;
				s.estimate = estimate;
				this.render();
			}, 250);
		}

		/**
		 * The start time as the server stores it. `datetime-local` gives the browser's wall clock;
		 * the campaign's `scheduled_at` is system time, so a sender in another zone than the site
		 * scheduled hours off (and "in the future" was judged against the wrong clock).
		 */
		scheduled_at() {
			const at = this.state.at;
			if (!at) return null;
			const system = window.frappe && frappe.boot && frappe.boot.time_zone && frappe.boot.time_zone.system;
			const m = window.moment && moment(at);
			if (!m || !m.isValid()) return at.replace("T", " ");
			return (system && m.tz ? m.clone().tz(system) : m).locale("en").format("YYYY-MM-DD HH:mm:ss");
		}

		// ---- events -------------------------------------------------------------------------------

		on_key(e) {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				return this.close();
			}
			whatsapp.ui.keep_tab_inside(e, this.$root);
		}

		on_input(e) {
			const el = e.target;
			const kind = el.getAttribute("data-in");
			const s = this.state;
			if (kind === "q") {
				s.q = el.value;
				if (s.src === "contacts") return this.search_contacts();
				return this.render();
			}
			if (kind === "numbers") return void (s.numbers_text = el.value);
			if (kind === "rate") return void (s.rate = el.value);
			if (kind === "body") {
				s.body = el.value;
				return this.render();
			}
		}

		on_change(e) {
			const el = e.target;
			const kind = el.getAttribute("data-ch");
			const s = this.state;
			if (kind === "template") {
				s.template = el.value;
				const tpl = this.template();
				if (tpl) s.body = tpl.body || "";
			} else if (kind === "device") s.device = el.value;
			else if (kind === "at") s.at = el.value;
			this.render();
		}

		on_act(e) {
			const $el = $(e.currentTarget);
			const act = $el.attr("data-act");
			const key = $el.attr("data-key");
			const s = this.state;
			switch (act) {
				case "close":
					return this.close();
				case "src":
					s.src = key;
					s.q = "";
					this.render();
					if (key === "contacts") this.search_contacts();
					return;
				case "toggle-group":
					s.groups = s.groups.includes(key) ? s.groups.filter((x) => x !== key) : s.groups.concat([key]);
					break;
				case "toggle-contact": {
					const c = (s.results || []).find((x) => x.name === key);
					s.contacts = s.contacts.some((x) => x.name === key) ? s.contacts.filter((x) => x.name !== key) : s.contacts.concat(c ? [c] : []);
					break;
				}
				case "rm-group":
					s.groups = s.groups.filter((x) => x !== key);
					break;
				case "rm-contact":
					s.contacts = s.contacts.filter((x) => x.name !== key);
					break;
				case "rm-number":
					s.numbers = s.numbers.filter((x) => x !== key);
					break;
				case "add-numbers": {
					const seen = new Set(s.numbers.map(norm));
					const add = [];
					String(s.numbers_text)
						.split(/[\n,،;]+/)
						.map((x) => x.trim())
						.filter(Boolean)
						.forEach((p) => {
							const n = norm(p);
							if (valid(n) && !seen.has(n)) {
								seen.add(n);
								add.push(n);
							}
						});
					s.numbers = s.numbers.concat(add);
					s.numbers_text = "";
					if (add.length) whatsapp.ui.Toast.success(whatsapp.ui.plural(add.length, { one: __("{0} number added"), other: __("{0} numbers added") }));
					else whatsapp.ui.Toast.warning(__("No new valid number"));
					break;
				}
				case "show-selected":
					s.src = s.src === "selected" ? "groups" : "selected";
					s.q = "";
					return this.render();
				case "clear":
					Object.assign(s, { groups: [], contacts: [], numbers: [], src: "groups", q: "" });
					break;
				case "settings":
					s.settings = !s.settings;
					return this.render();
				case "when":
					s.when = key;
					return this.render();
				case "templates":
					this.close();
					return this.opts.on_templates && this.opts.on_templates();
				case "plus":
					return new whatsapp.ui.AttachMenu({
						anchor: e.currentTarget,
						kinds: ["image", "video", "document", "audio", "contact"],
						reasons: { location: __("A location goes to one conversation at a time — send it from the simulator.") },
						search_contacts: (txt) => this.opts.search_contacts(txt),
						on_pick: (v) => {
							s.attach = v;
							this.render();
						},
					});
				case "clear-body":
					s.body = "";
					this.render();
					return this.$root.find("[data-f=body]").trigger("focus");
				case "send":
					return this.ask_send();
				default:
					return;
			}
			this.render();
			this.refresh_estimate();
		}

		/** The prototype's three guards, then its confirmation with the facts of this send. */
		ask_send() {
			const s = this.state;
			const total = this.total();
			const dev = this.device();
			if (!this.picked_count()) return new whatsapp.ui.Toast({ tone: "warning", title: __("No recipients"), message: __("Pick a group or contacts, or enter numbers.") });
			if (!s.body.trim() && !s.attach)
				return new whatsapp.ui.Toast({ tone: "warning", title: __("The message is empty"), message: __("Write the message text, or pick a file or a contact with «+».") });
			if (!dev || dev.status !== "Connected") return new whatsapp.ui.Toast({ tone: "warning", title: __("The device is not connected"), message: __("Pick a connected device from the send settings.") });
			if (s.when === "later" && !s.at) return new whatsapp.ui.Toast({ tone: "warning", title: __("No start time"), message: __("Pick when the send starts, or send now.") });
			if (this.rate_problem()) return new whatsapp.ui.Toast({ tone: "warning", title: __("The rate is too high"), message: this.rate_problem() });
			const later = s.when === "later";
			const e = s.estimate || {};
			const remaining = this.ctx.messages_remaining;
			const impact = [
				{ label: __("Recipients", null, "Bulk Send"), value: whatsapp.ui.format_int(total) },
				{ label: __("Device"), value: dev.device_name || dev.name },
			];
			if (remaining != null) impact.push({ label: __("Counted against the plan"), value: whatsapp.ui.format_int(Math.min(total, cint(remaining))) });
			if (cint(e.excluded)) impact.push({ label: __("Excluded (blacklist)"), value: whatsapp.ui.format_int(e.excluded) });
			whatsapp.ui.ConfirmDialog.ask({
				title: later ? __("Schedule {0} messages?", [whatsapp.ui.format_int(total)]) : __("Send {0} messages?", [whatsapp.ui.format_int(total)]),
				message: later
					? __("The messages are scheduled for the chosen time and can be cancelled from the queue before they start.")
					: __("The messages enter the queue now and go out at {0} messages a minute. What is sent cannot be recalled.", [cint(s.rate) || 20]),
				impact,
				ack_checkbox: total > 200 ? __("I understand that {0} messages will really be sent and counted against the balance", [whatsapp.ui.format_int(total)]) : undefined,
				confirm_label: later ? __("Schedule the send") : __("Send now"),
				on_confirm: () =>
					this.opts.send({
						groups: s.groups,
						contacts: s.contacts.map((c) => c.name),
						numbers: s.numbers,
						body: s.body,
						template: s.attach ? null : s.template || null,
						kind: s.attach ? s.attach.kind : "text",
						attachment: s.attach ? s.attach.attachment || null : null,
						contact: s.attach ? s.attach.contact || null : null,
						device: s.device,
						rate: cint(s.rate) || null,
						scheduled_at: later ? this.scheduled_at() : null,
					}),
			})
				.then((r) => {
					new whatsapp.ui.Toast({
						tone: "success",
						title: later ? __("{0} messages scheduled", [whatsapp.ui.format_int(r.recipients)]) : __("{0} messages added to the queue", [whatsapp.ui.format_int(r.recipients)]),
						message: later ? __("They start at the chosen time.") : __("They go out at {0} messages a minute — follow them from the queue.", [cint(s.rate) || 20]),
					});
					this.opts.on_sent && this.opts.on_sent(r);
					this.close();
				})
				.catch(() => {});
		}
	}

	whatsapp.ui.BulkSend = BulkSend;
})();

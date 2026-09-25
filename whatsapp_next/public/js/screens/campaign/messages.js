// MessageStep — step 2. The messages the campaign will send.
//
// The sequence, the per-type editor, the variable picker and the live WhatsApp bubble are one
// component the product already owns (`sanad.ui.MessageComposer`): a rail of cards with the delay
// between two of them drawn as the gap, an editor that shows only the fields the type has, and a
// preview that renders the real thing for a sample recipient once the campaign is saved. The step
// mounts it inside its own pane and adds the one verb the composer has no opinion about — sending
// a message to a real number before sending it to everyone.
//
// The test send is the backend's own (`simulator.send_test`), which sends **text**. It is offered
// for a message whose body is written and explains itself for the rest, rather than pretending to
// send an attachment it cannot.

frappe.provide("whatsapp_next.campaign");

(function () {
	const ui = sanad.ui;
	const C = whatsapp_next.campaign;
	const esc = C.esc;

	C.Messages = class MessageStep {
		constructor({ wrapper, ctx }) {
			this.$wrapper = $(wrapper);
			this.ctx = ctx;
			this.render();
		}

		/**
		 * A menu the composer opens beside a button belongs to that button: once the page scrolls
		 * and the button slides under the pinned bars, the menu closes instead of floating on.
		 */
		watch_scroll() {
			this.unwatch_scroll();
			this._on_scroll = () => {
				const c = this.composer;
				if (!c) return;
				// opening a menu focuses its first item, and the browser may scroll to show it:
				// that scroll is the menu's own, not the reader leaving
				const $menu = this.$wrapper.find(".sanad-mc__typemenu, .sanad-mc__varmenu");
				if ($menu.length && Date.now() - ($menu[0].__opened_at || 0) < 250) return;
				if (c.close_type_menu) c.close_type_menu();
				this.$wrapper.find(".sanad-mc__varmenu").remove();
				this.$wrapper.find(".sanad-mc__varbtn").attr("aria-expanded", "false");
			};
			document.addEventListener("scroll", this._on_scroll, true);
		}

		/**
		 * The composer hangs its menus from their buttons' start edge; a button near the screen's
		 * end would hang a menu off the screen. Watched as they appear, and flipped when they would.
		 */
		watch_menus() {
			if (this._menus || !window.MutationObserver) return;
			const fit = (el) => {
				el.__opened_at = Date.now();
				const margin = 8;
				const rtl = document.documentElement.dir === "rtl";
				el.style.maxInlineSize = `${Math.max(200, window.innerWidth - margin * 2)}px`;
				let r = el.getBoundingClientRect();
				const off_end = rtl ? r.left < margin : r.right > window.innerWidth - margin;
				if (off_end) {
					el.classList.add(`${el.classList[0]}--flip`);
					r = el.getBoundingClientRect();
					const off_start = rtl ? r.right > window.innerWidth - margin : r.left < margin;
					if (off_start) {
						el.classList.remove(`${el.classList[0]}--flip`);
						el.classList.add(`${el.classList[0]}--unflip`);
					}
				}
			};
			this._menus = new MutationObserver((records) => {
				records.forEach((rec) =>
					rec.addedNodes.forEach((n) => {
						if (n.nodeType === 1 && (n.classList.contains("sanad-mc__typemenu") || n.classList.contains("sanad-mc__varmenu"))) fit(n);
					})
				);
			});
			this._menus.observe(this.$wrapper[0], { childList: true, subtree: true });
		}

		unwatch_scroll() {
			if (this._on_scroll) document.removeEventListener("scroll", this._on_scroll, true);
			this._on_scroll = null;
		}

		destroy() {
			this.unwatch_scroll();
			if (this._menus) this._menus.disconnect();
			this._menus = null;
			if (this.composer && this.composer.destroy) this.composer.destroy();
		}

		get frm() {
			return this.ctx.frm;
		}

		render() {
			const blocked = this.test_blocked();
			this.$wrapper.html(`
				<div class="wa-cb__stack wa-cb__messages">
					<p class="wa-cb__mstep-note">${esc(__("Every recipient receives all of these, in this order. The gap between two cards is the wait between them."))}</p>
					<div class="wa-cb__mstep-host"></div>
				</div>`);
			this.mount_composer();
			this.watch_scroll();
			this.watch_menus();
			// the composer draws the head of this step (its title, its count, "add message"), so the
			// one verb it has no opinion about joins that head rather than opening a second one
			const $test = $(`<button type="button" class="wa-btn wa-btn--secondary wa-btn--sm" data-test${blocked ? " disabled" : ""}${blocked ? ` title="${esc(blocked)}"` : ""}>${ui.ico("send", "sm")}<span>${esc(__("Send a test message"))}</span></button>`);
			$test.on("click", () => this.test_send()).prependTo(this.$wrapper.find(".sanad-mc__head-actions"));
			return this;
		}

		/** Why the test cannot be offered yet, or "" when it can. */
		test_blocked() {
			if (this.frm.is_new() || this.frm.is_dirty()) return __("Save the campaign to send a test.");
			if (!this.ctx.doc.device) return __("Choose a device first.");
			if (!this.messages_with_body().length) return __("Write a message first.");
			return "";
		}

		messages_with_body() {
			return (this.ctx.doc.messages || []).filter((m) => (m.body || "").trim() || m.template);
		}

		/**
		 * The composer. Rebuilt whenever the pane is drawn, never captured: Desk keeps one `frm` per
		 * DocType and hands it the next document, so a composer built while a Running campaign was
		 * open would stay read-only over the Draft one opened after it.
		 *
		 * It mounts itself in the field's own place, which on this screen is inside the hidden form
		 * layout, so the step moves it into its pane afterwards. The component is untouched: it
		 * still writes through the same field, and the kit stays exactly as the other screens use
		 * it.
		 */
		mount_composer() {
			const frm = this.frm;
			this.composer = new ui.MessageComposer({
				frm,
				fieldname: "messages",
				type_field: "message_type",
				body_field: "body",
				delay_field: "delay_seconds",
				max: 5,
				// what leads the editor for each type; everything else the type allows waits under
				// "More options", so a text message is a text box and not a form of eleven fields
				primary_fields: {
					Text: ["body"],
					Image: ["attachment", "caption"],
					Video: ["attachment", "caption"],
					Audio: ["attachment"],
					Sticker: ["attachment"],
					// printing the recipient's own document to PDF is a real capability, but it is not
					// what a campaign's document message usually is: it waits with `file_name_template`
					// under "More options" for the campaign that wants it
					Document: ["attachment", "caption"],
					Location: [],
					Poll: ["poll_question", "poll_options", "poll_allow_multiple"],
				},
				can_edit: () => this.ctx.can_edit(),
				preview: { method: "campaigns.preview_message", args: (row) => ({ name: frm.doc.name, idx: row.idx }) },
				// the campaign renders per recipient: these are the names that exist in that context
				// (`services/campaign_runner._render_message_body`), said in the reader's words
				variables: [
					{ name: "recipient.display_name", label: __("Recipient name") },
					{ name: "recipient.phone_e164", label: __("Recipient number") },
					{ name: "recipient.contact", label: __("Linked contact") },
					{ name: "campaign.campaign_name", label: __("Campaign name") },
					{ name: "doc.name", label: __("Source document") },
					{ name: "today", label: __("Today's date") },
					{ name: "now", label: __("Now") },
				],
				empty_text: __("No message yet"),
			});
			this.composer.$el.appendTo(this.$wrapper.find(".wa-cb__mstep-host"));
		}

		// ---- the test send -----------------------------------------------------------------------

		test_send() {
			const frm = this.frm;
			const rows = this.messages_with_body();
			const options = rows.map((m) => ({
				value: String(m.idx),
				label: __("Message {0} · {1}", [C.fmt_int(m.idx), __(m.message_type)]),
			}));
			const skipped = (this.ctx.doc.messages || []).length - rows.length;

			const dialog = new frappe.ui.Dialog({
				title: __("Send a test message"),
				fields: [
					{ fieldtype: "Select", fieldname: "idx", label: __("Which message"), options, default: options[0] && options[0].value, reqd: 1 },
					{ fieldtype: "HTML", fieldname: "phone" },
					{ fieldtype: "HTML", fieldname: "preview" },
				],
				primary_action_label: __("Send it"),
				primary_action: () => this.do_test(dialog),
			});
			dialog.show();
			dialog.$wrapper.addClass("sanad-sheet");

			this.phone = new ui.PhoneField({
				wrapper: dialog.get_field("phone").$wrapper,
				label: __("Send it to"),
				required: true,
				hint: __("Only this number receives it. Nothing is written to the campaign."),
			});
			const $preview = dialog.get_field("preview").$wrapper;
			$preview.html(`<div class="wa-cb__test-preview" data-preview></div>${skipped ? `<p class="wa-field__hint">${esc(__("{0} of the messages carry a file or a poll. The test send carries text, so they are not offered here.", [C.fmt_int(skipped)]))}</p>` : ""}`);
			const load = () => this.load_preview(dialog, $preview.find("[data-preview]"));
			dialog.get_field("idx").$input.on("change", load);
			load();
		}

		/** The message as the campaign would render it — the server's own preview, not a guess. */
		load_preview(dialog, $box) {
			const idx = cint(dialog.get_value("idx"));
			$box.html(`<div class="sanad-skeleton" style="block-size:64px"></div>`);
			ui.call("campaigns.preview_message", { name: this.ctx.doc.name, idx }, { silent: true })
				.then((p) => {
					if (!$box.closest("body").length) return;
					this.test_body = p.body || "";
					const errors = (p.errors || []).map((e) => `<li>${esc(e)}</li>`).join("");
					$box.html(`
						<span class="wa-cb__test-label">${esc(__("What arrives"))}</span>
						<div class="wa-cb__bubble" dir="auto">${esc(p.body || __("(empty)"))}</div>
						${p.attachment_name ? `<p class="wa-field__hint">${esc(__("The campaign also sends {0}; the test sends the text only.", [p.attachment_name]))}</p>` : ""}
						${errors ? `<ul class="wa-cb__test-errors" role="alert">${errors}</ul>` : ""}`);
				})
				.catch((err) => $box.html(`<p class="wa-cb__test-errors" role="alert">${esc(err.message)}</p>`));
		}

		do_test(dialog) {
			const phone = this.phone && this.phone.get_value();
			if (!phone || !phone.valid) {
				ui.Toast.error(__("Enter a valid number with its country code."));
				return;
			}
			if (!(this.test_body || "").trim()) {
				ui.Toast.error(__("This message has no text to send."));
				return;
			}
			dialog.set_primary_action_disabled && dialog.set_primary_action_disabled(true);
			ui.call("simulator.send_test", { device: this.ctx.doc.device, phone: phone.e164 || phone.phone_e164, body: this.test_body })
				.then((r) => {
					dialog.hide();
					ui.Toast.success(__("Test message sent to {0}.", [phone.e164 || phone.phone_e164]), {
						action: r && r.outbound ? { label: __("Open it"), onclick: () => frappe.set_route("Form", "WhatsApp Log", r.outbound) } : undefined,
					});
				})
				.catch((err) => {
					ui.Toast.error(err);
					dialog.set_primary_action_disabled && dialog.set_primary_action_disabled(false);
				});
		}
	};
})();

// whatsapp.ui.AttachMenu — the composer's "+" from the prototype's Chat Thread
// (`docs/component/Chat Thread.dc.html`, `composer.attach`): a popover over the button with a
// 3-column grid of kinds (image · video · document · voice note · location · contact card), each
// in its tone, and — once picked — a chip above the field ("Image · receipt.jpg ×").
//
// A file kind opens Frappe's own uploader (private file, restricted to that family); location and
// contact are a second step inside the same popover (latitude / longitude / name, or a contact
// search), so the menu never closes the window it lives in. The picked value is the host's to send:
// `{kind, label, attachment, file_name, contact, contact_label, location}`.
//
// Portable: the host passes the kinds it can send and the contact search.

frappe.provide("whatsapp.ui");

(function () {
	const escape_html = (v) => whatsapp.ui.escape(v);
	const stroke_icon_svg = (d) =>
		`<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
	const ICONS = {
		image: stroke_icon_svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"></rect><circle cx="9" cy="10" r="1.6"></circle><path d="M4 17l4.8-4.6 3.4 3.2 2.6-2.4L20 17"></path>'),
		video: stroke_icon_svg('<rect x="3" y="6" width="12.5" height="12" rx="2.5"></rect><path d="M15.5 11.2l5-2.7v7l-5-2.7z"></path>'),
		document: stroke_icon_svg('<path d="M13.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z"></path><path d="M13.5 3.5V9H19M9 13h6M9 16.5h4"></path>'),
		audio: stroke_icon_svg('<path d="M12 4.5a2.4 2.4 0 0 1 2.4 2.4v4.6a2.4 2.4 0 0 1-4.8 0V6.9A2.4 2.4 0 0 1 12 4.5z"></path><path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v3M9.5 20h5"></path>'),
		location: stroke_icon_svg('<path d="M12 21s6.5-6 6.5-11a6.5 6.5 0 1 0-13 0C5.5 15 12 21 12 21z"></path><circle cx="12" cy="10" r="2.3"></circle>'),
		contact: stroke_icon_svg('<circle cx="12" cy="9" r="3.2"></circle><path d="M5.5 19.5c1-3.2 3.6-4.8 6.5-4.8s5.5 1.6 6.5 4.8"></path>'),
		buttons: stroke_icon_svg('<rect x="3.5" y="5" width="17" height="5" rx="2.5"></rect><rect x="3.5" y="14" width="17" height="5" rx="2.5"></rect>'),
		list: stroke_icon_svg('<path d="M9 6.5h11M9 12h11M9 17.5h11"></path><circle cx="4.8" cy="6.5" r="1"></circle><circle cx="4.8" cy="12" r="1"></circle><circle cx="4.8" cy="17.5" r="1"></circle>'),
	};
	// the prototype's order and tones
	const KINDS = [
		{ key: "image", tone: "pri", accept: ["image/*"] },
		{ key: "video", tone: "nf", accept: ["video/*"] },
		{ key: "document", tone: "wn", accept: null },
		{ key: "audio", tone: "ok", accept: ["audio/*"] },
		{ key: "location", tone: "dg" },
		{ key: "contact", tone: "muted" },
		// opt-in: shown only to a host that lists them in `kinds` (it must be able to send them)
		{ key: "buttons", tone: "pri", opt_in: true },
		{ key: "list", tone: "nf", opt_in: true },
	];
	const label_of = (key) =>
		({
			image: __("Image"),
			video: __("Video"),
			document: __("Document", null, "Command Editor"),
			audio: __("Voice note"),
			location: __("Location"),
			contact: __("Contact card"),
			buttons: __("Buttons"),
			list: __("List"),
		})[key] || key;

	class AttachMenu {
		/**
		 * @param {Object} opts
		 * @param {jQuery|HTMLElement} opts.anchor — the "+" button
		 * @param {string[]} [opts.kinds] — the kinds the host can send (default: all six)
		 * @param {Object} [opts.reasons] — `{kind: text}` shown for a kind the host cannot send
		 * @param {Function} [opts.search_contacts] — `(txt) → [{name, label, phone}]`
		 * @param {Function} opts.on_pick — `(value)` with `{kind, label, attachment, file_name,
		 *   contact, contact_label, location}`
		 */
		constructor(opts = {}) {
			this.opts = opts;
			this.step = "menu";
			this.open();
		}

		static kind_icon_svg(kind) {
			return ICONS[kind] || ICONS.document;
		}

		static kind_label(kind) {
			return label_of(kind);
		}

		/** The chip above the field for a picked value (the host binds `[data-attach-clear]`). */
		static chip_html(v) {
			if (!v) return "";
			const detail = v.file_name || v.contact_label || v.summary || (v.location ? v.location.name || `${v.location.latitude}, ${v.location.longitude}` : "");
			const tone = (KINDS.find((k) => k.key === v.kind) || {}).tone || "muted";
			return `<span class="whatsapp-kit-attach-menu__chip whatsapp-kit-attach-menu__chip--${tone}">
				<span class="whatsapp-kit-attach-menu__chip-icon">${ICONS[v.kind] || ""}</span>
				<span class="whatsapp-kit-attach-menu__chip-text">${escape_html(label_of(v.kind))}${detail ? ` · <bdi>${escape_html(detail)}</bdi>` : ""}</span>
				<button type="button" class="whatsapp-kit-attach-menu__chip-x" data-attach-clear aria-label="${escape_html(__("Remove the attachment"))}" title="${escape_html(__("Remove the attachment"))}">×</button>
			</span>`;
		}

		open() {
			const $anchor = $(this.opts.anchor);
			this.$pop = $(`<div class="whatsapp-kit whatsapp-kit-attach-menu" role="dialog" aria-label="${escape_html(__("Message type"))}"></div>`).appendTo(document.body);
			this.render();
			this.place($anchor);
			this._outside = (e) => {
				if (!this.$pop) return;
				if (!$(e.target).closest(this.$pop).length && !$(e.target).closest($anchor).length) this.close();
			};
			this._key = (e) => {
				if (e.key !== "Escape") return;
				e.stopPropagation();
				e.preventDefault();
				this.close(true);
			};
			setTimeout(() => document.addEventListener("mousedown", this._outside, true), 0);
			this.$pop.on("keydown", this._key);
			this._resize = () => this.place($anchor);
			$(window).on("resize.whatsapp-kit-attach-menu", this._resize);
			const first = this.$pop.find("button:not([disabled]), input").get(0);
			first && first.focus();
		}

		place($anchor) {
			if (!this.$pop || !$anchor.length) return;
			const r = $anchor.get(0).getBoundingClientRect();
			const w = this.$pop.outerWidth();
			const h = this.$pop.outerHeight();
			const rtl = whatsapp.ui.is_rtl();
			let left = rtl ? r.right - w : r.left;
			left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
			const top = r.top - h - 8 >= 8 ? r.top - h - 8 : Math.min(r.bottom + 8, window.innerHeight - h - 8);
			this.$pop.css({ left: `${left}px`, top: `${top}px` });
		}

		close(refocus = false) {
			document.removeEventListener("mousedown", this._outside, true);
			$(window).off("resize.whatsapp-kit-attach-menu", this._resize);
			if (this.$pop) this.$pop.remove();
			this.$pop = null;
			if (refocus) $(this.opts.anchor).trigger("focus");
			this.opts.on_close && this.opts.on_close();
		}

		allowed(key) {
			return !this.opts.kinds || this.opts.kinds.includes(key);
		}

		render() {
			const $popover = this.$pop;
			if (this.step === "menu") {
				$popover.html(`<div class="whatsapp-kit-attach-menu__grid">${KINDS.filter((k) => !k.opt_in || (this.opts.kinds || []).includes(k.key)).map((k) => {
					const ok = this.allowed(k.key);
					const reason = !ok && this.opts.reasons ? this.opts.reasons[k.key] : "";
					return `<button type="button" class="whatsapp-kit-attach-menu__item" data-kind="${k.key}"${ok ? "" : ` disabled title="${escape_html(reason || __("Not available here"))}"`}>
						<span class="whatsapp-kit-attach-menu__icon whatsapp-kit-attach-menu__icon--${k.tone}">${ICONS[k.key]}</span>
						<span class="whatsapp-kit-attach-menu__label">${escape_html(label_of(k.key))}</span>
					</button>`;
				}).join("")}</div>`);
				$popover.find("[data-kind]").on("click", (e) => this.choose_attachment_kind($(e.currentTarget).data("kind")));
				return;
			}
			if (this.step === "location") {
				$popover.html(`<form class="whatsapp-kit-attach-menu__form" novalidate>
					<span class="whatsapp-kit-attach-menu__title">${ICONS.location}${escape_html(__("Location"))}</span>
					<span class="whatsapp-kit-attach-menu__row">
						<label class="whatsapp-kit-attach-menu__labelled-field"><span>${escape_html(__("Latitude"))}</span><input type="number" step="any" name="latitude" dir="ltr" required /></label>
						<label class="whatsapp-kit-attach-menu__labelled-field"><span>${escape_html(__("Longitude"))}</span><input type="number" step="any" name="longitude" dir="ltr" required /></label>
					</span>
					<label class="whatsapp-kit-attach-menu__labelled-field"><span>${escape_html(__("Place name"))}</span><input type="text" name="name" /></label>
					${navigator.geolocation ? `<button type="button" class="whatsapp-kit-attach-menu__link" data-here>${escape_html(__("Use my current location"))}</button>` : ""}
					<span class="whatsapp-kit-attach-menu__error" role="alert"></span>
					<span class="whatsapp-kit-attach-menu__actions">
						<button type="button" class="whatsapp-kit-attach-menu__button" data-back>${escape_html(__("Back"))}</button>
						<button type="submit" class="whatsapp-kit-attach-menu__button whatsapp-kit-attach-menu__button--primary">${escape_html(__("Add the location"))}</button>
					</span>
				</form>`);
				const $f = $popover.find("form");
				$popover.find("[data-back]").on("click", () => this.show_menu_step("menu"));
				$popover.find("[data-here]").on("click", () =>
					navigator.geolocation.getCurrentPosition(
						(pos) => {
							$f.find("[name=latitude]").val(pos.coords.latitude.toFixed(6));
							$f.find("[name=longitude]").val(pos.coords.longitude.toFixed(6));
						},
						() => $f.find(".whatsapp-kit-attach-menu__error").text(__("The browser did not share the location."))
					)
				);
				$f.on("submit", (e) => {
					e.preventDefault();
					const lat = parseFloat($f.find("[name=latitude]").val());
					const lng = parseFloat($f.find("[name=longitude]").val());
					if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) {
						$f.find(".whatsapp-kit-attach-menu__error").text(__("Enter a latitude between -90 and 90 and a longitude between -180 and 180."));
						return;
					}
					const name = cstr($f.find("[name=name]").val()).trim();
					this.close_and_send_pick({ kind: "location", location: { latitude: lat, longitude: lng, name: name || null } });
				});
				return;
			}
			if (this.step === "contact") {
				$popover.html(`<div class="whatsapp-kit-attach-menu__form">
					<span class="whatsapp-kit-attach-menu__title">${ICONS.contact}${escape_html(__("Contact card"))}</span>
					<input type="text" class="whatsapp-kit-attach-menu__search" data-whatsapp-bare placeholder="${escape_html(__("Search by name or number…"))}" aria-label="${escape_html(__("Search by name or number"))}" autocomplete="off" />
					<span class="whatsapp-kit-attach-menu__results" role="listbox"><span class="whatsapp-kit-attach-menu__none">${escape_html(__("Loading…"))}</span></span>
					<span class="whatsapp-kit-attach-menu__actions"><button type="button" class="whatsapp-kit-attach-menu__button" data-back>${escape_html(__("Back"))}</button></span>
				</div>`);
				$popover.find("[data-back]").on("click", () => this.show_menu_step("menu"));
				const $q = $popover.find(".whatsapp-kit-attach-menu__search");
				const $r = $popover.find(".whatsapp-kit-attach-menu__results");
				const load = whatsapp.ui.debounce(async () => {
					const q = cstr($q.val());
					let rows = [];
					try {
						rows = (await this.opts.search_contacts(q)) || [];
					} catch (err) {
						$r.html(`<span class="whatsapp-kit-attach-menu__none">${escape_html(err && err.message ? err.message : __("Something went wrong. Please try again."))}</span>`);
						return;
					}
					if (cstr($q.val()) !== q) return;
					$r.html(
						rows.length
							? rows
									.slice(0, 20)
									.map((c) => `<button type="button" role="option" class="whatsapp-kit-attach-menu__option" data-name="${escape_html(c.name)}">${escape_html(c.label || c.name)}<span dir="ltr">${escape_html(whatsapp.ui.phone(c.phone || ""))}</span></button>`)
									.join("")
							: `<span class="whatsapp-kit-attach-menu__none">${escape_html(__("No matching contacts."))}</span>`
					);
					$r.find("[data-name]").on("click", (e) => {
						const c = rows.find((x) => x.name === $(e.currentTarget).data("name"));
						if (c) this.close_and_send_pick({ kind: "contact", contact: c.name, contact_label: c.label || c.name });
					});
				}, 220);
				$q.on("input", load).trigger("focus");
				load();
			}
		}

		show_menu_step(step) {
			this.step = step;
			this.render();
			this.place($(this.opts.anchor));
			const first = this.$pop.find("input, button:not([disabled])").get(0);
			first && first.focus();
		}

		choose_attachment_kind(kind) {
			if (kind === "location" || kind === "contact") return this.show_menu_step(kind);
			if (kind === "buttons" || kind === "list") return this.define(kind);
			const spec = KINDS.find((k) => k.key === kind);
			this.close();
			new frappe.ui.FileUploader({
				allow_multiple: false,
				make_attachments_public: false,
				restrictions: spec && spec.accept ? { allowed_file_types: spec.accept } : {},
				on_success: (file) => {
					if (!file || !file.file_url) return;
					this.opts.on_pick({ kind, attachment: file.file_url, file_name: file.file_name || file.file_url.split("/").pop() });
				},
			});
		}

		/**
		 * Buttons or a list, defined line by line (the message text is the composer's own field):
		 * buttons `text | type | value` (type reply · url · call · copy), list `title | description`
		 * with a `# heading` line starting a section.
		 */
		define(kind) {
			this.close();
			const is_list = kind === "list";
			const d = new frappe.ui.Dialog({
				title: is_list ? __("List") : __("Buttons"),
				fields: [
					{ fieldtype: "Data", fieldname: "title", label: __("Title"), description: __("Optional, above the text.") },
					is_list ? { fieldtype: "Data", fieldname: "button_text", label: __("List button"), default: __("Options"), reqd: 1 } : null,
					{
						fieldtype: "Small Text",
						fieldname: "lines",
						reqd: 1,
						label: is_list ? __("Options") : __("Buttons"),
						description: is_list
							? __("One option per line: title | description. A line starting with # starts a section. Up to 10 options.")
							: __("One button per line: text, or text | url | https://…, text | call | +967…, text | copy | CODE. Up to 10."),
					},
					{ fieldtype: "Data", fieldname: "footer", label: __("Footer"), description: __("Optional, small text under the message.") },
				].filter(Boolean),
				primary_action_label: __("Use"),
				primary_action: (v) => {
					const lines = String(v.lines || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
					const interactive = { title: v.title || "", footer: v.footer || "" };
					let summary;
					if (is_list) {
						const sections = [];
						lines.forEach((l) => {
							if (l.startsWith("#")) return sections.push({ title: l.replace(/^#+/, "").trim(), rows: [] });
							if (!sections.length) sections.push({ title: "", rows: [] });
							const [title, description] = l.split("|").map((p) => p.trim());
							sections[sections.length - 1].rows.push({ title, description: description || "" });
						});
						interactive.button_text = v.button_text;
						interactive.sections = sections.filter((s) => s.rows.length);
						const n = interactive.sections.reduce((a, s) => a + s.rows.length, 0);
						summary = __("{0} options", [n]);
					} else {
						interactive.buttons = lines.map((l) => {
							const [text, type, value] = l.split("|").map((p) => (p || "").trim());
							const t = (type || "reply").toLowerCase();
							return { text, type: t, url: t === "url" ? value : undefined, phone: t === "call" ? value : undefined, code: t === "copy" ? value : undefined };
						});
						summary = __("{0} buttons", [interactive.buttons.length]);
					}
					d.hide();
					this.opts.on_pick({ kind, interactive, summary });
				},
			});
			d.show();
		}

		close_and_send_pick(value) {
			this.close(true);
			this.opts.on_pick(value);
		}
	}

	whatsapp.ui.AttachMenu = AttachMenu;
})();

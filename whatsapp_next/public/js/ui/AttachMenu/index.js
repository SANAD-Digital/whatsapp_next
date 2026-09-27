// sanad.ui.AttachMenu — the composer's "+" from the prototype's Chat Thread
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

frappe.provide("sanad.ui");

(function () {
	const esc = (v) => sanad.ui.escape(v);
	const SV = (d) =>
		`<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
	const ICONS = {
		image: SV('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"></rect><circle cx="9" cy="10" r="1.6"></circle><path d="M4 17l4.8-4.6 3.4 3.2 2.6-2.4L20 17"></path>'),
		video: SV('<rect x="3" y="6" width="12.5" height="12" rx="2.5"></rect><path d="M15.5 11.2l5-2.7v7l-5-2.7z"></path>'),
		document: SV('<path d="M13.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z"></path><path d="M13.5 3.5V9H19M9 13h6M9 16.5h4"></path>'),
		audio: SV('<path d="M12 4.5a2.4 2.4 0 0 1 2.4 2.4v4.6a2.4 2.4 0 0 1-4.8 0V6.9A2.4 2.4 0 0 1 12 4.5z"></path><path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v3M9.5 20h5"></path>'),
		location: SV('<path d="M12 21s6.5-6 6.5-11a6.5 6.5 0 1 0-13 0C5.5 15 12 21 12 21z"></path><circle cx="12" cy="10" r="2.3"></circle>'),
		contact: SV('<circle cx="12" cy="9" r="3.2"></circle><path d="M5.5 19.5c1-3.2 3.6-4.8 6.5-4.8s5.5 1.6 6.5 4.8"></path>'),
	};
	// the prototype's order and tones
	const KINDS = [
		{ key: "image", tone: "pri", accept: ["image/*"] },
		{ key: "video", tone: "nf", accept: ["video/*"] },
		{ key: "document", tone: "wn", accept: null },
		{ key: "audio", tone: "ok", accept: ["audio/*"] },
		{ key: "location", tone: "dg" },
		{ key: "contact", tone: "muted" },
	];
	const label_of = (key) =>
		({
			image: __("Image"),
			video: __("Video"),
			document: __("Document", null, "Command Editor"),
			audio: __("Voice note"),
			location: __("Location"),
			contact: __("Contact card"),
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

		static icon(kind) {
			return ICONS[kind] || ICONS.document;
		}

		static label(kind) {
			return label_of(kind);
		}

		/** The chip above the field for a picked value (the host binds `[data-attach-clear]`). */
		static chip_html(v) {
			if (!v) return "";
			const detail = v.file_name || v.contact_label || (v.location ? v.location.name || `${v.location.latitude}, ${v.location.longitude}` : "");
			const tone = (KINDS.find((k) => k.key === v.kind) || {}).tone || "muted";
			return `<span class="sanad-am__chip sanad-am__chip--${tone}">
				<span class="sanad-am__chip-icon">${ICONS[v.kind] || ""}</span>
				<span class="sanad-am__chip-text">${esc(label_of(v.kind))}${detail ? ` · <bdi>${esc(detail)}</bdi>` : ""}</span>
				<button type="button" class="sanad-am__chip-x" data-attach-clear aria-label="${esc(__("Remove the attachment"))}" title="${esc(__("Remove the attachment"))}">×</button>
			</span>`;
		}

		open() {
			const $anchor = $(this.opts.anchor);
			this.$pop = $(`<div class="sanad-kit sanad-am" role="dialog" aria-label="${esc(__("Message type"))}"></div>`).appendTo(document.body);
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
			$(window).on("resize.sanad-am", this._resize);
			const first = this.$pop.find("button:not([disabled]), input").get(0);
			first && first.focus();
		}

		place($anchor) {
			if (!this.$pop || !$anchor.length) return;
			const r = $anchor.get(0).getBoundingClientRect();
			const w = this.$pop.outerWidth();
			const h = this.$pop.outerHeight();
			const rtl = sanad.ui.is_rtl();
			let left = rtl ? r.right - w : r.left;
			left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
			const top = r.top - h - 8 >= 8 ? r.top - h - 8 : Math.min(r.bottom + 8, window.innerHeight - h - 8);
			this.$pop.css({ left: `${left}px`, top: `${top}px` });
		}

		close(refocus = false) {
			document.removeEventListener("mousedown", this._outside, true);
			$(window).off("resize.sanad-am", this._resize);
			if (this.$pop) this.$pop.remove();
			this.$pop = null;
			if (refocus) $(this.opts.anchor).trigger("focus");
			this.opts.on_close && this.opts.on_close();
		}

		allowed(key) {
			return !this.opts.kinds || this.opts.kinds.includes(key);
		}

		render() {
			const $p = this.$pop;
			if (this.step === "menu") {
				$p.html(`<div class="sanad-am__grid">${KINDS.map((k) => {
					const ok = this.allowed(k.key);
					const reason = !ok && this.opts.reasons ? this.opts.reasons[k.key] : "";
					return `<button type="button" class="sanad-am__item" data-kind="${k.key}"${ok ? "" : ` disabled title="${esc(reason || __("Not available here"))}"`}>
						<span class="sanad-am__icon sanad-am__icon--${k.tone}">${ICONS[k.key]}</span>
						<span class="sanad-am__label">${esc(label_of(k.key))}</span>
					</button>`;
				}).join("")}</div>`);
				$p.find("[data-kind]").on("click", (e) => this.pick($(e.currentTarget).data("kind")));
				return;
			}
			if (this.step === "location") {
				$p.html(`<form class="sanad-am__form" novalidate>
					<span class="sanad-am__title">${ICONS.location}${esc(__("Location"))}</span>
					<span class="sanad-am__row">
						<label class="sanad-am__fld"><span>${esc(__("Latitude"))}</span><input type="number" step="any" name="latitude" dir="ltr" required /></label>
						<label class="sanad-am__fld"><span>${esc(__("Longitude"))}</span><input type="number" step="any" name="longitude" dir="ltr" required /></label>
					</span>
					<label class="sanad-am__fld"><span>${esc(__("Place name"))}</span><input type="text" name="name" /></label>
					${navigator.geolocation ? `<button type="button" class="sanad-am__link" data-here>${esc(__("Use my current location"))}</button>` : ""}
					<span class="sanad-am__error" role="alert"></span>
					<span class="sanad-am__actions">
						<button type="button" class="sanad-am__btn" data-back>${esc(__("Back"))}</button>
						<button type="submit" class="sanad-am__btn sanad-am__btn--pri">${esc(__("Add the location"))}</button>
					</span>
				</form>`);
				const $f = $p.find("form");
				$p.find("[data-back]").on("click", () => this.go("menu"));
				$p.find("[data-here]").on("click", () =>
					navigator.geolocation.getCurrentPosition(
						(pos) => {
							$f.find("[name=latitude]").val(pos.coords.latitude.toFixed(6));
							$f.find("[name=longitude]").val(pos.coords.longitude.toFixed(6));
						},
						() => $f.find(".sanad-am__error").text(__("The browser did not share the location."))
					)
				);
				$f.on("submit", (e) => {
					e.preventDefault();
					const lat = parseFloat($f.find("[name=latitude]").val());
					const lng = parseFloat($f.find("[name=longitude]").val());
					if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) {
						$f.find(".sanad-am__error").text(__("Enter a latitude between -90 and 90 and a longitude between -180 and 180."));
						return;
					}
					const name = cstr($f.find("[name=name]").val()).trim();
					this.done({ kind: "location", location: { latitude: lat, longitude: lng, name: name || null } });
				});
				return;
			}
			if (this.step === "contact") {
				$p.html(`<div class="sanad-am__form">
					<span class="sanad-am__title">${ICONS.contact}${esc(__("Contact card"))}</span>
					<input type="text" class="sanad-am__search" data-sanad-bare placeholder="${esc(__("Search by name or number…"))}" aria-label="${esc(__("Search by name or number"))}" autocomplete="off" />
					<span class="sanad-am__results" role="listbox"><span class="sanad-am__none">${esc(__("Loading…"))}</span></span>
					<span class="sanad-am__actions"><button type="button" class="sanad-am__btn" data-back>${esc(__("Back"))}</button></span>
				</div>`);
				$p.find("[data-back]").on("click", () => this.go("menu"));
				const $q = $p.find(".sanad-am__search");
				const $r = $p.find(".sanad-am__results");
				const load = sanad.ui.debounce(async () => {
					const q = cstr($q.val());
					let rows = [];
					try {
						rows = (await this.opts.search_contacts(q)) || [];
					} catch (err) {
						$r.html(`<span class="sanad-am__none">${esc(err && err.message ? err.message : __("Something went wrong. Please try again."))}</span>`);
						return;
					}
					if (cstr($q.val()) !== q) return;
					$r.html(
						rows.length
							? rows
									.slice(0, 20)
									.map((c) => `<button type="button" role="option" class="sanad-am__opt" data-name="${esc(c.name)}">${esc(c.label || c.name)}<span dir="ltr">${esc(c.phone || "")}</span></button>`)
									.join("")
							: `<span class="sanad-am__none">${esc(__("No matching contacts."))}</span>`
					);
					$r.find("[data-name]").on("click", (e) => {
						const c = rows.find((x) => x.name === $(e.currentTarget).data("name"));
						if (c) this.done({ kind: "contact", contact: c.name, contact_label: c.label || c.name });
					});
				}, 220);
				$q.on("input", load).trigger("focus");
				load();
			}
		}

		go(step) {
			this.step = step;
			this.render();
			this.place($(this.opts.anchor));
			const first = this.$pop.find("input, button:not([disabled])").get(0);
			first && first.focus();
		}

		pick(kind) {
			if (kind === "location" || kind === "contact") return this.go(kind);
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

		done(value) {
			this.close(true);
			this.opts.on_pick(value);
		}
	}

	sanad.ui.AttachMenu = AttachMenu;
})();

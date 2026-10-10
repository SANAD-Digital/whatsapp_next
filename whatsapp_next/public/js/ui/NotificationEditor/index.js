// sanad.ui.NotificationEditor — one window to create, edit and try a document notification: a
// WhatsApp message that goes out when something happens to a record (created, submitted, a field
// changes, N days before a date…). The same anatomy as the AlertEditor, its cards and its preview
// (the two windows share `sanad-ae` styling), answering four short questions:
//
//   1 When     the document type (searched), the event as chips, the detail the event needs (a date
//              field and N days, a field that changes, another document event) and an optional
//              condition.
//   2 What     the message, from a saved template — the templates written for this document type
//              as cards, with "New template" and "Edit template" opening the host's template
//              editor — or written here with the document's fields as insertable variables, and
//              "Save as a template". Then what it attaches: nothing, a print of the record or a file
//              in one of its fields.
//   3 To whom  a number in the document, a number through a linked record, fixed numbers or the
//              host's contact picker, as chips.
//   4 From     the device that sends it.
//   (+) Afterwards — optionally set a field of the record once the message is sent.
//
// Beside them, a live preview of the unsaved draft on one record (the latest, or one picked):
// whether the condition holds, the message as the first recipient gets it, what it attaches and
// how many numbers it reaches; "Send a test" sends it once to one number. A saved notification
// also shows what it has sent.
//
// Portable: it knows nothing about the host app. The host passes the data source as functions —
// see README.md. Colours are the product tokens (`--wa-*`); offsets are logical, so RTL needs nothing.

frappe.provide("sanad.ui");

(function () {
	const esc = (v) => sanad.ui.escape(v == null ? "" : v);
	const DAY_EVENTS = ["Days Before", "Days After"];
	const MINUTE_EVENTS = ["Minutes Before", "Minutes After"];
	const EVENT_LABEL = () => ({
		New: __("It is created"),
		Save: __("It is saved"),
		Submit: __("It is submitted"),
		Cancel: __("It is cancelled"),
		"Value Change": __("A field changes"),
		"Days Before": __("Days before a date"),
		"Days After": __("Days after a date"),
		"Minutes Before": __("Minutes before a time"),
		"Minutes After": __("Minutes after a time"),
		Method: __("Another document event"),
	});
	const RECIPIENT_META = () => ({
		"Document Field": { icon: "user", label: __("A number in the document") },
		"Linked Document Field": { icon: "link", label: __("Through a linked record") },
		"Fixed Number": { icon: "chat", label: __("A fixed number") },
	});
	const VAR_LIMIT = 12;
	/** Frappe's filter list from the stored JSON, or []. */
	const parse_filters = (raw) => {
		try {
			const v = typeof raw === "string" ? JSON.parse(raw) : raw;
			return Array.isArray(v) ? v : [];
		} catch (e) {
			return [];
		}
	};

	class NotificationEditor {
		constructor(opts = {}) {
			this.opts = opts;
			this.ui = {
				add_q: "",
				results: [],
				pick_open: null, // "document_type" | "print_format" | "letter_head"
				preview: null,
				previewing: false,
				saving: false,
				testing: false,
				test_phone: "",
				who_open: null,
				ref: null, // the record the preview is tried on; null → the latest
				var_q: "",
				tpl_q: "",
				adder: "Document Field",
				labels: {},
			};
			this.data = null;
			this.draft = null;
			this.clean = null;
			this.build();
			this.load(opts.name || null);
		}

		// ---- shell ---------------------------------------------------------------------------------

		build() {
			this.id = sanad.ui.uid("sanad-ne");
			this.previous_focus = document.activeElement;
			this.$root = $(`
				<div class="sanad-kit sanad-ae-layer" role="presentation">
					<div class="sanad-ae-backdrop" data-act="close"></div>
					<div class="sanad-ae sanad-ne" role="dialog" aria-modal="true" aria-labelledby="${this.id}-title">
						<div class="sanad-ae__loading">${esc(__("Loading…"))}</div>
					</div>
				</div>`).appendTo(document.body);
			this.$dlg = this.$root.find(".sanad-ae");
			$("body").addClass("sanad-ae-open");
			this.$root.on("click", "[data-act]", (e) => this.on_act(e));
			this.$root.on("input", "[data-in]", (e) => this.on_input(e));
			this.$root.on("change", "[data-ch]", (e) => this.on_change(e));
			this.$root.on("keydown", (e) => this.on_key(e));
			this.$root.on("focusin", "[data-in=pick_q]", (e) => {
				const kind = $(e.currentTarget).data("kind");
				if (this.ui.pick_open === kind) return;
				this.ui.pick_open = kind;
				this.ui.add_q = $(e.currentTarget).val() || "";
				this.ui.searching = true;
				this.run_search();
			});
			this.$root.on("mousedown", (e) => {
				if (this.ui.pick_open && !$(e.target).closest(".sanad-ae__pick").length) this.close_pick();
			});
			this.untrap = sanad.ui.trap_focus(this.$root);
			this.refresh_preview = sanad.ui.debounce(() => this.run_preview(), 600);
			this.search_later = sanad.ui.debounce(() => this.run_search(), 250);
		}

		close(force = false) {
			if (!force && this.is_dirty()) {
				frappe.confirm(__("Discard unsaved changes?"), () => this.close(true));
				return;
			}
			this.untrap && this.untrap();
			if (!$(".sanad-ae-layer").not(this.$root).length) $("body").removeClass("sanad-ae-open");
			this.$root.remove();
			if (this.previous_focus && this.previous_focus.focus) this.previous_focus.focus();
			this.opts.on_close && this.opts.on_close();
		}

		async load(name) {
			try {
				this.data = await this.opts.load(name);
				this.draft = this.seed(this.data.notification);
				this.clean = JSON.stringify(this.draft);
				this.ui.test_phone = (this.data.me && this.data.me.phone) || "";
				if (this.draft.document_type) this.ui.labels[`document_type:${this.draft.document_type}`] = null;
				this.render();
				if (!this.draft.name) this.$root.find("[data-in=notification_name]").trigger("focus");
				this.run_preview();
			} catch (err) {
				this.$dlg.html(`
					<div class="sanad-ae__loading" role="alert">
						<span>${esc(err && err.message ? err.message : __("Something went wrong. Please try again."))}</span>
						<button type="button" class="sanad-ae__btn" data-act="close">${esc(__("Close"))}</button>
					</div>`);
			}
		}

		seed(n) {
			return {
				name: n.name || null,
				notification_name: n.notification_name || "",
				enabled: cint(n.enabled),
				document_type: n.document_type || null,
				event: n.event || "Submit",
				date_changed: n.date_changed || "",
				days_in_advance: cint(n.days_in_advance) || 1,
				datetime_changed: n.datetime_changed || "",
				minutes_offset: cint(n.minutes_offset) || 30,
				value_changed: n.value_changed || "",
				method: n.method || "",
				condition: n.condition || "",
				filters: parse_filters(n.filters),
				cond_mode: n.condition_type === "Filters" ? (parse_filters(n.filters).length ? "filters" : "none") : (n.condition || "").trim() ? "python" : "none",
				device: n.device || null,
				template: n.template || null,
				message: n.message || "",
				body_mode: n.template ? "template" : "custom",
				attach: cint(n.attach_print) ? "print" : n.attach_field ? "field" : "none",
				print_format: n.print_format || null,
				letter_head: n.letter_head || null,
				attach_field: n.attach_field || "",
				message_type: n.message_type || "Text",
				set_property_after_alert: n.set_property_after_alert || "",
				property_value: n.property_value || "",
				recipients: (n.recipients || []).map((r) => ({
					recipient_type: r.recipient_type,
					receiver_by_document_field: r.receiver_by_document_field || null,
					linked_document_field: r.linked_document_field || null,
					linked_mobile_fieldname: r.linked_mobile_fieldname || null,
					phone: r.phone_e164 || r.phone || null,
					condition: r.condition || null,
				})),
			};
		}

		payload() {
			const d = this.draft;
			const attach_field = this.attach_fields().find((f) => f.fieldname === d.attach_field);
			const out = {
				notification_name: d.notification_name,
				enabled: d.enabled,
				document_type: d.document_type,
				event: d.event,
				date_changed: DAY_EVENTS.includes(d.event) ? d.date_changed || null : null,
				days_in_advance: DAY_EVENTS.includes(d.event) ? d.days_in_advance : 0,
				datetime_changed: MINUTE_EVENTS.includes(d.event) ? d.datetime_changed || null : null,
				minutes_offset: MINUTE_EVENTS.includes(d.event) ? d.minutes_offset : 0,
				value_changed: d.event === "Value Change" ? d.value_changed || null : null,
				method: d.event === "Method" ? d.method || null : null,
				condition_type: d.cond_mode === "python" ? "Python" : "Filters",
				filters: d.cond_mode === "filters" && d.filters.length ? d.filters : null,
				condition: d.cond_mode === "python" ? (d.condition || "").trim() || null : null,
				device: d.device,
				template: d.body_mode === "template" ? d.template : null,
				// a written text stays on the record under a template, so switching back loses nothing
				message: d.message || null,
				message_type: d.attach === "print" ? "Document" : d.attach === "field" ? (attach_field && attach_field.fieldtype === "Attach Image" ? "Image" : "Document") : "Text",
				attach_print: d.attach === "print" ? 1 : 0,
				print_format: d.attach === "print" ? d.print_format : null,
				letter_head: d.attach === "print" ? d.letter_head : null,
				attach_field: d.attach === "field" ? d.attach_field || null : null,
				set_property_after_alert: d.set_property_after_alert || null,
				property_value: d.set_property_after_alert ? d.property_value : null,
				recipients: d.recipients,
			};
			if (d.name) out.name = d.name;
			return out;
		}

		is_dirty() {
			return !!this.draft && this.clean !== JSON.stringify(this.draft);
		}

		changed({ redraw = [], preview = true } = {}) {
			redraw.forEach((part) => this[`draw_${part}`] && this[`draw_${part}`]());
			this.draw_sentence();
			this.draw_head_state();
			this.draw_foot();
			if (preview) {
				this.ui.previewing = true;
				this.draw_status();
				this.refresh_preview();
			}
		}

		// ---- the document type's fields -----------------------------------------------------------

		fields(kind) {
			return ((this.data.fields || {})[kind] || []).slice();
		}

		attach_fields() {
			return this.fields("all_fields").filter((f) => ["Attach", "Attach Image"].includes(f.fieldtype));
		}

		field_label(fieldname) {
			const f = this.fields("all_fields").find((x) => x.fieldname === fieldname);
			return f ? __(f.label) : fieldname;
		}

		select(key, rows, value, placeholder, label) {
			const opts = rows.map((r) => `<option value="${esc(r.fieldname)}"${r.fieldname === value ? " selected" : ""}>${esc(__(r.label))}</option>`);
			if (value && !rows.some((r) => r.fieldname === value)) opts.push(`<option value="${esc(value)}" selected>${esc(value)}</option>`);
			return `<select class="wa-select" data-ch="${esc(key)}" aria-label="${esc(label || placeholder)}"><option value="">${esc(placeholder)}</option>${opts.join("")}</select>`;
		}

		async load_setup() {
			const dt = this.draft.document_type;
			if (!dt) {
				this.data.fields = null;
				this.data.templates = [];
				return;
			}
			try {
				const r = await this.opts.setup(dt);
				if (this.draft.document_type !== dt) return;
				this.data.fields = r.fields;
				this.data.templates = r.templates || [];
			} catch (err) {
				this.data.fields = null;
				frappe.show_alert({ message: err && err.message ? err.message : __("Could not read the document type"), indicator: "red" });
			}
		}

		// ---- render --------------------------------------------------------------------------------

		render() {
			const d = this.draft;
			this.$dlg.html(`
				<header class="sanad-ae__head">
					<span class="sanad-ae__mark" aria-hidden="true">${sanad.ui.ico("bolt", "md")}</span>
					<div class="sanad-ae__heading">
						<h2 id="${this.id}-title" class="sr-only">${esc(d.name ? __("Edit notification") : __("New notification"))}</h2>
						<input type="text" class="sanad-ae__name" data-in="notification_name" data-sanad-bare maxlength="140"
							value="${esc(d.notification_name)}" placeholder="${esc(__("Name this notification…"))}" aria-label="${esc(__("Notification name"))}">
						<p class="sanad-ae__sentence" data-slot="sentence"></p>
					</div>
					<span class="sanad-ae__dirty" data-slot="dirty" hidden>${esc(__("Not saved"))}</span>
					<label class="wa-toggle sanad-ae__enabled" title="${esc(__("The notification sends only when it is on"))}">
						<input type="checkbox" data-ch="enabled" ${d.enabled ? "checked" : ""}>
						<span class="wa-toggle__track"></span>
						<span class="wa-toggle__label" data-slot="enabled-label"></span>
					</label>
					<button type="button" class="sanad-ae__icon" data-act="close" aria-label="${esc(__("Close"))}" title="${esc(__("Close (Esc)"))}">${sanad.ui.ico("x", "md")}</button>
				</header>
				<div class="sanad-ae__main">
					<div class="sanad-ae__build">
						<section class="sanad-ae__step" data-step="when"></section>
						<section class="sanad-ae__step" data-step="what"></section>
						<section class="sanad-ae__step" data-step="who"></section>
						<section class="sanad-ae__step" data-step="from"></section>
						<section class="sanad-ae__step" data-step="after"></section>
					</div>
					<aside class="sanad-ae__side" aria-label="${esc(__("Preview"))}">
						<div data-slot="record"></div>
						<div data-slot="preview"></div>
						<div data-slot="test"></div>
						<div data-slot="history"></div>
					</aside>
				</div>
				<footer class="sanad-ae__foot" data-slot="foot"></footer>`);
			this.draw_all();
		}

		draw_all() {
			this.draw_when();
			this.draw_what();
			this.draw_who();
			this.draw_from();
			this.draw_after();
			this.draw_record();
			this.draw_preview();
			this.draw_test();
			this.draw_history();
			this.draw_sentence();
			this.draw_head_state();
			this.draw_foot();
		}

		step_head(n, title, done, note) {
			return `
				<header class="sanad-ae__step-head">
					<span class="sanad-ae__num${done ? " is-done" : ""}" aria-hidden="true">${done ? sanad.ui.ico("tick", "sm") : n}</span>
					<span class="sanad-ae__step-title"><strong>${esc(title)}</strong>${note ? `<span>${esc(note)}</span>` : ""}</span>
					<span class="sr-only">${esc(done ? __("Complete") : __("Not complete yet"))}</span>
				</header>`;
		}

		chip(label, { act, value, on, disabled, title } = {}) {
			return `<button type="button" class="sanad-ae__chip${on ? " is-on" : ""}" data-act="${esc(act)}" data-value="${esc(value)}" aria-pressed="${on ? "true" : "false"}"${disabled ? " disabled" : ""}${title ? ` title="${esc(title)}"` : ""}>${esc(label)}</button>`;
		}

		seg(act, options, value, label) {
			return `<div class="wa-seg sanad-ae__seg" role="radiogroup" aria-label="${esc(label)}">${options
				.map(
					(o) =>
						`<button type="button" class="wa-seg__opt" role="radio" aria-checked="${o.value === value}" data-act="${esc(act)}" data-value="${esc(o.value)}"${o.disabled ? " disabled" : ""}${o.title ? ` title="${esc(o.title)}"` : ""}>${o.icon ? sanad.ui.ico(o.icon, "xs") : ""}<span>${esc(o.label)}</span></button>`
				)
				.join("")}</div>`;
		}

		/** A searchable single-value picker: the value as a chip, or a search field with results. */
		picker(kind, value, placeholder, label, description) {
			if (value) {
				return `<div class="sanad-ae__picked">
					<span class="sanad-ae__picked-text"><strong>${esc(label || value)}</strong>${description ? `<span>${esc(description)}</span>` : ""}</span>
					<button type="button" class="sanad-ae__link" data-act="unpick" data-kind="${esc(kind)}">${esc(__("Change"))}</button>
				</div>`;
			}
			const open = this.ui.pick_open === kind;
			return `<div class="sanad-ae__pick">
				<span class="sanad-ae__pick-ico" aria-hidden="true">${sanad.ui.ico("search", "sm")}</span>
				<input type="search" class="wa-input" data-in="pick_q" data-kind="${esc(kind)}" autocomplete="off" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" aria-expanded="${open}" value="${open ? esc(this.ui.add_q) : ""}">
				${open ? this.results_html(kind) : ""}
			</div>`;
		}

		results_html(kind) {
			const rows = this.ui.results || [];
			return `<div class="sanad-ae__results" role="listbox">${
				rows.length
					? rows
							.map(
								(r, i) =>
									`<button type="button" role="option" class="sanad-ae__opt" data-act="pick" data-kind="${esc(kind)}" data-i="${i}"><strong>${esc(r.label)}</strong>${r.description ? `<span>${esc(r.description)}</span>` : ""}</button>`
							)
							.join("")
					: `<p class="sanad-ae__none">${esc(this.ui.searching ? __("Searching…") : __("Nothing matches"))}</p>`
			}</div>`;
		}

		// 1 — when -------------------------------------------------------------------------------------

		when_done() {
			const d = this.draft;
			if (!d.document_type || !d.event) return false;
			if (DAY_EVENTS.includes(d.event)) return !!d.date_changed;
			if (MINUTE_EVENTS.includes(d.event)) return !!d.datetime_changed;
			if (d.event === "Value Change") return !!d.value_changed;
			if (d.event === "Method") return !!d.method;
			return true;
		}

		draw_when() {
			const d = this.draft;
			const labels = EVENT_LABEL();
			const known = this.data.options.event || [];
			const chips = (events) =>
				events.filter((e) => known.includes(e)).map((e) => this.chip(labels[e] || __(e), { act: "event", value: e, on: d.event === e, disabled: !d.document_type })).join("");
			let detail = "";
			if (d.document_type && DAY_EVENTS.includes(d.event)) {
				detail = `<div class="sanad-ne__line">
					<input type="number" min="0" class="wa-input wa-input--mono sanad-ne__num" data-in="days_in_advance" value="${esc(d.days_in_advance)}" aria-label="${esc(__("Days"))}">
					<span>${esc(d.event === "Days Before" ? __("days before") : __("days after"))}</span>
					${this.select("date_changed", this.fields("date_fields"), d.date_changed, __("Choose a date field…"), __("Date field"))}
				</div>`;
			} else if (d.document_type && MINUTE_EVENTS.includes(d.event)) {
				detail = `<div class="sanad-ne__line">
					<input type="number" min="0" class="wa-input wa-input--mono sanad-ne__num" data-in="minutes_offset" value="${esc(d.minutes_offset)}" aria-label="${esc(__("Minutes"))}">
					<span>${esc(d.event === "Minutes Before" ? __("minutes before") : __("minutes after"))}</span>
					${this.select("datetime_changed", this.fields("datetime_fields"), d.datetime_changed, __("Choose a date and time field…"), __("Date and time field"))}
				</div>`;
			} else if (d.document_type && d.event === "Value Change") {
				detail = `<div class="sanad-ne__line"><span>${esc(__("When this field changes"))}</span>${this.select("value_changed", this.fields("all_fields"), d.value_changed, __("Choose a field…"), __("Field"))}</div>`;
			} else if (d.document_type && d.event === "Method") {
				const methods = (this.data.options.method || []).map((m) => ({ fieldname: m, label: m }));
				detail = `<div class="sanad-ne__line"><span>${esc(__("On the document event"))}</span>${this.select("method", methods, d.method, __("Choose an event…"), __("Document event"))}</div>`;
			}
			const cond = d.cond_mode;
			this.$root.find("[data-step=when]").html(`
				${this.step_head(1, __("When is it sent?"), this.when_done())}
				<div class="sanad-ae__step-body">
					<div class="sanad-ae__field">
						<span class="sanad-ae__label">${esc(__("Document type"))}</span>
						${this.picker("document_type", d.document_type, __("Search document types…"), d.document_type ? __(d.document_type) : null, this.ui.labels[`document_type:${d.document_type}`])}
					</div>
					<fieldset class="sanad-ne__block"${d.document_type ? "" : " disabled"}>
						<legend class="sanad-ae__label">${esc(__("Send it when"))}</legend>
						<div class="sanad-ne__group">
							<span class="sanad-ne__group-label">${esc(__("Something happens to it"))}</span>
							<div class="sanad-ae__chips">${chips(["New", "Save", "Submit", "Cancel", "Value Change"])}</div>
						</div>
						<div class="sanad-ne__group">
							<span class="sanad-ne__group-label">${esc(__("On a schedule"))}</span>
							<div class="sanad-ae__chips">${chips(["Days Before", "Days After", "Minutes Before", "Minutes After"])}</div>
						</div>
						${
							d.event === "Method"
								? `<div class="sanad-ne__group"><span class="sanad-ne__group-label">${esc(__("Other"))}</span><div class="sanad-ae__chips">${chips(["Method"])}</div></div>`
								: `<button type="button" class="sanad-ae__link sanad-ne__other" data-act="event" data-value="Method"${d.document_type ? "" : " disabled"}>${esc(__("Another document event…"))}</button>`
						}
						${detail}
						${d.document_type ? "" : `<p class="sanad-ae__hint">${esc(__("Choose the document type first."))}</p>`}
					</fieldset>
					<fieldset class="sanad-ne__block"${d.document_type ? "" : " disabled"}>
						<div class="sanad-ae__field-line">
							<legend class="sanad-ae__label">${esc(__("For which records?"))}</legend>
							${this.seg(
								"cond",
								[
									{ value: "none", label: __("Every record") },
									{ value: "filters", label: __("Matching filters"), icon: "table" },
									{ value: "python", label: __("An expression"), icon: "code" },
								],
								cond,
								__("Condition")
							)}
						</div>
						${
							cond === "filters"
								? `<div class="sanad-ne__fg"></div><p class="sanad-ae__hint">${esc(__("Only records that match every filter get the message, as in a list's filters."))}</p>`
								: cond === "python"
									? `<textarea class="wa-textarea wa-input--mono sanad-ne__code" data-in="condition" rows="2" dir="ltr" spellcheck="false" placeholder="doc.grand_total > 1000" aria-label="${esc(__("Condition"))}">${esc(d.condition)}</textarea>
										<p class="sanad-ae__hint">${esc(__("A Python expression over doc; the message goes out only when it is true."))}</p>`
									: ""
						}
					</fieldset>
				</div>`);
			if (cond === "filters" && d.document_type) this.draw_filters();
		}

		/** Frappe's own filter component on the document type, as its Notification's "Filters" condition. */
		draw_filters() {
			const d = this.draft;
			const $fg = this.$root.find("[data-step=when] .sanad-ne__fg");
			const dt = d.document_type;
			frappe.model.with_doctype(dt, () => {
				if (this.draft.document_type !== dt || !$fg.closest("body").length) return;
				try {
					this.fg = new frappe.ui.FilterGroup({
						parent: $fg,
						doctype: dt,
						on_change: () => {
							d.filters = this.fg.get_filters().map((f) => f.slice(0, 4));
							this.changed();
						},
					});
					this.fg.wrapper.find(".apply-filters").hide();
					this.fg.add_filters_to_filter_group(d.filters || []);
				} catch (e) {
					$fg.html(`<p class="sanad-ae__hint">${esc(__("The filters could not be shown for this document type."))}</p>`);
				}
			});
		}

		// 2 — what -------------------------------------------------------------------------------------

		draw_what() {
			const d = this.draft;
			const done = d.body_mode === "template" ? !!d.template : !!(d.message || "").trim();
			const attach_fields = this.attach_fields();
			this.$root.find("[data-step=what]").html(`
				${this.step_head(2, __("What does it send?"), done)}
				<div class="sanad-ae__step-body">
					<div class="sanad-ae__field">
						<div class="sanad-ae__field-line">
							<span class="sanad-ae__label">${esc(__("Message"))}</span>
							${this.seg(
								"body",
								[
									{ value: "template", label: __("From a template"), icon: "cards" },
									{ value: "custom", label: __("Written here"), icon: "note" },
								],
								d.body_mode,
								__("Message source")
							)}
						</div>
						<div data-slot="body"></div>
					</div>
					<div class="sanad-ae__field">
						<span class="sanad-ae__label">${esc(__("Attach"))}</span>
						${this.seg(
							"attach",
							[
								{ value: "none", label: __("Nothing") },
								{ value: "print", label: __("A print of the document"), icon: "doc", disabled: !d.document_type },
								{ value: "field", label: __("A file in the document"), icon: "attach", disabled: !attach_fields.length, title: attach_fields.length ? "" : __("The document type has no attachment field") },
							],
							d.attach,
							__("Attachment")
						)}
						${
							d.attach === "print"
								? `<div class="sanad-ae__cols">
									<div class="sanad-ae__field"><span class="sanad-ae__label">${esc(__("Print format"))}</span>${this.picker("print_format", d.print_format, __("Default"), d.print_format)}</div>
									<div class="sanad-ae__field"><span class="sanad-ae__label">${esc(__("Letter head"))}</span>${this.picker("letter_head", d.letter_head, __("None"), d.letter_head)}</div>
								</div>`
								: d.attach === "field"
									? this.select("attach_field", attach_fields, d.attach_field, __("Choose the field that holds the file…"), __("Attachment field"))
									: ""
						}
					</div>
				</div>`);
			this.draw_body();
		}

		draw_body() {
			const $b = this.$root.find("[data-slot=body]");
			if (this.draft.body_mode === "template") return $b.html(this.templates_html());
			$b.html(this.write_html());
		}

		/** The templates the notification can use, as cards: the document type's own first. */
		templates_html() {
			const d = this.draft;
			const q = this.ui.tpl_q.trim().toLowerCase();
			const all = this.data.templates || [];
			const rows = all.filter((t) => !q || `${t.template_name || t.name} ${t.category || ""} ${t.body || ""}`.toLowerCase().includes(q));
			const can_new = !!this.opts.open_template;
			const card = (t) => {
				const on = t.name === d.template;
				return `<button type="button" class="sanad-ne__tpl${on ? " is-on" : ""}" data-act="template" data-value="${esc(t.name)}" aria-pressed="${on}">
					<span class="sanad-ne__tpl-head">
						<strong>${esc(t.template_name || t.name)}</strong>
						${on ? `<span class="sanad-ne__tpl-tick" aria-hidden="true">${sanad.ui.ico("tick", "xs")}</span>` : ""}
					</span>
					<span class="sanad-ne__tpl-meta">${t.category ? `<span class="wa-badge wa-badge--muted wa-badge--nodot">${esc(t.category)}</span>` : ""}${
						t.reference_doctype ? `<span>${esc(__("For {0}", [__(t.reference_doctype)]))}</span>` : `<span>${esc(__("Any document"))}</span>`
					}${t.message_type && t.message_type !== "Text" ? `<span>${esc(__(t.message_type))}</span>` : ""}</span>
					<span class="sanad-ne__tpl-body" dir="auto">${esc(t.body || "")}</span>
				</button>`;
			};
			const chosen = all.find((t) => t.name === d.template);
			return `
				${all.length > 6 ? `<input type="search" class="wa-input sanad-ne__filter" data-in="tpl_q" value="${esc(this.ui.tpl_q)}" placeholder="${esc(__("Filter templates…"))}" aria-label="${esc(__("Filter templates"))}">` : ""}
				<div class="sanad-ne__tpls" role="group" aria-label="${esc(__("Templates"))}">
					${can_new ? `<button type="button" class="sanad-ne__tpl sanad-ne__tpl--new" data-act="tpl_new">${sanad.ui.ico("plus", "sm")}<strong>${esc(__("New template"))}</strong><span>${esc(d.document_type ? __("Written for {0}", [__(d.document_type)]) : __("Opens the template editor"))}</span></button>` : ""}
					${rows.map(card).join("")}
				</div>
				${!all.length ? `<p class="sanad-ae__hint">${esc(d.document_type ? __("No template is written for {0} yet. Create one, or write the message here.", [__(d.document_type)]) : __("Choose the document type to see its templates."))}</p>` : ""}
				${all.length && !rows.length ? `<p class="sanad-ae__hint">${esc(__("No template matches."))}</p>` : ""}
				${d.template && !chosen ? `<p class="sanad-ae__hint">${esc(__("Uses {0}", [d.template]))}</p>` : ""}
				${d.template && can_new ? `<div class="sanad-ne__tpl-actions"><button type="button" class="sanad-ae__link" data-act="tpl_edit">${sanad.ui.ico("note", "xs")} ${esc(__("Edit this template"))}</button></div>` : ""}`;
		}

		/** The message written here, with the document's fields as insertable variables. */
		write_html() {
			const d = this.draft;
			const q = this.ui.var_q.trim().toLowerCase();
			const fields = this.fields("all_fields").filter((f) => !q || `${__(f.label)} ${f.fieldname}`.toLowerCase().includes(q));
			const shown = fields.slice(0, VAR_LIMIT);
			const vars = d.document_type
				? `<div class="sanad-ne__vars-bar">
						<span class="sanad-ae__sub">${esc(__("Insert a field of the document"))}</span>
						<input type="search" class="wa-input sanad-ne__filter" data-in="var_q" value="${esc(this.ui.var_q)}" placeholder="${esc(__("Filter fields…"))}" aria-label="${esc(__("Filter fields"))}">
					</div>
					<div class="sanad-ae__vars" role="group" aria-label="${esc(__("Insert a variable"))}">
						${shown.map((f) => `<button type="button" class="sanad-ae__var" data-act="var" data-value="${esc(f.fieldname)}" title="{{ doc.${esc(f.fieldname)} }}">${sanad.ui.ico("plus", "xs")}${esc(__(f.label))}</button>`).join("")}
						${fields.length > shown.length ? `<span class="sanad-ae__hint">${esc(__("{0} more — filter to find them", [fields.length - shown.length]))}</span>` : ""}
					</div>`
				: "";
			return `${vars}
				<textarea class="wa-textarea sanad-ae__msg" data-in="message" rows="5" dir="auto" placeholder="${esc(__("What the message says… e.g. Invoice {{ doc.name }} is ready"))}" aria-label="${esc(__("Message"))}">${esc(d.message)}</textarea>
				${this.opts.open_template ? `<div class="sanad-ne__tpl-actions"><button type="button" class="sanad-ae__link" data-act="tpl_from_text"${(d.message || "").trim() ? "" : " disabled"}>${sanad.ui.ico("cards", "xs")} ${esc(__("Save this text as a template"))}</button></div>` : ""}`;
		}

		// 3 — who --------------------------------------------------------------------------------------

		recipient_text(r) {
			if (r.recipient_type === "Document Field") return this.field_label(r.receiver_by_document_field);
			if (r.recipient_type === "Linked Document Field") return `${this.field_label(r.linked_document_field)} → ${r.linked_mobile_fieldname || ""}`;
			return this.ui.labels[`phone:${r.phone}`] || sanad.ui.phone(r.phone || "");
		}

		/** The open recipient's details (owner, 2026-10-08): what it is and where its number comes from. */
		who_detail_html() {
			const r = this.draft.recipients[this.ui.who_open];
			if (!r) return "";
			const m = RECIPIENT_META()[r.recipient_type] || RECIPIENT_META()["Fixed Number"];
			const rows = [[__("Recipient type"), esc(m.label)]];
			if (r.recipient_type === "Fixed Number") {
				const name = this.ui.labels[`phone:${r.phone}`];
				if (name) rows.push([__("Name"), `<span dir="auto">${esc(name)}</span>`]);
				rows.push([__("Number"), `<span dir="ltr">${esc(sanad.ui.phone(r.phone || ""))}</span>${sanad.ui.group_tag(r.phone)}`]);
			} else if (r.recipient_type === "Document Field") {
				rows.push([__("Number field"), esc(this.field_label(r.receiver_by_document_field))]);
				rows.push([__("Field name"), `<code dir="ltr">${esc(r.receiver_by_document_field || "")}</code>`]);
			} else {
				const link = this.fields("link_fields").find((f) => f.fieldname === r.linked_document_field);
				rows.push([__("Linked record field"), esc(this.field_label(r.linked_document_field))]);
				if (link && link.options) rows.push([__("Linked record type"), esc(__(link.options))]);
				rows.push([__("Number field on the linked record"), `<code dir="ltr">${esc(r.linked_mobile_fieldname || "")}</code>`]);
			}
			rows.push([__("Send condition"), r.condition ? `<code dir="ltr">${esc(r.condition)}</code>` : esc(__("Always"))]);
			return `<div class="sanad-ae__who-detail" id="sanad-ne-who-detail" role="region" aria-label="${esc(__("Recipient details"))}">
				<dl>${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>
			</div>`;
		}

		draw_who() {
			const d = this.draft;
			const meta = RECIPIENT_META();
			const chips = d.recipients
				.map((r, i) => {
					const m = meta[r.recipient_type] || meta["Fixed Number"];
					const label = this.recipient_text(r);
					const sub = r.recipient_type === "Fixed Number" && this.ui.labels[`phone:${r.phone}`] ? sanad.ui.phone(r.phone) : m.label;
					const open = this.ui.who_open === i;
					return `<li class="sanad-ae__who${open ? " is-open" : ""}">
						<button type="button" class="sanad-ae__who-open" data-act="r_open" data-i="${i}" aria-expanded="${open}" aria-controls="sanad-ne-who-detail" title="${esc(__("Show the details"))}">
							<span class="sanad-ae__who-ico" aria-hidden="true">${sanad.ui.ico(m.icon, "sm")}</span>
							<span class="sanad-ae__who-text"><strong dir="auto">${esc(label)}${r.recipient_type === "Fixed Number" ? sanad.ui.group_tag(r.phone) : ""}</strong><span dir="auto">${esc(sub)}${r.condition ? ` · ${esc(__("with a condition"))}` : ""}</span></span>
						</button>
						<button type="button" class="sanad-ae__icon sanad-ae__icon--sm" data-act="r_remove" data-i="${i}" aria-label="${esc(__("Remove {0}", [label]))}">${sanad.ui.ico("x", "sm")}</button>
					</li>`;
				})
				.join("");
			const type = this.ui.adder;
			const receivers = this.fields("phone_fields").concat(this.fields("link_fields").filter((f) => f.options === "Contact"));
			let adder = "";
			if (type === "Document Field")
				adder = d.document_type
					? `${this.select("add_doc_field", receivers, "", __("Choose the field with the number…"), __("Number field"))}`
					: `<p class="sanad-ae__hint">${esc(__("Choose the document type first."))}</p>`;
			else if (type === "Linked Document Field")
				adder = d.document_type
					? `<div class="sanad-ne__line">
						${this.select("add_link_field", this.fields("link_fields"), this.ui.link_field || "", __("Linked record field…"), __("Linked record field"))}
						<input type="text" class="wa-input wa-input--mono" data-in="link_mobile" dir="ltr" value="${esc(this.ui.link_mobile || "mobile_no")}" placeholder="mobile_no" aria-label="${esc(__("Number field on the linked record"))}">
						<button type="button" class="sanad-ae__btn" data-act="add_linked">${esc(__("Add"))}</button>
					</div>`
					: `<p class="sanad-ae__hint">${esc(__("Choose the document type first."))}</p>`;
			else
				adder = `<div class="sanad-ae__addline">
					<input type="tel" class="wa-input wa-input--mono" data-in="add_phone" dir="ltr" placeholder="9665…" aria-label="${esc(__("Number"))}">
					<button type="button" class="sanad-ae__btn" data-act="add_phone">${esc(__("Add"))}</button>
					${this.opts.pick_recipients ? `<button type="button" class="sanad-ae__btn sanad-ae__btn--pri" data-act="pick_contacts">${sanad.ui.ico("users", "sm")}${esc(__("Choose from contacts"))}</button>` : ""}
				</div>`;
			this.$root.find("[data-step=who]").html(`
				${this.step_head(3, __("Who gets it?"), d.recipients.length > 0)}
				<div class="sanad-ae__step-body">
					${d.recipients.length ? `<ul class="sanad-ae__whos">${chips}</ul>${this.who_detail_html()}` : `<p class="sanad-ae__empty">${esc(__("Nobody yet."))}</p>`}
					<div class="sanad-ae__field">
						${this.seg(
							"adder",
							Object.entries(meta).map(([value, m]) => ({ value, label: m.label, icon: m.icon })),
							type,
							__("Add a recipient")
						)}
						${adder}
					</div>
				</div>`);
		}

		add_recipient(row) {
			const d = this.draft;
			const same = (r) => r.recipient_type === row.recipient_type && r.receiver_by_document_field == row.receiver_by_document_field && r.linked_document_field == row.linked_document_field && r.phone == row.phone;
			if (d.recipients.some(same)) return false;
			d.recipients.push(Object.assign({ receiver_by_document_field: null, linked_document_field: null, linked_mobile_fieldname: null, phone: null, condition: null }, row));
			return true;
		}

		async pick_contacts() {
			if (!this.opts.pick_recipients) return;
			const d = this.draft;
			const existing = d.recipients.filter((r) => r.recipient_type === "Fixed Number").map((r) => r.phone);
			const rows = (await this.opts.pick_recipients({ existing })) || [];
			let added = 0;
			rows.forEach((row) => {
				const phone = row.phone_e164 || row.phone;
				if (!phone) return;
				if (this.add_recipient({ recipient_type: "Fixed Number", phone })) added += 1;
				if (row.display_name) this.ui.labels[`phone:${phone}`] = row.display_name;
			});
			if (added) {
				frappe.show_alert({ message: sanad.ui.plural(added, { one: __("{0} number added"), other: __("{0} numbers added") }), indicator: "green" });
				this.changed({ redraw: ["who"] });
			}
		}

		// 4 — from -------------------------------------------------------------------------------------

		draw_from() {
			const d = this.draft;
			const cfg = this.opts.device_link || {};
			const dev = (this.data.devices || []).find((x) => x.name === d.device);
			this.$root.find("[data-step=from]").html(`
				${this.step_head(4, __("From which device?"), !!d.device, d.device ? null : __("Without one, the default device sends it"))}
				<div class="sanad-ae__step-body">
					<div class="sanad-ae__device-link"></div>
					${
						dev
							? `<p class="sanad-ae__hint sanad-ae__device-state"><span class="sanad-ae__device-dot sanad-ae__device-dot--${dev.status === "Connected" ? "ok" : "warn"}"></span>${esc(__(dev.status))}${dev.phone_e164 ? ` · <span dir="ltr">${esc(dev.phone_e164)}</span>` : ""}</p>`
							: ""
					}
				</div>`);
			if (!cfg.doctype) return;
			const control = frappe.ui.form.make_control({
				df: {
					fieldtype: "Link",
					fieldname: "device",
					options: cfg.doctype,
					placeholder: cfg.placeholder || __("Choose a connected device…"),
					get_query: () => ({ filters: cfg.filters || {} }),
					change: () => {
						const v = control.get_value() || null;
						if (v === d.device) return;
						d.device = v;
						this.changed();
						this.draw_from();
					},
				},
				parent: this.$root.find("[data-step=from] .sanad-ae__device-link"),
				render_input: true,
				only_input: true,
			});
			control.refresh();
			if (d.device) control.set_value(d.device);
			if (control.$input) control.$input.attr("aria-label", __("Device"));
		}

		// (+) — afterwards -----------------------------------------------------------------------------

		draw_after() {
			const d = this.draft;
			this.$root.find("[data-step=after]").html(`
				<details class="sanad-ae__more sanad-ne__after"${d.set_property_after_alert ? " open" : ""}>
					<summary>${esc(__("Afterwards: set a field of the document (optional)"))}</summary>
					<div class="sanad-ne__line">
						${this.select("set_property_after_alert", this.fields("all_fields"), d.set_property_after_alert, __("No field"), __("Field to set"))}
						${d.set_property_after_alert ? `<span>${esc(__("to"))}</span><input type="text" class="wa-input" data-in="property_value" value="${esc(d.property_value)}" aria-label="${esc(__("Value to set"))}">` : ""}
					</div>
				</details>`);
		}

		// ---- the side: record, preview, test, history ---------------------------------------------

		draw_record() {
			const d = this.draft;
			const $s = this.$root.find("[data-slot=record]");
			if (!d.document_type) return $s.html("");
			$s.html(`<div class="sanad-ne__record">
				<span class="sanad-ae__sub">${esc(__("Tried on"))}</span>
				<div class="sanad-ne__record-link"></div>
			</div>`);
			const control = frappe.ui.form.make_control({
				df: {
					fieldtype: "Link",
					fieldname: "reference_name",
					options: d.document_type,
					placeholder: __("The latest {0}", [__(d.document_type)]),
					change: () => {
						const v = control.get_value() || null;
						if (v === this.ui.ref) return;
						this.ui.ref = v;
						this.ui.previewing = true;
						this.draw_status();
						this.run_preview();
					},
				},
				parent: $s.find(".sanad-ne__record-link"),
				render_input: true,
				only_input: true,
			});
			control.refresh();
			if (this.ui.ref) control.set_value(this.ui.ref);
			if (control.$input) control.$input.attr("aria-label", __("Record to try the notification on"));
		}

		draw_status() {
			const $s = this.$root.find("[data-slot=pv-status]");
			$s.toggleClass("is-busy", !!this.ui.previewing).text(this.ui.previewing ? __("Updating…") : __("Up to date"));
		}

		draw_preview() {
			const p = this.ui.preview;
			const d = this.draft;
			const dev = (this.data.devices || []).find((x) => x.name === d.device) || (this.data.devices || []).find((x) => cint(x.is_default)) || {};
			const first = p && p.recipients && p.recipients[0];
			let bubble;
			if (!p) bubble = `<div class="sanad-ae__bubble is-ghost">${sanad.ui.skeleton(2)}</div>`;
			else if (!d.document_type) bubble = `<p class="sanad-ae__pv-empty">${esc(__("Choose the document type to see the message."))}</p>`;
			else if (p.no_access) bubble = `<p class="sanad-ae__pv-empty">${esc(__("You cannot read {0} records, so there is nothing to try the message on. It still works when saved.", [__(d.document_type)]))}</p>`;
			else if (!p.reference_name) bubble = `<p class="sanad-ae__pv-empty">${esc(__("There is no {0} to try it on yet.", [__(d.document_type)]))}</p>`;
			else if (!p.message && !p.attachment) bubble = `<p class="sanad-ae__pv-empty">${esc(d.body_mode === "template" ? __("Choose a template to see the message.") : __("Write the message to see it here."))}</p>`;
			else {
				const a = p.attachment;
				const file = a
					? `<div class="sanad-ae__file"><span class="sanad-ae__file-ico" aria-hidden="true">${sanad.ui.ico(a.message_type === "Image" ? "image" : "doc", "md")}</span><span><strong dir="ltr">${esc(a.file_name || __("No file in this record"))}</strong><span>${esc(a.message_type === "Image" ? __("Image") : __("Document"))}${a.missing ? ` · ${esc(__("empty in this record"))}` : ""}</span></span></div>`
					: "";
				bubble = `<div class="sanad-ae__bubble">${file}${p.message ? `<div class="sanad-ae__bubble-text" dir="auto">${esc(p.message)}</div>` : ""}<span class="sanad-ae__bubble-time">${sanad.ui.ico("read", "xs")}</span></div>`;
			}
			const facts =
				p && p.reference_name
					? `<dl class="sanad-ae__facts">
						<div><dt>${esc(__("Record"))}</dt><dd dir="auto">${esc(p.reference_name)}</dd></div>
						<div><dt>${esc(__("Recipients"))}</dt><dd>${esc(sanad.ui.format_int(p.recipients_count || 0))}</dd></div>
					</dl>`
					: "";
			const notes = [];
			if (p && p.reference_name && p.meets_condition === false)
				notes.push(`<div class="sanad-ae__note sanad-ae__note--warn" role="status">${sanad.ui.ico("warn", "sm")}<span>${esc(__("The condition does not hold for this record, so nothing would be sent for it."))}</span></div>`);
			if (p && p.problem) notes.push(`<div class="sanad-ae__note sanad-ae__note--warn" role="status">${sanad.ui.ico("warn", "sm")}<span>${esc(p.problem)}</span></div>`);
			if (p && p.error) notes.push(`<div class="sanad-ae__note sanad-ae__note--danger" role="alert">${sanad.ui.ico("error", "sm")}<span>${esc(p.error)}</span></div>`);
			this.$root.find("[data-slot=preview]").html(`
				<div class="sanad-ae__side-head"><strong>${esc(__("Preview"))}</strong><span class="sanad-ae__status" data-slot="pv-status" aria-live="polite"></span></div>
				<div class="sanad-ae__phone">
					<div class="sanad-ae__phone-bar">
						<span class="sanad-ae__phone-av" aria-hidden="true">${sanad.ui.ico("whatsapp", "sm")}</span>
						<span><strong>${esc(dev.device_name || __("Device"))}</strong><span dir="ltr">${esc(first ? first.phone_e164 : __("to the first recipient"))}</span></span>
					</div>
					<div class="sanad-ae__chat">${bubble}</div>
				</div>
				${facts}
				${notes.join("")}`);
			this.draw_status();
		}

		draw_test() {
			if (!this.opts.send_test) return;
			this.$root.find("[data-slot=test]").html(`
				<div class="sanad-ae__test">
					<strong>${esc(__("Try it"))}</strong>
					<p>${esc(__("Sends this draft once to one number, for the record above — nothing is saved and the condition is not checked."))}</p>
					<div class="sanad-ae__addline">
						<div class="sanad-ae__test-phone" data-slot="test-phone"></div>
						<button type="button" class="sanad-ae__btn sanad-ae__btn--pri" data-act="test"${this.ui.testing ? " disabled" : ""}>${sanad.ui.ico("send", "sm")}${esc(this.ui.testing ? __("Sending…") : __("Send a test"))}</button>
					</div>
				</div>`);
			// The kit's phone field: its country opens on the site's default (WhatsApp Settings →
			// default country), so a local number takes that key without it being typed (owner,
			// 2026-10-08); a number written with its own key keeps it.
			new sanad.ui.PhoneField({
				wrapper: this.$root.find("[data-slot=test-phone]"),
				label: "",
				value: this.ui.test_phone,
				on_change: (v) => {
					this.ui.test_phone = (v && (v.phone_e164 || v.phone)) || "";
				},
			});
		}

		draw_history() {
			const s = this.data.stats || {};
			const recent = this.data.recent || [];
			if (!this.draft.name) return this.$root.find("[data-slot=history]").html("");
			const tone = { Read: "ok", Delivered: "ok", Sent: "info", Queued: "muted", Sending: "muted", Failed: "danger", Cancelled: "muted" };
			this.$root.find("[data-slot=history]").html(`
				<div class="sanad-ae__hist">
					<div class="sanad-ae__side-head"><strong>${esc(__("What it has done"))}</strong></div>
					<dl class="sanad-ae__facts">
						<div><dt>${esc(__("Sent"))}</dt><dd>${esc(sanad.ui.format_int(s.send_count || 0))}</dd></div>
						<div><dt>${esc(__("Last sent"))}</dt><dd>${esc(s.last_sent_at ? frappe.datetime.str_to_user(s.last_sent_at) : "—")}</dd></div>
					</dl>
					${s.last_error ? `<div class="sanad-ae__note sanad-ae__note--danger">${sanad.ui.ico("error", "sm")}<span>${esc(s.last_error)}</span></div>` : ""}
					${
						recent.length
							? `<ul class="sanad-ae__recent">${recent
									.map((r) => `<li><span dir="ltr">${esc(r.display_name || sanad.ui.phone(r.phone_e164))}</span>${sanad.ui.group_tag(r.phone_e164)}${sanad.ui.badge(__(r.status), tone[r.status] || "muted")}<time>${esc(frappe.datetime.comment_when(r.creation, true))}</time></li>`)
									.join("")}</ul>`
							: ""
					}
				</div>`);
		}

		draw_sentence() {
			const d = this.draft;
			const $s = this.$root.find("[data-slot=sentence]");
			if (!d.document_type) return $s.text(__("Choose what it is about, then what it says."));
			const ev = (EVENT_LABEL()[d.event] || __(d.event)).toLowerCase();
			const count = d.recipients.length;
			$s.text(
				[
					__("{0}: {1}", [__(d.document_type), ev]),
					d.cond_mode !== "none" ? __("with a condition") : null,
					count ? sanad.ui.plural(count, { one: __("{0} recipient"), other: __("{0} recipients") }) : null,
				]
					.filter(Boolean)
					.join(" · ")
			);
		}

		draw_head_state() {
			const d = this.draft;
			this.$root.find("[data-slot=dirty]").prop("hidden", !this.is_dirty());
			this.$root.find("[data-slot=enabled-label]").text(d.enabled ? __("On") : __("Off"));
		}

		draw_foot() {
			const d = this.draft;
			const p = this.ui.preview;
			const hint = p && p.problem ? p.problem : this.is_dirty() ? __("Changes are not saved yet") : d.name ? __("Saved") : "";
			this.$root.find("[data-slot=foot]").html(`
				${d.name && this.data.can_delete && this.opts.remove ? `<button type="button" class="sanad-ae__btn sanad-ae__btn--danger" data-act="delete">${sanad.ui.ico("trash", "sm")}${esc(__("Delete"))}</button>` : ""}
				<span class="sanad-ae__foot-hint${p && p.problem ? " is-warn" : ""}">${esc(hint)}</span>
				<button type="button" class="sanad-ae__btn" data-act="close">${esc(__("Cancel"))}</button>
				<button type="button" class="sanad-ae__btn sanad-ae__btn--pri" data-act="save"${(!this.is_dirty() && d.name) || this.ui.saving || !this.data.can_write ? " disabled" : ""}>${esc(this.ui.saving ? __("Saving…") : d.name ? __("Save") : __("Create notification"))}</button>`);
		}

		// ---- events --------------------------------------------------------------------------------

		on_act(e) {
			const $t = $(e.currentTarget);
			const act = $t.data("act");
			const value = $t.attr("data-value");
			const i = cint($t.attr("data-i"));
			const d = this.draft;
			switch (act) {
				case "close":
					return this.close();
				case "event":
					d.event = value;
					return this.changed({ redraw: ["when"] });
				case "cond":
					d.cond_mode = value;
					return this.changed({ redraw: ["when"] });
				case "body":
					d.body_mode = value;
					return this.changed({ redraw: ["what"] });
				case "attach":
					d.attach = value;
					return this.changed({ redraw: ["what"] });
				case "template":
					d.template = d.template === value ? null : value;
					this.draw_body();
					this.redraw_step_head("what");
					return this.changed();
				case "tpl_new":
					return this.open_template(null, { reference_doctype: d.document_type || null });
				case "tpl_edit":
					return this.open_template(d.template);
				case "tpl_from_text":
					return this.open_template(null, { reference_doctype: d.document_type || null, body: d.message, template_name: d.notification_name });
				case "var":
					return this.insert_var(value);
				case "unpick":
					d[$t.data("kind")] = null;
					this.ui.pick_open = $t.data("kind");
					this.ui.add_q = "";
					this.ui.results = [];
					this.changed({ redraw: ["when", "what"] });
					this.$root.find(`[data-in=pick_q][data-kind=${$t.data("kind")}]`).trigger("focus");
					return this.run_search();
				case "pick":
					return this.pick($t.data("kind"), this.ui.results[i]);
				case "adder":
					this.ui.adder = value;
					return this.draw_who();
				case "add_phone": {
					const phone = String(this.$root.find("[data-in=add_phone]").val() || "").trim();
					if (!phone) return this.$root.find("[data-in=add_phone]").trigger("focus");
					if (this.add_recipient({ recipient_type: "Fixed Number", phone })) this.changed({ redraw: ["who"] });
					return this.$root.find("[data-in=add_phone]").trigger("focus");
				}
				case "add_linked": {
					const field = this.ui.link_field;
					const mobile = (this.ui.link_mobile || "mobile_no").trim();
					if (!field) return frappe.show_alert({ message: __("Choose the linked record field first"), indicator: "orange" });
					if (this.add_recipient({ recipient_type: "Linked Document Field", linked_document_field: field, linked_mobile_fieldname: mobile })) this.changed({ redraw: ["who"] });
					return;
				}
				case "pick_contacts":
					return this.pick_contacts();
				case "r_open":
					this.ui.who_open = this.ui.who_open === i ? null : i;
					return this.draw_who();
				case "r_remove":
					d.recipients.splice(i, 1);
					this.ui.who_open = null;
					return this.changed({ redraw: ["who"] });
				case "test":
					return this.send_test();
				case "save":
					return this.save();
				case "delete":
					return this.remove();
			}
		}

		redraw_step_head(step) {
			const titles = { what: [2, __("What does it send?")] };
			const d = this.draft;
			const done = d.body_mode === "template" ? !!d.template : !!(d.message || "").trim();
			const [n, title] = titles[step];
			this.$root.find(`[data-step=${step}] > .sanad-ae__step-head`).replaceWith(this.step_head(n, title, done));
		}

		on_input(e) {
			const $t = $(e.currentTarget);
			const key = $t.data("in");
			const d = this.draft;
			const v = $t.val();
			switch (key) {
				case "notification_name":
					d.notification_name = v;
					return this.changed({ preview: false });
				case "message":
					d.message = v;
					this.$root.find("[data-act=tpl_from_text]").prop("disabled", !v.trim());
					this.redraw_step_head("what");
					return this.changed();
				case "condition":
					d.condition = v;
					return this.changed();
				case "days_in_advance":
					d.days_in_advance = cint(v);
					return this.changed({ redraw: [] });
				case "minutes_offset":
					d.minutes_offset = cint(v);
					return this.changed({ redraw: [] });
				case "property_value":
					d.property_value = v;
					return this.changed({ preview: false });
				case "var_q":
				case "tpl_q": {
					this.ui[key] = v;
					this.draw_body();
					const $in = this.$root.find(`[data-in=${key}]`).trigger("focus");
					const el = $in.get(0);
					if (el) el.selectionStart = el.selectionEnd = el.value.length;
					return;
				}
				case "link_mobile":
					this.ui.link_mobile = v;
					return;
				case "pick_q":
					this.ui.pick_open = $t.data("kind");
					this.ui.add_q = v;
					this.ui.searching = true;
					return this.search_later();
				case "test_phone":
					this.ui.test_phone = v;
					return;
			}
		}

		on_change(e) {
			const $t = $(e.currentTarget);
			const key = $t.data("ch");
			const d = this.draft;
			const v = $t.val();
			if (key === "enabled") {
				d.enabled = $t.is(":checked") ? 1 : 0;
				return this.changed({ preview: false });
			}
			if (["date_changed", "datetime_changed", "value_changed", "method"].includes(key)) {
				d[key] = v;
				return this.changed({ redraw: ["when"] });
			}
			if (key === "attach_field") {
				d.attach_field = v;
				return this.changed();
			}
			if (key === "set_property_after_alert") {
				d.set_property_after_alert = v;
				return this.changed({ redraw: ["after"], preview: false });
			}
			if (key === "add_doc_field") {
				if (v && this.add_recipient({ recipient_type: "Document Field", receiver_by_document_field: v })) this.changed({ redraw: ["who"] });
				return;
			}
			if (key === "add_link_field") {
				this.ui.link_field = v;
				return;
			}
		}

		on_key(e) {
			if (e.key === "Escape") {
				if (this.ui.pick_open) {
					e.stopPropagation();
					return this.close_pick();
				}
				if ($(".modal.show").length) return;
				e.stopPropagation();
				return this.close();
			}
			if (e.key === "Enter") {
				const $t = $(e.target);
				if ($t.is("[data-in=pick_q]") && this.ui.results.length) {
					e.preventDefault();
					return this.pick($t.data("kind"), this.ui.results[0]);
				}
				if ($t.is("[data-in=test_phone]")) {
					e.preventDefault();
					return this.send_test();
				}
				if ($t.is("[data-in=add_phone]")) {
					e.preventDefault();
					return this.$root.find("[data-act=add_phone]").trigger("click");
				}
			}
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
				e.preventDefault();
				return this.save();
			}
			if (e.key === "ArrowDown" && $(e.target).is("[data-in=pick_q]")) {
				e.preventDefault();
				this.$root.find(".sanad-ae__opt").first().trigger("focus");
			}
		}

		// ---- actions -------------------------------------------------------------------------------

		close_pick() {
			const kind = this.ui.pick_open;
			this.ui.pick_open = null;
			this.ui.results = [];
			this.$root.find(`[data-in=pick_q][data-kind=${kind}]`).attr("aria-expanded", "false").siblings(".sanad-ae__results").remove();
		}

		async run_search() {
			const kind = this.ui.pick_open;
			if (!kind) return;
			const q = this.ui.add_q;
			try {
				const rows = await this.opts.search(kind, q, this.draft.document_type);
				if (this.ui.pick_open !== kind || this.ui.add_q !== q) return;
				this.ui.results = rows || [];
			} catch (err) {
				this.ui.results = [];
			}
			this.ui.searching = false;
			const $pick = this.$root.find(`[data-in=pick_q][data-kind=${kind}]`).closest(".sanad-ae__pick");
			$pick.find(".sanad-ae__results").remove();
			$pick.append(this.results_html(kind));
			$pick.find("input").attr("aria-expanded", "true");
		}

		async pick(kind, row) {
			if (!row) return;
			const d = this.draft;
			this.ui.pick_open = null;
			this.ui.results = [];
			this.ui.add_q = "";
			d[kind] = row.value;
			this.ui.labels[`${kind}:${row.value}`] = row.description;
			if (kind !== "document_type") return this.changed({ redraw: ["what"] });
			// a new document type brings its own fields and templates; what pointed at the old one goes
			Object.assign(d, { date_changed: "", datetime_changed: "", value_changed: "", attach_field: "", set_property_after_alert: "", print_format: null, filters: [] });
			d.recipients = d.recipients.filter((r) => r.recipient_type === "Fixed Number");
			if (d.template && !(this.data.templates || []).some((t) => t.name === d.template && !t.reference_doctype)) d.template = null;
			this.ui.ref = null;
			if (!d.notification_name.trim()) {
				d.notification_name = __("{0} notification", [row.label]);
				this.$root.find("[data-in=notification_name]").val(d.notification_name);
			}
			await this.load_setup();
			this.changed({ redraw: ["when", "what", "who", "after", "record"] });
		}

		insert_var(fieldname) {
			const code = `{{ doc.${fieldname} }}`;
			const el = this.$root.find("[data-in=message]").get(0);
			if (!el) return;
			const start = el.selectionStart ?? el.value.length;
			const end = el.selectionEnd ?? el.value.length;
			el.value = el.value.slice(0, start) + code + el.value.slice(end);
			el.focus();
			el.selectionStart = el.selectionEnd = start + code.length;
			this.draft.message = el.value;
			this.redraw_step_head("what");
			this.changed();
		}

		/** The host's template editor, on a saved template or a new one with `defaults`; a saved one is chosen. */
		open_template(name, defaults) {
			if (!this.opts.open_template) return;
			this.opts.open_template(name, {
				defaults,
				on_saved: async (r) => {
					if (!r || r.deleted) {
						if (r && r.deleted && r.name === this.draft.template) this.draft.template = null;
					} else {
						this.draft.template = r.name;
						this.draft.body_mode = "template";
					}
					await this.load_setup();
					this.changed({ redraw: ["what"] });
				},
			});
		}

		async run_preview() {
			if (!this.draft) return;
			const seq = (this.preview_seq = (this.preview_seq || 0) + 1);
			this.ui.previewing = true;
			this.draw_status();
			try {
				const result = await this.opts.preview(this.payload(), this.ui.ref);
				if (seq !== this.preview_seq) return;
				this.ui.preview = result || {};
			} catch (err) {
				if (seq !== this.preview_seq) return;
				this.ui.preview = { problem: err && err.message ? err.message : __("The preview could not run") };
			}
			this.ui.previewing = false;
			this.draw_preview();
			this.draw_foot();
		}

		async send_test() {
			const phone = (this.ui.test_phone || "").trim();
			if (!phone) {
				this.$root.find("[data-in=test_phone]").trigger("focus");
				return frappe.show_alert({ message: __("Enter the number to send the test to"), indicator: "orange" });
			}
			this.ui.testing = true;
			this.draw_test();
			try {
				const r = await this.opts.send_test(this.payload(), phone, this.ui.ref || (this.ui.preview && this.ui.preview.reference_name) || null);
				frappe.show_alert({ message: __("Test sent to {0}", [sanad.ui.phone(r && r.phone_e164 ? r.phone_e164 : phone)]), indicator: "green" });
			} catch (err) {
				frappe.show_alert({ message: err && err.message ? err.message : __("The test could not be sent"), indicator: "red" });
			}
			this.ui.testing = false;
			this.draw_test();
		}

		async save() {
			if (this.ui.saving || !this.data.can_write) return;
			const d = this.draft;
			if (!d.notification_name.trim()) {
				this.$root.find("[data-in=notification_name]").trigger("focus");
				return frappe.show_alert({ message: __("Name the notification first"), indicator: "orange" });
			}
			this.ui.saving = true;
			this.draw_foot();
			try {
				const r = await this.opts.save(this.payload());
				const was_new = !d.name;
				frappe.show_alert({ message: was_new ? __("Notification created") : __("Notification saved"), indicator: "green" });
				this.opts.on_saved && this.opts.on_saved(r);
				this.data = await this.opts.load(r.name);
				this.draft = this.seed(this.data.notification);
				this.clean = JSON.stringify(this.draft);
				this.ui.saving = false;
				this.render();
				this.run_preview();
			} catch (err) {
				this.ui.saving = false;
				this.draw_foot();
				frappe.show_alert({ message: err && err.message ? err.message : __("Could not save"), indicator: "red" });
			}
		}

		remove() {
			const d = this.draft;
			frappe.confirm(__("Delete {0}? The messages it already sent stay in the log.", [d.notification_name]), async () => {
				try {
					await this.opts.remove(d.name);
					frappe.show_alert({ message: __("Notification deleted"), indicator: "green" });
					this.opts.on_saved && this.opts.on_saved({ name: d.name, deleted: true });
					this.close(true);
				} catch (err) {
					frappe.show_alert({ message: err && err.message ? err.message : __("Could not delete"), indicator: "red" });
				}
			});
		}
	}

	sanad.ui.NotificationEditor = NotificationEditor;
})();

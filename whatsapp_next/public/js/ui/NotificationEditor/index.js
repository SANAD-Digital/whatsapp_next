// whatsapp.ui.NotificationEditor — one window to create, edit and try a document notification: a
// WhatsApp message that goes out when something happens to a record (created, submitted, a field
// changes, N days before a date…). The same anatomy as the AlertEditor, its cards and its preview
// (the two windows share `whatsapp-kit-alert-editor` styling), answering four short questions:
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
// see README.md. Colours are the product tokens (`--whatsapp-*`); offsets are logical, so RTL needs nothing.

frappe.provide("whatsapp.ui");

(function () {
	const escape_html = (v) => whatsapp.ui.escape(v == null ? "" : v);
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
			this.build_editor_layer();
			this.load_notification(opts.name || null);
		}

		// ---- shell ---------------------------------------------------------------------------------

		build_editor_layer() {
			this.id = whatsapp.ui.unique_dom_id("whatsapp-kit-notification-editor");
			this.previous_focus = document.activeElement;
			this.$root = $(`
				<div class="whatsapp-kit whatsapp-kit-alert-editor-layer" role="presentation">
					<div class="whatsapp-kit-alert-editor-backdrop" data-act="close"></div>
					<div class="whatsapp-kit-alert-editor whatsapp-kit-notification-editor" role="dialog" aria-modal="true" aria-labelledby="${this.id}-title">
						<div class="whatsapp-kit-alert-editor__loading">${escape_html(__("Loading…"))}</div>
					</div>
				</div>`).appendTo(document.body);
			this.$dlg = this.$root.find(".whatsapp-kit-alert-editor");
			$("body").addClass("whatsapp-kit-alert-editor-open");
			this.$root.on("click", "[data-act]", (e) => this.on_act(e));
			// a Link drop-down that opens near the bottom (the device picker) is brought into view by
			// scrolling the column it is in; the window itself never scrolls (owner, 2026-11-10)
			this.$root.on("awesomplete-open", "input", (e) => {
				const list = e.target.parentElement && e.target.parentElement.querySelector("ul");
				if (list) window.requestAnimationFrame(() => list.scrollIntoView({ block: "nearest" }));
			});
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
				if (this.ui.pick_open && !$(e.target).closest(".whatsapp-kit-alert-editor__pick").length) this.close_pick();
			});
			this.untrap = whatsapp.ui.trap_focus(this.$root);
			this.refresh_preview = whatsapp.ui.debounce(() => this.run_preview(), 600);
			this.search_later = whatsapp.ui.debounce(() => this.run_search(), 250);
		}

		close(force = false) {
			if (!force && this.is_dirty()) {
				frappe.confirm(__("Discard unsaved changes?"), () => this.close(true));
				return;
			}
			this.untrap && this.untrap();
			if (!$(".whatsapp-kit-alert-editor-layer").not(this.$root).length) $("body").removeClass("whatsapp-kit-alert-editor-open");
			this.$root.remove();
			if (this.previous_focus && this.previous_focus.focus) this.previous_focus.focus();
			this.opts.on_close && this.opts.on_close();
		}

		async load_notification(name) {
			try {
				this.data = await this.opts.load(name);
				this.draft = this.build_draft_from_notification(this.data.notification);
				this.clean = JSON.stringify(this.draft);
				this.ui.test_phone = whatsapp.ui.test_phone.get() || (this.data.me && this.data.me.phone) || "";
				if (this.draft.document_type) this.ui.labels[`document_type:${this.draft.document_type}`] = null;
				this.render();
				if (!this.draft.name) this.$root.find("[data-in=notification_name]").trigger("focus");
				this.run_preview();
			} catch (err) {
				this.$dlg.html(`
					<div class="whatsapp-kit-alert-editor__loading" role="alert">
						<span>${escape_html(err && err.message ? err.message : __("Something went wrong. Please try again."))}</span>
						<button type="button" class="whatsapp-kit-alert-editor__button" data-act="close">${escape_html(__("Close"))}</button>
					</div>`);
			}
		}

		build_draft_from_notification(n) {
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
				attach_to_document: cint(n.attach_to_document) ? 1 : 0,
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
			const draft = this.draft;
			const attach_field = this.attach_fields().find((f) => f.fieldname === draft.attach_field);
			const out = {
				notification_name: draft.notification_name,
				enabled: draft.enabled,
				document_type: draft.document_type,
				event: draft.event,
				date_changed: DAY_EVENTS.includes(draft.event) ? draft.date_changed || null : null,
				days_in_advance: DAY_EVENTS.includes(draft.event) ? draft.days_in_advance : 0,
				datetime_changed: MINUTE_EVENTS.includes(draft.event) ? draft.datetime_changed || null : null,
				minutes_offset: MINUTE_EVENTS.includes(draft.event) ? draft.minutes_offset : 0,
				value_changed: draft.event === "Value Change" ? draft.value_changed || null : null,
				method: draft.event === "Method" ? draft.method || null : null,
				condition_type: draft.cond_mode === "python" ? "Python" : "Filters",
				filters: draft.cond_mode === "filters" && draft.filters.length ? draft.filters : null,
				condition: draft.cond_mode === "python" ? (draft.condition || "").trim() || null : null,
				device: draft.device,
				template: draft.body_mode === "template" ? draft.template : null,
				// a written text stays on the record under a template, so switching back loses nothing
				message: draft.message || null,
				message_type: draft.attach === "print" ? "Document" : draft.attach === "field" ? (attach_field && attach_field.fieldtype === "Attach Image" ? "Image" : "Document") : "Text",
				attach_print: draft.attach === "print" ? 1 : 0,
				print_format: draft.attach === "print" ? draft.print_format : null,
				letter_head: draft.attach === "print" ? draft.letter_head : null,
				attach_to_document: draft.attach === "print" && draft.attach_to_document ? 1 : 0,
				attach_field: draft.attach === "field" ? draft.attach_field || null : null,
				set_property_after_alert: draft.set_property_after_alert || null,
				property_value: draft.set_property_after_alert ? draft.property_value : null,
				recipients: draft.recipients,
			};
			if (draft.name) out.name = draft.name;
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

		document_fields_of_kind(kind) {
			return ((this.data.fields || {})[kind] || []).slice();
		}

		attach_fields() {
			return this.document_fields_of_kind("all_fields").filter((f) => ["Attach", "Attach Image"].includes(f.fieldtype));
		}

		field_label(fieldname) {
			const f = this.document_fields_of_kind("all_fields").find((x) => x.fieldname === fieldname);
			return f ? __(f.label) : fieldname;
		}

		select(key, rows, value, placeholder, label) {
			const opts = rows.map((r) => `<option value="${escape_html(r.fieldname)}"${r.fieldname === value ? " selected" : ""}>${escape_html(__(r.label))}</option>`);
			if (value && !rows.some((r) => r.fieldname === value)) opts.push(`<option value="${escape_html(value)}" selected>${escape_html(value)}</option>`);
			return `<select class="whatsapp-select" data-ch="${escape_html(key)}" aria-label="${escape_html(label || placeholder)}"><option value="">${escape_html(placeholder)}</option>${opts.join("")}</select>`;
		}

		async load_setup() {
			const document_type = this.draft.document_type;
			if (!document_type) {
				this.data.fields = null;
				this.data.templates = [];
				return;
			}
			try {
				const r = await this.opts.setup(document_type);
				if (this.draft.document_type !== document_type) return;
				this.data.fields = r.fields;
				this.data.templates = r.templates || [];
			} catch (err) {
				this.data.fields = null;
				frappe.show_alert({ message: err && err.message ? escape_html(err.message) : __("Could not read the document type"), indicator: "red" });
			}
		}

		// ---- render --------------------------------------------------------------------------------

		render() {
			const draft = this.draft;
			this.$dlg.html(`
				<header class="whatsapp-kit-alert-editor__head">
					<span class="whatsapp-kit-alert-editor__mark" aria-hidden="true">${whatsapp.ui.inline_icon_html("bolt", "md")}</span>
					<div class="whatsapp-kit-alert-editor__heading">
						<h2 id="${this.id}-title" class="sr-only">${escape_html(draft.name ? __("Edit notification") : __("New notification"))}</h2>
						<input type="text" class="whatsapp-kit-alert-editor__name" data-in="notification_name" data-whatsapp-bare maxlength="140"
							value="${escape_html(draft.notification_name)}" placeholder="${escape_html(__("Name this notification…"))}" aria-label="${escape_html(__("Notification name"))}">
						<p class="whatsapp-kit-alert-editor__sentence" data-slot="sentence"></p>
					</div>
					<span class="whatsapp-kit-alert-editor__dirty" data-slot="dirty" hidden>${escape_html(__("Not saved"))}</span>
					<label class="whatsapp-toggle whatsapp-kit-alert-editor__enabled" title="${escape_html(__("The notification sends only when it is on"))}">
						<input type="checkbox" data-ch="enabled" ${draft.enabled ? "checked" : ""}>
						<span class="whatsapp-toggle__track"></span>
						<span class="whatsapp-toggle__label" data-slot="enabled-label"></span>
					</label>
					${this.opts.form_doctype && draft.name ? whatsapp.ui.form_button_html() : ""}
					<button type="button" class="whatsapp-kit-alert-editor__icon" data-act="close" aria-label="${escape_html(__("Close"))}" title="${escape_html(__("Close (Esc)"))}">${whatsapp.ui.inline_icon_html("x", "md")}</button>
				</header>
				<div class="whatsapp-kit-alert-editor__main">
					<div class="whatsapp-kit-alert-editor__build">
						<section class="whatsapp-kit-alert-editor__step" data-step="when"></section>
						<section class="whatsapp-kit-alert-editor__step" data-step="what"></section>
						<section class="whatsapp-kit-alert-editor__step" data-step="who"></section>
						<section class="whatsapp-kit-alert-editor__step" data-step="from"></section>
						<section class="whatsapp-kit-alert-editor__step" data-step="after"></section>
					</div>
					<aside class="whatsapp-kit-alert-editor__side" aria-label="${escape_html(__("Preview"))}">
						<div data-slot="record"></div>
						<div data-slot="preview"></div>
						<div data-slot="test"></div>
						<div data-slot="history"></div>
					</aside>
				</div>
				<footer class="whatsapp-kit-alert-editor__foot" data-slot="foot"></footer>`);
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
				<header class="whatsapp-kit-alert-editor__step-head">
					<span class="whatsapp-kit-alert-editor__number${done ? " is-done" : ""}" aria-hidden="true">${done ? whatsapp.ui.inline_icon_html("tick", "sm") : n}</span>
					<span class="whatsapp-kit-alert-editor__step-title"><strong>${escape_html(title)}</strong>${note ? `<span>${escape_html(note)}</span>` : ""}</span>
					<span class="sr-only">${escape_html(done ? __("Complete") : __("Not complete yet"))}</span>
				</header>`;
		}

		toggle_chip_html(label, { act, value, on, disabled, title } = {}) {
			return `<button type="button" class="whatsapp-kit-alert-editor__chip${on ? " is-on" : ""}" data-act="${escape_html(act)}" data-value="${escape_html(value)}" aria-pressed="${on ? "true" : "false"}"${disabled ? " disabled" : ""}${title ? ` title="${escape_html(title)}"` : ""}>${escape_html(label)}</button>`;
		}

		segmented_control_html(act, options, value, label) {
			return `<div class="whatsapp-segmented whatsapp-kit-alert-editor__segment" role="radiogroup" aria-label="${escape_html(label)}">${options
				.map(
					(o) =>
						`<button type="button" class="whatsapp-segmented__option" role="radio" aria-checked="${o.value === value}" data-act="${escape_html(act)}" data-value="${escape_html(o.value)}"${o.disabled ? " disabled" : ""}${o.title ? ` title="${escape_html(o.title)}"` : ""}>${o.icon ? whatsapp.ui.inline_icon_html(o.icon, "xs") : ""}<span>${escape_html(o.label)}</span></button>`
				)
				.join("")}</div>`;
		}

		/** A searchable single-value picker: the value as a chip, or a search field with results. */
		picker(kind, value, placeholder, label, description) {
			if (value) {
				return `<div class="whatsapp-kit-alert-editor__picked">
					<span class="whatsapp-kit-alert-editor__picked-text"><strong>${escape_html(label || value)}</strong>${description ? `<span>${escape_html(description)}</span>` : ""}</span>
					<button type="button" class="whatsapp-kit-alert-editor__link" data-act="unpick" data-kind="${escape_html(kind)}">${escape_html(__("Change"))}</button>
				</div>`;
			}
			const open = this.ui.pick_open === kind;
			return `<div class="whatsapp-kit-alert-editor__pick">
				<span class="whatsapp-kit-alert-editor__pick-icon" aria-hidden="true">${whatsapp.ui.inline_icon_html("search", "sm")}</span>
				<input type="search" class="whatsapp-input" data-in="pick_q" data-kind="${escape_html(kind)}" autocomplete="off" placeholder="${escape_html(placeholder)}" aria-label="${escape_html(placeholder)}" aria-expanded="${open}" value="${open ? escape_html(this.ui.add_q) : ""}">
				${open ? this.results_html(kind) : ""}
			</div>`;
		}

		results_html(kind) {
			const rows = this.ui.results || [];
			return `<div class="whatsapp-kit-alert-editor__results" role="listbox">${
				rows.length
					? rows
							.map(
								(r, i) =>
									`<button type="button" role="option" class="whatsapp-kit-alert-editor__option" data-act="pick" data-kind="${escape_html(kind)}" data-i="${i}"><strong>${escape_html(r.label)}</strong>${r.description ? `<span>${escape_html(r.description)}</span>` : ""}</button>`
							)
							.join("")
					: `<p class="whatsapp-kit-alert-editor__none">${escape_html(this.ui.searching ? __("Searching…") : __("Nothing matches"))}</p>`
			}</div>`;
		}

		// 1 — when -------------------------------------------------------------------------------------

		when_done() {
			const draft = this.draft;
			if (!draft.document_type || !draft.event) return false;
			if (DAY_EVENTS.includes(draft.event)) return !!draft.date_changed;
			if (MINUTE_EVENTS.includes(draft.event)) return !!draft.datetime_changed;
			if (draft.event === "Value Change") return !!draft.value_changed;
			if (draft.event === "Method") return !!draft.method;
			return true;
		}

		draw_when() {
			const draft = this.draft;
			const labels = EVENT_LABEL();
			const known = this.data.options.event || [];
			const chips = (events) =>
				events.filter((e) => known.includes(e)).map((e) => this.toggle_chip_html(labels[e] || __(e), { act: "event", value: e, on: draft.event === e, disabled: !draft.document_type })).join("");
			let detail = "";
			if (draft.document_type && DAY_EVENTS.includes(draft.event)) {
				detail = `<div class="whatsapp-kit-notification-editor__line">
					<input type="number" min="0" class="whatsapp-input whatsapp-input--mono whatsapp-kit-notification-editor__number" data-in="days_in_advance" value="${escape_html(draft.days_in_advance)}" aria-label="${escape_html(__("Days"))}">
					<span>${escape_html(draft.event === "Days Before" ? __("days before") : __("days after"))}</span>
					${this.select("date_changed", this.document_fields_of_kind("date_fields"), draft.date_changed, __("Choose a date field…"), __("Date field"))}
				</div>`;
			} else if (draft.document_type && MINUTE_EVENTS.includes(draft.event)) {
				detail = `<div class="whatsapp-kit-notification-editor__line">
					<input type="number" min="0" class="whatsapp-input whatsapp-input--mono whatsapp-kit-notification-editor__number" data-in="minutes_offset" value="${escape_html(draft.minutes_offset)}" aria-label="${escape_html(__("Minutes"))}">
					<span>${escape_html(draft.event === "Minutes Before" ? __("minutes before") : __("minutes after"))}</span>
					${this.select("datetime_changed", this.document_fields_of_kind("datetime_fields"), draft.datetime_changed, __("Choose a date and time field…"), __("Date and time field"))}
				</div>`;
			} else if (draft.document_type && draft.event === "Value Change") {
				detail = `<div class="whatsapp-kit-notification-editor__line"><span>${escape_html(__("When this field changes"))}</span>${this.select("value_changed", this.document_fields_of_kind("all_fields"), draft.value_changed, __("Choose a field…"), __("Field"))}</div>`;
			} else if (draft.document_type && draft.event === "Method") {
				const methods = (this.data.options.method || []).map((m) => ({ fieldname: m, label: m }));
				detail = `<div class="whatsapp-kit-notification-editor__line"><span>${escape_html(__("On the document event"))}</span>${this.select("method", methods, draft.method, __("Choose an event…"), __("Document event"))}</div>`;
			}
			const condition_mode = draft.cond_mode;
			this.$root.find("[data-step=when]").html(`
				${this.step_head(1, __("When is it sent?"), this.when_done())}
				<div class="whatsapp-kit-alert-editor__step-body">
					<div class="whatsapp-kit-alert-editor__field">
						<span class="whatsapp-kit-alert-editor__label">${escape_html(__("Document type"))}</span>
						${this.picker("document_type", draft.document_type, __("Search document types…"), draft.document_type ? __(draft.document_type) : null, this.ui.labels[`document_type:${draft.document_type}`])}
					</div>
					<fieldset class="whatsapp-kit-notification-editor__block"${draft.document_type ? "" : " disabled"}>
						<legend class="whatsapp-kit-alert-editor__label">${escape_html(__("Send it when"))}</legend>
						<div class="whatsapp-kit-notification-editor__group">
							<span class="whatsapp-kit-notification-editor__group-label">${escape_html(__("Something happens to it"))}</span>
							<div class="whatsapp-kit-alert-editor__chips">${chips(["New", "Save", "Submit", "Cancel", "Value Change"])}</div>
						</div>
						<div class="whatsapp-kit-notification-editor__group">
							<span class="whatsapp-kit-notification-editor__group-label">${escape_html(__("On a schedule"))}</span>
							<div class="whatsapp-kit-alert-editor__chips">${chips(["Days Before", "Days After", "Minutes Before", "Minutes After"])}</div>
						</div>
						${
							draft.event === "Method"
								? `<div class="whatsapp-kit-notification-editor__group"><span class="whatsapp-kit-notification-editor__group-label">${escape_html(__("Other"))}</span><div class="whatsapp-kit-alert-editor__chips">${chips(["Method"])}</div></div>`
								: `<button type="button" class="whatsapp-kit-alert-editor__link whatsapp-kit-notification-editor__other" data-act="event" data-value="Method"${draft.document_type ? "" : " disabled"}>${escape_html(__("Another document event…"))}</button>`
						}
						${detail}
						${draft.document_type ? "" : `<p class="whatsapp-kit-alert-editor__hint">${escape_html(__("Choose the document type first."))}</p>`}
					</fieldset>
					<fieldset class="whatsapp-kit-notification-editor__block"${draft.document_type ? "" : " disabled"}>
						<div class="whatsapp-kit-alert-editor__field-line">
							<legend class="whatsapp-kit-alert-editor__label">${escape_html(__("For which records?"))}</legend>
							${this.segmented_control_html(
								"cond",
								[
									{ value: "none", label: __("Every record") },
									{ value: "filters", label: __("Matching filters"), icon: "table" },
									{ value: "python", label: __("An expression"), icon: "code" },
								],
								condition_mode,
								__("Condition")
							)}
						</div>
						${
							condition_mode === "filters"
								? `<div class="whatsapp-kit-notification-editor__field-group"></div><p class="whatsapp-kit-alert-editor__hint">${escape_html(__("Only records that match every filter get the message, as in a list's filters."))}</p>`
								: condition_mode === "python"
									? `<textarea class="whatsapp-textarea whatsapp-input--mono whatsapp-kit-notification-editor__code" data-in="condition" rows="2" dir="ltr" spellcheck="false" placeholder="doc.grand_total > 1000" aria-label="${escape_html(__("Condition"))}">${escape_html(draft.condition)}</textarea>
										<p class="whatsapp-kit-alert-editor__hint">${escape_html(__("A Python expression over doc; the message goes out only when it is true."))}</p>`
									: ""
						}
					</fieldset>
				</div>`);
			if (condition_mode === "filters" && draft.document_type) this.draw_filters();
		}

		/** Frappe's own filter component on the document type, as its Notification's "Filters" condition. */
		draw_filters() {
			const draft = this.draft;
			const $fg = this.$root.find("[data-step=when] .whatsapp-kit-notification-editor__field-group");
			const document_type = draft.document_type;
			frappe.model.with_doctype(document_type, () => {
				if (this.draft.document_type !== document_type || !$fg.closest("body").length) return;
				try {
					this.fg = new frappe.ui.FilterGroup({
						parent: $fg,
						doctype: document_type,
						on_change: () => {
							draft.filters = this.fg.get_filters().map((f) => f.slice(0, 4));
							this.changed();
						},
					});
					this.fg.wrapper.find(".apply-filters").hide();
					this.fg.add_filters_to_filter_group(draft.filters || []);
				} catch (e) {
					$fg.html(`<p class="whatsapp-kit-alert-editor__hint">${escape_html(__("The filters could not be shown for this document type."))}</p>`);
				}
			});
		}

		// 2 — what -------------------------------------------------------------------------------------

		draw_what() {
			const draft = this.draft;
			const done = draft.body_mode === "template" ? !!draft.template : !!(draft.message || "").trim();
			const attach_fields = this.attach_fields();
			this.$root.find("[data-step=what]").html(`
				${this.step_head(2, __("What does it send?"), done)}
				<div class="whatsapp-kit-alert-editor__step-body">
					<div class="whatsapp-kit-alert-editor__field">
						<div class="whatsapp-kit-alert-editor__field-line">
							<span class="whatsapp-kit-alert-editor__label">${escape_html(__("Message"))}</span>
							${this.segmented_control_html(
								"body",
								[
									{ value: "template", label: __("From a template"), icon: "cards" },
									{ value: "custom", label: __("Written here"), icon: "note" },
								],
								draft.body_mode,
								__("Message source")
							)}
						</div>
						<div data-slot="body"></div>
					</div>
					<div class="whatsapp-kit-alert-editor__field">
						<span class="whatsapp-kit-alert-editor__label">${escape_html(__("Attach"))}</span>
						${this.segmented_control_html(
							"attach",
							[
								{ value: "none", label: __("Nothing") },
								{ value: "print", label: __("A print of the document"), icon: "doc", disabled: !draft.document_type },
								{ value: "field", label: __("A file in the document"), icon: "attach", disabled: !attach_fields.length, title: attach_fields.length ? "" : __("The document type has no attachment field") },
							],
							draft.attach,
							__("Attachment")
						)}
						${
							draft.attach === "print"
								? `<div class="whatsapp-kit-alert-editor__columns">
									<div class="whatsapp-kit-alert-editor__field"><span class="whatsapp-kit-alert-editor__label">${escape_html(__("Print format"))}</span>${this.picker("print_format", draft.print_format, __("Default"), draft.print_format)}</div>
									<div class="whatsapp-kit-alert-editor__field"><span class="whatsapp-kit-alert-editor__label">${escape_html(__("Letter head"))}</span>${this.picker("letter_head", draft.letter_head, __("None"), draft.letter_head)}</div>
								</div>
								<label class="whatsapp-toggle whatsapp-kit-alert-editor__keep">
									<input type="checkbox" data-ch="attach_to_document" ${draft.attach_to_document ? "checked" : ""}>
									<span class="whatsapp-toggle__track"></span>
									<span class="whatsapp-toggle__label">${escape_html(__("Keep the sent file on the document"))}</span>
								</label>
								<p class="whatsapp-kit-alert-editor__hint">${escape_html(__("Off: the printed file is kept with the sent message only, and the document's attachments stay as they were."))}</p>`
								: draft.attach === "field"
									? this.select("attach_field", attach_fields, draft.attach_field, __("Choose the field that holds the file…"), __("Attachment field"))
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
			const draft = this.draft;
			return whatsapp.ui.template_cards({
				templates: this.data.templates,
				chosen: draft.template,
				query: this.ui.tpl_q,
				can_open: !!this.opts.open_template,
				new_note: draft.document_type ? __("Written for {0}", [__(draft.document_type)]) : __("Opens the template editor"),
				empty_note: draft.document_type
					? __("No template is written for {0} yet. Create one, or write the message here.", [__(draft.document_type)])
					: __("Choose the document type to see its templates."),
			});
		}

		/** The message written here, with the document's fields as insertable variables. */
		write_html() {
			const draft = this.draft;
			const q = this.ui.var_q.trim().toLowerCase();
			const fields = this.document_fields_of_kind("all_fields").filter((f) => !q || `${__(f.label)} ${f.fieldname}`.toLowerCase().includes(q));
			const shown = fields.slice(0, VAR_LIMIT);
			const vars = draft.document_type
				? `<div class="whatsapp-kit-notification-editor__variables-bar">
						<span class="whatsapp-kit-alert-editor__subtitle">${escape_html(__("Insert a field of the document"))}</span>
						<input type="search" class="whatsapp-input whatsapp-kit-notification-editor__filter" data-in="var_q" value="${escape_html(this.ui.var_q)}" placeholder="${escape_html(__("Filter fields…"))}" aria-label="${escape_html(__("Filter fields"))}">
					</div>
					<div class="whatsapp-kit-alert-editor__variables" role="group" aria-label="${escape_html(__("Insert a variable"))}">
						${shown.map((f) => `<button type="button" class="whatsapp-kit-alert-editor__variable" data-act="var" data-value="${escape_html(f.fieldname)}" title="{{ doc.${escape_html(f.fieldname)} }}">${whatsapp.ui.inline_icon_html("plus", "xs")}${escape_html(__(f.label))}</button>`).join("")}
						${fields.length > shown.length ? `<span class="whatsapp-kit-alert-editor__hint">${escape_html(__("{0} more — filter to find them", [fields.length - shown.length]))}</span>` : ""}
					</div>`
				: "";
			return `${vars}
				<textarea class="whatsapp-textarea whatsapp-kit-alert-editor__message" data-in="message" rows="5" dir="auto" placeholder="${escape_html(__("What the message says… e.g. Invoice {{ doc.name }} is ready"))}" aria-label="${escape_html(__("Message"))}">${escape_html(draft.message)}</textarea>
				${this.opts.open_template ? `<div class="whatsapp-kit-notification-editor__template-actions"><button type="button" class="whatsapp-kit-alert-editor__link" data-act="tpl_from_text"${(draft.message || "").trim() ? "" : " disabled"}>${whatsapp.ui.inline_icon_html("cards", "xs")} ${escape_html(__("Save this text as a template"))}</button></div>` : ""}`;
		}

		// 3 — who --------------------------------------------------------------------------------------

		recipient_text(r) {
			if (r.recipient_type === "Document Field") return this.field_label(r.receiver_by_document_field);
			if (r.recipient_type === "Linked Document Field") return `${this.field_label(r.linked_document_field)} → ${r.linked_mobile_fieldname || ""}`;
			return this.ui.labels[`phone:${r.phone}`] || whatsapp.ui.phone(r.phone || "");
		}

		/** The open recipient's details (owner, 2026-10-08): what it is and where its number comes from. */
		who_detail_html() {
			const recipient = this.draft.recipients[this.ui.who_open];
			if (!recipient) return "";
			const m = RECIPIENT_META()[recipient.recipient_type] || RECIPIENT_META()["Fixed Number"];
			const rows = [[__("Recipient type"), escape_html(m.label)]];
			if (recipient.recipient_type === "Fixed Number") {
				const name = this.ui.labels[`phone:${recipient.phone}`];
				if (name) rows.push([__("Name"), `<span dir="auto">${escape_html(name)}</span>`]);
				rows.push([__("Number"), `<span dir="ltr">${escape_html(whatsapp.ui.phone(recipient.phone || ""))}</span>${whatsapp.ui.group_tag(recipient.phone)}`]);
			} else if (recipient.recipient_type === "Document Field") {
				rows.push([__("Number field"), escape_html(this.field_label(recipient.receiver_by_document_field))]);
				rows.push([__("Field name"), `<code dir="ltr">${escape_html(recipient.receiver_by_document_field || "")}</code>`]);
			} else {
				const link = this.document_fields_of_kind("link_fields").find((f) => f.fieldname === recipient.linked_document_field);
				rows.push([__("Linked record field"), escape_html(this.field_label(recipient.linked_document_field))]);
				if (link && link.options) rows.push([__("Linked record type"), escape_html(__(link.options))]);
				rows.push([__("Number field on the linked record"), `<code dir="ltr">${escape_html(recipient.linked_mobile_fieldname || "")}</code>`]);
			}
			rows.push([__("Send condition"), recipient.condition ? `<code dir="ltr">${escape_html(recipient.condition)}</code>` : escape_html(__("Always"))]);
			return `<div class="whatsapp-kit-alert-editor__who-detail" id="whatsapp-kit-notification-editor-who-detail" role="region" aria-label="${escape_html(__("Recipient details"))}">
				<dl>${rows.map(([k, v]) => `<div><dt>${escape_html(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>
			</div>`;
		}

		draw_who() {
			const draft = this.draft;
			const meta = RECIPIENT_META();
			const chips = draft.recipients
				.map((r, i) => {
					const m = meta[r.recipient_type] || meta["Fixed Number"];
					const label = this.recipient_text(r);
					const sub = r.recipient_type === "Fixed Number" && this.ui.labels[`phone:${r.phone}`] ? whatsapp.ui.phone(r.phone) : m.label;
					const open = this.ui.who_open === i;
					return `<li class="whatsapp-kit-alert-editor__who${open ? " is-open" : ""}">
						<button type="button" class="whatsapp-kit-alert-editor__who-open" data-act="r_open" data-i="${i}" aria-expanded="${open}" aria-controls="whatsapp-kit-notification-editor-who-detail" title="${escape_html(__("Show the details"))}">
							<span class="whatsapp-kit-alert-editor__who-icon" aria-hidden="true">${whatsapp.ui.inline_icon_html(m.icon, "sm")}</span>
							<span class="whatsapp-kit-alert-editor__who-text"><strong dir="auto">${escape_html(label)}${r.recipient_type === "Fixed Number" ? whatsapp.ui.group_tag(r.phone) : ""}</strong><span dir="auto">${escape_html(sub)}${r.condition ? ` · ${escape_html(__("with a condition"))}` : ""}</span></span>
						</button>
						<button type="button" class="whatsapp-kit-alert-editor__icon whatsapp-kit-alert-editor__icon--sm" data-act="r_remove" data-i="${i}" aria-label="${escape_html(__("Remove {0}", [label]))}">${whatsapp.ui.inline_icon_html("x", "sm")}</button>
					</li>`;
				})
				.join("");
			const type = this.ui.adder;
			const receivers = this.document_fields_of_kind("phone_fields").concat(this.document_fields_of_kind("link_fields").filter((f) => f.options === "Contact"));
			let adder = "";
			if (type === "Document Field")
				adder = draft.document_type
					? `${this.select("add_doc_field", receivers, "", __("Choose the field with the number…"), __("Number field"))}`
					: `<p class="whatsapp-kit-alert-editor__hint">${escape_html(__("Choose the document type first."))}</p>`;
			else if (type === "Linked Document Field")
				adder = draft.document_type
					? `<div class="whatsapp-kit-notification-editor__line">
						${this.select("add_link_field", this.document_fields_of_kind("link_fields"), this.ui.link_field || "", __("Linked record field…"), __("Linked record field"))}
						<input type="text" class="whatsapp-input whatsapp-input--mono" data-in="link_mobile" dir="ltr" value="${escape_html(this.ui.link_mobile || "mobile_no")}" placeholder="mobile_no" aria-label="${escape_html(__("Number field on the linked record"))}">
						<button type="button" class="whatsapp-kit-alert-editor__button" data-act="add_linked">${escape_html(__("Add"))}</button>
					</div>`
					: `<p class="whatsapp-kit-alert-editor__hint">${escape_html(__("Choose the document type first."))}</p>`;
			else
				adder = `<div class="whatsapp-kit-alert-editor__add-line">
					<input type="tel" class="whatsapp-input whatsapp-input--mono" data-in="add_phone" dir="ltr" placeholder="${escape_html(whatsapp.ui.PhoneField.example(null, { format: false }).replace("+", ""))}" aria-label="${escape_html(__("Number"))}">
					<button type="button" class="whatsapp-kit-alert-editor__button" data-act="add_phone">${escape_html(__("Add"))}</button>
					${this.opts.pick_recipients ? `<button type="button" class="whatsapp-kit-alert-editor__button whatsapp-kit-alert-editor__button--primary" data-act="pick_contacts">${whatsapp.ui.inline_icon_html("users", "sm")}${escape_html(__("Choose from contacts"))}</button>` : ""}
				</div>`;
			this.$root.find("[data-step=who]").html(`
				${this.step_head(3, __("Who gets it?"), draft.recipients.length > 0)}
				<div class="whatsapp-kit-alert-editor__step-body">
					${draft.recipients.length ? `<ul class="whatsapp-kit-alert-editor__recipient-chips">${chips}</ul>${this.who_detail_html()}` : `<p class="whatsapp-kit-alert-editor__empty">${escape_html(__("Nobody yet."))}</p>`}
					<div class="whatsapp-kit-alert-editor__field">
						${this.segmented_control_html(
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
			const draft = this.draft;
			const is_same_recipient = (r) => r.recipient_type === row.recipient_type && r.receiver_by_document_field == row.receiver_by_document_field && r.linked_document_field == row.linked_document_field && r.phone == row.phone;
			if (draft.recipients.some(is_same_recipient)) return false;
			draft.recipients.push(Object.assign({ receiver_by_document_field: null, linked_document_field: null, linked_mobile_fieldname: null, phone: null, condition: null }, row));
			return true;
		}

		async pick_contacts() {
			if (!this.opts.pick_recipients) return;
			const draft = this.draft;
			const existing = draft.recipients.filter((r) => r.recipient_type === "Fixed Number").map((r) => r.phone);
			const rows = (await this.opts.pick_recipients({ existing })) || [];
			let added = 0;
			rows.forEach((row) => {
				const phone = row.phone_e164 || row.phone;
				if (!phone) return;
				if (this.add_recipient({ recipient_type: "Fixed Number", phone })) added += 1;
				if (row.display_name) this.ui.labels[`phone:${phone}`] = row.display_name;
			});
			if (added) {
				frappe.show_alert({ message: whatsapp.ui.plural(added, { one: __("{0} number added"), other: __("{0} numbers added") }), indicator: "green" });
				this.changed({ redraw: ["who"] });
			}
		}

		// 4 — from -------------------------------------------------------------------------------------

		draw_from() {
			const draft = this.draft;
			const cfg = this.opts.device_link || {};
			const dev = (this.data.devices || []).find((x) => x.name === draft.device);
			this.$root.find("[data-step=from]").html(`
				${this.step_head(4, __("From which device?"), !!draft.device, draft.device ? null : __("Without one, the default device sends it"))}
				<div class="whatsapp-kit-alert-editor__step-body">
					<div class="whatsapp-kit-alert-editor__device-link"></div>
					${
						dev
							? `<p class="whatsapp-kit-alert-editor__hint whatsapp-kit-alert-editor__device-state"><span class="whatsapp-kit-alert-editor__device-dot whatsapp-kit-alert-editor__device-dot--${dev.status === "Connected" ? "ok" : "warn"}"></span>${escape_html(__(dev.status))}${dev.phone_e164 ? ` · <span dir="ltr">${escape_html(dev.phone_e164)}</span>` : ""}</p>`
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
						if (v === draft.device) return;
						draft.device = v;
						this.changed();
						this.draw_from();
					},
				},
				parent: this.$root.find("[data-step=from] .whatsapp-kit-alert-editor__device-link"),
				render_input: true,
				only_input: true,
			});
			control.refresh();
			if (draft.device) control.set_value(draft.device);
			if (control.$input) control.$input.attr("aria-label", __("Device"));
		}

		// (+) — afterwards -----------------------------------------------------------------------------

		draw_after() {
			const draft = this.draft;
			this.$root.find("[data-step=after]").html(`
				<details class="whatsapp-kit-alert-editor__more whatsapp-kit-notification-editor__after"${draft.set_property_after_alert ? " open" : ""}>
					<summary>${escape_html(__("Afterwards: set a field of the document (optional)"))}</summary>
					<div class="whatsapp-kit-notification-editor__line">
						${this.select("set_property_after_alert", this.document_fields_of_kind("all_fields"), draft.set_property_after_alert, __("No field"), __("Field to set"))}
						${draft.set_property_after_alert ? `<span>${escape_html(__("to"))}</span><input type="text" class="whatsapp-input" data-in="property_value" value="${escape_html(draft.property_value)}" aria-label="${escape_html(__("Value to set"))}">` : ""}
					</div>
				</details>`);
		}

		// ---- the side: record, preview, test, history ---------------------------------------------

		draw_record() {
			const draft = this.draft;
			const $s = this.$root.find("[data-slot=record]");
			if (!draft.document_type) return $s.html("");
			// "Create PDF" sits with the record it prints (owner, 2026-11-10), whatever the message attaches
			$s.html(`<div class="whatsapp-kit-notification-editor__record">
				<div class="whatsapp-kit-notification-editor__record-head">
					<span class="whatsapp-kit-alert-editor__subtitle">${escape_html(__("Tried on"))}</span>
					${this.opts.make_file ? `<button type="button" class="whatsapp-kit-alert-editor__button whatsapp-kit-notification-editor__record-pdf" data-act="make_file">${whatsapp.ui.inline_icon_html("doc", "sm")}<span class="whatsapp-kit-notification-editor__record-pdf-label">${escape_html(__("Create PDF"))}</span></button>` : ""}
				</div>
				<div class="whatsapp-kit-notification-editor__record-link"></div>
			</div>`);
			const control = frappe.ui.form.make_control({
				df: {
					fieldtype: "Link",
					fieldname: "reference_name",
					options: draft.document_type,
					placeholder: __("The latest {0}", [__(draft.document_type)]),
					change: () => {
						const v = control.get_value() || null;
						if (v === this.ui.ref) return;
						this.ui.ref = v;
						this.ui.previewing = true;
						this.draw_status();
						this.run_preview();
					},
				},
				parent: $s.find(".whatsapp-kit-notification-editor__record-link"),
				render_input: true,
				only_input: true,
			});
			control.refresh();
			this.record_control = control;
			if (this.ui.ref) control.set_value(this.ui.ref);
			if (control.$input) control.$input.attr("aria-label", __("Record to try the notification on"));
		}

		draw_status() {
			const $s = this.$root.find("[data-slot=pv-status]");
			$s.toggleClass("is-busy", !!this.ui.previewing).text(this.ui.previewing ? __("Updating…") : __("Up to date"));
		}

		draw_preview() {
			const preview = this.ui.preview;
			const draft = this.draft;
			const dev = (this.data.devices || []).find((x) => x.name === draft.device) || (this.data.devices || []).find((x) => cint(x.is_default)) || {};
			const first = preview && preview.recipients && preview.recipients[0];
			let bubble;
			if (!preview) bubble = `<div class="whatsapp-kit-alert-editor__bubble is-ghost">${whatsapp.ui.skeleton(2)}</div>`;
			else if (!draft.document_type) bubble = `<p class="whatsapp-kit-alert-editor__preview-empty">${escape_html(__("Choose the document type to see the message."))}</p>`;
			else if (preview.no_access) bubble = `<p class="whatsapp-kit-alert-editor__preview-empty">${escape_html(__("You cannot read {0} records, so there is nothing to try the message on. It still works when saved.", [__(draft.document_type)]))}</p>`;
			else if (!preview.reference_name) bubble = `<p class="whatsapp-kit-alert-editor__preview-empty">${escape_html(__("There is no {0} to try it on yet.", [__(draft.document_type)]))}</p>`;
			else if (!preview.message && !preview.attachment) bubble = `<p class="whatsapp-kit-alert-editor__preview-empty">${escape_html(draft.body_mode === "template" ? __("Choose a template to see the message.") : __("Write the message to see it here."))}</p>`;
			else {
				const attachment = preview.attachment;
				const file = attachment
					? `<div class="whatsapp-kit-alert-editor__file"><span class="whatsapp-kit-alert-editor__file-icon" aria-hidden="true">${whatsapp.ui.inline_icon_html(attachment.message_type === "Image" ? "image" : "doc", "md")}</span><span><strong dir="ltr">${escape_html(attachment.file_name || __("No file in this record"))}</strong><span>${escape_html(attachment.message_type === "Image" ? __("Image") : __("Document"))}${attachment.image_if_one_page ? ` · ${escape_html(__("sent as an image when it is one page"))}` : ""}${attachment.missing ? ` · ${escape_html(__("empty in this record"))}` : ""}</span></span></div>`
					: "";
				bubble = `<div class="whatsapp-kit-alert-editor__bubble">${file}${preview.message ? `<div class="whatsapp-kit-alert-editor__bubble-text" dir="auto">${escape_html(preview.message)}</div>` : ""}<span class="whatsapp-kit-alert-editor__bubble-time">${whatsapp.ui.inline_icon_html("read", "xs")}</span></div>`;
			}
			const facts =
				preview && preview.reference_name
					? `<dl class="whatsapp-kit-alert-editor__facts">
						<div><dt>${escape_html(__("Record"))}</dt><dd dir="auto">${escape_html(preview.reference_name)}</dd></div>
						<div><dt>${escape_html(__("Recipients"))}</dt><dd>${escape_html(whatsapp.ui.format_integer(preview.recipients_count || 0))}</dd></div>
					</dl>`
					: "";
			const notes = [];
			if (preview && preview.reference_name && preview.meets_condition === false)
				notes.push(`<div class="whatsapp-kit-alert-editor__note whatsapp-kit-alert-editor__note--warn" role="status">${whatsapp.ui.inline_icon_html("warn", "sm")}<span>${escape_html(__("The condition does not hold for this record, so nothing would be sent for it."))}</span></div>`);
			if (preview && preview.problem) notes.push(`<div class="whatsapp-kit-alert-editor__note whatsapp-kit-alert-editor__note--warn" role="status">${whatsapp.ui.inline_icon_html("warn", "sm")}<span>${escape_html(preview.problem)}</span></div>`);
			if (preview && preview.error) notes.push(`<div class="whatsapp-kit-alert-editor__note whatsapp-kit-alert-editor__note--danger" role="alert">${whatsapp.ui.inline_icon_html("error", "sm")}<span>${escape_html(preview.error)}</span></div>`);
			this.$root.find("[data-slot=preview]").html(`
				<div class="whatsapp-kit-alert-editor__side-head"><strong>${escape_html(__("Preview"))}</strong><span class="whatsapp-kit-alert-editor__status" data-slot="pv-status" aria-live="polite"></span></div>
				<div class="whatsapp-kit-alert-editor__phone">
					<div class="whatsapp-kit-alert-editor__phone-bar">
						<span class="whatsapp-kit-alert-editor__phone-avatar" aria-hidden="true">${whatsapp.ui.inline_icon_html("whatsapp", "sm")}</span>
						<span><strong>${escape_html(dev.device_name || __("Device"))}</strong><span dir="ltr">${escape_html(first ? first.phone_e164 : __("to the first recipient"))}</span></span>
					</div>
					<div class="whatsapp-kit-alert-editor__chat">${bubble}</div>
				</div>
				${facts}
				${notes.join("")}`);
			this.draw_status();
		}

		draw_test() {
			if (!this.opts.send_test) return;
			this.$root.find("[data-slot=test]").html(`
				<div class="whatsapp-kit-alert-editor__test">
					<strong>${escape_html(__("Try it"))}</strong>
					<p>${escape_html(__("Sends this draft once to one number, for the record above — nothing is saved and the condition is not checked."))}</p>
					<div class="whatsapp-kit-alert-editor__add-line">
						<div class="whatsapp-kit-alert-editor__test-phone" data-slot="test-phone"></div>
						<button type="button" class="whatsapp-kit-alert-editor__button whatsapp-kit-alert-editor__button--primary" data-act="test"${this.ui.testing ? " disabled" : ""}>${whatsapp.ui.inline_icon_html("send", "sm")}${escape_html(this.ui.testing ? __("Sending…") : __("Send a test"))}</button>
					</div>
				</div>`);
			// The kit's phone field: its country opens on the site's own (Global Defaults → Country),
			// so a local number takes that key without it being typed (owner, 2026-10-08 and
			// 2026-11-09); a number written with its own key keeps it.
			new whatsapp.ui.PhoneField({
				wrapper: this.$root.find("[data-slot=test-phone]"),
				label: "",
				value: this.ui.test_phone,
				on_change: (v) => {
					this.ui.test_phone = (v && (v.phone_e164 || v.phone)) || "";
				},
			});
		}

		/** The same "What it has done" panel as the alert editor's, drawn by its code. */
		draw_history() {
			return whatsapp.ui.AlertEditor.prototype.draw_history.call(this);
		}

		draw_sentence() {
			const draft = this.draft;
			const $s = this.$root.find("[data-slot=sentence]");
			if (!draft.document_type) return $s.text(__("Choose what it is about, then what it says."));
			const ev = (EVENT_LABEL()[draft.event] || __(draft.event)).toLowerCase();
			const count = draft.recipients.length;
			$s.text(
				[
					__("{0}: {1}", [__(draft.document_type), ev]),
					draft.cond_mode !== "none" ? __("with a condition") : null,
					count ? whatsapp.ui.plural(count, { one: __("{0} recipient"), other: __("{0} recipients") }) : null,
				]
					.filter(Boolean)
					.join(" · ")
			);
		}

		draw_head_state() {
			const draft = this.draft;
			this.$root.find("[data-slot=dirty]").prop("hidden", !this.is_dirty());
			this.$root.find("[data-slot=enabled-label]").text(draft.enabled ? __("On") : __("Off"));
		}

		draw_foot() {
			const draft = this.draft;
			const preview = this.ui.preview;
			const hint = preview && preview.problem ? preview.problem : this.is_dirty() ? __("Changes are not saved yet") : draft.name ? __("Saved") : "";
			this.$root.find("[data-slot=foot]").html(`
				${draft.name && this.data.can_delete && this.opts.remove ? `<button type="button" class="whatsapp-kit-alert-editor__button whatsapp-kit-alert-editor__button--danger" data-act="delete">${whatsapp.ui.inline_icon_html("trash", "sm")}${escape_html(__("Delete"))}</button>` : ""}
				<span class="whatsapp-kit-alert-editor__foot-hint${preview && preview.problem ? " is-warn" : ""}">${escape_html(hint)}</span>
				<button type="button" class="whatsapp-kit-alert-editor__button" data-act="close">${escape_html(__("Cancel"))}</button>
				<button type="button" class="whatsapp-kit-alert-editor__button whatsapp-kit-alert-editor__button--primary" data-act="save"${(!this.is_dirty() && draft.name) || this.ui.saving || !this.data.can_write ? " disabled" : ""}>${escape_html(this.ui.saving ? __("Saving…") : draft.name ? __("Save") : __("Create notification"))}</button>`);
		}

		// ---- events --------------------------------------------------------------------------------

		on_act(e) {
			const $t = $(e.currentTarget);
			const act = $t.data("act");
			const value = $t.attr("data-value");
			const i = cint($t.attr("data-i"));
			const draft = this.draft;
			switch (act) {
				case "close":
					return this.close();
				case "open_form":
					return whatsapp.ui.open_form(this, this.opts.form_doctype, this.draft && this.draft.name);
				case "event":
					draft.event = value;
					return this.changed({ redraw: ["when"] });
				case "cond":
					draft.cond_mode = value;
					return this.changed({ redraw: ["when"] });
				case "body":
					draft.body_mode = value;
					return this.changed({ redraw: ["what"] });
				case "attach":
					draft.attach = value;
					return this.changed({ redraw: ["what"] });
				case "make_file":
					return this.make_file();
				case "template":
					// the second click of a double click opens the card to edit (owner, 2026-11-10); the
					// cards are redrawn after each click, so a `dblclick` would not reach them
					if (e.originalEvent && e.originalEvent.detail === 2) return this.edit_template(value);
					draft.template = draft.template === value ? null : value;
					this.draw_body();
					this.redraw_step_head("what");
					return this.changed();
				case "tpl_new":
					return this.open_template(null, { reference_doctype: draft.document_type || null });
				case "tpl_edit":
					return this.open_template(draft.template);
				case "tpl_from_text":
					return this.open_template(null, { reference_doctype: draft.document_type || null, body: draft.message, template_name: draft.notification_name });
				case "var":
					return this.insert_var(value);
				case "unpick":
					draft[$t.data("kind")] = null;
					this.ui.pick_open = $t.data("kind");
					this.ui.add_q = "";
					this.ui.results = [];
					this.changed({ redraw: ["when", "what"] });
					this.$root.find(`[data-in=pick_q][data-kind=${$t.data("kind")}]`).trigger("focus");
					return this.run_search();
				case "pick":
					return this.apply_picked_result($t.data("kind"), this.ui.results[i]);
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
					draft.recipients.splice(i, 1);
					this.ui.who_open = null;
					return this.changed({ redraw: ["who"] });
				case "test":
					return this.send_test();
				case "save":
					return this.save_notification();
				case "delete":
					return this.delete_notification();
			}
		}

		redraw_step_head(step) {
			const titles = { what: [2, __("What does it send?")] };
			const draft = this.draft;
			const done = draft.body_mode === "template" ? !!draft.template : !!(draft.message || "").trim();
			const [n, title] = titles[step];
			this.$root.find(`[data-step=${step}] > .whatsapp-kit-alert-editor__step-head`).replaceWith(this.step_head(n, title, done));
		}

		on_input(e) {
			const $t = $(e.currentTarget);
			const key = $t.data("in");
			const draft = this.draft;
			const v = $t.val();
			switch (key) {
				case "notification_name":
					draft.notification_name = v;
					return this.changed({ preview: false });
				case "message":
					draft.message = v;
					this.$root.find("[data-act=tpl_from_text]").prop("disabled", !v.trim());
					this.redraw_step_head("what");
					return this.changed();
				case "condition":
					draft.condition = v;
					return this.changed();
				case "days_in_advance":
					draft.days_in_advance = cint(v);
					return this.changed({ redraw: [] });
				case "minutes_offset":
					draft.minutes_offset = cint(v);
					return this.changed({ redraw: [] });
				case "property_value":
					draft.property_value = v;
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
			const draft = this.draft;
			const v = $t.val();
			if (key === "attach_to_document") {
				draft.attach_to_document = $t.is(":checked") ? 1 : 0;
				return this.changed({ preview: false });
			}
			if (key === "enabled") {
				draft.enabled = $t.is(":checked") ? 1 : 0;
				return this.changed({ preview: false });
			}
			if (["date_changed", "datetime_changed", "value_changed", "method"].includes(key)) {
				draft[key] = v;
				return this.changed({ redraw: ["when"] });
			}
			if (key === "attach_field") {
				draft.attach_field = v;
				return this.changed();
			}
			if (key === "set_property_after_alert") {
				draft.set_property_after_alert = v;
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
					return this.apply_picked_result($t.data("kind"), this.ui.results[0]);
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
				return this.save_notification();
			}
			if (e.key === "ArrowDown" && $(e.target).is("[data-in=pick_q]")) {
				e.preventDefault();
				this.$root.find(".whatsapp-kit-alert-editor__option").first().trigger("focus");
			}
		}

		// ---- actions -------------------------------------------------------------------------------

		close_pick() {
			const kind = this.ui.pick_open;
			this.ui.pick_open = null;
			this.ui.results = [];
			this.$root.find(`[data-in=pick_q][data-kind=${kind}]`).attr("aria-expanded", "false").siblings(".whatsapp-kit-alert-editor__results").remove();
		}

		async run_search() {
			const kind = this.ui.pick_open;
			if (!kind) return;
			const add_query = this.ui.add_q;
			try {
				const rows = await this.opts.search(kind, add_query, this.draft.document_type);
				if (this.ui.pick_open !== kind || this.ui.add_q !== add_query) return;
				this.ui.results = rows || [];
			} catch (err) {
				this.ui.results = [];
			}
			this.ui.searching = false;
			const $pick = this.$root.find(`[data-in=pick_q][data-kind=${kind}]`).closest(".whatsapp-kit-alert-editor__pick");
			$pick.find(".whatsapp-kit-alert-editor__results").remove();
			$pick.append(this.results_html(kind));
			$pick.find("input").attr("aria-expanded", "true");
		}

		async apply_picked_result(kind, row) {
			if (!row) return;
			const draft = this.draft;
			this.ui.pick_open = null;
			this.ui.results = [];
			this.ui.add_q = "";
			draft[kind] = row.value;
			this.ui.labels[`${kind}:${row.value}`] = row.description;
			if (kind !== "document_type") return this.changed({ redraw: ["what"] });
			// a new document type brings its own fields and templates; what pointed at the old one goes
			Object.assign(draft, { date_changed: "", datetime_changed: "", value_changed: "", attach_field: "", set_property_after_alert: "", print_format: null, filters: [] });
			draft.recipients = draft.recipients.filter((r) => r.recipient_type === "Fixed Number");
			if (draft.template && !(this.data.templates || []).some((t) => t.name === draft.template && !t.reference_doctype)) draft.template = null;
			this.ui.ref = null;
			if (!draft.notification_name.trim()) {
				draft.notification_name = __("{0} notification", [row.label]);
				this.$root.find("[data-in=notification_name]").val(draft.notification_name);
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
		/** "Create PDF": the record the preview is tried on, printed with the draft's print format and
		 * letter head (the default ones when it attaches no print), opened in a new tab. The tab opens in this click, before the server answers (later it would be
		 * blocked as a pop-up). */
		make_file() {
			if (!this.opts.make_file || this.ui.making) return;
			// what the field shows now: Frappe's Link control reports a pick only once it is left and
			// checked, so a press right after picking read the record before it (owner, 2026-11-10)
			const $in = this.record_control && this.record_control.$input;
			const typed = $in ? String($in.val() || "").trim() : "";
			const ref = typed || this.ui.ref || (this.ui.preview && this.ui.preview.reference_name) || null;
			const $btn = this.$root.find('[data-act="make_file"]');
			const set_file_button_busy = (on) => {
				this.ui.making = on;
				// the label only: the icon is a <span> too
				$btn.prop("disabled", on).attr("aria-busy", on ? "true" : null).find(".whatsapp-kit-notification-editor__record-pdf-label").text(on ? __("Making the file…") : __("Create PDF"));
			};
			set_file_button_busy(true);
			return whatsapp.ui
				.open_file_in_tab(() => this.opts.make_file(this.payload(), ref))
				.catch((err) => whatsapp.ui.Toast.error(err))
				.finally(() => set_file_button_busy(false));
		}

		/** A double-clicked card is the one used (its first click may have toggled it off), and opens. */
		edit_template(name) {
			if (!name || !this.opts.open_template) return;
			if (this.draft.template !== name) {
				this.draft.template = name;
				this.draw_body();
				this.redraw_step_head("what");
				this.changed();
			}
			this.open_template(name);
		}

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
				whatsapp.ui.test_phone.set(r && r.phone_e164 ? r.phone_e164 : phone);
				frappe.show_alert({ message: __("Test sent to {0}", [whatsapp.ui.phone(r && r.phone_e164 ? r.phone_e164 : phone)]), indicator: "green" });
			} catch (err) {
				frappe.show_alert({ message: err && err.message ? escape_html(err.message) : __("The test could not be sent"), indicator: "red" });
			}
			this.ui.testing = false;
			this.draw_test();
		}

		async save_notification() {
			if (this.ui.saving || !this.data.can_write) return;
			const draft = this.draft;
			if (!draft.notification_name.trim()) {
				this.$root.find("[data-in=notification_name]").trigger("focus");
				return frappe.show_alert({ message: __("Name the notification first"), indicator: "orange" });
			}
			this.ui.saving = true;
			this.draw_foot();
			try {
				const r = await this.opts.save(this.payload());
				const was_new = !draft.name;
				frappe.show_alert({ message: was_new ? __("Notification created") : __("Notification saved"), indicator: "green" });
				this.opts.on_saved && this.opts.on_saved(r);
				this.data = await this.opts.load(r.name);
				this.draft = this.build_draft_from_notification(this.data.notification);
				this.clean = JSON.stringify(this.draft);
				this.ui.saving = false;
				this.render();
				this.run_preview();
			} catch (err) {
				this.ui.saving = false;
				this.draw_foot();
				frappe.show_alert({ message: err && err.message ? escape_html(err.message) : __("Could not save"), indicator: "red" });
			}
		}

		delete_notification() {
			const draft = this.draft;
			frappe.confirm(__("Delete {0}? The messages it already sent stay in the log.", [escape_html(draft.notification_name)]), async () => {
				try {
					await this.opts.remove(draft.name);
					frappe.show_alert({ message: __("Notification deleted"), indicator: "green" });
					this.opts.on_saved && this.opts.on_saved({ name: draft.name, deleted: true });
					this.close(true);
				} catch (err) {
					frappe.show_alert({ message: err && err.message ? escape_html(err.message) : __("Could not delete"), indicator: "red" });
				}
			});
		}
	}

	whatsapp.ui.NotificationEditor = NotificationEditor;
})();

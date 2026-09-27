// sanad.ui.TemplateEditor — a live Jinja preview mounted into any form with a template body
// field: a variables sidebar (from `templates.list_variables`, click inserts `{{ name }}` at the
// caret of the body control — Ace editor, textarea or plain input), a sample-record picker
// (Link control on the reference DocType + "Use latest" via `templates.pick_sample`) and a
// debounced preview pane (`templates.preview` → `{body, errors[]}`, errors announced with
// role="alert"). Field names are options; nothing about the host DocType is hard-coded.

import ui from "../_core/index.js";

const DEFAULT_API = {
	preview: "templates.preview",
	variables: "templates.list_variables",
	sample: "templates.pick_sample",
};

sanad.ui.TemplateEditor = class TemplateEditor {
	/**
	 * @param {Object} opts
	 * @param {Object} opts.frm — the form (`frappe.ui.form.Form`)
	 * @param {string} [opts.body_field="body"] — Jinja body field (Code / Text / Small Text / Data)
	 * @param {string} [opts.reference_doctype_field="reference_doctype"] — Link to DocType (may be absent)
	 * @param {string} [opts.sample_field="sample_context"] — JSON field with extra context (may be absent)
	 * @param {string} [opts.preview_field] — an HTML field to mount into (default: after the body field)
	 * @param {number} [opts.debounce=400] — ms between keystrokes and the preview call
	 * @param {Object} [opts.api] — key overrides `{preview, variables, sample}`
	 */
	constructor(opts = {}) {
		this.opts = Object.assign(
			{ body_field: "body", reference_doctype_field: "reference_doctype", sample_field: "sample_context", debounce: 400 },
			opts
		);
		this.api = Object.assign({}, DEFAULT_API, opts.api || {});
		this.frm = this.opts.frm;
		if (!this.frm) throw new Error(__("TemplateEditor needs a form"));
		this.id = ui.uid("tpl");
		this.reference_name = null;
		this.variables = [];
		this.schedule_preview = ui.debounce(() => this.preview(), this.opts.debounce);
		this.make();
		sanad.ui.TemplateEditor.bind_form_events(this.frm.doctype, this.opts);
		this.refresh();
	}

	/** Mount once per form and refresh on later calls (use from `refresh(frm)`). */
	static mount(opts = {}) {
		const frm = opts.frm;
		if (!frm) return null;
		if (frm.__sanad_template_editor && document.contains(frm.__sanad_template_editor.$root.get(0))) {
			return frm.__sanad_template_editor.refresh();
		}
		frm.__sanad_template_editor = new sanad.ui.TemplateEditor(opts);
		return frm.__sanad_template_editor;
	}

	/** Route the form's field events to the mounted editor (registered once per DocType). */
	static bind_form_events(doctype, opts) {
		const bound = (sanad.ui.TemplateEditor._bound = sanad.ui.TemplateEditor._bound || {});
		if (bound[doctype]) return;
		bound[doctype] = true;
		const editor_of = (frm) => frm.__sanad_template_editor;
		const handlers = {};
		handlers[opts.body_field] = (frm) => editor_of(frm) && editor_of(frm).schedule_preview();
		if (opts.reference_doctype_field) {
			handlers[opts.reference_doctype_field] = (frm) => editor_of(frm) && editor_of(frm).on_reference_change();
		}
		if (opts.sample_field) {
			handlers[opts.sample_field] = (frm) => editor_of(frm) && editor_of(frm).schedule_preview();
		}
		frappe.ui.form.on(doctype, handlers);
	}

	get_field(fieldname) {
		return fieldname && this.frm.fields_dict ? this.frm.fields_dict[fieldname] : null;
	}

	make() {
		const preview_id = `${this.id}-preview`;
		const vars_id = `${this.id}-vars`;
		this.$root = $(`
			<div class="sanad-kit sanad-tpl" id="${this.id}">
				<div class="sanad-tpl__toolbar">
					<div class="sanad-tpl__sample"></div>
					<button type="button" class="btn btn-sm btn-default sanad-tpl__latest">${ui.icon("es-line-reload", "xs")} ${ui.escape(__("Use latest"))}</button>
					<span class="sanad-tpl__sample-note"></span>
				</div>
				<div class="sanad-tpl__grid">
					<section class="sanad-tpl__preview" aria-labelledby="${preview_id}">
						<h3 class="sanad-tpl__h" id="${preview_id}">${ui.escape(__("Preview"))}</h3>
						<div class="sanad-tpl__state"></div>
						<div class="sanad-tpl__bubble"></div>
						<ul class="sanad-tpl__errors" role="alert" hidden></ul>
					</section>
					<aside class="sanad-tpl__vars" aria-labelledby="${vars_id}">
						<h3 class="sanad-tpl__h" id="${vars_id}">${ui.escape(__("Variables"))}</h3>
						<input type="search" class="form-control input-sm sanad-tpl__search" placeholder="${ui.escape(__("Filter variables"))}" aria-label="${ui.escape(__("Filter variables"))}">
						<div class="sanad-tpl__vars-state"></div>
						<ul class="sanad-tpl__list" role="list"></ul>
					</aside>
				</div>
			</div>`);
		this.$sample = this.$root.find(".sanad-tpl__sample");
		this.$latest = this.$root.find(".sanad-tpl__latest");
		this.$sample_note = this.$root.find(".sanad-tpl__sample-note");
		this.$bubble = this.$root.find(".sanad-tpl__bubble");
		this.$errors = this.$root.find(".sanad-tpl__errors");
		this.$list = this.$root.find(".sanad-tpl__list");
		this.$search = this.$root.find(".sanad-tpl__search");
		this.state = new sanad.ui.EmptyState({ wrapper: this.$root.find(".sanad-tpl__state"), state: "loading", rows: 2, size: "sm" });
		this.vars_state = new sanad.ui.EmptyState({ wrapper: this.$root.find(".sanad-tpl__vars-state"), state: "loading", rows: 3, size: "sm" });

		const mount = this.get_field(this.opts.preview_field);
		if (mount && mount.$wrapper) {
			mount.$wrapper.empty().append(this.$root);
		} else {
			const body = this.get_field(this.opts.body_field);
			if (body && body.$wrapper) body.$wrapper.after(this.$root);
			else $(this.frm.wrapper).find(".form-layout").append(this.$root);
		}

		this.$latest.on("click", () => this.use_latest());
		this.$search.on("input", ui.debounce(() => this.render_variables(), 120));
		this.$list.on("click", ".sanad-tpl__var", (e) => this.insert_variable($(e.currentTarget).data("name")));
	}

	// ---- state from the form --------------------------------------------------------------

	get_body() {
		return cstr(this.frm.doc[this.opts.body_field] || "");
	}

	get_reference_doctype() {
		return this.opts.reference_doctype_field ? this.frm.doc[this.opts.reference_doctype_field] || null : null;
	}

	/** Parsed sample context, or `{error}` when the JSON field does not parse. */
	get_sample_context() {
		const raw = this.opts.sample_field ? this.frm.doc[this.opts.sample_field] : null;
		if (!raw) return { value: null };
		if (typeof raw === "object") return { value: raw };
		try {
			const value = JSON.parse(raw);
			return { value: value && typeof value === "object" ? value : null };
		} catch (e) {
			return { value: null, error: __("Sample context is not valid JSON. Fix it to include it in the preview.") };
		}
	}

	refresh() {
		const doctype = this.get_reference_doctype();
		if (doctype !== this._doctype) this.on_reference_change();
		else this.schedule_preview();
		return this;
	}

	on_reference_change() {
		this._doctype = this.get_reference_doctype();
		this.reference_name = null;
		this.make_sample_picker();
		this.load_variables();
		this.schedule_preview();
	}

	// ---- sample record --------------------------------------------------------------------

	make_sample_picker() {
		this.$sample.empty();
		const doctype = this._doctype;
		if (!doctype) {
			this.$latest.hide();
			this.$sample_note.text(__("Choose a reference document type to preview with a real record."));
			return;
		}
		this.$latest.show();
		this.$sample_note.text("");
		this.sample_control = frappe.ui.form.make_control({
			parent: this.$sample,
			df: {
				fieldtype: "Link",
				fieldname: "sanad_sample_record",
				label: __("Sample record"),
				options: doctype,
				placeholder: __("Search {0}", [__(doctype)]),
				change: () => {
					this.reference_name = this.sample_control.get_value() || null;
					this.schedule_preview();
				},
			},
			render_input: true,
		});
		this.sample_control.$wrapper.addClass("sanad-tpl__sample-control");
	}

	use_latest() {
		if (!this._doctype) return Promise.resolve();
		this.$latest.prop("disabled", true).attr("aria-busy", "true");
		return sanad.ui
			.call(this.api.sample, { reference_doctype: this._doctype })
			.then((r) => {
				const name = r && r.name;
				if (!name) {
					sanad.ui.Toast.info(__("There are no {0} records to preview with yet.", [__(this._doctype)]));
					return;
				}
				this.reference_name = name;
				if (this.sample_control) this.sample_control.set_value(name);
				this.schedule_preview();
			})
			.catch((err) => sanad.ui.Toast.error(err))
			.then(() => this.$latest.prop("disabled", false).removeAttr("aria-busy"));
	}

	// ---- variables ------------------------------------------------------------------------

	load_variables() {
		this.vars_state.loading({ rows: 3 });
		this.$list.empty();
		const args = this._doctype ? { reference_doctype: this._doctype } : {};
		return sanad.ui
			.call(this.api.variables, args, { silent: true })
			.then((rows) => {
				this.variables = Array.isArray(rows) ? rows : [];
				this.render_variables();
			})
			.catch((err) => this.vars_state.error(err, { action: { label: __("Retry"), onclick: () => this.load_variables() } }));
	}

	render_variables() {
		const q = cstr(this.$search.val()).trim().toLowerCase();
		const rows = this.variables.filter((v) => !q || `${v.name} ${v.label || ""}`.toLowerCase().includes(q));
		this.$list.empty();
		if (!rows.length) {
			this.vars_state.empty({ title: q ? __("No variables match") : __("No variables"), description: q ? "" : __("Choose a reference document type to list its fields."), size: "sm" });
			return;
		}
		this.vars_state.hide();
		rows.forEach((v) => {
			const token = `{{ ${v.name} }}`;
			const label = v.label && v.label !== v.name ? v.label : "";
			$(`<li><button type="button" class="sanad-tpl__var" data-name="${ui.escape(v.name)}" aria-label="${ui.escape(__("Insert {0}", [token]))}" title="${ui.escape(__("Insert at the cursor"))}"><code>${ui.escape(token)}</code>${label ? `<span class="sanad-tpl__var-label">${ui.escape(__(label))}${v.fieldtype ? ` · ${ui.escape(__(v.fieldtype))}` : ""}</span>` : ""}</button></li>`).appendTo(this.$list);
		});
	}

	/** Insert `{{ name }}` at the caret of the body control (Ace editor, textarea or input). */
	insert_variable(name) {
		if (!name) return;
		const token = `{{ ${name} }}`;
		const field = this.get_field(this.opts.body_field);
		// Only a body the person can see has a caret worth honouring; when the editor is mounted
		// on another tab (`preview_field`) the variable goes at the end of the text.
		const visible = !!(field && field.$wrapper && field.$wrapper.is(":visible"));
		if (visible && field.editor && typeof field.editor.insert === "function") {
			field.editor.insert(token);
			field.editor.focus();
			return;
		}
		const $input = visible && field.$input;
		const el = $input && $input.get(0);
		if (el && typeof el.selectionStart === "number") {
			const value = cstr(el.value);
			const start = el.selectionStart;
			const end = el.selectionEnd;
			const next = value.slice(0, start) + token + value.slice(end);
			this.frm.set_value(this.opts.body_field, next).then(() => {
				el.focus();
				el.setSelectionRange(start + token.length, start + token.length);
			});
			return;
		}
		const body = this.get_body();
		this.frm.set_value(this.opts.body_field, body ? `${body} ${token}` : token);
	}

	// ---- preview --------------------------------------------------------------------------

	preview() {
		const body = this.get_body();
		const sample = this.get_sample_context();
		if (!body.trim()) {
			this.state.hide();
			this.$bubble.hide();
			this.render_errors(sample.error ? [sample.error] : []);
			this.state.empty({ title: __("Nothing to preview"), description: __("Type the message body to see it rendered."), size: "sm" });
			return Promise.resolve();
		}
		const seq = (this._seq = (this._seq || 0) + 1);
		if (!this.$bubble.is(":visible")) this.state.loading({ rows: 2 });
		this.$bubble.attr("aria-busy", "true");
		const args = { body, reference_doctype: this._doctype || null, reference_name: this.reference_name || null };
		if (sample.value) args.sample_context = sample.value;
		return sanad.ui
			.call(this.api.preview, args, { silent: true })
			.then((r) => {
				if (seq !== this._seq) return;
				this.state.hide();
				const rendered = cstr((r && r.body) || "");
				const format = sanad.ui.ChatThread && sanad.ui.ChatThread.format ? sanad.ui.ChatThread.format : (t) => ui.escape(t).replace(/\r?\n/g, "<br>");
				this.$bubble.html(rendered ? format(rendered) : `<span class="sanad-tpl__muted">${ui.escape(__("The template renders to an empty message."))}</span>`).show();
				this.render_errors([].concat(sample.error ? [sample.error] : [], (r && r.errors) || []));
			})
			.catch((err) => {
				if (seq !== this._seq) return;
				this.$bubble.hide();
				this.render_errors([]);
				this.state.error(err, { action: { label: __("Retry"), onclick: () => this.preview() } });
			})
			.then(() => this.$bubble.removeAttr("aria-busy"));
	}

	/** Render the error list only when it changed, so the `role="alert"` region announces once per change. */
	render_errors(errors = []) {
		const list = (errors || []).map((e) => (e && e.message) || cstr(e)).filter(Boolean);
		const signature = list.join("\n");
		if (signature === this._errors_signature) return;
		this._errors_signature = signature;
		this.$errors.empty();
		if (!list.length) {
			this.$errors.attr("hidden", true);
			return;
		}
		list.forEach((msg) => $(`<li>${ui.icon("es-line-alert-triangle", "xs")} <span>${ui.escape(msg)}</span></li>`).appendTo(this.$errors));
		this.$errors.removeAttr("hidden");
	}

	destroy() {
		this.$root.remove();
		if (this.frm.__sanad_template_editor === this) delete this.frm.__sanad_template_editor;
	}
};

export default sanad.ui.TemplateEditor;

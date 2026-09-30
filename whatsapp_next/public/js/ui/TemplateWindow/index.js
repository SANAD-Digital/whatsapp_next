// sanad.ui.TemplateWindow — one window to write, check and save a message template, ported from
// `docs/component/Template Editor.dc.html`: the name in the header, and three columns under it —
//
//   Editor     what kind of message it is (text / image / document), its category, the document it
//              is about, and the text itself with a small formatting bar (*bold* _italic_ ~strike~
//              ```mono```, a condition). The file an image or document message carries sits under
//              the text; the rarely touched options fold away.
//   Preview    the text as WhatsApp shows it, rendered through the host's sandbox with a real
//              record of the chosen document (picked, or the latest one), errors under it.
//   Variables  what the text may use, filtered as you type; a click inserts it at the caret.
//
// Under 720 px the columns become three tabs. Ctrl/⌘+S saves, Esc closes (asking before unsaved
// changes are dropped). The DOM is built once and only the parts that change are redrawn, so the
// text box never loses its caret while the preview follows it.
//
// Portable: it knows nothing about the host app — the host passes the data source as functions
// (see README.md). Colours are the product tokens (`--wa-*`); offsets are logical.

import ui from "../_core/index.js";
import kit from "../_kit/index.js";

const esc = (v) => ui.escape(v == null ? "" : v);
const format_html = (text) =>
	sanad.ui.ChatThread && sanad.ui.ChatThread.format ? sanad.ui.ChatThread.format(text) : esc(text).replace(/\n/g, "<br>");

const TYPES = () => [
	{ value: "Text", label: __("Text"), icon: "chat" },
	{ value: "Image", label: __("Image"), icon: "attach" },
	{ value: "Document", label: __("Document"), icon: "doc" },
];

// the formatting bar: what WhatsApp itself understands, plus the one Jinja shape people need most
const FORMATS = () => [
	{ key: "bold", mark: "*", label: __("Bold"), glyph: "B" },
	{ key: "italic", mark: "_", label: __("Italic"), glyph: "I" },
	{ key: "strike", mark: "~", label: __("Strikethrough"), glyph: "S" },
	{ key: "mono", mark: "```", label: __("Monospace"), glyph: "</>" },
];

sanad.ui.TemplateWindow = class TemplateWindow {
	/**
	 * @param {Object} opts
	 * @param {string|null} [opts.name] — the template to open; empty for a new one
	 * @param {Function} opts.load — `(name) → {template, categories[], message_types[], can_write, can_delete}`
	 * @param {Function} opts.save — `(payload) → {name, modified}`
	 * @param {Function} [opts.remove] — `(name)`
	 * @param {Function} opts.preview — `({body, reference_doctype, reference_name, sample_context}) → {body, errors[]}`
	 * @param {Function} [opts.variables] — `(reference_doctype) → [{name, label, fieldtype}]`
	 * @param {Function} [opts.pick_sample] — `(reference_doctype) → {name}` (the latest readable record)
	 * @param {Function} [opts.use_in_message] — `(name)`; shows "Use in a message" on a saved template
	 * @param {Function} [opts.on_saved] — `(result)` after a save or a delete
	 * @param {Function} [opts.on_close]
	 */
	constructor(opts = {}) {
		this.opts = opts;
		this.state = { tab: "editor", vars: [], vars_q: "", sample: null, seq: 0, saving: false };
		this.controls = {};
		this.build();
		this.load(opts.name || null);
	}

	// ---- shell ---------------------------------------------------------------------------------

	build() {
		this.id = ui.uid("sanad-tw");
		this.previous_focus = document.activeElement;
		this.$root = $(`
			<div class="sanad-kit wa sanad-tw-layer" role="presentation">
				<div class="sanad-tw-backdrop"></div>
				<div class="sanad-tw sanad-tw--tab-editor" role="dialog" aria-modal="true" aria-labelledby="${this.id}-label">
					<span class="sr-only" id="${this.id}-label">${esc(__("Message template"))}</span>
					<div class="sanad-tw__loading">${esc(__("Loading…"))}</div>
				</div>
			</div>`).appendTo(document.body);
		this.$dlg = this.$root.find(".sanad-tw");
		$("body").addClass("sanad-tw-open");
		this.$root.find(".sanad-tw-backdrop").on("click", () => this.close());
		this.$root.on("keydown", (e) => this.on_key(e));
		this.untrap = ui.trap_focus(this.$root);
		this.preview_later = ui.debounce(() => this.run_preview(), 400);
		// the window belongs to the page it was opened on: leaving that page (a link, "Use in a
		// message" handing over to another screen, the back button) takes the window with it
		this._on_route = () => this.$root && this.close(true);
		frappe.router.on("change", this._on_route);
	}

	on_key(e) {
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
			e.preventDefault();
			if (this.data && this.data.can_write) this.save();
			return;
		}
		if (e.key !== "Escape") return;
		// a Link control's open list takes Esc first
		if ($(e.target).closest(".awesomplete").find("ul:not([hidden])").length) return;
		e.preventDefault();
		e.stopPropagation();
		this.close();
	}

	close(force = false) {
		if (!force && this.is_dirty()) {
			frappe.confirm(__("Discard unsaved changes?"), () => this.close(true));
			return;
		}
		if (this._closed) return;
		this._closed = true;
		frappe.router.off("change", this._on_route);
		this.untrap && this.untrap();
		$("body").removeClass("sanad-tw-open");
		this.$root.remove();
		if (this.previous_focus && document.contains(this.previous_focus)) this.previous_focus.focus();
		this.opts.on_close && this.opts.on_close();
	}

	async load(name) {
		try {
			this.data = await this.opts.load(name);
			const t = this.data.template || {};
			this.draft = {
				name: t.name || null,
				modified: t.modified || null,
				template_name: t.template_name || t.name || "",
				category: t.category || "",
				description: t.description || "",
				message_type: t.message_type || "Text",
				disabled: cint(t.disabled),
				body: t.body || "",
				attachment: t.attachment || null,
				print_format: t.print_format || null,
				letter_head: t.letter_head || null,
				file_name_template: t.file_name_template || "",
				reference_doctype: t.reference_doctype || null,
				language: t.language || null,
				sample_context: t.sample_context || "",
			};
			this.stats = { use_count: t.use_count, last_used_at: t.last_used_at };
			this.mark_clean();
			this.render();
			this.load_variables();
			this.run_preview();
			(this.draft.name ? this.$body_input : this.$name_input).trigger("focus");
		} catch (err) {
			this.$dlg.html(`
				<div class="sanad-tw__loading" role="alert">
					<span>${esc((err && err.message) || __("Something went wrong. Please try again."))}</span>
					${kit.btn({ label: __("Close"), attrs: { "data-act": "close" } })}
				</div>`);
			this.$dlg.find("[data-act=close]").on("click", () => this.close(true));
		}
	}

	payload() {
		const d = this.draft;
		return {
			name: d.name,
			modified: d.modified,
			template_name: d.template_name,
			category: d.category,
			description: d.description,
			message_type: d.message_type,
			disabled: d.disabled,
			body: d.body,
			attachment: d.attachment,
			print_format: d.print_format,
			letter_head: d.letter_head,
			file_name_template: d.file_name_template,
			reference_doctype: d.reference_doctype,
			language: d.language,
			sample_context: d.sample_context,
		};
	}

	mark_clean() {
		this.clean = JSON.stringify(this.payload());
	}

	is_dirty() {
		return !!this.draft && JSON.stringify(this.payload()) !== this.clean;
	}

	/** Set one field of the draft and redraw only what depends on it. */
	set(field, value) {
		if (this.draft[field] === value) return;
		this.draft[field] = value;
		if (field === "message_type") this.render_attachment();
		if (field === "reference_doctype") {
			this.state.sample = null;
			this.render_sample();
			this.load_variables();
			this.render_attachment();
		}
		if (["body", "reference_doctype", "sample_context", "message_type", "attachment", "file_name_template"].includes(field)) this.preview_later();
		this.render_status();
	}

	// ---- render --------------------------------------------------------------------------------

	render() {
		const d = this.draft;
		const ro = !this.data.can_write;
		this.$dlg.html(`
			<header class="sanad-tw__head">
				<span class="sanad-tw__mark" aria-hidden="true">${kit.ico("doc", "sm")}</span>
				<input type="text" class="sanad-tw__name" value="${esc(d.template_name)}" placeholder="${esc(__("Template name"))}" aria-label="${esc(__("Template name"))}" maxlength="140"${ro ? " readonly" : ""}>
				<span class="sanad-tw__status" aria-live="polite"></span>
				${kit.btn({ icon: "x", variant: "secondary", title: __("Close (Esc)"), cls: "sanad-tw__close", attrs: { "data-act": "close" } })}
			</header>
			<div class="sanad-tw__tabs" role="tablist" aria-label="${esc(__("Sections"))}">
				${[["editor", __("Editor")], ["preview", __("Preview", null, "Template preview tab")], ["vars", __("Variables")]]
					.map(([k, l]) => `<button type="button" class="sanad-tw__tab" role="tab" data-tab="${k}" aria-selected="${k === this.state.tab}">${esc(l)}</button>`)
					.join("")}
			</div>
			<div class="sanad-tw__grid">
				<section class="sanad-tw__pane sanad-tw__editor" data-pane="editor" aria-label="${esc(__("Editor"))}">
					<div class="sanad-tw__row">
						<div class="wa-field">
							<span class="wa-field__label">${esc(__("Message type"))}</span>
							${kit.segmented(TYPES(), d.message_type, { label: __("Message type") })}
						</div>
						<label class="wa-field">
							<span class="wa-field__label">${esc(__("Category"))}</span>
							<input type="text" class="wa-input" data-field="category" list="${this.id}-cats" value="${esc(d.category)}" placeholder="${esc(__("e.g. Sales"))}"${ro ? " disabled" : ""}>
							<datalist id="${this.id}-cats">${(this.data.categories || []).map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
						</label>
					</div>
					<div class="wa-field">
						<span class="wa-field__label">${esc(__("Document it is about"))}</span>
						<div class="sanad-tw__link" data-link="reference_doctype"></div>
						<span class="wa-field__hint">${esc(__("Optional. Pick the document the message is sent about, such as Sales Invoice, to insert its fields."))}</span>
					</div>
					<div class="wa-field sanad-tw__body-field">
						<div class="sanad-tw__body-head">
							<label class="wa-field__label" for="${this.id}-body">${esc(__("Message text"))} <span class="wa-field__req" aria-hidden="true">*</span></label>
							${ro ? "" : `<div class="sanad-tw__fmt" role="toolbar" aria-label="${esc(__("Formatting"))}">
								${FORMATS().map((f) => `<button type="button" class="sanad-tw__fmt-btn sanad-tw__fmt-btn--${f.key}" data-fmt="${f.key}" title="${esc(f.label)}" aria-label="${esc(f.label)}">${esc(f.glyph)}</button>`).join("")}
								<span class="sanad-tw__fmt-sep" aria-hidden="true"></span>
								<button type="button" class="sanad-tw__fmt-btn sanad-tw__fmt-btn--wide" data-fmt="if" title="${esc(__("Show a part only when a condition holds"))}">${esc(__("Condition"))}</button>
							</div>`}
						</div>
						<textarea id="${this.id}-body" class="wa-textarea sanad-tw__body" dir="auto" rows="10" placeholder="${esc(__("Hello {{ doc.customer_name }}, …"))}"${ro ? " readonly" : ""}>${esc(d.body)}</textarea>
						<div class="sanad-tw__body-foot">
							<span class="wa-field__hint">${esc(__("Variables go in {{ … }} and conditions in {% if … %} … {% endif %}."))}</span>
							<span class="sanad-tw__count sanad-tabular"></span>
						</div>
					</div>
					<div class="sanad-tw__attach"></div>
					<details class="sanad-tw__more">
						<summary>${esc(__("More options"))}</summary>
						<div class="sanad-tw__more-body">
							<label class="wa-toggle">
								<input type="checkbox" data-field="enabled"${d.disabled ? "" : " checked"}${ro ? " disabled" : ""}>
								<span class="wa-toggle__track" aria-hidden="true"></span>
								<span class="wa-toggle__label">${esc(__("Offered when sending"))}</span>
							</label>
							<label class="wa-field">
								<span class="wa-field__label">${esc(__("Description"))}</span>
								<textarea class="wa-textarea" data-field="description" rows="2" placeholder="${esc(__("When to use it — shown to whoever picks it"))}"${ro ? " readonly" : ""}>${esc(d.description)}</textarea>
							</label>
							<div class="wa-field">
								<span class="wa-field__label">${esc(__("Language"))}</span>
								<div class="sanad-tw__link" data-link="language"></div>
							</div>
							<label class="wa-field">
								<span class="wa-field__label">${esc(__("Extra sample values (JSON)"))}</span>
								<textarea class="wa-textarea wa-textarea--mono" data-field="sample_context" dir="ltr" rows="3" placeholder='{"discount": 10}'${ro ? " readonly" : ""}>${esc(d.sample_context)}</textarea>
								<span class="wa-field__hint">${esc(__("Only for the preview: values the text uses that no document has."))}</span>
							</label>
						</div>
					</details>
				</section>

				<section class="sanad-tw__pane sanad-tw__preview" data-pane="preview" aria-label="${esc(__("Preview", null, "Template preview tab"))}">
					<span class="sanad-tw__pane-title">${esc(__("Preview — as the recipient sees it"))}</span>
					<div class="sanad-tw__sample"></div>
					<div class="sanad-tw__chat">
						<div class="sanad-tw__bubble" aria-busy="false">
							<div class="sanad-tw__bubble-file"></div>
							<div class="sanad-tw__bubble-text" dir="auto"></div>
							<span class="sanad-tw__bubble-time" dir="ltr">${esc(frappe.datetime.now_time().slice(0, 5))} ✓✓</span>
						</div>
					</div>
					<ul class="sanad-tw__errors" role="alert"></ul>
				</section>

				<section class="sanad-tw__pane sanad-tw__vars" data-pane="vars" aria-label="${esc(__("Variables"))}">
					<span class="sanad-tw__pane-title">${esc(__("Variables — click to insert"))}</span>
					<input type="search" class="wa-input sanad-tw__vars-q" placeholder="${esc(__("Filter variables…"))}" aria-label="${esc(__("Filter variables"))}">
					<div class="sanad-tw__vars-list" role="list"></div>
				</section>
			</div>
			<footer class="sanad-tw__foot">
				<div class="sanad-tw__foot-msg" role="alert"></div>
				<div class="sanad-tw__foot-btns"></div>
			</footer>`);
		this.$name_input = this.$dlg.find(".sanad-tw__name");
		this.$body_input = this.$dlg.find(".sanad-tw__body");
		this.make_link("reference_doctype", "DocType", { get_query: () => ({ filters: { istable: 0, issingle: 0 } }), placeholder: __("Any document") });
		this.make_link("language", "Language", { placeholder: __("The user's language") });
		this.bind();
		this.render_attachment();
		this.render_sample();
		this.render_vars();
		this.render_status();
		this.render_foot();
	}

	/** A Frappe Link control (search, permissions, "create new"), drawn in the kit's field style. */
	make_link(field, doctype, { get_query, placeholder, parent } = {}) {
		const $parent = parent || this.$dlg.find(`[data-link="${field}"]`);
		$parent.empty();
		const control = frappe.ui.form.make_control({
			df: {
				fieldtype: "Link",
				fieldname: field,
				options: doctype,
				placeholder: placeholder || "",
				read_only: this.data.can_write ? 0 : 1,
				get_query,
				change: () => {
					// a control replaced by a newer one (the document changed) may still report its
					// last value on blur; only the live one speaks
					if (this.controls[field] !== control) return;
					const value = control.get_value() || null;
					if (field === "sample") this.pick_sample(value);
					else this.set(field, value);
				},
			},
			parent: $parent,
			render_input: true,
			only_input: true,
		});
		const value = field === "sample" ? this.state.sample : this.draft[field];
		if (value) control.set_value(value);
		control.$input && control.$input.addClass("wa-input");
		this.controls[field] = control;
		return control;
	}

	bind() {
		const $d = this.$dlg;
		$d.on("click", "[data-act=close]", () => this.close());
		$d.on("click", "[data-tab]", (e) => this.show_tab($(e.currentTarget).data("tab")));
		kit.bind_segmented($d.find(".wa-seg"), (value) => this.set("message_type", value));
		if (!this.data.can_write) $d.find(".wa-seg__opt").prop("disabled", true);
		this.$name_input.on("input", (e) => this.set("template_name", e.target.value));
		this.$body_input.on("input", (e) => {
			this.set("body", e.target.value);
			this.render_count();
		});
		$d.on("input", "[data-field=category], [data-field=description], [data-field=sample_context], [data-field=file_name_template]", (e) =>
			this.set($(e.currentTarget).data("field"), e.target.value)
		);
		$d.on("change", "[data-field=enabled]", (e) => this.set("disabled", e.target.checked ? 0 : 1));
		$d.on("click", "[data-fmt]", (e) => this.apply_format($(e.currentTarget).data("fmt")));
		$d.on("input", ".sanad-tw__vars-q", (e) => {
			this.state.vars_q = e.target.value;
			this.render_vars();
		});
		$d.on("click", "[data-token]", (e) => this.insert($(e.currentTarget).attr("data-token")));
		$d.on("click", "[data-act=latest]", () => this.use_latest());
		$d.on("click", "[data-act=upload]", () => this.upload());
		$d.on("click", "[data-act=unattach]", () => {
			this.set("attachment", null);
			this.render_attachment();
		});
		this.render_count();
	}

	show_tab(tab) {
		this.state.tab = tab;
		this.$dlg.removeClass("sanad-tw--tab-editor sanad-tw--tab-preview sanad-tw--tab-vars").addClass(`sanad-tw--tab-${tab}`);
		this.$dlg.find("[data-tab]").each((_, el) => el.setAttribute("aria-selected", String(el.dataset.tab === tab)));
	}

	render_count() {
		const n = (this.draft.body || "").length;
		this.$dlg.find(".sanad-tw__count").text(__("{0} characters", [format_number(n, null, 0)]));
	}

	/** The header's word on the template: unsaved, off, or how often it has been used. */
	render_status() {
		const d = this.draft;
		const parts = [];
		if (this.is_dirty()) parts.push(kit.badge(__("Unsaved"), "warn"));
		else if (!d.name) parts.push(kit.badge(__("New"), "info"));
		if (d.disabled) parts.push(kit.badge(__("Not offered"), "muted"));
		if (d.name && !this.is_dirty() && this.stats && cint(this.stats.use_count))
			parts.push(`<span class="sanad-tw__uses">${esc(__("Used {0} times", [format_number(this.stats.use_count, null, 0)]))}</span>`);
		if (!this.data.can_write) parts.push(kit.badge(__("Read only"), "muted", { dot: false }));
		this.$dlg.find(".sanad-tw__status").html(parts.join(""));
		this.render_foot_state();
	}

	/** What an image or document message carries, under the text. */
	render_attachment() {
		const d = this.draft;
		const ro = !this.data.can_write;
		const $a = this.$dlg.find(".sanad-tw__attach").empty();
		if (d.message_type === "Image") {
			const file = d.attachment;
			$a.html(`
				<div class="wa-field">
					<span class="wa-field__label">${esc(__("Image"))}</span>
					${
						file
							? `<div class="sanad-tw__file">
								<img class="sanad-tw__file-thumb" src="${esc(file)}" alt="">
								<span class="sanad-tw__file-name" dir="ltr">${esc(file.split("/").pop())}</span>
								${ro ? "" : `${kit.btn({ label: __("Replace"), size: "sm", attrs: { "data-act": "upload" } })}${kit.btn({ icon: "x", size: "sm", variant: "ghost", title: __("Remove the image"), attrs: { "data-act": "unattach" } })}`}
							</div>`
							: ro
								? `<span class="wa-field__hint">${esc(__("No image"))}</span>`
								: `<button type="button" class="sanad-tw__drop" data-act="upload">${kit.ico("attach", "md")}<span>${esc(__("Upload the image the message is sent with"))}</span></button>`
					}
				</div>`);
		} else if (d.message_type === "Document") {
			$a.html(`
				<div class="sanad-tw__doc">
					<div class="wa-field">
						<span class="wa-field__label">${esc(__("Print format"))} <span class="wa-field__req" aria-hidden="true">*</span></span>
						<div class="sanad-tw__link" data-link="print_format"></div>
						<span class="wa-field__hint">${esc(d.reference_doctype ? __("The PDF is printed from the document with this format.") : __("Pick the document it is about first, to see its print formats."))}</span>
					</div>
					<div class="wa-field">
						<span class="wa-field__label">${esc(__("Letter head"))}</span>
						<div class="sanad-tw__link" data-link="letter_head"></div>
					</div>
					<label class="wa-field sanad-tw__doc-wide">
						<span class="wa-field__label">${esc(__("File name"))}</span>
						<input type="text" class="wa-input wa-input--mono" dir="ltr" data-field="file_name_template" value="${esc(d.file_name_template)}" placeholder="{{ doc.name }}.pdf"${ro ? " disabled" : ""}>
					</label>
				</div>`);
			this.make_link("print_format", "Print Format", {
				get_query: () => ({ filters: Object.assign({ disabled: 0 }, d.reference_doctype ? { doc_type: d.reference_doctype } : {}) }),
			});
			this.make_link("letter_head", "Letter Head", { get_query: () => ({ filters: { disabled: 0 } }) });
		}
		this.render_bubble_file();
	}

	upload() {
		new frappe.ui.FileUploader({
			allow_multiple: false,
			restrictions: { allowed_file_types: ["image/*"] },
			on_success: (file) => {
				this.set("attachment", file.file_url);
				this.render_attachment();
			},
		});
	}

	/** The sample the preview renders with: a record of the chosen document, picked or the latest. */
	render_sample() {
		const dt = this.draft.reference_doctype;
		const $s = this.$dlg.find(".sanad-tw__sample").empty();
		if (!dt) {
			$s.html(`<span class="sanad-tw__sample-note">${esc(__("Rendered with general sample values. Pick the document it is about to preview with a real record."))}</span>`);
			return;
		}
		$s.html(`
			<span class="sanad-tw__sample-label">${esc(__("With {0}", [__(dt)]))}</span>
			<div class="sanad-tw__sample-pick"></div>
			${this.opts.pick_sample ? kit.btn({ label: __("Latest"), size: "sm", variant: "ghost", title: __("Use the latest {0}", [__(dt)]), attrs: { "data-act": "latest" } }) : ""}`);
		const control = this.make_link("sample", dt, { parent: $s.find(".sanad-tw__sample-pick"), placeholder: __("Pick a record…") });
		// the sample is not part of the template, so even a read-only reader may change it
		control.df.read_only = 0;
		control.refresh();
		control.$input && control.$input.addClass("wa-input");
		if (!this.state.sample && this.opts.pick_sample) this.use_latest(true);
	}

	async use_latest(quiet = false) {
		const dt = this.draft.reference_doctype;
		if (!dt || !this.opts.pick_sample) return;
		try {
			const r = await this.opts.pick_sample(dt);
			if (dt !== this.draft.reference_doctype) return;
			if (!r || !r.name) {
				if (!quiet) sanad.ui.Toast.info(__("There are no {0} records to preview with yet.", [__(dt)]));
				return;
			}
			this.state.sample = r.name;
			this.controls.sample && this.controls.sample.set_value(r.name);
			this.run_preview();
		} catch (e) {
			// the preview still renders with general sample values
		}
	}

	pick_sample(value) {
		if (value === this.state.sample) return;
		this.state.sample = value;
		this.run_preview();
	}

	async run_preview() {
		if (!this.draft) return;
		const seq = ++this.state.seq;
		const $bubble = this.$dlg.find(".sanad-tw__bubble").attr("aria-busy", "true").addClass("sanad-tw__bubble--busy");
		let r;
		try {
			r = await this.opts.preview({
				body: this.draft.body || "",
				reference_doctype: this.draft.reference_doctype,
				reference_name: this.state.sample,
				sample_context: this.sample_json(),
			});
		} catch (err) {
			r = { body: "", errors: [(err && err.message) || __("The preview could not be rendered.")] };
		}
		if (seq !== this.state.seq) return; // a newer render is on its way
		$bubble.attr("aria-busy", "false").removeClass("sanad-tw__bubble--busy");
		// when it could not render, the text is still shown as written, so the preview never goes blank
		const failed = !r.body && (r.errors || []).length;
		const text = failed ? this.draft.body || "" : r.body || "";
		this.$dlg
			.find(".sanad-tw__bubble-text")
			.toggleClass("sanad-tw__bubble-text--empty", !text)
			.toggleClass("sanad-tw__bubble-text--raw", !!(failed && text))
			.html(text ? format_html(text) : esc(this.draft.body ? __("(the text renders empty)") : __("Start writing and the message appears here.")));
		const errors = (r.errors || []).concat(this.sample_error ? [this.sample_error] : []);
		const key = JSON.stringify(errors);
		// re-render only when they change, so a screen reader hears them once
		if (key !== this.state.errors_key) {
			this.state.errors_key = key;
			this.$dlg.find(".sanad-tw__errors").html(errors.map((e) => `<li>${kit.ico("warn", "xs")}<span>${esc(e)}</span></li>`).join(""));
		}
	}

	/** Extra sample values as an object; invalid JSON is reported, not sent. */
	sample_json() {
		this.sample_error = null;
		const raw = (this.draft.sample_context || "").trim();
		if (!raw) return null;
		try {
			const v = JSON.parse(raw);
			if (v && typeof v === "object" && !Array.isArray(v)) return v;
		} catch (e) {
			// fall through
		}
		this.sample_error = __('Extra sample values must be a JSON object, like {"discount": 10}.');
		return null;
	}

	render_bubble_file() {
		const d = this.draft;
		const $f = this.$dlg.find(".sanad-tw__bubble-file").empty();
		if (d.message_type === "Image") {
			$f.html(d.attachment ? `<img src="${esc(d.attachment)}" alt="">` : `<span class="sanad-tw__bubble-ph">${kit.ico("attach", "md")}<span>${esc(__("Image"))}</span></span>`);
		} else if (d.message_type === "Document") {
			$f.html(`<span class="sanad-tw__bubble-doc">${kit.ico("doc", "md")}<span dir="ltr">${esc(d.file_name_template || (d.reference_doctype ? `${__(d.reference_doctype)}.pdf` : "document.pdf"))}</span><small>PDF</small></span>`);
		}
		$f.prop("hidden", d.message_type === "Text");
	}

	// ---- variables -----------------------------------------------------------------------------

	async load_variables() {
		if (!this.opts.variables) return;
		const dt = this.draft.reference_doctype;
		try {
			const rows = await this.opts.variables(dt);
			if (dt !== this.draft.reference_doctype) return;
			this.state.vars = rows || [];
		} catch (e) {
			this.state.vars = [];
		}
		this.render_vars();
	}

	render_vars() {
		const q = (this.state.vars_q || "").trim().toLowerCase();
		const rows = this.state.vars.filter((v) => !q || `${v.name} ${v.label}`.toLowerCase().includes(q));
		const of_doc = rows.filter((v) => v.name.startsWith("doc."));
		const general = rows.filter((v) => !v.name.startsWith("doc."));
		const item = (v) =>
			`<button type="button" class="sanad-tw__var" role="listitem" data-token="{{ ${esc(v.name)} }}" title="${esc(__("Insert {0}", [`{{ ${v.name} }}`]))}"${this.data.can_write ? "" : " disabled"}>
				<span class="sanad-tw__var-token" dir="ltr">{{ ${esc(v.name)} }}</span>
				${v.label && v.label !== v.name ? `<span class="sanad-tw__var-label">${esc(__(v.label))}</span>` : ""}
			</button>`;
		const group = (title, list) => (list.length ? `<span class="sanad-tw__vars-group">${esc(title)}</span>${list.map(item).join("")}` : "");
		const html =
			group(this.draft.reference_doctype ? __("Fields of {0}", [__(this.draft.reference_doctype)]) : __("Document fields"), of_doc) + group(__("General"), general);
		this.$dlg.find(".sanad-tw__vars-list").html(
			html ||
				`<span class="sanad-tw__vars-empty">${esc(
					q ? __("No variable matches “{0}”.", [this.state.vars_q]) : __("Pick the document it is about to see its fields here.")
				)}</span>`
		);
	}

	/** Put `text` at the caret of the message text (replacing a selection) and keep typing there. */
	insert(text, { select_inner = null } = {}) {
		if (!this.data.can_write) return;
		const el = this.$body_input[0];
		const start = el.selectionStart ?? el.value.length;
		const end = el.selectionEnd ?? start;
		const before = el.value.slice(0, start);
		const pad = before && !/\s$/.test(before) && !select_inner ? " " : "";
		el.value = before + pad + text + el.value.slice(end);
		const caret = before.length + pad.length + (select_inner ? select_inner[0] : text.length);
		el.focus();
		el.setSelectionRange(caret, select_inner ? caret + select_inner[1] : caret);
		this.set("body", el.value);
		this.render_count();
		if (this.state.tab === "vars") this.show_tab("editor");
	}

	/** Wrap the selection in a WhatsApp mark, or drop in a condition. */
	apply_format(key) {
		const el = this.$body_input[0];
		const sel = el.value.slice(el.selectionStart, el.selectionEnd);
		if (key === "if") {
			const cond = "{% if doc.status == \"Overdue\" %}";
			const text = `${cond}${sel || __("shown only then")}{% else %}${__("otherwise")}{% endif %}`;
			// leave the condition selected, since that is the part to change first
			this.insert(text, { select_inner: [6, cond.length - 9] });
			return;
		}
		const f = FORMATS().find((x) => x.key === key);
		const inner = sel || __("text");
		this.insert(`${f.mark}${inner}${f.mark}`, { select_inner: [f.mark.length, inner.length] });
	}

	// ---- footer --------------------------------------------------------------------------------

	render_foot() {
		const d = this.draft;
		const can = this.data.can_write;
		const btns = [];
		if (can) btns.push(kit.btn({ label: d.name ? __("Save") : __("Create template"), variant: "primary", cls: "sanad-tw__save", attrs: { "data-act": "save", "aria-keyshortcuts": "Control+S" } }));
		btns.push(kit.btn({ label: can ? __("Cancel") : __("Close"), attrs: { "data-act": "close" } }));
		if (d.name && this.opts.use_in_message && !d.disabled) btns.push(kit.btn({ label: __("Use in a message"), icon: "send", variant: "ghost", attrs: { "data-act": "use" } }));
		if (d.name && this.data.can_delete && this.opts.remove) btns.push(kit.btn({ label: __("Delete"), icon: "trash", variant: "danger", cls: "sanad-tw__delete", attrs: { "data-act": "delete" } }));
		const $b = this.$dlg.find(".sanad-tw__foot-btns").html(btns.join(""));
		$b.find("[data-act=save]").on("click", () => this.save());
		// the send takes over from here: this window steps aside first (asking about unsaved edits),
		// so it is not left open on top of the send window or the screen the send leads to
		$b.find("[data-act=use]").on("click", () => {
			const go = () => {
				this.close(true);
				this.opts.use_in_message(d.name);
			};
			if (this.is_dirty()) frappe.confirm(__("Discard unsaved changes?"), go);
			else go();
		});
		$b.find("[data-act=delete]").on("click", () => this.remove());
		this.render_foot_state();
	}

	render_foot_state() {
		const $save = this.$dlg.find(".sanad-tw__save");
		$save.prop("disabled", this.state.saving || (!!this.draft.name && !this.is_dirty()));
		$save.toggleClass("wa-btn--busy", !!this.state.saving);
	}

	show_error(message) {
		this.$dlg.find(".sanad-tw__foot-msg").html(message ? `${kit.ico("warn", "xs")}<span>${esc(message)}</span>` : "");
	}

	/** What is missing before a save can work, said before the server has to. */
	problem() {
		const d = this.draft;
		if (!(d.template_name || "").trim()) return { msg: __("Give the template a name."), $focus: this.$name_input };
		if (!(d.body || "").trim()) return { msg: __("Write the message text."), $focus: this.$body_input };
		if (d.message_type === "Document" && !d.print_format) return { msg: __("Pick the print format the document is printed with."), $focus: this.$dlg.find("[data-link=print_format] input") };
		if (d.message_type === "Image" && !d.attachment) return { msg: __("Upload the image the message is sent with."), $focus: this.$dlg.find("[data-act=upload]") };
		return null;
	}

	async save() {
		if (this.state.saving || !this.data.can_write) return;
		if (this.draft.name && !this.is_dirty()) return;
		const p = this.problem();
		if (p) {
			this.show_error(p.msg);
			this.show_tab("editor");
			p.$focus && p.$focus.trigger("focus");
			return;
		}
		this.state.saving = true;
		this.show_error("");
		this.render_foot_state();
		try {
			const r = await this.opts.save(this.payload());
			const created = !this.draft.name;
			this.draft.name = r.name;
			this.draft.modified = r.modified;
			this.draft.template_name = r.name;
			this.mark_clean();
			sanad.ui.Toast.success(created ? __("Template created") : __("Template saved"));
			this.opts.on_saved && this.opts.on_saved(r);
			if (created) this.data.can_delete = !!this.opts.remove;
		} catch (err) {
			this.show_error((err && err.message) || __("The template could not be saved."));
		} finally {
			this.state.saving = false;
			this.render_foot();
			this.render_status();
		}
	}

	remove() {
		const name = this.draft.name;
		frappe.confirm(__("Delete the template {0}? This cannot be undone.", [`<b>${esc(name)}</b>`]), async () => {
			try {
				await this.opts.remove(name);
				sanad.ui.Toast.success(__("Template deleted"));
				this.opts.on_saved && this.opts.on_saved({ name, deleted: true });
				this.close(true);
			} catch (err) {
				this.show_error(`${(err && err.message) || __("The template could not be deleted.")} ${__("You can switch it off under More options instead.")}`);
			}
		});
	}

	/** Open a template (or a new one) in one call. */
	static open(opts) {
		return new TemplateWindow(opts);
	}
};

export default sanad.ui.TemplateWindow;

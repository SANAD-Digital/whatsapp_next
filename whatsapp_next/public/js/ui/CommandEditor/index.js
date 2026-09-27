// sanad.ui.CommandEditor — the prototype's command editor (`docs/component/Command Editor.dc.html`):
// a full-height modal with a header (command word, "not saved yet", status toggle, close; tabs
// Setup · Permissions (count of allowed types) · Preview; 30-day runs and the function chip), three
// tabs and a footer (Save · Cancel · hint · Delete).
//
//   Setup        340px | 1fr | 1fr — Definition (function picker, synonyms, suggested words, party
//                types, "requires linking") · Variables and options (inputs with an on/off switch,
//                function settings) · Outputs (texts with variable chips, document outputs).
//   Permissions  one tab per allowed party type: Allow All (the list is a blacklist) or Deny All
//                (a whitelist), with contact groups and specific contacts.
//   Preview      320px | 1fr | 420px — assumptions (sender type, sender, account, variables) ·
//                the same options and outputs · the reply as the customer receives it, from a real
//                dry run of the unsaved draft on the server (nothing saved, nothing sent).
//
// Portable: it knows nothing about the host app. The host passes the data source as functions
// (`load`, `load_function`, `save`, `remove`, `preview`, `search_groups`, `search_contacts`) — see
// README.md. Colours are the product tokens (`--wa-*`); every offset is logical, so RTL needs nothing.

frappe.provide("sanad.ui");

(function () {
	const esc = (v) => sanad.ui.escape(v);
	const clone = (v) => JSON.parse(JSON.stringify(v == null ? null : v));
	const NARROW = 1080;

	const SETTING_TYPE = { Check: "check", Int: "number", Select: "select", Data: "text" };

	class CommandEditor {
		/**
		 * @param {Object} opts
		 * @param {string|null} opts.name — command to open; empty for a new one
		 * @param {boolean} [opts.read_only] — view only (no save / delete, controls disabled)
		 * @param {Function} opts.load — `(name) → {command, functions, party_types, function}`
		 * @param {Function} opts.load_function — `(function) → spec {inputs, settings, outputs, ...}`
		 * @param {Function} opts.save — `(payload) → {name, status}`
		 * @param {Function} [opts.remove] — `(name) → any`
		 * @param {Function} opts.preview — `({payload, sender, values}) → result`
		 * @param {Function} opts.search_groups — `(txt) → [{name, label}]`
		 * @param {Function} opts.search_contacts — `(txt, party_type) → [{name, label, phone, links}]`
		 * @param {Function} [opts.on_saved] — `(result)` after a save or a delete
		 * @param {Function} [opts.on_close]
		 */
		constructor(opts = {}) {
			this.opts = opts;
			this.read_only = !!opts.read_only;
			this.ui = {
				tab: "setup",
				fn_open: false,
				fn_q: null,
				syn: "",
				perm_tab: null,
				pick: {},
				pv: { party_type: null, contact: null, account: null, q: null, open: false, results: [], values: {}, loaded_for: null },
				result: null,
				running: false,
				error: null,
			};
			this.data = null;
			this.spec = null;
			this.draft = null;
			this.clean = null;
			this.build();
			this.load(opts.name || null);
		}

		// ---- shell ---------------------------------------------------------------------------------

		build() {
			this.id = sanad.ui.uid("sanad-ce");
			this.previous_focus = document.activeElement;
			this.$root = $(`
				<div class="sanad-kit sanad-ce-layer" role="presentation">
					<div class="sanad-ce-backdrop" data-act="close"></div>
					<div class="sanad-ce" role="dialog" aria-modal="true" aria-labelledby="${this.id}-title">
						<h2 id="${this.id}-title" class="sr-only">${esc(__("Command editor"))}</h2>
						<div class="sanad-ce__body" data-slot="body"></div>
					</div>
				</div>`).appendTo(document.body);
			this.$body = this.$root.find("[data-slot=body]");
			$("body").addClass("sanad-ce-open");
			this.$root.on("click", "[data-act]", (e) => this.on_act(e));
			this.$root.on("input", "[data-in]", (e) => this.on_input(e));
			this.$root.on("change", "[data-ch]", (e) => this.on_change(e));
			this.$root.on("keydown", (e) => this.on_key(e));
			this.$root.on("focusin", "[data-focus-open]", (e) => this.on_focus_open(e));
			this.$root.on("mousedown", (e) => this.on_outside(e));
			this._resize = sanad.ui.debounce(() => this.render(), 150);
			$(window).on(`resize.${this.id}`, this._resize);
			this.$body.html(`<div class="sanad-ce__loading">${esc(__("Loading…"))}</div>`);
		}

		close(force = false) {
			if (!force && this.is_dirty() && !this.read_only) {
				frappe.confirm(__("Discard unsaved changes?"), () => this.close(true));
				return;
			}
			$(window).off(`resize.${this.id}`);
			$("body").removeClass("sanad-ce-open");
			if (this.thread && this.thread.destroy) this.thread.destroy();
			this.$root.remove();
			if (this.previous_focus && this.previous_focus.focus) this.previous_focus.focus();
			this.opts.on_close && this.opts.on_close();
		}

		async load(name) {
			try {
				this.data = await this.opts.load(name);
				this.spec = this.data.function || null;
				this.draft = this.seed(this.data.command);
				this.clean = JSON.stringify(this.draft);
				this.render();
				const first = this.$root.find("[data-f=code]").get(0);
				first && first.focus();
			} catch (err) {
				this.$body.html(`
					<div class="sanad-ce__loading" role="alert">
						<span>${esc(err && err.message ? err.message : __("Something went wrong. Please try again."))}</span>
						<button type="button" class="sanad-ce__btn" data-act="close">${esc(__("Close"))}</button>
					</div>`);
			}
		}

		seed(c) {
			return {
				name: c.name || null,
				code: c.code || "",
				function: c.function || null,
				status: c.status || "Inactive",
				synonyms: (c.synonyms || []).slice(),
				allowed_party_types: (c.allowed_party_types || []).slice(),
				requires_linked_contact: cint(c.requires_linked_contact),
				disabled_inputs: (c.disabled_inputs || []).slice(),
				settings_overrides: Object.assign({}, c.settings_overrides || {}),
				outputs: clone(c.outputs || []),
				access: clone(c.access || {}),
			};
		}

		is_dirty() {
			return !!this.draft && this.clean !== JSON.stringify(this.draft);
		}

		// ---- derived ------------------------------------------------------------------------------

		party_types() {
			return (this.data && this.data.party_types) || [];
		}

		type_label(key) {
			const t = this.party_types().find((p) => p.key === key);
			return t ? t.label : __(key);
		}

		allowed(key) {
			return this.draft.allowed_party_types.includes(key);
		}

		access_of(key) {
			return Object.assign({ mode: "Allow All", groups: [], contacts: [] }, this.draft.access[key] || {});
		}

		set_access(key, patch) {
			this.draft.access[key] = Object.assign(this.access_of(key), patch);
		}

		fn_row() {
			return ((this.data && this.data.functions) || []).find((f) => f.name === this.draft.function) || null;
		}

		setting_value(s) {
			const o = this.draft.settings_overrides;
			return Object.prototype.hasOwnProperty.call(o, s.key) ? o[s.key] : s.default_value;
		}

		/** Payload for save / preview (the allow-list of `commands.save_editor`). */
		payload() {
			const d = this.draft;
			const access = {};
			d.allowed_party_types.forEach((key) => {
				const a = this.access_of(key);
				access[key] = { mode: a.mode, groups: a.groups.map((g) => g.name), contacts: a.contacts.map((c) => c.name) };
			});
			const out = {
				code: (d.code || "").trim(),
				function: d.function,
				synonyms: d.synonyms.join("\n"),
				requires_linked_contact: d.requires_linked_contact,
				allowed_party_types: d.allowed_party_types.slice(),
				disabled_inputs: d.disabled_inputs.slice(),
				settings_overrides: Object.assign({}, d.settings_overrides),
				outputs: clone(d.outputs),
				access,
			};
			if (d.name) out.name = d.name;
			return out;
		}

		// ---- render -------------------------------------------------------------------------------

		render() {
			if (!this.draft) return;
			const active = document.activeElement;
			const focus_key = active && this.$root.get(0).contains(active) ? active.getAttribute("data-f") : null;
			const sel = focus_key && "selectionStart" in active ? [active.selectionStart, active.selectionEnd] : null;
			const scrolls = {};
			this.$root.find("[data-scroll]").each((_, el) => (scrolls[el.getAttribute("data-scroll")] = el.scrollTop));

			const tab = this.ui.tab;
			const body = tab === "setup" ? this.render_setup() : tab === "perms" ? this.render_perms() : this.render_preview();
			this.$body.html(`${this.render_header()}${body}${this.render_footer()}`);
			this.$root.find(".sanad-ce").toggleClass("sanad-ce--readonly", this.read_only);
			if (this.read_only) this.$body.find("input, textarea, select").not("[data-keep]").prop("disabled", true);

			Object.keys(scrolls).forEach((k) => {
				const el = this.$root.find(`[data-scroll="${k}"]`).get(0);
				if (el) el.scrollTop = scrolls[k];
			});
			if (focus_key) {
				const el = this.$root.find(`[data-f="${focus_key}"]`).get(0);
				if (el) {
					el.focus();
					if (sel && "setSelectionRange" in el) {
						try {
							el.setSelectionRange(sel[0], sel[1]);
						} catch (e) {
							// number inputs do not support a selection
						}
					}
				}
			}
			if (tab === "preview") this.mount_thread();
		}

		render_header() {
			const d = this.draft;
			const on = d.status === "Active";
			const runs = sanad.ui.format_int(cint(this.data.command.runs_30d));
			const fn = this.fn_row();
			const tabs = [
				{ key: "setup", label: __("Setup") },
				{ key: "perms", label: __("Permissions"), count: d.allowed_party_types.length },
				{ key: "preview", label: __("Preview") },
			];
			return `
				<div class="sanad-ce__head">
					<div class="sanad-ce__head-row">
						<span class="sanad-ce__word">
							<label class="sanad-ce__word-label" for="${this.id}-code">${esc(__("Command"))}</label>
							<input id="${this.id}-code" type="text" dir="ltr" class="sanad-ce__code" data-f="code" data-in="code" value="${esc(d.code)}" placeholder="${esc(__("Command word"))}" autocomplete="off" />
							${this.is_dirty() ? `<span class="sanad-ce__dirty" data-slot="dirty"><span class="sanad-ce__dot"></span>${esc(__("Not saved yet"))}</span>` : `<span data-slot="dirty"></span>`}
						</span>
						<span class="sanad-ce__head-end">
							<button type="button" class="sanad-ce__status${on ? " is-on" : ""}" data-act="toggle-status" role="switch" aria-checked="${on}" title="${esc(__("Turn the command on or off"))}">
								${esc(on ? __("Enabled", null, "Command Editor") : __("Stopped"))}<span class="sanad-ce__track"><span class="sanad-ce__knob"></span></span>
							</button>
							<button type="button" class="sanad-ce__x" data-act="close" data-keep title="${esc(__("Close (Esc)"))}" aria-label="${esc(__("Close"))}">×</button>
						</span>
					</div>
					<div class="sanad-ce__head-row sanad-ce__head-row--tabs">
						<span class="sanad-ce__tabs" role="tablist">
							${tabs
								.map(
									(t) => `<button type="button" role="tab" class="sanad-ce__tab${this.ui.tab === t.key ? " is-sel" : ""}" aria-selected="${this.ui.tab === t.key}" data-act="tab" data-key="${t.key}" data-keep>
										${esc(t.label)}${t.count != null ? `<span class="sanad-ce__count" dir="ltr">${sanad.ui.format_int(t.count)}</span>` : ""}
									</button>`
								)
								.join("")}
						</span>
						<span class="sanad-ce__meta">
							<span class="sanad-ce__runs">${this.runs_html(runs)}</span>
							<button type="button" class="sanad-ce__fnchip" data-act="open-fn" title="${esc(__("Change the function"))}">${esc(fn ? fn.function_name || fn.name : __("No function"))}</button>
						</span>
					</div>
				</div>`;
		}

		runs_html(runs) {
			const text = __("{0} runs in 30 days", ["\u0000"], "Command Editor");
			const [before, after] = text.split("\u0000");
			return `${esc(before || "")}<span class="sanad-ce__runs-n" dir="ltr">${esc(runs)}</span>${esc(after || "")}`;
		}

		col(title, body, { link = null, tone = "surface", key = "", span = false } = {}) {
			return `
				<section class="sanad-ce__col sanad-ce__col--${tone}${span ? " sanad-ce__col--span" : ""}" data-scroll="${key}" aria-label="${esc(title)}">
					<header class="sanad-ce__col-head">
						<span class="sanad-ce__col-title">${esc(title)}</span>
						${link ? `<button type="button" class="sanad-ce__link" data-act="${link.act}">${esc(link.label)}</button>` : ""}
					</header>
					<div class="sanad-ce__col-body">${body}</div>
				</section>`;
		}

		// ---- setup --------------------------------------------------------------------------------

		render_setup() {
			return `<div class="sanad-ce__grid sanad-ce__grid--setup">
				${this.col(__("Definition"), this.render_definition(), { key: "def", span: true })}
				${this.col(__("Variables and options"), this.render_vars(), { key: "vars", link: { act: "reset-fn", label: __("Restore function defaults") } })}
				${this.col(__("Outputs of this command"), this.render_outputs(), { key: "outs", tone: "bg", link: { act: "reset-outs", label: __("Restore default texts") } })}
			</div>`;
		}

		render_definition() {
			const d = this.draft;
			const spec = this.spec;
			const fn = this.fn_row();
			const q = (this.ui.fn_q == null ? "" : this.ui.fn_q).trim().toLowerCase();
			const matches = ((this.data && this.data.functions) || [])
				.filter((f) => !q || `${f.function_name || ""} ${f.name} ${f.category || ""}`.toLowerCase().includes(q))
				.slice(0, 40);
			const fn_value = this.ui.fn_q == null ? (fn ? fn.function_name || fn.name : "") : this.ui.fn_q;
			const suggested = (spec && spec.suggested_commands) || [];
			return `
				<div class="sanad-ce__field">
					<label class="sanad-ce__label" for="${this.id}-fn">${esc(__("Function to run"))}</label>
					<span class="sanad-ce__combo" data-pop="fn">
						<input id="${this.id}-fn" type="text" class="sanad-ce__input" data-f="fn" data-in="fn-q" data-focus-open="fn" value="${esc(fn_value)}" placeholder="${esc(__("Search by function name or group…"))}" autocomplete="off" role="combobox" aria-expanded="${this.ui.fn_open}" aria-controls="${this.id}-fnlist" />
						${
							this.ui.fn_open
								? `<span class="sanad-ce__pop" id="${this.id}-fnlist" role="listbox">
									${matches
										.map(
											(f) => `<button type="button" role="option" class="sanad-ce__opt${f.name === d.function ? " is-sel" : ""}" aria-selected="${f.name === d.function}" data-act="pick-fn" data-key="${esc(f.name)}">
												${esc(f.function_name || f.name)}<span class="sanad-ce__opt-sub">${esc(f.category || "")}${f.status === "Active" ? "" : ` · ${esc(__("paused"))}`}</span>
											</button>`
										)
										.join("")}
									${matches.length ? "" : `<span class="sanad-ce__none">${esc(__("No matching functions."))}</span>`}
								</span>`
								: ""
						}
					</span>
					${spec && spec.when_to_use ? `<span class="sanad-ce__note">${esc(spec.when_to_use)}</span>` : ""}
				</div>
				${
					fn && fn.status !== "Active"
						? `<div class="sanad-ce__callout sanad-ce__callout--warn"><strong>${esc(__("The function is stopped in the Functions Center"))}</strong><span>${esc(
								__("The command will match the text but will not run until the function is started.")
						  )}</span></div>`
						: ""
				}
				<div class="sanad-ce__field">
					<span class="sanad-ce__label">${esc(__("Synonyms"))}</span>
					<div class="sanad-ce__chips">
						${d.synonyms
							.map(
								(s, i) => `<span class="sanad-ce__chip sanad-ce__chip--pri">${esc(s)}<button type="button" class="sanad-ce__chip-x" data-act="rm-syn" data-key="${i}" title="${esc(__("Remove"))}" aria-label="${esc(
									__("Remove {0}", [s])
								)}">×</button></span>`
							)
							.join("")}
						<input type="text" class="sanad-ce__syn" data-f="syn" data-in="syn" value="${esc(this.ui.syn)}" placeholder="${esc(__("Add a synonym, then Enter"))}" aria-label="${esc(__("Add a synonym"))}" />
					</div>
					<span class="sanad-ce__hint">${esc(__("Any inbound text that matches the command or one of its synonyms runs the function directly."))}</span>
				</div>
				${
					suggested.length
						? `<div class="sanad-ce__field sanad-ce__field--tight">
							<span class="sanad-ce__note">${esc(__("Commands suggested by the function — click to use:"))}</span>
							<span class="sanad-ce__chips">${suggested
								.map((s) => `<button type="button" class="sanad-ce__chip sanad-ce__chip--ghost" data-act="use-word" data-key="${esc(s)}">${esc(s)}</button>`)
								.join("")}</span>
						</div>`
						: ""
				}
				<div class="sanad-ce__field">
					<span class="sanad-ce__label">${esc(__("Party types allowed"))}</span>
					<div class="sanad-ce__chips">
						${this.party_types()
							.map(
								(p) => `<button type="button" class="sanad-ce__pill${this.allowed(p.key) ? " is-on" : ""}" aria-pressed="${this.allowed(p.key)}" data-act="toggle-type" data-key="${esc(p.key)}">${esc(p.label)}<span class="sanad-ce__mark" aria-hidden="true">${
									this.allowed(p.key) ? "✓" : ""
								}</span></button>`
							)
							.join("")}
					</div>
					${d.allowed_party_types.length ? "" : `<span class="sanad-ce__note sanad-ce__note--danger">${esc(__("No type allowed — the command will not run for any party."))}</span>`}
					<span class="sanad-ce__note">${esc(__("Each type's white and black lists are in the Permissions tab."))}</span>
				</div>
				<label class="sanad-ce__switch-card">
					<span class="sanad-ce__switch-text"><span class="sanad-ce__switch-title">${esc(__("Requires the party to be linked to an account"))}</span><span class="sanad-ce__note">${esc(
						__("Messages from numbers that are not linked are refused with an explanatory reply.")
					)}</span></span>
					<input type="checkbox" class="sanad-ce__check" data-ch="link" ${d.requires_linked_contact ? "checked" : ""} />
				</label>`;
		}

		render_vars() {
			const spec = this.spec;
			if (!spec) return `<span class="sanad-ce__empty">${esc(__("Pick a function in the Definition column to see its variables, options and outputs."))}</span>`;
			const off = this.draft.disabled_inputs;
			const vars = (spec.inputs || [])
				.map((v) => {
					const on = !off.includes(v.key);
					return `<div class="sanad-ce__card${on ? "" : " is-off"}">
						<div class="sanad-ce__card-row">
							<span class="sanad-ce__card-title">
								<span class="sanad-ce__mono" dir="ltr">#${esc(v.key)}</span>
								<span class="sanad-ce__sub">${esc(v.label || "")}</span>
								<span class="sanad-ce__tag sanad-ce__mono" dir="ltr">${esc(v.type || "str")}</span>
								${v.required ? `<span class="sanad-ce__tag sanad-ce__tag--warn">${esc(__("Required"))}</span>` : ""}
							</span>
							<input type="checkbox" class="sanad-ce__check" data-ch="var" data-key="${esc(v.key)}" ${on ? "checked" : ""} title="${esc(__("Enable the variable in this command"))}" aria-label="${esc(
								__("Enable {0} in this command", [v.label || v.key])
							)}" />
						</div>
						${v.details ? `<span class="sanad-ce__note">${esc(v.details)}</span>` : ""}
						${v.example ? `<span class="sanad-ce__example sanad-ce__mono" dir="ltr">${esc(v.example)}</span>` : ""}
					</div>`;
				})
				.join("");
			return `
				${
					(spec.inputs || []).length
						? `<div class="sanad-ce__field sanad-ce__field--tight"><span class="sanad-ce__label">${esc(__("Variables the command text can pass"))}</span><div class="sanad-ce__stack">${vars}</div></div>`
						: ""
				}
				${
					(spec.settings || []).length
						? `<div class="sanad-ce__field sanad-ce__field--tight"><span class="sanad-ce__label">${esc(__("Function options in this command"))}</span><div class="sanad-ce__stack">${(spec.settings || [])
								.map((s) => this.render_setting(s, "stack"))
								.join("")}</div></div>`
						: ""
				}
				${(spec.inputs || []).length || (spec.settings || []).length ? "" : `<span class="sanad-ce__empty">${esc(__("This function takes no variables and has no options."))}</span>`}`;
		}

		setting_note(s) {
			const def = s.fieldtype === "Check" ? (cint(s.default_value) ? __("Yes") : __("No")) : s.default_value == null || s.default_value === "" ? "—" : s.default_value;
			return __("Default: {0}", [def]) + (s.notes ? ` — ${s.notes}` : "");
		}

		render_setting(s, layout) {
			const kind = SETTING_TYPE[s.fieldtype] || "text";
			const value = this.setting_value(s);
			const f = `set-${s.key}-${layout}`;
			const type_label = { check: __("Yes / No"), number: __("Number"), select: __("List"), text: __("Text") }[kind];
			let control;
			if (kind === "check") control = `<input type="checkbox" class="sanad-ce__check" data-ch="setting" data-key="${esc(s.key)}" ${cint(value) ? "checked" : ""} aria-label="${esc(s.label)}" />`;
			else if (kind === "number") control = `<input type="number" class="sanad-ce__input sanad-ce__input--num sanad-ce__mono" data-f="${esc(f)}" data-in="setting" data-key="${esc(s.key)}" value="${esc(value == null ? "" : value)}" aria-label="${esc(s.label)}" />`;
			else if (kind === "select")
				control = `<select class="sanad-ce__input sanad-ce__select" data-ch="setting" data-key="${esc(s.key)}" aria-label="${esc(s.label)}">${(s.choices || [])
					.map((c) => `<option value="${esc(c)}" ${String(value) === String(c) ? "selected" : ""}>${esc(c)}</option>`)
					.join("")}</select>`;
			else control = `<input type="text" class="sanad-ce__input sanad-ce__input--text" data-f="${esc(f)}" data-in="setting" data-key="${esc(s.key)}" value="${esc(value == null ? "" : value)}" aria-label="${esc(s.label)}" />`;
			if (layout === "row") {
				return `<div class="sanad-ce__card sanad-ce__card--row sanad-ce__card--surface">
					<span class="sanad-ce__switch-text"><span class="sanad-ce__card-name">${esc(s.label)}</span><span class="sanad-ce__note">${esc(this.setting_note(s))}</span></span>
					<span class="sanad-ce__control">${control}</span>
				</div>`;
			}
			return `<div class="sanad-ce__card">
				<div class="sanad-ce__card-row">
					<span class="sanad-ce__card-title"><span class="sanad-ce__card-name">${esc(s.label)}</span><span class="sanad-ce__tag">${esc(type_label)}</span></span>
					<span class="sanad-ce__control">${control}</span>
				</div>
				<span class="sanad-ce__note">${esc(this.setting_note(s))}</span>
			</div>`;
		}

		render_outputs(compact = false) {
			const outs = this.draft.outputs || [];
			if (!this.spec) return `<span class="sanad-ce__empty">${esc(__("Pick a function in the Definition column to see its variables, options and outputs."))}</span>`;
			if (!outs.length) return `<span class="sanad-ce__empty sanad-ce__empty--surface">${esc(__("This function defines no outputs."))}</span>`;
			return outs
				.map((o, i) => {
					const is_doc = o.output_type === "Document";
					const text = o.template == null ? o.default_template || "" : o.template;
					const rows = Math.min(7, Math.max(3, Math.ceil(String(text).length / 52)));
					const vars = String(o.variables || "")
						.split(/[,\n]/)
						.map((s) => s.trim())
						.filter(Boolean);
					const k = compact ? "pv" : "st";
					return `<div class="sanad-ce__out">
						<span class="sanad-ce__card-row sanad-ce__card-row--wrap">
							<span class="sanad-ce__out-name">${esc(o.label || o.output_key)}</span>
							<span class="sanad-ce__tag">${esc(is_doc ? __("Document", null, "Command Editor") : __("Text"))}</span>
						</span>
						${o.notes && !compact ? `<span class="sanad-ce__note">${esc(o.notes)}</span>` : ""}
						${
							is_doc
								? `${compact ? "" : `<label class="sanad-ce__sub" for="${this.id}-pf-${i}">${esc(__("Print format"))}</label><input id="${this.id}-pf-${i}" type="text" dir="ltr" class="sanad-ce__input sanad-ce__mono sanad-ce__input--sm" data-f="out-pf-${i}-${k}" data-in="out-pf" data-key="${i}" value="${esc(o.print_format || "")}" placeholder="${esc(__("Standard"))}" />`}
								   ${compact ? "" : `<label class="sanad-ce__sub" for="${this.id}-fn-${i}">${esc(__("Attached file name"))}</label>`}<input ${compact ? "" : `id="${this.id}-fn-${i}"`} type="text" class="sanad-ce__input sanad-ce__input--sm" data-f="out-file-${i}-${k}" data-in="out-file" data-key="${i}" value="${esc(o.file_name_template || "")}" aria-label="${esc(__("Attached file name"))}" />`
								: `<textarea class="sanad-ce__textarea" rows="${rows}" data-f="out-${i}-${k}" data-in="out-text" data-key="${i}" aria-label="${esc(o.label || o.output_key)}">${esc(text)}</textarea>`
						}
						${
							!is_doc && vars.length && !compact
								? `<span class="sanad-ce__chips sanad-ce__chips--tight">${vars
										.map((v) => `<button type="button" class="sanad-ce__token sanad-ce__mono" dir="ltr" data-act="insert-var" data-key="${i}" data-var="${esc(v)}" title="${esc(__("Add to the text"))}">{{ ${esc(v)} }}</button>`)
										.join("")}</span>`
								: ""
						}
					</div>`;
				})
				.join("");
		}

		// ---- permissions --------------------------------------------------------------------------

		render_perms() {
			const keys = this.draft.allowed_party_types;
			if (!keys.length) {
				return `<div class="sanad-ce__pane" data-scroll="perms"><span class="sanad-ce__empty sanad-ce__empty--surface">${esc(
					__("No party is allowed yet. Pick party types in the Setup tab to manage their lists here.")
				)}</span></div>`;
			}
			const key = keys.includes(this.ui.perm_tab) ? this.ui.perm_tab : keys[0];
			const a = this.access_of(key);
			const deny = a.mode === "Deny All";
			const list = deny ? __("the whitelist") : __("the blacklist");
			const tone = deny ? "pri" : "dg";
			const tabs = keys
				.map((k) => {
					const x = this.access_of(k);
					return `<button type="button" role="tab" class="sanad-ce__seg${k === key ? " is-sel" : ""}" aria-selected="${k === key}" data-act="perm-tab" data-key="${esc(k)}" data-keep>${esc(this.type_label(k))}<span class="sanad-ce__seg-n" dir="ltr">${sanad.ui.format_int(
						x.groups.length + x.contacts.length
					)}</span></button>`;
				})
				.join("");
			const modes = [
				{ key: "Allow All", label: __("Everyone allowed — set the blacklist") },
				{ key: "Deny All", label: __("Everyone denied — set the whitelist") },
			]
				.map((m) => `<button type="button" class="sanad-ce__pill${a.mode === m.key ? " is-on" : ""}" aria-pressed="${a.mode === m.key}" data-act="perm-mode" data-key="${esc(m.key)}">${esc(m.label)}</button>`)
				.join("");
			return `<div class="sanad-ce__pane" data-scroll="perms">
				<span class="sanad-ce__segs" role="tablist">${tabs}</span>
				<div class="sanad-ce__perm">
					<span class="sanad-ce__card-row sanad-ce__card-row--wrap">
						<span class="sanad-ce__switch-text"><span class="sanad-ce__perm-title">${esc(`${this.type_label(key)} — ${deny ? __("Whitelist") : __("Blacklist")}`)}</span><span class="sanad-ce__note">${esc(
							deny ? __("Everyone is denied; only those on the whitelist below are allowed.") : __("Everyone is allowed; only those on the blacklist below are denied.")
						)}</span></span>
						<label class="sanad-ce__inline-check">${esc(__("Requires linking"))}<input type="checkbox" class="sanad-ce__check" data-ch="link" ${this.draft.requires_linked_contact ? "checked" : ""} /></label>
					</span>
					<span class="sanad-ce__chips">${modes}</span>
					<div class="sanad-ce__pickers">
						${this.render_picker(key, "g", __("Contact groups — {0}", [list]), __("Search contact groups…"), a.groups, tone, __("No matching groups."), __("No groups added."))}
						${this.render_picker(key, "c", __("Specific contacts — {0}", [list]), __("Search contacts by name or number…"), a.contacts, tone, __("No matching contacts."), __("No contacts added."))}
					</div>
				</div>
			</div>`;
		}

		render_picker(type, kind, label, placeholder, items, tone, none, empty) {
			const k = `${type}-${kind}`;
			const p = this.ui.pick[k] || { q: "", open: false, results: [] };
			const taken = new Set(items.map((x) => x.name));
			const results = (p.results || []).filter((r) => !taken.has(r.name));
			return `<div class="sanad-ce__picker" data-pop="${esc(k)}">
				<span class="sanad-ce__label">${esc(label)}</span>
				<span class="sanad-ce__combo">
					<input type="text" class="sanad-ce__input sanad-ce__input--surface" data-f="pick-${esc(k)}" data-in="pick" data-key="${esc(k)}" data-focus-open="${esc(k)}" value="${esc(p.q)}" placeholder="${esc(placeholder)}" autocomplete="off" aria-label="${esc(label)}" />
					${
						p.open
							? `<span class="sanad-ce__pop sanad-ce__pop--sm" role="listbox">
								${results
									.map(
										(r) => `<button type="button" role="option" class="sanad-ce__opt" data-act="pick-add" data-key="${esc(k)}" data-name="${esc(r.name)}">${esc(r.label || r.name)}${
											r.phone ? `<span class="sanad-ce__opt-sub sanad-ce__mono" dir="ltr">${esc(r.phone)}</span>` : ""
										}</button>`
									)
									.join("")}
								${p.loading ? `<span class="sanad-ce__none">${esc(__("Loading…"))}</span>` : results.length ? "" : `<span class="sanad-ce__none">${esc(p.error || none)}</span>`}
							</span>`
							: ""
					}
				</span>
				<span class="sanad-ce__chips">
					${items
						.map(
							(x) => `<span class="sanad-ce__chip sanad-ce__chip--${tone}">${esc(x.label || x.name)}<button type="button" class="sanad-ce__chip-x" data-act="pick-rm" data-key="${esc(k)}" data-name="${esc(x.name)}" aria-label="${esc(
								__("Remove {0}", [x.label || x.name])
							)}">×</button></span>`
						)
						.join("")}
					${items.length ? "" : `<span class="sanad-ce__note">${esc(empty)}</span>`}
				</span>
			</div>`;
		}

		// ---- preview ------------------------------------------------------------------------------

		pv_type() {
			const pv = this.ui.pv;
			return pv.party_type || this.draft.allowed_party_types[0] || (this.party_types()[0] || {}).key || null;
		}

		pv_links() {
			const c = this.ui.pv.contact;
			if (!c) return [];
			return (c.links || []).filter((l) => l.link_doctype === this.pv_type());
		}

		pv_inputs() {
			const off = this.draft.disabled_inputs;
			return ((this.spec && this.spec.inputs) || []).filter((v) => !off.includes(v.key));
		}

		render_preview() {
			const pv = this.ui.pv;
			const type = this.pv_type();
			const blocked = type && !this.allowed(type);
			const c = pv.contact;
			const links = this.pv_links();
			const unlinked = !c || !links.length;
			const account = links.find((l) => l.link_name === pv.account) || links[0] || null;
			const inputs = this.pv_inputs();
			const types = this.party_types()
				.map(
					(p) => `<button type="button" class="sanad-ce__pill${p.key === type ? " is-on" : ""}" aria-pressed="${p.key === type}" data-act="pv-type" data-key="${esc(p.key)}" data-keep>${esc(p.label)}${
						this.allowed(p.key) ? "" : ` ${esc(__("(not allowed)"))}`
					}</button>`
				)
				.join("");
			const search_value = pv.q == null ? (c ? c.label || c.phone || "" : "") : pv.q;
			const assumptions = `
				<div class="sanad-ce__field sanad-ce__field--tight">
					<span class="sanad-ce__label">${esc(__("Sender party type"))}</span>
					<span class="sanad-ce__chips">${types}</span>
					${blocked ? `<span class="sanad-ce__note sanad-ce__note--warn">${esc(__("This type is not allowed to use the command — the preview shows the refusal."))}</span>` : ""}
				</div>
				<div class="sanad-ce__field">
					<label class="sanad-ce__label" for="${this.id}-pv">${esc(__("Sender", null, "Command Editor"))}</label>
					<span class="sanad-ce__combo" data-pop="pv">
						<input id="${this.id}-pv" type="text" class="sanad-ce__input" data-f="pv-q" data-in="pv-q" data-focus-open="pv" data-keep value="${esc(search_value)}" placeholder="${esc(__("Search by name or number…"))}" autocomplete="off" />
						${
							pv.open
								? `<span class="sanad-ce__pop" role="listbox">
									${(pv.results || [])
										.map(
											(r) => `<button type="button" role="option" class="sanad-ce__opt${c && r.name === c.name ? " is-sel" : ""}" data-act="pv-pick" data-name="${esc(r.name)}" data-keep>${esc(r.label || __("Unnamed"))}<span class="sanad-ce__opt-sub sanad-ce__mono" dir="ltr">${esc(r.phone || "")}</span></button>`
										)
										.join("")}
									${pv.loading ? `<span class="sanad-ce__none">${esc(__("Loading…"))}</span>` : (pv.results || []).length ? "" : `<span class="sanad-ce__none">${esc(pv.error || __("No matching contacts."))}</span>`}
								</span>`
								: ""
						}
					</span>
					${!c ? `<span class="sanad-ce__note">${esc(__("No sender picked — the preview assumes a number that is not linked."))}</span>` : ""}
					${unlinked && this.draft.requires_linked_contact ? `<span class="sanad-ce__note sanad-ce__note--warn">${esc(__("This contact is not linked to an account and the command requires it — the preview shows the refusal."))}</span>` : ""}
				</div>
				${
					links.length
						? `<div class="sanad-ce__box">
							<span class="sanad-ce__note">${esc(__("Accounts linked to the contact"))}</span>
							<span class="sanad-ce__chips">${links
								.map((l) => `<button type="button" class="sanad-ce__pill${account && l.link_name === account.link_name ? " is-on" : ""}" data-act="pv-acc" data-key="${esc(l.link_name)}" data-keep>${esc(l.link_title || l.link_name)}</button>`)
								.join("")}</span>
						</div>`
						: ""
				}
				${
					inputs.length
						? `<div class="sanad-ce__field sanad-ce__field--tight">
							<span class="sanad-ce__card-row"><span class="sanad-ce__label">${esc(__("Variables passed in the command text"))}</span><button type="button" class="sanad-ce__link" data-act="pv-fill" data-keep>${esc(__("Fill with examples"))}</button></span>
							<div class="sanad-ce__stack">${inputs
								.map((v) => {
									const val = pv.values[v.key] || "";
									const missing = v.required && !String(val).trim();
									return `<span class="sanad-ce__card${missing ? " is-missing" : ""}">
										<span class="sanad-ce__card-row"><span class="sanad-ce__mono" dir="ltr">#${esc(v.key)}</span>${v.required ? `<span class="sanad-ce__tag sanad-ce__tag--warn">${esc(__("Required"))}</span>` : ""}</span>
										<input type="text" dir="ltr" class="sanad-ce__input sanad-ce__input--surface sanad-ce__mono" data-f="pv-${esc(v.key)}" data-in="pv-val" data-key="${esc(v.key)}" data-keep value="${esc(val)}" placeholder="${esc(v.example || v.key)}" aria-label="${esc(v.label || v.key)}" />
										<span class="sanad-ce__note">${esc(v.label || "")}</span>
									</span>`;
								})
								.join("")}</div>
						</div>`
						: ""
				}`;
			const options = `
				<span class="sanad-ce__note">${esc(__("Changes here edit the command's own settings — save for them to apply to inbound messages."))}</span>
				${((this.spec && this.spec.settings) || []).map((s) => this.render_setting(s, "row")).join("")}
				${this.render_outputs(true)}`;
			const r = this.ui.result;
			const missing = r && r.missing && r.missing.length && r.status !== "Blocked";
			const result = `
				<div class="sanad-ce__phone">
					<div class="sanad-ce__phone-head">
						<span class="sanad-ce__avatar" aria-hidden="true">${esc(String((c && c.label) || "?").trim().slice(0, 2))}</span>
						<span class="sanad-ce__switch-text"><span class="sanad-ce__card-name">${esc(c ? c.label || __("Unnamed") : __("Unknown number"))}</span><span class="sanad-ce__opt-sub sanad-ce__mono" dir="ltr">${esc((c && c.phone) || "")}</span></span>
						<span class="sanad-ce__tag ${unlinked ? "sanad-ce__tag--warn" : "sanad-ce__tag--ok"}">${esc(unlinked ? __("Not linked") : __("Linked to an account", null, "Command Editor"))}</span>
					</div>
					<span class="sanad-ce__phone-note">${esc(__("The reply is built from the output texts and the function's options, run for real without sending."))}</span>
					<div class="sanad-ce__thread" data-slot="thread" aria-live="polite"></div>
				</div>
				${
					r && r.status === "Blocked" && !r.reply_sent
						? `<div class="sanad-ce__callout sanad-ce__callout--muted"><span>${esc(__("No reply is sent for a refusal: the receipt reply is off in Settings."))}</span></div>`
						: ""
				}
				${
					missing
						? `<div class="sanad-ce__callout sanad-ce__callout--warn"><strong>${esc(__("Not enough data to run the function"))}</strong><span>${esc(
								__("The message text must contain: {0}", [r.missing.map((m) => `#${m.key}${m.label ? ` (${m.label})` : ""}`).join(__(", "))])
						  )}</span></div>`
						: ""
				}
				${this.ui.error ? `<div class="sanad-ce__callout sanad-ce__callout--danger" role="alert"><span>${esc(this.ui.error)}</span></div>` : ""}`;
			return `<div class="sanad-ce__grid sanad-ce__grid--preview">
				${this.col(__("Preview assumptions"), assumptions, { key: "pv-a" })}
				${this.col(__("Function options and outputs"), options, { key: "pv-o", tone: "bg", link: { act: "reset-all", label: __("Restore defaults", null, "Command Editor") } })}
				<section class="sanad-ce__col sanad-ce__col--bg sanad-ce__col--last" data-scroll="pv-r" aria-label="${esc(__("Result as the customer receives it"))}">
					<header class="sanad-ce__col-head">
						<span class="sanad-ce__col-title">${esc(__("Result as the customer receives it"))}</span>
						<span class="sanad-ce__sim"><span class="sanad-ce__dot sanad-ce__dot--wn"></span>${esc(__("Simulation — nothing sent"))}</span>
					</header>
					<div class="sanad-ce__col-body sanad-ce__col-body--result">${result}</div>
				</section>
			</div>`;
		}

		mount_thread() {
			const $slot = this.$root.find("[data-slot=thread]");
			if (!$slot.length) return;
			const r = this.ui.result;
			const now = frappe.datetime.now_datetime();
			const text = (r && r.text) || this.draft.code;
			const rows = [{ direction: "Inbound", name: "pv-in", ts: now, message_type: "Text", body: text }];
			if (this.ui.running && !r) {
				$slot.html(`<span class="sanad-ce__none">${esc(__("Running the preview…"))}</span>`);
				return;
			}
			((r && r.replies) || []).forEach((rep, i) => {
				const doc = rep.message_type === "Document";
				rows.push({
					direction: "Outbound",
					name: `pv-out-${i}`,
					ts: now,
					status: "Read",
					message_type: "Text",
					body: doc ? `📎 ${rep.file_name || __("Document", null, "Command Editor")}` : rep.body || "",
				});
			});
			if (typeof sanad.ui.ChatThread === "function") {
				if (this.thread && this.thread.destroy) this.thread.destroy();
				this.thread = new sanad.ui.ChatThread({ wrapper: $slot, rows, empty_text: __("No reply") });
				this.$root.find("[data-slot=thread]").toggleClass("is-running", !!this.ui.running);
			} else {
				$slot.html(rows.map((x) => `<p class="sanad-ce__bubble sanad-ce__bubble--${x.direction === "Inbound" ? "in" : "out"}">${esc(x.body)}</p>`).join(""));
			}
		}

		schedule_preview() {
			if (this.ui.tab !== "preview" || !this.draft.function) return;
			clearTimeout(this._pv_timer);
			this._pv_timer = setTimeout(() => this.run_preview(), 450);
		}

		async run_preview() {
			if (!this.draft.function) return;
			const pv = this.ui.pv;
			const c = pv.contact;
			const links = this.pv_links();
			const account = links.find((l) => l.link_name === pv.account) || links[0] || null;
			const token = (this._pv_token = (this._pv_token || 0) + 1);
			this.ui.running = true;
			this.$root.find("[data-slot=thread]").addClass("is-running");
			try {
				const result = await this.opts.preview({
					payload: this.payload(),
					sender: c
						? { contact: c.name, label: c.label, phone: c.phone, party_type: account ? account.link_doctype : null, party_name: account ? account.link_name : null }
						: { phone: null },
					values: Object.assign({}, pv.values),
				});
				if (token !== this._pv_token) return;
				this.ui.result = result;
				this.ui.error = null;
			} catch (err) {
				if (token !== this._pv_token) return;
				this.ui.error = err && err.message ? err.message : __("Something went wrong. Please try again.");
			} finally {
				if (token === this._pv_token) {
					this.ui.running = false;
					if (this.ui.tab === "preview") this.render();
				}
			}
		}

		async load_pv_contacts(q) {
			const pv = this.ui.pv;
			const type = this.pv_type();
			pv.loading = true;
			pv.error = null;
			try {
				const rows = await this.opts.search_contacts(q || "", type);
				if (pv.q !== q && q !== "") return;
				pv.results = rows || [];
			} catch (err) {
				pv.results = [];
				pv.error = err && err.message;
			}
			pv.loading = false;
			return pv.results;
		}

		async enter_preview() {
			const pv = this.ui.pv;
			const type = this.pv_type();
			if (pv.loaded_for !== type) {
				pv.loaded_for = type;
				const rows = await this.load_pv_contacts("");
				if (!pv.contact && rows && rows.length) pv.contact = rows[0];
				this.render();
			}
			this.run_preview();
		}

		// ---- footer -------------------------------------------------------------------------------

		foot_hint() {
			const d = this.draft;
			if (this.read_only) return __("View only — you can't change commands.");
			if (!d.allowed_party_types.length) return __("Pick at least one party type before saving.");
			if (d.status === "Active")
				return __("After saving, the command works immediately on inbound messages from: {0}", [d.allowed_party_types.map((k) => this.type_label(k)).join(__(", "))]);
			return __("The command is stopped; start it to work on inbound messages.");
		}

		render_footer() {
			const can_delete = !this.read_only && this.draft.name && this.opts.remove;
			return `<div class="sanad-ce__foot">
				${this.read_only ? "" : `<button type="button" class="sanad-ce__btn sanad-ce__btn--pri" data-act="save">${esc(__("Save command"))}</button>`}
				<button type="button" class="sanad-ce__btn" data-act="close" data-keep>${esc(this.read_only ? __("Close") : __("Cancel"))}</button>
				<span class="sanad-ce__foot-hint" data-slot="hint">${esc(this.foot_hint())}</span>
				${can_delete ? `<button type="button" class="sanad-ce__btn sanad-ce__btn--danger" data-act="delete">${esc(__("Delete command"))}</button>` : ""}
			</div>`;
		}

		/** Update the bits that depend on the draft without a full render (typing stays smooth). */
		touch() {
			const dirty = this.is_dirty();
			const $dirty = this.$root.find("[data-slot=dirty]");
			if (dirty && !$dirty.hasClass("sanad-ce__dirty")) $dirty.replaceWith(`<span class="sanad-ce__dirty" data-slot="dirty"><span class="sanad-ce__dot"></span>${esc(__("Not saved yet"))}</span>`);
			if (!dirty && $dirty.hasClass("sanad-ce__dirty")) $dirty.replaceWith(`<span data-slot="dirty"></span>`);
			this.$root.find("[data-slot=hint]").text(this.foot_hint());
			this.schedule_preview();
		}

		// ---- events -------------------------------------------------------------------------------

		blocked(e) {
			return this.read_only && !$(e.currentTarget || e.target).closest("[data-keep]").length;
		}

		on_key(e) {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				const pv = this.ui.pv;
				const open_pick = Object.keys(this.ui.pick).some((k) => this.ui.pick[k].open);
				if (pv.open) pv.open = false;
				else if (this.ui.fn_open) this.ui.fn_open = false;
				else if (open_pick) this.ui.pick = {};
				else return this.close();
				this.render();
				return;
			}
			if (e.key === "Enter" && e.target.getAttribute("data-in") === "syn") {
				e.preventDefault();
				const v = String(this.ui.syn || "").trim();
				this.ui.syn = "";
				if (v && !this.draft.synonyms.includes(v) && v !== this.draft.code) this.draft.synonyms.push(v);
				this.render();
				this.touch();
				return;
			}
			if (e.key === "Tab") {
				const nodes = this.$root.find("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])").filter(":visible").get();
				if (!nodes.length) return;
				const first = nodes[0];
				const last = nodes[nodes.length - 1];
				if (e.shiftKey && document.activeElement === first) {
					e.preventDefault();
					last.focus();
				} else if (!e.shiftKey && document.activeElement === last) {
					e.preventDefault();
					first.focus();
				}
			}
		}

		on_outside(e) {
			const $t = $(e.target);
			let changed = false;
			if (this.ui.fn_open && !$t.closest('[data-pop="fn"]').length) {
				this.ui.fn_open = false;
				this.ui.fn_q = null;
				changed = true;
			}
			if (this.ui.pv.open && !$t.closest('[data-pop="pv"]').length) {
				this.ui.pv.open = false;
				this.ui.pv.q = null;
				changed = true;
			}
			Object.keys(this.ui.pick).forEach((k) => {
				if (this.ui.pick[k].open && !$t.closest(`[data-pop="${k}"]`).length) {
					this.ui.pick[k].open = false;
					changed = true;
				}
			});
			// options use `click`; let the click land first, then close
			if (changed && !$t.closest("[data-act]").length) setTimeout(() => this.render(), 0);
		}

		on_focus_open(e) {
			if (this.read_only && !$(e.target).is("[data-keep]")) return;
			const k = e.target.getAttribute("data-focus-open");
			if (k === "fn" && !this.ui.fn_open) {
				this.ui.fn_open = true;
				this.ui.fn_q = "";
				this.render();
			} else if (k === "pv" && !this.ui.pv.open) {
				this.ui.pv.open = true;
				this.ui.pv.q = "";
				this.render();
			} else if (k !== "fn" && k !== "pv") {
				const p = (this.ui.pick[k] = this.ui.pick[k] || { q: "", open: false, results: [] });
				if (!p.open) {
					p.open = true;
					this.search_pick(k, p.q || "");
					this.render();
				}
			}
		}

		search_pick(k, q) {
			const p = this.ui.pick[k];
			const [type, kind] = [k.slice(0, k.lastIndexOf("-")), k.slice(k.lastIndexOf("-") + 1)];
			p.loading = true;
			p.error = null;
			clearTimeout(p.timer);
			p.timer = setTimeout(async () => {
				try {
					const rows = kind === "g" ? await this.opts.search_groups(q) : await this.opts.search_contacts(q, type);
					if (p.q !== q) return;
					p.results = rows || [];
				} catch (err) {
					p.results = [];
					p.error = err && err.message;
				}
				p.loading = false;
				if (p.open) this.render();
			}, 200);
		}

		on_input(e) {
			const el = e.target;
			const kind = el.getAttribute("data-in");
			const key = el.getAttribute("data-key");
			const v = el.value;
			const d = this.draft;
			if (this.read_only && !$(el).is("[data-keep]")) return;
			if (kind === "code") d.code = v;
			else if (kind === "syn") return void (this.ui.syn = v);
			else if (kind === "fn-q") {
				this.ui.fn_q = v;
				this.ui.fn_open = true;
				return this.render();
			} else if (kind === "setting") this.set_setting(key, v);
			else if (kind === "out-text") d.outputs[cint(key)].template = v;
			else if (kind === "out-pf") d.outputs[cint(key)].print_format = v || null;
			else if (kind === "out-file") d.outputs[cint(key)].file_name_template = v;
			else if (kind === "pick") {
				const p = (this.ui.pick[key] = this.ui.pick[key] || { q: "", open: true, results: [] });
				p.q = v;
				p.open = true;
				this.search_pick(key, v);
				return this.render();
			} else if (kind === "pv-q") {
				this.ui.pv.q = v;
				this.ui.pv.open = true;
				clearTimeout(this._pvq);
				this._pvq = setTimeout(() => this.load_pv_contacts(v).then(() => this.ui.pv.open && this.render()), 200);
				return this.render();
			} else if (kind === "pv-val") {
				this.ui.pv.values[key] = v;
				return this.schedule_preview();
			}
			this.touch();
		}

		set_setting(key, value) {
			const s = ((this.spec && this.spec.settings) || []).find((x) => x.key === key);
			if (!s) return;
			const o = this.draft.settings_overrides;
			const norm = s.fieldtype === "Check" || s.fieldtype === "Int" ? (value === "" ? "" : cint(value)) : value;
			const def = s.fieldtype === "Check" || s.fieldtype === "Int" ? cint(s.default_value) : s.default_value;
			if (String(norm) === String(def == null ? "" : def)) delete o[key];
			else o[key] = norm;
		}

		on_change(e) {
			const el = e.target;
			if (this.read_only) return;
			const kind = el.getAttribute("data-ch");
			const key = el.getAttribute("data-key");
			const d = this.draft;
			if (kind === "link") d.requires_linked_contact = el.checked ? 1 : 0;
			else if (kind === "var") d.disabled_inputs = el.checked ? d.disabled_inputs.filter((k) => k !== key) : d.disabled_inputs.concat([key]);
			else if (kind === "setting") this.set_setting(key, el.type === "checkbox" ? (el.checked ? 1 : 0) : el.value);
			this.render();
			this.touch();
		}

		async on_act(e) {
			const $el = $(e.currentTarget);
			const act = $el.attr("data-act");
			const key = $el.attr("data-key");
			const d = this.draft;
			if (!d && act !== "close") return;
			if (act !== "close" && this.blocked(e)) return;
			switch (act) {
				case "close":
					return this.close();
				case "tab":
					this.ui.tab = key;
					this.ui.fn_open = false;
					this.ui.pv.open = false;
					this.ui.pick = {};
					this.render();
					if (key === "preview") this.enter_preview();
					return;
				case "toggle-status":
					d.status = d.status === "Active" ? "Inactive" : "Active";
					break;
				case "open-fn":
					this.ui.tab = "setup";
					this.ui.fn_open = true;
					this.ui.fn_q = "";
					this.render();
					this.$root.find("[data-f=fn]").trigger("focus");
					return;
				case "pick-fn":
					this.ui.fn_open = false;
					this.ui.fn_q = null;
					return this.pick_function(key);
				case "rm-syn":
					d.synonyms.splice(cint(key), 1);
					break;
				case "use-word":
					d.code = key;
					break;
				case "toggle-type":
					d.allowed_party_types = this.allowed(key) ? d.allowed_party_types.filter((k) => k !== key) : d.allowed_party_types.concat([key]);
					if (!this.allowed(key)) delete d.access[key];
					break;
				case "reset-fn":
					d.disabled_inputs = [];
					d.settings_overrides = {};
					break;
				case "reset-outs":
					this.reset_outputs();
					break;
				case "reset-all":
					d.disabled_inputs = [];
					d.settings_overrides = {};
					this.reset_outputs();
					break;
				case "insert-var": {
					const o = d.outputs[cint(key)];
					const text = o.template == null ? o.default_template || "" : o.template;
					o.template = `${text}${text && !/\s$/.test(text) ? " " : ""}{{ ${$el.attr("data-var")} }}`;
					break;
				}
				case "perm-tab":
					this.ui.perm_tab = key;
					this.ui.pick = {};
					return this.render();
				case "perm-mode": {
					const type = d.allowed_party_types.includes(this.ui.perm_tab) ? this.ui.perm_tab : d.allowed_party_types[0];
					this.set_access(type, { mode: key });
					break;
				}
				case "pick-add": {
					const k = key;
					const [type, kind] = [k.slice(0, k.lastIndexOf("-")), k.slice(k.lastIndexOf("-") + 1)];
					const p = this.ui.pick[k] || { results: [] };
					const row = (p.results || []).find((r) => r.name === $el.attr("data-name"));
					if (!row) return;
					const a = this.access_of(type);
					const field = kind === "g" ? "groups" : "contacts";
					this.set_access(type, { [field]: a[field].concat([{ name: row.name, label: row.label, phone: row.phone }]) });
					this.ui.pick[k] = { q: "", open: false, results: [] };
					break;
				}
				case "pick-rm": {
					const k = key;
					const [type, kind] = [k.slice(0, k.lastIndexOf("-")), k.slice(k.lastIndexOf("-") + 1)];
					const a = this.access_of(type);
					const field = kind === "g" ? "groups" : "contacts";
					this.set_access(type, { [field]: a[field].filter((x) => x.name !== $el.attr("data-name")) });
					break;
				}
				case "pv-type":
					Object.assign(this.ui.pv, { party_type: key, contact: null, account: null, q: null, results: [], loaded_for: null });
					this.render();
					return this.enter_preview();
				case "pv-pick": {
					const row = (this.ui.pv.results || []).find((r) => r.name === $el.attr("data-name"));
					Object.assign(this.ui.pv, { contact: row || null, account: null, open: false, q: null });
					this.render();
					return this.run_preview();
				}
				case "pv-acc":
					this.ui.pv.account = key;
					this.render();
					return this.run_preview();
				case "pv-fill":
					this.fill_examples();
					this.render();
					return this.run_preview();
				case "save":
					return this.save();
				case "delete":
					return this.remove();
				default:
					return;
			}
			this.render();
			this.touch();
		}

		reset_outputs() {
			this.draft.outputs = clone(((this.spec && this.spec.outputs) || []).map((o) => Object.assign({}, o, { template: o.default_template || o.template || "" })));
		}

		fill_examples() {
			const inputs = this.pv_inputs();
			const example = String((this.spec && this.spec.example) || "").trim();
			const words = example ? example.split(/\s+/).slice(1) : [];
			const all = (this.spec && this.spec.inputs) || [];
			inputs.forEach((v) => {
				if (v.example) {
					this.ui.pv.values[v.key] = v.example;
					return;
				}
				const i = all.indexOf(v);
				if (v.rest && words.length > i) this.ui.pv.values[v.key] = words.slice(i).join(" ");
				else if (words[i] != null) this.ui.pv.values[v.key] = words[i];
			});
		}

		async pick_function(name) {
			const d = this.draft;
			if (!name || name === d.function) return this.render();
			try {
				const spec = await this.opts.load_function(name);
				this.spec = spec;
				d.function = name;
				d.disabled_inputs = [];
				d.settings_overrides = {};
				this.reset_outputs();
				if (!d.allowed_party_types.length && (spec.party_types || []).length) d.allowed_party_types = spec.party_types.slice();
				if (!d.code && (spec.suggested_commands || []).length) d.code = spec.suggested_commands[0];
				this.ui.pv.values = {};
				this.ui.result = null;
			} catch (err) {
				sanad.ui.Toast.error(err);
			}
			this.render();
			this.touch();
		}

		async save() {
			const d = this.draft;
			const problem = !String(d.code || "").trim()
				? __("Enter the command word.")
				: !d.function
				? __("Pick a function.")
				: !d.allowed_party_types.length
				? __("Pick at least one party type before saving.")
				: null;
			if (problem) {
				sanad.ui.Toast.error(problem);
				if (!String(d.code || "").trim()) this.$root.find("[data-f=code]").trigger("focus");
				return;
			}
			const $btn = this.$root.find('[data-act="save"]').prop("disabled", true);
			try {
				const payload = Object.assign(this.payload(), { status: d.status });
				const result = await this.opts.save(payload);
				d.name = result.name;
				d.status = result.status || d.status;
				d.code = String(d.code).trim().toLowerCase();
				this.clean = JSON.stringify(d);
				sanad.ui.Toast.success(__("Command saved"));
				this.opts.on_saved && this.opts.on_saved(result);
				this.render();
			} catch (err) {
				sanad.ui.Toast.error(err);
				$btn.prop("disabled", false);
			}
		}

		async remove() {
			const d = this.draft;
			try {
				await sanad.ui.ConfirmDialog.ask({
					title: __("Delete command {0}?", [d.code || d.name]),
					message: __("The command is removed. A command with run history cannot be deleted; stop it instead."),
					impact: [{ label: __("Function"), value: (this.fn_row() || {}).function_name || d.function || "—" }],
					confirm_label: __("Delete command"),
					danger: true,
					on_confirm: () => this.opts.remove(d.name),
				});
			} catch (e) {
				return; // cancelled, or the server refused (already shown)
			}
			sanad.ui.Toast.success(__("Command deleted"));
			this.opts.on_saved && this.opts.on_saved({ name: d.name, deleted: true });
			this.close(true);
		}
	}

	sanad.ui.CommandEditor = CommandEditor;
})();

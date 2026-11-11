// whatsapp.ui.FunctionDetail — the prototype's function window (`docs/component/Function Detail.dc.html`):
// a full-height modal with a header (name, category, active / stopped, installed / not installed,
// close; tabs Details · Version log (count) · Preview; the current and the latest version), three
// tabs and a footer (Update to … · Install / Uninstall · Linked commands · Close).
//
//   Details      340 | 1fr | 1fr — what it does, when to use it, who it serves, four figures,
//                suggested words, linked commands · the variables and the options it takes · the
//                outputs it produces (texts and file names with a copy button, fields to copy).
//   Version log  one card per version, newest first; the latest and the installed one marked.
//   Preview      320 | 1fr | 400 — assumptions (sender type, contact, account, variables) · options
//                and texts for this preview only · the reply after rendering, from the host's
//                `preview` (a real dry run: nothing saved, nothing sent).
//
// It draws on the shell of `whatsapp.ui.CommandEditor` (the two prototypes share it value for value),
// so it needs that component's styles. Portable: the host passes the data and the verbs.

frappe.provide("whatsapp.ui");

(function () {
	const escape_html = (v) => whatsapp.ui.escape(v);
	const clone = (v) => JSON.parse(JSON.stringify(v == null ? null : v));
	const SETTING_TYPE = { Check: "check", Int: "number", Select: "select", Data: "text" };
	const COPY_ICON =
		'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"></path></svg>';

	const vtuple = (v) => String(v || "").split(/[.-]/).map((p) => (/^\d+$/.test(p) ? cint(p) : 0));
	const compare_versions = (a, b) => {
		const ta = vtuple(a);
		const tb = vtuple(b);
		for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
			const d = (ta[i] || 0) - (tb[i] || 0);
			if (d) return d;
		}
		return 0;
	};

	class FunctionDetail {
		/**
		 * @param {Object} opts
		 * @param {Object} opts.entry — `{function_key, function_name, category, description, when_to_use,
		 *   status, installed, installed_version, latest_version, update_available, versions[],
		 *   releases{v: {released, changelog}}, party_types[], linked_commands[{name, code, status}],
		 *   calls_30d, avg_ms}`
		 * @param {Object} opts.manifest — `{inputs[], settings[], outputs[], suggested_commands[],
		 *   party_types[], example, installed{installed_at}}`
		 * @param {Array} [opts.party_types] — `[{key, label}]` for the preview
		 * @param {Function} [opts.preview] — `({settings, outputs, values, sender, code}) → result`
		 *   (`{text, status, block_reason, missing[], replies[], error}`); omitted → the tab says why
		 * @param {Function} [opts.search_contacts] — `(txt, party_type) → [{name, label, phone, links}]`
		 * @param {Function} [opts.on_update] `(entry)` · [opts.on_toggle_install] `(entry)` ·
		 *   [opts.on_open_commands] `(entry)` · [opts.more] `[{label, handler}]` extra verbs ·
		 *   [opts.on_close]
		 */
		constructor(opts = {}) {
			this.opts = opts;
			this.entry = opts.entry || {};
			this.manifest = opts.manifest || { inputs: [], settings: [], outputs: [] };
			this.ui = {
				tab: opts.tab || "details",
				log_open: {},
				pv: { party_type: null, contact: null, account: null, q: null, open: false, results: [], values: {}, loaded_for: null },
				opts: {},
				outs: {},
				files: {},
				result: null,
				running: false,
				error: null,
				more: false,
			};
		}

		// ---- shell ---------------------------------------------------------------------------------

		show() {
			this.id = whatsapp.ui.unique_dom_id("whatsapp-kit-function-detail");
			this.previous_focus = document.activeElement;
			this.$root = $(`
				<div class="whatsapp-kit whatsapp-kit-command-editor-layer whatsapp-kit-function-detail-layer" role="presentation">
					<div class="whatsapp-kit-command-editor-backdrop" data-act="close"></div>
					<div class="whatsapp-kit-command-editor whatsapp-kit-function-detail" role="dialog" aria-modal="true" aria-labelledby="${this.id}-title">
						<div class="whatsapp-kit-command-editor__body" data-slot="body"></div>
					</div>
				</div>`).appendTo(document.body);
			this.$body = this.$root.find("[data-slot=body]");
			$("body").addClass("whatsapp-kit-command-editor-open");
			this.$root.on("click", "[data-act]", (e) => this.on_act(e));
			this.$root.on("input", "[data-in]", (e) => this.on_input(e));
			this.$root.on("change", "[data-ch]", (e) => this.on_change(e));
			this.$root.on("keydown", (e) => this.on_key(e));
			this.$root.on("focusin", "[data-focus-open]", () => this.open_preview_contact_dropdown());
			this.$root.on("mousedown", (e) => this.on_outside(e));
			if (whatsapp.ui.overlay) whatsapp.ui.overlay.open(this);
			this.render();
			const x = this.$root.find(".whatsapp-kit-command-editor__x").get(0);
			x && x.focus();
			if (this.ui.tab === "preview") this.enter_preview();
			return this;
		}

		/** Remove without asking (another overlay took the screen, or the host re-opens it). */
		hide() {
			if (!this.$root) return;
			if (this.thread && this.thread.destroy) this.thread.destroy();
			this.$root.remove();
			this.$root = null;
			if (!$(".whatsapp-kit-command-editor-layer").length) $("body").removeClass("whatsapp-kit-command-editor-open");
			if (whatsapp.ui.overlay) whatsapp.ui.overlay.close(this);
		}

		destroy() {
			this.hide();
		}

		close() {
			this.hide();
			if (this.previous_focus && this.previous_focus.focus && document.body.contains(this.previous_focus)) this.previous_focus.focus();
			this.opts.on_close && this.opts.on_close();
		}

		// ---- derived ------------------------------------------------------------------------------

		party_types() {
			const list = this.opts.party_types || [];
			return list.length ? list : ["Customer", "Supplier", "Employee", "Sales Person"].map((k) => ({ key: k, label: __(k) }));
		}

		outputs() {
			return (this.manifest.outputs || []).map((o) => {
				const key = o.output_key || o.label;
				const is_doc = o.output_type === "Document";
				const text = this.ui.outs[key] != null ? this.ui.outs[key] : o.default_template || "";
				const file = this.ui.files[key] != null ? this.ui.files[key] : o.file_name_template || "";
				return { o, key, is_doc, text, file };
			});
		}

		setting_value(s) {
			if (Object.prototype.hasOwnProperty.call(this.ui.opts, s.key)) return this.ui.opts[s.key];
			return s.value != null && s.value !== "" ? s.value : s.default_value;
		}

		format_release_date(d) {
			return d ? frappe.datetime.str_to_user(String(d).slice(0, 10)) : "";
		}

		format_time_ago(d) {
			try {
				return d ? frappe.datetime.prettyDate(d) : "";
			} catch (e) {
				return "";
			}
		}

		// ---- render -------------------------------------------------------------------------------

		render() {
			if (!this.$root) return;
			const restore = whatsapp.ui.hold_focus(this.$root);
			const tab = this.ui.tab;
			const body = tab === "details" ? this.render_details() : tab === "log" ? this.render_log() : this.render_preview();
			this.$body.html(`${this.render_header()}${body}${this.render_footer()}`);
			restore();
			if (tab === "preview") this.mount_thread();
		}

		render_header() {
			const entry = this.entry;
			const on = entry.status === "Active";
			const releases = entry.releases || {};
			const cur = entry.installed ? entry.installed_version : entry.latest_version;
			const tabs = [
				{ key: "details", label: __("Details", null, "Function Detail") },
				{ key: "log", label: __("Version log"), count: (entry.versions || []).length },
				{ key: "preview", label: __("Preview") },
			];
			return `
				<div class="whatsapp-kit-command-editor__head">
					<div class="whatsapp-kit-command-editor__head-row whatsapp-kit-function-detail__head-row">
						<span class="whatsapp-kit-function-detail__identity">
							<span class="whatsapp-kit-function-detail__name" id="${this.id}-title">${escape_html(entry.function_name || entry.function_key)}</span>
							<span class="whatsapp-kit-function-detail__subtitle">
								<span class="whatsapp-kit-command-editor__subtitle">${escape_html(entry.category || __("Uncategorised"))}</span>
								${
									entry.installed
										? `<span class="whatsapp-kit-function-detail__badge ${on ? "whatsapp-kit-function-detail__badge--ok" : "whatsapp-kit-function-detail__badge--muted"}">${escape_html(on ? __("Active", null, "Function Detail") : __("Stopped", null, "Function Detail"))}</span>`
										: ""
								}
								<span class="whatsapp-kit-function-detail__badge whatsapp-kit-function-detail__badge--line ${entry.installed ? "whatsapp-kit-function-detail__badge--primary" : ""}">${escape_html(entry.installed ? __("Installed", null, "Function Detail") : __("Not installed", null, "Function Detail"))}</span>
							</span>
						</span>
						${this.opts.form ? whatsapp.ui.form_button_html() : ""}
						<button type="button" class="whatsapp-kit-command-editor__x whatsapp-kit-function-detail__x" data-act="close" title="${escape_html(__("Close (Esc)"))}" aria-label="${escape_html(__("Close"))}">×</button>
					</div>
					<div class="whatsapp-kit-command-editor__head-row whatsapp-kit-command-editor__head-row--tabs whatsapp-kit-function-detail__tabs-row">
						<span class="whatsapp-kit-command-editor__tabs" role="tablist">
							${tabs
								.map(
									(t) => `<button type="button" role="tab" class="whatsapp-kit-command-editor__tab${this.ui.tab === t.key ? " is-sel" : ""}" aria-selected="${this.ui.tab === t.key}" data-act="tab" data-key="${t.key}">
										${escape_html(t.label)}${t.count != null ? `<span class="whatsapp-kit-command-editor__count" dir="ltr">${whatsapp.ui.format_integer(t.count)}</span>` : ""}
									</button>`
								)
								.join("")}
						</span>
						<span class="whatsapp-kit-command-editor__meta">
							${cur ? `<span class="whatsapp-kit-function-detail__version whatsapp-kit-function-detail__version--primary" dir="ltr">${escape_html(__("Current {0} · {1}", [cur, this.format_release_date((releases[cur] || {}).released)]))}</span>` : ""}
							${
								entry.installed && entry.update_available
									? `<span class="whatsapp-kit-function-detail__version whatsapp-kit-function-detail__version--warning" dir="ltr">${escape_html(__("Latest {0} · {1}", [entry.latest_version, this.format_release_date((releases[entry.latest_version] || {}).released)]))}</span>`
									: ""
							}
						</span>
					</div>
				</div>`;
		}

		render_details() {
			const entry = this.entry;
			const manifest = this.manifest;
			const linked = entry.linked_commands || [];
			const party = (manifest.party_types && manifest.party_types.length ? manifest.party_types : entry.party_types) || [];
			const words = manifest.suggested_commands || [];
			const stats = [
				[__("Calls (30d)", null, "Function Detail"), whatsapp.ui.format_integer(cint(entry.calls_30d))],
				[__("Average run time"), cint(entry.avg_ms) ? `${whatsapp.ui.format_integer(entry.avg_ms)} ms` : "—"],
				[__("Linked commands"), whatsapp.ui.format_integer(linked.length)],
				[__("Active of them"), whatsapp.ui.format_integer(linked.filter((c) => c.status === "Active").length)],
			];
			const about = `
				<p class="whatsapp-kit-function-detail__lede" dir="auto">${escape_html(entry.description || __("No description in the catalog."))}</p>
				<div class="whatsapp-kit-command-editor__box whatsapp-kit-function-detail__box">
					<span class="whatsapp-kit-function-detail__box-title">${escape_html(__("When exactly to use it"))}</span>
					<span class="whatsapp-kit-function-detail__box-text" dir="auto">${escape_html(entry.when_to_use || __("The catalog does not say when to use it."))}</span>
				</div>
				<div class="whatsapp-kit-command-editor__box whatsapp-kit-function-detail__box">
					<span class="whatsapp-kit-function-detail__box-title">${escape_html(__("Party type the function serves"))}</span>
					<span class="whatsapp-kit-command-editor__chips">${(party.length ? party.map((p) => __(p)) : [__("General")]).map((p) => `<span class="whatsapp-kit-function-detail__tag">${escape_html(p)}</span>`).join("")}</span>
				</div>
				<div class="whatsapp-kit-function-detail__stats">
					${stats.map(([k, v]) => `<span class="whatsapp-kit-function-detail__stat"><span class="whatsapp-kit-function-detail__stat-key">${escape_html(k)}</span><span class="whatsapp-kit-function-detail__stat-value" dir="ltr">${escape_html(v)}</span></span>`).join("")}
				</div>
				${
					words.length
						? `<div class="whatsapp-kit-command-editor__field whatsapp-kit-command-editor__field--tight">
							<span class="whatsapp-kit-function-detail__heading">${escape_html(__("Suggested commands for this function"))}</span>
							<span class="whatsapp-kit-command-editor__chips">${words.map((w) => `<span class="whatsapp-kit-function-detail__word">${escape_html(w)}</span>`).join("")}</span>
						</div>`
						: ""
				}
				<div class="whatsapp-kit-command-editor__field whatsapp-kit-command-editor__field--tight">
					<span class="whatsapp-kit-command-editor__card-row"><span class="whatsapp-kit-function-detail__heading">${escape_html(__("Linked commands", null, "Function Detail"))}</span>${
						this.opts.on_open_commands ? `<button type="button" class="whatsapp-kit-command-editor__link" data-act="commands">${escape_html(__("Open in commands"))}</button>` : ""
					}</span>
					<span class="whatsapp-kit-command-editor__chips">
						${linked.map((c) => `<span class="whatsapp-kit-function-detail__command${c.status === "Active" ? " is-on" : ""}">${escape_html(c.code || c.name)}</span>`).join("")}
						${linked.length ? "" : `<span class="whatsapp-kit-command-editor__note">${escape_html(__("No command is linked to this function yet."))}</span>`}
					</span>
				</div>`;
			const inputs = manifest.inputs || [];
			const settings = manifest.settings || [];
			const vars = `
				${
					inputs.length
						? `<div class="whatsapp-kit-command-editor__field"><span class="whatsapp-kit-function-detail__heading whatsapp-kit-function-detail__heading--strong">${escape_html(__("Variables it can handle"))}</span><div class="whatsapp-kit-command-editor__stack">${inputs
								.map(
									(v) => `<div class="whatsapp-kit-command-editor__card">
										<div class="whatsapp-kit-command-editor__card-row whatsapp-kit-command-editor__card-row--wrap">
											<span class="whatsapp-kit-command-editor__card-title">
												<span class="whatsapp-kit-command-editor__mono" dir="ltr">#${escape_html(v.key)}</span>
												<span class="whatsapp-kit-command-editor__subtitle">${escape_html(__(v.label || v.key))}</span>
												${v.required ? `<span class="whatsapp-kit-command-editor__tag whatsapp-kit-command-editor__tag--warn">${escape_html(__("Required"))}</span>` : ""}
											</span>
											<span class="whatsapp-kit-command-editor__control">
												<span class="whatsapp-kit-command-editor__tag whatsapp-kit-command-editor__mono" dir="ltr">${escape_html((v.type || "str") + (v.options ? ` · ${v.options}` : ""))}</span>
												${v.example ? `<span class="whatsapp-kit-command-editor__example whatsapp-kit-command-editor__mono" dir="ltr">${escape_html(v.example)}</span>` : ""}
											</span>
										</div>
										${v.notes || v.details ? `<span class="whatsapp-kit-command-editor__note" dir="auto">${escape_html(__(v.notes || v.details))}</span>` : ""}
									</div>`
								)
								.join("")}</div></div>`
						: `<span class="whatsapp-kit-command-editor__empty">${escape_html(__("This function takes no variables: the command word alone runs it."))}</span>`
				}
				${
					settings.length
						? `<div class="whatsapp-kit-command-editor__field"><span class="whatsapp-kit-function-detail__heading whatsapp-kit-function-detail__heading--strong">${escape_html(__("Options the function can use"))}</span><div class="whatsapp-kit-command-editor__stack">${settings
								.map((s) => {
									const value = this.setting_value(s);
									const shown = s.fieldtype === "Check" ? (cint(value) ? __("Yes") : __("No")) : cstr(value) || "—";
									const choices = cstr(s.choices).split("\n").filter(Boolean);
									return `<div class="whatsapp-kit-command-editor__card">
										<div class="whatsapp-kit-command-editor__card-row whatsapp-kit-command-editor__card-row--wrap">
											<span class="whatsapp-kit-command-editor__card-name">${escape_html(__(s.label || s.key))}</span>
											<span class="whatsapp-kit-command-editor__control"><span class="whatsapp-kit-command-editor__tag">${escape_html(this.type_label(s))}</span><span class="whatsapp-kit-function-detail__value">${escape_html(shown)}</span></span>
										</div>
										${s.notes ? `<span class="whatsapp-kit-command-editor__note" dir="auto">${escape_html(__(s.notes))}</span>` : ""}
										${choices.length ? `<span class="whatsapp-kit-function-detail__choices whatsapp-kit-command-editor__mono" dir="ltr">${escape_html(choices.join(" · "))}</span>` : ""}
									</div>`;
								})
								.join("")}</div></div>`
						: ""
				}`;
			const outs = this.outputs();
			const outputs = `
				<span class="whatsapp-kit-function-detail__heading whatsapp-kit-function-detail__heading--strong">${escape_html(__("Outputs expected from the function"))}</span>
				${outs
					.map(({ o, key, is_doc }) => {
						const fields = cstr(o.variables)
							.split(/[,\n]/)
							.map((v) => v.trim())
							.filter(Boolean);
						return `<div class="whatsapp-kit-command-editor__out">
							<span class="whatsapp-kit-command-editor__card-row whatsapp-kit-command-editor__card-row--wrap">
								<span class="whatsapp-kit-function-detail__out-name"><span class="whatsapp-kit-function-detail__bar" aria-hidden="true"></span>${escape_html(__(o.label || key))}</span>
								<span class="whatsapp-kit-command-editor__tag">${escape_html(is_doc ? __("Document", null, "Command Editor") : __("Text"))}</span>
							</span>
							${o.notes ? `<span class="whatsapp-kit-command-editor__note" dir="auto">${escape_html(__(o.notes))}</span>` : ""}
							${
								o.default_template
									? `<div class="whatsapp-kit-function-detail__copy-box"><span class="whatsapp-kit-function-detail__copy-text" dir="auto">${escape_html(o.default_template)}</span>${this.render_copy_button(o.default_template, __("Copy the text"))}</div>`
									: ""
							}
							${
								o.file_name_template
									? `<div class="whatsapp-kit-command-editor__field whatsapp-kit-command-editor__field--tight"><span class="whatsapp-kit-command-editor__note">${escape_html(__("Default file name"))}</span><div class="whatsapp-kit-function-detail__copy-box whatsapp-kit-function-detail__copy-box--sm"><span class="whatsapp-kit-function-detail__copy-text">${escape_html(
											o.file_name_template
									  )}</span>${this.render_copy_button(o.file_name_template, __("Copy the file name"))}</div></div>`
									: ""
							}
							${
								fields.length
									? `<div class="whatsapp-kit-command-editor__field whatsapp-kit-command-editor__field--tight"><span class="whatsapp-kit-command-editor__note">${escape_html(__("Fields you can use — click to copy"))}</span><span class="whatsapp-kit-command-editor__chips whatsapp-kit-command-editor__chips--tight">${fields
											.map((f) => `<button type="button" class="whatsapp-kit-function-detail__field whatsapp-kit-command-editor__mono" dir="ltr" data-act="copy" data-text="${escape_html(`{{ ${f} }}`)}">{{ ${escape_html(f)} }}</button>`)
											.join("")}</span></div>`
									: ""
							}
						</div>`;
					})
					.join("")}
				${outs.length ? "" : `<span class="whatsapp-kit-command-editor__empty whatsapp-kit-command-editor__empty--surface">${escape_html(__("This function defines no outputs."))}</span>`}`;
			return `<div class="whatsapp-kit-command-editor__grid whatsapp-kit-command-editor__grid--setup whatsapp-kit-function-detail__grid">
				<section class="whatsapp-kit-command-editor__column whatsapp-kit-command-editor__column--span" data-scroll="about"><div class="whatsapp-kit-command-editor__column-body whatsapp-kit-function-detail__body">${about}</div></section>
				<section class="whatsapp-kit-command-editor__column" data-scroll="vars"><div class="whatsapp-kit-command-editor__column-body whatsapp-kit-function-detail__body">${vars}</div></section>
				<section class="whatsapp-kit-command-editor__column whatsapp-kit-command-editor__column--background" data-scroll="outs"><div class="whatsapp-kit-command-editor__column-body whatsapp-kit-function-detail__body whatsapp-kit-function-detail__body--outs">${outputs}</div></section>
			</div>`;
		}

		render_copy_button(text, title) {
			return `<button type="button" class="whatsapp-kit-function-detail__copy" data-act="copy" data-text="${escape_html(text)}" title="${escape_html(title)}" aria-label="${escape_html(title)}">${COPY_ICON}</button>`;
		}

		type_label(s) {
			const kind = SETTING_TYPE[s.fieldtype] || "text";
			return { check: __("Yes / No"), number: __("Number"), select: __("List"), text: __("Text") }[kind];
		}

		render_log() {
			const entry = this.entry;
			const releases = entry.releases || {};
			const versions = (entry.versions || []).slice().sort((a, b) => compare_versions(b, a));
			const cards = versions
				.map((v, i) => {
					const rel = releases[v] || {};
					const note = cstr(rel.changelog || (entry.changelog || {})[v]).trim();
					const changes = note ? note.split(/\n+/).map((s) => s.replace(/^[-*•]\s*/, "").trim()).filter(Boolean) : [];
					const open = this.ui.log_open[v] != null ? this.ui.log_open[v] : i === 0;
					const latest = v === entry.latest_version;
					const current = entry.installed && v === entry.installed_version;
					const badge = latest ? __("Latest", null, "Function Detail") : current ? __("Installed now") : "";
					return `<div class="whatsapp-kit-function-detail__log${current ? " is-current" : ""}">
						<button type="button" class="whatsapp-kit-function-detail__log-head" data-act="log" data-key="${escape_html(v)}" aria-expanded="${open}">
							<span class="whatsapp-kit-function-detail__arrow" aria-hidden="true">${open ? "▾" : "▸"}</span>
							<span class="whatsapp-kit-function-detail__log-value" dir="ltr">${escape_html(v)}</span>
							${badge ? `<span class="whatsapp-kit-function-detail__badge ${latest ? "whatsapp-kit-function-detail__badge--warning" : "whatsapp-kit-function-detail__badge--primary"}">${escape_html(badge)}</span>` : ""}
							<span class="whatsapp-kit-command-editor__subtitle">${escape_html(this.format_release_date(rel.released))}</span>
							<span class="whatsapp-kit-command-editor__note">${escape_html(this.format_time_ago(rel.released))}</span>
							<span class="whatsapp-kit-function-detail__log-count">${escape_html(whatsapp.ui.plural(changes.length, { one: __("{0} change"), other: __("{0} changes") }))}</span>
						</button>
						${
							open
								? `<div class="whatsapp-kit-function-detail__changes">${(changes.length ? changes : [__("No note for this version.")])
										.map((c) => `<span class="whatsapp-kit-function-detail__change"><span class="whatsapp-kit-function-detail__bullet" aria-hidden="true"></span><span dir="auto">${escape_html(c)}</span></span>`)
										.join("")}</div>`
								: ""
						}
					</div>`;
				})
				.join("");
			return `<div class="whatsapp-kit-command-editor__pane whatsapp-kit-function-detail__pane" data-scroll="log">${cards || `<span class="whatsapp-kit-command-editor__empty whatsapp-kit-command-editor__empty--surface">${escape_html(__("No versions in the catalog."))}</span>`}</div>`;
		}

		// ---- preview ------------------------------------------------------------------------------

		preview_party_type() {
			return this.ui.pv.party_type || (this.party_types()[0] || {}).key || null;
		}

		preview_contact_links() {
			const contact = this.ui.pv.contact;
			return contact ? (contact.links || []).filter((l) => l.link_doctype === this.preview_party_type()) : [];
		}

		preview_blocker() {
			if (!this.entry.installed) return __("Install the function to preview it: the preview runs the installed handler.");
			if (!this.opts.preview) return __("Only a WhatsApp manager can run the preview.");
			return null;
		}

		render_preview() {
			const blocker = this.preview_blocker();
			if (blocker) return `<div class="whatsapp-kit-command-editor__pane" data-scroll="pv"><span class="whatsapp-kit-command-editor__empty whatsapp-kit-command-editor__empty--surface">${escape_html(blocker)}</span></div>`;
			const preview = this.ui.pv;
			const type = this.preview_party_type();
			const contact = preview.contact;
			const links = this.preview_contact_links();
			const account = links.find((l) => l.link_name === preview.account) || links[0] || null;
			const inputs = this.manifest.inputs || [];
			const search_value = preview.q == null ? (contact ? contact.label || contact.phone || "" : "") : preview.q;
			const assumptions = `
				<div class="whatsapp-kit-command-editor__field whatsapp-kit-command-editor__field--tight">
					<span class="whatsapp-kit-command-editor__label">${escape_html(__("Party type"))}</span>
					<span class="whatsapp-kit-command-editor__chips">${this.party_types()
						.map((p) => `<button type="button" class="whatsapp-kit-command-editor__pill${p.key === type ? " is-on" : ""}" aria-pressed="${p.key === type}" data-act="pv-type" data-key="${escape_html(p.key)}">${escape_html(p.label)}</button>`)
						.join("")}</span>
				</div>
				<div class="whatsapp-kit-command-editor__field">
					<label class="whatsapp-kit-command-editor__label" for="${this.id}-pv">${escape_html(__("Contact", null, "Function Detail"))}</label>
					<span class="whatsapp-kit-command-editor__combo" data-pop="pv">
						<input id="${this.id}-pv" type="text" class="whatsapp-kit-command-editor__input" data-f="pv-q" data-in="pv-q" data-focus-open="pv" value="${escape_html(search_value)}" placeholder="${escape_html(__("Search by name or number…"))}" autocomplete="off" />
						${
							preview.open
								? `<span class="whatsapp-kit-command-editor__popover" role="listbox">
									${(preview.results || [])
										.map(
											(r) => `<button type="button" role="option" class="whatsapp-kit-command-editor__option${contact && r.name === contact.name ? " is-sel" : ""}" data-act="pv-pick" data-name="${escape_html(r.name)}">${escape_html(r.label || __("Unnamed"))}<span class="whatsapp-kit-command-editor__option-subtitle whatsapp-kit-command-editor__mono" dir="ltr">${escape_html(whatsapp.ui.phone(r.phone || ""))}</span></button>`
										)
										.join("")}
									${preview.loading ? `<span class="whatsapp-kit-command-editor__none">${escape_html(__("Loading…"))}</span>` : (preview.results || []).length ? "" : `<span class="whatsapp-kit-command-editor__none">${escape_html(preview.error || __("No matching contacts."))}</span>`}
								</span>`
								: ""
						}
					</span>
					${contact ? "" : `<span class="whatsapp-kit-command-editor__note">${escape_html(__("No sender picked — the preview assumes a number that is not linked."))}</span>`}
				</div>
				${
					links.length
						? `<div class="whatsapp-kit-command-editor__box"><span class="whatsapp-kit-command-editor__note">${escape_html(__("Accounts linked to the contact"))}</span><span class="whatsapp-kit-command-editor__chips">${links
								.map((l) => `<button type="button" class="whatsapp-kit-command-editor__pill${account && l.link_name === account.link_name ? " is-on" : ""}" data-act="pv-acc" data-key="${escape_html(l.link_name)}">${escape_html(l.link_title || l.link_name)}</button>`)
								.join("")}</span></div>`
						: ""
				}
				${
					inputs.length
						? `<div class="whatsapp-kit-command-editor__field whatsapp-kit-command-editor__field--tight">
							<span class="whatsapp-kit-command-editor__card-row"><span class="whatsapp-kit-command-editor__label">${escape_html(__("Variables passed in the command text"))}</span><button type="button" class="whatsapp-kit-command-editor__link" data-act="pv-fill">${escape_html(__("Fill with examples"))}</button></span>
							<div class="whatsapp-kit-command-editor__stack">${inputs
								.map((v) => {
									const val = preview.values[v.key] || "";
									return `<span class="whatsapp-kit-command-editor__card${v.required && !String(val).trim() ? " is-missing" : ""}">
										<span class="whatsapp-kit-command-editor__card-row"><span class="whatsapp-kit-command-editor__mono" dir="ltr">#${escape_html(v.key)}</span>${v.required ? `<span class="whatsapp-kit-command-editor__tag whatsapp-kit-command-editor__tag--warn">${escape_html(__("Required"))}</span>` : ""}</span>
										<input type="text" dir="ltr" class="whatsapp-kit-command-editor__input whatsapp-kit-command-editor__input--surface whatsapp-kit-command-editor__mono" data-f="pv-${escape_html(v.key)}" data-in="pv-val" data-key="${escape_html(v.key)}" value="${escape_html(val)}" placeholder="${escape_html(v.example || v.key)}" aria-label="${escape_html(__(v.label || v.key))}" />
										<span class="whatsapp-kit-command-editor__note">${escape_html(__(v.label || ""))}</span>
									</span>`;
								})
								.join("")}</div>
						</div>`
						: ""
				}`;
			const settings = (this.manifest.settings || []).map((s) => this.render_setting(s)).join("");
			const outs = this.outputs()
				.map(
					({ o, key, is_doc, text, file }) => `<div class="whatsapp-kit-command-editor__out">
						<span class="whatsapp-kit-command-editor__card-row whatsapp-kit-command-editor__card-row--wrap"><span class="whatsapp-kit-command-editor__out-name">${escape_html(__(o.label || key))}</span><span class="whatsapp-kit-command-editor__tag">${escape_html(is_doc ? __("Document", null, "Command Editor") : __("Text"))}</span></span>
						${
							is_doc
								? `<input type="text" class="whatsapp-kit-command-editor__input whatsapp-kit-command-editor__input--sm" data-f="pvf-${escape_html(key)}" data-in="pv-file" data-key="${escape_html(key)}" value="${escape_html(file)}" aria-label="${escape_html(__("Attached file name"))}" />`
								: `<textarea class="whatsapp-kit-command-editor__textarea whatsapp-kit-function-detail__template" dir="auto" rows="${Math.min(7, Math.max(3, Math.ceil(String(text).length / 52)))}" data-f="pvo-${escape_html(key)}" data-in="pv-out" data-key="${escape_html(key)}" aria-label="${escape_html(__(o.label || key))}">${escape_html(text)}</textarea>`
						}
					</div>`
				)
				.join("");
			const r = this.ui.result;
			const c_label = contact ? contact.label || __("Unnamed") : __("Unknown number");
			const linked = !!(contact && links.length);
			const result = `
				<div class="whatsapp-kit-command-editor__phone">
					<div class="whatsapp-kit-command-editor__phone-head">
						<span class="whatsapp-kit-command-editor__avatar" aria-hidden="true">${escape_html(String((contact && contact.label) || "?").trim().slice(0, 2))}</span>
						<span class="whatsapp-kit-command-editor__switch-text"><span class="whatsapp-kit-command-editor__card-name">${escape_html(c_label)}</span><span class="whatsapp-kit-command-editor__option-subtitle whatsapp-kit-command-editor__mono" dir="ltr">${escape_html(whatsapp.ui.phone((contact && contact.phone) || ""))}</span></span>
						<span class="whatsapp-kit-command-editor__tag ${linked ? "whatsapp-kit-command-editor__tag--ok" : "whatsapp-kit-command-editor__tag--warn"}">${escape_html(linked ? __("Linked to an account", null, "Command Editor") : __("Not linked"))}</span>
					</div>
					<span class="whatsapp-kit-command-editor__phone-note">${escape_html(__("The reply comes from the function's output texts, run for real without sending."))}</span>
					<div class="whatsapp-kit-command-editor__thread" data-slot="thread" aria-live="polite"></div>
				</div>
				${
					r && r.missing && r.missing.length && r.status !== "Blocked"
						? `<div class="whatsapp-kit-command-editor__callout whatsapp-kit-command-editor__callout--warn"><strong>${escape_html(__("Not enough data to run the function"))}</strong><span>${escape_html(
								__("The message text must contain: {0}", [r.missing.map((x) => `#${x.key}${x.label ? ` (${x.label})` : ""}`).join(__(", "))])
						  )}</span></div>`
						: ""
				}
				${r && r.status === "Blocked" ? `<div class="whatsapp-kit-command-editor__callout whatsapp-kit-command-editor__callout--muted"><span>${escape_html(__("Refused: {0}", [__(r.block_reason || "")]))}</span></div>` : ""}
				${this.ui.error ? `<div class="whatsapp-kit-command-editor__callout whatsapp-kit-command-editor__callout--danger" role="alert"><span>${escape_html(this.ui.error)}</span></div>` : ""}`;
			return `<div class="whatsapp-kit-command-editor__grid whatsapp-kit-command-editor__grid--preview whatsapp-kit-function-detail__grid--preview">
				${this.column_section_html(__("Preview assumptions"), assumptions, "pv-a")}
				${this.column_section_html(
					__("Options and texts for this preview"),
					`<span class="whatsapp-kit-command-editor__note">${escape_html(__("Changes here are for the preview only; they change neither the function nor the commands."))}</span>${settings}${outs}`,
					"pv-o",
					"bg",
					{ act: "pv-reset", label: __("Back to the function's defaults") }
				)}
				<section class="whatsapp-kit-command-editor__column whatsapp-kit-command-editor__column--background whatsapp-kit-command-editor__column--last" data-scroll="pv-r" aria-label="${escape_html(__("The result after rendering"))}">
					<header class="whatsapp-kit-command-editor__column-head"><span class="whatsapp-kit-command-editor__column-title">${escape_html(__("The result after rendering"))}</span><span class="whatsapp-kit-command-editor__simulator"><span class="whatsapp-kit-command-editor__dot whatsapp-kit-command-editor__dot--warning"></span>${escape_html(__("Simulation — nothing sent"))}</span></header>
					<div class="whatsapp-kit-command-editor__column-body whatsapp-kit-command-editor__column-body--result">${result}</div>
				</section>
			</div>`;
		}

		column_section_html(title, body, key, tone = "surface", link = null) {
			return `<section class="whatsapp-kit-command-editor__column whatsapp-kit-command-editor__column--${tone}" data-scroll="${key}" aria-label="${escape_html(title)}">
				<header class="whatsapp-kit-command-editor__column-head"><span class="whatsapp-kit-command-editor__column-title">${escape_html(title)}</span>${link ? `<button type="button" class="whatsapp-kit-command-editor__link" data-act="${link.act}">${escape_html(link.label)}</button>` : ""}</header>
				<div class="whatsapp-kit-command-editor__column-body">${body}</div>
			</section>`;
		}

		render_setting(s) {
			const kind = SETTING_TYPE[s.fieldtype] || "text";
			const value = this.setting_value(s);
			const def = s.fieldtype === "Check" ? (cint(s.default_value) ? __("Yes") : __("No")) : s.default_value == null || s.default_value === "" ? "—" : s.default_value;
			let control;
			if (kind === "check") control = `<input type="checkbox" class="whatsapp-kit-command-editor__check" data-ch="pv-setting" data-key="${escape_html(s.key)}" ${cint(value) ? "checked" : ""} aria-label="${escape_html(__(s.label))}" />`;
			else if (kind === "number") control = `<input type="number" class="whatsapp-kit-command-editor__input whatsapp-kit-command-editor__input--number whatsapp-kit-command-editor__mono" data-f="pvs-${escape_html(s.key)}" data-in="pv-setting" data-key="${escape_html(s.key)}" value="${escape_html(value == null ? "" : value)}" aria-label="${escape_html(__(s.label))}" />`;
			else if (kind === "select")
				control = `<select class="whatsapp-kit-command-editor__input whatsapp-kit-command-editor__select" data-ch="pv-setting" data-key="${escape_html(s.key)}" aria-label="${escape_html(__(s.label))}">${cstr(s.choices)
					.split("\n")
					.filter(Boolean)
					.map((c) => `<option value="${escape_html(c)}" ${String(value) === String(c) ? "selected" : ""}>${escape_html(c)}</option>`)
					.join("")}</select>`;
			else control = `<input type="text" class="whatsapp-kit-command-editor__input whatsapp-kit-command-editor__input--text" data-f="pvs-${escape_html(s.key)}" data-in="pv-setting" data-key="${escape_html(s.key)}" value="${escape_html(value == null ? "" : value)}" aria-label="${escape_html(__(s.label))}" />`;
			return `<div class="whatsapp-kit-command-editor__card whatsapp-kit-command-editor__card--row whatsapp-kit-command-editor__card--surface">
				<span class="whatsapp-kit-command-editor__switch-text"><span class="whatsapp-kit-command-editor__card-name">${escape_html(__(s.label || s.key))}</span><span class="whatsapp-kit-command-editor__note">${escape_html(__("Default: {0}", [def]))}</span></span>
				<span class="whatsapp-kit-command-editor__control">${control}</span>
			</div>`;
		}

		mount_thread() {
			const $slot = this.$root.find("[data-slot=thread]");
			if (!$slot.length) return;
			const result = this.ui.result;
			if (this.ui.running && !result) {
				$slot.html(`<span class="whatsapp-kit-command-editor__none">${escape_html(__("Running the preview…"))}</span>`);
				return;
			}
			const now = frappe.datetime.now_datetime();
			const rows = [{ direction: "Inbound", name: "fd-in", ts: now, message_type: "Text", body: (result && result.text) || this.get_command_code() }];
			((result && result.replies) || []).forEach((rep, i) =>
				rows.push({
					direction: "Outbound",
					name: `fd-out-${i}`,
					ts: now,
					status: "Read",
					message_type: "Text",
					body: rep.message_type === "Document" ? `📎 ${rep.file_name || __("Document", null, "Command Editor")}` : rep.body || "",
				})
			);
			if (typeof whatsapp.ui.ChatThread === "function") {
				if (this.thread && this.thread.destroy) this.thread.destroy();
				this.thread = new whatsapp.ui.ChatThread({ wrapper: $slot, rows, empty_text: __("No reply") });
				$slot.toggleClass("is-running", !!this.ui.running);
			}
		}

		/** The word the preview "types": a linked command's, else a suggested one, else the key. */
		get_command_code() {
			const linked = (this.entry.linked_commands || [])[0];
			return (linked && linked.code) || (this.manifest.suggested_commands || [])[0] || this.entry.function_key;
		}

		schedule_preview() {
			if (this.ui.tab !== "preview" || this.preview_blocker()) return;
			clearTimeout(this._pv_timer);
			this._pv_timer = setTimeout(() => this.run_preview(), 450);
		}

		async run_preview() {
			if (this.preview_blocker()) return;
			const preview = this.ui.pv;
			const contact = preview.contact;
			const links = this.preview_contact_links();
			const account = links.find((l) => l.link_name === preview.account) || links[0] || null;
			const token = (this._pv_token = (this._pv_token || 0) + 1);
			this.ui.running = true;
			this.$root && this.$root.find("[data-slot=thread]").addClass("is-running");
			try {
				const outputs = this.outputs().map(({ o, text, file }) => Object.assign(clone(o), { template: text, file_name_template: file || o.file_name_template }));
				const result = await this.opts.preview({
					code: this.get_command_code(),
					settings: Object.assign({}, this.ui.opts),
					outputs,
					values: Object.assign({}, preview.values),
					sender: contact
						? { contact: contact.name, label: contact.label, phone: contact.phone, party_type: account ? account.link_doctype : null, party_name: account ? account.link_name : null }
						: { phone: null },
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

		async search_preview_contacts(q) {
			const preview = this.ui.pv;
			if (!this.opts.search_contacts) return [];
			preview.loading = true;
			preview.error = null;
			try {
				const rows = await this.opts.search_contacts(q || "", this.preview_party_type());
				// a slow answer to an earlier search must not replace the newer one (CommandEditor's guard)
				if (preview.q !== q && q !== "") return;
				preview.results = rows || [];
			} catch (err) {
				preview.results = [];
				preview.error = err && err.message;
			}
			preview.loading = false;
			return preview.results;
		}

		async enter_preview() {
			if (this.preview_blocker()) return;
			const preview = this.ui.pv;
			const type = this.preview_party_type();
			if (preview.loaded_for !== type) {
				preview.loaded_for = type;
				const rows = await this.search_preview_contacts("");
				if (!preview.contact && rows && rows.length) preview.contact = rows[0];
				this.render();
			}
			this.run_preview();
		}

		open_preview_contact_dropdown() {
			if (!this.ui.pv.open) {
				this.ui.pv.open = true;
				this.ui.pv.q = "";
				this.render();
			}
		}

		fill_examples() {
			const inputs = this.manifest.inputs || [];
			const words = String(this.manifest.example || "").trim().split(/\s+/).slice(1);
			inputs.forEach((v, i) => {
				if (v.example) this.ui.pv.values[v.key] = v.example;
				else if (v.rest && words.length > i) this.ui.pv.values[v.key] = words.slice(i).join(" ");
				else if (words[i] != null) this.ui.pv.values[v.key] = words[i];
			});
		}

		set_opt(key, value) {
			const s = (this.manifest.settings || []).find((x) => x.key === key);
			if (!s) return;
			this.ui.opts[key] = s.fieldtype === "Check" || s.fieldtype === "Int" ? (value === "" ? "" : cint(value)) : value;
		}

		// ---- footer -------------------------------------------------------------------------------

		render_footer() {
			const entry = this.entry;
			const options = this.opts;
			const more = options.more || [];
			return `<div class="whatsapp-kit-command-editor__foot">
				${entry.installed && entry.update_available && options.on_update ? `<button type="button" class="whatsapp-kit-command-editor__button whatsapp-kit-command-editor__button--primary" data-act="update">${escape_html(__("Update to {0}", [entry.latest_version]))}</button>` : ""}
				${options.on_toggle_install ? `<button type="button" class="whatsapp-kit-command-editor__button${entry.installed ? "" : " whatsapp-kit-command-editor__button--primary"}" data-act="install">${escape_html(entry.installed ? __("Uninstall") : __("Install the function"))}</button>` : ""}
				${options.on_open_commands ? `<button type="button" class="whatsapp-kit-command-editor__button whatsapp-kit-function-detail__button-primary-soft" data-act="commands">${escape_html(__("Linked commands", null, "Function Detail"))}</button>` : ""}
				<span class="whatsapp-kit-command-editor__foot-hint"></span>
				${
					more.length
						? `<span class="whatsapp-kit-function-detail__more">
							<button type="button" class="whatsapp-kit-command-editor__button" data-act="more" aria-haspopup="menu" aria-expanded="${this.ui.more}">${escape_html(__("More"))} ▾</button>
							${
								this.ui.more
									? `<span class="whatsapp-kit-command-editor__popover whatsapp-kit-function-detail__menu" role="menu">${more
											.map((m, i) => `<button type="button" role="menuitem" class="whatsapp-kit-command-editor__option${m.danger ? " whatsapp-kit-function-detail__danger" : ""}" data-act="more-item" data-key="${i}">${escape_html(m.label)}</button>`)
											.join("")}</span>`
									: ""
							}
						</span>`
						: ""
				}
				<button type="button" class="whatsapp-kit-command-editor__button whatsapp-kit-function-detail__close" data-act="close">${escape_html(__("Close"))}</button>
			</div>`;
		}

		// ---- events -------------------------------------------------------------------------------

		on_key(e) {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				if (this.ui.pv.open) this.ui.pv.open = false;
				else if (this.ui.more) this.ui.more = false;
				else return this.close();
				this.render();
				return;
			}
			whatsapp.ui.keep_tab_inside(e, this.$root);
		}

		on_outside(e) {
			const $t = $(e.target);
			let changed = false;
			if (this.ui.pv.open && !$t.closest('[data-pop="pv"]').length) {
				this.ui.pv.open = false;
				this.ui.pv.q = null;
				changed = true;
			}
			if (this.ui.more && !$t.closest(".whatsapp-kit-function-detail__more").length) {
				this.ui.more = false;
				changed = true;
			}
			if (changed && !$t.closest("[data-act]").length) setTimeout(() => this.render(), 0);
		}

		on_input(e) {
			const target_element = e.target;
			const kind = target_element.getAttribute("data-in");
			const key = target_element.getAttribute("data-key");
			const value = target_element.value;
			if (kind === "pv-q") {
				this.ui.pv.q = value;
				this.ui.pv.open = true;
				clearTimeout(this._pvq);
				this._pvq = setTimeout(() => this.search_preview_contacts(value).then(() => this.ui.pv.open && this.render()), 200);
				return this.render();
			}
			if (kind === "pv-val") this.ui.pv.values[key] = value;
			else if (kind === "pv-out") this.ui.outs[key] = value;
			else if (kind === "pv-file") this.ui.files[key] = value;
			else if (kind === "pv-setting") this.set_opt(key, value);
			this.schedule_preview();
		}

		on_change(e) {
			const target_element = e.target;
			if (target_element.getAttribute("data-ch") === "pv-setting") this.set_opt(target_element.getAttribute("data-key"), target_element.type === "checkbox" ? (target_element.checked ? 1 : 0) : target_element.value);
			this.render();
			this.schedule_preview();
		}

		on_act(e) {
			const $el = $(e.currentTarget);
			const act = $el.attr("data-act");
			const key = $el.attr("data-key");
			const options = this.opts;
			switch (act) {
				case "open_form":
					return whatsapp.ui.open_form(this, this.opts.form.doctype, this.opts.form.name);
				case "close":
					return this.close();
				case "tab":
					this.ui.tab = key;
					this.ui.pv.open = false;
					this.render();
					if (key === "preview") this.enter_preview();
					return;
				case "log":
					this.ui.log_open[key] = !($el.attr("aria-expanded") === "true");
					return this.render();
				case "copy":
					return this.copy_text_to_clipboard($el.attr("data-text"));
				case "commands":
					return options.on_open_commands && options.on_open_commands(this.entry);
				case "update":
					return options.on_update && options.on_update(this.entry);
				case "install":
					return options.on_toggle_install && options.on_toggle_install(this.entry);
				case "more":
					this.ui.more = !this.ui.more;
					return this.render();
				case "more-item": {
					const item = (options.more || [])[cint(key)];
					this.ui.more = false;
					this.render();
					return item && item.handler && item.handler(this.entry);
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
				case "pv-reset":
					Object.assign(this.ui, { opts: {}, outs: {}, files: {} });
					this.ui.pv.values = {};
					this.render();
					return this.run_preview();
				default:
			}
		}

		copy_text_to_clipboard(text) {
			if (frappe.utils && frappe.utils.copy_to_clipboard) frappe.utils.copy_to_clipboard(text);
			else if (navigator.clipboard) navigator.clipboard.writeText(String(text)).then(() => whatsapp.ui.Toast.success(__("Copied")));
		}
	}

	whatsapp.ui.FunctionDetail = FunctionDetail;
})();

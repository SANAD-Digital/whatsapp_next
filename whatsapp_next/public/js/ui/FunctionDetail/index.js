// sanad.ui.FunctionDetail — the prototype's function window (`docs/component/Function Detail.dc.html`):
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
// It draws on the shell of `sanad.ui.CommandEditor` (the two prototypes share it value for value),
// so it needs that component's styles. Portable: the host passes the data and the verbs.

frappe.provide("sanad.ui");

(function () {
	const esc = (v) => sanad.ui.escape(v);
	const clone = (v) => JSON.parse(JSON.stringify(v == null ? null : v));
	const SETTING_TYPE = { Check: "check", Int: "number", Select: "select", Data: "text" };
	const COPY_ICON =
		'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"></path></svg>';

	const vtuple = (v) => String(v || "").split(/[.-]/).map((p) => (/^\d+$/.test(p) ? cint(p) : 0));
	const vcmp = (a, b) => {
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
			this.id = sanad.ui.uid("sanad-fd");
			this.previous_focus = document.activeElement;
			this.$root = $(`
				<div class="sanad-kit sanad-ce-layer sanad-fd-layer" role="presentation">
					<div class="sanad-ce-backdrop" data-act="close"></div>
					<div class="sanad-ce sanad-fd" role="dialog" aria-modal="true" aria-labelledby="${this.id}-title">
						<div class="sanad-ce__body" data-slot="body"></div>
					</div>
				</div>`).appendTo(document.body);
			this.$body = this.$root.find("[data-slot=body]");
			$("body").addClass("sanad-ce-open");
			this.$root.on("click", "[data-act]", (e) => this.on_act(e));
			this.$root.on("input", "[data-in]", (e) => this.on_input(e));
			this.$root.on("change", "[data-ch]", (e) => this.on_change(e));
			this.$root.on("keydown", (e) => this.on_key(e));
			this.$root.on("focusin", "[data-focus-open]", () => this.open_pv());
			this.$root.on("mousedown", (e) => this.on_outside(e));
			if (sanad.ui.overlay) sanad.ui.overlay.open(this);
			this.render();
			const x = this.$root.find(".sanad-ce__x").get(0);
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
			if (!$(".sanad-ce-layer").length) $("body").removeClass("sanad-ce-open");
			if (sanad.ui.overlay) sanad.ui.overlay.close(this);
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

		fmt_date(d) {
			return d ? frappe.datetime.str_to_user(String(d).slice(0, 10)) : "";
		}

		ago(d) {
			try {
				return d ? frappe.datetime.prettyDate(d) : "";
			} catch (e) {
				return "";
			}
		}

		// ---- render -------------------------------------------------------------------------------

		render() {
			if (!this.$root) return;
			const active = document.activeElement;
			const focus_key = active && this.$root.get(0).contains(active) ? active.getAttribute("data-f") : null;
			const sel = focus_key && "selectionStart" in active ? [active.selectionStart, active.selectionEnd] : null;
			const scrolls = {};
			this.$root.find("[data-scroll]").each((_, el) => (scrolls[el.getAttribute("data-scroll")] = el.scrollTop));
			const tab = this.ui.tab;
			const body = tab === "details" ? this.render_details() : tab === "log" ? this.render_log() : this.render_preview();
			this.$body.html(`${this.render_header()}${body}${this.render_footer()}`);
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
			const e = this.entry;
			const on = e.status === "Active";
			const releases = e.releases || {};
			const cur = e.installed ? e.installed_version : e.latest_version;
			const tabs = [
				{ key: "details", label: __("Details", null, "Function Detail") },
				{ key: "log", label: __("Version log"), count: (e.versions || []).length },
				{ key: "preview", label: __("Preview") },
			];
			return `
				<div class="sanad-ce__head">
					<div class="sanad-ce__head-row sanad-fd__head-row">
						<span class="sanad-fd__identity">
							<span class="sanad-fd__name" id="${this.id}-title">${esc(e.function_name || e.function_key)}</span>
							<span class="sanad-fd__sub">
								<span class="sanad-ce__sub">${esc(e.category || __("Uncategorised"))}</span>
								${
									e.installed
										? `<span class="sanad-fd__badge ${on ? "sanad-fd__badge--ok" : "sanad-fd__badge--muted"}">${esc(on ? __("Active", null, "Function Detail") : __("Stopped", null, "Function Detail"))}</span>`
										: ""
								}
								<span class="sanad-fd__badge sanad-fd__badge--line ${e.installed ? "sanad-fd__badge--pri" : ""}">${esc(e.installed ? __("Installed", null, "Function Detail") : __("Not installed", null, "Function Detail"))}</span>
							</span>
						</span>
						<button type="button" class="sanad-ce__x sanad-fd__x" data-act="close" title="${esc(__("Close (Esc)"))}" aria-label="${esc(__("Close"))}">×</button>
					</div>
					<div class="sanad-ce__head-row sanad-ce__head-row--tabs sanad-fd__tabs-row">
						<span class="sanad-ce__tabs" role="tablist">
							${tabs
								.map(
									(t) => `<button type="button" role="tab" class="sanad-ce__tab${this.ui.tab === t.key ? " is-sel" : ""}" aria-selected="${this.ui.tab === t.key}" data-act="tab" data-key="${t.key}">
										${esc(t.label)}${t.count != null ? `<span class="sanad-ce__count" dir="ltr">${sanad.ui.format_int(t.count)}</span>` : ""}
									</button>`
								)
								.join("")}
						</span>
						<span class="sanad-ce__meta">
							${cur ? `<span class="sanad-fd__ver sanad-fd__ver--pri" dir="ltr">${esc(__("Current {0} · {1}", [cur, this.fmt_date((releases[cur] || {}).released)]))}</span>` : ""}
							${
								e.installed && e.update_available
									? `<span class="sanad-fd__ver sanad-fd__ver--wn" dir="ltr">${esc(__("Latest {0} · {1}", [e.latest_version, this.fmt_date((releases[e.latest_version] || {}).released)]))}</span>`
									: ""
							}
						</span>
					</div>
				</div>`;
		}

		render_details() {
			const e = this.entry;
			const m = this.manifest;
			const linked = e.linked_commands || [];
			const party = (m.party_types && m.party_types.length ? m.party_types : e.party_types) || [];
			const words = m.suggested_commands || [];
			const stats = [
				[__("Calls (30d)", null, "Function Detail"), sanad.ui.format_int(cint(e.calls_30d))],
				[__("Average run time"), cint(e.avg_ms) ? `${sanad.ui.format_int(e.avg_ms)} ms` : "—"],
				[__("Linked commands"), sanad.ui.format_int(linked.length)],
				[__("Active of them"), sanad.ui.format_int(linked.filter((c) => c.status === "Active").length)],
			];
			const about = `
				<p class="sanad-fd__lede" dir="auto">${esc(e.description || __("No description in the catalog."))}</p>
				<div class="sanad-ce__box sanad-fd__box">
					<span class="sanad-fd__box-title">${esc(__("When exactly to use it"))}</span>
					<span class="sanad-fd__box-text" dir="auto">${esc(e.when_to_use || __("The catalog does not say when to use it."))}</span>
				</div>
				<div class="sanad-ce__box sanad-fd__box">
					<span class="sanad-fd__box-title">${esc(__("Party type the function serves"))}</span>
					<span class="sanad-ce__chips">${(party.length ? party.map((p) => __(p)) : [__("General")]).map((p) => `<span class="sanad-fd__tag">${esc(p)}</span>`).join("")}</span>
				</div>
				<div class="sanad-fd__stats">
					${stats.map(([k, v]) => `<span class="sanad-fd__stat"><span class="sanad-fd__stat-k">${esc(k)}</span><span class="sanad-fd__stat-v" dir="ltr">${esc(v)}</span></span>`).join("")}
				</div>
				${
					words.length
						? `<div class="sanad-ce__field sanad-ce__field--tight">
							<span class="sanad-fd__h">${esc(__("Suggested commands for this function"))}</span>
							<span class="sanad-ce__chips">${words.map((w) => `<span class="sanad-fd__word">${esc(w)}</span>`).join("")}</span>
						</div>`
						: ""
				}
				<div class="sanad-ce__field sanad-ce__field--tight">
					<span class="sanad-ce__card-row"><span class="sanad-fd__h">${esc(__("Linked commands", null, "Function Detail"))}</span>${
						this.opts.on_open_commands ? `<button type="button" class="sanad-ce__link" data-act="commands">${esc(__("Open in commands"))}</button>` : ""
					}</span>
					<span class="sanad-ce__chips">
						${linked.map((c) => `<span class="sanad-fd__cmd${c.status === "Active" ? " is-on" : ""}">${esc(c.code || c.name)}</span>`).join("")}
						${linked.length ? "" : `<span class="sanad-ce__note">${esc(__("No command is linked to this function yet."))}</span>`}
					</span>
				</div>`;
			const inputs = m.inputs || [];
			const settings = m.settings || [];
			const vars = `
				${
					inputs.length
						? `<div class="sanad-ce__field"><span class="sanad-fd__h sanad-fd__h--strong">${esc(__("Variables it can handle"))}</span><div class="sanad-ce__stack">${inputs
								.map(
									(v) => `<div class="sanad-ce__card">
										<div class="sanad-ce__card-row sanad-ce__card-row--wrap">
											<span class="sanad-ce__card-title">
												<span class="sanad-ce__mono" dir="ltr">#${esc(v.key)}</span>
												<span class="sanad-ce__sub">${esc(__(v.label || v.key))}</span>
												${v.required ? `<span class="sanad-ce__tag sanad-ce__tag--warn">${esc(__("Required"))}</span>` : ""}
											</span>
											<span class="sanad-ce__control">
												<span class="sanad-ce__tag sanad-ce__mono" dir="ltr">${esc((v.type || "str") + (v.options ? ` · ${v.options}` : ""))}</span>
												${v.example ? `<span class="sanad-ce__example sanad-ce__mono" dir="ltr">${esc(v.example)}</span>` : ""}
											</span>
										</div>
										${v.notes || v.details ? `<span class="sanad-ce__note" dir="auto">${esc(__(v.notes || v.details))}</span>` : ""}
									</div>`
								)
								.join("")}</div></div>`
						: `<span class="sanad-ce__empty">${esc(__("This function takes no variables: the command word alone runs it."))}</span>`
				}
				${
					settings.length
						? `<div class="sanad-ce__field"><span class="sanad-fd__h sanad-fd__h--strong">${esc(__("Options the function can use"))}</span><div class="sanad-ce__stack">${settings
								.map((s) => {
									const value = this.setting_value(s);
									const shown = s.fieldtype === "Check" ? (cint(value) ? __("Yes") : __("No")) : cstr(value) || "—";
									const choices = cstr(s.choices).split("\n").filter(Boolean);
									return `<div class="sanad-ce__card">
										<div class="sanad-ce__card-row sanad-ce__card-row--wrap">
											<span class="sanad-ce__card-name">${esc(__(s.label || s.key))}</span>
											<span class="sanad-ce__control"><span class="sanad-ce__tag">${esc(this.type_label(s))}</span><span class="sanad-fd__value">${esc(shown)}</span></span>
										</div>
										${s.notes ? `<span class="sanad-ce__note" dir="auto">${esc(__(s.notes))}</span>` : ""}
										${choices.length ? `<span class="sanad-fd__choices sanad-ce__mono" dir="ltr">${esc(choices.join(" · "))}</span>` : ""}
									</div>`;
								})
								.join("")}</div></div>`
						: ""
				}`;
			const outs = this.outputs();
			const outputs = `
				<span class="sanad-fd__h sanad-fd__h--strong">${esc(__("Outputs expected from the function"))}</span>
				${outs
					.map(({ o, key, is_doc }) => {
						const fields = cstr(o.variables)
							.split(/[,\n]/)
							.map((v) => v.trim())
							.filter(Boolean);
						return `<div class="sanad-ce__out">
							<span class="sanad-ce__card-row sanad-ce__card-row--wrap">
								<span class="sanad-fd__out-name"><span class="sanad-fd__bar" aria-hidden="true"></span>${esc(__(o.label || key))}</span>
								<span class="sanad-ce__tag">${esc(is_doc ? __("Document", null, "Command Editor") : __("Text"))}</span>
							</span>
							${o.notes ? `<span class="sanad-ce__note" dir="auto">${esc(__(o.notes))}</span>` : ""}
							${
								o.default_template
									? `<div class="sanad-fd__copybox"><span class="sanad-fd__copytext" dir="auto">${esc(o.default_template)}</span>${this.copy_btn(o.default_template, __("Copy the text"))}</div>`
									: ""
							}
							${
								o.file_name_template
									? `<div class="sanad-ce__field sanad-ce__field--tight"><span class="sanad-ce__note">${esc(__("Default file name"))}</span><div class="sanad-fd__copybox sanad-fd__copybox--sm"><span class="sanad-fd__copytext">${esc(
											o.file_name_template
									  )}</span>${this.copy_btn(o.file_name_template, __("Copy the file name"))}</div></div>`
									: ""
							}
							${
								fields.length
									? `<div class="sanad-ce__field sanad-ce__field--tight"><span class="sanad-ce__note">${esc(__("Fields you can use — click to copy"))}</span><span class="sanad-ce__chips sanad-ce__chips--tight">${fields
											.map((f) => `<button type="button" class="sanad-fd__field sanad-ce__mono" dir="ltr" data-act="copy" data-text="${esc(`{{ ${f} }}`)}">{{ ${esc(f)} }}</button>`)
											.join("")}</span></div>`
									: ""
							}
						</div>`;
					})
					.join("")}
				${outs.length ? "" : `<span class="sanad-ce__empty sanad-ce__empty--surface">${esc(__("This function defines no outputs."))}</span>`}`;
			return `<div class="sanad-ce__grid sanad-ce__grid--setup sanad-fd__grid">
				<section class="sanad-ce__col sanad-ce__col--span" data-scroll="about"><div class="sanad-ce__col-body sanad-fd__body">${about}</div></section>
				<section class="sanad-ce__col" data-scroll="vars"><div class="sanad-ce__col-body sanad-fd__body">${vars}</div></section>
				<section class="sanad-ce__col sanad-ce__col--bg" data-scroll="outs"><div class="sanad-ce__col-body sanad-fd__body sanad-fd__body--outs">${outputs}</div></section>
			</div>`;
		}

		copy_btn(text, title) {
			return `<button type="button" class="sanad-fd__copy" data-act="copy" data-text="${esc(text)}" title="${esc(title)}" aria-label="${esc(title)}">${COPY_ICON}</button>`;
		}

		type_label(s) {
			const kind = SETTING_TYPE[s.fieldtype] || "text";
			return { check: __("Yes / No"), number: __("Number"), select: __("List"), text: __("Text") }[kind];
		}

		render_log() {
			const e = this.entry;
			const releases = e.releases || {};
			const versions = (e.versions || []).slice().sort((a, b) => vcmp(b, a));
			const cards = versions
				.map((v, i) => {
					const rel = releases[v] || {};
					const note = cstr(rel.changelog || (e.changelog || {})[v]).trim();
					const changes = note ? note.split(/\n+/).map((s) => s.replace(/^[-*•]\s*/, "").trim()).filter(Boolean) : [];
					const open = this.ui.log_open[v] != null ? this.ui.log_open[v] : i === 0;
					const latest = v === e.latest_version;
					const current = e.installed && v === e.installed_version;
					const badge = latest ? __("Latest", null, "Function Detail") : current ? __("Installed now") : "";
					return `<div class="sanad-fd__log${current ? " is-current" : ""}">
						<button type="button" class="sanad-fd__log-head" data-act="log" data-key="${esc(v)}" aria-expanded="${open}">
							<span class="sanad-fd__arrow" aria-hidden="true">${open ? "▾" : "▸"}</span>
							<span class="sanad-fd__log-v" dir="ltr">${esc(v)}</span>
							${badge ? `<span class="sanad-fd__badge ${latest ? "sanad-fd__badge--wn" : "sanad-fd__badge--pri"}">${esc(badge)}</span>` : ""}
							<span class="sanad-ce__sub">${esc(this.fmt_date(rel.released))}</span>
							<span class="sanad-ce__note">${esc(this.ago(rel.released))}</span>
							<span class="sanad-fd__log-n">${esc(sanad.ui.plural(changes.length, { one: __("{0} change"), other: __("{0} changes") }))}</span>
						</button>
						${
							open
								? `<div class="sanad-fd__changes">${(changes.length ? changes : [__("No note for this version.")])
										.map((c) => `<span class="sanad-fd__change"><span class="sanad-fd__bullet" aria-hidden="true"></span><span dir="auto">${esc(c)}</span></span>`)
										.join("")}</div>`
								: ""
						}
					</div>`;
				})
				.join("");
			return `<div class="sanad-ce__pane sanad-fd__pane" data-scroll="log">${cards || `<span class="sanad-ce__empty sanad-ce__empty--surface">${esc(__("No versions in the catalog."))}</span>`}</div>`;
		}

		// ---- preview ------------------------------------------------------------------------------

		pv_type() {
			return this.ui.pv.party_type || (this.party_types()[0] || {}).key || null;
		}

		pv_links() {
			const c = this.ui.pv.contact;
			return c ? (c.links || []).filter((l) => l.link_doctype === this.pv_type()) : [];
		}

		preview_blocker() {
			if (!this.entry.installed) return __("Install the function to preview it: the preview runs the installed handler.");
			if (!this.opts.preview) return __("Only a WhatsApp manager can run the preview.");
			return null;
		}

		render_preview() {
			const blocker = this.preview_blocker();
			if (blocker) return `<div class="sanad-ce__pane" data-scroll="pv"><span class="sanad-ce__empty sanad-ce__empty--surface">${esc(blocker)}</span></div>`;
			const pv = this.ui.pv;
			const type = this.pv_type();
			const c = pv.contact;
			const links = this.pv_links();
			const account = links.find((l) => l.link_name === pv.account) || links[0] || null;
			const inputs = this.manifest.inputs || [];
			const search_value = pv.q == null ? (c ? c.label || c.phone || "" : "") : pv.q;
			const assumptions = `
				<div class="sanad-ce__field sanad-ce__field--tight">
					<span class="sanad-ce__label">${esc(__("Party type"))}</span>
					<span class="sanad-ce__chips">${this.party_types()
						.map((p) => `<button type="button" class="sanad-ce__pill${p.key === type ? " is-on" : ""}" aria-pressed="${p.key === type}" data-act="pv-type" data-key="${esc(p.key)}">${esc(p.label)}</button>`)
						.join("")}</span>
				</div>
				<div class="sanad-ce__field">
					<label class="sanad-ce__label" for="${this.id}-pv">${esc(__("Contact", null, "Function Detail"))}</label>
					<span class="sanad-ce__combo" data-pop="pv">
						<input id="${this.id}-pv" type="text" class="sanad-ce__input" data-f="pv-q" data-in="pv-q" data-focus-open="pv" value="${esc(search_value)}" placeholder="${esc(__("Search by name or number…"))}" autocomplete="off" />
						${
							pv.open
								? `<span class="sanad-ce__pop" role="listbox">
									${(pv.results || [])
										.map(
											(r) => `<button type="button" role="option" class="sanad-ce__opt${c && r.name === c.name ? " is-sel" : ""}" data-act="pv-pick" data-name="${esc(r.name)}">${esc(r.label || __("Unnamed"))}<span class="sanad-ce__opt-sub sanad-ce__mono" dir="ltr">${esc(r.phone || "")}</span></button>`
										)
										.join("")}
									${pv.loading ? `<span class="sanad-ce__none">${esc(__("Loading…"))}</span>` : (pv.results || []).length ? "" : `<span class="sanad-ce__none">${esc(pv.error || __("No matching contacts."))}</span>`}
								</span>`
								: ""
						}
					</span>
					${c ? "" : `<span class="sanad-ce__note">${esc(__("No sender picked — the preview assumes a number that is not linked."))}</span>`}
				</div>
				${
					links.length
						? `<div class="sanad-ce__box"><span class="sanad-ce__note">${esc(__("Accounts linked to the contact"))}</span><span class="sanad-ce__chips">${links
								.map((l) => `<button type="button" class="sanad-ce__pill${account && l.link_name === account.link_name ? " is-on" : ""}" data-act="pv-acc" data-key="${esc(l.link_name)}">${esc(l.link_title || l.link_name)}</button>`)
								.join("")}</span></div>`
						: ""
				}
				${
					inputs.length
						? `<div class="sanad-ce__field sanad-ce__field--tight">
							<span class="sanad-ce__card-row"><span class="sanad-ce__label">${esc(__("Variables passed in the command text"))}</span><button type="button" class="sanad-ce__link" data-act="pv-fill">${esc(__("Fill with examples"))}</button></span>
							<div class="sanad-ce__stack">${inputs
								.map((v) => {
									const val = pv.values[v.key] || "";
									return `<span class="sanad-ce__card${v.required && !String(val).trim() ? " is-missing" : ""}">
										<span class="sanad-ce__card-row"><span class="sanad-ce__mono" dir="ltr">#${esc(v.key)}</span>${v.required ? `<span class="sanad-ce__tag sanad-ce__tag--warn">${esc(__("Required"))}</span>` : ""}</span>
										<input type="text" dir="ltr" class="sanad-ce__input sanad-ce__input--surface sanad-ce__mono" data-f="pv-${esc(v.key)}" data-in="pv-val" data-key="${esc(v.key)}" value="${esc(val)}" placeholder="${esc(v.example || v.key)}" aria-label="${esc(__(v.label || v.key))}" />
										<span class="sanad-ce__note">${esc(__(v.label || ""))}</span>
									</span>`;
								})
								.join("")}</div>
						</div>`
						: ""
				}`;
			const settings = (this.manifest.settings || []).map((s) => this.render_setting(s)).join("");
			const outs = this.outputs()
				.map(
					({ o, key, is_doc, text, file }) => `<div class="sanad-ce__out">
						<span class="sanad-ce__card-row sanad-ce__card-row--wrap"><span class="sanad-ce__out-name">${esc(__(o.label || key))}</span><span class="sanad-ce__tag">${esc(is_doc ? __("Document", null, "Command Editor") : __("Text"))}</span></span>
						${
							is_doc
								? `<input type="text" class="sanad-ce__input sanad-ce__input--sm" data-f="pvf-${esc(key)}" data-in="pv-file" data-key="${esc(key)}" value="${esc(file)}" aria-label="${esc(__("Attached file name"))}" />`
								: `<textarea class="sanad-ce__textarea" rows="${Math.min(7, Math.max(3, Math.ceil(String(text).length / 52)))}" data-f="pvo-${esc(key)}" data-in="pv-out" data-key="${esc(key)}" aria-label="${esc(__(o.label || key))}">${esc(text)}</textarea>`
						}
					</div>`
				)
				.join("");
			const r = this.ui.result;
			const c_label = c ? c.label || __("Unnamed") : __("Unknown number");
			const linked = !!(c && links.length);
			const result = `
				<div class="sanad-ce__phone">
					<div class="sanad-ce__phone-head">
						<span class="sanad-ce__avatar" aria-hidden="true">${esc(String((c && c.label) || "?").trim().slice(0, 2))}</span>
						<span class="sanad-ce__switch-text"><span class="sanad-ce__card-name">${esc(c_label)}</span><span class="sanad-ce__opt-sub sanad-ce__mono" dir="ltr">${esc((c && c.phone) || "")}</span></span>
						<span class="sanad-ce__tag ${linked ? "sanad-ce__tag--ok" : "sanad-ce__tag--warn"}">${esc(linked ? __("Linked to an account", null, "Command Editor") : __("Not linked"))}</span>
					</div>
					<span class="sanad-ce__phone-note">${esc(__("The reply comes from the function's output texts, run for real without sending."))}</span>
					<div class="sanad-ce__thread" data-slot="thread" aria-live="polite"></div>
				</div>
				${
					r && r.missing && r.missing.length && r.status !== "Blocked"
						? `<div class="sanad-ce__callout sanad-ce__callout--warn"><strong>${esc(__("Not enough data to run the function"))}</strong><span>${esc(
								__("The message text must contain: {0}", [r.missing.map((x) => `#${x.key}${x.label ? ` (${x.label})` : ""}`).join(__(", "))])
						  )}</span></div>`
						: ""
				}
				${r && r.status === "Blocked" ? `<div class="sanad-ce__callout sanad-ce__callout--muted"><span>${esc(__("Refused: {0}", [__(r.block_reason || "")]))}</span></div>` : ""}
				${this.ui.error ? `<div class="sanad-ce__callout sanad-ce__callout--danger" role="alert"><span>${esc(this.ui.error)}</span></div>` : ""}`;
			return `<div class="sanad-ce__grid sanad-ce__grid--preview sanad-fd__grid--preview">
				${this.col(__("Preview assumptions"), assumptions, "pv-a")}
				${this.col(
					__("Options and texts for this preview"),
					`<span class="sanad-ce__note">${esc(__("Changes here are for the preview only; they change neither the function nor the commands."))}</span>${settings}${outs}`,
					"pv-o",
					"bg",
					{ act: "pv-reset", label: __("Back to the function's defaults") }
				)}
				<section class="sanad-ce__col sanad-ce__col--bg sanad-ce__col--last" data-scroll="pv-r" aria-label="${esc(__("The result after rendering"))}">
					<header class="sanad-ce__col-head"><span class="sanad-ce__col-title">${esc(__("The result after rendering"))}</span><span class="sanad-ce__sim"><span class="sanad-ce__dot sanad-ce__dot--wn"></span>${esc(__("Simulation — nothing sent"))}</span></header>
					<div class="sanad-ce__col-body sanad-ce__col-body--result">${result}</div>
				</section>
			</div>`;
		}

		col(title, body, key, tone = "surface", link = null) {
			return `<section class="sanad-ce__col sanad-ce__col--${tone}" data-scroll="${key}" aria-label="${esc(title)}">
				<header class="sanad-ce__col-head"><span class="sanad-ce__col-title">${esc(title)}</span>${link ? `<button type="button" class="sanad-ce__link" data-act="${link.act}">${esc(link.label)}</button>` : ""}</header>
				<div class="sanad-ce__col-body">${body}</div>
			</section>`;
		}

		render_setting(s) {
			const kind = SETTING_TYPE[s.fieldtype] || "text";
			const value = this.setting_value(s);
			const def = s.fieldtype === "Check" ? (cint(s.default_value) ? __("Yes") : __("No")) : s.default_value == null || s.default_value === "" ? "—" : s.default_value;
			let control;
			if (kind === "check") control = `<input type="checkbox" class="sanad-ce__check" data-ch="pv-setting" data-key="${esc(s.key)}" ${cint(value) ? "checked" : ""} aria-label="${esc(__(s.label))}" />`;
			else if (kind === "number") control = `<input type="number" class="sanad-ce__input sanad-ce__input--num sanad-ce__mono" data-f="pvs-${esc(s.key)}" data-in="pv-setting" data-key="${esc(s.key)}" value="${esc(value == null ? "" : value)}" aria-label="${esc(__(s.label))}" />`;
			else if (kind === "select")
				control = `<select class="sanad-ce__input sanad-ce__select" data-ch="pv-setting" data-key="${esc(s.key)}" aria-label="${esc(__(s.label))}">${cstr(s.choices)
					.split("\n")
					.filter(Boolean)
					.map((c) => `<option value="${esc(c)}" ${String(value) === String(c) ? "selected" : ""}>${esc(c)}</option>`)
					.join("")}</select>`;
			else control = `<input type="text" class="sanad-ce__input sanad-ce__input--text" data-f="pvs-${esc(s.key)}" data-in="pv-setting" data-key="${esc(s.key)}" value="${esc(value == null ? "" : value)}" aria-label="${esc(__(s.label))}" />`;
			return `<div class="sanad-ce__card sanad-ce__card--row sanad-ce__card--surface">
				<span class="sanad-ce__switch-text"><span class="sanad-ce__card-name">${esc(__(s.label || s.key))}</span><span class="sanad-ce__note">${esc(__("Default: {0}", [def]))}</span></span>
				<span class="sanad-ce__control">${control}</span>
			</div>`;
		}

		mount_thread() {
			const $slot = this.$root.find("[data-slot=thread]");
			if (!$slot.length) return;
			const r = this.ui.result;
			if (this.ui.running && !r) {
				$slot.html(`<span class="sanad-ce__none">${esc(__("Running the preview…"))}</span>`);
				return;
			}
			const now = frappe.datetime.now_datetime();
			const rows = [{ direction: "Inbound", name: "fd-in", ts: now, message_type: "Text", body: (r && r.text) || this.code() }];
			((r && r.replies) || []).forEach((rep, i) =>
				rows.push({
					direction: "Outbound",
					name: `fd-out-${i}`,
					ts: now,
					status: "Read",
					message_type: "Text",
					body: rep.message_type === "Document" ? `📎 ${rep.file_name || __("Document", null, "Command Editor")}` : rep.body || "",
				})
			);
			if (typeof sanad.ui.ChatThread === "function") {
				if (this.thread && this.thread.destroy) this.thread.destroy();
				this.thread = new sanad.ui.ChatThread({ wrapper: $slot, rows, empty_text: __("No reply") });
				$slot.toggleClass("is-running", !!this.ui.running);
			}
		}

		/** The word the preview "types": a linked command's, else a suggested one, else the key. */
		code() {
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
			const pv = this.ui.pv;
			const c = pv.contact;
			const links = this.pv_links();
			const account = links.find((l) => l.link_name === pv.account) || links[0] || null;
			const token = (this._pv_token = (this._pv_token || 0) + 1);
			this.ui.running = true;
			this.$root && this.$root.find("[data-slot=thread]").addClass("is-running");
			try {
				const outputs = this.outputs().map(({ o, text, file }) => Object.assign(clone(o), { template: text, file_name_template: file || o.file_name_template }));
				const result = await this.opts.preview({
					code: this.code(),
					settings: Object.assign({}, this.ui.opts),
					outputs,
					values: Object.assign({}, pv.values),
					sender: c
						? { contact: c.name, label: c.label, phone: c.phone, party_type: account ? account.link_doctype : null, party_name: account ? account.link_name : null }
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

		async load_pv_contacts(q) {
			const pv = this.ui.pv;
			if (!this.opts.search_contacts) return [];
			pv.loading = true;
			pv.error = null;
			try {
				pv.results = (await this.opts.search_contacts(q || "", this.pv_type())) || [];
			} catch (err) {
				pv.results = [];
				pv.error = err && err.message;
			}
			pv.loading = false;
			return pv.results;
		}

		async enter_preview() {
			if (this.preview_blocker()) return;
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

		open_pv() {
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
			const e = this.entry;
			const o = this.opts;
			const more = o.more || [];
			return `<div class="sanad-ce__foot">
				${e.installed && e.update_available && o.on_update ? `<button type="button" class="sanad-ce__btn sanad-ce__btn--pri" data-act="update">${esc(__("Update to {0}", [e.latest_version]))}</button>` : ""}
				${o.on_toggle_install ? `<button type="button" class="sanad-ce__btn${e.installed ? "" : " sanad-ce__btn--pri"}" data-act="install">${esc(e.installed ? __("Uninstall") : __("Install the function"))}</button>` : ""}
				${o.on_open_commands ? `<button type="button" class="sanad-ce__btn sanad-fd__btn-pri-soft" data-act="commands">${esc(__("Linked commands", null, "Function Detail"))}</button>` : ""}
				<span class="sanad-ce__foot-hint"></span>
				${
					more.length
						? `<span class="sanad-fd__more">
							<button type="button" class="sanad-ce__btn" data-act="more" aria-haspopup="menu" aria-expanded="${this.ui.more}">${esc(__("More"))} ▾</button>
							${
								this.ui.more
									? `<span class="sanad-ce__pop sanad-fd__menu" role="menu">${more
											.map((m, i) => `<button type="button" role="menuitem" class="sanad-ce__opt${m.danger ? " sanad-fd__danger" : ""}" data-act="more-item" data-key="${i}">${esc(m.label)}</button>`)
											.join("")}</span>`
									: ""
							}
						</span>`
						: ""
				}
				<button type="button" class="sanad-ce__btn sanad-fd__close" data-act="close">${esc(__("Close"))}</button>
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
			if (e.key === "Tab") {
				const nodes = this.$root.find("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])").filter(":visible").get();
				if (!nodes.length) return;
				if (e.shiftKey && document.activeElement === nodes[0]) {
					e.preventDefault();
					nodes[nodes.length - 1].focus();
				} else if (!e.shiftKey && document.activeElement === nodes[nodes.length - 1]) {
					e.preventDefault();
					nodes[0].focus();
				}
			}
		}

		on_outside(e) {
			const $t = $(e.target);
			let changed = false;
			if (this.ui.pv.open && !$t.closest('[data-pop="pv"]').length) {
				this.ui.pv.open = false;
				this.ui.pv.q = null;
				changed = true;
			}
			if (this.ui.more && !$t.closest(".sanad-fd__more").length) {
				this.ui.more = false;
				changed = true;
			}
			if (changed && !$t.closest("[data-act]").length) setTimeout(() => this.render(), 0);
		}

		on_input(e) {
			const el = e.target;
			const kind = el.getAttribute("data-in");
			const key = el.getAttribute("data-key");
			const v = el.value;
			if (kind === "pv-q") {
				this.ui.pv.q = v;
				this.ui.pv.open = true;
				clearTimeout(this._pvq);
				this._pvq = setTimeout(() => this.load_pv_contacts(v).then(() => this.ui.pv.open && this.render()), 200);
				return this.render();
			}
			if (kind === "pv-val") this.ui.pv.values[key] = v;
			else if (kind === "pv-out") this.ui.outs[key] = v;
			else if (kind === "pv-file") this.ui.files[key] = v;
			else if (kind === "pv-setting") this.set_opt(key, v);
			this.schedule_preview();
		}

		on_change(e) {
			const el = e.target;
			if (el.getAttribute("data-ch") === "pv-setting") this.set_opt(el.getAttribute("data-key"), el.type === "checkbox" ? (el.checked ? 1 : 0) : el.value);
			this.render();
			this.schedule_preview();
		}

		on_act(e) {
			const $el = $(e.currentTarget);
			const act = $el.attr("data-act");
			const key = $el.attr("data-key");
			const o = this.opts;
			switch (act) {
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
					return this.copy($el.attr("data-text"));
				case "commands":
					return o.on_open_commands && o.on_open_commands(this.entry);
				case "update":
					return o.on_update && o.on_update(this.entry);
				case "install":
					return o.on_toggle_install && o.on_toggle_install(this.entry);
				case "more":
					this.ui.more = !this.ui.more;
					return this.render();
				case "more-item": {
					const item = (o.more || [])[cint(key)];
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

		copy(text) {
			if (frappe.utils && frappe.utils.copy_to_clipboard) frappe.utils.copy_to_clipboard(text);
			else if (navigator.clipboard) navigator.clipboard.writeText(String(text)).then(() => sanad.ui.Toast.success(__("Copied")));
		}
	}

	sanad.ui.FunctionDetail = FunctionDetail;
})();

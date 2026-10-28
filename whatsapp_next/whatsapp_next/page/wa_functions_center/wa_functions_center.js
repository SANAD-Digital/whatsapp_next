// Functions Center (09 row 7, spec §5.6, WHATSAPP_NEXT_INTEGRATION §4) — the functions of this site. A
// function is a Server Script (type API, method `wa_fn_…`) that carries a WA-FUNCTION header: what it
// does, who it serves, what it needs on the site (@requires), the values it takes (@param), the texts
// it writes (@default) and the replies it sends (@reply). This screen lists every such script —
// available, unavailable (with the reasons), with an invalid header (with its line), installed, or
// changed since it was installed — and installs, updates, configures, tries and switches them.
//
// Anatomy, from the prototype (`docs/screen/Hub Screen - Functions.dc.html`) drawn with the kit:
// the product's `PageHeader`, the four `Cards`, the shared `FilterBar` and the kit's `DataList` in
// page mode. The scripts come whole from `functions.get_catalog`, so this screen owns the rows, the
// filtering, the sorting and the paging and hands the table one page at a time.
//
// The function opens as the prototype's function window (`sanad.ui.FunctionDetail`, D-133); its
// header is drawn as variables · options · outputs by `whatsapp_next.functions` (screens/
// function_spec.js). A form is an `OverlayPanel`: the diff before install or update, the values
// form (built from the header's parameters, a message text per language) and the "Try" run. Every
// read and write goes through `sanad.ui.call` to `functions.*` / `commands.*`.

(() => {
	const ROUTE = "wa-functions-center";
	const ui = sanad.ui;
	const kit = sanad.kit;
	const esc = (v) => ui.escape(v == null ? "" : v);
	const fmt_int = (v) => ui.format_int(v);
	const is_manager = () => frappe.user.has_role("WhatsApp Manager") || frappe.user.has_role("System Manager");
	const command_list = (entry) => frappe.set_route("List", "WhatsApp Command", entry ? { function: entry.function_key } : {});

	/** `1.10.0` sorts after `1.9.0`: compare versions the way the server does. */
	const version_tuple = (v) => cstr(v).split(/[.-]/).map((p) => (/^\d+$/.test(p) ? cint(p) : 0));
	const version_cmp = (a, b) => {
		const ta = version_tuple(a);
		const tb = version_tuple(b);
		for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
			const d = (ta[i] || 0) - (tb[i] || 0);
			if (d) return d;
		}
		return 0;
	};

	// ---- cell badges (the table keeps the kit's StatusBadge like every other list) ------------

	/** Update state is a fact about two versions: it always reads as a word, never as a colour. */
	const update_badge = (e) =>
		e.update_available
			? ui.StatusBadge.html({ label: __("Update available"), colour: "orange" })
			: ui.StatusBadge.html({ label: __("Up to date"), colour: "green" });

	const status_badge = (e) =>
		e.installed
			? ui.StatusBadge.html({ label: __(e.status || "Active"), colour: e.status === "Active" ? "green" : "gray" })
			: `<span class="text-muted" aria-hidden="true">—</span><span class="sanad-visually-hidden">${esc(__("Not installed"))}</span>`;

	/** Installed, or why it cannot be: an invalid header, a site that lacks what it needs, a lost script. */
	const install_badge = (e) => {
		if (e.state === "invalid") return ui.StatusBadge.html({ label: __("Invalid header"), colour: "red" });
		if (e.state === "missing") return ui.StatusBadge.html({ label: __("Script missing"), colour: "red" });
		if (e.state === "unavailable") return ui.StatusBadge.html({ label: __("Unavailable"), colour: "orange" });
		return e.installed ? ui.StatusBadge.html({ label: __("Installed"), colour: "blue" }) : ui.StatusBadge.html({ label: __("Not installed"), colour: "gray" });
	};

	/** "12 ms" — the average run of the installed handler; a dash while it has never run. */
	const ms_text = (value) => (cint(value) ? __("{0} ms", [fmt_int(value)]) : "—");

	// ---- data ---------------------------------------------------------------------------------

	/**
	 * One screen row per catalog entry: the catalog's own fields, the 30-day run count of the
	 * commands bound to it (the prototype's "Calls (30 days)" column) and the installed record's
	 * average run time.
	 */
	function decorate(entries, commands, docs) {
		const by_key = {};
		(docs || []).forEach((d) => (by_key[d.name] = d));
		const calls = {};
		const linked = {};
		(commands || []).forEach((c) => {
			if (!c.function) return;
			calls[c.function] = (calls[c.function] || 0) + cint(c.run_count_30d);
			(linked[c.function] = linked[c.function] || []).push(c);
		});
		return (entries || []).map((e) =>
			Object.assign({}, e, {
				name: e.function_key || e.server_script, // the table addresses a row by `name`, like any Desk list
				// the API counts every bound command; the page's own sum only covers the commands it read
				calls_30d: e.calls_30d != null ? cint(e.calls_30d) : calls[e.function_key] || 0,
				linked_commands: linked[e.function_key] || [],
				avg_ms: cint((by_key[e.function_key] || {}).avg_ms),
				call_count: cint((by_key[e.function_key] || {}).call_count),
				error_count: cint((by_key[e.function_key] || {}).error_count),
			})
		);
	}

	// ---- the diff before install / update ----------------------------------------------------

	/**
	 * What install / update will change, from `functions.preview_install`: the two versions, the
	 * parameters and replies that move (added / removed / changed) and the commands that run on this
	 * function. It is the preview *and* the confirmation. A script the site cannot run (its
	 * `@requires`) shows why and cannot be installed.
	 */
	function confirm_change(entry, { on_close } = {}) {
		const installing = !entry.installed;
		let changed = false;
		const title = installing ? __("Install {0}?", [entry.function_name]) : __("Update {0}?", [entry.function_name]);
		const chips = (keys, tone) => (keys || []).map((k) => kit.badge(k, tone, { dot: false })).join("");
		const moved = (rows, key) => (rows || []).map((r) => kit.badge(`${r[key]} · ${Object.keys(r.fields || {}).join(", ")}`, "warn", { dot: false })).join("");
		const area = (label, d, key) => {
			const lines = [
				[__("Added"), chips(d.added, "ok")],
				[__("Removed"), chips(d.removed, "danger")],
				[__("Changed"), moved(d.changed, key)],
			].filter((l) => l[1]);
			if (!lines.length) return null;
			return {
				label,
				render: ($el) =>
					$el.html(
						lines
							.map((l) => `<div class="wa-fn-diff__line"><span class="wa-fn-diff__what">${esc(l[0])}</span><span class="wa-fn-diff__keys">${l[1]}</span></div>`)
							.join("")
					),
			};
		};
		return ui
			.call("functions.preview_install", { server_script: entry.server_script })
			.then((diff) => {
				const impacted = diff.commands_impacted || [];
				const count = (x) => (x.added || []).length + (x.removed || []).length + (x.changed || []).length;
				const moving = count(diff.params || {}) + count(diff.replies || {});
				const blocks = [
					area(__("Parameters"), diff.params || {}, "name"),
					area(__("Replies"), diff.replies || {}, "key"),
					{
						label: __("Commands that use this function"),
						list: impacted.map((c) => ({ text: c, badge: __("Command"), badge_tone: "muted" })),
						empty: __("No command uses this function yet."),
					},
				].filter(Boolean);
				const panel = new ui.OverlayPanel({
					type: "modal",
					width: "600px",
					title,
					subtitle: `${entry.installed_version || "—"} → ${diff.target_version || "—"}`,
					subtitle_mono: true,
					badge: installing ? { text: __("New install"), tone: "info" } : { text: __("Update"), tone: "ok" },
					detail: {
						alert: diff.available
							? {
									tone: "info",
									title: installing ? __("Installing reads the header of {0}.", [entry.server_script]) : __("The function takes the script's new header."),
									lines: [__("Nothing is sent. Commands, their words and their permissions stay as they are; the site's values stay for the parameters that kept their name.")],
							  }
							: {
									tone: "danger",
									title: __("This site cannot run the function."),
									lines: diff.reasons || [],
							  },
						facts: [
							{ k: __("Server Script"), v: entry.server_script, mono: true },
							{ k: __("Installed version"), v: entry.installed_version || __("None"), mono: !!entry.installed_version },
							{ k: __("Version in the script"), v: diff.target_version || "—", mono: true },
							{ k: __("Commands that benefit"), v: fmt_int(impacted.length), mono: true, tone: impacted.length ? "ok" : undefined },
						],
						blocks: moving ? blocks : blocks.slice(-1).concat([{ label: __("Parameters and replies"), text: __("Nothing changes in the parameters or the replies.") }]),
					},
					actions: [
						{ key: "cancel", label: __("Cancel"), close: true },
						{
							key: "go",
							label: installing ? __("Install") : __("Update"),
							variant: "primary",
							handler: () =>
								ui
									.call(installing ? "functions.install" : "functions.update", installing ? { server_script: entry.server_script } : { function_key: entry.function_key }, { silent: true })
									.then((r) => {
										changed = true;
										ui.Toast.success(installing ? __("{0} installed", [entry.function_name]) : __("{0} is now on {1}", [entry.function_name, (r && r.installed_version) || diff.target_version]));
									}),
						},
					],
					on_close: () => on_close && on_close(changed),
				}).show();
				if (!diff.available) panel.set_action_disabled("go", true);
				return panel;
			})
			.catch((err) => {
				ui.Toast.error(err);
				on_close && on_close(false);
			});
	}

	// ---- the site's values -----------------------------------------------------------------------

	/** The languages a message text can be written in: the header's own, the site's and the reader's. */
	const text_languages = (p) => {
		const langs = Object.keys((p && p.defaults_by_lang) || {});
		[frappe.boot.lang, frappe.boot.sysdefaults && frappe.boot.sysdefaults.language].forEach((l) => l && !langs.includes(l) && langs.push(l));
		return langs;
	};

	/**
	 * The site's values of an installed function (`functions.save_values`), built from its header's
	 * parameters: a Check as a toggle, a Select with its `@options`, a number, a date word or a date,
	 * a name — and each message text once for every language (empty = the header's text, shown as the
	 * placeholder) with the values it may use as the hint. Symbols such as `@default_company` are
	 * shown in the hint, never written as a value.
	 */
	function edit_values(entry, manifest, { on_close } = {}) {
		const params = (manifest && manifest.params) || [];
		let changed = false;
		if (!params.length) {
			ui.Toast.info(__("This function has no values to set."));
			on_close && on_close(false);
			return null;
		}
		const hint_of = (p) => {
			const bits = [];
			if (p.default) bits.push(__("Default: {0}", [p.default]));
			if (p.depends_on) bits.push(__("Only when {0} is {1}", [p.depends_on.param, p.depends_on.value]));
			if (p.required) bits.push(__("Required"));
			return bits.join(" · ") || undefined;
		};
		const fields = [];
		params.forEach((p) => {
			const raw = p.value;
			const df = { key: p.name, label: __(p.label || p.name), hint: hint_of(p) };
			if (p.fieldtype === "Template") {
				const vars = (p.vars || []).map((v) => `{{ ${v.name} }}`).join(" ");
				const by_lang = raw && typeof raw === "object" ? raw : { "": raw || "" };
				fields.push({
					key: `${p.name}::`,
					label: __("{0} — every language", [__(p.label || p.name)]),
					type: "textarea",
					rows: 5,
					value: by_lang[""] || "",
					placeholder: p.default || "",
					hint: vars ? __("Values: {0}", [vars]) : undefined,
				});
				text_languages(p).forEach((lang) =>
					fields.push({
						key: `${p.name}::${lang}`,
						label: __("{0} — {1}", [__(p.label || p.name), lang]),
						type: "textarea",
						rows: 5,
						value: by_lang[lang] || "",
						placeholder: (p.defaults_by_lang || {})[lang] || p.default || "",
					})
				);
				return;
			}
			if (p.fieldtype === "Check") return fields.push(Object.assign(df, { type: "toggle", value: raw == null || raw === "" ? cint(p.default) : cint(raw) }));
			if (p.fieldtype === "Select")
				return fields.push(
					Object.assign(df, {
						type: "select",
						value: cstr(raw),
						options: [{ value: "", label: __("Default") }].concat((p.select_options || []).map((v) => ({ value: v, label: __(v) }))),
					})
				);
			if (p.fieldtype === "Int") return fields.push(Object.assign(df, { type: "number", value: raw === "" || raw == null ? "" : Number(raw) }));
			return fields.push(Object.assign(df, { type: "text", value: cstr(raw), placeholder: p.default || "", mono: ["Date", "Link", "Dynamic"].includes(p.fieldtype) }));
		});
		return new ui.OverlayPanel({
			type: "modal",
			width: "640px",
			title: __("Values of {0}", [entry.function_name]),
			subtitle: entry.server_script,
			subtitle_mono: true,
			sections: [{ cols: 1, fields }],
			actions: [
				{ key: "cancel", label: __("Cancel"), close: true },
				{
					key: "save",
					label: __("Save values"),
					variant: "primary",
					requires_dirty: true,
					handler: (values) => {
						const payload = {};
						params.forEach((p) => {
							if (p.fieldtype === "Template") {
								const texts = {};
								["", ...text_languages(p)].forEach((lang) => {
									const v = values[`${p.name}::${lang}`];
									if (cstr(v).trim()) texts[lang] = v;
								});
								payload[p.name] = Object.keys(texts).length ? texts : null;
								return;
							}
							const v = values[p.name];
							payload[p.name] = p.fieldtype === "Check" ? (v ? 1 : 0) : v == null ? "" : v;
						});
						return ui.call("functions.save_values", { function_key: entry.function_key, values: payload }, { silent: true }).then(() => {
							changed = true;
							ui.Toast.success(__("Values saved"));
						});
					},
				},
			],
			on_close: () => on_close && on_close(changed),
		}).show();
	}

	// ---- "Try" (§4): the run a command would make, step by step ------------------------------------

	const PREVIEW_PARTY_TYPES = ["Customer", "Supplier", "Employee", "Sales Person"];

	/** Ask who the run is for, then show each step and the messages — nothing sent, nothing kept. */
	function try_function(entry, manifest, { on_close } = {}) {
		const needs_party = ((manifest && manifest.sender_params) || []).length > 0;
		let shown = false;
		return new ui.OverlayPanel({
			type: "modal",
			width: "560px",
			title: __("Try {0}", [entry.function_name]),
			subtitle: __("Runs as a command would. Nothing is sent and nothing is kept."),
			sections: [
				{
					cols: 1,
					fields: needs_party
						? [
								{ key: "party_type", label: __("Party type"), type: "select", value: "Customer", options: PREVIEW_PARTY_TYPES.map((k) => ({ value: k, label: __(k) })) },
								{ key: "party", label: __("Party"), type: "text", mono: true, hint: __("The record's name, as a linked contact would have it") },
						  ]
						: [{ key: "note", type: "readonly", label: __("Party"), value: __("This function does not read the sender's party.") }],
				},
			],
			actions: [
				{ key: "cancel", label: __("Close"), close: true },
				{
					key: "run",
					label: __("Try"),
					variant: "primary",
					handler: (values) =>
						ui
							.call("functions.try_function", { function_key: entry.function_key, party_type: needs_party ? values.party_type : null, party: needs_party ? values.party : null }, { silent: true })
							.then((r) => {
								shown = true;
								show_trial(entry, r, { on_close });
							}),
				},
			],
			on_close: () => !shown && on_close && on_close(false),
		}).show();
	}

	function show_trial(entry, r, { on_close } = {}) {
		const ok = (r.steps || []).every((st) => st.ok) && !r.error;
		return new ui.OverlayPanel({
			type: "modal",
			width: "620px",
			title: __("Try {0}", [entry.function_name]),
			badge: ok ? { text: __("Passed"), tone: "ok" } : { text: __("Stopped"), tone: "danger" },
			detail: {
				blocks: [
					{
						label: __("Steps"),
						list: (r.steps || []).map((st) => ({ text: `${st.name}${st.detail ? " — " + st.detail : ""}`, badge: st.ok ? __("OK") : __("Failed"), badge_tone: st.ok ? "ok" : "danger" })),
					},
					{
						label: __("Messages"),
						render: ($el) =>
							$el.html(
								(r.messages || []).length
									? r.messages
											.map((m) =>
												m.type === "text"
													? `<div class="wa-fn-try__msg"><span class="wa-fn-try__key">${esc(m.reply)}</span><pre class="wa-fn-try__text">${esc(m.text)}</pre></div>`
													: `<div class="wa-fn-try__msg"><span class="wa-fn-try__key">${esc(m.reply)}</span><span>${esc(__("File {0} from report {1}", [m.file_name || "", m.report_name]))}</span></div>`
											)
											.join("")
									: `<span class="text-muted">${esc(r.error || __("No message."))}</span>`
							),
					},
				],
			},
			actions: [{ key: "close", label: __("Close"), close: true }],
			on_close: () => on_close && on_close(false),
		}).show();
	}

	// ---- the function, as a document ---------------------------------------------------------

	/** The header from `functions.get_manifest` in the shape `sanad.ui.FunctionDetail` draws. */
	function window_data(entry, detail) {
		const params = detail.params || [];
		const typed = params.filter((p) => p.fieldtype !== "Template");
		const spec = whatsapp_next.functions.editor_spec(
			{
				party_types: detail.party_types,
				party_types_text: detail.party_types_text,
				inputs: typed.map((p, i) => ({
					key: p.name,
					label: p.label || p.name,
					type: { Date: "date", Int: "int", Link: "link", Check: "check", Select: "select" }[p.fieldtype] || "str",
					required: !!(p.required && !p.default),
					options: p.options,
					position: i + 1,
				})),
				settings: typed.map((p) => ({
					key: p.name,
					label: p.label || p.name,
					fieldtype: p.fieldtype,
					choices: p.select_options || [],
					depends_on: p.depends_on,
					default_value: p.value != null && p.value !== "" ? p.value : p.default,
					value: p.value,
				})),
				templates: params
					.filter((p) => p.fieldtype === "Template")
					.map((p) => ({ key: p.name, label: p.label || p.name, default: p.default, defaults_by_lang: p.defaults_by_lang, site: p.value, vars: p.vars })),
			},
			[]
		);
		const reasons = (detail.reasons || []).length ? __("Not available here: {0}", [detail.reasons.join(" · ")]) : "";
		return {
			entry: Object.assign({}, entry, {
				category: entry.server_script,
				latest_version: detail.version || entry.version,
				versions: [detail.version || entry.version].filter(Boolean),
				releases: {},
				when_to_use: [spec.when_to_use, reasons].filter(Boolean).join(" — "),
				party_types: spec.party_types,
			}),
			manifest: Object.assign({}, spec, {
				suggested_commands: [],
				example: null,
				installed: detail.installed || {},
				params,
				sender_params: detail.sender_params || [],
			}),
		};
	}

	/**
	 * The function as the prototype's window (`sanad.ui.FunctionDetail`, D-133): the header read
	 * once, the verbs mapped onto this screen's forms. The preview runs the function on a throw-away
	 * command draft through `commands.preview_command` — nothing saved, nothing sent.
	 */
	class FunctionWindow {
		constructor(page, entry) {
			this.page = page;
			this.entry = entry;
		}

		show() {
			const e = this.entry;
			const page = this.page;
			const manager = is_manager();
			if (e.state === "invalid" || e.state === "missing") return Promise.resolve(page.show_problem(e));
			const args = e.installed ? { function_key: e.function_key } : { server_script: e.server_script };
			return ui
				.call("functions.get_manifest", args, { silent: true })
				.catch(() => null)
				.then((detail) => {
					const data = window_data(e, detail || { params: [] });
					this.manifest = data.manifest;
					const linked = (e.linked_commands || []).length;
					const more = [];
					if (manager && e.installed) {
						more.push({ label: e.status === "Active" ? __("Deactivate") : __("Activate"), handler: () => page.set_status(e, e.status === "Active" ? "Inactive" : "Active") });
						if ((this.manifest.params || []).length) more.push({ label: __("Edit values"), handler: () => page.edit_values(e, this.manifest) });
						more.push({ label: __("Try"), handler: () => page.try_function(e, this.manifest) });
						if (!linked) more.push({ label: __("Link a command"), handler: () => page.new_command(e) });
					}
					more.push({ label: __("Open the Server Script"), handler: () => frappe.set_route("Form", "Server Script", e.server_script) });
					this.view = new ui.FunctionDetail({
						entry: data.entry,
						manifest: this.manifest,
						form: e.installed ? { doctype: "WhatsApp Function", name: e.function_key } : null,
						party_types: PREVIEW_PARTY_TYPES.map((k) => ({ key: k, label: __(k) })),
						preview: manager && e.installed ? (a) => this.preview(a) : null,
						search_contacts: manager ? (txt, party_type) => ui.call("commands.search_contacts", { txt, party_type }) : null,
						on_update: manager && e.update_available ? () => page.change(e) : null,
						on_toggle_install: manager && (e.installed || e.available) ? () => (e.installed ? page.remove(e) : page.change(e)) : null,
						on_open_commands: () => {
							this.view && this.view.close();
							command_list(e);
						},
						more,
						on_close: () => {
							if (page.detail === this) page.detail = null;
						},
					});
					this.view.show();
					return this.view;
				});
		}

		preview({ code, settings, outputs, values, sender }) {
			const payload = whatsapp_next.functions.payload_of(
				{ code, function: this.entry.function_key, allowed_party_types: [], requires_linked_contact: 0, settings_overrides: settings, outputs },
				this.manifest.outputs,
				[]
			);
			return ui.call("commands.preview_command", { payload, sender, values });
		}

		hide() {
			if (this.view) this.view.hide();
			this.view = null;
		}
	}

	// ---- the storefront table -------------------------------------------------------------------

	/**
	 * The prototype's columns (`docs/screen/Hub Screen - Functions.dc.html`), drawn by the kit's
	 * `DataList` in page mode: the catalog is a file, so this screen owns the rows, the filtering,
	 * the sorting and the paging, and the table only renders them — the same table the Outbound,
	 * Inbound, Queue and Commands screens use. The row is one line: the function's name, bold, and
	 * eight facts beside it; the description is searched but drawn in the drawer, not here.
	 */
	const columns = () => [
		{ fieldname: "function_name", label: __("Function"), width: 160, sortable: true, format: (v) => `<strong>${esc(v || "")}</strong>` },
		{ fieldname: "server_script", label: __("Server Script"), width: 150, sortable: true, format: (v) => `<span class="sanad-tabular" dir="ltr">${esc(v || "")}</span>` },
		{
			fieldname: "installed_version",
			label: __("Version"),
			width: 84,
			sortable: true,
			format: (v, doc) => `<span class="sanad-tabular" dir="ltr">${esc(v || doc.version || "")}</span>`,
		},
		{ fieldname: "update_available", label: __("Update"), width: 112, sortable: true, format: (v, doc) => (doc.installed && doc.state !== "missing" ? update_badge(doc) : "") },
		{ fieldname: "commands_count", label: __("Linked commands"), type: "number", align: "end", width: 104, sortable: true, format: (v) => fmt_int(v) },
		{ fieldname: "calls_30d", label: __("Calls (30d)"), type: "number", align: "end", width: 96, sortable: true, format: (v) => fmt_int(v) },
		{ fieldname: "avg_ms", label: __("Average run"), type: "number", align: "end", width: 98, sortable: true, hidden_xs: true, format: (v) => (cint(v) ? esc(ms_text(v)) : "") },
		{ fieldname: "status", label: __("Status"), width: 94, sortable: true, format: (v, doc) => (doc.installed ? status_badge(doc) : "") },
		{ fieldname: "installed", label: __("Install"), width: 98, sortable: true, format: (v, doc) => install_badge(doc) },
	];

	/** How each column is compared when the reader sorts by it. */
	const SORT_VALUE = {
		function_name: (e) => cstr(e.function_name).toLowerCase(),
		server_script: (e) => cstr(e.server_script).toLowerCase(),
		// by version, not by text: `1.10.0` after `1.9.0`
		installed_version: (e) =>
			version_tuple(e.installed_version || e.version)
				.map((p) => String(p).padStart(6, "0"))
				.join("."),
		update_available: (e) => (e.update_available ? 1 : 0),
		commands_count: (e) => cint(e.commands_count),
		calls_30d: (e) => cint(e.calls_30d),
		avg_ms: (e) => cint(e.avg_ms),
		status: (e) => (e.installed ? (e.status === "Active" ? 2 : 1) : 0),
		installed: (e) => (e.installed ? 1 : 0),
	};

	// ---- the page -------------------------------------------------------------------------------

	class FunctionsCenter {
		constructor(page) {
			this.page = page;
			this.entries = [];
			this.filters = {};
			this.search = "";
			this.sort = { fieldname: "calls_30d", order: "desc" };
			this.$main = $(page.main).addClass("sanad-kit wa-functions");
			this.$head = $('<div class="wa-functions__head"></div>').appendTo(this.$main);
			// the toolbar, the selection and the table are one panel, exactly a Desk list's
			this.$panel = $('<div class="wa-functions__panel sanad-list-card"></div>').appendTo(this.$main);
			this.$toolbar = $('<div class="wa-functions__toolbar"></div>').appendTo(this.$panel);
			this.$bulk = $('<div class="wa-functions__bulk" hidden></div>').appendTo(this.$panel);
			this.$body = $('<div class="wa-functions__body"></div>').appendTo(this.$panel);
			this.state = new ui.EmptyState({ wrapper: this.$body, state: "loading", rows: 6 });
			this.loaded = this.load();
			// the filters stay under Desk's strip while the functions scroll beneath, as on a list
			ui.pin_stack(this.$main, [".wa-functions__toolbar"]);
		}

		// ---- data -----------------------------------------------------------------------------

		load() {
			if (!this.table) this.state.loading({ rows: 6 });
			return Promise.all([
				ui.call("functions.get_catalog"),
				ui.call("commands.list_commands", { page: 1, page_length: 200 }, { silent: true }).catch(() => null),
				ui.call("frappe.client.get_list", { doctype: "WhatsApp Function", fields: ["name", "avg_ms", "call_count", "error_count"], limit_page_length: 0 }, { silent: true }).catch(
					() => []
				),
				ui.meta.with_doctype("WhatsApp Function"),
			])
				.then(([catalog, commands, docs]) => {
					this.catalog = catalog || {};
					this.commands = (commands && commands.rows) || [];
					this.commands_total = (commands && commands.total) || this.commands.length;
					this.entries = decorate(this.catalog.entries, this.commands, docs);
					// the loading state owns the body only until the table is mounted in it
					if (!this.table) this.state.hide();
					this.render();
				})
				.catch((err) => {
					if (this.table) return ui.Toast.error(err);
					this.state.error(err, {
						title: __("Could not load the functions"),
						action: { label: __("Retry"), on_click: () => this.load() },
					});
				});
		}

		/** Re-read after install / update / remove, keeping the filters and the page. */
		reload() {
			return this.load();
		}

		entry(key) {
			return this.entries.find((e) => e.function_key === key) || null;
		}

		// ---- the screen's own numbers ----------------------------------------------------------

		counters() {
			const all = this.entries;
			return {
				total: all.length,
				problems: all.filter((e) => ["invalid", "unavailable", "missing"].includes(e.state)).length,
				installed: all.filter((e) => e.installed).length,
				active: all.filter((e) => e.installed && e.status === "Active").length,
				inactive: all.filter((e) => e.installed && e.status !== "Active").length,
				outdated: all.filter((e) => e.update_available).length,
				calls: all.reduce((n, e) => n + cint(e.calls_30d), 0),
			};
		}

		/**
		 * The prototype's header: the title, the sentence that says what a function is, and the
		 * "Commands · N" button at the inline-end of the same row; under it the one banner the
		 * operator must not miss, then the four readings.
		 */
		render_header() {
			if (this.header) this.header.destroy();
			this.$head.empty();
			// Desk's own strip, as on a list: the page's title and breadcrumb, "Commands" on its bar
			this.header = new ui.PageHeader({
				wrapper: this.$head,
				page: this.page,
				title: __("Functions Center"),
				description: __("A function is the logic behind a command. Review its versions here, install it and keep it current."),
				secondary: [
					{ label: __("Commands"), icon: "es-line-chat-alt", count: this.commands_total, handler: () => command_list(null) },
				],
				banner: () => this.banner(),
				blocks: [{ key: "readings", render: ($el) => this.render_cards($el) }],
			});
		}

		/** The prototype's four `stat` cards, compact: functions · active · calls · updates. */
		render_cards($el) {
			const c = this.counters();
			if (this.cards) this.cards.destroy && this.cards.destroy();
			$el.empty();
			this.cards = new ui.Cards({
				wrapper: $el,
				density: "compact",
				handlers: {
					open_commands: () => command_list(null),
					show_updates: () => this.filter_bar && this.filter_bar.set("update_state", "available"),
				},
				sections: [
					{
						min: 200,
						cards: [
							{
								kind: "stat",
								icon: "sigma",
								label: __("Functions"),
								value: fmt_int(c.total),
								note: c.problems ? ui.plural(c.problems, { one: __("{0} cannot run here"), other: __("{0} cannot run here") }) : __("Every script can run here"),
							},
							{
								kind: "stat",
								icon: "check",
								tone: "ok",
								label: __("Active"),
								value: fmt_int(c.active),
								note: __("{0} installed · {1} inactive", [fmt_int(c.installed), fmt_int(c.inactive)]),
							},
							{
								kind: "stat",
								icon: "chart",
								tone: "info",
								label: __("Calls (30d)"),
								value: fmt_int(c.calls),
								note: ui.plural(this.commands_total, { one: __("Through {0} linked command"), other: __("Through {0} linked commands") }),
								action: "open_commands",
							},
							{
								kind: "stat",
								icon: "warn",
								tone: c.outdated ? "warn" : undefined,
								label: __("Updates available"),
								value: fmt_int(c.outdated),
								note: c.outdated ? __("Scripts whose header changed since install") : __("Every function matches its script"),
								action: c.outdated ? "show_updates" : undefined,
							},
						],
					},
				],
			});
		}

		/** The states the operator must not miss: installed functions that lost their script, scripts that cannot be read. */
		banner() {
			const missing = this.entries.filter((e) => e.state === "missing");
			if (missing.length)
				return {
					tone: "red",
					text: ui.plural(missing.length, {
						one: __("{0} installed function lost its Server Script and will not run."),
						other: __("{0} installed functions lost their Server Script and will not run."),
					}),
				};
			const invalid = this.entries.filter((e) => e.state === "invalid");
			if (invalid.length)
				return {
					tone: "amber",
					text: ui.plural(invalid.length, { one: __("{0} script has an invalid WA-FUNCTION header."), other: __("{0} scripts have an invalid WA-FUNCTION header.") }),
				};
			return null;
		}

		// ---- toolbar --------------------------------------------------------------------------

		render_toolbar() {
			if (this.filter_bar) return;
			this.filter_bar = new ui.FilterBar({
				page: this.page,
				wrapper: this.$toolbar,
				list_style: true,
				doctype: "WhatsApp Function",
				presets: [
					{
						fieldname: "function_name",
						type: "search",
						fields: ["function_name", "server_script", "description"],
						placeholder: __("Search a function, its script or its description…"),
					},
					{
						fieldname: "state",
						type: "select",
						label: __("State"),
						multiple: false,
						options: [
							{ value: "available", label: __("Available") },
							{ value: "unavailable", label: __("Unavailable") },
							{ value: "invalid", label: __("Invalid header") },
							{ value: "missing", label: __("Script missing") },
						],
					},
					{
						fieldname: "update_state",
						type: "select",
						label: __("Update"),
						multiple: false,
						options: [
							{ value: "available", label: __("Update available") },
							{ value: "current", label: __("Up to date") },
						],
					},
					{
						fieldname: "status",
						type: "select",
						label: __("Status"),
						multiple: false,
						options: [
							{ value: "Active", label: __("Active") },
							{ value: "Inactive", label: __("Inactive") },
						],
					},
					{
						fieldname: "install_state",
						type: "select",
						label: __("Install"),
						multiple: false,
						options: [
							{ value: "installed", label: __("Installed") },
							{ value: "not_installed", label: __("Not installed") },
						],
					},
				],
				on_change: (filters, { values, search }) => {
					this.filters = values || {};
					this.search = cstr(search || "").toLowerCase();
					if (this.table) this.table.page = 0;
					this.apply();
				},
			});
		}

		// ---- rows ------------------------------------------------------------------------------

		/** Client-side, because the catalog is a file the API returns whole (a few dozen rows). */
		visible() {
			const f = this.filters || {};
			const has = (value, picked) => {
				if (picked == null || picked === "") return true;
				const list = Array.isArray(picked) ? picked : [picked];
				return !list.length || list.map(cstr).includes(cstr(value));
			};
			const rows = this.entries.filter((e) => {
				if (f.state && !(f.state === "available" ? ["available", "update"].includes(e.state) : e.state === f.state)) return false;
				if (f.update_state === "available" && !e.update_available) return false;
				if (f.update_state === "current" && e.update_available) return false;
				if (f.status && (!e.installed || e.status !== f.status)) return false;
				if (f.install_state === "installed" && !e.installed) return false;
				if (f.install_state === "not_installed" && e.installed) return false;
				if (this.search) {
					const hay = [e.function_name, e.function_key, e.server_script, e.description, e.error].map(cstr).join(" ").toLowerCase();
					if (!hay.includes(this.search)) return false;
				}
				return true;
			});
			const get = SORT_VALUE[this.sort.fieldname] || ((e) => cstr(e[this.sort.fieldname]));
			const dir = this.sort.order === "asc" ? 1 : -1;
			return rows.sort((a, b) => {
				const va = get(a);
				const vb = get(b);
				if (va === vb) return cstr(a.function_name).localeCompare(cstr(b.function_name));
				return va > vb ? dir : -dir;
			});
		}

		render() {
			this.render_header();
			this.render_toolbar();
			if (!this.table) {
				this.$body.empty();
				this.table = new ui.DataList({
					wrapper: this.$body,
					doctype: "WhatsApp Function",
					columns: columns(),
					selectable: is_manager(),
					page_length: 20,
					sort: this.sort,
					// what the prototype's phone card carries: the name, its group and version, the
					// update state, the commands behind it and the two state badges
					mobile_columns: ["function_name", "server_script", "installed_version", "update_available", "commands_count", "calls_30d", "status", "installed"],
					pinnable: false,
					// the prototype's storefront has no "view" column: the row is the control, and
					// DataList keeps it focusable with Enter — nine columns of state need the width
					row_action: false,
					on_row_click: (doc) => this.open(doc),
					on_sort: (fieldname, order) => {
						this.sort = { fieldname, order };
						this.apply();
					},
					on_page: () => this.apply(),
					on_select: (rows) => this.render_bulk(rows),
					footer: { count: (total) => ui.plural(total, { one: __("{0} function"), other: __("{0} functions") }) },
					empty: {
						title: this.entries.length ? __("No function matches") : __("No function on this site"),
						description: this.entries.length
							? __("Change the search or the filters to see more functions.")
							: __("A function is a Server Script of type API whose method starts with wa_fn_ and that carries a WA-FUNCTION header."),
						action: this.entries.length ? { label: __("Clear filters"), on_click: () => this.filter_bar && this.filter_bar.clear() } : null,
					},
				});
				this.$body.on("change", ".list-row-checkbox", () => this.render_bulk(this.table.get_selected()));
			}
			this.apply();
		}

		/** One page of the filtered, sorted catalog handed to the table. */
		apply() {
			if (!this.table) return;
			const rows = this.visible();
			const start = cint(this.table.page) * cint(this.table.page_length);
			this.table.set_rows(rows.slice(start, start + cint(this.table.page_length)), rows.length);
			ui.announce(ui.plural(rows.length, { one: __("{0} function"), other: __("{0} functions") }));
		}

		// ---- selection ---------------------------------------------------------------------------

		/**
		 * The prototype's selection cluster: a tinted "N selected ×" pill and, beside it, the verbs
		 * that act on the selection — update, activate, deactivate — each naming how many rows it
		 * will actually touch.
		 */
		render_bulk(picked) {
			if (!is_manager() || !picked.length) return this.$bulk.attr("hidden", true).empty();
			const updatable = picked.filter((e) => e.update_available).length;
			const installed = picked.filter((e) => e.installed).length;
			this.$bulk.removeAttr("hidden").html(`
				<span class="wa-functions__bulk-count">
					<span role="status" aria-atomic="true">${esc(ui.plural(picked.length, { one: __("{0} selected"), other: __("{0} selected") }))}</span>
					<button type="button" class="wa-functions__bulk-clear" aria-label="${esc(__("Clear selection"))}">&times;</button>
				</span>
				${updatable ? kit.btn({ label: __("Update {0}", [fmt_int(updatable)]), variant: "tonal", attrs: { "data-bulk": "update" } }) : ""}
				${
					installed
						? kit.btn({ label: __("Activate {0}", [fmt_int(installed)]), variant: "tonal", attrs: { "data-bulk": "Active" } }) +
						  kit.btn({ label: __("Deactivate {0}", [fmt_int(installed)]), variant: "tonal", attrs: { "data-bulk": "Inactive" } })
						: `<span class="wa-functions__bulk-note">${esc(__("Install a function before activating or deactivating it."))}</span>`
				}`);
			this.$bulk.find("[data-bulk]").on("click", (ev) => this.bulk($(ev.currentTarget).data("bulk"), picked));
			this.$bulk.find(".wa-functions__bulk-clear").on("click", () => {
				this.table.clear_selection();
				this.render_bulk([]);
			});
		}

		// ---- the record ------------------------------------------------------------------------

		open(entry) {
			if (this.detail) this.detail.hide();
			this.detail = new FunctionWindow(this, entry);
			this.detail_key = entry.function_key;
			return this.detail.show();
		}

		/** After a form or a change: the screen's truth again, then the same function again. */
		back(changed) {
			const key = this.detail_key;
			return (changed ? this.reload() : Promise.resolve()).then(() => {
				const entry = key && this.entry(key);
				if (entry) return this.open(entry);
				this.detail = null;
			});
		}

		/** A drawer verb that opens a form: the form takes the overlay, and the drawer returns after it. */
		change(entry) {
			return confirm_change(entry, { on_close: (changed) => this.back(changed) });
		}

		edit_values(entry, manifest) {
			return edit_values(entry, manifest, { on_close: (changed) => this.back(changed) });
		}

		try_function(entry, manifest) {
			return try_function(entry, manifest, { on_close: () => this.back(false) });
		}

		/** A script that cannot be read (its header error, with the line) or an installed function that lost it. */
		show_problem(entry) {
			const remove = entry.state === "missing" && entry.installed && is_manager();
			return new ui.OverlayPanel({
				type: "modal",
				width: "560px",
				title: entry.function_name || entry.server_script,
				subtitle: entry.server_script,
				subtitle_mono: true,
				badge: { text: entry.state === "missing" ? __("Script missing") : __("Invalid header"), tone: "danger" },
				detail: { alert: { tone: "danger", title: entry.error || "", lines: [__("Fix the Server Script, then come back: the list reads it again.")] } },
				actions: [
					{ key: "close", label: __("Close"), close: true },
					remove
						? { key: "remove", label: __("Remove"), variant: "danger", close: true, handler: () => this.remove(entry) }
						: { key: "open", label: __("Open the Server Script"), variant: "primary", close: true, handler: () => frappe.set_route("Form", "Server Script", entry.server_script) },
				],
			}).show();
		}

		/** A new command for this function: the command form hands it to the editor with its suggested words. */
		new_command(entry) {
			frappe.new_doc("WhatsApp Command", { function: entry.function_key });
		}

		set_status(entry, status) {
			return ui
				.call("functions.set_status", { function_key: entry.function_key, status })
				.then(() => {
					ui.Toast.success(status === "Active" ? __("{0} is active", [entry.function_name]) : __("{0} is inactive", [entry.function_name]));
					return this.back(true);
				})
				.catch((err) => ui.Toast.error(err));
		}

		/** Removing is refused while a command still runs on the function (409) — say so plainly. */
		remove(entry) {
			const linked = (entry.linked_commands || []).length;
			return ui.ConfirmDialog.ask({
				title: __("Remove {0}?", [entry.function_name]),
				message: __("The installed record and the site's values are deleted. The Server Script stays, so the function can be installed again."),
				impact: [
					{ label: __("Installed version"), value: entry.installed_version || "—" },
					{ label: __("Linked commands"), value: fmt_int(linked), tone: linked ? "red" : null },
				],
				danger: true,
				confirm_label: __("Remove"),
				on_confirm: () => ui.call("functions.remove", { function_key: entry.function_key }),
			})
				.then(() => {
					ui.Toast.success(__("{0} removed", [entry.function_name]));
					if (this.detail) this.detail.hide();
					this.detail = null;
					return this.reload();
				})
				.catch(() => {});
		}

		// ---- bulk -------------------------------------------------------------------------------

		bulk(what, picked) {
			if (what === "update") {
				const targets = picked.filter((e) => e.update_available);
				const impacted = targets.reduce((n, e) => n + (e.linked_commands || []).length, 0);
				const left = this.entries.filter((e) => e.update_available).length - targets.length;
				ui.ConfirmDialog.ask({
					title: ui.plural(targets.length, { one: __("Update {0} function?"), other: __("Update {0} functions?") }),
					message: __("Each function takes its script's current header. Commands, their words and their permissions stay as they are."),
					impact: [
						{ label: __("Functions to update"), value: fmt_int(targets.length) },
						{ label: __("Commands that benefit"), value: fmt_int(impacted), tone: "green" },
						{ label: __("Left without update"), value: fmt_int(left) },
					],
					confirm_label: __("Update"),
					on_confirm: () => ui.call("functions.update_many", { function_keys: targets.map((e) => e.function_key) }),
				})
					.then((r) => this.after_bulk(r, __("{0} functions updated", [fmt_int((r && r.count) || 0)])))
					.catch(() => {});
				return;
			}
			const status = what;
			const targets = picked.filter((e) => e.installed);
			if (!targets.length) return ui.Toast.warning(__("Only installed functions can be activated or deactivated."));
			ui.ConfirmDialog.ask({
				title:
					status === "Active"
						? ui.plural(targets.length, { one: __("Activate {0} function?"), other: __("Activate {0} functions?") })
						: ui.plural(targets.length, { one: __("Deactivate {0} function?"), other: __("Deactivate {0} functions?") }),
				message: status === "Active" ? __("Linked commands run again from their next message.") : __("Linked commands still match the text, but they will not run."),
				impact: [
					{ label: __("Functions"), value: fmt_int(targets.length) },
					{
						label: __("Linked commands"),
						value: fmt_int(targets.reduce((n, e) => n + (e.linked_commands || []).length, 0)),
						tone: status === "Active" ? "green" : "amber",
					},
				],
				danger: status !== "Active",
				confirm_label: status === "Active" ? __("Activate") : __("Deactivate"),
				on_confirm: () => ui.call("functions.set_status_many", { function_keys: targets.map((e) => e.function_key), status }),
			})
				.then((r) =>
					this.after_bulk(
						r,
						status === "Active" ? __("{0} functions activated", [fmt_int((r && r.count) || 0)]) : __("{0} functions deactivated", [fmt_int((r && r.count) || 0)])
					)
				)
				.catch(() => {});
		}

		after_bulk(result, message) {
			const failed = ((result || {}).failed || []).length;
			const skipped = ((result || {}).skipped || []).length;
			if (failed) ui.Toast.warning(__("{0} could not be done", [fmt_int(failed)]));
			else if (skipped && !cint((result || {}).count)) ui.Toast.info(__("Nothing to do"));
			else ui.Toast.success(message);
			if (this.table) {
				this.table.clear_selection();
				this.render_bulk([]);
			}
			this.reload();
		}

		destroy() {
			if (this.header) this.header.destroy();
			if (this.filter_bar) this.filter_bar.destroy();
			if (this.table) this.table.destroy();
			if (this.detail) this.detail.hide();
		}
	}

	frappe.pages[ROUTE].on_page_load = function (wrapper) {
		// a tab opened before the last build holds the old bundle without `whatsapp_next.functions`:
		// load the new one once instead of failing on every row
		if (!(window.whatsapp_next && whatsapp_next.functions && whatsapp_next.functions.editor_spec)) {
			let first = true;
			try {
				first = !sessionStorage.getItem("wa-functions-reloaded");
				sessionStorage.setItem("wa-functions-reloaded", "1");
			} catch (e) {
				first = true;
			}
			if (first) return window.location.reload();
		}
		try {
			sessionStorage.removeItem("wa-functions-reloaded");
		} catch (e) {
			// storage blocked: nothing to forget
		}
		const page = frappe.ui.make_app_page({ parent: wrapper, title: __("Functions Center"), single_column: true });
		wrapper.whatsapp_next = new FunctionsCenter(page);
		frappe.provide("whatsapp_next.pages");
		whatsapp_next.pages.functions_center = wrapper.whatsapp_next;
	};

	frappe.pages[ROUTE].on_page_show = function (wrapper) {
		const screen = wrapper.whatsapp_next;
		if (!screen) return;
		// coming back from a command or a form: the install state may have moved meanwhile
		const ready = screen.entries.length ? screen.reload() : screen.loaded || screen.load();
		// `?function=<key>` or `frappe.route_options.function` (the native Function form, a command's
		// "Open function"): open that function's record once the catalog is in.
		const key = (frappe.route_options && frappe.route_options.function) || frappe.utils.get_url_arg("function");
		if (!key) return;
		frappe.route_options = null;
		Promise.resolve(ready).then(() => {
			const entry = screen.entry(key);
			if (entry) screen.open(entry);
			else ui.Toast.info(__("Function {0} is not on this site.", [key]));
		});
	};
})();

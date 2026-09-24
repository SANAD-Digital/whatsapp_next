// Functions Center (09 row 7, spec §5.6) — the storefront over the function catalog. A function is
// the logic behind a command; this screen is where its versions are reviewed, installed, updated,
// switched on and off. The catalog is a JSON file read by `functions.get_catalog`; the installed
// record is the `WhatsApp Function` DocType, so every row carries two states at once: what the
// catalog offers (latest version, change log) and what this site runs (installed version, status).
//
// Anatomy, from the prototype (`docs/screen/Hub Screen - Functions.dc.html`): the KPI row
// (PageHeader without a title — Desk's page head already names the screen), the shared FilterBar
// (its intro sentence, search, category / update / status / install), and the kit's `DataList` in
// page mode with the prototype's columns — function, category, version, update, linked commands,
// calls (30 days), average run, status, install. The catalog is a file, so this screen owns the
// rows, the filtering, the sorting and the paging and hands the table one page at a time.
// Page-local: FunctionDetail (the modal, `docs/component/Function Detail`) and PreviewModal (the
// diff `functions.preview_install` returns, shown before install or update).
//
// No business logic here: every read and write goes through `sanad.ui.call` to the `functions.*` /
// `commands.*` API. Two numbers the catalog API does not carry yet (`avg_ms`, `call_count`) are
// read from the DocType through Frappe's own list API — see the API gaps in the report.

(() => {
	const ROUTE = "wa-functions-center";
	const esc = (v) => sanad.ui.escape(v);
	const fmt_int = (v) => sanad.ui.format_int(v);
	const is_manager = () => frappe.user.has_role("WhatsApp Manager") || frappe.user.has_role("System Manager");

	/** Update state is a fact about two versions: it always reads as a word, never as a colour. */
	const update_badge = (e) =>
		e.update_available
			? sanad.ui.StatusBadge.html({ label: __("Update available"), colour: "orange" })
			: sanad.ui.StatusBadge.html({ label: __("Up to date"), colour: "green" });

	const status_badge = (e) =>
		e.installed
			? sanad.ui.StatusBadge.html({
					label: __(e.status || "Active"),
					colour: e.status === "Active" ? "green" : "gray",
			  })
			: `<span class="text-muted" aria-hidden="true">—</span><span class="sanad-visually-hidden">${esc(
					__("Not installed")
			  )}</span>`;

	const install_badge = (e) =>
		e.installed
			? sanad.ui.StatusBadge.html({ label: __("Installed"), colour: "blue" })
			: sanad.ui.StatusBadge.html({ label: __("Not installed"), colour: "gray" });

	/** "12 ms" — the average run of the installed handler; a dash while it has never run. */
	const ms_text = (value) => (cint(value) ? __("{0} ms", [fmt_int(value)]) : "—");

	/**
	 * The two versions the prototype puts at the top of the detail, side by side: the one this site
	 * runs and the newest the catalog offers, each named so the pair never has to be decoded.
	 */
	const version_pill = (label, version, tone) =>
		`<span class="wa-fndetail__pill sanad-tone--${tone}">
			<b class="sanad-tabular">${esc(version || "—")}</b>
			<span>${esc(label)}</span>
		</span>`;

	/** One number of the detail's stat block: the label above it, the figure large and tabular. */
	const fact_tile = (label, value) =>
		`<div class="wa-fndetail__tile"><span class="wa-fndetail__tile-label">${esc(label)}</span>
			<b class="wa-fndetail__tile-value sanad-tabular">${value}</b></div>`;

	const command_route = (entry) => frappe.set_route("List", "WhatsApp Command", { function: entry.function_key });

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
				name: e.function_key, // the table addresses a row by `name`, like any Desk list
				calls_30d: calls[e.function_key] || 0,
				linked_commands: linked[e.function_key] || [],
				avg_ms: cint((by_key[e.function_key] || {}).avg_ms),
				call_count: cint((by_key[e.function_key] || {}).call_count),
				error_count: cint((by_key[e.function_key] || {}).error_count),
			})
		);
	}

	// ---- PreviewModal -------------------------------------------------------------------------

	/**
	 * What install / update will change, from `functions.preview_install`: the settings and output
	 * rows added, removed and changed, the manifest keys that move, and the commands that run on
	 * this function. It is the preview *and* the confirmation — the diff is the impact, so the
	 * screen never asks twice for one decision (the prototype's «تحديث «X»» states the same facts).
	 */
	class PreviewModal {
		constructor(entry, { version = null, on_done } = {}) {
			this.entry = entry;
			this.version = version || entry.latest_version;
			this.on_done = on_done;
			this.installing = !entry.installed;
			this.rollback = !!entry.installed && this.version !== entry.latest_version;
		}

		title() {
			const e = this.entry;
			if (this.installing) return __("Install {0}?", [e.function_name]);
			if (this.rollback) return __("Move {0} back to {1}?", [e.function_name, this.version]);
			return __("Update {0} to {1}?", [e.function_name, this.version]);
		}

		show() {
			this.dialog = new frappe.ui.Dialog({
				title: this.title(),
				size: "large",
				fields: [{ fieldtype: "HTML", fieldname: "body" }],
				primary_action_label: this.installing ? __("Install") : __("Update"),
				primary_action: () => this.run(),
			});
			this.dialog.$wrapper.addClass("sanad-kit sanad-sheet wa-preview");
			this.$body = this.dialog.get_field("body").$wrapper;
			this.state = new sanad.ui.EmptyState({ wrapper: this.$body, state: "loading", rows: 3 });
			this.dialog.get_primary_btn().prop("disabled", true);
			this.dialog.show();
			this.load();
			return this;
		}

		load() {
			this.state.loading({ rows: 3 });
			sanad.ui
				.call("functions.preview_install", { function_key: this.entry.function_key, version: this.version })
				.then((diff) => {
					this.state.hide();
					this.render(diff);
					this.dialog.get_primary_btn().prop("disabled", !diff.handler_registered);
				})
				.catch((err) =>
					this.state.error(err, {
						title: __("Could not read what will change"),
						action: { label: __("Retry"), onclick: () => this.load() },
					})
				);
		}

		/** A named group of keys — "Settings added: document_type, party_field". */
		group(label, keys, tone) {
			if (!keys || !keys.length) return "";
			return `<div class="wa-diff__group">
				<span class="wa-diff__label">${esc(label)}</span>
				<span class="wa-diff__keys">${keys
					.map((k) => `<code class="wa-diff__key${tone ? ` sanad-tone--${tone}` : ""}">${esc(k)}</code>`)
					.join(" ")}</span>
			</div>`;
		}

		/** Changed rows name the fields that move, so "changed" is never an unexplained word. */
		changed(label, rows, key) {
			if (!rows || !rows.length) return "";
			const items = rows
				.map(
					(r) =>
						`<li><code class="wa-diff__key">${esc(r[key])}</code> <span class="wa-diff__fields">${esc(
							Object.keys(r.fields || {}).join(", ")
						)}</span></li>`
				)
				.join("");
			return `<div class="wa-diff__group">
				<span class="wa-diff__label">${esc(label)}</span>
				<ul class="wa-diff__list">${items}</ul>
			</div>`;
		}

		render(diff) {
			const d = diff.diff || {};
			const s = d.settings || {};
			const o = d.outputs || {};
			const m = d.manifest || {};
			const impacted = diff.commands_impacted || [];
			const blocks = [
				this.group(__("Settings added"), s.added, "green"),
				this.group(__("Settings removed"), s.removed, "red"),
				this.changed(__("Settings changed"), s.changed, "key"),
				this.group(__("Outputs added"), o.added, "green"),
				this.group(__("Outputs removed"), o.removed, "red"),
				this.changed(__("Outputs changed"), o.changed, "output_key"),
				this.group(__("Manifest added"), m.added, "green"),
				this.group(__("Manifest removed"), m.removed, "red"),
				this.group(__("Manifest changed"), m.changed, "amber"),
			]
				.filter(Boolean)
				.join("");
			const commands = impacted.length
				? `<div class="wa-diff__group"><span class="wa-diff__label">${esc(
						sanad.ui.plural(impacted.length, {
							one: __("{0} command uses this function"),
							other: __("{0} commands use this function"),
						})
				  )}</span><span class="wa-diff__keys">${impacted
						.map((c) => `<code class="wa-diff__key">${esc(c)}</code>`)
						.join(" ")}</span></div>`
				: `<p class="wa-diff__note">${esc(__("No command uses this function yet."))}</p>`;
			const warning = diff.handler_registered
				? ""
				: `<div class="wa-diff__warning" role="alert">${esc(
						__(
							"No handler is registered for this function, so it cannot be installed. Install the app that provides it first."
						)
				  )}</div>`;
			this.$body.html(`
				<div class="wa-diff">
					${warning}
					<div class="wa-diff__versions">
						<span class="wa-diff__version"><span class="wa-diff__label">${esc(__("Installed version"))}</span>
							<b class="sanad-tabular">${esc(diff.installed_version || __("None"))}</b></span>
						<span class="wa-diff__arrow" aria-hidden="true">→</span>
						<span class="wa-diff__version"><span class="wa-diff__label">${esc(__("Target version"))}</span>
							<b class="sanad-tabular">${esc(diff.target_version)}</b></span>
					</div>
					<p class="wa-diff__note">${esc(
						this.installing
							? __(
									"Installing copies the settings and outputs below into this site. Nothing is sent and no command changes."
							  )
							: __(
									"Updating replaces the function's logic with the chosen version. Commands, their words and their permissions stay as they are."
							  )
					)}</p>
					${blocks || `<p class="wa-diff__note">${esc(__("Nothing changes in the settings or the outputs."))}</p>`}
					${commands}
				</div>`);
		}

		run() {
			const method = this.installing ? "functions.install" : "functions.update";
			const $btn = this.dialog.get_primary_btn();
			$btn.prop("disabled", true);
			return sanad.ui
				.call(method, { function_key: this.entry.function_key, version: this.version })
				.then((r) => {
					this.dialog.hide();
					sanad.ui.Toast.success(
						this.installing
							? __("{0} installed", [this.entry.function_name])
							: __("{0} is now on {1}", [
									this.entry.function_name,
									(r && r.installed_version) || this.version,
							  ])
					);
					this.on_done && this.on_done();
				})
				.catch((err) => {
					$btn.prop("disabled", false);
					sanad.ui.Toast.error(err);
				});
		}
	}

	// ---- settings editor ----------------------------------------------------------------------

	/**
	 * The values an installed function exposes (`functions.save_settings`). Field types come from
	 * the function's own setting rows — Check, Select with choices, or Data — never from a hard
	 * coded list.
	 */
	function edit_settings(entry, on_done) {
		sanad.ui
			.call("commands.get_defaults", { function: entry.function_key })
			.then((defaults) => {
				const rows = (defaults && defaults.settings) || [];
				if (!rows.length) {
					sanad.ui.Toast.info(__("This function has no settings."));
					return;
				}
				const fields = rows.map((r) => {
					const df = {
						fieldname: r.key,
						label: __(r.label || r.key),
						description: r.notes ? __(r.notes) : null,
						default: r.value != null && r.value !== "" ? r.value : r.default_value,
					};
					if (r.fieldtype === "Check") return Object.assign(df, { fieldtype: "Check" });
					if (r.choices)
						return Object.assign(df, { fieldtype: "Select", options: String(r.choices).split("\n") });
					return Object.assign(df, { fieldtype: r.fieldtype === "Int" ? "Int" : "Data" });
				});
				const dialog = new frappe.ui.Dialog({
					title: __("Settings of {0}", [entry.function_name]),
					fields,
					primary_action_label: __("Save settings"),
					primary_action: (values) => {
						dialog.get_primary_btn().prop("disabled", true);
						sanad.ui
							.call("functions.save_settings", { function_key: entry.function_key, values })
							.then(() => {
								dialog.hide();
								sanad.ui.Toast.success(__("Settings saved"));
								on_done && on_done();
							})
							.catch((err) => {
								dialog.get_primary_btn().prop("disabled", false);
								sanad.ui.Toast.error(err);
							});
					},
				});
				dialog.$wrapper.addClass("sanad-kit sanad-sheet");
				dialog.show();
			})
			.catch((err) => sanad.ui.Toast.error(err));
	}

	// ---- FunctionDetail -----------------------------------------------------------------------

	const TABS = [
		{ key: "details", label: () => __("Details") },
		{ key: "log", label: () => __("Change log") },
		{ key: "preview", label: () => __("Preview") },
	];

	/**
	 * The function itself (`docs/component/Function Detail.dc.html`): what it does, when it is used,
	 * the variables it reads, the outputs it writes and the settings it exposes, then its change log
	 * and a preview. The Details tab is the catalog entry; the manifest rows (variables / outputs /
	 * settings) are read from the installed record, because the catalog API returns install state
	 * only (report: `functions.get_manifest`).
	 */
	class FunctionDetail {
		constructor(entry, { on_change } = {}) {
			this.entry = entry;
			this.on_change = on_change;
			this.tab = "details";
			this.manifest = null;
		}

		show() {
			this.dialog = new frappe.ui.Dialog({
				title: this.entry.function_name,
				size: "extra-large",
				fields: [{ fieldtype: "HTML", fieldname: "body" }],
			});
			this.dialog.$wrapper.addClass("sanad-kit sanad-sheet wa-fndetail");
			this.$body = this.dialog.get_field("body").$wrapper;
			this.render_shell();
			this.dialog.show();
			this.load();
			return this;
		}

		/** Refresh after an action that changed the record, keeping the modal open. */
		changed(entry) {
			if (entry) this.entry = entry;
			this.manifest = null;
			this.render_shell();
			this.load();
		}

		render_shell() {
			const e = this.entry;
			this.id = this.id || sanad.ui.uid("wa-fn");
			const tabs = TABS.map(
				(t) =>
					`<button type="button" role="tab" class="wa-fndetail__tab" data-tab="${t.key}"
						id="${this.id}-tab-${t.key}" aria-controls="${this.id}-pane"
						aria-selected="${t.key === this.tab}" tabindex="${t.key === this.tab ? 0 : -1}">${esc(t.label())}${
						t.key === "log" ? ` <span class="sanad-chip__count sanad-tabular">${fmt_int((e.versions || []).length)}</span>` : ""
					}</button>`
			).join("");
			this.$body.html(`
				<div class="wa-fndetail__head">
					<div class="wa-fndetail__badges">
						<span class="sanad-chip sanad-chip--sm">${esc(e.category || __("Uncategorised"))}</span>
						${install_badge(e)}
						${e.installed ? status_badge(e) : ""}
						${e.installed ? update_badge(e) : ""}
					</div>
					<div class="wa-fndetail__versions">
						${e.installed ? version_pill(__("Installed"), e.installed_version, "green") : ""}
						${version_pill(__("Latest"), e.latest_version, e.update_available ? "amber" : "gray")}
					</div>
				</div>
				<div class="wa-fndetail__tabs" role="tablist" aria-label="${esc(__("Function detail"))}">${tabs}</div>
				<div class="wa-fndetail__pane" role="tabpanel" id="${this.id}-pane"
					aria-labelledby="${this.id}-tab-${this.tab}" tabindex="0"></div>
				<div class="wa-fndetail__actions"></div>`);
			this.$pane = this.$body.find(".wa-fndetail__pane");
			this.$actions = this.$body.find(".wa-fndetail__actions");
			this.$body.find(".wa-fndetail__tab").on("click", (ev) => this.select($(ev.currentTarget).data("tab")));
			this.$body.find(".wa-fndetail__tabs").on("keydown", (ev) => {
				const items = this.$body.find(".wa-fndetail__tab").toArray();
				const index = items.indexOf(ev.currentTarget.querySelector('[aria-selected="true"]'));
				const next = sanad.ui.roving_index(ev, items, index);
				if (next < 0) return;
				ev.preventDefault();
				this.select($(items[next]).data("tab"));
				items[next].focus();
			});
			this.render_actions();
		}

		select(tab) {
			this.tab = tab;
			this.$body.find(".wa-fndetail__tab").each((i, el) => {
				const on = $(el).data("tab") === tab;
				$(el).attr("aria-selected", on ? "true" : "false").attr("tabindex", on ? 0 : -1);
			});
			this.$pane.attr("aria-labelledby", `${this.id}-tab-${tab}`);
			this.render_pane();
		}

		/** The manifest is what the installed record stores; a Manager also sees what an install adds. */
		load() {
			this.state = new sanad.ui.EmptyState({ wrapper: this.$pane, state: "loading", rows: 4 });
			const key = this.entry.function_key;
			const jobs = [];
			if (this.entry.installed) {
				jobs.push(
					sanad.ui
						.call("frappe.client.get_value", {
							doctype: "WhatsApp Function",
							filters: key,
							fieldname: ["manifest", "installed_at", "installed_by", "catalog_source", "last_error"],
						})
						.then((doc) => {
							this.record = doc || {};
							try {
								this.manifest = doc && doc.manifest ? JSON.parse(doc.manifest) : null;
							} catch (e) {
								this.manifest = null;
							}
						})
				);
			} else if (is_manager()) {
				jobs.push(
					sanad.ui
						.call("functions.preview_install", { function_key: key })
						.then((diff) => {
							this.incoming = diff;
						})
						.catch(() => {
							this.incoming = null;
						})
				);
			}
			Promise.all(jobs)
				.then(() => {
					this.state.hide();
					this.render_pane();
				})
				.catch((err) =>
					this.state.error(err, {
						title: __("Could not read this function"),
						action: { label: __("Retry"), onclick: () => this.load() },
					})
				);
		}

		// ---- panes ----------------------------------------------------------------------------

		render_pane() {
			if (!this.$pane) return;
			if (this.tab === "log") return this.render_log();
			if (this.tab === "preview") return this.render_preview();
			return this.render_details();
		}

		block(label, body) {
			return `<section class="wa-fndetail__block"><h3 class="wa-fndetail__block-title">${esc(label)}</h3>${body}</section>`;
		}

		/** The prototype's four tiles: what this function costs and what runs on it. */
		facts() {
			const e = this.entry;
			const linked = e.linked_commands || [];
			return `<div class="wa-fndetail__tiles">
				${fact_tile(__("Calls (30d)"), fmt_int(e.calls_30d))}
				${fact_tile(__("Average run"), esc(ms_text(e.avg_ms)))}
				${fact_tile(__("Linked commands"), fmt_int(linked.length))}
				${fact_tile(__("Active among them"), fmt_int(linked.filter((c) => c.status === "Active").length))}
			</div>`;
		}

		/** Where the function comes from and whether this site can actually run it. */
		provenance() {
			const e = this.entry;
			return `<p class="wa-fndetail__muted">${esc(
				__("Handler: {0}", [e.handler_registered ? __("Registered") : __("Missing")])
			)} · <code class="wa-fndetail__token">${esc(e.source || "—")}</code></p>`;
		}

		alert_html() {
			const e = this.entry;
			const linked = (e.linked_commands || []).length;
			if (e.installed && e.update_available)
				return `<div class="wa-fndetail__alert sanad-tone--amber" role="status">${esc(
					__("A newer version is available: {0}. Updating does not change the linked commands.", [
						e.latest_version,
					])
				)}</div>`;
			if (e.installed && e.status !== "Active")
				return `<div class="wa-fndetail__alert sanad-tone--amber" role="status">${esc(
					linked
						? sanad.ui.plural(linked, {
								one: __("This function is inactive; {0} linked command will not run."),
								other: __("This function is inactive; {0} linked commands will not run."),
						  })
						: __("This function is inactive. No command is linked to it yet.")
				)}</div>`;
			if (!e.installed)
				return `<div class="wa-fndetail__alert sanad-tone--blue" role="status">${esc(
					__("This function is in the catalog but is not installed on this site.")
				)}</div>`;
			return "";
		}

		list_block(label, rows, render, empty_text) {
			if (!rows || !rows.length) return this.block(label, `<p class="wa-fndetail__muted">${esc(empty_text)}</p>`);
			return this.block(label, `<ul class="wa-fndetail__rows">${rows.map(render).join("")}</ul>`);
		}

		render_details() {
			const e = this.entry;
			const m = this.manifest || {};
			const incoming = this.incoming || null;
			const inputs = m.inputs || [];
			const outputs = m.outputs || [];
			const settings = m.settings || [];
			const not_installed_note = __("The full manifest is read when the function is installed.");
			const inputs_html = this.list_block(
				__("Variables it reads"),
				inputs,
				(i) =>
					`<li><code class="wa-fndetail__token">${esc(i.key)}</code>
						<span class="wa-fndetail__row-label">${esc(__(i.label || i.key))}</span>
						${i.required ? `<span class="sanad-chip sanad-chip--sm">${esc(__("Required"))}</span>` : ""}
						${i.type ? `<span class="wa-fndetail__muted">${esc(i.type)}</span>` : ""}</li>`,
				e.installed ? __("This function takes no variables.") : not_installed_note
			);
			const outputs_html = this.list_block(
				__("Outputs it writes"),
				outputs.length ? outputs : (incoming && (incoming.diff.outputs.added || []).map((k) => ({ output_key: k }))) || [],
				(o) =>
					`<li><code class="wa-fndetail__token">${esc(o.output_key)}</code>
						${o.label ? `<span class="wa-fndetail__row-label">${esc(__(o.label))}</span>` : ""}
						${o.output_type ? `<span class="sanad-chip sanad-chip--sm">${esc(__(o.output_type))}</span>` : ""}
						${o.default_template ? `<p class="wa-fndetail__template">${esc(o.default_template)}</p>` : ""}</li>`,
				e.installed ? __("This function writes no output.") : not_installed_note
			);
			const settings_html = this.list_block(
				__("Settings it exposes"),
				settings.length ? settings : (incoming && (incoming.diff.settings.added || []).map((k) => ({ key: k }))) || [],
				(s) =>
					`<li><code class="wa-fndetail__token">${esc(s.key)}</code>
						${s.label ? `<span class="wa-fndetail__row-label">${esc(__(s.label))}</span>` : ""}
						${s.default_value ? `<span class="wa-fndetail__muted">${esc(__("Default: {0}", [s.default_value]))}</span>` : ""}
						${s.notes ? `<p class="wa-fndetail__muted">${esc(__(s.notes))}</p>` : ""}</li>`,
				e.installed ? __("This function has no settings.") : not_installed_note
			);
			const commands = e.linked_commands || [];
			const commands_html = this.block(
				__("Linked commands"),
				commands.length
					? `<div class="wa-fndetail__chips">${commands
							.map(
								(c) =>
									`<span class="sanad-chip sanad-chip--sm"><code>${esc(c.code)}</code> ${esc(
										__(c.status)
									)}</span>`
							)
							.join("")}</div>`
					: `<p class="wa-fndetail__muted">${esc(__("No command runs this function yet."))}</p>`
			);
			const serves = (e.party_types || []).map((t) => `<span class="sanad-chip sanad-chip--sm">${esc(__(t))}</span>`).join("");
			// The prototype reads this pane in three columns: what the function is on the
			// inline-start, what it takes in the middle, what it writes at the inline-end. Below
			// 1100 px they fall into one column in the same order.
			this.$pane.html(`
				${this.alert_html()}
				<div class="wa-fndetail__cols">
					<div class="wa-fndetail__col">
						<p class="wa-fndetail__lede" dir="auto">${esc(e.description || __("No description in the catalog."))}</p>
						<div class="wa-fndetail__card">
							<span class="wa-fndetail__block-title">${esc(__("When it is used"))}</span>
							<p class="wa-fndetail__muted" dir="auto">${esc(e.when_to_use || __("The catalog does not say when to use it."))}</p>
						</div>
						${this.block(
							__("Party types it serves"),
							serves
								? `<div class="wa-fndetail__chips">${serves}</div>`
								: `<p class="wa-fndetail__muted">${esc(__("Any sender."))}</p>`
						)}
						${this.facts()}
						${commands_html}
						${this.provenance()}
					</div>
					<div class="wa-fndetail__col">
						${inputs_html}
						${settings_html}
					</div>
					<div class="wa-fndetail__col">
						${outputs_html}
					</div>
				</div>`);
		}

		render_log() {
			const e = this.entry;
			const versions = (e.versions || []).slice().reverse();
			if (!versions.length) {
				new sanad.ui.EmptyState({
					wrapper: this.$pane.empty(),
					state: "empty",
					title: __("No versions in the catalog"),
					description: __("This function has no released version yet."),
				});
				return;
			}
			const rows = versions
				.map((v) => {
					const badges = [];
					if (v === e.latest_version)
						badges.push(sanad.ui.StatusBadge.html({ label: __("Latest"), colour: "blue" }));
					if (v === e.installed_version)
						badges.push(sanad.ui.StatusBadge.html({ label: __("Installed"), colour: "green" }));
					const text = (e.changelog || {})[v];
					const action =
						is_manager() && v !== e.installed_version
							? `<button type="button" class="btn btn-default btn-xs" data-version="${esc(v)}">${esc(
									e.installed
										? __("Switch to this version")
										: __("Install this version")
							  )}</button>`
							: "";
					return `<li class="wa-fndetail__version">
						<div class="wa-fndetail__version-head">
							<b class="sanad-tabular">${esc(v)}</b>${badges.join("")}${action}
						</div>
						<p class="wa-fndetail__muted">${esc(text || __("No note for this version."))}</p>
					</li>`;
				})
				.join("");
			this.$pane.html(`<ul class="wa-fndetail__rows wa-fndetail__log">${rows}</ul>`);
			this.$pane.find("[data-version]").on("click", (ev) => {
				const version = $(ev.currentTarget).data("version");
				new PreviewModal(this.entry, { version, on_done: () => this.on_change && this.on_change(this) }).show();
			});
		}

		/**
		 * A dry run instead of a mock-up: the prototype renders the reply from sample values, and
		 * this app can do better — `commands.test_command` routes one message through the real
		 * command router without storing or sending anything. Without a linked command there is
		 * nothing to route, so the pane shows the output templates and says what is missing.
		 */
		render_preview() {
			const e = this.entry;
			const m = this.manifest || {};
			if (!e.installed) {
				new sanad.ui.EmptyState({
					wrapper: this.$pane.empty(),
					state: "empty",
					title: __("Install to preview"),
					description: __("The preview runs the real function, so it needs the function installed on this site."),
					action: is_manager()
						? {
								label: __("Install"),
								onclick: () =>
									new PreviewModal(this.entry, {
										on_done: () => this.on_change && this.on_change(this),
									}).show(),
						  }
						: null,
				});
				return;
			}
			const commands = (e.linked_commands || []).filter((c) => c.status === "Active");
			const templates = (m.outputs || [])
				.filter((o) => o.default_template)
				.map(
					(o) =>
						`<li><span class="wa-fndetail__row-label">${esc(__(o.label || o.output_key))}</span>
							<p class="wa-fndetail__template">${esc(o.default_template)}</p></li>`
				)
				.join("");
			this.$pane.html(`
				<p class="wa-fndetail__note">${esc(__("Simulation — the function runs, nothing is stored and nothing is sent."))}</p>
				<div class="wa-fndetail__runner"></div>
				${templates ? this.block(__("Reply templates"), `<ul class="wa-fndetail__rows">${templates}</ul>`) : ""}`);
			const $runner = this.$pane.find(".wa-fndetail__runner");
			if (!is_manager()) {
				new sanad.ui.EmptyState({
					wrapper: $runner,
					state: "empty",
					size: "sm",
					title: __("Only a manager can run the preview"),
					description: __("The templates above show what the reply is built from."),
				});
				return;
			}
			if (!commands.length) {
				new sanad.ui.EmptyState({
					wrapper: $runner,
					state: "empty",
					size: "sm",
					title: __("No active command to run"),
					description: __("A command carries the word a sender writes. Link one to preview the reply."),
					action: { label: __("Open commands"), onclick: () => command_route(e) },
				});
				return;
			}
			this.render_runner($runner, commands, m.example || "");
		}

		render_runner($wrapper, commands, example) {
			const id = sanad.ui.uid("wa-run");
			$wrapper.html(`
				<div class="wa-fndetail__form">
					<label class="wa-fndetail__field">
						<span>${esc(__("Message"))}</span>
						<input type="text" class="form-control" id="${id}-text" dir="auto"
							value="${esc(example || commands[0].code)}" />
					</label>
					<label class="wa-fndetail__field">
						<span>${esc(__("Sender number"))}</span>
						<input type="tel" class="form-control" id="${id}-phone" dir="ltr" inputmode="tel"
							placeholder="${esc(sanad.ui.PhoneField.example())}" />
					</label>
					<button type="button" class="btn btn-default btn-sm wa-fndetail__run">${esc(__("Run preview"))}</button>
				</div>
				<div class="wa-fndetail__result"></div>`);
			const $text = $wrapper.find(`#${id}-text`);
			const $phone = $wrapper.find(`#${id}-phone`);
			const $result = $wrapper.find(".wa-fndetail__result");
			// A real sender makes the preview honest: the router resolves the party from the number.
			sanad.ui
				.call("numbers.search_numbers", { page: 1, page_length: 1 }, { silent: true })
				.then((r) => {
					const row = ((r && r.rows) || [])[0];
					if (row && !$phone.val()) $phone.val(row.phone_e164);
				})
				.catch(() => {});
			$wrapper.find(".wa-fndetail__run").on("click", (ev) => {
				const text = cstr($text.val()).trim();
				const phone = sanad.ui.PhoneField.normalize(cstr($phone.val()));
				if (!text) return sanad.ui.Toast.warning(__("Write the message the sender would send."));
				if (!phone.valid) return sanad.ui.Toast.warning(__("Enter the sender's number in full, with its country code."));
				const $btn = $(ev.currentTarget).prop("disabled", true);
				$result.html(sanad.ui.skeleton(1, { lines: 2 }));
				sanad.ui
					.call("commands.test_command", { text, sender_phone: phone.phone_e164 })
					.then((r) => this.render_result($result, r))
					.catch((err) => {
						$result.empty();
						new sanad.ui.EmptyState({ wrapper: $result, state: "error", size: "sm", description: err.message });
					})
					.then(() => $btn.prop("disabled", false));
			});
		}

		render_result($wrapper, r) {
			const tone = r.matched ? (r.block_reason ? "amber" : "green") : "gray";
			const label = r.block_reason
				? __("Blocked: {0}", [__(r.block_reason)])
				: r.matched
				? __("Matched {0}", [r.command])
				: __("No command matched this message");
			$wrapper.html(`
				<div class="wa-fndetail__result-head">
					<span class="sanad-chip sanad-chip--sm sanad-tone--${tone}">${esc(label)}</span>
					<span class="wa-fndetail__muted sanad-tabular">${esc(__("{0} ms", [fmt_int(r.function_ms)]))}</span>
				</div>
				${
					r.reply_body
						? `<div class="wa-fndetail__reply">${sanad.ui.ChatThread.format(r.reply_body)}</div>`
						: `<p class="wa-fndetail__muted">${esc(r.error || __("The function produced no reply."))}</p>`
				}`);
			sanad.ui.announce(label);
		}

		// ---- actions --------------------------------------------------------------------------

		render_actions() {
			const e = this.entry;
			const manager = is_manager();
			const actions = [];
			if (manager && !e.installed)
				actions.push({
					label: __("Install"),
					primary: true,
					handler: () => new PreviewModal(e, { on_done: () => this.on_change && this.on_change(this) }).show(),
				});
			if (manager && e.installed && e.update_available)
				actions.push({
					label: __("Update to {0}", [e.latest_version]),
					primary: true,
					handler: () => new PreviewModal(e, { on_done: () => this.on_change && this.on_change(this) }).show(),
				});
			if (manager && e.installed)
				actions.push({
					label: e.status === "Active" ? __("Deactivate") : __("Activate"),
					handler: () => this.set_status(e.status === "Active" ? "Inactive" : "Active"),
				});
			if (manager && e.installed)
				actions.push({ label: __("Edit settings"), handler: () => edit_settings(e, () => this.on_change && this.on_change(this)) });
			actions.push({
				label: (e.linked_commands || []).length ? __("Linked commands") : __("Link a command"),
				handler: () => {
					this.dialog.hide();
					command_route(e);
				},
			});
			if (manager && e.installed)
				actions.push({ label: __("Remove"), danger: true, handler: () => this.remove() });
			this.$actions.empty();
			actions.forEach((a) => {
				$(
					`<button type="button" class="btn btn-sm ${
						a.primary ? "btn-primary" : a.danger ? "btn-default wa-fndetail__danger" : "btn-default"
					}">${esc(a.label)}</button>`
				)
					.on("click", a.handler)
					.appendTo(this.$actions);
			});
		}

		set_status(status) {
			sanad.ui
				.call("functions.set_status", { function_key: this.entry.function_key, status })
				.then(() => {
					sanad.ui.Toast.success(
						status === "Active"
							? __("{0} is active", [this.entry.function_name])
							: __("{0} is inactive", [this.entry.function_name])
					);
					this.entry.status = status;
					this.on_change && this.on_change(this);
				})
				.catch((err) => sanad.ui.Toast.error(err));
		}

		/** Removing is refused while a command still runs on the function (409) — say so plainly. */
		remove() {
			const e = this.entry;
			const linked = (e.linked_commands || []).length;
			sanad.ui.ConfirmDialog.ask({
				title: __("Remove {0}?", [e.function_name]),
				message: __(
					"The installed record, its settings and its outputs are deleted. The catalog keeps the function, so it can be installed again."
				),
				impact: [
					{ label: __("Installed version"), value: e.installed_version || "—" },
					{ label: __("Linked commands"), value: fmt_int(linked), tone: linked ? "red" : null },
				],
				danger: true,
				confirm_label: __("Remove"),
				on_confirm: () => sanad.ui.call("functions.remove", { function_key: e.function_key }),
			})
				.then(() => {
					sanad.ui.Toast.success(__("{0} removed", [e.function_name]));
					this.dialog.hide();
					this.on_change && this.on_change(this);
				})
				.catch(() => {});
		}
	}

	// ---- the storefront table -------------------------------------------------------------------

	/**
	 * The prototype's columns (`docs/screen/Hub Screen - Functions.dc.html`), drawn by the kit's
	 * `DataList` in page mode: the catalog is a file, so this screen owns the rows, the filtering,
	 * the sorting and the paging, and the table only renders them — the same table the Outbound,
	 * Inbound, Queue and Commands screens use.
	 */
	// The prototype's row is one line: the function's name, bold, and nine facts beside it. The
	// catalog description is *searched* but not drawn here (it is the detail's "What it does"), so
	// the row keeps the prototype's density instead of wrapping a paragraph into the name cell.
	const columns = () => [
		{
			fieldname: "function_name",
			label: __("Function"),
			width: 160,
			sortable: true,
			format: (v) => `<strong>${esc(v || "")}</strong>`,
		},
		{ fieldname: "category", label: __("Category"), width: 108, sortable: true, format: (v) => esc(v || "") },
		{
			fieldname: "installed_version",
			label: __("Version"),
			width: 84,
			sortable: true,
			format: (v, doc) => `<span class="sanad-tabular">${esc(v || doc.latest_version || "")}</span>`,
		},
		{
			fieldname: "update_available",
			label: __("Update"),
			width: 112,
			sortable: true,
			format: (v, doc) => (doc.installed ? update_badge(doc) : ""),
		},
		{
			fieldname: "commands_count",
			label: __("Linked commands"),
			type: "number",
			align: "end",
			width: 104,
			sortable: true,
			format: (v) => fmt_int(v),
		},
		{
			fieldname: "calls_30d",
			label: __("Calls (30d)"),
			type: "number",
			align: "end",
			width: 96,
			sortable: true,
			format: (v) => fmt_int(v),
		},
		{
			fieldname: "avg_ms",
			label: __("Average run"),
			type: "number",
			align: "end",
			width: 98,
			sortable: true,
			hidden_xs: true,
			format: (v) => (cint(v) ? esc(ms_text(v)) : ""),
		},
		{ fieldname: "status", label: __("Status"), width: 94, sortable: true, format: (v, doc) => (doc.installed ? status_badge(doc) : "") },
		{ fieldname: "installed", label: __("Install"), width: 98, sortable: true, format: (v, doc) => install_badge(doc) },
	];

	/** How each column is compared when the reader sorts by it. */
	const SORT_VALUE = {
		function_name: (e) => cstr(e.function_name).toLowerCase(),
		category: (e) => cstr(e.category).toLowerCase(),
		installed_version: (e) => cstr(e.installed_version || e.latest_version),
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
			this.$toolbar = $('<div class="wa-functions__toolbar"></div>').appendTo(this.$main);
			this.$bulk = $('<div class="wa-functions__bulk" hidden></div>').appendTo(this.$main);
			this.$body = $('<div class="wa-functions__body"></div>').appendTo(this.$main);
			this.state = new sanad.ui.EmptyState({ wrapper: this.$body, state: "loading", rows: 6 });
			this.load();
		}

		// ---- data -----------------------------------------------------------------------------

		load() {
			if (!this.table) this.state.loading({ rows: 6 });
			return Promise.all([
				sanad.ui.call("functions.get_catalog"),
				sanad.ui.call("commands.list_commands", { page: 1, page_length: 200 }, { silent: true }).catch(() => null),
				sanad.ui
					.call(
						"frappe.client.get_list",
						{
							doctype: "WhatsApp Function",
							fields: ["name", "avg_ms", "call_count", "error_count"],
							limit_page_length: 0,
						},
						{ silent: true }
					)
					.catch(() => []),
				sanad.ui.meta.with_doctype("WhatsApp Function"),
			])
				.then(([catalog, commands, docs]) => {
					this.catalog = catalog || {};
					this.commands = (commands && commands.rows) || [];
					this.commands_total = (commands && commands.total) || this.commands.length;
					this.entries = decorate(this.catalog.entries, this.commands, docs);
					this.state.hide();
					this.render();
				})
				.catch((err) =>
					this.state.error(err, {
						title: __("Could not load the catalog"),
						action: { label: __("Retry"), on_click: () => this.load() },
					})
				);
		}

		/** Re-read after install / update / remove, keeping the filters and the page. */
		reload() {
			return this.load();
		}

		// ---- the screen's own numbers ----------------------------------------------------------

		counters() {
			const all = this.entries;
			return {
				total: all.length,
				categories: Array.from(new Set(all.map((e) => e.category).filter(Boolean))).length,
				installed: all.filter((e) => e.installed).length,
				active: all.filter((e) => e.installed && e.status === "Active").length,
				inactive: all.filter((e) => e.installed && e.status !== "Active").length,
				outdated: all.filter((e) => e.update_available).length,
				calls: all.reduce((n, e) => n + cint(e.calls_30d), 0),
			};
		}

		/**
		 * No title row: Desk's own page head already names the screen, and a second title above the
		 * toolbar only repeats it (owner, 2026-09-23). What the prototype puts under that title —
		 * the sentence that says what a function is, and the "Commands · N" button at the
		 * inline-end of the same row — the header carries instead, above the KPI row and the one
		 * banner the operator must not miss.
		 */
		render_header() {
			const c = this.counters();
			if (this.header) this.header.destroy();
			this.$head.empty();
			this.header = new sanad.ui.PageHeader({
				wrapper: this.$head,
				description: __("A function is the logic behind a command. Review its versions here and update it."),
				secondary: [
					{
						label: __("Commands"),
						icon: "es-line-chat-alt",
						count: this.commands_total,
						handler: () => frappe.set_route("List", "WhatsApp Command"),
					},
				],
				stats: [
					{
						key: "total",
						label: __("Functions"),
						icon: "es-line-all-apps",
						value: () => c.total,
						sub: sanad.ui.plural(c.categories, { one: __("{0} category"), other: __("{0} categories") }),
					},
					{
						key: "active",
						label: __("Active"),
						icon: "es-line-success",
						tone: "green",
						value: () => c.active,
						sub: __("{0} installed, {1} inactive", [fmt_int(c.installed), fmt_int(c.inactive)]),
					},
					{
						key: "calls",
						label: __("Calls (30d)"),
						icon: "es-line-chart",
						tone: "blue",
						value: () => c.calls,
						sub: sanad.ui.plural(this.commands_total, {
							one: __("Through {0} linked command"),
							other: __("Through {0} linked commands"),
						}),
						onclick: () => frappe.set_route("List", "WhatsApp Command"),
					},
					{
						key: "updates",
						label: __("Updates available"),
						icon: "es-line-alert-triangle",
						tone: c.outdated ? "amber" : "gray",
						value: () => c.outdated,
						sub: c.outdated ? __("Newer versions ready to install") : __("Every function is on its latest version"),
					},
				],
				banner: () => this.banner(),
			});
		}

		/** The one state the operator must not miss: a catalog file that could not be read. */
		banner() {
			const errors = (this.catalog && this.catalog.catalog_errors) || [];
			if (errors.length) return { tone: "red", text: __("A catalog file could not be read: {0}", [errors.join(" · ")]) };
			const missing = this.entries.filter((e) => e.installed && !e.handler_registered);
			if (missing.length)
				return {
					tone: "amber",
					text: sanad.ui.plural(missing.length, {
						one: __("{0} installed function has no handler and will not run."),
						other: __("{0} installed functions have no handler and will not run."),
					}),
				};
			return null;
		}

		// ---- toolbar --------------------------------------------------------------------------

		render_toolbar() {
			if (this.filter_bar) return;
			const categories = Array.from(new Set(this.entries.map((e) => e.category).filter(Boolean))).sort();
			this.filter_bar = new sanad.ui.FilterBar({
				page: this.page,
				wrapper: this.$toolbar,
				doctype: "WhatsApp Function",
				presets: [
					{
						fieldname: "function_name",
						type: "search",
						fields: ["function_name", "category", "description"],
						placeholder: __("Search a function, its category or its description…"),
					},
					{
						fieldname: "category",
						type: "select",
						label: __("Category"),
						options: categories.map((v) => ({ value: v, label: __(v) })),
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
				if (!has(e.category, f.category)) return false;
				if (f.update_state === "available" && !e.update_available) return false;
				if (f.update_state === "current" && e.update_available) return false;
				if (f.status && (!e.installed || e.status !== f.status)) return false;
				if (f.install_state === "installed" && !e.installed) return false;
				if (f.install_state === "not_installed" && e.installed) return false;
				if (this.search) {
					const hay = [e.function_name, e.function_key, e.category, e.description, e.when_to_use]
						.map(cstr)
						.join(" ")
						.toLowerCase();
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
				this.table = new sanad.ui.DataList({
					wrapper: this.$body,
					doctype: "WhatsApp Function",
					columns: columns(),
					selectable: is_manager(),
					page_length: 20,
					sort: this.sort,
					// what the prototype's phone card carries: the name, its group and version, the
					// update state, the commands behind it and the two state badges
					mobile_columns: [
						"function_name",
						"category",
						"installed_version",
						"update_available",
						"commands_count",
						"calls_30d",
						"status",
						"installed",
					],
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
					footer: {
						count: (total) => sanad.ui.plural(total, { one: __("{0} function"), other: __("{0} functions") }),
					},
					empty: {
						title: this.entries.length ? __("No function matches") : __("The catalog is empty"),
						description: this.entries.length
							? __("Change the search or the filters to see more of the catalog.")
							: __(
									"No function is published for this site yet. A function comes from an installed app that ships a catalog file."
							  ),
						action: this.entries.length
							? { label: __("Clear filters"), on_click: () => this.filter_bar && this.filter_bar.clear() }
							: null,
					},
				});
				// The table tells a page about "select all" and about a group, but not about one
				// row's checkbox (kit ask in the report), so the screen listens for it itself.
				// It is bound after the table's own handler, which has already updated the set.
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
			sanad.ui.announce(sanad.ui.plural(rows.length, { one: __("{0} function"), other: __("{0} functions") }));
		}

		// ---- selection ---------------------------------------------------------------------------

		/**
		 * The prototype's selection cluster (`docs/component/List View.dc.html`): a tinted
		 * "N selected ×" pill and, beside it, the verbs that act on the selection — update,
		 * activate, deactivate — each naming how many rows it will actually touch. It sits at the
		 * inline-end above the table, where the prototype ends its toolbar.
		 */
		render_bulk(picked) {
			if (!is_manager() || !picked.length) return this.$bulk.attr("hidden", true).empty();
			const updatable = picked.filter((e) => e.update_available).length;
			const installed = picked.filter((e) => e.installed).length;
			this.$bulk.removeAttr("hidden").html(`
				<span class="wa-functions__bulk-count">
					<span role="status" aria-atomic="true">${esc(
						sanad.ui.plural(picked.length, { one: __("{0} selected"), other: __("{0} selected") })
					)}</span>
					<button type="button" class="wa-functions__bulk-clear" aria-label="${esc(__("Clear selection"))}">&times;</button>
				</span>
				${
					updatable
						? `<button type="button" class="btn btn-sm wa-functions__bulk-btn" data-bulk="update">${esc(
								__("Update {0}", [fmt_int(updatable)])
						  )}</button>`
						: ""
				}
				${
					installed
						? `<button type="button" class="btn btn-sm wa-functions__bulk-btn" data-bulk="Active">${esc(
								__("Activate {0}", [fmt_int(installed)])
						  )}</button>
							<button type="button" class="btn btn-sm wa-functions__bulk-btn" data-bulk="Inactive">${esc(
								__("Deactivate {0}", [fmt_int(installed)])
							)}</button>`
						: `<span class="wa-functions__bulk-note">${esc(
								__("Install a function before activating or deactivating it.")
						  )}</span>`
				}`);
			this.$bulk.find("[data-bulk]").on("click", (ev) => this.bulk($(ev.currentTarget).data("bulk"), picked));
			this.$bulk.find(".wa-functions__bulk-clear").on("click", () => {
				this.table.clear_selection();
				this.render_bulk([]);
			});
		}

		// ---- actions -------------------------------------------------------------------------------

		open(entry) {
			this.detail = new FunctionDetail(entry, {
				on_change: () => this.reload().then(() => this.refresh_detail(entry.function_key)),
			}).show();
		}

		/** After an action the modal keeps the screen's truth: re-read the entry it is showing. */
		refresh_detail(key) {
			if (!this.detail || !this.detail.dialog || !this.detail.dialog.display) return;
			const entry = this.entries.find((e) => e.function_key === key);
			if (entry) this.detail.changed(entry);
			else this.detail.dialog.hide();
		}

		bulk(what, picked) {
			if (what === "update") {
				const targets = picked.filter((e) => e.update_available);
				const impacted = targets.reduce((n, e) => n + (e.linked_commands || []).length, 0);
				const left = this.entries.filter((e) => e.update_available).length - targets.length;
				sanad.ui.ConfirmDialog.ask({
					title: sanad.ui.plural(targets.length, {
						one: __("Update {0} function?"),
						other: __("Update {0} functions?"),
					}),
					message: __(
						"Each function moves to its latest version. Commands, their words and their permissions stay as they are."
					),
					impact: [
						{ label: __("Functions to update"), value: fmt_int(targets.length) },
						{ label: __("Commands that benefit"), value: fmt_int(impacted), tone: "green" },
						{ label: __("Left without update"), value: fmt_int(left) },
					],
					confirm_label: __("Update"),
					on_confirm: () =>
						sanad.ui.call("functions.update_many", { function_keys: targets.map((e) => e.function_key) }),
				})
					.then((r) => this.after_bulk(r, __("{0} functions updated", [fmt_int((r && r.count) || 0)])))
					.catch(() => {});
				return;
			}
			const status = what;
			const targets = picked.filter((e) => e.installed);
			if (!targets.length) return sanad.ui.Toast.warning(__("Only installed functions can be activated or deactivated."));
			sanad.ui.ConfirmDialog.ask({
				title:
					status === "Active"
						? sanad.ui.plural(targets.length, {
								one: __("Activate {0} function?"),
								other: __("Activate {0} functions?"),
						  })
						: sanad.ui.plural(targets.length, {
								one: __("Deactivate {0} function?"),
								other: __("Deactivate {0} functions?"),
						  }),
				message:
					status === "Active"
						? __("Linked commands run again from their next message.")
						: __("Linked commands still match the text, but they will not run."),
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
				on_confirm: () =>
					sanad.ui.call("functions.set_status_many", {
						function_keys: targets.map((e) => e.function_key),
						status,
					}),
			})
				.then((r) =>
					this.after_bulk(
						r,
						status === "Active"
							? __("{0} functions activated", [fmt_int((r && r.count) || 0)])
							: __("{0} functions deactivated", [fmt_int((r && r.count) || 0)])
					)
				)
				.catch(() => {});
		}

		after_bulk(result, message) {
			const failed = ((result || {}).failed || []).length;
			const skipped = ((result || {}).skipped || []).length;
			if (failed) sanad.ui.Toast.warning(__("{0} could not be done", [fmt_int(failed)]));
			else if (skipped && !cint((result || {}).count)) sanad.ui.Toast.info(__("Nothing to do"));
			else sanad.ui.Toast.success(message);
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
		}
	}

	frappe.pages[ROUTE].on_page_load = function (wrapper) {
		const page = frappe.ui.make_app_page({
			parent: wrapper,
			title: __("Functions Center"),
			single_column: true,
		});
		wrapper.whatsapp_next = new FunctionsCenter(page);
		frappe.provide("whatsapp_next.pages");
		whatsapp_next.pages.functions_center = wrapper.whatsapp_next;
	};

	frappe.pages[ROUTE].on_page_show = function (wrapper) {
		// coming back from a command or a form: the install state may have moved meanwhile
		if (wrapper.whatsapp_next && wrapper.whatsapp_next.entries.length) wrapper.whatsapp_next.reload();
	};
})();

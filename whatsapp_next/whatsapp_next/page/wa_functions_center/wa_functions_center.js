// Functions Center (09 row 7, spec §5.6) — the storefront over the function catalog. A function is
// the logic behind a command; this screen is where its versions are reviewed, installed, updated,
// switched on and off. The catalog is a JSON file read by `functions.get_catalog`; the installed
// record is the `WhatsApp Function` DocType, so every row carries two states at once: what the
// catalog offers (latest version, change log) and what this site runs (installed version, status).
//
// Anatomy, from the prototype (`docs/screen/Hub Screen - Functions.dc.html`) drawn with the kit:
// the product's `PageHeader` (title, the sentence that says what a function is, the "Commands · N"
// button at the inline-end), the prototype's four `Cards` (compact `stat`: functions, active,
// calls, updates), the shared `FilterBar` and the kit's `DataList` in page mode with the
// prototype's nine columns. The catalog is a file, so this screen owns the rows, the filtering,
// the sorting and the paging and hands the table one page at a time.
//
// The function itself opens as the kit's record drawer in its document layout (D-084): identity,
// what it does, the six facts an operator asks first, the variables · settings · outputs the
// manifest declares, the commands that run on it drawn as themselves, the record's own details
// and the versions as a timeline — two or three verbs in the footer, the rest behind "More".
// A form is an `OverlayPanel`: the dry-run preview, the diff shown before install or update, and
// the settings editor. Every read and write goes through `sanad.ui.call` to `functions.*` /
// `commands.*`; no business logic lives here.

(() => {
	const ROUTE = "wa-functions-center";
	const ui = sanad.ui;
	const kit = sanad.kit;
	const parts = ui.Render.parts;
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

	const install_badge = (e) =>
		e.installed
			? ui.StatusBadge.html({ label: __("Installed"), colour: "blue" })
			: ui.StatusBadge.html({ label: __("Not installed"), colour: "gray" });

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
				name: e.function_key, // the table addresses a row by `name`, like any Desk list
				calls_30d: calls[e.function_key] || 0,
				linked_commands: linked[e.function_key] || [],
				avg_ms: cint((by_key[e.function_key] || {}).avg_ms),
				call_count: cint((by_key[e.function_key] || {}).call_count),
				error_count: cint((by_key[e.function_key] || {}).error_count),
			})
		);
	}

	// ---- the diff before install / update ----------------------------------------------------

	/**
	 * What install / update will change, from `functions.preview_install`, as the prototype's
	 * confirmation with facts («تحديث «X»؟» — دوال ستُحدَّث · أوامر ستستفيد): the two versions,
	 * the rows that move (settings · outputs · manifest keys, each added / removed / changed) and
	 * the commands that run on this function. It is the preview *and* the confirmation — the diff
	 * is the impact, so the screen never asks twice for one decision.
	 */
	function confirm_change(entry, version, { on_close } = {}) {
		const installing = !entry.installed;
		const target = version || entry.latest_version;
		const rollback = !installing && version_cmp(target, entry.installed_version) < 0;
		let changed = false;
		const title = installing
			? __("Install {0}?", [entry.function_name])
			: rollback
			? __("Move {0} back to {1}?", [entry.function_name, target])
			: __("Update {0} to {1}?", [entry.function_name, target]);
		const chips = (keys, tone) => (keys || []).map((k) => kit.badge(k, tone, { dot: false })).join("");
		const moved = (label, rows, key) =>
			(rows || []).map((r) => kit.badge(`${r[key]} · ${Object.keys(r.fields || {}).join(", ")}`, "warn", { dot: false })).join("");
		/** One manifest area: three lines at most, each naming the keys that move. */
		const area = (label, d, key) => {
			const lines = [
				[__("Added"), chips(d.added, "ok")],
				[__("Removed"), chips(d.removed, "danger")],
				[__("Changed"), key ? moved(__("Changed"), d.changed, key) : chips(d.changed, "warn")],
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
			.call("functions.preview_install", { function_key: entry.function_key, version: target })
			.then((diff) => {
				const d = diff.diff || {};
				const impacted = diff.commands_impacted || [];
				const count = (x) => (x.added || []).length + (x.removed || []).length + (x.changed || []).length;
				const moving = count(d.settings || {}) + count(d.outputs || {}) + count(d.manifest || {});
				const blocks = [
					area(__("Settings"), d.settings || {}, "key"),
					area(__("Outputs"), d.outputs || {}, "output_key"),
					area(__("Manifest"), d.manifest || {}, null),
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
					subtitle: `${entry.installed_version || "—"} → ${target}`,
					subtitle_mono: true,
					badge: installing
						? { text: __("New install"), tone: "info" }
						: rollback
						? { text: __("Rollback"), tone: "warn" }
						: { text: __("Update"), tone: "ok" },
					detail: {
						alert: diff.handler_registered
							? {
									tone: "info",
									title: installing
										? __("Installing copies the settings and outputs below into this site.")
										: __("The function's logic moves to the chosen version."),
									lines: [__("Nothing is sent. Commands, their words and their permissions stay as they are.")],
							  }
							: {
									tone: "danger",
									title: __("No handler is registered for this function."),
									lines: [__("It cannot be installed until the app that provides it is installed on this site.")],
							  },
						facts: [
							{ k: __("Installed version"), v: entry.installed_version || __("None"), mono: !!entry.installed_version },
							{ k: __("Target version"), v: target, mono: true },
							{ k: __("Commands that benefit"), v: fmt_int(impacted.length), mono: true, tone: impacted.length ? "ok" : undefined },
							{ k: __("Changes"), v: fmt_int(moving), mono: true, tone: moving ? "warn" : undefined },
						],
						blocks: moving ? blocks : blocks.slice(-1).concat([{ label: __("Settings and outputs"), text: __("Nothing changes in the settings or the outputs.") }]),
					},
					actions: [
						{ key: "cancel", label: __("Cancel"), close: true },
						{
							key: "go",
							label: installing ? __("Install") : rollback ? __("Move back") : __("Update"),
							variant: "primary",
							handler: () =>
								ui
									.call(installing ? "functions.install" : "functions.update", { function_key: entry.function_key, version: target }, { silent: true })
									.then((r) => {
										changed = true;
										ui.Toast.success(
											installing
												? __("{0} installed", [entry.function_name])
												: __("{0} is now on {1}", [entry.function_name, (r && r.installed_version) || target])
										);
									}),
						},
					],
					on_close: () => on_close && on_close(changed),
				}).show();
				if (!diff.handler_registered) panel.set_action_disabled("go", true);
				return panel;
			})
			.catch((err) => {
				ui.Toast.error(err);
				on_close && on_close(false);
			});
	}

	// ---- settings editor ----------------------------------------------------------------------

	/**
	 * The values an installed function exposes (`functions.save_settings`), as the prototype's
	 * overlay form. Field types come from the function's own setting rows — Check, Select with
	 * choices, a number, or text — never from a hard-coded list.
	 */
	function edit_settings(entry, manifest, { on_close } = {}) {
		const rows = (manifest && manifest.settings) || [];
		let changed = false;
		if (!rows.length) {
			ui.Toast.info(__("This function has no settings."));
			on_close && on_close(false);
			return null;
		}
		const fields = rows.map((r) => {
			const raw = r.value != null && r.value !== "" ? r.value : r.default_value;
			const df = { key: r.key, label: __(r.label || r.key), hint: r.notes ? __(r.notes) : undefined };
			if (r.fieldtype === "Check") return Object.assign(df, { type: "toggle", value: cint(raw) });
			if (r.choices)
				return Object.assign(df, {
					type: "select",
					value: cstr(raw),
					options: cstr(r.choices)
						.split("\n")
						.map((v) => v.trim())
						.filter(Boolean)
						.map((v) => ({ value: v, label: __(v) })),
				});
			if (r.fieldtype === "Int" || r.fieldtype === "Float") return Object.assign(df, { type: "number", value: raw === "" || raw == null ? "" : Number(raw) });
			return Object.assign(df, { type: "text", value: cstr(raw) });
		});
		return new ui.OverlayPanel({
			type: "modal",
			width: "560px",
			title: __("Settings of {0}", [entry.function_name]),
			subtitle: entry.installed_version,
			subtitle_mono: true,
			sections: [{ cols: 1, fields }],
			actions: [
				{ key: "cancel", label: __("Cancel"), close: true },
				{
					key: "save",
					label: __("Save settings"),
					variant: "primary",
					requires_dirty: true,
					handler: (values) => {
						const payload = {};
						rows.forEach((r) => {
							const v = values[r.key];
							payload[r.key] = r.fieldtype === "Check" ? (v ? 1 : 0) : v == null ? "" : v;
						});
						return ui.call("functions.save_settings", { function_key: entry.function_key, values: payload }, { silent: true }).then(() => {
							changed = true;
							ui.Toast.success(__("Settings saved"));
						});
					},
				},
			],
			on_close: () => on_close && on_close(changed),
		}).show();
	}

	// ---- the dry-run preview ------------------------------------------------------------------

	/**
	 * A dry run instead of a mock-up: the prototype renders the reply from sample values, and this
	 * app can do better — `commands.test_command` routes one message through the real command
	 * router without storing or sending anything. The reply is drawn as the WhatsApp exchange it
	 * would be: the sender's message in, the function's reply out.
	 */
	function run_preview(entry, manifest, { on_close } = {}) {
		const commands = (entry.linked_commands || []).filter((c) => c.status === "Active");
		const example = cstr((manifest && manifest.example) || "") || (commands[0] || {}).code || "";
		const templates = ((manifest && manifest.outputs) || []).filter((o) => o.default_template);
		let $result = null;
		let $templates = null;
		const idle = () => {
			$result.empty();
			new ui.EmptyState({
				wrapper: $result,
				state: "empty",
				size: "sm",
				title: commands.length ? __("Run the preview to see the reply") : __("No active command to run"),
				description: commands.length
					? __("The message goes through the real router: the command word, the sender's party, the function's outputs.")
					: __("A command carries the word a sender writes. Link one to preview the reply."),
				action: commands.length ? undefined : { label: __("Open commands"), onclick: () => command_list(entry) },
			});
		};
		const render_result = (text, r) => {
			const tone = r.block_reason ? "warn" : r.matched ? "ok" : "muted";
			const label = r.block_reason
				? __("Blocked: {0}", [__(r.block_reason)])
				: r.matched
				? __("Matched {0}", [r.command])
				: __("No command matched this message");
			$result.html(`
				<div class="wa-fn-preview">
					<div class="wa-fn-preview__head">${kit.badge(label, tone)}${r.matched && cint(r.function_ms) ? `<span class="wa-fn-preview__ms sanad-tabular" dir="ltr">${esc(ms_text(r.function_ms))}</span>` : ""}</div>
					<div class="wa-fn-preview__thread">
						<div class="sanad-chat__row sanad-chat__row--in"><div class="sanad-chat__bubble" dir="auto">${ui.ChatThread.format(text)}</div></div>
						${
							r.reply_body
								? `<div class="sanad-chat__row sanad-chat__row--out"><div class="sanad-chat__bubble" dir="auto">${ui.ChatThread.format(r.reply_body)}</div></div>`
								: `<p class="wa-fn__muted">${esc(r.error || __("The function produced no reply."))}</p>`
						}
					</div>
				</div>`);
			ui.announce(label);
		};
		const panel = new ui.OverlayPanel({
			type: "modal",
			width: "680px",
			title: __("Preview {0}", [entry.function_name]),
			subtitle: __("Simulation — the function runs, nothing is stored and nothing is sent."),
			badge: { text: __("Simulation"), tone: "warn" },
			sections: [
				{
					cols: 2,
					fields: [
						{ key: "text", label: __("Message"), value: example, span: 2, required: true, hint: __("What the sender would write — the command word first, then its arguments.") },
						{ key: "phone", label: __("Sender number"), type: "phone", required: true, hint: __("The router reads the sender's party from this number.") },
						{
							key: "result",
							type: "html",
							span: 2,
							render: ($h) => {
								$result = $h;
								idle();
							},
						},
						{
							key: "templates",
							type: "html",
							span: 2,
							render: ($h) => {
								$templates = $h;
								if (!templates.length) return;
								$h.html(
									`<div class="wa-fn__head"><span class="wa-fn__head-label">${esc(__("Reply templates"))}</span></div>` +
										templates
											.map(
												(o) =>
													`<div class="wa-fn__output"><div class="wa-fn__output-head"><span class="wa-fn__output-name">${esc(__(o.label || o.output_key))}</span>${kit.badge(
														__(o.output_type || "Text"),
														"muted",
														{ dot: false }
													)}</div>${parts.code(o.default_template)}</div>`
											)
											.join("")
								);
							},
						},
					],
				},
			],
			actions: [
				{ key: "close", label: __("Close"), close: true },
				{
					key: "run",
					label: __("Run preview"),
					variant: "primary",
					icon: "send",
					handler: (values) => {
						const text = cstr(values.text).trim();
						const phone = ui.PhoneField.normalize(cstr(values.phone));
						if (!phone.valid) {
							panel.set_error("phone", __("Enter the sender's number in full, with its country code."));
							return false;
						}
						$result.html(ui.skeleton(1, { lines: 2 }));
						return ui
							.call("commands.test_command", { text, sender_phone: phone.phone_e164 }, { silent: true })
							.then((r) => render_result(text, r))
							.catch((err) => {
								$result.empty();
								new ui.EmptyState({ wrapper: $result, state: "error", size: "sm", description: err.message });
							})
							.then(() => false);
					},
				},
			],
			on_close: () => on_close && on_close(false),
		}).show();
		if (!commands.length) panel.set_action_disabled("run", true);
		// A real sender makes the preview honest: the router resolves the party from the number.
		ui.call("numbers.search_numbers", { page: 1, page_length: 1 }, { silent: true })
			.then((r) => {
				const row = ((r && r.rows) || [])[0];
				if (row && !cstr(panel.get_value("phone"))) {
					panel.set_value("phone", row.phone_e164);
					panel.mark_clean();
				}
			})
			.catch(() => {});
		void $templates;
		if (parts.bind_copy) parts.bind_copy();
		return panel;
	}

	// ---- the versions ---------------------------------------------------------------------------

	/** Every version the catalog holds, newest first, to pick one to move to. */
	function pick_version(entry, { on_pick, on_close } = {}) {
		const versions = (entry.versions || []).slice().sort((a, b) => version_cmp(b, a));
		const releases = entry.releases || {};
		let picked = false;
		return new ui.Drawer({
			mode: "choice",
			title: __("Versions of {0}", [entry.function_name]),
			choices: versions.map((v) => {
				const marks = [];
				if (v === entry.latest_version) marks.push(__("Latest"));
				if (v === entry.installed_version) marks.push(__("Installed"));
				const note = ((releases[v] || {}).changelog || (entry.changelog || {})[v] || "").trim();
				return {
					label: marks.length ? `${v} — ${marks.join(" · ")}` : v,
					description: note || __("No note for this version."),
					value: v,
					icon: v === entry.installed_version ? "es-line-check" : "es-line-tag",
				};
			}),
			on_choose: (v) => {
				picked = true;
				on_pick && on_pick(v);
			},
			on_close: () => !picked && on_close && on_close(false),
		}).show();
	}

	// ---- the function, as a document ---------------------------------------------------------

	/**
	 * The function itself (`docs/component/Function Detail.dc.html`) in the kit's document
	 * drawer: who it is (name, category, the two versions, its state), what it does and when to
	 * use it, the six facts, the manifest's variables · settings · outputs, the commands that
	 * run on it as themselves, the record's details, and every version as a timeline.
	 */
	class FunctionDrawer {
		constructor(page, entry) {
			this.page = page;
			this.entry = entry;
			this.key = entry.function_key;
		}

		show() {
			const e = this.entry;
			const manager = is_manager();
			this.state = new ui.EmptyState({ wrapper: $("<div>"), state: "loading" });
			return ui
				.call("functions.get_manifest", { function_key: e.function_key }, { silent: true })
				.catch(() => null)
				.then((manifest) => {
					this.manifest = manifest || { inputs: [], settings: [], outputs: [], installed: {} };
					return ui.meta.with_doctype("WhatsApp Command").catch(() => null);
				})
				.then(() => {
					this.drawer = new ui.Drawer({
						doctype: "WhatsApp Function",
						name: e.function_key,
						mode: "record",
						layout: "document",
						doc: this.document(),
						width: 640,
						title: __("Function"),
						open_link: false,
						fields: this.fields(),
						profile: {
							title: "function_name",
							lines: ["category", "version_line"],
							image: false,
							value: false,
							status: () => this.status(),
						},
						time_field: "installed_at",
						highlight: ($el) => this.render_about($el),
						highlight_label: __("What it does"),
						// a function that is not installed has no runs to count: only the version it offers
						facts: e.installed
							? [
									{ field: "calls_30d", icon: "es-line-zap" },
									{ field: "avg_ms_text", icon: "es-line-time", ltr: true },
									{ field: "commands_count", icon: "es-line-chat-alt" },
									{ field: "active_commands", icon: "es-line-success" },
									{ field: "installed_version", icon: "es-line-check", ltr: true },
									{ field: "latest_version", icon: "es-line-tag", ltr: true },
							  ]
							: [
									{ field: "latest_version", icon: "es-line-tag", ltr: true },
									{ field: "versions_count", icon: "es-line-time" },
							  ],
						relations: [],
						sections: [
							{ label: __("Variables it reads"), icon: "es-line-code", render: ($el) => this.render_inputs($el) },
							{ label: __("Settings"), icon: "es-line-settings", render: ($el) => this.render_settings($el) },
							{ label: __("Outputs"), icon: "es-line-chat", render: ($el) => this.render_outputs($el) },
							{ label: __("Linked commands"), icon: "es-line-chat-alt", render: ($el) => this.render_commands($el) },
						],
						details: ["source", "handler_text", "installed_by", "call_count", "error_count", "last_error"],
						activity: () => this.versions(),
						activity_label: __("Versions"),
						actions: this.actions(manager),
					});
					this.drawer.show();
					if (parts.bind_copy) parts.bind_copy();
					return this.drawer;
				});
		}

		hide() {
			if (this.drawer) this.drawer.destroy();
			this.drawer = null;
		}

		/** The row, read as a document: the scalars the identity, the facts and the details need. */
		document() {
			const e = this.entry;
			const m = this.manifest || {};
			const inst = m.installed || {};
			const linked = e.linked_commands || [];
			const version_line = !e.installed
				? __("Latest {0}", [e.latest_version || "—"])
				: e.update_available
				? __("Installed {0} · latest {1}", [e.installed_version, e.latest_version])
				: __("Version {0} · up to date", [e.installed_version]);
			return Object.assign({}, e, {
				doctype: "WhatsApp Function",
				name: e.function_key,
				category: e.category || __("Uncategorised"),
				version_line,
				calls_30d: cint(e.calls_30d),
				avg_ms_text: ms_text(inst.avg_ms != null ? inst.avg_ms : e.avg_ms),
				commands_count: linked.length,
				active_commands: linked.filter((c) => c.status === "Active").length,
				installed_version: e.installed_version || "",
				latest_version: e.latest_version || "",
				versions_count: (e.versions || []).length,
				handler_text: e.handler_registered ? __("Registered") : __("Missing"),
				installed_at: inst.installed_at || "",
				installed_by: inst.installed_by || "",
				call_count: e.installed ? cint(inst.call_count != null ? inst.call_count : e.call_count) : "",
				error_count: e.installed ? cint(inst.error_count != null ? inst.error_count : e.error_count) : "",
				last_error: inst.last_error || "",
			});
		}

		fields() {
			return [
				{ fieldname: "function_name", fieldtype: "Data", label: __("Function") },
				{ fieldname: "category", fieldtype: "Data", label: __("Category") },
				{ fieldname: "version_line", fieldtype: "Data", label: __("Version") },
				{ fieldname: "calls_30d", fieldtype: "Int", label: __("Calls (30d)") },
				{ fieldname: "avg_ms_text", fieldtype: "Data", label: __("Average run") },
				{ fieldname: "commands_count", fieldtype: "Int", label: __("Commands") },
				{ fieldname: "active_commands", fieldtype: "Int", label: __("Active") },
				{ fieldname: "installed_version", fieldtype: "Data", label: __("Installed version") },
				{ fieldname: "latest_version", fieldtype: "Data", label: __("Latest version") },
				{ fieldname: "versions_count", fieldtype: "Int", label: __("Versions") },
				{ fieldname: "source", fieldtype: "Data", label: __("Catalog source") },
				{ fieldname: "handler_text", fieldtype: "Data", label: __("Handler") },
				{ fieldname: "installed_at", fieldtype: "Datetime", label: __("Installed at") },
				{ fieldname: "installed_by", fieldtype: "Link", options: "User", label: __("Installed by") },
				{ fieldname: "call_count", fieldtype: "Int", label: __("Calls, all time") },
				{ fieldname: "error_count", fieldtype: "Int", label: __("Errors") },
				{ fieldname: "last_error", fieldtype: "Small Text", label: __("Last error") },
			];
		}

		/** The one badge beside the identity: what an operator asks first — does it run? */
		status() {
			const e = this.entry;
			if (!e.installed) return { label: __("Not installed"), colour: "gray" };
			if (e.status !== "Active") return { label: __("Inactive"), colour: "orange" };
			if (e.update_available) return { label: __("Update available"), colour: "orange" };
			return { label: __("Active"), colour: "green" };
		}

		/** What needs attention, then what the function does, when to use it, and who it serves. */
		render_about($el) {
			const e = this.entry;
			const m = this.manifest || {};
			const linked = (e.linked_commands || []).length;
			const alert = this.alert();
			const party = (m.party_types && m.party_types.length ? m.party_types : e.party_types) || [];
			const words = m.suggested_commands || [];
			$el.html(`
				${
					alert
						? `<div class="sanad-op__alert sanad-op__alert--${alert.tone}" role="${alert.tone === "danger" ? "alert" : "status"}">
								<span class="sanad-op__alert-title">${esc(alert.title)}</span>
								${alert.lines.map((l) => `<span class="sanad-op__alert-line">${esc(l)}</span>`).join("")}
							</div>`
						: ""
				}
				<p class="wa-fn__lede" dir="auto">${esc(e.description || __("No description in the catalog."))}</p>
				<div class="wa-fn__when">
					<span class="wa-fn__when-label">${esc(__("When to use it"))}</span>
					<span class="wa-fn__when-text" dir="auto">${esc(e.when_to_use || __("The catalog does not say when to use it."))}</span>
				</div>
				<div class="wa-fn__tags">
					<span class="wa-fn__tags-label">${esc(__("Who it serves"))}</span>
					${party.length ? parts.chips(party.map((t) => ({ icon: "es-line-customer", text: __(t) }))) : `<span class="wa-fn__muted">${esc(__("Any sender."))}</span>`}
				</div>
				${
					words.length
						? `<div class="wa-fn__tags">
								<span class="wa-fn__tags-label">${esc(__("Suggested command words"))}</span>
								<span class="wa-fn__pills">${words.map((w) => kit.badge(w, "muted", { dot: false })).join("")}</span>
							</div>`
						: ""
				}`);
			void linked;
		}

		alert() {
			const e = this.entry;
			const linked = (e.linked_commands || []).length;
			if (e.installed && e.update_available)
				return {
					tone: "warn",
					title: __("A newer version is available: {0}.", [e.latest_version]),
					lines: [__("Updating does not change the linked commands, their words or their permissions.")],
				};
			if (e.installed && e.status !== "Active")
				return {
					tone: "warn",
					title: __("This function is inactive."),
					lines: [
						linked
							? ui.plural(linked, {
									one: __("{0} linked command matches its text but will not run until it is activated."),
									other: __("{0} linked commands match their text but will not run until it is activated."),
							  })
							: __("No command is linked to it yet."),
					],
				};
			if (e.installed && !e.handler_registered)
				return {
					tone: "danger",
					title: __("No handler is registered for this function."),
					lines: [__("Its commands will not run until the app that provides it is installed on this site.")],
				};
			if (!e.installed)
				return {
					tone: "info",
					title: __("In the catalog, not installed on this site."),
					lines: [__("Installing copies its settings and outputs here; nothing is sent.")],
				};
			return null;
		}

		/** A list block: rows the manifest declares, or one sentence when it declares none. */
		rows($el, rows, render, empty_text) {
			if (!rows || !rows.length) {
				$el.html(`<p class="wa-fn__muted">${esc(empty_text)}</p>`);
				return;
			}
			$el.html(`<ul class="wa-fn__rows">${rows.map(render).join("")}</ul>`);
		}

		render_inputs($el) {
			const inputs = (this.manifest || {}).inputs || [];
			this.rows(
				$el,
				inputs,
				(i) => `<li class="wa-fn__row">
					<div class="wa-fn__row-head">
						<code class="wa-fn__token" dir="ltr">${esc(i.key)}</code>
						<span class="wa-fn__row-label">${esc(__(i.label || i.key))}</span>
						<span class="wa-fn__row-end">
							${i.required ? kit.badge(__("Required"), "warn", { dot: false }) : ""}
							${i.type ? `<code class="wa-fn__type" dir="ltr">${esc(i.type)}${i.rest ? " …" : ""}</code>` : ""}
						</span>
					</div>
					${i.notes ? `<span class="wa-fn__row-note" dir="auto">${esc(__(i.notes))}</span>` : ""}
				</li>`,
				__("This function takes no variables: the command word alone runs it.")
			);
		}

		render_settings($el) {
			const e = this.entry;
			const rows = (this.manifest || {}).settings || [];
			this.rows(
				$el,
				rows,
				(s) => {
					const value = s.value != null && s.value !== "" ? s.value : s.default_value;
					const shown = s.fieldtype === "Check" ? (cint(value) ? __("Yes") : __("No")) : cstr(value) || "—";
					const is_default = s.value == null || s.value === "" || cstr(s.value) === cstr(s.default_value);
					return `<li class="wa-fn__row">
					<div class="wa-fn__row-head">
						<span class="wa-fn__row-label wa-fn__row-label--strong">${esc(__(s.label || s.key))}</span>
						<span class="wa-fn__row-end">
							${kit.badge(shown, is_default ? "muted" : "pri", { dot: false })}
							${e.installed && !is_default ? `<span class="wa-fn__muted">${esc(__("Default: {0}", [s.fieldtype === "Check" ? (cint(s.default_value) ? __("Yes") : __("No")) : s.default_value || "—"]))}</span>` : ""}
						</span>
					</div>
					${s.notes ? `<span class="wa-fn__row-note" dir="auto">${esc(__(s.notes))}</span>` : ""}
					${s.choices ? `<code class="wa-fn__choices" dir="ltr">${esc(cstr(s.choices).split("\n").filter(Boolean).join(" · "))}</code>` : ""}
				</li>`;
				},
				__("This function has no settings.")
			);
			if (e.installed && is_manager() && rows.length) {
				$(`<button type="button" class="wa-fn__link">${ui.icon("es-line-edit", "xs")}<span>${esc(__("Edit settings"))}</span></button>`)
					.on("click", () => this.page.edit_settings(this.entry, this.manifest))
					.appendTo($el);
			}
		}

		render_outputs($el) {
			const outputs = (this.manifest || {}).outputs || [];
			if (!outputs.length) {
				$el.html(`<p class="wa-fn__muted">${esc(__("This function writes no output."))}</p>`);
				return;
			}
			$el.html(
				outputs
					.map((o) => {
						const vars = cstr(o.variables)
							.split(",")
							.map((v) => v.trim())
							.filter(Boolean);
						return `<div class="wa-fn__output">
							<div class="wa-fn__output-head">
								<span class="wa-fn__output-name">${esc(__(o.label || o.output_key))}</span>
								<code class="wa-fn__token" dir="ltr">${esc(o.output_key)}</code>
								${kit.badge(__(o.output_type || "Text"), o.output_type === "Document" ? "info" : "muted", { dot: false })}
							</div>
							${o.notes ? `<span class="wa-fn__row-note" dir="auto">${esc(__(o.notes))}</span>` : ""}
							${o.default_template ? parts.code(o.default_template) : ""}
							${o.file_name_template ? `<div class="wa-fn__kv"><span class="wa-fn__kv-label">${esc(__("File name"))}</span><code class="wa-fn__token" dir="ltr">${esc(o.file_name_template)}</code></div>` : ""}
							${o.condition ? `<div class="wa-fn__kv"><span class="wa-fn__kv-label">${esc(__("Sent when"))}</span><code class="wa-fn__token" dir="ltr">${esc(o.condition)}</code></div>` : ""}
							${vars.length ? `<div class="wa-fn__kv"><span class="wa-fn__kv-label">${esc(__("Variables"))}</span><span class="wa-fn__pills">${vars.map((v) => kit.badge(v, "muted", { dot: false })).join("")}</span></div>` : ""}
						</div>`;
					})
					.join("")
			);
		}

		/** Every command that runs on this function, drawn as the command it is. */
		render_commands($el) {
			const e = this.entry;
			const commands = e.linked_commands || [];
			if (!commands.length) {
				new ui.EmptyState({
					wrapper: $el,
					state: "empty",
					size: "sm",
					title: __("No command runs this function yet"),
					description: __("A command carries the word a sender writes; the function is what it does."),
					action: is_manager() && e.installed ? { label: __("Link a command"), onclick: () => this.page.new_command(e) } : undefined,
				});
				return;
			}
			const $list = $('<div class="sanad-ent-list sanad-ent-list--row"></div>').appendTo($el);
			commands.forEach((c) => {
				const doc = Object.assign({}, c, { doctype: "WhatsApp Command" });
				const $item = $('<div class="sanad-ent-list__item"></div>').appendTo($list);
				ui.Render.mount($item, doc, {
					doctype: "WhatsApp Command",
					kind: "generic",
					density: "row",
					vm: { initials: "", icon: "es-line-chat-alt" },
					profile: {
						title: "code",
						title_ltr: false,
						lines: [{ field: "run_count_30d", value: (d) => ui.plural(cint(d.run_count_30d), { one: __("{0} run in 30 days"), other: __("{0} runs in 30 days") }) }],
						value: false,
						facts: [],
						status: () => ({ label: __(c.status || "Inactive"), colour: c.status === "Active" ? "green" : "gray" }),
					},
					href: null,
					on_click: () => frappe.set_route("Form", "WhatsApp Command", c.name),
				});
			});
			$(`<button type="button" class="wa-fn__link">${ui.icon("es-line-chat-alt", "xs")}<span>${esc(__("Open in commands"))}</span></button>`)
				.on("click", () => command_list(e))
				.appendTo($el);
		}

		/** The change log as the timeline it is: newest first, the installed one marked. */
		versions() {
			const e = this.entry;
			const releases = e.releases || {};
			return (e.versions || [])
				.slice()
				.sort((a, b) => version_cmp(b, a))
				.map((v) => {
					const marks = [];
					if (v === e.latest_version) marks.push(__("Latest"));
					if (v === e.installed_version) marks.push(__("Installed"));
					const rel = releases[v] || {};
					return {
						title: marks.length ? `${v} — ${marks.join(" · ")}` : v,
						description: (rel.changelog || (e.changelog || {})[v] || "").trim() || __("No note for this version."),
						time: rel.released || "",
						icon: v === e.installed_version ? "es-line-check" : v === e.latest_version ? "es-line-tag" : "es-line-time",
						tone: v === e.installed_version ? "green" : v === e.latest_version && e.update_available ? "orange" : "gray",
					};
				});
		}

		/** Two or three verbs in the footer; everything else behind "More". */
		actions(manager) {
			const e = this.entry;
			const page = this.page;
			const linked = (e.linked_commands || []).length;
			const list = [];
			if (manager && !e.installed)
				list.push({ label: __("Install"), icon: "es-line-download", primary: true, handler: () => page.change(e, null) });
			if (manager && e.installed && e.update_available)
				list.push({ label: __("Update to {0}", [e.latest_version]), icon: "es-line-upload", primary: true, handler: () => page.change(e, e.latest_version) });
			if (manager && e.installed) list.push({ label: __("Preview"), icon: "es-line-zap", handler: () => page.preview(e, this.manifest) });
			list.push({
				label: linked ? __("Linked commands") : __("Link a command"),
				icon: "es-line-chat-alt",
				handler: () => (linked || !manager || !e.installed ? command_list(e) : page.new_command(e)),
			});
			if (manager && e.installed) {
				list.push({
					label: e.status === "Active" ? __("Deactivate") : __("Activate"),
					icon: e.status === "Active" ? "es-line-close-circle" : "es-line-success",
					menu: true,
					handler: () => page.set_status(e, e.status === "Active" ? "Inactive" : "Active"),
				});
				list.push({ label: __("Edit settings"), icon: "es-line-settings", menu: true, handler: () => page.edit_settings(e, this.manifest) });
				if ((e.versions || []).length > 1)
					list.push({ label: __("Another version…"), icon: "es-line-tag", menu: true, handler: () => page.pick_version(e) });
				list.push({ label: __("Remove"), icon: "es-line-delete", menu: true, danger: true, handler: () => page.remove(e) });
			}
			return list;
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
		{ fieldname: "category", label: __("Category"), width: 108, sortable: true, format: (v) => esc(v || "") },
		{
			fieldname: "installed_version",
			label: __("Version"),
			width: 84,
			sortable: true,
			format: (v, doc) => `<span class="sanad-tabular" dir="ltr">${esc(v || doc.latest_version || "")}</span>`,
		},
		{ fieldname: "update_available", label: __("Update"), width: 112, sortable: true, format: (v, doc) => (doc.installed ? update_badge(doc) : "") },
		{ fieldname: "commands_count", label: __("Linked commands"), type: "number", align: "end", width: 104, sortable: true, format: (v) => fmt_int(v) },
		{ fieldname: "calls_30d", label: __("Calls (30d)"), type: "number", align: "end", width: 96, sortable: true, format: (v) => fmt_int(v) },
		{ fieldname: "avg_ms", label: __("Average run"), type: "number", align: "end", width: 98, sortable: true, hidden_xs: true, format: (v) => (cint(v) ? esc(ms_text(v)) : "") },
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
			this.state = new ui.EmptyState({ wrapper: this.$body, state: "loading", rows: 6 });
			this.loaded = this.load();
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
						title: __("Could not load the catalog"),
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
				categories: Array.from(new Set(all.map((e) => e.category).filter(Boolean))).length,
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
			this.header = new ui.PageHeader({
				wrapper: this.$head,
				title: __("Functions Center"),
				description: __("A function is the logic behind a command. Review its versions here, install it and keep it current."),
				secondary: [
					{ label: __("Commands"), icon: "es-line-chat-alt", count: this.commands_total, handler: () => command_list(null) },
				],
				banner: () => this.banner(),
				blocks: [{ key: "readings", render: ($el) => this.render_cards($el) }],
			});
			$(`<span class="wa-functions__mark" aria-hidden="true">${ui.icon("es-line-code", "md")}</span>`).prependTo(this.header.$el.find(".sanad-pagehead__row"));
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
								note: ui.plural(c.categories, { one: __("{0} category"), other: __("{0} categories") }),
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
								note: c.outdated ? __("Newer versions ready to install") : __("Every function is on its latest version"),
								action: c.outdated ? "show_updates" : undefined,
							},
						],
					},
				],
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
					text: ui.plural(missing.length, {
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
			this.filter_bar = new ui.FilterBar({
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
					{ fieldname: "category", type: "select", label: __("Category"), options: categories.map((v) => ({ value: v, label: __(v) })) },
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
					const hay = [e.function_name, e.function_key, e.category, e.description, e.when_to_use].map(cstr).join(" ").toLowerCase();
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
					mobile_columns: ["function_name", "category", "installed_version", "update_available", "commands_count", "calls_30d", "status", "installed"],
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
						title: this.entries.length ? __("No function matches") : __("The catalog is empty"),
						description: this.entries.length
							? __("Change the search or the filters to see more of the catalog.")
							: __("No function is published for this site yet. A function comes from an installed app that ships a catalog file."),
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
			this.detail = new FunctionDrawer(this, entry);
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
		change(entry, version) {
			return confirm_change(entry, version, { on_close: (changed) => this.back(changed) });
		}

		preview(entry, manifest) {
			return run_preview(entry, manifest, { on_close: () => this.back(false) });
		}

		edit_settings(entry, manifest) {
			return edit_settings(entry, manifest, { on_close: (changed) => this.back(changed) });
		}

		pick_version(entry) {
			return pick_version(entry, {
				on_pick: (v) => (v === entry.installed_version ? this.back(false) : this.change(entry, v)),
				on_close: () => this.back(false),
			});
		}

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
				message: __("The installed record, its settings and its outputs are deleted. The catalog keeps the function, so it can be installed again."),
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
					message: __("Each function moves to its latest version. Commands, their words and their permissions stay as they are."),
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
			else ui.Toast.info(__("Function {0} is not in the catalog.", [key]));
		});
	};
})();

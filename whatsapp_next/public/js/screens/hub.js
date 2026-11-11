// The WhatsApp hub window (owner, 2026-10-29): the ready-made functions, commands, alerts or
// notifications the platform publishes, opened from that screen's «Hub» button on its own type.
// A list (searchable) on one side, the chosen entry with all its data on the other; each entry
// says whether this site has it — «Not installed», «Update available», «Installed» — and installs
// or updates it here. Data through `hub.*` (services/hub.py); nothing is kept in the page.

frappe.provide("whatsapp_next.hub");

(function () {
	const ui = whatsapp.ui;
	const escape_html = (v) => ui.escape(v == null ? "" : v);

	const TITLES = {
		Function: () => __("Functions hub"),
		Command: () => __("Commands hub"),
		Alert: () => __("Alerts hub"),
		Notification: () => __("Notifications hub"),
		Template: () => __("Templates hub"),
	};
	const STATES = {
		not_installed: () => ({ label: __("Not installed", null, "Hub"), colour: "gray" }),
		update_available: () => ({ label: __("Update available", null, "Hub"), colour: "orange" }),
		installed: () => ({ label: __("Installed", null, "Hub"), colour: "green" }),
	};
	// a description the hub wrote from the record ("Sales Invoice · Submit"): each part translated
	const describe = (text) => (text || "").split(" · ").map((part) => __(part.trim())).join(" · ");
	const badge = (state) => ui.StatusBadge.html(STATES[state] ? STATES[state]() : { label: state, colour: "gray" });

	class HubWindow {
		constructor(hub_type, { on_installed } = {}) {
			this.hub_type = hub_type;
			this.on_installed = on_installed;
			this.txt = "";
			this.rows = [];
			this.current = null;
			this.dialog = new frappe.ui.Dialog({
				title: TITLES[hub_type] ? TITLES[hub_type]() : __("Hub"),
				size: "extra-large",
				fields: [{ fieldtype: "HTML", fieldname: "body" }],
			});
			this.$body = this.dialog.get_field("body").$wrapper.addClass("whatsapp-hub");
			this.$body.html(`
				<div class="whatsapp-hub__layout">
					<section class="whatsapp-hub__list" aria-label="${escape_html(__("Entries", null, "Hub"))}">
						<input type="search" class="whatsapp-input whatsapp-hub__search" placeholder="${escape_html(__("Search the hub…"))}" aria-label="${escape_html(__("Search the hub"))}">
						<div class="whatsapp-hub__rows" role="listbox" aria-label="${escape_html(__("Entries", null, "Hub"))}"></div>
					</section>
					<section class="whatsapp-hub__detail" aria-live="polite"></section>
				</div>`);
			this.$layout = this.$body.find(".whatsapp-hub__layout");
			this.$rows = this.$body.find(".whatsapp-hub__rows");
			this.$detail = this.$body.find(".whatsapp-hub__detail");
			this.$body.find(".whatsapp-hub__search").on(
				"input",
				ui.debounce((e) => {
					this.txt = e.target.value.trim();
					this.load_hub_entries();
				}, 300)
			);
			// on a narrow window the list and the details take turns: a pick opens the details, Back returns
			this.$rows.on("click", "[data-entry]", (e) => {
				this.$layout.addClass("is-detail");
				this.show($(e.currentTarget).attr("data-entry"));
			});
			this.$detail.on("click", ".whatsapp-hub__back", () => {
				this.$layout.removeClass("is-detail");
				this.$rows.find(".is-on").trigger("focus");
			});
			this.dialog.show();
			this.load_hub_entries();
		}

		load_hub_entries() {
			const state = new ui.EmptyState({ wrapper: this.$rows, state: "loading", rows: 5, size: "sm" });
			return ui
				.call("hub.list_entries", { hub_type: this.hub_type, txt: this.txt || null }, { silent: true })
				.then((rows) => {
					this.rows = rows || [];
					if (!this.rows.length) {
						state.empty({
							title: this.txt ? __("Nothing matches this search") : __("The hub has nothing of this kind yet"),
						});
						this.$detail.empty();
						return;
					}
					this.render_rows();
					this.show((this.current && this.rows.find((r) => r.name === this.current) ? this.current : this.rows[0].name));
				})
				.catch((err) => state.error(err, { action: { label: __("Retry"), onclick: () => this.load_hub_entries() } }));
		}

		render_rows() {
			this.$rows.html(
				this.rows
					.map(
						(r) => `<button type="button" class="whatsapp-hub__row${r.name === this.current ? " is-on" : ""}" data-entry="${escape_html(r.name)}" role="option" aria-selected="${r.name === this.current}">
							<span class="whatsapp-hub__row-text"><b>${escape_html(r.hub_name)}</b>${r.description ? `<em>${escape_html(describe(r.description))}</em>` : ""}</span>
							${badge(r.state)}
						</button>`
					)
					.join("")
			);
		}

		show(name) {
			this.current = name;
			this.render_rows();
			const state = new ui.EmptyState({ wrapper: this.$detail, state: "loading", rows: 6, size: "sm" });
			return ui
				.call("hub.get_entry", { name }, { silent: true })
				.then((e) => {
					if (this.current !== name) return;
					state.hide();
					this.render_detail(e);
				})
				.catch((err) => state.error(err, { action: { label: __("Retry"), onclick: () => this.show(name) } }));
		}

		render_detail(e) {
			const verb = { not_installed: __("Install", null, "Hub"), update_available: __("Update"), installed: __("Install again") }[e.state] || __("Install", null, "Hub");
			// what an entry sets up, readably: empty values left out, a table (recipients, inputs)
			// one line per row, the words a select stores in the user's language
			const empty = (v) => v == null || v === "" || (Array.isArray(v) && !v.length);
			const translate_value_text = (v) => (typeof v === "string" ? __(v) : String(v));
			const row_line = (r) =>
				Object.entries(r || {})
					.filter(([, v]) => !empty(v) && typeof v !== "object")
					.map(([, v]) => translate_value_text(v))
					.join(" · ");
			const value_html = (v) =>
				Array.isArray(v)
					? `<ul class="whatsapp-hub__table">${v.map((r) => `<li dir="auto">${escape_html(typeof r === "object" ? row_line(r) : translate_value_text(r))}</li>`).join("")}</ul>`
					: typeof v === "object"
					? escape_html(row_line(v))
					: escape_html(translate_value_text(v));
			const fields = Object.entries(e.payload || {})
				.filter(([k, v]) => !["script", "requires", "name"].includes(k) && !empty(v))
				.map(([k, v]) => `<div${Array.isArray(v) ? ' class="is-wide"' : ""}><dt>${escape_html((e.labels || {})[k] || k)}</dt><dd dir="auto">${value_html(v)}</dd></div>`)
				.join("");
			this.$detail.html(`
				<button type="button" class="btn btn-xs btn-default whatsapp-hub__back">${escape_html(__("Back"))}</button>
				<header class="whatsapp-hub__head">
					<div>
						<h3>${escape_html(e.hub_name)}</h3>
						<p>${badge(e.state)}${e.local ? ` <span class="whatsapp-hub__muted">${escape_html(__("Here as {0}", [e.local]))}</span>` : ""}</p>
					</div>
					<span class="whatsapp-settings__btns">
						${e.local ? `<button type="button" class="btn btn-sm btn-default" data-act="open">${escape_html(__("Open form"))}</button>` : ""}
						<button type="button" class="btn btn-sm btn-primary" data-act="install">${escape_html(verb)}</button>
					</span>
				</header>
				${e.description ? `<p class="whatsapp-hub__desc">${escape_html(describe(e.description))}</p>` : ""}
				<dl class="whatsapp-hub__facts">
					<div><dt>${escape_html(__("Type"))}</dt><dd>${escape_html(__(e.hub_type))}</dd></div>
					<div><dt>${escape_html(__("Last changed"))}</dt><dd>${escape_html(frappe.datetime.str_to_user(e.modified))}</dd></div>
					<div><dt>${escape_html(__("Checksum", null, "Hub"))}</dt><dd dir="ltr" class="whatsapp-kit-tabular">${escape_html(e.checksum)}</dd></div>
				</dl>
				${["Template", "Notification", "Alert"].includes(e.hub_type) ? `<h4 class="whatsapp-hub__sub">${escape_html(__("How it is sent"))}</h4><div class="whatsapp-hub__preview" data-slot="preview"></div>` : ""}
				${fields ? `<h4 class="whatsapp-hub__sub">${escape_html(__("What it sets up"))}</h4><dl class="whatsapp-hub__fields">${fields}</dl>` : ""}
				${
					e.payload && e.payload.script
						? `<h4 class="whatsapp-hub__sub">${escape_html(__("The code it runs on this site"))}</h4><pre class="whatsapp-hub__code" dir="ltr">${escape_html(e.payload.script)}</pre>`
						: ""
				}
				${
					["Alert", "Notification"].includes(e.hub_type) && e.state === "not_installed"
						? `<p class="whatsapp-hub__muted">${escape_html(__("It is installed switched off: turn it on when its recipients and device are right."))}</p>`
						: e.hub_type === "Command" && e.state === "not_installed"
						? `<p class="whatsapp-hub__muted">${escape_html(__("It is installed stopped: set who may use it (groups, account types), then turn it on."))}</p>`
						: ""
				}`);
			this.$detail.find("[data-act=install]").on("click", () => this.install_hub_entry(e));
			this.render_entry_preview(e);
			this.$detail.find("[data-act=open]").on("click", () => {
				this.dialog.hide();
				frappe.set_route("Form", { Function: "WhatsApp Function", Template: "WhatsApp Template", Command: "WhatsApp Command", Alert: "WhatsApp Notification Alert", Notification: "WhatsApp Notification" }[e.hub_type], e.local);
			});
		}

		/** The message as the recipient gets it on WhatsApp: the text rendered (on the server, as
		 *  the send renders it) against the latest record of its document type here, in WhatsApp's
		 *  formatting. A notification or alert without text of its own shows the template it needs. */
		async render_entry_preview(e) {
			const $slot = this.$detail.find("[data-slot=preview]");
			if (!$slot.length) return;
			const p = e.payload || {};
			let body = e.hub_type === "Template" ? p.body : p.message;
			let sample_from = e.hub_type === "Template" ? p : null;
			let doctype = e.hub_type === "Template" ? p.reference_doctype : p.document_type;
			if (!body && p.template && (p.requires || []).length) {
				try {
					const tpl = await ui.call("hub.get_entry", { name: p.requires[0] }, { silent: true });
					body = ((tpl && tpl.payload) || {}).body;
					sample_from = (tpl && tpl.payload) || null;
					doctype = doctype || ((tpl && tpl.payload) || {}).reference_doctype;
				} catch (err) {
					body = null;
				}
			}
			if (this.current !== e.name) return;
			if (!body) {
				$slot.html(`<p class="whatsapp-hub__muted">${escape_html(e.hub_type === "Alert" ? __("It sends the report itself, with no text of its own.") : __("Nothing to preview: it has no text."))}</p>`);
				return;
			}
			$slot.html(`<div class="whatsapp-hub__chat"><div class="whatsapp-hub__bubble" aria-busy="true"><span class="whatsapp-hub__muted">${escape_html(__("Preparing the preview…"))}</span></div></div>`);
			let r;
			try {
				// the template's own sample values fill what no readable record gives
				let sample = (sample_from || {}).sample_context;
				try {
					sample = typeof sample === "string" && sample.trim() ? JSON.parse(sample) : sample || null;
				} catch (err) {
					sample = null;
				}
				r = await ui.call("templates.preview", { body, reference_doctype: doctype || null, sample_context: sample }, { silent: true });
			} catch (err) {
				r = { body: "", errors: [(err && err.message) || __("The preview could not be rendered.")] };
			}
			if (this.current !== e.name) return;
			// no record it could read (a permission, an empty site): the text as written, its
			// variables visible, rather than a message with holes in it
			const text = (r && r.errors && r.errors.length) || !(r && r.body) ? body : r.body;
			const format = ui.ChatThread && ui.ChatThread.format_whatsapp_text ? ui.ChatThread.format_whatsapp_text : (t) => escape_html(t).replace(/\r?\n/g, "<br>");
			const attachment = (p.message_type || "Text") !== "Text" || cint(p.attach_print) || (e.hub_type === "Alert" && p.content_type === "Report");
			$slot.html(`
				<div class="whatsapp-hub__chat">
					<div class="whatsapp-hub__bubble">
						${attachment ? `<span class="whatsapp-hub__file">${ui.inline_icon_html ? ui.inline_icon_html("attach", "xs") : ""} ${escape_html(e.hub_type === "Alert" ? __("The report, as a file") : __("The document, as a file"))}</span>` : ""}
						<div class="whatsapp-hub__text" dir="auto">${format(text)}</div>
						<span class="whatsapp-hub__time" dir="ltr">${escape_html(frappe.datetime.now_time().slice(0, 5))} ✓✓</span>
					</div>
				</div>
				<p class="whatsapp-hub__muted">${escape_html(
					(r && r.errors && r.errors.length)
						? __("Shown as written: {0}", [r.errors[0]])
						: doctype
						? __("Filled from the latest {0} on this site.", [__(doctype)])
						: __("As it is sent.")
				)}</p>`);
		}

		install_hub_entry(e) {
			const call_hub_install = () =>
				ui
					.call("hub.install", { name: e.name }, { freeze: true })
					.then((r) => {
						ui.Toast.success(r.created ? __("Installed", null, "Hub") : __("Updated"));
						if (typeof this.on_installed === "function") this.on_installed(r);
						return this.load_hub_entries();
					})
					.catch((err) => ui.Toast.error(err));
			if (e.hub_type === "Function") {
				// code that will run here: said before it is installed
				return frappe.confirm(escape_html(__("This installs code that runs on this site, as shown under «The code it runs on this site». Continue?")), call_hub_install);
			}
			call_hub_install();
		}
	}

	/** Open the hub on one type: "Function", "Command", "Alert" or "Notification". */
	whatsapp_next.hub.open = (hub_type, opts) => new HubWindow(hub_type, opts);
})();

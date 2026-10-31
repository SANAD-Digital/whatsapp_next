// The WhatsApp hub window (owner, 2026-10-29): the ready-made functions, commands, alerts or
// notifications the platform publishes, opened from that screen's «Hub» button on its own type.
// A list (searchable) on one side, the chosen entry with all its data on the other; each entry
// says whether this site has it — «Not installed», «Update available», «Installed» — and installs
// or updates it here. Data through `hub.*` (services/hub.py); nothing is kept in the page.

frappe.provide("whatsapp_next.hub");

(function () {
	const ui = sanad.ui;
	const esc = (v) => ui.escape(v == null ? "" : v);

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
			this.$body = this.dialog.get_field("body").$wrapper.addClass("wa-hub");
			this.$body.html(`
				<div class="wa-hub__layout">
					<section class="wa-hub__list" aria-label="${esc(__("Entries", null, "Hub"))}">
						<input type="search" class="wa-input wa-hub__search" placeholder="${esc(__("Search the hub…"))}" aria-label="${esc(__("Search the hub"))}">
						<div class="wa-hub__rows" role="listbox" aria-label="${esc(__("Entries", null, "Hub"))}"></div>
					</section>
					<section class="wa-hub__detail" aria-live="polite"></section>
				</div>`);
			this.$rows = this.$body.find(".wa-hub__rows");
			this.$detail = this.$body.find(".wa-hub__detail");
			this.$body.find(".wa-hub__search").on(
				"input",
				ui.debounce((e) => {
					this.txt = e.target.value.trim();
					this.load();
				}, 300)
			);
			this.$rows.on("click", "[data-entry]", (e) => this.show($(e.currentTarget).attr("data-entry")));
			this.dialog.show();
			this.load();
		}

		load() {
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
				.catch((err) => state.error(err, { action: { label: __("Retry"), onclick: () => this.load() } }));
		}

		render_rows() {
			this.$rows.html(
				this.rows
					.map(
						(r) => `<button type="button" class="wa-hub__row${r.name === this.current ? " is-on" : ""}" data-entry="${esc(r.name)}" role="option" aria-selected="${r.name === this.current}">
							<span class="wa-hub__row-text"><b>${esc(r.hub_name)}</b>${r.description ? `<em>${esc(describe(r.description))}</em>` : ""}</span>
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
			const text = (v) => (typeof v === "string" ? __(v) : String(v));
			const row_line = (r) =>
				Object.entries(r || {})
					.filter(([, v]) => !empty(v) && typeof v !== "object")
					.map(([, v]) => text(v))
					.join(" · ");
			const value_html = (v) =>
				Array.isArray(v)
					? `<ul class="wa-hub__table">${v.map((r) => `<li dir="auto">${esc(typeof r === "object" ? row_line(r) : text(r))}</li>`).join("")}</ul>`
					: typeof v === "object"
					? esc(row_line(v))
					: esc(text(v));
			const fields = Object.entries(e.payload || {})
				.filter(([k, v]) => !["script", "requires", "name"].includes(k) && !empty(v))
				.map(([k, v]) => `<div${Array.isArray(v) ? ' class="is-wide"' : ""}><dt>${esc((e.labels || {})[k] || k)}</dt><dd dir="auto">${value_html(v)}</dd></div>`)
				.join("");
			this.$detail.html(`
				<header class="wa-hub__head">
					<div>
						<h3>${esc(e.hub_name)}</h3>
						<p>${badge(e.state)}${e.local ? ` <span class="wa-hub__muted">${esc(__("Here as {0}", [e.local]))}</span>` : ""}</p>
					</div>
					<span class="wa-settings__btns">
						${e.local ? `<button type="button" class="btn btn-sm btn-default" data-act="open">${esc(__("Open form"))}</button>` : ""}
						<button type="button" class="btn btn-sm btn-primary" data-act="install">${esc(verb)}</button>
					</span>
				</header>
				${e.description ? `<p class="wa-hub__desc">${esc(describe(e.description))}</p>` : ""}
				<dl class="wa-hub__facts">
					<div><dt>${esc(__("Type"))}</dt><dd>${esc(__(e.hub_type))}</dd></div>
					<div><dt>${esc(__("Last changed"))}</dt><dd>${esc(frappe.datetime.str_to_user(e.modified))}</dd></div>
					<div><dt>${esc(__("Checksum", null, "Hub"))}</dt><dd dir="ltr" class="sanad-tabular">${esc(e.checksum)}</dd></div>
				</dl>
				${["Template", "Notification", "Alert"].includes(e.hub_type) ? `<h4 class="wa-hub__sub">${esc(__("How it is sent"))}</h4><div class="wa-hub__preview" data-slot="preview"></div>` : ""}
				${fields ? `<h4 class="wa-hub__sub">${esc(__("What it sets up"))}</h4><dl class="wa-hub__fields">${fields}</dl>` : ""}
				${
					e.payload && e.payload.script
						? `<h4 class="wa-hub__sub">${esc(__("The code it runs on this site"))}</h4><pre class="wa-hub__code" dir="ltr">${esc(e.payload.script)}</pre>`
						: ""
				}
				${
					["Alert", "Notification"].includes(e.hub_type) && e.state === "not_installed"
						? `<p class="wa-hub__muted">${esc(__("It is installed switched off: turn it on when its recipients and device are right."))}</p>`
						: e.hub_type === "Command" && e.state === "not_installed"
						? `<p class="wa-hub__muted">${esc(__("It is installed stopped: set who may use it (groups, account types), then turn it on."))}</p>`
						: ""
				}`);
			this.$detail.find("[data-act=install]").on("click", () => this.install(e));
			this.preview(e);
			this.$detail.find("[data-act=open]").on("click", () => {
				this.dialog.hide();
				frappe.set_route("Form", { Function: "WhatsApp Function", Template: "WhatsApp Template", Command: "WhatsApp Command", Alert: "WhatsApp Notification Alert", Notification: "WhatsApp Notification" }[e.hub_type], e.local);
			});
		}

		/** The message as the recipient gets it on WhatsApp: the text rendered (on the server, as
		 *  the send renders it) against the latest record of its document type here, in WhatsApp's
		 *  formatting. A notification or alert without text of its own shows the template it needs. */
		async preview(e) {
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
				$slot.html(`<p class="wa-hub__muted">${esc(e.hub_type === "Alert" ? __("It sends the report itself, with no text of its own.") : __("Nothing to preview: it has no text."))}</p>`);
				return;
			}
			$slot.html(`<div class="wa-hub__chat"><div class="wa-hub__bubble" aria-busy="true"><span class="wa-hub__muted">${esc(__("Preparing the preview…"))}</span></div></div>`);
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
			const format = ui.ChatThread && ui.ChatThread.format ? ui.ChatThread.format : (t) => esc(t).replace(/\r?\n/g, "<br>");
			const attachment = (p.message_type || "Text") !== "Text" || cint(p.attach_print) || (e.hub_type === "Alert" && p.content_type === "Report");
			$slot.html(`
				<div class="wa-hub__chat">
					<div class="wa-hub__bubble">
						${attachment ? `<span class="wa-hub__file">${ui.ico ? ui.ico("attach", "xs") : ""} ${esc(e.hub_type === "Alert" ? __("The report, as a file") : __("The document, as a file"))}</span>` : ""}
						<div class="wa-hub__text" dir="auto">${format(text)}</div>
						<span class="wa-hub__time" dir="ltr">${esc(frappe.datetime.now_time().slice(0, 5))} ✓✓</span>
					</div>
				</div>
				<p class="wa-hub__muted">${esc(
					(r && r.errors && r.errors.length)
						? __("Shown as written: {0}", [r.errors[0]])
						: doctype
						? __("Filled from the latest {0} on this site.", [__(doctype)])
						: __("As it is sent.")
				)}</p>`);
		}

		install(e) {
			const run = () =>
				ui
					.call("hub.install", { name: e.name }, { freeze: true })
					.then((r) => {
						ui.Toast.success(r.created ? __("Installed", null, "Hub") : __("Updated"));
						if (typeof this.on_installed === "function") this.on_installed(r);
						return this.load();
					})
					.catch((err) => ui.Toast.error(err));
			if (e.hub_type === "Function") {
				// code that will run here: said before it is installed
				return frappe.confirm(esc(__("This installs code that runs on this site, as shown under «The code it runs on this site». Continue?")), run);
			}
			run();
		}
	}

	/** Open the hub on one type: "Function", "Command", "Alert" or "Notification". */
	whatsapp_next.hub.open = (hub_type, opts) => new HubWindow(hub_type, opts);
})();

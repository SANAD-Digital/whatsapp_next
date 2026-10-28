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
	};
	const STATES = {
		not_installed: () => ({ label: __("Not installed", null, "Hub"), colour: "gray" }),
		update_available: () => ({ label: __("Update available", null, "Hub"), colour: "orange" }),
		installed: () => ({ label: __("Installed", null, "Hub"), colour: "green" }),
	};
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
							<span class="wa-hub__row-text"><b>${esc(r.hub_name)}</b>${r.description ? `<em>${esc(r.description)}</em>` : ""}</span>
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
			const fields = Object.entries(e.payload || {})
				.filter(([k]) => k !== "script")
				.map(([k, v]) => `<div><dt>${esc((e.labels || {})[k] || k)}</dt><dd dir="auto">${esc(typeof v === "object" ? JSON.stringify(v) : v)}</dd></div>`)
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
				${e.description ? `<p class="wa-hub__desc">${esc(e.description)}</p>` : ""}
				<dl class="wa-hub__facts">
					<div><dt>${esc(__("Type"))}</dt><dd>${esc(__(e.hub_type))}</dd></div>
					<div><dt>${esc(__("Last changed"))}</dt><dd>${esc(frappe.datetime.str_to_user(e.modified))}</dd></div>
					<div><dt>${esc(__("Checksum", null, "Hub"))}</dt><dd dir="ltr" class="sanad-tabular">${esc(e.checksum)}</dd></div>
				</dl>
				${fields ? `<h4 class="wa-hub__sub">${esc(__("What it sets up"))}</h4><dl class="wa-hub__fields">${fields}</dl>` : ""}
				${
					e.payload && e.payload.script
						? `<h4 class="wa-hub__sub">${esc(__("The code it runs on this site"))}</h4><pre class="wa-hub__code" dir="ltr">${esc(e.payload.script)}</pre>`
						: ""
				}
				${
					["Alert", "Notification"].includes(e.hub_type) && e.state === "not_installed"
						? `<p class="wa-hub__muted">${esc(__("It is installed switched off: turn it on when its recipients and device are right."))}</p>`
						: ""
				}`);
			this.$detail.find("[data-act=install]").on("click", () => this.install(e));
			this.$detail.find("[data-act=open]").on("click", () => {
				this.dialog.hide();
				frappe.set_route("Form", { Function: "WhatsApp Function", Command: "WhatsApp Command", Alert: "WhatsApp Notification Alert", Notification: "WhatsApp Notification" }[e.hub_type], e.local);
			});
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

// sanad.ui.AlertEditor — one window to create, edit, look at and try a scheduled alert (a report or a
// message that goes out daily, weekly, monthly…). The alert is written as four short answers, each
// in its own card that ticks itself green once it is complete:
//
//   1 When     every day / week / month / quarter / year — weekday chips, a 28-day grid, month
//              chips and a time with quick picks — read back as one sentence with the next runs.
//   2 What     a report (searched), its filters as rows (a fixed value or a date that moves: today,
//              month start, last N days…) and the file it attaches; or only a message. The text is
//              custom with insertable variables, or a saved template.
//   3 To whom  users, roles, numbers, or a column of the report (one message per value), as chips.
//   4 From     the device that sends it, as cards with their state.
//
// Beside them, a live preview of the unsaved draft — the message as the first recipient gets it,
// the file it attaches, how many rows and recipients, the next runs, and what is still missing —
// refreshed as you type. Under it, "Send a test" sends the draft once to one number; a saved alert
// also shows what it sent last and can run now.
//
// Portable: it knows nothing about the host app. The host passes the data source as functions —
// see README.md. Colours are the product tokens (`--wa-*`); offsets are logical, so RTL needs nothing.

frappe.provide("sanad.ui");

(function () {
	const esc = (v) => sanad.ui.escape(v == null ? "" : v);
	const WEEK_ORDER = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
	const JS_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
	const PERIOD_LABEL = () => ({
		Daily: __("Every day"),
		Weekly: __("Every week"),
		Monthly: __("Every month"),
		Quarterly: __("Every quarter"),
		Yearly: __("Every year"),
	});
	const TYPE_META = () => ({
		User: { icon: "user", label: __("User"), hint: __("Their mobile number from their user profile") },
		Role: { icon: "users", label: __("Role", null, "alert recipient"), hint: __("Every enabled user with this role") },
		Phone: { icon: "chat", label: __("Number"), hint: __("Any WhatsApp number") },
		"Report Column": { icon: "table", label: __("Report column"), hint: __("One message per number in this column, with only that number's rows") },
	});

	class AlertEditor {
		/**
		 * @param {Object} opts
		 * @param {string|null} opts.name — the alert to open; empty for a new one
		 * @param {Function} opts.load — `(name) → {alert, stats, recent[], options, devices[], templates[], tokens[], variables[], png_available, me, can_write, can_delete}`
		 * @param {Function} opts.preview — `(payload) → {problem, next_runs[], row_count, recipients[], recipients_count, message, attachment, error}`
		 * @param {Function} opts.save — `(payload) → {name}`
		 * @param {Function} [opts.remove] — `(name)`
		 * @param {Function} [opts.set_enabled] — `(name, enabled)`
		 * @param {Function} [opts.send_test] — `(payload, phone) → {phone_e164}`
		 * @param {Function} [opts.run_now] — `(name)`
		 * @param {Function} opts.search — `(kind, txt) → [{value, label, description}]`; kinds report · user · role · print_format · letter_head · language
		 * @param {Function} [opts.report_columns] — `(report, filters) → [{fieldname, label}]`
		 * @param {Function} [opts.on_saved] — `(result)` after a save, a switch or a delete
		 * @param {Function} [opts.on_close]
		 */
		constructor(opts = {}) {
			this.opts = opts;
			this.ui = {
				add_q: "",
				results: [],
				pick_open: null, // "report" | "recipient" | "print_format" | "letter_head" | "language"
				json_mode: false,
				preview: null,
				previewing: false,
				saving: false,
				testing: false,
				test_phone: "",
				columns: null,
				columns_for: null,
				labels: {},
			};
			this.data = null;
			this.draft = null;
			this.clean = null;
			this.build();
			this.load(opts.name || null);
		}

		// ---- shell ---------------------------------------------------------------------------------

		build() {
			this.id = sanad.ui.uid("sanad-ae");
			this.previous_focus = document.activeElement;
			this.$root = $(`
				<div class="sanad-kit sanad-ae-layer" role="presentation">
					<div class="sanad-ae-backdrop" data-act="close"></div>
					<div class="sanad-ae" role="dialog" aria-modal="true" aria-labelledby="${this.id}-title">
						<div class="sanad-ae__loading">${esc(__("Loading…"))}</div>
					</div>
				</div>`).appendTo(document.body);
			this.$dlg = this.$root.find(".sanad-ae");
			$("body").addClass("sanad-ae-open");
			this.$root.on("click", "[data-act]", (e) => this.on_act(e));
			this.$root.on("input", "[data-in]", (e) => this.on_input(e));
			this.$root.on("change", "[data-ch]", (e) => this.on_change(e));
			this.$root.on("keydown", (e) => this.on_key(e));
			// a picker lists its first choices as soon as it is focused
			this.$root.on("focusin", "[data-in=pick_q]", (e) => {
				const kind = $(e.currentTarget).data("kind");
				if (this.ui.pick_open === kind) return;
				this.ui.pick_open = kind;
				this.ui.add_q = $(e.currentTarget).val() || "";
				this.ui.searching = true;
				this.run_search();
			});
			this.$root.on("mousedown", (e) => {
				if (this.ui.pick_open && !$(e.target).closest(".sanad-ae__pick").length) this.close_pick();
			});
			this.untrap = sanad.ui.trap_focus(this.$root);
			this.install_report_shim();
			this.refresh_preview = sanad.ui.debounce(() => this.run_preview(), 600);
			this.search_later = sanad.ui.debounce(() => this.run_search(), 250);
		}

		close(force = false) {
			if (!force && this.is_dirty()) {
				frappe.confirm(__("Discard unsaved changes?"), () => this.close(true));
				return;
			}
			this.untrap && this.untrap();
			frappe.query_report = this._prev_query_report;
			$("body").removeClass("sanad-ae-open");
			this.$root.remove();
			if (this.previous_focus && this.previous_focus.focus) this.previous_focus.focus();
			this.opts.on_close && this.opts.on_close();
		}

		async load(name) {
			try {
				this.data = await this.opts.load(name);
				this.draft = this.seed(this.data.alert);
				this.clean = JSON.stringify(this.draft);
				this.ui.test_phone = (this.data.me && this.data.me.phone) || "";
				this.render();
				const $name = this.$root.find("[data-in=alert_name]");
				if (!this.draft.name) $name.trigger("focus");
				this.run_preview();
				if (this.draft.report) {
					this.load_report_filters();
					this.load_columns();
				}
			} catch (err) {
				this.$dlg.html(`
					<div class="sanad-ae__loading" role="alert">
						<span>${esc(err && err.message ? err.message : __("Something went wrong. Please try again."))}</span>
						<button type="button" class="sanad-ae__btn" data-act="close">${esc(__("Close"))}</button>
					</div>`);
			}
		}

		seed(a) {
			const filters = this.parse_filters(a.filters_json, a.dynamic_filters_json);
			return {
				name: a.name || null,
				alert_name: a.alert_name || "",
				enabled: cint(a.enabled),
				periodicity: a.periodicity || "Daily",
				day_of_week: a.day_of_week || "Sunday",
				day_of_month: cint(a.day_of_month) || 1,
				month_of_year: a.month_of_year || "January",
				notification_time: a.notification_time || "08:00",
				content_type: a.content_type || "Report",
				report: a.report || null,
				filters: filters.rows,
				filters_raw: filters.raw,
				rf: this.parse_report_filters(a.filters_json, a.dynamic_filters_json),
				builder: this.parse_builder(a.filters_json),
				template: a.template || null,
				message: a.message || "",
				body_mode: a.template ? "template" : "custom",
				attachment_format: a.attachment_format || "PDF",
				print_format: a.print_format || null,
				letter_head: a.letter_head || null,
				language: a.language || null,
				device: a.device || null,
				recipients: (a.recipients || []).map((r) => ({
					recipient_type: r.recipient_type,
					user: r.user || null,
					role: r.role || null,
					phone: r.phone || r.phone_e164 || null,
					report_column: r.report_column || null,
				})),
			};
		}

		/** A report's own filters: `{values{field: value}, tokens{field: "today" | "last_days:7"}}`. */
		parse_report_filters(static_json, dynamic_json) {
			const parse = (t) => {
				try {
					const v = typeof t === "string" ? JSON.parse(t) : t;
					return v && typeof v === "object" && !Array.isArray(v) ? v : {};
				} catch (e) {
					return {};
				}
			};
			return { values: parse(static_json), tokens: parse(dynamic_json) };
		}

		/** A Report Builder report's filters, as Frappe list filters, or null. */
		parse_builder(static_json) {
			try {
				const v = typeof static_json === "string" ? JSON.parse(static_json) : static_json;
				return Array.isArray(v) ? v : null;
			} catch (e) {
				return null;
			}
		}

		/** Filters as rows `{field, mode: "value"|"token", value, token, n}`; `raw` when they do not fit rows. */
		parse_filters(static_json, dynamic_json) {
			const parse = (t) => {
				if (!t) return {};
				try {
					return typeof t === "string" ? JSON.parse(t) : t;
				} catch (e) {
					return null;
				}
			};
			const st = parse(static_json);
			const dy = parse(dynamic_json);
			const raw = { filters_json: static_json || "", dynamic_filters_json: dynamic_json || "" };
			if (st === null || dy === null || Array.isArray(st) || Array.isArray(dy)) return { rows: [], raw };
			const rows = [];
			Object.entries(st || {}).forEach(([field, value]) => {
				if (value !== null && typeof value === "object") return;
				rows.push({ field, mode: "value", value: value == null ? "" : String(value), token: "today", n: 7 });
			});
			Object.entries(dy || {}).forEach(([field, token]) => {
				const m = /^(\w+):(\d+)$/.exec(String(token));
				rows.push({ field, mode: "token", value: "", token: m ? `${m[1]}:N` : String(token), n: m ? cint(m[2]) : 7 });
			});
			const lossless = Object.values(st || {}).every((v) => v === null || typeof v !== "object");
			return { rows, raw: lossless ? null : raw };
		}

		payload() {
			const d = this.draft;
			const out = {
				alert_name: d.alert_name,
				enabled: d.enabled,
				periodicity: d.periodicity,
				day_of_week: d.day_of_week,
				day_of_month: d.day_of_month,
				month_of_year: d.month_of_year,
				notification_time: d.notification_time,
				content_type: d.content_type,
				report: d.content_type === "Report" ? d.report : null,
				template: d.body_mode === "template" ? d.template : null,
				message: d.body_mode === "custom" ? d.message : d.message || null,
				attachment_format: d.content_type === "Report" ? d.attachment_format : "None",
				print_format: d.print_format,
				letter_head: d.letter_head,
				language: d.language,
				device: d.device,
				recipients: d.recipients.filter((r) => d.content_type === "Report" || r.recipient_type !== "Report Column"),
			};
			if (d.name) out.name = d.name;
			const mode = this.ui.filter_mode;
			if (mode === "builder") {
				out.filters_json = d.builder && d.builder.length ? JSON.stringify(d.builder) : null;
				out.dynamic_filters_json = null;
			} else if (mode === "report") {
				const values = {};
				Object.entries(d.rf.values || {}).forEach(([k, v]) => {
					if (d.rf.tokens[k] || v === "" || v == null || (Array.isArray(v) && !v.length)) return;
					values[k] = v;
				});
				out.filters_json = Object.keys(values).length ? JSON.stringify(values) : null;
				out.dynamic_filters_json = Object.keys(d.rf.tokens || {}).length ? JSON.stringify(d.rf.tokens) : null;
			} else if (this.ui.json_mode || d.filters_raw) {
				const raw = d.filters_raw || {};
				out.filters_json = raw.filters_json || null;
				out.dynamic_filters_json = raw.dynamic_filters_json || null;
			} else {
				const st = {};
				const dy = {};
				d.filters.forEach((f) => {
					const field = (f.field || "").trim();
					if (!field) return;
					if (f.mode === "token") dy[field] = f.token.endsWith(":N") ? f.token.replace(":N", `:${cint(f.n) || 1}`) : f.token;
					else st[field] = f.value;
				});
				out.filters_json = Object.keys(st).length ? JSON.stringify(st) : null;
				out.dynamic_filters_json = Object.keys(dy).length ? JSON.stringify(dy) : null;
			}
			if (d.content_type !== "Report") {
				out.filters_json = null;
				out.dynamic_filters_json = null;
			}
			return out;
		}

		is_dirty() {
			return !!this.draft && this.clean !== JSON.stringify(this.draft);
		}

		/** A change to the draft: redraw what depends on it and ask for a new preview. */
		changed({ redraw = [], preview = true } = {}) {
			redraw.forEach((part) => this[`draw_${part}`] && this[`draw_${part}`]());
			this.draw_head_state();
			this.draw_foot();
			if (preview) {
				this.ui.previewing = true;
				this.draw_status();
				this.refresh_preview();
			}
		}

		// ---- render --------------------------------------------------------------------------------

		render() {
			const d = this.draft;
			this.$dlg.html(`
				<header class="sanad-ae__head">
					<span class="sanad-ae__mark" aria-hidden="true">${sanad.ui.ico("clock", "md")}</span>
					<div class="sanad-ae__heading">
						<h2 id="${this.id}-title" class="sr-only">${esc(d.name ? __("Edit alert") : __("New alert"))}</h2>
						<input type="text" class="sanad-ae__name" data-in="alert_name" data-sanad-bare maxlength="140"
							value="${esc(d.alert_name)}" placeholder="${esc(__("Name this alert…"))}" aria-label="${esc(__("Alert name"))}">
						<p class="sanad-ae__sentence" data-slot="sentence"></p>
					</div>
					<span class="sanad-ae__dirty" data-slot="dirty" hidden>${esc(__("Not saved"))}</span>
					<label class="wa-toggle sanad-ae__enabled" title="${esc(__("The alert runs on its schedule only when it is on"))}">
						<input type="checkbox" data-ch="enabled" ${d.enabled ? "checked" : ""}>
						<span class="wa-toggle__track"></span>
						<span class="wa-toggle__label" data-slot="enabled-label"></span>
					</label>
					<button type="button" class="sanad-ae__icon" data-act="close" aria-label="${esc(__("Close"))}" title="${esc(__("Close (Esc)"))}">${sanad.ui.ico("x", "md")}</button>
				</header>
				<div class="sanad-ae__main">
					<div class="sanad-ae__build">
						<section class="sanad-ae__step" data-step="when"></section>
						<section class="sanad-ae__step" data-step="what"></section>
						<section class="sanad-ae__step" data-step="who"></section>
						<section class="sanad-ae__step" data-step="from"></section>
					</div>
					<aside class="sanad-ae__side" aria-label="${esc(__("Preview"))}">
						<div data-slot="preview"></div>
						<div data-slot="test"></div>
						<div data-slot="history"></div>
					</aside>
				</div>
				<footer class="sanad-ae__foot" data-slot="foot"></footer>`);
			this.draw_when();
			this.draw_what();
			this.draw_who();
			this.draw_from();
			this.draw_preview();
			this.draw_test();
			this.draw_history();
			this.draw_head_state();
			this.draw_foot();
		}

		step_head(n, key, title, done, note) {
			return `
				<header class="sanad-ae__step-head">
					<span class="sanad-ae__num${done ? " is-done" : ""}" aria-hidden="true">${done ? sanad.ui.ico("tick", "sm") : n}</span>
					<span class="sanad-ae__step-title"><strong>${esc(title)}</strong>${note ? `<span>${esc(note)}</span>` : ""}</span>
					<span class="sr-only">${esc(done ? __("Complete") : __("Not complete yet"))}</span>
				</header>`;
		}

		chip(label, { act, value, on, disabled, title, wide } = {}) {
			return `<button type="button" class="sanad-ae__chip${on ? " is-on" : ""}${wide ? " sanad-ae__chip--wide" : ""}" data-act="${esc(act)}" data-value="${esc(value)}" aria-pressed="${on ? "true" : "false"}"${disabled ? " disabled" : ""}${title ? ` title="${esc(title)}"` : ""}>${esc(label)}</button>`;
		}

		seg(act, options, value, label) {
			return `<div class="wa-seg sanad-ae__seg" role="radiogroup" aria-label="${esc(label)}">${options
				.map(
					(o) =>
						`<button type="button" class="wa-seg__opt" role="radio" aria-checked="${o.value === value}" data-act="${esc(act)}" data-value="${esc(o.value)}"${o.disabled ? " disabled" : ""}${o.title ? ` title="${esc(o.title)}"` : ""}>${o.icon ? sanad.ui.ico(o.icon, "xs") : ""}<span>${esc(o.label)}</span></button>`
				)
				.join("")}</div>`;
		}

		// 1 — when -------------------------------------------------------------------------------------

		draw_when() {
			const d = this.draft;
			const o = this.data.options || {};
			const labels = PERIOD_LABEL();
			const select = (key, options, value, label) =>
				`<select class="wa-select sanad-ae__inline" data-ch="${esc(key)}" aria-label="${esc(label)}">${options
					.map((opt) => `<option value="${esc(opt.value)}"${String(opt.value) === String(value) ? " selected" : ""}>${esc(opt.label)}</option>`)
					.join("")}</select>`;
			const days = Array.from({ length: 28 }, (_, i) => ({ value: i + 1, label: String(i + 1) }));
			const parts = [
				`<span class="sanad-ae__word">${esc(__("Send it", null, "alert schedule"))}</span>`,
				select("periodicity", (o.periodicity || Object.keys(labels)).map((p) => ({ value: p, label: labels[p] || __(p) })), d.periodicity, __("Periodicity")),
			];
			if (d.periodicity === "Weekly") {
				parts.push(`<span class="sanad-ae__word">${esc(__("on", null, "alert schedule"))}</span>`);
				parts.push(select("day_of_week", WEEK_ORDER.filter((w) => (o.day_of_week || WEEK_ORDER).includes(w)).map((w) => ({ value: w, label: __(w) })), d.day_of_week, __("Day of the week")));
			}
			if (["Monthly", "Quarterly", "Yearly"].includes(d.periodicity)) {
				parts.push(`<span class="sanad-ae__word">${esc(__("on day", null, "alert schedule"))}</span>`);
				parts.push(select("day_of_month", days, d.day_of_month, __("Day of the month")));
			}
			if (d.periodicity === "Yearly") {
				parts.push(`<span class="sanad-ae__word">${esc(__("of", null, "alert schedule"))}</span>`);
				parts.push(select("month_of_year", (o.month_of_year || []).map((m) => ({ value: m, label: __(m) })), d.month_of_year, __("Month")));
			}
			parts.push(`<span class="sanad-ae__word">${esc(__("at", null, "alert schedule"))}</span>`);
			parts.push(`<input type="time" class="wa-input sanad-ae__inline sanad-ae__time-in" data-in="notification_time" value="${esc(d.notification_time)}" aria-label="${esc(__("Time"))}">`);
			const note =
				d.periodicity === "Quarterly"
					? __("In the first month of each quarter. Days 29–31 are left out so that every month has the day.")
					: ["Monthly", "Yearly"].includes(d.periodicity)
						? __("Days 29–31 are left out so that every month has the day.")
						: "";
			this.$root.find("[data-step=when]").html(`
				${this.step_head(1, "when", __("When does it go out?"), !!d.notification_time)}
				<div class="sanad-ae__step-body">
					<div class="sanad-ae__sentence-line">${parts.join("")}</div>
					${note ? `<p class="sanad-ae__hint">${esc(note)}</p>` : ""}
					<div class="sanad-ae__next" data-slot="next"></div>
				</div>`);
			this.draw_next();
			this.draw_sentence();
		}

		draw_next() {
			const runs = (this.ui.preview && this.ui.preview.next_runs) || [];
			const $n = this.$root.find("[data-slot=next]");
			if (!runs.length) return $n.html("");
			$n.html(`
				<span class="sanad-ae__next-label">${esc(__("Next runs"))}</span>
				<ol class="sanad-ae__runs">${runs
					.map((r, i) => `<li class="${i === 0 ? "is-first" : ""}"><span class="sanad-ae__dot"></span>${esc(this.when_text(r))}</li>`)
					.join("")}</ol>`);
		}

		when_text(value) {
			const dt = frappe.datetime.str_to_obj(value);
			if (!dt) return value;
			const day = __(JS_DAYS[dt.getDay()]);
			const date = frappe.datetime.str_to_user(frappe.datetime.obj_to_str(dt).slice(0, 10));
			const time = `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
			return `${day} ${date} · ${time}`;
		}

		schedule_sentence() {
			const d = this.draft;
			const t = d.notification_time || "—";
			switch (d.periodicity) {
				case "Weekly":
					return __("Every {0} at {1}", [__(d.day_of_week), t]);
				case "Monthly":
					return __("On day {0} of every month at {1}", [d.day_of_month, t]);
				case "Quarterly":
					return __("On day {0} of every quarter at {1}", [d.day_of_month, t]);
				case "Yearly":
					return __("Every year on {0} {1} at {2}", [d.day_of_month, __(d.month_of_year), t]);
				default:
					return __("Every day at {0}", [t]);
			}
		}

		draw_sentence() {
			const d = this.draft;
			const what =
				d.content_type === "Report"
					? d.report
						? __("the report {0}", [__(d.report)])
						: __("a report")
					: __("a message");
			const n = d.recipients.length;
			const who = n ? sanad.ui.plural(n, { one: __("{0} recipient"), other: __("{0} recipients") }) : __("no one yet");
			this.$root.find("[data-slot=sentence]").text(`${this.schedule_sentence()} — ${what} → ${who}`);
		}

		// 2 — what -------------------------------------------------------------------------------------

		draw_what() {
			const d = this.draft;
			const is_report = d.content_type === "Report";
			const done = (is_report ? !!d.report : true) && (d.body_mode === "template" ? !!d.template : !!(d.message || "").trim());
			const png_off = !this.data.png_available && d.attachment_format !== "PNG";
			this.$root.find("[data-step=what]").html(`
				${this.step_head(2, "what", __("What does it send?"), done)}
				<div class="sanad-ae__step-body">
					${this.seg(
						"content",
						[
							{ value: "Report", label: __("A report"), icon: "table" },
							{ value: "Static Message", label: __("A message only"), icon: "chat" },
						],
						d.content_type,
						__("Content")
					)}
					${
						is_report
							? `
						<div class="sanad-ae__field">
							<span class="sanad-ae__label">${esc(__("Report"))}</span>
							${this.picker("report", d.report, __("Search reports…"), d.report ? __(d.report) : null, this.ui.labels[`report:${d.report}`])}
						</div>
						<div class="sanad-ae__field">
							<div class="sanad-ae__field-line">
								<span class="sanad-ae__label">${esc(__("Filters"))}</span>
								${
									["report", "builder", "loading"].includes(this.ui.filter_mode)
										? `<span class="sanad-ae__sub">${esc(this.ui.filter_mode === "builder" ? __("The report's list filters") : this.ui.filter_mode === "report" ? __("The report's own filters") : "")}</span>`
										: `<button type="button" class="sanad-ae__link" data-act="json">${esc(this.ui.json_mode || d.filters_raw ? __("Edit as rows") : __("Edit as JSON"))}</button>`
								}
							</div>
							<div data-slot="filters"></div>
						</div>
						<div class="sanad-ae__field">
							<span class="sanad-ae__label">${esc(__("Attach the report as"))}</span>
							${this.seg(
								"format",
								[
									{ value: "None", label: __("No file") },
									{ value: "PDF", label: __("PDF"), icon: "doc" },
									{
										value: "PNG",
										label: __("Image"),
										disabled: png_off,
										title: png_off ? __("An image needs wkhtmltoimage on the server") : "",
									},
								],
								d.attachment_format,
								__("Attachment")
							)}
							${
								d.attachment_format !== "None"
									? `<details class="sanad-ae__more"${d.print_format || d.letter_head || d.language ? " open" : ""}>
										<summary>${esc(__("File options"))}</summary>
										<div class="sanad-ae__cols">
											<div class="sanad-ae__field"><span class="sanad-ae__label">${esc(__("Print format"))}</span>${this.picker("print_format", d.print_format, __("Default"), d.print_format)}</div>
											<div class="sanad-ae__field"><span class="sanad-ae__label">${esc(__("Letter head"))}</span>${this.picker("letter_head", d.letter_head, __("None"), d.letter_head)}</div>
											<div class="sanad-ae__field"><span class="sanad-ae__label">${esc(__("Language"))}</span>${this.picker("language", d.language, __("The site's"), d.language)}</div>
										</div>
									</details>`
									: ""
							}
						</div>`
							: ""
					}
					<div class="sanad-ae__field">
						<div class="sanad-ae__field-line">
							<span class="sanad-ae__label">${esc(is_report && d.attachment_format !== "None" ? __("Caption") : __("Message"))}</span>
							${this.seg(
								"body",
								[
									{ value: "custom", label: __("Write it") },
									{ value: "template", label: __("Use a template"), disabled: !(this.data.templates || []).length },
								],
								d.body_mode,
								__("Message source")
							)}
						</div>
						${
							d.body_mode === "template"
								? `<select class="wa-select" data-ch="template" aria-label="${esc(__("Template"))}">
									<option value="">${esc(__("Choose a template…"))}</option>
									${(this.data.templates || [])
										.map((t) => `<option value="${esc(t.name)}"${t.name === d.template ? " selected" : ""}>${esc(t.template_name || t.name)}${t.category ? ` · ${esc(t.category)}` : ""}</option>`)
										.join("")}
								</select>`
								: `<div class="sanad-ae__vars" role="group" aria-label="${esc(__("Insert a variable"))}">
									${(this.data.variables || [])
										.map((v, i) => `<button type="button" class="sanad-ae__var" data-act="var" data-value="${i}" title="${esc(v.code)}">${sanad.ui.ico("plus", "xs")}${esc(v.label)}</button>`)
										.join("")}
								</div>
								<textarea class="wa-textarea sanad-ae__msg" data-in="message" rows="4" dir="auto" placeholder="${esc(__("What the message says…"))}" aria-label="${esc(__("Message"))}">${esc(d.message)}</textarea>`
						}
					</div>
				</div>`);
			this.draw_filters();
			this.draw_sentence();
		}

		/** The report's filters: its own controls (script / query report), Frappe's filter component
		 * (Report Builder — a list of one DocType), or key / value rows when it defines none. */
		draw_filters() {
			const $f = this.$root.find("[data-slot=filters]");
			if (!$f.length) return;
			const mode = this.ui.filter_mode;
			if (mode === "loading") return $f.html(`<p class="sanad-ae__hint">${esc(__("Reading the report's filters…"))}</p>`);
			if (mode === "builder") return this.draw_builder($f);
			if (mode === "report") return this.draw_report_controls($f);
			return this.draw_filter_rows();
		}

		draw_builder($f) {
			const d = this.draft;
			const info = this.ui.report_info || {};
			$f.html(`<div class="sanad-ae__fg"></div><p class="sanad-ae__hint">${esc(
				__("Filters on {0}. For a date that moves, choose the \"Timespan\" condition (today, this week, last month…).", [__(info.ref_doctype)])
			)}</p>`);
			try {
				this.fg = new frappe.ui.FilterGroup({
					parent: $f.find(".sanad-ae__fg"),
					doctype: info.ref_doctype,
					on_change: () => {
						d.builder = this.fg.get_filters().map((f) => f.slice(0, 4));
						this.changed();
					},
				});
				this.fg.wrapper.find(".apply-filters").hide();
				this.fg.add_filters_to_filter_group(d.builder || []);
			} catch (e) {
				$f.html(`<p class="sanad-ae__hint">${esc(__("The filters of this report could not be shown."))}</p>`);
			}
		}

		draw_report_controls($f) {
			const d = this.draft;
			const tokens = this.data.tokens || [];
			const defs = (this.ui.report_defs || []).filter((df) => df.fieldname && !["Section Break", "Column Break", "Tab Break", "HTML", "Button"].includes(df.fieldtype) && !df.hidden);
			$f.html(`<div class="sanad-ae__rfs"></div>`);
			const $wrap = $f.find(".sanad-ae__rfs");
			this.rf_controls = {};
			defs.forEach((def) => {
				const field = def.fieldname;
				const is_date = ["Date", "Datetime"].includes(def.fieldtype);
				const token = d.rf.tokens[field];
				const m = token ? /^(\w+):(\d+)$/.exec(token) : null;
				const token_key = m ? `${m[1]}:N` : token;
				const $row = $(`<div class="sanad-ae__rf${token ? " is-moving" : ""}" data-field="${esc(field)}">
					<div class="sanad-ae__rf-head">
						<span class="sanad-ae__rf-label">${esc(__(def.label || field))}${def.reqd ? '<span class="wa-field__req"> *</span>' : ""}</span>
						${is_date ? this.seg(`rf_mode:${field}`, [{ value: "fixed", label: __("Fixed") }, { value: "moving", label: __("Moves") }], token ? "moving" : "fixed", __("Date kind")) : ""}
					</div>
					<div class="sanad-ae__rf-in"></div>
				</div>`).appendTo($wrap);
				const $in = $row.find(".sanad-ae__rf-in");
				if (token) {
					$in.html(`<span class="sanad-ae__token">
						<select class="wa-select" data-ch="rf_token" data-field="${esc(field)}" aria-label="${esc(__(def.label || field))}">${tokens
							.map((t) => `<option value="${esc(t.name)}"${t.name === token_key ? " selected" : ""}>${esc(this.token_label(t.name))} — ${esc(t.example)}</option>`)
							.join("")}</select>
						${token_key && token_key.endsWith(":N") ? `<input type="number" min="1" max="3660" class="wa-input sanad-ae__n" data-in="rf_n" data-field="${esc(field)}" value="${esc(m ? m[2] : 7)}" aria-label="${esc(__("Number of days"))}">` : ""}
					</span>`);
					return;
				}
				const df = Object.assign({}, def, { label: "", reqd: 0, on_change: null, onchange: null });
				delete df.default;
				df.change = () => {
					d.rf.values[field] = control.get_value();
					this.changed();
				};
				const control = frappe.ui.form.make_control({ df, parent: $in, render_input: true, only_input: def.fieldtype !== "Check" });
				control.refresh();
				if (d.rf.values[field] != null) control.set_value(d.rf.values[field]);
				if (control.$input) control.$input.attr("aria-label", __(def.label || field));
				this.rf_controls[field] = control;
			});
			if (!defs.length) $wrap.html(`<p class="sanad-ae__hint">${esc(__("This report has no filters."))}</p>`);
		}

		/** Load the picked report's filter definitions and draw them. */
		async load_report_filters() {
			const d = this.draft;
			if (!d.report || !this.opts.report_info) {
				this.ui.filter_mode = null;
				return this.draw_filters();
			}
			const report = d.report;
			this.ui.filter_mode = "loading";
			this.draw_filters();
			try {
				const info = await this.opts.report_info(report);
				if (this.draft.report !== report) return;
				this.ui.report_info = info;
				if (info.report_type === "Report Builder") {
					await new Promise((resolve) => frappe.model.with_doctype(info.ref_doctype, resolve));
					if (!d.builder) d.builder = info.saved_filters || [];
					this.ui.filter_mode = "builder";
				} else {
					const defs = await this.report_defs(report, info);
					if (this.draft.report !== report) return;
					this.ui.report_defs = defs;
					this.ui.filter_mode = defs.length ? "report" : "rows";
					if (defs.length && !this.draft.name) this.apply_defaults(defs);
				}
			} catch (e) {
				this.ui.filter_mode = "rows";
			}
			this.draw_what();
			this.run_preview();
		}

		/** A script / query report's filter definitions, from its own script (as Frappe's report view loads it). */
		async report_defs(report, info) {
			const known = frappe.query_reports && frappe.query_reports[report];
			if (known && known.filters) return known.filters;
			const r = await frappe.xcall("frappe.desk.query_report.get_script", { report_name: report });
			const before = new Set(Object.keys(frappe.query_reports || {}));
			try {
				frappe.dom.eval((r && r.script) || "");
			} catch (e) {
				// a script that needs its report page around it: fall back to the filters saved on the report
			}
			frappe.query_reports = frappe.query_reports || {};
			const added = Object.keys(frappe.query_reports).filter((k) => !before.has(k));
			const settings = frappe.query_reports[report] || (added.length ? frappe.query_reports[added[added.length - 1]] : null);
			const defs = (settings && settings.filters) || (r && r.filters) || [];
			return defs.map((f) => Object.assign({}, f, { fieldtype: f.fieldtype || "Data", reqd: f.reqd || f.mandatory }));
		}

		apply_defaults(defs) {
			const d = this.draft;
			defs.forEach((def) => {
				if (!def.fieldname || d.rf.values[def.fieldname] != null || d.rf.tokens[def.fieldname]) return;
				let v = def.default;
				try {
					if (typeof v === "function") v = v();
				} catch (e) {
					v = null;
				}
				if (v == null || v === "") return;
				// a date the report defaults to today keeps moving with the alert
				if (["Date", "Datetime"].includes(def.fieldtype) && v === frappe.datetime.get_today()) d.rf.tokens[def.fieldname] = "today";
				else d.rf.values[def.fieldname] = v;
			});
		}

		/** Report filter scripts ask `frappe.query_report` for each other's values (`get_query`); answer from the draft. */
		install_report_shim() {
			const me = this;
			this._prev_query_report = frappe.query_report;
			frappe.query_report = {
				get_filter_value: (f) => me.draft && me.draft.rf.values[f],
				get_filter: (f) => ({ get_value: () => me.draft && me.draft.rf.values[f], set_value: () => {}, set_input: () => {}, refresh: () => {}, df: {} }),
				set_filter_value: () => {},
				get_values: () => Object.assign({}, me.draft && me.draft.rf.values),
				refresh: () => {},
				filters: [],
			};
		}

		draw_filter_rows() {
			const d = this.draft;
			const $f = this.$root.find("[data-slot=filters]");
			if (!$f.length) return;
			const mode = this.ui.filter_mode;
			if (mode === "builder") {
				out.filters_json = d.builder && d.builder.length ? JSON.stringify(d.builder) : null;
				out.dynamic_filters_json = null;
			} else if (mode === "report") {
				const values = {};
				Object.entries(d.rf.values || {}).forEach(([k, v]) => {
					if (d.rf.tokens[k] || v === "" || v == null || (Array.isArray(v) && !v.length)) return;
					values[k] = v;
				});
				out.filters_json = Object.keys(values).length ? JSON.stringify(values) : null;
				out.dynamic_filters_json = Object.keys(d.rf.tokens || {}).length ? JSON.stringify(d.rf.tokens) : null;
			} else if (this.ui.json_mode || d.filters_raw) {
				const raw = d.filters_raw || { filters_json: "", dynamic_filters_json: "" };
				$f.html(`
					<div class="sanad-ae__cols">
						<label class="sanad-ae__field"><span class="sanad-ae__sub">${esc(__("Fixed filters (JSON)"))}</span>
							<textarea class="wa-textarea wa-input--mono" rows="3" data-in="raw_static" dir="ltr">${esc(raw.filters_json || "")}</textarea></label>
						<label class="sanad-ae__field"><span class="sanad-ae__sub">${esc(__("Moving dates (JSON)"))}</span>
							<textarea class="wa-textarea wa-input--mono" rows="3" data-in="raw_dynamic" dir="ltr">${esc(raw.dynamic_filters_json || "")}</textarea></label>
					</div>`);
				return;
			}
			const tokens = this.data.tokens || [];
			const rows = d.filters
				.map(
					(f, i) => `
					<div class="sanad-ae__filter" data-i="${i}">
						<input type="text" class="wa-input wa-input--mono" data-in="f_field" data-i="${i}" value="${esc(f.field)}" placeholder="${esc(__("field"))}" aria-label="${esc(__("Filter field"))}" dir="ltr">
						${this.seg(`f_mode:${i}`, [{ value: "value", label: __("Value") }, { value: "token", label: __("Date that moves") }], f.mode, __("Filter kind"))}
						${
							f.mode === "token"
								? `<span class="sanad-ae__token">
									<select class="wa-select" data-ch="f_token" data-i="${i}" aria-label="${esc(__("Date"))}">${tokens
										.map((t) => `<option value="${esc(t.name)}"${t.name === f.token ? " selected" : ""}>${esc(this.token_label(t.name))} — ${esc(t.example)}</option>`)
										.join("")}</select>
									${f.token.endsWith(":N") ? `<input type="number" min="1" max="3660" class="wa-input sanad-ae__n" data-in="f_n" data-i="${i}" value="${esc(f.n)}" aria-label="${esc(__("Number of days"))}">` : ""}
								</span>`
								: `<input type="text" class="wa-input" data-in="f_value" data-i="${i}" value="${esc(f.value)}" placeholder="${esc(__("value"))}" aria-label="${esc(__("Filter value"))}" dir="auto">`
						}
						<button type="button" class="sanad-ae__icon sanad-ae__icon--sm" data-act="f_remove" data-i="${i}" aria-label="${esc(__("Remove filter"))}">${sanad.ui.ico("x", "sm")}</button>
					</div>`
				)
				.join("");
			$f.html(`
				${rows || `<p class="sanad-ae__hint">${esc(__("No filters: the report runs with its own defaults."))}</p>`}
				<button type="button" class="sanad-ae__add" data-act="f_add">${sanad.ui.ico("plus", "sm")}${esc(__("Add a filter"))}</button>`);
		}

		token_label(token) {
			return (
				{
					today: __("Today"),
					yesterday: __("Yesterday"),
					tomorrow: __("Tomorrow"),
					week_start: __("Start of this week"),
					week_end: __("End of this week"),
					month_start: __("Start of this month"),
					month_end: __("End of this month"),
					quarter_start: __("Start of this quarter"),
					quarter_end: __("End of this quarter"),
					year_start: __("Start of this year"),
					year_end: __("End of this year"),
					fiscal_year_start: __("Start of the fiscal year"),
					fiscal_year_end: __("End of the fiscal year"),
					"last_days:N": __("N days back (range)"),
					"days_ago:N": __("N days ago"),
					"days_ahead:N": __("N days ahead"),
				}[token] || token
			);
		}

		/** A searchable single-value picker: the value as a chip, or a search field with results. */
		picker(kind, value, placeholder, label, description) {
			if (value) {
				return `<div class="sanad-ae__picked">
					<span class="sanad-ae__picked-text"><strong>${esc(label || value)}</strong>${description ? `<span>${esc(description)}</span>` : ""}</span>
					<button type="button" class="sanad-ae__link" data-act="unpick" data-kind="${esc(kind)}">${esc(__("Change"))}</button>
				</div>`;
			}
			const open = this.ui.pick_open === kind;
			return `<div class="sanad-ae__pick">
				<span class="sanad-ae__pick-ico" aria-hidden="true">${sanad.ui.ico("search", "sm")}</span>
				<input type="search" class="wa-input" data-in="pick_q" data-kind="${esc(kind)}" autocomplete="off" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" aria-expanded="${open}" value="${open ? esc(this.ui.add_q) : ""}">
				${open ? this.results_html(kind) : ""}
			</div>`;
		}

		results_html(kind) {
			const rows = this.ui.results || [];
			return `<div class="sanad-ae__results" role="listbox">${
				rows.length
					? rows
							.map(
								(r, i) =>
									`<button type="button" role="option" class="sanad-ae__opt" data-act="pick" data-kind="${esc(kind)}" data-i="${i}"><strong>${esc(r.label)}</strong>${r.description ? `<span>${esc(r.description)}</span>` : ""}</button>`
							)
							.join("")
					: `<p class="sanad-ae__none">${esc(this.ui.searching ? __("Searching…") : __("Nothing matches"))}</p>`
			}</div>`;
		}

		// 3 — who --------------------------------------------------------------------------------------

		draw_who() {
			const d = this.draft;
			const meta = TYPE_META();
			const is_report = d.content_type === "Report";
			const chips = d.recipients
				.map((r, i) => {
					if (!is_report && r.recipient_type === "Report Column") return "";
					const m = meta[r.recipient_type] || meta.Phone;
					const value = r.user || r.role || r.phone || r.report_column || "";
					const label = this.ui.labels[`${r.recipient_type}:${value}`] || (r.recipient_type === "Role" ? __(value) : value);
					const sub = r.recipient_type === "Phone" && label !== value ? value : m.label;
					return `<li class="sanad-ae__who sanad-ae__who--${esc(frappe.scrub(r.recipient_type))}">
						<span class="sanad-ae__who-ico" aria-hidden="true">${sanad.ui.ico(m.icon, "sm")}</span>
						<span class="sanad-ae__who-text"><strong>${esc(label)}</strong><span dir="auto">${esc(sub)}</span></span>
						<button type="button" class="sanad-ae__icon sanad-ae__icon--sm" data-act="r_remove" data-i="${i}" aria-label="${esc(__("Remove {0}", [label]))}">${sanad.ui.ico("x", "sm")}</button>
					</li>`;
				})
				.join("");
			const phones = d.recipients.filter((r) => r.recipient_type === "Phone").length;
			let columns = "";
			if (is_report) {
				const cols = this.ui.columns;
				columns = `<div class="sanad-ae__colpick">
					<span class="sanad-ae__sub">${esc(__("Or one message per number in a report column"))}</span>
					${
						!d.report
							? `<p class="sanad-ae__hint">${esc(__("Choose the report first; its columns are listed here."))}</p>`
							: cols === null
								? `<p class="sanad-ae__hint">${esc(__("Reading the report's columns…"))}</p>`
								: cols.length
									? `<div class="sanad-ae__chips">${cols
											.map((c) => this.chip(__(c.label || c.fieldname), { act: "add_column", value: c.fieldname, on: d.recipients.some((r) => r.report_column === c.fieldname) }))
											.join("")}</div>`
									: `<p class="sanad-ae__hint">${esc(__("The report returned no columns with these filters."))}</p>`
					}
				</div>`;
			}
			this.$root.find("[data-step=who]").html(`
				${this.step_head(3, "who", __("Who gets it?"), d.recipients.length > 0)}
				<div class="sanad-ae__step-body">
					<div class="sanad-ae__who-bar">
						<button type="button" class="sanad-ae__btn sanad-ae__btn--pri" data-act="pick_contacts"${this.opts.pick_recipients ? "" : " disabled"}>${sanad.ui.ico("users", "sm")}${esc(__("Choose from contacts"))}</button>
						<span class="sanad-ae__hint">${esc(__("Contact groups, contacts, system screens, a file or typed numbers."))}</span>
						${phones ? `<button type="button" class="sanad-ae__link" data-act="r_clear">${esc(__("Remove all numbers"))}</button>` : ""}
					</div>
					${d.recipients.length ? `<ul class="sanad-ae__whos">${chips}</ul>` : `<p class="sanad-ae__empty">${esc(__("Nobody yet."))}</p>`}
					${columns}
				</div>`);
			this.draw_sentence();
		}

		async pick_contacts() {
			if (!this.opts.pick_recipients) return;
			const d = this.draft;
			const existing = d.recipients.filter((r) => r.recipient_type === "Phone").map((r) => r.phone);
			const rows = (await this.opts.pick_recipients({ existing })) || [];
			let added = 0;
			rows.forEach((row) => {
				const phone = row.phone_e164 || row.phone;
				if (!phone || d.recipients.some((r) => r.recipient_type === "Phone" && r.phone === phone)) return;
				d.recipients.push({ recipient_type: "Phone", phone });
				if (row.display_name) this.ui.labels[`Phone:${phone}`] = row.display_name;
				added += 1;
			});
			if (added) {
				frappe.show_alert({ message: sanad.ui.plural(added, { one: __("{0} number added"), other: __("{0} numbers added") }), indicator: "green" });
				this.changed({ redraw: ["who"] });
			}
		}

		// 4 — from -------------------------------------------------------------------------------------

		/** The device as a Link field (the host sets the DocType and which records it offers). */
		draw_from() {
			const d = this.draft;
			const cfg = this.opts.device_link || {};
			const dev = (this.data.devices || []).find((x) => x.name === d.device);
			this.$root.find("[data-step=from]").html(`
				${this.step_head(4, "from", __("From which device?"), !!d.device, d.device ? null : __("Without one, the default device sends it"))}
				<div class="sanad-ae__step-body">
					<div class="sanad-ae__device-link"></div>
					${
						dev
							? `<p class="sanad-ae__hint sanad-ae__device-state"><span class="sanad-ae__device-dot sanad-ae__device-dot--${dev.status === "Connected" ? "ok" : "warn"}"></span>${esc(__(dev.status))}${dev.phone_e164 ? ` · <span dir="ltr">${esc(dev.phone_e164)}</span>` : ""}</p>`
							: ""
					}
				</div>`);
			if (!cfg.doctype) return;
			const control = frappe.ui.form.make_control({
				df: {
					fieldtype: "Link",
					fieldname: "device",
					options: cfg.doctype,
					placeholder: cfg.placeholder || __("Choose a connected device…"),
					get_query: () => ({ filters: cfg.filters || {} }),
					change: () => {
						const v = control.get_value() || null;
						if (v === d.device) return;
						d.device = v;
						this.changed();
						this.draw_from();
					},
				},
				parent: this.$root.find(".sanad-ae__device-link"),
				render_input: true,
				only_input: true,
			});
			control.refresh();
			if (d.device) control.set_value(d.device);
			if (control.$input) {
				control.$input.attr("aria-label", __("Device"));
				// its list opens under it: bring the field up so the choices are in sight
				control.$input.on("focus", () => control.$input.get(0).scrollIntoView({ block: "center", behavior: "smooth" }));
			}
		}

		// ---- the side: preview, test, history -------------------------------------------------------

		draw_status() {
			const $s = this.$root.find("[data-slot=pv-status]");
			$s.toggleClass("is-busy", !!this.ui.previewing).text(this.ui.previewing ? __("Updating…") : __("Up to date"));
		}

		draw_preview() {
			const p = this.ui.preview;
			const d = this.draft;
			const dev = (this.data.devices || []).find((x) => x.name === d.device) || (this.data.devices || []).find((x) => cint(x.is_default)) || {};
			const first = p && p.recipients && p.recipients[0];
			let bubble;
			if (!p) bubble = `<div class="sanad-ae__bubble is-ghost">${sanad.ui.skeleton(2)}</div>`;
			else if (!p.message && !p.attachment)
				bubble = `<p class="sanad-ae__pv-empty">${esc(d.content_type === "Report" && !d.report ? __("Choose a report to see the message.") : __("Write the message to see it here."))}</p>`;
			else {
				const file = p.attachment
					? `<div class="sanad-ae__file"><span class="sanad-ae__file-ico" aria-hidden="true">${sanad.ui.ico(p.attachment.message_type === "Image" ? "eye" : "doc", "md")}</span><span><strong dir="ltr">${esc(p.attachment.file_name)}</strong><span>${esc(p.attachment.message_type === "Image" ? __("Image") : "PDF")} · ${esc(__("built when it runs"))}</span></span></div>`
					: "";
				bubble = `<div class="sanad-ae__bubble">${file}${p.message ? `<div class="sanad-ae__bubble-text" dir="auto">${esc(p.message)}</div>` : ""}<span class="sanad-ae__bubble-time">${esc(d.notification_time || "")} ${sanad.ui.ico("read", "xs")}</span></div>`;
			}
			const facts = p
				? `<dl class="sanad-ae__facts">
					${d.content_type === "Report" ? `<div><dt>${esc(__("Rows"))}</dt><dd>${esc(sanad.ui.format_int(p.row_count || 0))}</dd></div>` : ""}
					<div><dt>${esc(__("Recipients"))}</dt><dd>${esc(sanad.ui.format_int(p.recipients_count || 0))}</dd></div>
					<div><dt>${esc(__("Next run"))}</dt><dd>${esc(p.next_runs && p.next_runs[0] ? this.when_text(p.next_runs[0]) : "—")}</dd></div>
				</dl>`
				: "";
			const notes = [];
			if (p && p.problem) notes.push(`<div class="sanad-ae__note sanad-ae__note--warn" role="status">${sanad.ui.ico("warn", "sm")}<span>${esc(p.problem)}</span></div>`);
			if (p && p.error) notes.push(`<div class="sanad-ae__note sanad-ae__note--danger" role="alert">${sanad.ui.ico("error", "sm")}<span>${esc(p.error)}</span></div>`);
			this.$root.find("[data-slot=preview]").html(`
				<div class="sanad-ae__side-head"><strong>${esc(__("Preview"))}</strong><span class="sanad-ae__status" data-slot="pv-status" aria-live="polite"></span></div>
				<div class="sanad-ae__phone">
					<div class="sanad-ae__phone-bar">
						<span class="sanad-ae__phone-av" aria-hidden="true">${sanad.ui.ico("whatsapp", "sm")}</span>
						<span><strong>${esc(dev.device_name || __("Device"))}</strong><span dir="ltr">${esc(first ? first.phone_e164 : __("to the first recipient"))}</span></span>
					</div>
					<div class="sanad-ae__chat">${bubble}</div>
				</div>
				${facts}
				${notes.join("")}`);
			this.draw_status();
		}

		draw_test() {
			if (!this.opts.send_test) return;
			const d = this.draft;
			this.$root.find("[data-slot=test]").html(`
				<div class="sanad-ae__test">
					<strong>${esc(__("Try it"))}</strong>
					<p>${esc(__("Sends this draft once to one number — nothing is saved, the schedule and the counters do not change."))}</p>
					<div class="sanad-ae__addline">
						<input type="tel" class="wa-input wa-input--mono" data-in="test_phone" dir="ltr" placeholder="+9665…" value="${esc(this.ui.test_phone)}" aria-label="${esc(__("Number for the test"))}">
						<button type="button" class="sanad-ae__btn sanad-ae__btn--pri" data-act="test"${this.ui.testing ? " disabled" : ""}>${sanad.ui.ico("send", "sm")}${esc(this.ui.testing ? __("Sending…") : __("Send a test"))}</button>
					</div>
					${d.name && this.opts.run_now ? `<button type="button" class="sanad-ae__link" data-act="run_now">${esc(__("Run it now for every recipient"))}</button>` : ""}
				</div>`);
		}

		draw_history() {
			const s = this.data.stats || {};
			const recent = this.data.recent || [];
			if (!this.draft.name) return this.$root.find("[data-slot=history]").html("");
			const tone = { Read: "ok", Delivered: "ok", Sent: "info", Queued: "muted", Sending: "muted", Failed: "danger", Cancelled: "muted" };
			this.$root.find("[data-slot=history]").html(`
				<div class="sanad-ae__hist">
					<div class="sanad-ae__side-head"><strong>${esc(__("What it has done"))}</strong></div>
					<dl class="sanad-ae__facts">
						<div><dt>${esc(__("Sent"))}</dt><dd>${esc(sanad.ui.format_int(s.send_count || 0))}</dd></div>
						<div><dt>${esc(__("Last sent"))}</dt><dd>${esc(s.last_sent_at ? frappe.datetime.str_to_user(s.last_sent_at) : "—")}</dd></div>
					</dl>
					${s.last_error ? `<div class="sanad-ae__note sanad-ae__note--danger">${sanad.ui.ico("error", "sm")}<span>${esc(s.last_error)}</span></div>` : ""}
					${
						recent.length
							? `<ul class="sanad-ae__recent">${recent
									.map(
										(r) => `<li><span dir="ltr">${esc(r.display_name || r.phone_e164)}</span>${sanad.ui.badge(__(r.status), tone[r.status] || "muted")}<time>${esc(frappe.datetime.comment_when(r.creation, true))}</time></li>`
									)
									.join("")}</ul>`
							: ""
					}
				</div>`);
		}

		draw_head_state() {
			const d = this.draft;
			this.$root.find("[data-slot=dirty]").prop("hidden", !this.is_dirty());
			this.$root.find("[data-slot=enabled-label]").text(d.enabled ? __("On") : __("Off"));
		}

		draw_foot() {
			const d = this.draft;
			const p = this.ui.preview;
			const hint = p && p.problem ? p.problem : this.is_dirty() ? __("Changes are not saved yet") : d.name ? __("Saved") : "";
			this.$root.find("[data-slot=foot]").html(`
				${d.name && this.data.can_delete && this.opts.remove ? `<button type="button" class="sanad-ae__btn sanad-ae__btn--danger" data-act="delete">${sanad.ui.ico("trash", "sm")}${esc(__("Delete"))}</button>` : ""}
				<span class="sanad-ae__foot-hint${p && p.problem ? " is-warn" : ""}">${esc(hint)}</span>
				<button type="button" class="sanad-ae__btn" data-act="close">${esc(__("Cancel"))}</button>
				<button type="button" class="sanad-ae__btn sanad-ae__btn--pri" data-act="save"${(!this.is_dirty() && d.name) || this.ui.saving || !this.data.can_write ? " disabled" : ""}>${esc(this.ui.saving ? __("Saving…") : d.name ? __("Save") : __("Create alert"))}</button>`);
		}

		// ---- events --------------------------------------------------------------------------------

		on_act(e) {
			const $t = $(e.currentTarget);
			const act = $t.data("act");
			const value = $t.attr("data-value");
			const i = cint($t.attr("data-i"));
			const d = this.draft;
			if (act.startsWith("rf_mode:")) {
				const field = act.slice(8);
				if (value === "moving") {
					d.rf.tokens[field] = "today";
					delete d.rf.values[field];
				} else delete d.rf.tokens[field];
				return this.changed({ redraw: ["filters"] });
			}
			if (act.startsWith("f_mode:")) {
				d.filters[cint(act.split(":")[1])].mode = value;
				return this.changed({ redraw: ["filters"] });
			}
			switch (act) {
				case "close":
					return this.close();
				case "content":
					d.content_type = value;
					return this.changed({ redraw: ["what", "who"] });
				case "format":
					d.attachment_format = value;
					return this.changed({ redraw: ["what"] });
				case "body":
					d.body_mode = value;
					return this.changed({ redraw: ["what"] });
				case "json":
					const mode = this.ui.filter_mode;
			if (mode === "builder") {
				out.filters_json = d.builder && d.builder.length ? JSON.stringify(d.builder) : null;
				out.dynamic_filters_json = null;
			} else if (mode === "report") {
				const values = {};
				Object.entries(d.rf.values || {}).forEach(([k, v]) => {
					if (d.rf.tokens[k] || v === "" || v == null || (Array.isArray(v) && !v.length)) return;
					values[k] = v;
				});
				out.filters_json = Object.keys(values).length ? JSON.stringify(values) : null;
				out.dynamic_filters_json = Object.keys(d.rf.tokens || {}).length ? JSON.stringify(d.rf.tokens) : null;
			} else if (this.ui.json_mode || d.filters_raw) {
						const back = this.parse_filters((d.filters_raw || {}).filters_json, (d.filters_raw || {}).dynamic_filters_json);
						if (back.raw) return frappe.show_alert({ message: __("These filters use operators that rows cannot show; keep them as JSON."), indicator: "orange" });
						d.filters = back.rows;
						d.filters_raw = null;
						this.ui.json_mode = false;
					} else {
						const p = this.payload();
						d.filters_raw = { filters_json: p.filters_json || "", dynamic_filters_json: p.dynamic_filters_json || "" };
						this.ui.json_mode = true;
					}
					return this.changed({ redraw: ["what"], preview: false });
				case "f_add":
					d.filters.push({ field: "", mode: "value", value: "", token: "today", n: 7 });
					this.changed({ redraw: ["filters"], preview: false });
					return this.$root.find(`[data-in=f_field][data-i=${d.filters.length - 1}]`).trigger("focus");
				case "f_remove":
					d.filters.splice(i, 1);
					return this.changed({ redraw: ["filters"] });
				case "var":
					return this.insert_var((this.data.variables || [])[cint(value)]);
				case "unpick":
					d[$t.data("kind")] = null;
					if ($t.data("kind") === "report") {
						this.ui.columns = null;
						this.ui.columns_for = null;
						this.ui.filter_mode = null;
					}
					this.ui.pick_open = $t.data("kind");
					this.ui.add_q = "";
					this.ui.results = [];
					this.changed({ redraw: ["what", "who"] });
					this.$root.find(`[data-in=pick_q][data-kind=${$t.data("kind")}]`).trigger("focus");
					return this.run_search();
				case "pick":
					return this.pick($t.data("kind"), this.ui.results[i]);
				case "add_column":
					if (d.recipients.some((r) => r.report_column === value)) return;
					d.recipients.push({ recipient_type: "Report Column", report_column: value });
					this.ui.labels[`Report Column:${value}`] = __(((this.ui.columns || []).find((c) => c.fieldname === value) || {}).label || value);
					return this.changed({ redraw: ["who"] });
				case "pick_contacts":
					return this.pick_contacts();
				case "r_clear":
					d.recipients = d.recipients.filter((r) => r.recipient_type !== "Phone");
					return this.changed({ redraw: ["who"] });
				case "r_remove":
					d.recipients.splice(i, 1);
					return this.changed({ redraw: ["who"] });
				case "test":
					return this.send_test();
				case "run_now":
					return this.run_now();
				case "save":
					return this.save();
				case "delete":
					return this.remove();
			}
		}

		on_input(e) {
			const $t = $(e.currentTarget);
			const key = $t.data("in");
			const i = cint($t.attr("data-i"));
			const d = this.draft;
			const v = $t.val();
			switch (key) {
				case "alert_name":
					d.alert_name = v;
					return this.changed();
				case "notification_time":
					d.notification_time = v;
					this.draw_sentence();
					return this.changed();
				case "message":
					d.message = v;
					return this.changed();
				case "f_field":
					d.filters[i].field = v;
					return this.changed();
				case "f_value":
					d.filters[i].value = v;
					return this.changed();
				case "rf_n": {
					const field = $t.data("field");
					d.rf.tokens[field] = String(d.rf.tokens[field] || "last_days:7").replace(/:\d+$/, `:${Math.max(1, cint(v))}`);
					return this.changed();
				}
				case "f_n":
					d.filters[i].n = cint(v);
					return this.changed();
				case "raw_static":
				case "raw_dynamic":
					d.filters_raw = d.filters_raw || { filters_json: "", dynamic_filters_json: "" };
					d.filters_raw[key === "raw_static" ? "filters_json" : "dynamic_filters_json"] = v;
					return this.changed();
				case "pick_q":
					this.ui.pick_open = $t.data("kind");
					this.ui.add_q = v;
					this.ui.searching = true;
					return this.search_later();
				case "test_phone":
					this.ui.test_phone = v;
					return;
			}
		}

		on_change(e) {
			const $t = $(e.currentTarget);
			const key = $t.data("ch");
			const d = this.draft;
			if (["periodicity", "day_of_week", "day_of_month", "month_of_year"].includes(key)) {
				d[key] = key === "day_of_month" ? cint($t.val()) : $t.val();
				this.changed({ redraw: key === "periodicity" ? ["when"] : [] });
				return this.draw_sentence();
			}
			if (key === "enabled") {
				d.enabled = $t.is(":checked") ? 1 : 0;
				return this.changed({ preview: false });
			}
			if (key === "template") {
				d.template = $t.val() || null;
				return this.changed({ redraw: ["what"] });
			}
			if (key === "rf_token") {
				const v = $t.val();
				d.rf.tokens[$t.data("field")] = v.endsWith(":N") ? v.replace(":N", ":7") : v;
				return this.changed({ redraw: ["filters"] });
			}
			if (key === "f_token") {
				d.filters[cint($t.attr("data-i"))].token = $t.val();
				return this.changed({ redraw: ["filters"] });
			}
		}

		on_key(e) {
			if (e.key === "Escape") {
				if (this.ui.pick_open) {
					e.stopPropagation();
					return this.close_pick();
				}
				if ($(".modal.show").length) return;
				e.stopPropagation();
				return this.close();
			}
			if (e.key === "Enter") {
				const $t = $(e.target);
				if ($t.is("[data-in=pick_q]") && this.ui.results.length) {
					e.preventDefault();
					return this.pick($t.data("kind"), this.ui.results[0]);
				}
				if ($t.is("[data-in=test_phone]")) {
					e.preventDefault();
					return this.send_test();
				}
			}
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
				e.preventDefault();
				return this.save();
			}
			if (e.key === "ArrowDown" && $(e.target).is("[data-in=pick_q]")) {
				e.preventDefault();
				this.$root.find(".sanad-ae__opt").first().trigger("focus");
			}
		}

		// ---- actions -------------------------------------------------------------------------------

		close_pick() {
			const kind = this.ui.pick_open;
			this.ui.pick_open = null;
			this.ui.results = [];
			this.$root.find(`[data-in=pick_q][data-kind=${kind}]`).attr("aria-expanded", "false").siblings(".sanad-ae__results").remove();
		}

		async run_search() {
			const kind = this.ui.pick_open;
			if (!kind) return;
			const search_kind = kind;
			const q = this.ui.add_q;
			try {
				const rows = await this.opts.search(search_kind, q);
				if (this.ui.pick_open !== kind || this.ui.add_q !== q) return;
				this.ui.results = rows || [];
			} catch (err) {
				this.ui.results = [];
			}
			this.ui.searching = false;
			const $pick = this.$root.find(`[data-in=pick_q][data-kind=${kind}]`).closest(".sanad-ae__pick");
			$pick.find(".sanad-ae__results").remove();
			$pick.append(this.results_html(kind));
			$pick.find("input").attr("aria-expanded", "true");
		}

		pick(kind, row) {
			if (!row) return;
			const d = this.draft;
			this.ui.pick_open = null;
			this.ui.results = [];
			this.ui.add_q = "";
			d[kind] = row.value;
			this.ui.labels[`${kind}:${row.value}`] = row.description;
			if (kind === "report") {
				// a new report brings its own filters
				d.rf = { values: {}, tokens: {} };
				d.builder = null;
				d.filters = [];
				d.filters_raw = null;
				this.ui.json_mode = false;
				this.ui.report_defs = null;
				this.ui.filter_mode = "loading";
				this.load_report_filters();
				if (!d.alert_name.trim()) {
					d.alert_name = row.label;
					this.$root.find("[data-in=alert_name]").val(row.label);
				}
				this.load_columns();
			}
			this.changed({ redraw: ["what", "who"] });
		}

		insert_var(v) {
			if (!v) return;
			const el = this.$root.find("[data-in=message]").get(0);
			if (!el) return;
			const start = el.selectionStart ?? el.value.length;
			const end = el.selectionEnd ?? el.value.length;
			el.value = el.value.slice(0, start) + v.code + el.value.slice(end);
			el.focus();
			el.selectionStart = el.selectionEnd = start + v.code.length;
			this.draft.message = el.value;
			this.changed();
		}

		async load_columns() {
			const d = this.draft;
			if (!d.report || !this.opts.report_columns) return;
			if (this.ui.columns_for === d.report && this.ui.columns) return;
			this.ui.columns = null;
			this.ui.columns_for = d.report;
			try {
				const filters = JSON.parse(this.payload().filters_json || "{}");
				this.ui.columns = (await this.opts.report_columns(d.report, filters)) || [];
			} catch (err) {
				this.ui.columns = [];
			}
			this.draw_who();
		}

		async run_preview() {
			if (!this.draft) return;
			const seq = (this.preview_seq = (this.preview_seq || 0) + 1);
			this.ui.previewing = true;
			this.draw_status();
			try {
				const result = await this.opts.preview(this.payload());
				if (seq !== this.preview_seq) return;
				this.ui.preview = result || {};
			} catch (err) {
				if (seq !== this.preview_seq) return;
				this.ui.preview = { problem: err && err.message ? err.message : __("The preview could not run"), next_runs: [] };
			}
			this.ui.previewing = false;
			this.draw_preview();
			this.draw_next();
			this.draw_foot();
			// the step header of "who" carries how many numbers the recipients became
			const $who = this.$root.find("[data-step=who] .sanad-ae__step-title");
			const count = this.ui.preview.recipients_count;
			$who.find("span").remove();
			if (count != null && this.draft.recipients.length) {
				$who.append(`<span>${esc(sanad.ui.plural(count, { one: __("Reaches {0} number"), other: __("Reaches {0} numbers") }))}</span>`);
			}
		}

		async send_test() {
			const phone = (this.ui.test_phone || "").trim();
			if (!phone) {
				this.$root.find("[data-in=test_phone]").trigger("focus");
				return frappe.show_alert({ message: __("Enter the number to send the test to"), indicator: "orange" });
			}
			this.ui.testing = true;
			this.draw_test();
			try {
				const r = await this.opts.send_test(this.payload(), phone);
				frappe.show_alert({ message: __("Test sent to {0}", [r && r.phone_e164 ? r.phone_e164 : phone]), indicator: "green" });
			} catch (err) {
				frappe.show_alert({ message: err && err.message ? err.message : __("The test could not be sent"), indicator: "red" });
			}
			this.ui.testing = false;
			this.draw_test();
		}

		run_now() {
			const d = this.draft;
			if (this.is_dirty()) return frappe.show_alert({ message: __("Save the changes first; a run uses the saved alert."), indicator: "orange" });
			frappe.confirm(__("Run {0} now for every recipient? The schedule is not changed.", [d.alert_name]), async () => {
				try {
					await this.opts.run_now(d.name);
					frappe.show_alert({ message: __("The alert is running in the background"), indicator: "green" });
				} catch (err) {
					frappe.show_alert({ message: err && err.message ? err.message : __("Something went wrong. Please try again."), indicator: "red" });
				}
			});
		}

		async save() {
			if (this.ui.saving || !this.data.can_write) return;
			const d = this.draft;
			if (!d.alert_name.trim()) {
				this.$root.find("[data-in=alert_name]").trigger("focus");
				return frappe.show_alert({ message: __("Name the alert first"), indicator: "orange" });
			}
			this.ui.saving = true;
			this.draw_foot();
			try {
				const r = await this.opts.save(this.payload());
				const was_new = !d.name;
				d.name = r.name;
				d.alert_name = r.name;
				this.clean = JSON.stringify(d);
				frappe.show_alert({ message: was_new ? __("Alert created") : __("Alert saved"), indicator: "green" });
				this.opts.on_saved && this.opts.on_saved(r);
				// the saved alert's own state (next run, counters, what it can do)
				this.data = await this.opts.load(r.name);
				this.draft = this.seed(this.data.alert);
				this.clean = JSON.stringify(this.draft);
				this.ui.saving = false;
				this.ui.filter_mode = null;
				this.render();
				this.run_preview();
				if (this.draft.report) this.load_report_filters();
			} catch (err) {
				this.ui.saving = false;
				this.draw_foot();
				frappe.show_alert({ message: err && err.message ? err.message : __("Could not save"), indicator: "red" });
			}
		}

		remove() {
			const d = this.draft;
			frappe.confirm(__("Delete {0}? The messages it already sent stay in the log.", [d.alert_name]), async () => {
				try {
					await this.opts.remove(d.name);
					frappe.show_alert({ message: __("Alert deleted"), indicator: "green" });
					this.opts.on_saved && this.opts.on_saved({ name: d.name, deleted: true });
					this.close(true);
				} catch (err) {
					frappe.show_alert({ message: err && err.message ? err.message : __("Could not delete"), indicator: "red" });
				}
			});
		}
	}

	sanad.ui.AlertEditor = AlertEditor;
})();

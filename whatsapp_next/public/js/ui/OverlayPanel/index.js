// sanad.ui.OverlayPanel — the design prototype's overlay panel (`docs/component/Overlay Panel.dc.html`),
// ported as a component.
//
// The prototype calls it "the same language as the table: type, width, content and actions all
// from one object". A screen hands it one object and gets back a modal (centred, 12 px radius) or
// a drawer (a side sheet) whose header names the record, whose body is either a form of sections
// or a record's detail (an alert, a facts grid, list and text blocks), and whose footer carries
// the verbs — start-aligned ones at the start, the rest at the end, a primary that stays disabled
// until something changed when the panel asked for that.
//
// Field types are the prototype's: `text`, `number`, `email`, `textarea`, `select`, `segment`,
// `toggle`, `readonly`, `list` (rows with a head, a tag, a remove and an add row that can search
// the server), `choice` (a searchable grid of options), `phone` (the kit's own PhoneField) and
// `html` (a render callback). Values are tracked against the initial ones, so the header shows
// "Unsaved changes" and `requires_dirty` actions wake up exactly when the prototype says.
//
// Nothing here knows the host app: every colour is a token, every label goes through `__()`, and
// the panel talks to the world only through the callbacks it was given.

import ui from "../_core/index.js";
import kit from "../_kit/index.js";

const esc = (v) => ui.escape(v);
const TONES = ["ok", "warn", "danger", "info", "muted", "pri"];
const tone_of = (t) => (TONES.includes(t) ? t : "muted");

sanad.ui.OverlayPanel = class OverlayPanel {
	/**
	 * @param {Object} opts
	 * @param {"modal"|"drawer"} [opts.type="modal"]
	 * @param {string} [opts.width] — CSS width (`"44%"`, `"560px"`); a modal never exceeds the viewport
	 * @param {"start"|"end"} [opts.side="end"] — drawer only
	 * @param {string} opts.title
	 * @param {string} [opts.subtitle]
	 * @param {boolean} [opts.subtitle_mono] — an id or a number: monospace, left to right
	 * @param {{text: string, tone?: string}} [opts.badge]
	 * @param {Array<Object>} [opts.sections] — form content: `{title?, note?, note_tone?, cols?, fields[]}`
	 * @param {Object} [opts.detail] — record content: `{alert?, facts?, blocks?}`
	 * @param {Array<Object>} [opts.actions] — `{key, label, variant?, align?, close?, requires_dirty?, handler?(values, panel)}`
	 * @param {Function} [opts.on_change] — `(key, value, panel)`
	 * @param {Function} [opts.on_close]
	 * @param {boolean} [opts.close_on_backdrop=true]
	 * @param {boolean} [opts.compact] — the prototype's compact density
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({ type: "modal", side: "end", close_on_backdrop: true, actions: [] }, opts);
		this.id = ui.uid("sanad-op");
		this.values = {};
		this.initial = {};
		this.fields = new Map(); // key → { df, $el, control? }
		this.errors = new Map();
		this.open = false;
		this.make();
	}

	// ---- shell ---------------------------------------------------------------------------------

	make() {
		const o = this.opts;
		const drawer = o.type === "drawer";
		this.$backdrop = $(`<div class="sanad-op-backdrop" hidden></div>`).appendTo(document.body);
		this.$root = $(`
			<section class="sanad-kit sanad-op wa ${o.compact ? "wa--compact" : ""} sanad-op--${drawer ? "drawer" : "modal"} ${
				drawer ? `sanad-op--${o.side === "start" ? "start" : "end"}` : ""
			}" role="dialog" aria-modal="true" aria-labelledby="${this.id}-title" hidden>
				<header class="sanad-op__head">
					<div class="sanad-op__heading">
						<h2 class="sanad-op__title" id="${this.id}-title">${esc(o.title || "")}</h2>
						<div class="sanad-op__meta">
							${o.subtitle ? `<span class="sanad-op__subtitle${o.subtitle_mono ? " sanad-op__subtitle--mono" : ""}"${o.subtitle_mono ? ' dir="ltr"' : ""}>${esc(o.subtitle)}</span>` : ""}
							<span class="sanad-op__badge"></span>
							<span class="sanad-op__dirty" hidden>${esc(__("Unsaved changes"))}</span>
						</div>
					</div>
					<button type="button" class="sanad-op__close" aria-label="${esc(__("Close"))}" title="${esc(__("Close (Esc)"))}">${kit.ico("x", "sm")}</button>
				</header>
				<div class="sanad-op__body"></div>
				<footer class="sanad-op__foot" hidden>
					<div class="sanad-op__foot-start"></div>
					<div class="sanad-op__foot-end"></div>
				</footer>
			</section>`).appendTo(document.body);
		if (o.width) this.$root.css("--sanad-op-width", o.width);
		this.$body = this.$root.find(".sanad-op__body");
		this.set_badge(o.badge);
		this.render_body();
		this.render_actions();
		this.$root.find(".sanad-op__close").on("click", () => this.hide());
		this.$backdrop.on("click", () => this.opts.close_on_backdrop !== false && this.hide());
		this.$root.on("keydown", (e) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				this.hide();
			}
		});
	}

	set_badge(badge) {
		const $b = this.$root.find(".sanad-op__badge");
		if (!badge || !badge.text) return $b.prop("hidden", true).empty();
		$b.prop("hidden", false).html(kit.badge(badge.text, tone_of(badge.tone)));
	}

	set_title(title, subtitle) {
		this.$root.find(".sanad-op__title").text(title || "");
		if (subtitle !== undefined) this.$root.find(".sanad-op__subtitle").text(subtitle || "");
	}

	// ---- body ----------------------------------------------------------------------------------

	render_body() {
		this.$body.empty();
		this.fields.clear();
		this.errors.clear();
		this.$summary = $(`<div class="sanad-op__summary" role="alert" tabindex="-1" hidden></div>`).appendTo(this.$body);
		if (this.opts.detail) this.render_detail(this.opts.detail);
		(this.opts.sections || []).forEach((s) => this.render_section(s));
		this.initial = Object.assign({}, this.values);
		this.update_dirty();
	}

	// ---- the record's detail: alert · facts · blocks -------------------------------------------

	render_detail(d) {
		if (d.alert) {
			const tone = tone_of(d.alert.tone);
			const lines = [].concat(d.alert.lines || d.alert.text || []).filter(Boolean);
			$(`<div class="sanad-op__alert sanad-op__alert--${tone}" role="${tone === "danger" ? "alert" : "status"}">
				<span class="sanad-op__alert-title">${esc(d.alert.title || "")}</span>
				${lines.map((l) => `<span class="sanad-op__alert-line">${esc(l)}</span>`).join("")}
			</div>`).appendTo(this.$body);
		}
		if ((d.facts || []).length) {
			const $facts = $(`<dl class="sanad-op__facts"></dl>`).appendTo(this.$body);
			d.facts.forEach((f) => {
				const html = f.html != null ? f.html : esc(f.v == null || f.v === "" ? "—" : f.v);
				$facts.append(`<div class="sanad-op__fact"><dt>${esc(f.k)}</dt><dd class="${f.mono ? "sanad-op__mono" : ""}${
					f.tone ? ` sanad-op__fact--${tone_of(f.tone)}` : ""
				}"${f.mono ? ' dir="ltr"' : ""}>${html}</dd></div>`);
			});
		}
		(d.blocks || []).forEach((b) => this.render_block(b));
	}

	/** One block: a labelled list of items (`text`, `sub`, `badge`, `avatar`) or a text panel. */
	render_block(b) {
		const $block = $(`<section class="sanad-op__block"><header class="sanad-op__block-head"><span class="sanad-op__block-label">${esc(
			b.label || ""
		)}</span>${b.more ? `<span class="sanad-op__block-more">${esc(b.more)}</span>` : ""}</header><div class="sanad-op__block-body"></div></section>`).appendTo(
			this.$body
		);
		const $body = $block.find(".sanad-op__block-body");
		if (typeof b.render === "function") {
			b.render($body, this);
			return $block;
		}
		if (Array.isArray(b.list)) {
			if (!b.list.length) {
				$body.html(`<div class="sanad-op__empty">${esc(b.empty || __("Nothing here yet."))}</div>`);
				return $block;
			}
			const $ul = $(`<ul class="sanad-op__list"></ul>`).appendTo($body);
			b.list.forEach((it) => {
				$ul.append(`<li class="sanad-op__item">
					${it.avatar != null ? kit.avatar({ text: it.avatar, size: "sm", square: true }) : ""}
					<span class="sanad-op__item-main">
						<span class="sanad-op__item-text">${esc(it.text)}</span>
						${it.sub ? `<span class="sanad-op__item-sub${it.sub_mono ? " sanad-op__mono" : ""}"${it.sub_mono ? ' dir="ltr"' : ""}>${esc(it.sub)}</span>` : ""}
					</span>
					${it.badge ? kit.badge(it.badge, tone_of(it.badge_tone), { dot: false }) : ""}
				</li>`);
			});
			return $block;
		}
		$body.html(`<div class="sanad-op__text${b.tone ? ` sanad-op__text--${tone_of(b.tone)}` : ""}">${esc(b.text || "")}</div>`);
		return $block;
	}

	// ---- form sections -------------------------------------------------------------------------

	render_section(s) {
		const $s = $(`<section class="sanad-op__section"></section>`).appendTo(this.$body);
		if (s.title) $s.append(kit.rule(s.title, s.note_end));
		if (s.note) $s.append(`<div class="sanad-op__note sanad-op__note--${tone_of(s.note_tone || "info")}">${esc(s.note)}</div>`);
		const $grid = $(`<div class="sanad-op__grid" style="--sanad-op-cols:${cint(s.cols) || 2}"></div>`).appendTo($s);
		(s.fields || []).forEach((df) => this.render_field(df, $grid));
	}

	render_field(df, $grid) {
		const type = df.type || "text";
		const key = df.key;
		const span = Math.max(1, cint(df.span) || 1);
		const $f = $(`<div class="sanad-op__field wa-field sanad-op__field--${type}" style="grid-column: span ${span}" data-key="${esc(key)}"></div>`).appendTo($grid);
		const label_id = `${this.id}-${key}-label`;
		const ctl_id = `${this.id}-${key}`;
		if (df.label && type !== "phone" && type !== "toggle") {
			$f.append(`<label class="wa-field__label" id="${label_id}" for="${ctl_id}">${esc(df.label)}${df.required ? ' <span class="wa-field__req" aria-hidden="true">*</span>' : ""}</label>`);
		}
		const entry = { df, $el: $f };
		this.fields.set(key, entry);
		let value = df.value;
		const set = (v, { silent } = {}) => {
			this.values[key] = v;
			if (!silent) {
				this.update_dirty();
				this.clear_error(key);
				if (typeof df.on_change === "function") df.on_change(v, this);
				if (typeof this.opts.on_change === "function") this.opts.on_change(key, v, this);
			}
		};

		switch (type) {
			case "readonly": {
				value = df.value == null ? "" : df.value;
				$f.append(`<div class="sanad-op__readonly${df.mono ? " sanad-op__mono" : ""}"${df.mono ? ' dir="ltr"' : ""}>${df.html != null ? df.html : esc(value === "" ? "—" : value)}</div>`);
				break;
			}
			case "textarea": {
				value = df.value == null ? "" : String(df.value);
				const $ta = $(`<textarea class="wa-textarea wa-field__input" id="${ctl_id}" rows="${cint(df.rows) || 3}" placeholder="${esc(df.placeholder || "")}"${
					df.required ? ' aria-required="true"' : ""
				}></textarea>`).appendTo($f);
				$ta.val(value).on("input", () => set($ta.val()));
				entry.$input = $ta;
				break;
			}
			case "select": {
				value = df.value == null ? "" : String(df.value);
				const $sel = $(`<select class="wa-select wa-field__input" id="${ctl_id}"${df.required ? ' aria-required="true"' : ""}></select>`).appendTo($f);
				if (df.placeholder) $sel.append(`<option value="">${esc(df.placeholder)}</option>`);
				(df.options || []).forEach((o) => $sel.append(`<option value="${esc(o.value)}">${esc(o.label)}</option>`));
				$sel.val(value).attr("data-empty", String(!value));
				$sel.on("change", () => {
					$sel.attr("data-empty", String(!$sel.val()));
					set($sel.val());
				});
				entry.$input = $sel;
				break;
			}
			case "segment": {
				value = df.value == null ? "" : df.value;
				const $seg = $(kit.segmented(df.options || [], value, { label: df.label })).appendTo($f);
				kit.bind_segmented($seg, (v) => set(v));
				entry.$input = $seg;
				break;
			}
			case "toggle": {
				value = !!df.value;
				const $t = $(`<label class="wa-toggle"><input type="checkbox" id="${ctl_id}"${value ? " checked" : ""}><span class="wa-toggle__track" aria-hidden="true"></span><span class="wa-toggle__label">${esc(
					df.label || ""
				)}</span></label>`).appendTo($f);
				$t.find("input").on("change", (e) => set(!!e.target.checked));
				entry.$input = $t.find("input");
				break;
			}
			case "phone": {
				const field = new sanad.ui.PhoneField({
					wrapper: $f,
					label: df.label || "",
					required: !!df.required,
					value: df.value || "",
					tip: df.tip,
					on_change: (v) => set(v.phone_e164 || ""),
				});
				const current = field.get_value();
				value = current.phone_e164 || "";
				entry.control = field;
				break;
			}
			case "list": {
				value = Array.isArray(df.value) ? df.value.slice() : [];
				this.render_list(df, $f, entry, (rows) => set(rows));
				break;
			}
			case "link": {
				value = df.value == null ? "" : df.value;
				const link = this.make_link($f, {
					id: ctl_id,
					placeholder: df.placeholder,
					search: df.search,
					value,
					display: df.display,
					required: !!df.required,
					on_pick: (item) => set(item ? item.value : ""),
				});
				entry.$input = link.$input;
				entry.link = link;
				break;
			}
			case "rows": {
				value = Array.isArray(df.value) ? df.value.map((r) => Object.assign({}, r)) : [];
				this.render_rows(df, $f, entry, (rows) => set(rows));
				break;
			}
			case "choice": {
				value = df.value == null ? "" : df.value;
				this.render_choice(df, $f, entry, (v) => set(v));
				break;
			}
			case "html": {
				const $h = $(`<div class="sanad-op__html"></div>`).appendTo($f);
				if (typeof df.render === "function") df.render($h, this);
				value = undefined;
				break;
			}
			default: {
				value = df.value == null ? "" : String(df.value);
				const input_type = type === "number" ? "number" : type === "email" ? "email" : "text";
				const $in = $(`<input class="wa-input wa-field__input${df.mono || type === "number" ? " wa-input--mono" : ""}" id="${ctl_id}" type="${input_type}" placeholder="${esc(
					df.placeholder || ""
				)}"${df.required ? ' aria-required="true"' : ""}${df.maxlength ? ` maxlength="${cint(df.maxlength)}"` : ""}${
					df.autocomplete ? ` autocomplete="${esc(df.autocomplete)}"` : ""
				}>`).appendTo($f);
				$in.val(value).on("input", () => set(type === "number" ? ($in.val() === "" ? "" : Number($in.val())) : $in.val()));
				entry.$input = $in;
			}
		}
		if (df.hint) $f.append(`<span class="wa-field__hint">${esc(df.hint)}</span>`);
		if (value !== undefined) this.values[key] = value;
		return $f;
	}

	/**
	 * The prototype's list field: a bordered table with a sticky head, rows of `text` (mono) ·
	 * `sub` · `meta` · `tag` · remove, and, under it, an add row on a sunken strip. `add.search`
	 * turns the add input into a lookup — the typed text is sent to the server and the answers
	 * are offered in a listbox, because a ledger account has to be a real record.
	 */
	render_list(df, $f, entry, set) {
		const $wrap = $(`<div class="sanad-op__listfield"></div>`).appendTo($f);
		const $table = $(`<div class="sanad-op__table" style="--sanad-op-rowcols:${esc(df.row_cols || "minmax(0,1fr) auto 24px")}"${
			df.max_height ? ` data-maxh="1"` : ""
		}></div>`).appendTo($wrap);
		if (df.max_height) $table.css("max-block-size", df.max_height);
		const rows = () => entry.rows;
		entry.rows = Array.isArray(df.value) ? df.value.slice() : [];

		const draw = () => {
			$table.empty();
			if (Array.isArray(df.head) && df.head.length) {
				$table.append(`<div class="sanad-op__thead">${df.head.map((h) => `<span>${esc(h)}</span>`).join("")}</div>`);
			}
			if (!rows().length) {
				$table.append(`<div class="sanad-op__trow sanad-op__trow--empty">${esc(df.empty || __("No rows."))}</div>`);
			}
			rows().forEach((r, i) => {
				const $r = $(`<div class="sanad-op__trow"></div>`).appendTo($table);
				(df.columns || ["text", "sub", "tag", "remove"]).forEach((col) => {
					if (col === "remove") {
						$r.append(
							`<button type="button" class="sanad-op__trow-remove" data-index="${i}" aria-label="${esc(
								__("Remove {0}", [r.text || r.sub || ""])
							)}" title="${esc(__("Remove"))}">${kit.ico("x", "xs")}</button>`
						);
					} else if (col === "tag") {
						$r.append(`<span class="sanad-op__trow-tag">${r.tag ? kit.badge(r.tag, tone_of(r.tag_tone || "info"), { dot: false }) : ""}</span>`);
					} else if (col === "text") {
						$r.append(`<span class="sanad-op__trow-text${r.text_mono === false ? "" : " sanad-op__mono"}"${r.text_mono === false ? "" : ' dir="ltr"'}>${esc(r.text || "")}</span>`);
					} else {
						$r.append(`<span class="sanad-op__trow-${esc(col)}">${esc(r[col] || "")}</span>`);
					}
				});
			});
			if (typeof df.on_rows === "function") df.on_rows(rows(), this);
		};
		$table.on("click", ".sanad-op__trow-remove", (e) => {
			const i = cint($(e.currentTarget).data("index"));
			entry.rows = rows().filter((_, ix) => ix !== i);
			draw();
			set(entry.rows.slice());
		});
		draw();

		if (df.add) {
			const add = df.add;
			const $add = $(`<div class="sanad-op__tadd" role="group" aria-label="${esc(add.label || __("Add"))}"></div>`).appendTo($wrap);
			const $q = $(`<input type="text" class="sanad-op__tadd-input" placeholder="${esc(add.placeholder || "")}" aria-label="${esc(add.placeholder || add.label || __("Add"))}" autocomplete="off">`).appendTo($add);
			let $type = null;
			if (Array.isArray(add.options) && add.options.length) {
				$type = $(`<select class="sanad-op__tadd-type" aria-label="${esc(add.type_label || __("Type"))}"></select>`).appendTo($add);
				add.options.forEach((o) => $type.append(`<option value="${esc(o.value)}">${esc(o.label)}</option>`));
			}
			const $btn = $(`<button type="button" class="sanad-op__tadd-btn">${esc(add.label || __("Add"))}</button>`).appendTo($add);
			const $list = $(`<ul class="sanad-op__tadd-list" role="listbox" hidden></ul>`).appendTo($add);
			let suggestions = [];
			let active = -1;
			const chosen = { current: null };

			const commit = (item) => {
				const type_value = $type ? $type.val() : null;
				const row = typeof add.on_add === "function" ? add.on_add(item, type_value, rows()) : item;
				if (!row) return;
				if (row.then) {
					row.then((r) => r && push(r));
					return;
				}
				push(row);
			};
			const push = (row) => {
				entry.rows = rows().concat([row]);
				draw();
				set(entry.rows.slice());
				$q.val("");
				chosen.current = null;
				hide_list();
				$q.trigger("focus");
			};
			const hide_list = () => {
				$list.prop("hidden", true).empty();
				$q.attr("aria-expanded", "false");
				active = -1;
			};
			const show_list = () => {
				$list.empty();
				if (!suggestions.length) {
					$list.append(`<li class="sanad-op__tadd-empty">${esc(add.empty || __("No match."))}</li>`);
				}
				suggestions.forEach((s, i) => {
					$list.append(`<li class="sanad-op__tadd-opt" role="option" id="${this.id}-opt-${i}" data-index="${i}" aria-selected="${i === active}">
						<span class="sanad-op__tadd-opt-label">${esc(s.label)}</span>${s.note ? `<span class="sanad-op__tadd-opt-note sanad-op__mono" dir="ltr">${esc(s.note)}</span>` : ""}
					</li>`);
				});
				$list.prop("hidden", false);
				$q.attr("aria-expanded", "true");
			};
			const search = ui.debounce(() => {
				if (typeof add.search !== "function") return;
				const txt = $q.val();
				Promise.resolve(add.search(txt, $type ? $type.val() : null))
					.then((items) => {
						suggestions = items || [];
						active = suggestions.length ? 0 : -1;
						show_list();
					})
					.catch(() => {
						suggestions = [];
						show_list();
					});
			}, 220);
			if (typeof add.search === "function") {
				$q.attr({ role: "combobox", "aria-autocomplete": "list", "aria-expanded": "false" });
				$q.on("input focus", () => search());
				$type && $type.on("change", () => search());
			}
			$q.on("keydown", (e) => {
				if (e.key === "ArrowDown" && suggestions.length) {
					e.preventDefault();
					active = (active + 1) % suggestions.length;
					show_list();
				} else if (e.key === "ArrowUp" && suggestions.length) {
					e.preventDefault();
					active = (active - 1 + suggestions.length) % suggestions.length;
					show_list();
				} else if (e.key === "Enter") {
					e.preventDefault();
					if (typeof add.search === "function") {
						if (active >= 0 && suggestions[active]) commit(suggestions[active]);
					} else if ($q.val().trim()) {
						commit({ value: $q.val().trim(), label: $q.val().trim() });
					}
				} else if (e.key === "Escape" && !$list.prop("hidden")) {
					e.stopPropagation();
					hide_list();
				}
			});
			$list.on("mousedown", ".sanad-op__tadd-opt", (e) => {
				e.preventDefault();
				commit(suggestions[cint($(e.currentTarget).data("index"))]);
			});
			$q.on("blur", () => window.setTimeout(hide_list, 120));
			$btn.on("click", () => {
				if (typeof add.search === "function") {
					if (active >= 0 && suggestions[active]) commit(suggestions[active]);
					else $q.trigger("focus");
				} else if ($q.val().trim()) {
					commit({ value: $q.val().trim(), label: $q.val().trim() });
				}
			});
			entry.$input = $q;
		}
		entry.get = () => rows().slice();
		entry.set_rows = (next) => {
			entry.rows = (next || []).slice();
			draw();
			set(entry.rows.slice());
		};
	}

	/**
	 * A Link field — the prototype's autocomplete (`docs/component/Form.dc.html`): an input that
	 * looks the typed text up on the server and offers the matches in a list under it, with the
	 * record's title on the first line and its id on the second. Only a listed record can be
	 * chosen: text that was not picked is put back to the last choice on blur, and a cleared
	 * input clears the value. `search(txt)` resolves `[{value, label, note}]`.
	 */
	make_link($host, o = {}) {
		const $wrap = $(`<div class="sanad-op__link"></div>`).appendTo($host);
		const $input = $(`<input type="text" class="wa-input sanad-op__link-input" id="${esc(o.id || ui.uid("sanad-link"))}" role="combobox" aria-autocomplete="list" aria-expanded="false" autocomplete="off" placeholder="${esc(
			o.placeholder || __("Search…")
		)}"${o.required ? ' aria-required="true"' : ""}>`).appendTo($wrap);
		const $clear = $(`<button type="button" class="sanad-op__link-clear" aria-label="${esc(__("Clear"))}" tabindex="-1" hidden>${kit.ico("x", "xs")}</button>`).appendTo($wrap);
		const $pop = $(`<ul class="sanad-op__pop" role="listbox" hidden></ul>`).appendTo($wrap);
		const state = { value: o.value || "", display: o.display || o.value || "", items: [], active: -1, open: false };
		const paint = () => {
			$input.val(state.display);
			$clear.prop("hidden", !state.value);
			$wrap.toggleClass("sanad-op__link--set", !!state.value);
		};
		const close = () => {
			state.open = false;
			$pop.prop("hidden", true).empty();
			$input.attr("aria-expanded", "false").removeAttr("aria-activedescendant");
		};
		const draw = () => {
			$pop.empty();
			if (!state.items.length) $pop.append(`<li class="sanad-op__pop-empty">${esc(__("No match."))}</li>`);
			state.items.forEach((it, i) => {
				const id = `${$input.attr("id")}-opt-${i}`;
				$pop.append(`<li class="sanad-op__pop-item" role="option" id="${id}" data-index="${i}" aria-selected="${i === state.active}">
					<span class="sanad-op__pop-label">${esc(it.label)}</span>
					${it.note && it.note !== it.label ? `<span class="sanad-op__pop-note sanad-op__mono" dir="ltr">${esc(it.note)}</span>` : ""}
				</li>`);
				if (i === state.active) $input.attr("aria-activedescendant", id);
			});
			$pop.prop("hidden", false);
			$input.attr("aria-expanded", "true");
			state.open = true;
		};
		const pick = (item) => {
			state.value = item ? item.value : "";
			state.display = item ? item.label : "";
			paint();
			close();
			o.on_pick && o.on_pick(item);
		};
		const load = ui.debounce(() => {
			if (typeof o.search !== "function") return;
			const txt = $input.val();
			$wrap.attr("aria-busy", "true");
			Promise.resolve(o.search(txt))
				.then((items) => {
					state.items = items || [];
					state.active = state.items.length ? 0 : -1;
					if (document.activeElement === $input[0]) draw();
				})
				.catch(() => {
					state.items = [];
					draw();
				})
				.then(() => $wrap.removeAttr("aria-busy"));
		}, 200);
		$input.on("input", () => {
			if (!$input.val().trim() && state.value) pick(null);
			load();
		});
		$input.on("focus", () => {
			if (!state.value) load();
		});
		$input.on("keydown", (e) => {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				if (!state.open) return load();
				const n = state.items.length;
				if (!n) return;
				state.active = (state.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
				draw();
			} else if (e.key === "Enter") {
				if (state.open && state.items[state.active]) {
					e.preventDefault();
					pick(state.items[state.active]);
				}
			} else if (e.key === "Escape" && state.open) {
				e.stopPropagation();
				close();
				paint();
			}
		});
		$pop.on("mousedown", ".sanad-op__pop-item", (e) => {
			e.preventDefault();
			pick(state.items[cint($(e.currentTarget).data("index"))]);
		});
		// text that was never picked is not a value: the field goes back to what it holds
		$input.on("blur", () => window.setTimeout(() => {
			close();
			paint();
		}, 120));
		$clear.on("click", () => {
			pick(null);
			$input.trigger("focus");
		});
		paint();
		return {
			$input,
			get: () => state.value,
			set: (value, display) => {
				state.value = value || "";
				state.display = display || value || "";
				paint();
			},
		};
	}

	/**
	 * A small editable table: every row is the same set of controls (`select` or `link`) with a
	 * remove at its end, and an "Add" button under it — Frappe's child table drawn with the
	 * prototype's controls. `columns: [{key, label, type, options?, search?(txt, row), width?}]`;
	 * the value is the array of row objects.
	 */
	render_rows(df, $f, entry, set) {
		const cols = df.columns || [];
		const $wrap = $(`<div class="sanad-op__rows" style="--sanad-op-rowcols:${esc(cols.map((c) => c.width || "minmax(0,1fr)").join(" ") + " 32px")}"></div>`).appendTo($f);
		const $head = $(`<div class="sanad-op__rows-head">${cols.map((c) => `<span>${esc(c.label || "")}</span>`).join("")}<span></span></div>`).appendTo($wrap);
		const $body = $(`<div class="sanad-op__rows-body"></div>`).appendTo($wrap);
		const $foot = $(`<div class="sanad-op__rows-foot"></div>`).appendTo($wrap);
		const $add = $(kit.btn({ label: df.add_label || __("Add a row"), icon: "plus", variant: "tonal", size: "sm" })).appendTo($foot);
		entry.rows = Array.isArray(df.value) ? df.value.map((r) => Object.assign({}, r)) : [];
		const emit = () => set(entry.rows.map((r) => Object.assign({}, r)));
		const draw_row = (row, i) => {
			const $r = $(`<div class="sanad-op__row" data-index="${i}"></div>`);
			cols.forEach((c) => {
				const $cell = $(`<div class="sanad-op__cell"></div>`).appendTo($r);
				const id = `${this.id}-${entry.df.key}-${i}-${c.key}`;
				if (c.type === "select") {
					const $sel = $(`<select class="wa-select wa-input" id="${id}" aria-label="${esc(c.label || "")}"></select>`).appendTo($cell);
					(c.options || []).forEach((opt) => $sel.append(`<option value="${esc(opt.value)}">${esc(opt.label)}</option>`));
					if (row[c.key] == null && c.options && c.options.length) row[c.key] = c.options[0].value;
					$sel.val(row[c.key]);
					$sel.on("change", () => {
						row[c.key] = $sel.val();
						(c.resets || []).forEach((k) => {
							row[k] = "";
							if (row[`${k}_title`] !== undefined) row[`${k}_title`] = "";
							const link = $r.data(`link-${k}`);
							link && link.set("", "");
						});
						emit();
					});
				} else {
					const link = this.make_link($cell, {
						id,
						placeholder: c.placeholder,
						required: true,
						search: (txt) => (typeof c.search === "function" ? c.search(txt, row) : []),
						value: row[c.key] || "",
						display: row[`${c.key}_title`] || row[c.key] || "",
						on_pick: (item) => {
							row[c.key] = item ? item.value : "";
							row[`${c.key}_title`] = item ? item.label : "";
							$cell.removeClass("wa-field--invalid");
							emit();
						},
					});
					link.$input.attr("aria-label", c.label || "");
					$r.data(`link-${c.key}`, link);
				}
			});
			$(`<button type="button" class="sanad-op__row-remove" aria-label="${esc(__("Remove row {0}", [i + 1]))}" title="${esc(__("Remove"))}">${kit.ico("trash", "xs")}</button>`)
				.on("click", () => {
					entry.rows.splice(i, 1);
					draw();
					emit();
				})
				.appendTo($r);
			return $r;
		};
		const draw = () => {
			$body.empty();
			if (!entry.rows.length) $body.append(`<div class="sanad-op__rows-empty">${esc(df.empty || __("No rows."))}</div>`);
			entry.rows.forEach((row, i) => $body.append(draw_row(row, i)));
			$head.prop("hidden", !entry.rows.length);
		};
		$add.on("click", () => {
			entry.rows.push({});
			draw();
			emit();
			$body.find(".sanad-op__row").last().find("select, input").first().trigger("focus");
		});
		draw();
		entry.get = () => entry.rows.map((r) => Object.assign({}, r));
		entry.set_rows = (rows) => {
			entry.rows = (rows || []).map((r) => Object.assign({}, r));
			draw();
			emit();
		};
		/** A row whose link is still empty is incomplete: mark it and say so. */
		entry.incomplete = () => {
			let bad = 0;
			$body.find(".sanad-op__row").each((i, el) => {
				cols.forEach((c) => {
					if (c.type !== "select" && !entry.rows[i][c.key]) {
						$(el).find(".sanad-op__cell").eq(cols.indexOf(c)).addClass("wa-field--invalid");
						bad += 1;
					}
				});
			});
			return bad;
		};
	}

	/** The prototype's choice grid: a search box above cards, one of which is chosen. */
	render_choice(df, $f, entry, set) {
		const $wrap = $(`<div class="sanad-op__choice"></div>`).appendTo($f);
		const $q = df.searchable !== false
			? $(`<label class="sanad-op__search">${kit.ico("search", "xs")}<input type="text" placeholder="${esc(df.placeholder || __("Search…"))}" aria-label="${esc(df.label || __("Search"))}" autocomplete="off"></label>`).appendTo($wrap)
			: null;
		const $grid = $(`<div class="sanad-op__choices" role="listbox" aria-label="${esc(df.label || "")}" style="--sanad-op-cols:${cint(df.cols) || 2}"></div>`).appendTo($wrap);
		let items = df.options || [];
		let current = df.value == null ? "" : df.value;
		const draw = () => {
			$grid.empty();
			if (!items.length) {
				$grid.append(`<div class="sanad-op__empty sanad-op__empty--dashed">${esc(df.empty || __("No match."))}</div>`);
				return;
			}
			items.forEach((o) => {
				const on = String(o.value) === String(current);
				$grid.append(`<button type="button" class="sanad-op__opt" role="option" aria-selected="${on}" data-value="${esc(o.value)}">
					<span class="sanad-op__opt-label${o.mono ? " sanad-op__mono" : ""}"${o.mono ? ' dir="ltr"' : ""}>${esc(o.label)}</span>
					${o.note ? `<span class="sanad-op__opt-note${o.note_mono ? " sanad-op__mono" : ""}"${o.note_mono ? ' dir="ltr"' : ""}>${esc(o.note)}</span>` : ""}
				</button>`);
			});
		};
		const load = ui.debounce(() => {
			if (typeof df.search !== "function") {
				const q = ($q ? $q.find("input").val() : "").trim().toLowerCase();
				items = (df.options || []).filter((o) => !q || String(o.label).toLowerCase().includes(q) || String(o.note || "").toLowerCase().includes(q));
				draw();
				return;
			}
			$grid.attr("aria-busy", "true");
			Promise.resolve(df.search($q ? $q.find("input").val() : "", this))
				.then((list) => {
					items = list || [];
					draw();
				})
				.catch(() => {
					items = [];
					draw();
				})
				.then(() => $grid.removeAttr("aria-busy"));
		}, 220);
		$grid.on("click", ".sanad-op__opt", (e) => {
			const v = $(e.currentTarget).data("value");
			current = String(v) === String(current) && df.toggle !== false ? "" : v;
			set(current);
			draw();
		});
		$q && $q.find("input").on("input", () => load());
		entry.$input = $q ? $q.find("input") : $grid;
		entry.reload = () => load();
		load();
		draw();
	}

	// ---- values, dirtiness, validation --------------------------------------------------------

	get_values() {
		return Object.assign({}, this.values);
	}

	get_value(key) {
		return this.values[key];
	}

	set_value(key, value, display) {
		const entry = this.fields.get(key);
		this.values[key] = value;
		if (entry) {
			const type = entry.df.type || "text";
			if ((type === "list" || type === "rows") && entry.set_rows) entry.set_rows(value);
			else if (type === "link" && entry.link) entry.link.set(value, display);
			else if (type === "segment") {
				entry.$input.find(".wa-seg__opt").each((_, el) => {
					const on = $(el).data("value") === value;
					$(el).attr("aria-checked", String(on)).attr("tabindex", on ? 0 : -1);
				});
			} else if (type === "phone" && entry.control) entry.control.set_value(value);
			else if (type === "toggle") entry.$input.prop("checked", !!value);
			else if (entry.$input && entry.$input.is("input, select, textarea")) entry.$input.val(value);
		}
		this.update_dirty();
	}

	field(key) {
		return this.fields.get(key);
	}

	is_dirty() {
		const keys = new Set([...Object.keys(this.values), ...Object.keys(this.initial)]);
		return Array.from(keys).some((k) => JSON.stringify(this.values[k] ?? "") !== JSON.stringify(this.initial[k] ?? ""));
	}

	/** Make the current values the baseline — after a save that keeps the panel open. */
	mark_clean() {
		this.initial = JSON.parse(JSON.stringify(this.values));
		this.update_dirty();
	}

	update_dirty() {
		const dirty = this.is_dirty();
		this.$root.find(".sanad-op__dirty").prop("hidden", !dirty);
		this.$root.find("[data-requires-dirty]").prop("disabled", !dirty);
	}

	/** Required fields must hold a value; returns the list of failing labels and marks them. */
	validate() {
		const missing = [];
		this.fields.forEach((entry, key) => {
			const df = entry.df;
			if (df.type === "rows" && entry.incomplete && entry.incomplete()) {
				missing.push({ key, label: df.label || key });
				this.set_error(key, df.incomplete_text || __("Every row needs a value, or remove the row."));
				return;
			}
			if (!df.required) return;
			const v = this.values[key];
			const empty = v == null || v === "" || (Array.isArray(v) && !v.length);
			if (empty) {
				missing.push({ key, label: df.label || key });
				this.set_error(key, __("{0} is required", [df.label || key]));
			}
		});
		if (missing.length) {
			this.$summary
				.prop("hidden", false)
				.html(
					`${esc(__("Fill in the required fields:"))} ${missing
						.map((m) => `<a href="#" data-focus="${esc(m.key)}">${esc(m.label)}</a>`)
						.join(__(", "))}`
				)
				.off("click")
				.on("click", "a[data-focus]", (e) => {
					e.preventDefault();
					this.focus_field($(e.currentTarget).data("focus"));
				})
				.trigger("focus");
		} else {
			this.$summary.prop("hidden", true).empty();
		}
		return missing;
	}

	set_error(key, text) {
		const entry = this.fields.get(key);
		if (!entry) return;
		this.clear_error(key);
		entry.$el.addClass("wa-field--invalid");
		const id = `${this.id}-${key}-err`;
		entry.$el.append(`<span class="wa-field__error" id="${id}">${esc(text)}</span>`);
		if (entry.$input) entry.$input.attr({ "aria-invalid": "true", "aria-describedby": id });
		this.errors.set(key, text);
	}

	clear_error(key) {
		const entry = this.fields.get(key);
		if (!entry) return;
		entry.$el.removeClass("wa-field--invalid").find(".wa-field__error").remove();
		if (entry.$input) entry.$input.removeAttr("aria-invalid").removeAttr("aria-describedby");
		this.errors.delete(key);
		// the summary lists the errors; once the last one is gone it has nothing to say
		if (!this.errors.size && this.$summary) this.$summary.prop("hidden", true).empty();
	}

	/** A server-side failure, shown where the user is looking (the toast is not enough). */
	show_error(err) {
		const text = (err && (err.message || err._server_messages || String(err))) || __("Something went wrong. Try again.");
		this.$summary.prop("hidden", false).text(text).trigger("focus");
	}

	focus_field(key) {
		const entry = this.fields.get(key);
		if (!entry) return;
		if (entry.control && entry.control.$input) entry.control.$input.trigger("focus");
		else if (entry.$input) entry.$input.filter(":visible").first().trigger("focus");
	}

	// ---- actions -------------------------------------------------------------------------------

	render_actions() {
		const actions = (this.opts.actions || []).filter(Boolean);
		const $foot = this.$root.find(".sanad-op__foot").prop("hidden", !actions.length);
		const $start = $foot.find(".sanad-op__foot-start").empty();
		const $end = $foot.find(".sanad-op__foot-end").empty();
		actions.forEach((a) => {
			const $btn = $(
				kit.btn({
					label: a.label,
					icon: a.icon,
					variant: a.variant || "secondary",
					attrs: Object.assign({ "data-key": a.key || "" }, a.requires_dirty ? { "data-requires-dirty": "1" } : {}),
				})
			);
			$btn.on("click", () => this.run(a));
			(a.align === "start" ? $start : $end).append($btn);
		});
		this.update_dirty();
	}

	run(action) {
		// a verb that does something checks the form first; "Cancel" and "Close" never do
		if (typeof action.handler === "function" && action.validate !== false && this.validate().length) return;
		const $btn = this.$root.find(`.sanad-op__foot [data-key="${CSS.escape(action.key || "")}"]`);
		const done = () => $btn.prop("disabled", false).removeClass("wa-btn--busy");
		const after = () => {
			done();
			if (action.close !== false) this.hide();
		};
		if (typeof action.handler !== "function") return after();
		let result;
		try {
			result = action.handler(this.get_values(), this);
		} catch (err) {
			this.show_error(err);
			return done();
		}
		if (result && typeof result.then === "function") {
			$btn.prop("disabled", true).addClass("wa-btn--busy");
			result.then(
				(r) => (r === false ? done() : after()),
				(err) => {
					done();
					if (err && err.message === "cancelled") return;
					this.show_error(err);
				}
			);
		} else if (result !== false) after();
	}

	set_action_disabled(key, disabled) {
		this.$root.find(`.sanad-op__foot [data-key="${CSS.escape(key)}"]`).prop("disabled", !!disabled);
	}

	// ---- open / close --------------------------------------------------------------------------

	show() {
		if (this.open) return this;
		this.open = true;
		this.opener = document.activeElement;
		// a panel that was closed left the document; it comes back for a second showing
		if (!this.$root.parent().length) {
			this.$backdrop.appendTo(document.body);
			this.$root.appendTo(document.body);
		}
		ui.overlay.open(this);
		this.$backdrop.prop("hidden", false);
		this.$root.prop("hidden", false);
		$(document.body).addClass("sanad-op-open");
		window.requestAnimationFrame(() => this.$root.addClass("sanad-op--in"));
		this.untrap = ui.trap_focus(this.$root);
		const $first = this.$root.find(".sanad-op__body").find("input:not([type=hidden]), select, textarea, button, [tabindex='0']").filter(":visible").first();
		($first.length ? $first : this.$root.find(".sanad-op__close")).trigger("focus");
		ui.announce(__("{0} opened.", [this.opts.title || __("Panel")]));
		return this;
	}

	hide() {
		if (!this.open) return this;
		this.open = false;
		this.untrap && this.untrap();
		ui.overlay.close(this);
		this.$root.removeClass("sanad-op--in");
		window.setTimeout(() => {
			this.$root.prop("hidden", true);
			this.$backdrop.prop("hidden", true);
			if (!ui.overlay.current) $(document.body).removeClass("sanad-op-open");
			// out of the document once closed, so a hidden panel's buttons never shadow a live one's
			if (!this.open) {
				this.$root.detach();
				this.$backdrop.detach();
			}
		}, 180);
		if (this.opener && document.contains(this.opener) && this.opener.focus) this.opener.focus();
		if (typeof this.opts.on_close === "function") this.opts.on_close(this);
		return this;
	}

	destroy() {
		const remove = () => {
			this.$root.remove();
			this.$backdrop.remove();
		};
		// a panel that is already closed leaves at once, so its buttons never shadow a new one's
		if (!this.open) return remove();
		this.hide();
		window.setTimeout(remove, 220);
	}

	/** Open one and get it back — `sanad.ui.OverlayPanel.open({...})`. */
	static open(opts) {
		return new OverlayPanel(opts).show();
	}
};

export default sanad.ui.OverlayPanel;

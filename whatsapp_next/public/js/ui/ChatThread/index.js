// sanad.ui.ChatThread — a WhatsApp-style thread over read-layer message rows: bubbles by
// `direction` (outbound inline-end, inbound inline-start — logical properties keep RTL right),
// day separators, time, outbound status ticks (icon + accessible label, never colour alone),
// media rows, a reference chip and a "Load older" button. The caller owns the data (a drawer,
// the Simulator); the thread only renders, keeps the scroll position on prepend and patches
// status ticks in place on realtime updates.

import ui from "../_core/index.js";

const STATUS = {
	Unsent: { icon: "es-line-time", tone: "gray", label: () => __("Not sent yet") },
	Queued: { icon: "es-line-time", tone: "gray", label: () => __("Queued") },
	Sending: { icon: "es-line-time", tone: "gray", label: () => __("Sending") },
	Sent: { icon: "es-line-check", tone: "gray", label: () => __("Sent") },
	Delivered: { icon: "es-line-double-check", tone: "gray", label: () => __("Delivered") },
	Read: { icon: "es-line-double-check", tone: "blue", label: () => __("Read") },
	Failed: { icon: "es-line-close-circle", tone: "red", label: () => __("Failed"), text: true },
	Cancelled: { icon: "es-line-close-circle", tone: "red", label: () => __("Cancelled"), text: true },
	Held: { icon: "es-line-alert-triangle", tone: "amber", label: () => __("Held"), text: true },
};

const MEDIA_ICON = {
	Image: "es-line-image",
	Video: "es-line-video",
	Audio: "es-line-activity",
	Document: "es-line-filetype",
	Sticker: "es-line-emoji",
	Location: "es-line-location",
	Poll: "es-line-bullet-list",
	Contact: "es-line-people",
	Reaction: "es-line-heart",
	Other: "es-line-attachment",
};

const row_key = (row) => `${row.direction || ""}:${row.name}`;

sanad.ui.ChatThread = class ChatThread {
	/**
	 * @param {Object} opts
	 * @param {jQuery|HTMLElement} opts.wrapper
	 * @param {Array<Object>} [opts.rows=[]] — read-layer rows `{direction, name, ts, status, message_type, body, caption, attachment, reference_doctype, reference_name, cursor}` in display order (oldest first)
	 * @param {Function} [opts.on_load_more] — `() => Promise`; renders the "Load older" button
	 * @param {boolean} [opts.has_more=true] — whether "Load older" is shown (with `on_load_more`)
	 * @param {Function} [opts.on_row_click] — `(row) => void`; rows become focusable buttons
	 * @param {string} [opts.highlight] — row `name` to highlight and scroll into view
	 * @param {string} [opts.empty_text] — title of the empty state
	 * @param {string} [opts.empty_description]
	 * @param {number} [opts.max_height] — CSS px; omit when the parent scrolls
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({ rows: [], has_more: true }, opts);
		this.$wrapper = $(this.opts.wrapper);
		this.rows = [];
		this.id = ui.uid("chat");
		this.make();
		this.set_rows(this.opts.rows || []);
	}

	make() {
		this.$root = $(`
			<div class="sanad-kit sanad-chat" id="${this.id}">
				<div class="sanad-chat__top"></div>
				<div class="sanad-chat__scroll" tabindex="0" role="log" aria-label="${ui.escape(__("Conversation"))}">
					<div class="sanad-chat__state"></div>
					<div class="sanad-chat__list"></div>
				</div>
			</div>`);
		if (this.opts.max_height) this.$root.css("max-height", `${cint(this.opts.max_height)}px`);
		this.$wrapper.empty().append(this.$root);
		this.$top = this.$root.find(".sanad-chat__top");
		this.$scroll = this.$root.find(".sanad-chat__scroll");
		this.$list = this.$root.find(".sanad-chat__list");
		this.state = new sanad.ui.EmptyState({ wrapper: this.$root.find(".sanad-chat__state"), state: "empty" });
		this.state.hide();
		this.render_top();
		// Clickable rows: the whole bubble reacts to a mouse click, keyboard users get the explicit
		// "Open" button in the meta line — no interactive content nested inside another control.
		this.$list.on("click", ".sanad-chat__row--clickable", (e) => {
			if ($(e.target).closest("a, button").length && !$(e.target).closest(".sanad-chat__open").length) return;
			e.preventDefault();
			const row = this.get_row($(e.currentTarget).data("key"));
			if (row && this.opts.on_row_click) this.opts.on_row_click(row);
		});
	}

	render_top() {
		this.$top.empty();
		if (!this.opts.on_load_more || !this.opts.has_more) return;
		this.$more = $(
			`<button type="button" class="btn btn-sm btn-default sanad-chat__more">${ui.icon("es-line-up", "xs")} ${ui.escape(__("Load older messages"))}</button>`
		)
			.on("click", () => this.load_more())
			.appendTo(this.$top);
	}

	load_more() {
		if (!this.opts.on_load_more || this._loading) return Promise.resolve();
		this._loading = true;
		const $btn = this.$more;
		$btn.prop("disabled", true).attr("aria-busy", "true").text(__("Loading…"));
		return Promise.resolve(this.opts.on_load_more())
			.catch((err) => sanad.ui.Toast.error(err))
			.then(() => {
				this._loading = false;
				this.render_top();
			});
	}

	/** Show / hide "Load older". */
	set_has_more(has_more) {
		this.opts.has_more = !!has_more;
		this.render_top();
		return this;
	}

	get_row(key) {
		return this.rows.find((r) => row_key(r) === key);
	}

	/** Replace all rows (any order; sorted oldest → newest) and scroll to the bottom. */
	set_rows(rows = []) {
		this.rows = sanad.ui.ChatThread.sort([...(rows || [])]);
		this.render();
		this.scroll_to_bottom();
		if (this.opts.highlight) this.scroll_to(this.opts.highlight);
		return this;
	}

	/** Add older rows above; the visible message stays where it is. */
	prepend(rows = []) {
		const fresh = this.dedupe(rows);
		if (!fresh.length) return 0;
		const el = this.$scroll.get(0);
		const before_height = el.scrollHeight;
		const before_top = el.scrollTop;
		this.rows = sanad.ui.ChatThread.sort(fresh.concat(this.rows));
		this.render();
		el.scrollTop = before_top + (el.scrollHeight - before_height);
		ui.announce(ui.plural(fresh.length, { one: __("{0} older message loaded."), other: __("{0} older messages loaded.") }));
		return fresh.length;
	}

	/** Add newer rows below; scrolls down when the reader was already at the bottom. */
	append(rows = []) {
		const fresh = this.dedupe(rows);
		if (!fresh.length) return 0;
		const at_bottom = this.is_at_bottom();
		this.rows = sanad.ui.ChatThread.sort(this.rows.concat(fresh));
		this.render();
		if (at_bottom) this.scroll_to_bottom();
		return fresh.length;
	}

	dedupe(rows) {
		const seen = new Set(this.rows.map(row_key));
		const fresh = [];
		(rows || []).forEach((r) => {
			if (!r || !r.name || seen.has(row_key(r))) return;
			seen.add(row_key(r));
			fresh.push(r);
		});
		return fresh;
	}

	/** Patch one outbound row's status ticks in place (realtime `wa:message:status`). */
	update_status(name, status) {
		const row = this.rows.find((r) => r.name === name && r.direction !== "Inbound");
		if (!row || !status) return false;
		row.status = status;
		const key = row_key(row);
		const $row = this.$list.children(".sanad-chat__row").filter((i, el) => el.dataset.key === key);
		$row.find(".sanad-chat__status").replaceWith(sanad.ui.ChatThread.status_html(status));
		return true;
	}

	is_at_bottom(threshold = 40) {
		const el = this.$scroll.get(0);
		return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
	}

	scroll_to_bottom() {
		const el = this.$scroll.get(0);
		el.scrollTop = el.scrollHeight;
		return this;
	}

	scroll_to(name) {
		const $row = this.$list.children(".sanad-chat__row").filter((i, el) => el.dataset.name === cstr(name)).first();
		if ($row.length && $row.get(0).scrollIntoView) $row.get(0).scrollIntoView({ block: "center" });
		return this;
	}

	render() {
		if (!this.rows.length) {
			this.$list.empty();
			this.state.empty({
				title: this.opts.empty_text || __("No messages yet"),
				description: this.opts.empty_description,
				action: this.opts.empty_action,
				size: "sm",
			});
			return this;
		}
		this.state.hide();
		let html = "";
		let last_day = null;
		this.rows.forEach((row) => {
			const day = sanad.ui.ChatThread.day_of(row.ts || row.creation);
			if (day.key !== last_day) {
				html += `<div class="sanad-chat__day" role="separator" aria-label="${ui.escape(day.label)}"><span>${ui.escape(day.label)}</span></div>`;
				last_day = day.key;
			}
			html += this.row_html(row);
		});
		this.$list.html(html);
		return this;
	}

	row_html(row) {
		const out = row.direction !== "Inbound";
		const clickable = !!this.opts.on_row_click;
		const highlight = this.opts.highlight && row.name === this.opts.highlight;
		const type = row.message_type || "Text";
		const who = row.display_name || row.key || "";
		const status_label = STATUS[row.status] ? STATUS[row.status].label() : row.status || "";
		const aria = out ? __("Sent message, {0}", [status_label]) : __("Received message from {0}", [who]);
		let inner = "";
		if (type !== "Text" || row.attachment) inner += sanad.ui.ChatThread.media_html(row, { link: !clickable });
		if (row.body) inner += `<div class="sanad-chat__text">${sanad.ui.ChatThread.format(row.body)}</div>`;
		if (row.caption) inner += `<div class="sanad-chat__caption">${sanad.ui.ChatThread.format(row.caption)}</div>`;
		if (!inner) inner = `<div class="sanad-chat__text sanad-chat__text--muted">${ui.escape(__(type))}</div>`;
		if (row.reference_doctype && row.reference_name) {
			const label = `${ui.escape(__(row.reference_doctype))}: ${ui.escape(row.reference_name)}`;
			if (clickable) {
				inner += `<span class="sanad-chat__ref">${ui.icon(ui.icons.link, "xs")}<span>${label}</span></span>`;
			} else {
				const href = frappe.utils.get_form_link(row.reference_doctype, row.reference_name);
				inner += `<a class="sanad-chat__ref" href="${ui.escape(href)}" title="${ui.escape(__("Open {0}", [__(row.reference_doctype)]))}">${ui.icon(ui.icons.link, "xs")}<span>${label}</span></a>`;
			}
		}
		const time = sanad.ui.ChatThread.time_of(row.ts || row.creation);
		const open_btn = clickable
			? `<button type="button" class="btn btn-xs btn-default sanad-chat__open" aria-label="${ui.escape(__("Open message details"))}">${ui.icon(ui.icons.open, "xs")}<span>${ui.escape(__("Open"))}</span></button>`
			: "";
		inner += `<div class="sanad-chat__meta"><time datetime="${ui.escape(time.iso)}" title="${ui.escape(time.full)}">${ui.escape(time.label)}</time>${out ? sanad.ui.ChatThread.status_html(row.status) : ""}${open_btn}</div>`;
		return `<div class="sanad-chat__row sanad-chat__row--${out ? "out" : "in"}${highlight ? " sanad-chat__row--highlight" : ""}${clickable ? " sanad-chat__row--clickable" : ""}" data-key="${ui.escape(row_key(row))}" data-name="${ui.escape(row.name)}" role="group" aria-label="${ui.escape(aria)}"><div class="sanad-chat__bubble">${inner}</div></div>`;
	}

	/** Sort oldest → newest (`ts`, then `name`) — stable for equal timestamps. */
	static sort(rows) {
		return rows.sort((a, b) => {
			const ta = cstr(a.ts || a.creation);
			const tb = cstr(b.ts || b.creation);
			if (ta !== tb) return ta < tb ? -1 : 1;
			return cstr(a.name) < cstr(b.name) ? -1 : cstr(a.name) > cstr(b.name) ? 1 : 0;
		});
	}

	/** Status ticks with an accessible label; icon + (for failure states) a visible word. */
	static status_html(status) {
		const s = STATUS[status] || { icon: "es-line-time", tone: "gray", label: () => __(status || "Queued") };
		const label = s.label();
		return `<span class="sanad-chat__status sanad-chat__status--${s.tone}" role="img" aria-label="${ui.escape(label)}" title="${ui.escape(label)}">${ui.icon(s.icon, "xs")}${s.text ? `<span class="sanad-chat__status-text">${ui.escape(label)}</span>` : ""}</span>`;
	}

	/** Media row; `link: false` renders the attachment name as text (rows that are themselves clickable). */
	static media_html(row, { link = true } = {}) {
		const type = row.message_type || "Other";
		const icon = MEDIA_ICON[type] || MEDIA_ICON.Other;
		const label = __(type);
		if (row.attachment) {
			const file = decodeURIComponent(cstr(row.attachment).split("/").pop() || "") || label;
			const body = `<span class="sanad-chat__media-icon" aria-hidden="true">${ui.icon(icon, "sm")}</span><span class="sanad-chat__media-name">${ui.escape(file)}</span><span class="sanad-chat__media-type">${ui.escape(label)}</span>`;
			if (!link) return `<div class="sanad-chat__media sanad-chat__media--plain">${body}</div>`;
			return `<a class="sanad-chat__media" href="${ui.escape(row.attachment)}" target="_blank" rel="noopener" aria-label="${ui.escape(__("Open {0}: {1}", [label, file]))}">${body}</a>`;
		}
		return `<div class="sanad-chat__media sanad-chat__media--plain"><span class="sanad-chat__media-icon" aria-hidden="true">${ui.icon(icon, "sm")}</span><span class="sanad-chat__media-type">${ui.escape(label)}</span></div>`;
	}

	/** Escape, keep line breaks, render WhatsApp `*bold*`, `_italic_`, `~strike~`, `` `code` ``. */
	static format(text) {
		let html = ui.escape(text);
		html = html
			.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<strong>$2</strong>")
			.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>")
			.replace(/(^|[\s(])~([^~\n]+)~(?=[\s).,!?:;]|$)/g, "$1<s>$2</s>")
			.replace(/&#x60;([^\n]+?)&#x60;/g, "<code>$1</code>"); // backticks are already escaped
		return html.replace(/\r?\n/g, "<br>");
	}

	static moment_of(ts) {
		if (!ts) return null;
		try {
			return frappe.datetime.convert_to_user_tz(cstr(ts), false);
		} catch (e) {
			return moment(cstr(ts));
		}
	}

	/** `{key, label}` for the day separator (Today / Yesterday / user date format). */
	static day_of(ts) {
		const m = sanad.ui.ChatThread.moment_of(ts);
		if (!m || !m.isValid()) return { key: "", label: "" };
		const key = m.format("YYYY-MM-DD");
		const today = moment().format("YYYY-MM-DD");
		const yesterday = moment().subtract(1, "day").format("YYYY-MM-DD");
		let label = m.format(frappe.datetime.get_user_date_fmt().toUpperCase());
		if (key === today) label = __("Today");
		else if (key === yesterday) label = __("Yesterday");
		return { key, label };
	}

	/** `{label, full, iso}` — time in the user's format without seconds. */
	static time_of(ts) {
		const m = sanad.ui.ChatThread.moment_of(ts);
		if (!m || !m.isValid()) return { label: "", full: "", iso: "" };
		const fmt = frappe.datetime.get_user_time_fmt().replace(/:ss/, "");
		return {
			label: m.format(fmt),
			full: m.format(`${frappe.datetime.get_user_date_fmt().toUpperCase()} ${fmt}`),
			iso: m.toISOString(),
		};
	}

	destroy() {
		this.$list.off();
		this.$root.remove();
	}
};

export default sanad.ui.ChatThread;

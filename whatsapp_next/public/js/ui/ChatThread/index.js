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

// Types shown inline, and the file extensions a preview trusts for each.
const PREVIEW = {
	Image: { tag: "img", ext: ["jpg", "jpeg", "png", "gif", "webp", "bmp"] },
	Sticker: { tag: "img", ext: ["webp", "png"] },
	Video: { tag: "video", ext: ["mp4", "webm", "mov", "m4v", "3gp"] },
	Audio: { tag: "audio", ext: ["ogg", "oga", "opus", "mp3", "m4a", "aac", "wav", "amr"] },
};

// buttons / a list sent, and a recipient's tap on them: drawn as themselves, not as a file row
const INTERACTIVE = new Set(["Buttons", "List"]);
const NO_CHIP = new Set(["Buttons", "List", "Interactive Reply"]);
const IA_ICON = { reply: "es-line-reply", url: "es-line-link", call: "es-line-call", copy: "es-line-copy" };

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
			if ($(e.target).closest(".sanad-chat__poll").length) return; // the poll opens its results
			e.preventDefault();
			const row = this.get_row($(e.currentTarget).data("key"));
			if (row && this.opts.on_row_click) this.opts.on_row_click(row);
		});
		// a received file not fetched yet (a past message): fetched on demand, then shown in place
		this.$list.on("click", ".sanad-chat__fetch", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const btn = e.currentTarget;
			const row = this.rows.find((r) => r.name === btn.dataset.name);
			if (!row || btn.disabled) return;
			btn.disabled = true;
			btn.querySelector(".sanad-chat__media-type").textContent = __("Downloading…");
			sanad.ui
				.call("messages.fetch_media", { name: row.name })
				.then((r) => {
					row.attachment = r && r.attachment;
					row.media_pending = 0;
					this.render();
				})
				.catch((err) => {
					btn.disabled = false;
					btn.querySelector(".sanad-chat__media-type").textContent = __("Download");
					sanad.ui.Toast.error(err);
				});
		});
		// a sent poll opens its results: anywhere on the poll with a mouse, its button from the keyboard
		this.$list.on("click", ".sanad-chat__poll", (e) => {
			e.preventDefault();
			const row = this.rows.find((r) => r.name === e.currentTarget.dataset.name);
			if (row) sanad.ui.ChatThread.open_poll(row);
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

	/**
	 * Merge a fresh read of the newest rows: new ones are added, rows already shown take the fresh
	 * values (status ticks, an edit, a deletion, a fetched attachment) and the thread redraws only
	 * when something changed, keeping the reader where they were. Returns `{added, changed}`.
	 */
	merge(rows = []) {
		const fresh = [];
		let changed = 0;
		(rows || []).forEach((r) => {
			if (!r || !r.name) return;
			const current = this.get_row(row_key(r));
			if (!current) return fresh.push(r);
			const keys = Object.keys(r).filter((k) => k !== "cursor");
			if (keys.some((k) => cstr(current[k]) !== cstr(r[k]))) {
				keys.forEach((k) => (current[k] = r[k]));
				changed++;
			}
		});
		const added = this.dedupe(fresh);
		if (!added.length && !changed) return { added: 0, changed: 0 };
		const el = this.$scroll.get(0);
		const at_bottom = this.is_at_bottom();
		const from_bottom = el.scrollHeight - el.scrollTop;
		this.rows = sanad.ui.ChatThread.sort(this.rows.concat(added));
		this.render();
		if (at_bottom) this.scroll_to_bottom();
		else el.scrollTop = el.scrollHeight - from_bottom;
		return { added: added.length, changed };
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
		this.pinned = true;
		if (!this.pin_watch) {
			// growth from a loading preview fires no scroll event, so `pinned` only drops when the reader scrolls up
			this.pin_watch = true;
			this.$scroll.on("scroll", () => {
				this.pinned = this.is_at_bottom();
			});
		}
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
		const reactions = sanad.ui.ChatThread.collect_reactions(this.rows);
		this.rows.forEach((row) => {
			// a reaction whose message is on screen shows as a badge on that message instead
			if (reactions.folded.has(row)) return;
			const day = sanad.ui.ChatThread.day_of(row.ts || row.creation);
			if (day.key !== last_day) {
				html += `<div class="sanad-chat__day" role="separator" aria-label="${ui.escape(day.label)}"><span>${ui.escape(day.label)}</span></div>`;
				last_day = day.key;
			}
			html += this.row_html(row, reactions.by_target.get(cstr(row.provider_message_id)));
		});
		this.$list.html(html);
		// A preview gets its height only once it loads: keep a reader who was at the bottom there.
		this.$list.find("img.sanad-chat__preview, video.sanad-chat__preview").each((i, el) => {
			if (el.tagName === "IMG" && el.complete) return;
			$(el).one(el.tagName === "IMG" ? "load" : "loadedmetadata", () => {
				if (this.pinned) this.scroll_to_bottom();
			});
		});
		this.load_poll_results();
		return this;
	}

	/** Fetch the live tally of the sent polls on screen and write it into their bubbles. */
	load_poll_results() {
		const names = this.rows
			.filter((r) => r.message_type === "Poll" && r.poll_question && r.direction !== "Inbound")
			.map((r) => r.name)
			.slice(-20);
		if (!names.length || this.opts.poll_results === false) return;
		sanad.ui
			.call("messages.get_poll_results", { names }, { silent: true })
			.then((res) => {
				Object.entries((res && res.results) || {}).forEach(([name, tally]) => {
					const $poll = this.$list.find(`.sanad-chat__poll[data-name="${CSS.escape(name)}"]`);
					if ($poll.length) sanad.ui.ChatThread.fill_poll($poll, tally);
				});
			})
			.catch(() => {});
	}

	row_html(row, reactions) {
		const out = row.direction !== "Inbound";
		const clickable = !!this.opts.on_row_click;
		const highlight = this.opts.highlight && row.name === this.opts.highlight;
		const type = row.message_type || "Text";
		const who = row.display_name || ui.phone(row.key || "");
		const status_label = STATUS[row.status] ? STATUS[row.status].label() : row.status || "";
		const aria = out ? __("Sent message, {0}", [status_label]) : __("Received message from {0}", [who]);
		let inner = "";
		inner += sanad.ui.ChatThread.quote_html(row, this.rows);
		if (!NO_CHIP.has(type) && (type !== "Text" || row.attachment)) inner += sanad.ui.ChatThread.media_html(row, { link: !clickable });
		const ia = INTERACTIVE.has(type) ? sanad.ui.ChatThread.interactive_of(row) : null;
		if (ia && ia.title) inner += `<div class="sanad-chat__ia-title">${ui.escape(ia.title)}</div>`;
		if (type === "Poll" && row.poll_question) inner += sanad.ui.ChatThread.poll_html(row);
		if (row.deleted_at) {
			// deleted for everyone: say so and by whom, and keep what it said one click away
			const by = row.deleted_by ? ui.phone(`+${cstr(row.deleted_by).replace(/\D/g, "")}`) : "";
			inner += `<div class="sanad-chat__deleted">${ui.icon("es-line-delete", "xs")}<span>${ui.escape(by ? __("This message was deleted by {0}", [by]) : __("This message was deleted"))}</span></div>`;
			if (row.body) inner += `<details class="sanad-chat__history"><summary>${ui.escape(__("Show the deleted message"))}</summary><div class="sanad-chat__text">${sanad.ui.ChatThread.format(row.body)}</div></details>`;
		} else if (row.body) {
			inner += `<div class="sanad-chat__text">${sanad.ui.ChatThread.format(row.body)}</div>`;
			if (row.edited_at && row.original_body && row.original_body !== row.body)
				inner += `<details class="sanad-chat__history"><summary>${ui.escape(__("Original text"))}</summary><div class="sanad-chat__text sanad-chat__text--muted">${sanad.ui.ChatThread.format(row.original_body)}</div></details>`;
		}
		if (row.caption) inner += `<div class="sanad-chat__caption">${sanad.ui.ChatThread.format(row.caption)}</div>`;
		// as WhatsApp lays it out: title, text, footer, then the buttons / the list button
		if (ia) inner += sanad.ui.ChatThread.interactive_html(type, ia);
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
		if (reactions && reactions.length) inner += sanad.ui.ChatThread.reactions_html(reactions);
		const edited = row.edited_at && !row.deleted_at ? `<span class="sanad-chat__edited">${ui.escape(__("Edited"))}</span>` : "";
		inner += `<div class="sanad-chat__meta">${edited}<time datetime="${ui.escape(time.iso)}" title="${ui.escape(time.full)}">${ui.escape(time.label)}</time>${out ? sanad.ui.ChatThread.status_html(row.status) : ""}${open_btn}</div>`;
		return `<div class="sanad-chat__row sanad-chat__row--${out ? "out" : "in"}${highlight ? " sanad-chat__row--highlight" : ""}${clickable ? " sanad-chat__row--clickable" : ""}" data-key="${ui.escape(row_key(row))}" data-name="${ui.escape(row.name)}" role="group" aria-label="${ui.escape(aria)}"><div class="sanad-chat__bubble">${inner}</div></div>`;
	}

	/**
	 * Reactions folded onto their messages, the way WhatsApp shows them: each person's latest
	 * reaction counts, a changed one replaces it and an empty one (removed) drops it. Returns
	 * `{by_target: Map<provider_message_id, [{emoji, count}]>, folded: Set<row>}`; a reaction
	 * whose message is not loaded stays a row of its own.
	 */
	static collect_reactions(rows) {
		const on_screen = new Set(rows.map((r) => cstr(r.provider_message_id)).filter(Boolean));
		const latest = new Map(); // target -> Map(person -> emoji)
		const folded = new Set();
		rows.forEach((row) => {
			if (row.message_type !== "Reaction" || !row.reaction_to || !on_screen.has(cstr(row.reaction_to))) return;
			folded.add(row);
			const target = cstr(row.reaction_to);
			const person = cstr(row.sender || row.key || row.direction);
			if (!latest.has(target)) latest.set(target, new Map());
			const emoji = cstr(row.body).trim();
			if (emoji) latest.get(target).set(person, emoji);
			else latest.get(target).delete(person); // rows are oldest → newest, so the last word wins
		});
		const by_target = new Map();
		latest.forEach((people, target) => {
			const counts = new Map();
			people.forEach((emoji) => counts.set(emoji, (counts.get(emoji) || 0) + 1));
			if (counts.size) by_target.set(target, [...counts].map(([emoji, count]) => ({ emoji, count })));
		});
		return { by_target, folded };
	}

	static reactions_html(reactions) {
		const label = reactions.map((r) => (r.count > 1 ? `${r.emoji} ${r.count}` : r.emoji)).join(" ");
		const chips = reactions
			.map((r) => `<span class="sanad-chat__reaction">${ui.escape(r.emoji)}${r.count > 1 ? `<span class="sanad-chat__reaction-count">${r.count}</span>` : ""}</span>`)
			.join("");
		return `<div class="sanad-chat__reactions" role="img" aria-label="${ui.escape(__("Reactions: {0}", [label]))}">${chips}</div>`;
	}

	/** A sent poll: its question and options; `fill_poll` adds the counts once they load. */
	static poll_html(row) {
		const options = sanad.ui.ChatThread.poll_options(row.poll_options);
		const items = options
			.map(
				(o) => `<li class="sanad-chat__poll-option" data-option="${ui.escape(o)}">
					<span class="sanad-chat__poll-label">${ui.escape(o)}</span>
					<span class="sanad-chat__poll-count" aria-hidden="true"></span>
					<span class="sanad-chat__poll-bar"><span class="sanad-chat__poll-fill"></span></span>
				</li>`
			)
			.join("");
		return `<div class="sanad-chat__poll" data-name="${ui.escape(row.name)}">
			<div class="sanad-chat__poll-question">${ui.escape(row.poll_question)}</div>
			<ul class="sanad-chat__poll-options">${items}</ul>
			<div class="sanad-chat__poll-foot">
				<span class="sanad-chat__poll-total" aria-live="polite"></span>
				<button type="button" class="sanad-chat__poll-open">${ui.escape(__("View results"))}</button>
			</div>
		</div>`;
	}

	/**
	 * The poll's results across everyone it was sent to (its campaign message, or the same question
	 * and options), in the document drawer: how many answered, the tally, each recipient's answer
	 * and who has not answered yet. Fetched live (`messages.get_poll_summary`).
	 */
	static open_poll(row) {
		const base = { doctype: "WhatsApp Log", name: row.name, poll_question: row.poll_question, scope_label: "", recipients: 0, responded: 0, response_rate: "", leading: "" };
		const drawer = new sanad.ui.Drawer({
			doctype: "WhatsApp Log",
			name: row.name,
			mode: "record",
			layout: "document",
			doc: base,
			width: 600,
			title: __("Poll results"),
			open_link: false,
			fields: [
				{ fieldname: "poll_question", fieldtype: "Data", label: __("Question") },
				{ fieldname: "scope_label", fieldtype: "Data", label: __("Sent as") },
				{ fieldname: "recipients", fieldtype: "Int", label: __("Sent to") },
				{ fieldname: "responded", fieldtype: "Int", label: __("Answered") },
				{ fieldname: "response_rate", fieldtype: "Data", label: __("Response rate") },
				{ fieldname: "leading", fieldtype: "Data", label: __("Leading answer") },
			],
			profile: {
				title: "poll_question",
				lines: ["scope_label"],
				value: false,
				status: (d) =>
					d.summary
						? { label: __("{0} of {1} answered", [ui.format_int(d.responded), ui.format_int(d.recipients)]), colour: cint(d.responded) ? "green" : "gray" }
						: null,
			},
			facts: [
				{ field: "recipients", icon: "es-line-send" },
				{ field: "responded", icon: "es-line-people" },
				{ field: "response_rate", icon: "es-line-chart" },
				{ field: "leading", icon: "es-line-flag" },
			],
			relations: [],
			sections: [
				{ label: __("Results"), icon: "es-line-chart", render: ($el, d) => sanad.ui.ChatThread.render_poll_results($el, d) },
				{ label: __("Answers"), icon: "es-line-people", render: ($el, d) => sanad.ui.ChatThread.render_poll_answers($el, d) },
				{ label: __("Not answered yet"), icon: "es-line-time", condition: (d) => d.summary && d.summary.not_responded_count, render: ($el, d) => sanad.ui.ChatThread.render_poll_waiting($el, d) },
			],
			details: [],
			actions: [{ label: __("Refresh"), icon: "es-line-reload", primary: true, handler: (d, dr) => load(dr) }],
		});
		const load = (dr) =>
			sanad.ui
				.call("messages.get_poll_summary", { name: row.name }, { silent: true })
				.then((sm) => {
					const top = (sm.counts || []).reduce((a, b) => (cint(b.votes) > cint(a.votes) ? b : a), { votes: 0 });
					const scope =
						sm.scope && sm.scope.kind === "campaign"
							? __("Campaign {0} · message {1}", [sm.scope.campaign_name || sm.scope.campaign, ui.format_int(sm.scope.message_idx)])
							: __("Every poll with this question");
					dr.set_doc(
						Object.assign({}, base, {
							summary: sm,
							scope_label: scope,
							recipients: cint(sm.recipients),
							responded: cint(sm.responded),
							response_rate: `${cint(sm.response_rate)}%`,
							leading: cint(top.votes) ? top.option : __("None yet"),
						})
					);
				})
				.catch(() => dr.set_doc(Object.assign({}, base, { summary: { error: true } })));
		drawer.show();
		load(drawer);
	}

	static render_poll_results($el, d) {
		const sm = d.summary;
		if (!sm) return $el.html(`<div class="sanad-chat__poll-total">${ui.escape(__("Loading…"))}</div>`);
		if (sm.error) return $el.html(`<div class="sanad-chat__poll-total">${ui.escape(__("Results unavailable"))}</div>`);
		const total = Math.max(1, cint(sm.total_votes));
		const rows = (sm.counts || [])
			.map((o) => {
				const pct = Math.round((cint(o.votes) / total) * 100);
				return `<li class="sanad-chat__poll-option" aria-label="${ui.escape(__("{0}: {1} votes", [o.option, ui.format_int(o.votes)]))}">
					<span class="sanad-chat__poll-label">${ui.escape(o.option)}</span>
					<span class="sanad-chat__poll-count">${ui.format_int(o.votes)} · ${pct}%</span>
					<span class="sanad-chat__poll-bar"><span class="sanad-chat__poll-fill" style="inline-size:${pct}%"></span></span>
				</li>`;
			})
			.join("");
		const notes = [];
		if (sm.voters_hidden) notes.push(__("The platform subscription does not share who voted, so some votes have no name."));
		if (sm.errors) notes.push(__("{0} sent polls could not be read; they count as not answered.", [ui.format_int(sm.errors)]));
		if (sm.truncated) notes.push(__("Only the first {0} recipients are counted.", [ui.format_int(sm.recipients)]));
		$el.html(
			`<ul class="sanad-chat__poll-options sanad-chat__poll-options--drawer">${rows}</ul>` +
				notes.map((n) => `<p class="sanad-chat__poll-note">${ui.escape(n)}</p>`).join("")
		);
	}

	static render_poll_answers($el, d) {
		const sm = d.summary;
		if (!sm || sm.error) return $el.empty();
		if (!(sm.responses || []).length) {
			new sanad.ui.EmptyState({ wrapper: $el, state: "empty", size: "sm", title: __("No answers yet"), description: __("Answers appear here as recipients vote.") });
			return;
		}
		const when = (ts) => (ts ? frappe.datetime.prettyDate(moment.unix(cint(ts)).format("YYYY-MM-DD HH:mm:ss")) : "");
		const items = sm.responses
			.map((r) => {
				const who = r.recipient || r.voter || ui.phone(r.phone || (r.voter_number ? "+" + r.voter_number : ""));
				const sub = [r.voter && r.voter !== r.recipient ? r.voter : "", ui.phone(r.phone || (r.voter_number ? "+" + r.voter_number : "")), when(r.voted_at)].filter(Boolean).join(" · ");
				const chips = (r.options || []).map((o) => `<span class="sanad-chat__poll-chip">${ui.escape(o)}</span>`).join("");
				return `<li class="sanad-chat__poll-answer"><div><div class="sanad-chat__poll-voter">${ui.escape(who)}</div><div class="sanad-chat__poll-voter-meta">${ui.escape(sub)}</div></div><div class="sanad-chat__poll-chips">${chips}</div></li>`;
			})
			.join("");
		$el.html(`<ul class="sanad-chat__poll-answers">${items}</ul>`);
	}

	static render_poll_waiting($el, d) {
		const sm = d.summary;
		const items = (sm.not_responded || [])
			.map((r) => `<li><span class="sanad-chat__poll-voter">${ui.escape(r.recipient || "")}</span><span class="sanad-chat__poll-voter-meta">${ui.escape(ui.phone(r.phone || ""))}</span></li>`)
			.join("");
		const more = cint(sm.not_responded_count) - (sm.not_responded || []).length;
		$el.html(`<ul class="sanad-chat__poll-voters">${items}</ul>${more > 0 ? `<p class="sanad-chat__poll-note">${ui.escape(__("And {0} more", [ui.format_int(more)]))}</p>` : ""}`);
	}

	static poll_options(value) {
		if (Array.isArray(value)) return value.map((v) => cstr(v).trim()).filter(Boolean);
		try {
			const parsed = JSON.parse(cstr(value) || "[]");
			if (Array.isArray(parsed)) return parsed.map((v) => cstr(v).trim()).filter(Boolean);
		} catch (e) {
			// plain lines
		}
		return cstr(value).split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
	}

	static fill_poll($poll, tally) {
		if (!tally || tally.error) {
			$poll.find(".sanad-chat__poll-total").text(__("Results unavailable"));
			return;
		}
		const total = cint(tally.total_voters);
		const max = Math.max(1, ...(tally.options || []).map((o) => cint(o.votes)));
		(tally.options || []).forEach((o) => {
			const $li = $poll.find(".sanad-chat__poll-option").filter((i, el) => el.dataset.option === cstr(o.option));
			const votes = cint(o.votes);
			$li.find(".sanad-chat__poll-count").text(ui.format_int(votes));
			$li.find(".sanad-chat__poll-fill").css("inline-size", `${Math.round((votes / max) * 100)}%`);
			$li.attr("aria-label", __("{0}: {1} votes", [cstr(o.option), ui.format_int(votes)]));
		});
		$poll.find(".sanad-chat__poll-total").text(
			total ? ui.plural(total, { one: __("{0} voter"), other: __("{0} voters") }) : __("No votes yet")
		);
	}

	static interactive_of(row) {
		try {
			const v = typeof row.interactive === "string" ? JSON.parse(row.interactive || "{}") : row.interactive || {};
			return v && typeof v === "object" ? v : null;
		} catch (e) {
			return null;
		}
	}

	/** Sent buttons (each as WhatsApp draws it, with its kind's icon) or a list (its button, and the
	 * options one click away). */
	static interactive_html(type, ia) {
		let html = "";
		if (ia.footer) html += `<div class="sanad-chat__ia-footer">${ui.escape(ia.footer)}</div>`;
		if (type === "Buttons") {
			html += `<div class="sanad-chat__ia-buttons">${(ia.buttons || [])
				.map((b) => {
					const hint = b.url || b.phone || b.code || "";
					return `<span class="sanad-chat__ia-button" title="${ui.escape(hint)}">${ui.icon(IA_ICON[b.type] || IA_ICON.reply, "xs")}<span>${ui.escape(b.text)}</span></span>`;
				})
				.join("")}</div>`;
		} else {
			const rows = (ia.sections || [])
				.map(
					(s) =>
						(s.title ? `<li class="sanad-chat__ia-section">${ui.escape(s.title)}</li>` : "") +
						(s.rows || []).map((r) => `<li class="sanad-chat__ia-row"><span>${ui.escape(r.title)}</span>${r.description ? `<small>${ui.escape(r.description)}</small>` : ""}</li>`).join("")
				)
				.join("");
			html += `<details class="sanad-chat__ia-list"><summary class="sanad-chat__ia-button">${ui.icon("es-line-bullet-list", "xs")}<span>${ui.escape(ia.button_text || __("Options"))}</span></summary><ul>${rows}</ul></details>`;
		}
		return html;
	}

	/** The message this one answers, quoted above it (a reply, or a tap on buttons / a list). */
	static quote_html(row, rows) {
		const id = cstr(row.quoted_id);
		if (!id) return "";
		const target = (rows || []).find((r) => cstr(r.provider_message_id) === id);
		const text = target ? target.body || target.poll_question || __(target.message_type || "Message") : __("An earlier message");
		const lead = row.message_type === "Interactive Reply" ? __("Chose from") : __("Reply to");
		return `<div class="sanad-chat__quote"><span class="sanad-chat__quote-lead">${ui.escape(lead)}</span><span class="sanad-chat__quote-text">${ui.escape(cstr(text).slice(0, 140))}</span></div>`;
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

	/** Inline preview of an attached image, sticker, video or audio, or "" when the file's own
	 * extension does not match its type (a renamed `.bin` stays a download row only). */
	static preview_html(row, { link = true } = {}) {
		const type = row.message_type || "Other";
		const kind = PREVIEW[type];
		const url = cstr(row.attachment);
		const ext = (url.split("?")[0].split(".").pop() || "").toLowerCase();
		if (!kind || !kind.ext.includes(ext)) return "";
		const src = ui.escape(url);
		if (kind.tag === "img") {
			const img = `<img class="sanad-chat__preview sanad-chat__preview--${type === "Sticker" ? "sticker" : "image"}" src="${src}" alt="${ui.escape(__(type))}" loading="lazy">`;
			return link ? `<a class="sanad-chat__preview-link" href="${src}" target="_blank" rel="noopener" aria-label="${ui.escape(__("Open {0}", [__(type)]))}">${img}</a>` : img;
		}
		if (kind.tag === "video") return `<video class="sanad-chat__preview" src="${src}" controls preload="metadata"></video>`;
		return `<audio class="sanad-chat__audio" src="${src}" controls preload="none"></audio>`;
	}

	/** Media row; `link: false` renders the attachment name as text (rows that are themselves clickable). */
	static media_html(row, { link = true } = {}) {
		const type = row.message_type || "Other";
		const icon = MEDIA_ICON[type] || MEDIA_ICON.Other;
		const label = __(type);
		if (row.attachment) {
			const file = decodeURIComponent(cstr(row.attachment).split("/").pop() || "") || label;
			const preview = sanad.ui.ChatThread.preview_html(row, { link });
			const body = `<span class="sanad-chat__media-icon" aria-hidden="true">${ui.icon(icon, "sm")}</span><span class="sanad-chat__media-name">${ui.escape(file)}</span><span class="sanad-chat__media-type">${ui.escape(label)}</span>`;
			if (!link) return `${preview}<div class="sanad-chat__media sanad-chat__media--plain">${body}</div>`;
			return `${preview}<a class="sanad-chat__media" href="${ui.escape(row.attachment)}" target="_blank" rel="noopener" aria-label="${ui.escape(__("Open {0}: {1}", [label, file]))}">${body}</a>`;
		}
		if (cint(row.media_pending) && row.name) {
			return `<button type="button" class="sanad-chat__media sanad-chat__fetch" data-name="${ui.escape(row.name)}" aria-label="${ui.escape(__("Download {0}", [label]))}"><span class="sanad-chat__media-icon" aria-hidden="true">${ui.icon("es-line-download", "sm")}</span><span class="sanad-chat__media-name">${ui.escape(label)}</span><span class="sanad-chat__media-type">${ui.escape(__("Download"))}</span></button>`;
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

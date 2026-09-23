// sanad.ui.ConversationDrawer — the conversation variant of the side panel: the shared
// `.sanad-panel` shell (full-height sheet on mobile) showing one number's merged outbound +
// inbound thread from the read layer, its link status, and the contextual actions (link /
// convert, quick send, confirm conversation). One overlay at a time through `ui.overlay`
// (opening it closes a Drawer and vice versa); it traps focus, closes on Escape, restores focus
// to the opener and unsubscribes its realtime handlers on close. Data: `messages.get_conversation`
// (newest-first pages, keyset cursor), `numbers.search_numbers` + `numbers.get_number` for the
// header, `numbers.confirm_conversation`.

import ui from "../_core/index.js";

const DEFAULT_API = {
	conversation: "messages.get_conversation",
	number: "numbers.get_number",
	number_search: "numbers.search_numbers",
	confirm: "numbers.confirm_conversation",
};

const DEFAULT_ROLES = {
	quick_send: ["WhatsApp Agent", "WhatsApp Manager"],
	confirm: ["WhatsApp Agent", "WhatsApp Manager"],
};

const sha1_cache = new Map();

/** Wrap a phone / id in a bidi isolate so it reads LTR inside Arabic sentences and escaped text. */
const ltr = (text) => `⁦${cstr(text)}⁩`;

/** sha1(text) as hex through WebCrypto; resolves `null` when the API is unavailable (http). */
async function sha1_hex(text) {
	if (sha1_cache.has(text)) return sha1_cache.get(text);
	let out = null;
	try {
		if (window.crypto && crypto.subtle && window.TextEncoder) {
			const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
			out = Array.from(new Uint8Array(buf))
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
		}
	} catch (e) {
		out = null;
	}
	sha1_cache.set(text, out);
	return out;
}

sanad.ui.ConversationDrawer = class ConversationDrawer {
	/**
	 * @param {Object} opts
	 * @param {string} opts.key — `phone_e164` or group JID
	 * @param {string} [opts.device] — restrict the thread to one device
	 * @param {number} [opts.page_length=50]
	 * @param {Array<string|Object>} [opts.actions=["link","quick_send","confirm"]] — keys, or `{key, label, icon, roles?, perm?, condition(number), handler(number, drawer)}`
	 * @param {string} [opts.title] — header title override
	 * @param {string|number} [opts.width] — panel width (default 520px)
	 * @param {Function} [opts.on_close]
	 * @param {Function} [opts.on_link] — `(number_row, drawer) => void`; opens the caller's link / convert dialog. Without it "Add as contact" is not rendered.
	 * @param {Function} [opts.on_row_click] — forwarded to ChatThread
	 * @param {Object} [opts.roles] — `{quick_send: [...], confirm: [...]}` role lists gating those actions (defaults to the Agent / Manager roles)
	 * @param {Object} [opts.api] — key overrides `{conversation, number, number_search, confirm}`
	 */
	constructor(opts = {}) {
		this.opts = Object.assign({ page_length: 50, actions: ["link", "quick_send", "confirm"] }, opts);
		this.api = Object.assign({}, DEFAULT_API, opts.api || {});
		this.roles = Object.assign({}, DEFAULT_ROLES, opts.roles || {});
		this.key = cstr(this.opts.key).trim();
		this.id = ui.uid("convo");
		this.number = undefined; // undefined = loading, null = no Number row
		this.next_cursor = null;
		this.key_hash = null;
		if (!this.key) throw new Error(__("ConversationDrawer needs a key"));
		this.opener = document.activeElement;
		ui.overlay.open(this); // closes any open Drawer / ConversationDrawer first
		sanad.ui.ConversationDrawer.current = this;
		this.make();
		this.open();
	}

	static open(opts) {
		return new sanad.ui.ConversationDrawer(opts);
	}

	make() {
		const title_id = `${this.id}-title`;
		const width = this.opts.width ? (typeof this.opts.width === "number" ? `${this.opts.width}px` : this.opts.width) : "";
		this.$backdrop = $(`<div class="sanad-kit sanad-backdrop sanad-convo__backdrop"></div>`);
		this.$root = $(`
			<aside class="sanad-kit sanad-panel sanad-convo" id="${this.id}" role="dialog" aria-modal="true" aria-labelledby="${title_id}"${width ? ` style="--sanad-panel-width:${ui.escape(width)}"` : ""}>
				<header class="sanad-panel__header">
					<div class="sanad-convo__avatar" aria-hidden="true"></div>
					<div class="sanad-panel__title">
						<h2 class="sanad-convo__title" id="${title_id}"></h2>
						<div class="sanad-panel__subtitle sanad-convo__sub sanad-tabular" dir="ltr"></div>
					</div>
					<div class="sanad-convo__badge"></div>
					<button type="button" class="btn btn-sm btn-default sanad-convo__close" aria-label="${ui.escape(__("Close"))}">${ui.icon("es-line-close", "sm")}</button>
				</header>
				<div class="sanad-panel__actions sanad-convo__actions" role="group" aria-label="${ui.escape(__("Conversation actions"))}"></div>
				<div class="sanad-panel__body sanad-convo__body">
					<div class="sanad-convo__state"></div>
					<div class="sanad-convo__thread"></div>
				</div>
			</aside>`);
		this.$title = this.$root.find(".sanad-convo__title");
		this.$sub = this.$root.find(".sanad-convo__sub");
		this.$avatar = this.$root.find(".sanad-convo__avatar");
		this.$badge = this.$root.find(".sanad-convo__badge");
		this.$actions = this.$root.find(".sanad-convo__actions");
		this.$thread = this.$root.find(".sanad-convo__thread");
		this.state = new sanad.ui.EmptyState({ wrapper: this.$root.find(".sanad-convo__state"), state: "loading", rows: 4 });
		this.$root.find(".sanad-convo__close").on("click", () => this.close());
		this.$backdrop.on("click", () => this.close());
		this.$root.on("keydown", (e) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				this.close();
			}
		});
		this.render_header();
		$(document.body).append(this.$backdrop, this.$root);
	}

	open() {
		window.requestAnimationFrame(() => this.$root.addClass("sanad-panel--open"));
		this.untrap = ui.trap_focus(this.$root);
		this.$root.find(".sanad-convo__close").trigger("focus");
		this.subscribe();
		this.load_number();
		this.load_first_page();
	}

	/** Close the panel (alias `hide()` so `ui.overlay` can close it like a Drawer). */
	close({ silent = false } = {}) {
		if (this._closed) return this;
		this._closed = true;
		this.unsubscribe();
		this.untrap && this.untrap();
		ui.overlay.close(this);
		if (sanad.ui.ConversationDrawer.current === this) sanad.ui.ConversationDrawer.current = null;
		this.$root.removeClass("sanad-panel--open");
		this.$backdrop.remove();
		window.setTimeout(() => {
			this.thread && this.thread.destroy();
			this.$root.remove();
		}, 200);
		if (this.opener && typeof this.opener.focus === "function" && document.contains(this.opener)) {
			this.opener.focus();
		}
		if (!silent) this.opts.on_close && this.opts.on_close(this);
		return this;
	}

	hide(opts) {
		return this.close(opts);
	}

	// ---- header ---------------------------------------------------------------------------

	render_header() {
		const n = this.number;
		const linked = !!(n && n.link_status === "Linked");
		const known = !!n;
		const name = this.opts.title || (n && n.display_name) || (known ? this.key : __("Unknown number"));
		this.$title.text(name);
		this.$sub.text(this.key !== name ? this.key : "");
		this.$avatar.text(cstr(name).trim().slice(0, 2).toUpperCase());
		if (n === undefined) {
			this.$badge.html(`<span class="sanad-skeleton__line sanad-convo__badge-skeleton" aria-hidden="true"></span>`);
		} else {
			this.$badge.html(sanad.ui.ConversationDrawer.link_badge(linked));
		}
		this.render_actions();
	}

	/** Linked (green, icon) / Not linked (neutral gray, no icon — it is a state, not a warning). */
	static link_badge(linked) {
		return linked
			? sanad.ui.StatusBadge.html({ label: __("Linked"), colour: "green" })
			: sanad.ui.StatusBadge.html({ label: __("Not linked"), colour: "gray", icon: false });
	}

	load_number() {
		this.number = undefined;
		this.render_header();
		// search first: a key without a Number row must not raise Desk's global 404 message
		return sanad.ui
			.call(this.api.number_search, { txt: this.key, page_length: 5 }, { silent: true })
			.then((r) => {
				const rows = (r && r.rows) || [];
				const hit = rows.find((row) => row.phone_e164 === this.key || row.name === this.key);
				if (!hit) return null;
				return sanad.ui.call(this.api.number, { phone_e164: this.key }, { silent: true }).catch(() => hit);
			})
			.catch((err) => {
				// permission or transport problem: the thread still loads; header stays minimal
				if (err && err.http_status !== 403) sanad.ui.Toast.error(err);
				return null;
			})
			.then((row) => {
				if (this._closed) return;
				this.number = row || null;
				this.render_header();
			});
	}

	// ---- actions --------------------------------------------------------------------------

	action_specs() {
		const n = this.number || {};
		const individual = !n.number_type || n.number_type === "Individual";
		const specs = {
			link: {
				label: n.contact ? __("Open contact") : __("Add as contact"),
				icon: n.contact ? "es-line-customer" : "es-line-add-people",
				condition: () => (n.contact ? true : !!this.number && individual && typeof this.opts.on_link === "function"),
				handler: () => (n.contact ? frappe.set_route("Form", "Contact", n.contact) : this.opts.on_link(this.number, this)),
			},
			quick_send: {
				label: __("Quick send"),
				icon: ui.icons.quick_send,
				roles: this.roles.quick_send,
				condition: () => typeof sanad.ui.QuickSend === "function",
				handler: () => {
					if (typeof sanad.ui.QuickSend !== "function") return;
					const args = { device: this.opts.device || n.last_device || undefined };
					if (this.key.includes("@")) args.jid = this.key;
					else args.phone = this.key;
					new sanad.ui.QuickSend(args);
				},
			},
			confirm: {
				label: n.conversation_confirmed ? __("Remove confirmation") : __("Confirm conversation"),
				icon: n.conversation_confirmed ? ui.icons.cancel : "es-line-success",
				roles: this.roles.confirm,
				condition: () => !!this.number && individual,
				handler: () => this.confirm_conversation(),
			},
		};
		return (this.opts.actions || [])
			.map((a) => (typeof a === "string" ? Object.assign({ key: a }, specs[a]) : a))
			.filter((a) => a && a.label && typeof a.handler === "function");
	}

	render_actions() {
		this.$actions.empty();
		if (this.number === undefined) {
			this.$actions.append(ui.skeleton(1, { lines: 1 }));
			return;
		}
		ui.visible_actions(this.action_specs(), this.number).forEach((a) => {
			$(`<button type="button" class="btn btn-sm btn-default sanad-convo__action">${a.icon ? ui.icon(a.icon, "xs") : ""}<span>${ui.escape(a.label)}</span></button>`)
				.on("click", () => a.handler(this.number, this))
				.appendTo(this.$actions);
		});
	}

	/**
	 * The confirm / remove-confirmation dialog for a number row `{phone_e164, display_name,
	 * conversation_confirmed}` — shared with the Numbers list. Resolves with the API result
	 * `{conversation_confirmed}`; rejects on cancel.
	 */
	static confirm_dialog(number, api = {}) {
		const n = number || {};
		const key = n.phone_e164 || n.name;
		const confirmed = !cint(n.conversation_confirmed);
		const who = n.display_name || ltr(key);
		return sanad.ui.ConfirmDialog.ask({
			title: confirmed ? __("Confirm this conversation?") : __("Remove the confirmation?"),
			message: confirmed
				? __("Marks {0} as a real, ongoing conversation. Agents rely on this flag.", [who])
				: __("The number will no longer be marked as a confirmed conversation."),
			impact: [{ label: __("Number"), value: ltr(key) }],
			reason_field: { label: __("Note"), required: true, description: __("Saved on the number and in the audit log.") },
			confirm_label: confirmed ? __("Confirm conversation") : __("Remove confirmation"),
			on_confirm: ({ reason }) =>
				sanad.ui.call(api.confirm || DEFAULT_API.confirm, { phone_e164: key, confirmed: confirmed ? 1 : 0, note: reason }),
		}).then((r) => {
			sanad.ui.Toast.success(confirmed ? __("Conversation confirmed") : __("Confirmation removed"));
			return r;
		});
	}

	confirm_conversation() {
		return sanad.ui.ConversationDrawer.confirm_dialog(Object.assign({ phone_e164: this.key }, this.number || {}), this.api)
			.then((r) => {
				if (this._closed) return;
				this.number = Object.assign({}, this.number, { conversation_confirmed: r && r.conversation_confirmed ? 1 : 0 });
				this.render_header();
			})
			.catch(() => {});
	}

	// ---- thread ---------------------------------------------------------------------------

	fetch_page(before) {
		const args = { key: this.key, limit: this.opts.page_length };
		if (this.opts.device) args.device = this.opts.device;
		if (before) args.before = before;
		return sanad.ui.call(this.api.conversation, args, { silent: true });
	}

	load_first_page() {
		this.state.loading({ rows: 4 });
		this.$thread.hide();
		return this.fetch_page()
			.then((page) => {
				if (this._closed) return;
				const rows = ((page && page.rows) || []).slice().reverse();
				this.next_cursor = page && page.has_more ? page.next_cursor : null;
				this.state.hide();
				this.$thread.show();
				this.thread = new sanad.ui.ChatThread({
					wrapper: this.$thread,
					rows,
					has_more: !!this.next_cursor,
					on_load_more: () => this.load_older(),
					on_row_click: this.opts.on_row_click,
					empty_text: __("No messages yet"),
					empty_description: __("Messages exchanged with this number will appear here."),
				});
				ui.announce(
					rows.length
						? ui.plural(rows.length, { one: __("{0} message loaded."), other: __("{0} messages loaded.") })
						: __("No messages yet.")
				);
			})
			.catch((err) => {
				if (this._closed) return;
				this.$thread.hide();
				const forbidden = err && (err.http_status === 403 || /PermissionError/.test(err.exc_type || ""));
				if (forbidden) {
					this.state.set("error", {
						title: __("No access to conversations"),
						description: __("You do not have permission to read conversations. Ask an administrator for access."),
						action: null,
					});
					return;
				}
				this.state.error(err, {
					title: __("Could not load the conversation"),
					action: { label: __("Retry"), onclick: () => this.load_first_page() },
				});
			});
	}

	load_older() {
		if (!this.next_cursor || !this.thread) return Promise.resolve();
		return this.fetch_page(this.next_cursor).then((page) => {
			if (this._closed) return;
			const rows = ((page && page.rows) || []).slice().reverse();
			this.next_cursor = page && page.has_more ? page.next_cursor : null;
			this.thread.prepend(rows);
			this.thread.set_has_more(!!this.next_cursor);
		});
	}

	/** Fetch the newest page and append rows the thread does not have yet (realtime inbound). */
	refresh_newest() {
		if (!this.thread || this._refreshing) return Promise.resolve();
		this._refreshing = true;
		return this.fetch_page()
			.then((page) => {
				if (this._closed) return;
				const rows = ((page && page.rows) || []).slice().reverse();
				const added = this.thread.append(rows);
				if (added) ui.announce(ui.plural(added, { one: __("{0} new message arrived."), other: __("{0} new messages arrived.") }));
			})
			.catch(() => {})
			.then(() => {
				this._refreshing = false;
			});
	}

	// ---- realtime -------------------------------------------------------------------------

	subscribe() {
		this._on_status = (p) => {
			if (p && p.outbound && this.thread) this.thread.update_status(p.outbound, p.status);
		};
		this._on_inbound = (p) => {
			if (!p) return;
			const matches = this.key_hash ? p.key_hash === this.key_hash : !this.opts.device || p.device === this.opts.device;
			if (matches) this.refresh_newest();
		};
		frappe.realtime.on("wa:message:status", this._on_status);
		frappe.realtime.on("wa:inbound:received", this._on_inbound);
		sha1_hex(this.key).then((hash) => {
			this.key_hash = hash;
		});
	}

	unsubscribe() {
		if (this._on_status) frappe.realtime.off("wa:message:status", this._on_status);
		if (this._on_inbound) frappe.realtime.off("wa:inbound:received", this._on_inbound);
		this._on_status = this._on_inbound = null;
	}
};

sanad.ui.ConversationDrawer.current = null;

export default sanad.ui.ConversationDrawer;

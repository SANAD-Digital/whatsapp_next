// sanad.ui core — the namespace, host configuration and the small helpers every kit component
// shares (escaping, icons, RTL, indicator colours, a11y announcer, API calls). Portable: nothing
// here knows the host app; the host fills `sanad.ui.config.api` with its dotted method paths.

frappe.provide("sanad.ui");

const ui = sanad.ui;

ui.version = "1.0.0";
ui.config = ui.config || { api: {}, defaults: {} };

/**
 * Merge host configuration:
 * `{ api: {key: "dotted.method"}, defaults: {...}, renderers: {doctypes, profiles, kinds, fields} }`.
 * The `renderers` block is handed to `sanad.ui.Render` — see its README for the spec.
 */
ui.configure = function (opts = {}) {
	ui.config.api = Object.assign(ui.config.api || {}, opts.api || {});
	ui.config.defaults = Object.assign(ui.config.defaults || {}, opts.defaults || {});
	if (opts.renderers) {
		ui.config.renderers = Object.assign(ui.config.renderers || {}, opts.renderers);
		if (sanad.ui.Render) sanad.ui.Render.configure(opts.renderers);
	}
	return ui.config;
};

/**
 * Resolve a configured API key (`"area.fn"`) to its dotted method. A full dotted path
 * (three or more segments, e.g. `frappe.client.get_value`) passes through unchanged.
 */
ui.api = function (key) {
	if (!key) return null;
	const method = (ui.config.api || {})[key];
	if (method) return method;
	if (key.split(".").length >= 3) return key;
	throw new Error(__("sanad.ui: API method '{0}' is not configured", [key]));
};

/**
 * Call a server method and resolve with `r.message`. Errors reject with an `Error` carrying
 * `exc_type` and a readable `message` (server messages already shown by Frappe are not repeated
 * when `silent` is false).
 */
ui.call = function (method, args = {}, { silent = false, freeze = false, freeze_message } = {}) {
	return new Promise((resolve, reject) => {
		frappe.call({
			method: ui.api(method),
			args,
			freeze,
			freeze_message,
			silent,
			callback: (r) => resolve(r.message),
			error: (r) => reject(ui.error_from(r)),
		});
	});
};

/** Normalise a failed request into `Error { message, exc_type, http_status }`. */
ui.error_from = function (r) {
	let message = "";
	try {
		const raw = r && (r._server_messages || (r.responseJSON && r.responseJSON._server_messages));
		if (raw) {
			const list = JSON.parse(raw).map((m) => {
				try {
					return JSON.parse(m).message;
				} catch (e) {
					return m;
				}
			});
			message = list.filter(Boolean).join(" ");
		}
	} catch (e) {
		message = "";
	}
	const exc_type = (r && (r.exc_type || (r.responseJSON && r.responseJSON.exc_type))) || "";
	if (!message) {
		message =
			r && r.status === 0 ? __("You are offline") : __("Something went wrong. Please try again.");
	}
	const err = new Error(typeof strip_html === "function" ? strip_html(message) : message);
	err.exc_type = exc_type;
	err.http_status = r && (r.status || (r.xhr && r.xhr.status));
	return err;
};

ui.escape = (value) => frappe.utils.escape_html(cstr(value == null ? "" : value));

/** Espresso icon (`es-line-*`) or legacy icon by name. */
ui.icon = (name, size = "sm", cls = "") => (name ? frappe.utils.icon(name, size, cls) : "");

ui.is_rtl = () =>
	typeof frappe.utils.is_rtl === "function" ? frappe.utils.is_rtl() : document.dir === "rtl";

ui.uid = (prefix = "sanad") => `${prefix}-${frappe.utils.get_random(8)}`;

ui.debounce = (fn, wait = 250) => frappe.utils.debounce(fn, wait);

ui.throttle = (fn, wait = 1000) => frappe.utils.throttle(fn, wait);

/**
 * Pick the plural form for `n` with the user's language rules (Arabic has six categories).
 * `forms` are already translated strings with `{0}`: `{one, other, zero?, two?, few?, many?}`.
 */
ui.plural = function (n, forms) {
	let category = "other";
	try {
		category = new Intl.PluralRules(frappe.boot.lang || "en").select(cint(n));
	} catch (e) {
		category = cint(n) === 1 ? "one" : "other";
	}
	const form = forms[category] || forms.other || forms.one || "";
	return form.replace("{0}", ui.format_int(n));
};

/** Run `fn(listview)` after every list render (paging, filters, realtime) — one wrapper per list. */
ui.on_list_render = function (listview, fn) {
	if (!listview._sanad_render_hooks) {
		listview._sanad_render_hooks = [];
		const original = listview.render_list.bind(listview);
		listview.render_list = function (...args) {
			const out = original(...args);
			listview._sanad_render_hooks.forEach((hook) => {
				try {
					hook(listview);
				} catch (e) {
					console.error(e); // eslint-disable-line no-console
				}
			});
			return out;
		};
	}
	listview._sanad_render_hooks.push(fn);
	return () => {
		listview._sanad_render_hooks = listview._sanad_render_hooks.filter((h) => h !== fn);
	};
};

/** Refresh a list on a realtime event, throttled, only while that list is the current route. */
ui.bind_list_realtime = function (listview, event, wait = 2000) {
	const key = `_sanad_rt_${event}`;
	if (listview[key]) return listview[key];
	const refresh = ui.throttle(() => {
		const route = frappe.get_route();
		if (route[0] === "List" && route[1] === listview.doctype && !document.hidden) listview.refresh();
	}, wait);
	frappe.realtime.on(event, refresh);
	listview[key] = () => frappe.realtime.off(event, refresh);
	return listview[key];
};

/**
 * Filter action specs by `roles` (any), `perm` (DocType permission) and `condition(doc)`.
 * Used by RowActions, BulkActions, Drawer and ConversationDrawer so visibility rules match.
 */
ui.visible_actions = function (actions = [], doc = null, doctype = null) {
	return (actions || []).filter((a) => {
		if (!a) return false;
		if (a.roles && a.roles.length && !frappe.user.has_role(a.roles)) return false;
		if (a.perm && doctype && !frappe.perm.has_perm(doctype, 0, a.perm, doc || undefined)) return false;
		if (typeof a.condition === "function") {
			try {
				return !!a.condition(doc);
			} catch (e) {
				return false;
			}
		}
		return true;
	});
};

/** One overlay (drawer / side panel) at a time: opening one closes the previous. */
ui.overlay = {
	current: null,
	open(instance) {
		if (ui.overlay.current && ui.overlay.current !== instance) {
			const previous = ui.overlay.current;
			ui.overlay.current = null;
			previous.hide && previous.hide();
		}
		ui.overlay.current = instance;
	},
	close(instance) {
		if (ui.overlay.current === instance) ui.overlay.current = null;
	},
};

/** Roving arrow-key navigation over `items` (RTL-aware); returns the new index or -1. */
ui.roving_index = function (e, items, index) {
	const rtl = ui.is_rtl();
	const next = rtl ? "ArrowLeft" : "ArrowRight";
	const prev = rtl ? "ArrowRight" : "ArrowLeft";
	if (e.key === next || e.key === "ArrowDown") return (index + 1) % items.length;
	if (e.key === prev || e.key === "ArrowUp") return (index - 1 + items.length) % items.length;
	if (e.key === "Home") return 0;
	if (e.key === "End") return items.length - 1;
	return -1;
};

/** A few verbs keep one icon everywhere. */
ui.icons = {
	quick_send: "es-line-chat",
	conversation: "es-line-chat-alt",
	resend: "es-line-reload",
	cancel: "es-line-close-circle",
	open: "es-line-arrow-up-right",
	edit: "es-line-edit",
	remove: "es-line-delete",
	link: "es-line-link",
	more: "es-line-overflow",
};

// Frappe's Int formatter is `cint()` — no separator — and this product prints large counts on
// every screen ("3,540 of 6,000"), so the kit groups them in the reader's own locale.
ui.format_int = (value) => (typeof format_number === "function" ? format_number(cint(value), null, 0) : String(cint(value)));

/** Avatar initials: first letter of the first two words, upper-cased (`"Sales device"` → `"SD"`). */
ui.initials = (text) => {
	const words = cstr(text).trim().split(/[\s_\-.]+/).filter(Boolean);
	if (!words.length) return "";
	return words
		.slice(0, 2)
		.map((w) => Array.from(w)[0])
		.join("")
		.toUpperCase();
};

/** Docname of a Desk list row (`.list-row-container`). */
ui.docname_of_row = ($row) => {
	const $r = $($row).closest(".list-row-container");
	return $r.find(".list-row-checkbox").data("name") || $r.find("a[data-name]").first().data("name");
};

// Frappe indicator colours → the Espresso triplet used by `.sanad-tone--*` classes.
const TONES = {
	green: "green",
	blue: "blue",
	"light-blue": "blue",
	cyan: "cyan",
	orange: "amber",
	yellow: "amber",
	amber: "amber",
	red: "red",
	gray: "gray",
	grey: "gray",
	darkgrey: "gray",
	"dark-grey": "gray",
	purple: "violet",
	violet: "violet",
	pink: "pink",
};

ui.tone = (colour) => TONES[String(colour || "gray").toLowerCase()] || "gray";

/** `{label, colour, tone}` for a document, from `frappe.get_indicator` (listview_settings aware). */
ui.indicator_for = (doctype, doc) => {
	let label = doc && doc.status;
	let colour = "gray";
	try {
		const ind = frappe.get_indicator(doc, doctype);
		if (ind && ind.length) {
			label = ind[0];
			colour = ind[1] || "gray";
		}
	} catch (e) {
		// meta not loaded yet — neutral badge
	}
	return { label: label || "", colour, tone: ui.tone(colour) };
};

/** Announce a message to assistive technology without moving focus. */
ui.announce = function (text, { assertive = false } = {}) {
	if (!text) return;
	const id = assertive ? "sanad-live-assertive" : "sanad-live-polite";
	let $region = $(`#${id}`);
	if (!$region.length) {
		$region = $(
			`<div id="${id}" class="sanad-visually-hidden" role="${
				assertive ? "alert" : "status"
			}" aria-live="${assertive ? "assertive" : "polite"}" aria-atomic="true"></div>`
		).appendTo(document.body);
	}
	$region.text("");
	window.setTimeout(() => $region.text(text), 30);
};

/** Keep Tab inside `$root` (dialogs handled by Bootstrap; drawers and sheets use this). */
ui.trap_focus = function ($root) {
	const selector =
		'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
	const handler = (e) => {
		if (e.key !== "Tab") return;
		const items = $root.find(selector).filter(":visible").toArray();
		if (!items.length) return;
		const first = items[0];
		const last = items[items.length - 1];
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	};
	$root.on("keydown.sanadtrap", handler);
	return () => $root.off("keydown.sanadtrap", handler);
};

/** Skeleton rows markup (loading state — never a spinner). */
ui.skeleton = (rows = 3, { lines = 2 } = {}) => {
	let html = '<div class="sanad-skeleton" aria-hidden="true">';
	for (let i = 0; i < rows; i++) {
		html += '<div class="sanad-skeleton__row">';
		for (let j = 0; j < lines; j++) {
			html += `<div class="sanad-skeleton__line" style="width:${j === 0 ? 60 : 85}%"></div>`;
		}
		html += "</div>";
	}
	return html + "</div>";
};

/** Meta helpers shared by meta-driven components. */
ui.meta = {
	/** Resolve meta (loads it when missing) → Promise<meta>. */
	with_doctype(doctype) {
		return new Promise((resolve) => frappe.model.with_doctype(doctype, () => resolve(frappe.get_meta(doctype))));
	},
	/** Default preview fields: `in_list_view` + `bold`, always excluding layout fields. */
	preview_fields(meta) {
		return (meta.fields || []).filter(
			(df) => !frappe.model.layout_fields.includes(df.fieldtype) && (df.in_list_view || df.bold)
		);
	},
	is_layout(df) {
		return frappe.model.layout_fields.includes(df.fieldtype);
	},
	/** Format a value for display through Frappe's own formatter. */
	format(value, df, doc) {
		if (value == null || value === "") return "";
		return frappe.format(value, df, { inline: true }, doc);
	},
};

export default ui;

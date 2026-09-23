// sanad.ui.Render — the kit's presentation layer: one place that decides how a value, a record or
// a collection looks, at five display levels (`inline`, `compact`, `row`, `card`, `hero`).
//
// The same data may have more than one visual representation depending on where it appears and
// how much room there is; what must not change is the language it is drawn in. So every screen
// asks Render instead of formatting on its own, and the drawer, the list cell and the picker row
// all show a person as the same person.
//
// Three levels of configuration:
//   1. nothing at all — the view model is derived from the DocType's meta (title field, image
//      field, indicator rules, the first currency field, the list-view fields);
//   2. a profile — `sanad.ui.Render.profile("WhatsApp Log", { lines: ["phone_e164"], … })`,
//      where every entry is a fieldname, a `{field, icon, …}` spec or a function of the doc;
//   3. a renderer — `sanad.ui.Render.register("my-kind", { card(vm) { return "…" } })` plus
//      `sanad.ui.Render.map({ "My DocType": "my-kind" })`.
//
// A host app can pass all three through `sanad.ui.configure({ renderers: {…} })`.

import ui from "../_core/index.js";
import { VALUE_RENDERERS, VALUE_HELPERS, file_size, file_ext } from "./values.js";
import { ENTITY_RENDERERS, KIND_BY_DOCTYPE, KIND_HINTS, BASE } from "./entities.js";
import * as parts from "./parts.js";

const DENSITIES = ["inline", "compact", "row", "card", "hero"];

// Fields we never surface as a fact: they are layout, noise, or already shown elsewhere.
const SKIP_FIELDS = ["name", "owner", "modified", "modified_by", "creation", "docstatus", "idx", "_user_tags", "_comments", "_assign", "_liked_by"];

const SUBTITLE_CANDIDATES = ["phone_e164", "mobile_no", "phone", "email_id", "email", "designation", "item_code", "party_name", "customer_name", "supplier_name", "company_name", "subject", "description"];
const IMAGE_CANDIDATES = ["image", "user_image", "avatar", "photo", "thumbnail", "item_image"];
const AMOUNT_CANDIDATES = ["grand_total", "total", "amount", "rate", "price", "standard_rate", "net_total", "base_grand_total", "outstanding_amount"];
const PROGRESS_CANDIDATES = ["percent_complete", "progress", "percent", "completion"];

// Extension → the tone its chip is tinted with (reference image 05).
const FILE_TONES = { pdf: "red", doc: "blue", docx: "blue", xls: "green", xlsx: "green", csv: "green", ppt: "amber", pptx: "amber", zip: "violet", rar: "violet", txt: "gray", png: "cyan", jpg: "cyan", jpeg: "cyan", gif: "cyan", webp: "cyan", svg: "cyan", mp4: "pink", mp3: "pink" };

const Render = {
	DENSITIES,
	parts,
	values: VALUE_HELPERS,
	file_size,
	file_ext,

	// ---- registries ---------------------------------------------------------------------

	fields: Object.assign({}, VALUE_RENDERERS),
	kinds: Object.assign({}, ENTITY_RENDERERS),
	doctype_kinds: Object.assign({}, KIND_BY_DOCTYPE),
	profiles: {},

	/** Register (or replace) the renderer for one fieldtype: `(value, df, doc, opts) => html`. */
	field(fieldtype, fn) {
		if (typeof fieldtype === "object") Object.assign(Render.fields, fieldtype);
		else Render.fields[fieldtype] = fn;
		return Render;
	},

	/** Register a kind: an object with any of the five densities, the rest inherited from BASE. */
	register(kind, renderers = {}) {
		Render.kinds[kind] = Object.assign({}, Render.kinds[kind] || {}, renderers);
		return Render;
	},

	/** Map DocTypes to kinds: `Render.map({ "WhatsApp Contact": "person" })`. */
	map(mapping = {}) {
		Object.assign(Render.doctype_kinds, mapping);
		return Render;
	},

	/** Declare how one DocType becomes a view model (see the file header for the spec). */
	profile(doctype, spec) {
		if (spec === undefined) return Render.profiles[doctype];
		Render.profiles[doctype] = Object.assign({}, Render.profiles[doctype] || {}, spec);
		return Render;
	},

	/** Everything a host app configures in one call (used by `sanad.ui.configure`). */
	configure(opts = {}) {
		if (!opts) return Render;
		if (opts.fields) Render.field(opts.fields);
		if (opts.kinds) Object.entries(opts.kinds).forEach(([kind, r]) => Render.register(kind, r));
		if (opts.doctypes) Render.map(opts.doctypes);
		if (opts.profiles) Object.entries(opts.profiles).forEach(([dt, spec]) => Render.profile(dt, spec));
		return Render;
	},

	// ---- values -------------------------------------------------------------------------

	/**
	 * One field value as HTML.
	 * @param {*} value
	 * @param {Object} df — docfield (or `{fieldtype}`)
	 * @param {Object} [doc]
	 * @param {Object} [opts] — `{density, variant, doctype}`
	 */
	value(value, df, doc, opts = {}) {
		if (value == null || value === "") return "";
		const fieldtype = (df && df.fieldtype) || "Data";
		const fn = Render.fields[fieldtype] || VALUE_HELPERS.fallback;
		try {
			return fn(value, df || { fieldtype }, doc || {}, Object.assign({ density: "inline" }, opts)) || "";
		} catch (e) {
			console.error("sanad.ui.Render.value", fieldtype, e); // eslint-disable-line no-console
			return ui.escape(value);
		}
	},

	/** The icon that stands for a field in a fact tile (from its meaning, then its type). */
	field_icon(df) {
		return icon_for_field(df);
	},

	/** An inline chip for a link target: the DocType's icon, the name, and a route. */
	doc_link(doctype, name, display, opts = {}) {
		if (!doctype || !name) return ui.escape(display || name || "");
		return parts.chip({
			icon: opts.icon === false ? null : Render.icon_for(doctype),
			text: cstr(display || name),
			href: frappe.utils.get_form_link(doctype, name),
			title: `${__(doctype)}: ${name}`,
			cls: "sanad-chipline--link",
		});
	},

	// ---- kinds and view models ------------------------------------------------------------

	/** The kind of a DocType: the explicit map first, then meta hints, then `generic`. */
	kind_of(doctype, doc) {
		if (!doctype) return "generic";
		if (Render.doctype_kinds[doctype]) return Render.doctype_kinds[doctype];
		const profile = Render.profiles[doctype];
		if (profile && profile.kind) return profile.kind;
		const meta = frappe.get_meta(doctype);
		const names = meta ? (meta.fields || []).map((df) => df.fieldname) : Object.keys(doc || {});
		const hit = KIND_HINTS.find((h) => h.fields.some((f) => names.includes(f)));
		let kind = hit ? hit.kind : null;
		if (!kind && meta && (meta.is_submittable || names.includes("status"))) kind = "document";
		// Only remember the answer once meta was there to answer with: a guess made from a bare
		// `{name}` payload must not become the DocType's kind for the rest of the session.
		if (meta) Render.doctype_kinds[doctype] = kind || "generic";
		return kind || "generic";
	},

	/** A sensible icon for a DocType (its workspace icon when Frappe knows one). */
	icon_for(doctype) {
		const kind = Render.kind_of(doctype);
		return { person: "es-line-customer", item: "es-line-storage", file: "es-line-filetype", document: "es-line-article", generic: "es-line-article" }[kind];
	},

	/** Resolve one profile entry: a fieldname, `{field, …}`, or `(doc) => value`. */
	resolve(entry, doc, meta) {
		if (entry == null) return null;
		if (typeof entry === "function") {
			const out = entry(doc);
			if (out == null) return null;
			// a function may return the value itself or a full `{value, label, …}` spec
			return typeof out === "object" ? out : { value: out };
		}
		if (typeof entry === "string") {
			const df = field_of(meta, entry);
			return { field: entry, df, value: doc[entry], label: df ? __(df.label || entry) : __(frappe.unscrub(entry)) };
		}
		if (typeof entry === "object") {
			if (entry.html || entry.text) return entry;
			const field = entry.field || entry.fieldname;
			const df = entry.df || field_of(meta, field);
			// the caller's spec first, then what we worked out from it — `value` may be a function
			// of the doc, and it must not survive into the view model as a function
			return Object.assign({}, entry, {
				field,
				df,
				value: typeof entry.value === "function" ? entry.value(doc) : entry.value !== undefined ? entry.value : doc[field],
				label: entry.label || (df ? __(df.label || field) : field ? __(frappe.unscrub(field)) : ""),
			});
		}
		return null;
	},

	/**
	 * The view model of one record: what every renderer draws from.
	 * @param {Object} doc
	 * @param {Object} [opts] — `{doctype, kind, density, actions, href, profile}`
	 */
	vm(doc = {}, opts = {}) {
		const doctype = opts.doctype || doc.doctype;
		const meta = doctype ? frappe.get_meta(doctype) : null;
		const kind = opts.kind || Render.kind_of(doctype, doc);
		const profile = Object.assign({}, Render.profiles[doctype] || {}, opts.profile || {});
		const used = new Set(SKIP_FIELDS);
		const density = opts.density || "row";

		const pick = (entry) => {
			const r = Render.resolve(entry, doc, meta);
			if (r && r.field) used.add(r.field);
			return r;
		};
		const text_of = (r, { density: d } = {}) => {
			if (!r) return null;
			if (r.html) return r;
			if (r.text != null) return r;
			if (r.value == null || r.value === "") return null;
			const html = r.df ? Render.value(r.value, r.df, doc, { density: d || "inline", doctype, variant: r.variant }) : ui.escape(r.value);
			return Object.assign({}, r, { html, ltr: r.ltr != null ? r.ltr : is_ltr_field(r.df, r.field) });
		};

		// title / subtitle lines
		const title_entry = pick(profile.title) || auto_title(doc, meta, used);
		const title = title_entry && title_entry.value != null ? cstr(title_entry.value) : cstr(doc.name || "");
		const line_specs = profile.lines || (profile.subtitle ? [profile.subtitle] : auto_lines(doc, meta, kind, used));
		const lines = line_specs
			.map((e) => text_of(pick(e)))
			.filter((l) => l && cstr(l.value != null ? l.value : l.text) !== title);

		// media
		const image_entry = profile.image ? pick(profile.image) : auto_image(doc, meta, used);
		const image = image_entry ? cstr(image_entry.value || image_entry.text || "") : "";

		// status
		let status = null;
		if (profile.status === false) status = null;
		else if (typeof profile.status === "function") status = profile.status(doc);
		else {
			const field = typeof profile.status === "string" ? profile.status : "status";
			const ind = doctype ? ui.indicator_for(doctype, Object.assign({ doctype }, doc)) : null;
			const label = (ind && ind.label) || doc[field];
			if (label) status = { label: __(cstr(label)), colour: (ind && ind.colour) || "gray" };
			used.add(field);
		}

		// primary value + progress
		const value_entry = profile.value !== undefined ? (profile.value === false ? null : pick(profile.value)) : auto_amount(doc, meta, used);
		const value = value_entry && value_entry.value != null && value_entry.value !== "" ? { label: value_entry.label, html: Render.value(value_entry.value, value_entry.df || { fieldtype: "Currency" }, doc, { density, doctype, variant: value_entry.variant || "strong" }) } : null;
		const progress_entry = profile.progress !== undefined ? (profile.progress === false ? null : pick(profile.progress)) : auto_progress(doc, meta, used);
		const progress = progress_entry && progress_entry.value != null ? flt(progress_entry.value) : null;

		// facts
		const fact_specs = profile.facts || auto_facts(doc, meta, used, density);
		const facts = fact_specs
			.map((e) => {
				const r = text_of(pick(e), { density: "inline" });
				if (!r) return null;
				return { label: r.label, value: r.html, icon: r.icon || icon_for_field(r.df), ltr: r.ltr };
			})
			.filter(Boolean);

		const kind_defaults = { person: { shape: "circle", icon: "es-line-customer", emphasis: "status" }, item: { shape: "thumb", icon: "es-line-storage", emphasis: "value" }, document: { shape: "tile", icon: "es-line-article", emphasis: "value" }, file: { shape: "tile", icon: "es-line-filetype", emphasis: "none" }, generic: { shape: "tile", icon: "es-line-article", emphasis: "status" } }[kind] || {};

		const vm = Object.assign(
			{
				kind,
				doctype,
				doctype_label: doctype ? __(doctype) : "",
				name: doc.name || opts.name || "",
				title,
				title_ltr: profile.title_ltr != null ? profile.title_ltr : kind === "document",
				lines,
				description: profile.description ? cstr((pick(profile.description) || {}).value || "") : "",
				image,
				initials: image || !is_nameish(title, doc) ? "" : ui.initials(title),
				icon: profile.icon || kind_defaults.icon,
				tone: profile.tone || (status ? status.colour : "gray"),
				shape: profile.shape || kind_defaults.shape,
				emphasis: profile.emphasis || (progress != null ? "progress" : kind_defaults.emphasis),
				status,
				value,
				progress,
				facts,
				actions: [],
				doc,
			},
			opts.vm || {}
		);

		// link and actions
		if (opts.href !== undefined) vm.href = opts.href;
		else if (profile.href === false) vm.href = null;
		else if (typeof profile.href === "function") vm.href = profile.href(doc);
		else if (doctype && vm.name && doctype !== "File") vm.href = frappe.utils.get_form_link(doctype, vm.name);
		if (opts.on_click) {
			vm.clickable = true;
			vm.href = null;
		}
		const action_specs = opts.actions || (typeof profile.actions === "function" ? profile.actions(doc) : profile.actions) || [];
		vm.actions = ui.visible_actions(action_specs, doc, doctype).map((a) => Object.assign({}, a, { href: typeof a.href === "function" ? a.href(doc) : a.href }));

		if (kind === "file") Object.assign(vm, file_vm(doc, vm));
		// The fields this view model already shows — a caller laying out the rest (the document
		// drawer) uses it so nothing appears twice.
		vm.used = Array.from(used);
		if (typeof profile.after === "function") profile.after(vm, doc);
		return vm;
	},

	// ---- entities -------------------------------------------------------------------------

	/**
	 * One record as HTML at the given density.
	 * @param {Object} doc
	 * @param {Object} [opts] — `{doctype, kind, density="row", actions, href, on_click, profile}`
	 */
	entity(doc, opts = {}) {
		const density = DENSITIES.includes(opts.density) ? opts.density : "row";
		const vm = opts.vm_built || Render.vm(doc, opts);
		const kind = Render.kinds[vm.kind] || {};
		const fn = kind[density] || BASE[density];
		try {
			return fn(vm, opts);
		} catch (e) {
			console.error("sanad.ui.Render.entity", vm.kind, density, e); // eslint-disable-line no-console
			return ui.escape(vm.title || vm.name || "");
		}
	},

	/**
	 * Render into an element and bind the interactions (`on_click`, action handlers).
	 * @returns {jQuery} the wrapper
	 */
	mount(wrapper, doc, opts = {}) {
		const $el = $(wrapper);
		const vm = Render.vm(doc, opts);
		$el.html(Render.entity(doc, Object.assign({}, opts, { vm_built: vm })));
		parts.bind_actions($el, vm.actions, doc);
		parts.bind_copy();
		if (typeof opts.on_click === "function") {
			$el.find(".sanad-ent").on("click", (e) => {
				if ($(e.target).closest("[data-action-index]").length) return;
				opts.on_click(doc, e);
			});
		}
		return $el;
	},

	/** Render a list of records at one density into a wrapper (rows, cards, a gallery…). */
	list(wrapper, docs = [], opts = {}) {
		const $el = $(wrapper).empty();
		const density = opts.density || "row";
		$el.addClass(`sanad-ent-list sanad-ent-list--${density}`);
		docs.forEach((doc) => {
			const $item = $('<div class="sanad-ent-list__item"></div>').appendTo($el);
			Render.mount($item, doc, opts);
		});
		if (!docs.length && opts.empty !== false) {
			new sanad.ui.EmptyState({ wrapper: $el, state: "empty", title: opts.empty_title || __("Nothing to show"), size: "sm" });
		}
		return $el;
	},

	/** The fields a DocType's view model reads — the field list to fetch for a linked record. */
	fields_needed(doctype) {
		const meta = frappe.get_meta(doctype);
		const profile = Render.profiles[doctype] || {};
		const out = new Set(["name"]);
		const add = (entry) => {
			if (typeof entry === "string") out.add(entry);
			else if (entry && typeof entry === "object" && (entry.field || entry.fieldname)) out.add(entry.field || entry.fieldname);
		};
		[profile.title, profile.subtitle, profile.image, profile.value, profile.progress, profile.description].forEach(add);
		(profile.lines || []).forEach(add);
		(profile.facts || []).forEach(add);
		if (meta) {
			if (meta.title_field) out.add(meta.title_field);
			if (meta.image_field) out.add(meta.image_field);
			(meta.fields || []).forEach((df) => {
				if (df.in_list_view || df.bold || IMAGE_CANDIDATES.includes(df.fieldname) || SUBTITLE_CANDIDATES.includes(df.fieldname)) out.add(df.fieldname);
			});
			if ((meta.fields || []).some((df) => df.fieldname === "status")) out.add("status");
		}
		return Array.from(out);
	},

	/**
	 * The few extra fields the identity block needs (picture, the line under the title, the time)
	 * on top of whatever the caller already asked for.
	 */
	identity_fields(doctype) {
		const meta = frappe.get_meta(doctype);
		if (!meta) return [];
		const names = (meta.fields || []).map((df) => df.fieldname);
		const out = [];
		const profile = Render.profiles[doctype] || {};
		if (meta.title_field) out.push(meta.title_field);
		const image = profile.image || meta.image_field || IMAGE_CANDIDATES.find((f) => names.includes(f));
		if (typeof image === "string") out.push(image);
		SUBTITLE_CANDIDATES.filter((f) => names.includes(f))
			.slice(0, 2)
			.forEach((f) => out.push(f));
		["sent_at", "received_at"].filter((f) => names.includes(f)).forEach((f) => out.push(f));
		out.push("creation");
		return out;
	},

	/** Load one linked record and resolve with its view model (drawer relations, pickers). */
	load(doctype, name, opts = {}) {
		if (!doctype || !name) return Promise.resolve(null);
		return ui.meta
			.with_doctype(doctype)
			.then(() => frappe.db.get_value(doctype, name, Render.fields_needed(doctype)))
			.then((r) => {
				const doc = Object.assign({ name, doctype }, (r && r.message) || {});
				return Render.vm(doc, Object.assign({ doctype }, opts));
			});
	},

	/** Load a linked record and render it into `wrapper` (skeleton → row → error). */
	load_into(wrapper, doctype, name, opts = {}) {
		const $el = $(wrapper);
		const state = new sanad.ui.EmptyState({ wrapper: $el, state: "loading", rows: 1, size: "sm" });
		return Render.load(doctype, name, opts)
			.then((vm) => {
				if (!vm) return null;
				$el.empty();
				Render.mount($el, vm.doc, Object.assign({ doctype }, opts));
				return vm;
			})
			.catch((err) => {
				state.error(err, { size: "sm" });
			});
	},
};

// ---- auto-derivation from meta ------------------------------------------------------------

/** A title worth taking initials from: a name, not a document number. */
function is_nameish(title, doc) {
	const text = cstr(title).trim();
	if (!text || text === cstr(doc.name)) return false;
	if (/^[A-Za-z]{2,}[-/][A-Za-z0-9-]+$/.test(text)) return false; // SAL-ORD-2026-00004
	return /[A-Za-z\u0600-\u06FF]/.test(text);
}

function field_of(meta, fieldname) {
	if (!meta || !fieldname) return null;
	return (meta.fields || []).find((df) => df.fieldname === fieldname) || null;
}

function is_ltr_field(df, fieldname) {
	const name = cstr(fieldname || (df && df.fieldname));
	if (/phone|mobile|email|url|jid|code|id$|_id/.test(name)) return true;
	return df ? ["Currency", "Int", "Float", "Percent", "Date", "Datetime", "Time", "Data"].includes(df.fieldtype) && /phone|mobile|email/.test(name) : false;
}

function icon_for_field(df) {
	if (!df) return null;
	const name = cstr(df.fieldname);
	if (/phone|mobile/.test(name)) return "es-line-call";
	if (/email/.test(name)) return "es-line-email";
	if (/device|machine/.test(name)) return "es-line-laptop";
	if (/lang/.test(name)) return "es-line-globe";
	if (/branch|location|city|address/.test(name)) return "es-line-location";
	if (/group|team/.test(name)) return "es-line-group";
	if (/tag/.test(name)) return "es-line-tag";
	if (/count|qty|quantity|retry|attempt/.test(name)) return "es-line-reload";
	if (/^(template|campaign|command)/.test(name)) return { template: "es-line-template", campaign: "es-line-plan", command: "es-line-zap" }[name.split("_")[0]];
	// only where the type itself carries a meaning; a generic Data or Select gets no icon
	return { Date: "es-line-calender", Datetime: "es-line-time", Currency: "es-line-payments", Percent: "es-line-progress", Attach: "es-line-attachment", "Attach Image": "es-line-image", Rating: "es-line-star", Geolocation: "es-line-location" }[df.fieldtype] || null;
}

function auto_title(doc, meta, used) {
	const field = (meta && meta.title_field) || ["title", "full_name", "display_name", "subject", "item_name", "employee_name", "customer_name"].find((f) => doc[f]);
	if (field && doc[field]) {
		used.add(field);
		return { field, value: doc[field] };
	}
	return { field: "name", value: doc.name };
}

function auto_image(doc, meta, used) {
	const field = (meta && meta.image_field) || IMAGE_CANDIDATES.find((f) => doc[f]) || (meta && (meta.fields || []).find((df) => df.fieldtype === "Attach Image" && doc[df.fieldname]) || {}).fieldname;
	if (!field || !doc[field]) return null;
	used.add(field);
	return { field, value: doc[field] };
}

function auto_lines(doc, meta, kind, used) {
	const out = [];
	if (kind === "document") out.push({ text: __(doc.doctype || ""), field: "__doctype" });
	SUBTITLE_CANDIDATES.forEach((f) => {
		if (out.length >= 2) return;
		if (doc[f] && !used.has(f)) out.push(f);
	});
	return out;
}

function auto_amount(doc, meta, used) {
	const field = AMOUNT_CANDIDATES.find((f) => doc[f] != null && doc[f] !== "" && !used.has(f));
	if (!field) return null;
	const df = field_of(meta, field) || { fieldtype: "Currency", fieldname: field };
	if (!["Currency", "Float", "Int"].includes(df.fieldtype)) return null;
	used.add(field);
	return { field, df, value: doc[field], label: __(df.label || field) };
}

function auto_progress(doc, meta, used) {
	const field = PROGRESS_CANDIDATES.find((f) => doc[f] != null && doc[f] !== "" && !used.has(f));
	if (!field) return null;
	used.add(field);
	return { field, df: field_of(meta, field) || { fieldtype: "Percent", fieldname: field }, value: doc[field] };
}

function auto_facts(doc, meta, used, density) {
	const limit = density === "hero" ? 6 : density === "card" ? 3 : 2;
	if (!meta) return [];
	return (meta.fields || [])
		.filter((df) => !ui.meta.is_layout(df) && (df.in_list_view || df.bold) && !used.has(df.fieldname) && doc[df.fieldname] != null && doc[df.fieldname] !== "" && !["Text Editor", "Code", "JSON", "HTML"].includes(df.fieldtype))
		.slice(0, limit)
		.map((df) => df.fieldname);
}

/** Files carry their own facts: type, size and the actions of reference image 05. */
function file_vm(doc, vm) {
	const url = doc.file_url || doc.url || vm.image || "";
	const name = doc.file_name || doc.name || cstr(url).split("/").pop();
	const ext = file_ext(name || url);
	const is_image = doc.is_image != null ? !!doc.is_image : /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(cstr(url));
	const size = doc.file_size ? file_size(doc.file_size) : "";
	return {
		title: name,
		ext,
		is_image,
		image: is_image ? url : "",
		tone: FILE_TONES[cstr(ext).toLowerCase()] || "gray",
		meta_text: [ext, size].filter(Boolean).join(" · "),
		href: null,
		actions: vm.actions.length
			? vm.actions
			: [
					{ icon: "es-line-preview", label: __("Preview"), href: url, target: "_blank" },
					{ icon: "es-line-download", label: __("Download"), href: url, download: true },
			  ],
	};
}

sanad.ui.Render = Render;
parts.bind_copy();

export default Render;

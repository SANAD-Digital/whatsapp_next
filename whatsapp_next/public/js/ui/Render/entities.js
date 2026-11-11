// whatsapp.ui.Render entity renderers — the same record at five display levels (reference images
// 02–05): `inline` (inside a table cell or a sentence), `compact` (dense lists), `row` (drawer
// lists and pick results), `card` (when the record deserves space) and `hero` (when it is the
// subject of the screen).
//
// Every kind renders from the same view model, so a person, an item, a document and a file share
// one design language and differ only where the reference says they should: the avatar shape, the
// fact that carries the most weight (amount for financial documents, status and progress for
// tasks), and the quick actions.
//
// A host app adds a kind with `whatsapp.ui.Render.register("my-kind", { row(vm) {…} })`.

import ui from "../_core/index.js";
import { avatar, thumb, chip, chips, fact, progress, actions as action_buttons } from "./parts.js";

const chevron = () => `<span class="whatsapp-kit-ent__go" aria-hidden="true">${ui.icon("es-line-right-chevron", "sm")}</span>`;

/** The badge of a view model, or nothing. */
function badge(vm, { size = "sm" } = {}) {
	if (!vm.status || !vm.status.label) return "";
	return whatsapp.ui.StatusBadge.html({ label: vm.status.label, colour: vm.status.colour, size });
}

/** The primary value (amount, price, progress) — the loudest thing after the title. */
function value_html(vm, { density } = {}) {
	if (vm.progress != null && vm.emphasis === "progress") return progress(vm.progress);
	if (!vm.value || !vm.value.html) return "";
	return `<span class="whatsapp-kit-ent__value${density === "hero" ? " whatsapp-kit-ent__value--hero" : ""}">${vm.value.html}</span>`;
}

/** Media: the record's picture at the size this density calls for. */
function media(vm, size) {
	if (vm.shape === "thumb") return thumb({ src: vm.image, alt: vm.title, size, icon: vm.icon });
	return avatar({ image: vm.image, initials: vm.initials, icon: vm.icon, tone: vm.tone, size, alt: vm.title });
}

/** Wrap a rendered entity in a link or a button when it leads somewhere. */
function shell(vm, density, inner, { tag } = {}) {
	const cls = `whatsapp-kit-ent whatsapp-kit-ent--${density} whatsapp-kit-ent--${vm.kind}${vm.href || vm.clickable ? " whatsapp-kit-ent--go" : ""}`;
	const label = vm.aria_label || vm.title || "";
	if (vm.href) return `<a class="${cls}" href="${ui.escape(vm.href)}" data-name="${ui.escape(vm.name || "")}" title="${ui.escape(label)}">${inner}</a>`;
	if (vm.clickable) return `<button type="button" class="${cls}" data-name="${ui.escape(vm.name || "")}">${inner}</button>`;
	return `<${tag || "span"} class="${cls}" data-name="${ui.escape(vm.name || "")}">${inner}</${tag || "span"}>`;
}

/** Title + one supporting line; the supporting line is whatever the kind ranked first. */
function titles(vm, { density, lines = 1 } = {}) {
	const subs = (vm.lines || []).filter(Boolean).slice(0, lines);
	return `<span class="whatsapp-kit-ent__text">
		<span class="whatsapp-kit-ent__title"${vm.title_ltr ? ' dir="ltr"' : ' dir="auto"'}>${ui.escape(vm.title || vm.name || "")}</span>
		${subs.map((s) => `<span class="whatsapp-kit-ent__sub"${s.ltr ? ' dir="ltr"' : ' dir="auto"'}>${s.html || ui.escape(s.text || "")}</span>`).join("")}
		${density === "compact" && vm.status && vm.status.label ? `<span class="whatsapp-kit-ent__dot whatsapp-kit-tone--${ui.tone(vm.status.colour)}" title="${ui.escape(vm.status.label)}" aria-hidden="true"></span>` : ""}
	</span>`;
}

/** The generic ladder every kind inherits; a kind overrides only what the reference changes. */
export const BASE = {
	inline(vm) {
		const first = (vm.lines || [])[0];
		return shell(vm, "inline", `${media(vm, "xs")}<span class="whatsapp-kit-ent__title" dir="auto">${ui.escape(vm.title || vm.name || "")}</span>${first ? `<span class="whatsapp-kit-ent__sub" ${first.ltr ? 'dir="ltr"' : 'dir="auto"'}>${first.html || ui.escape(first.text || "")}</span>` : ""}`);
	},

	compact(vm) {
		return shell(vm, "compact", `${media(vm, "sm")}${titles(vm, { density: "compact", lines: 1 })}${value_html(vm, { density: "compact" })}`);
	},

	row(vm) {
		const trailing = `${value_html(vm, { density: "row" })}${badge(vm)}${action_buttons(vm.actions)}${vm.href || vm.clickable ? chevron() : ""}`;
		return shell(vm, "row", `${media(vm, "md")}${titles(vm, { density: "row", lines: 2 })}<span class="whatsapp-kit-ent__trail">${trailing}</span>`);
	},

	card(vm) {
		const facts = (vm.facts || []).map((f) => chip(f)).filter(Boolean).join("");
		return shell(
			vm,
			"card",
			`<span class="whatsapp-kit-ent__head">${media(vm, "lg")}${titles(vm, { density: "card", lines: 2 })}${badge(vm)}</span>
			${vm.description ? `<span class="whatsapp-kit-ent__desc" dir="auto">${ui.escape(vm.description)}</span>` : ""}
			${facts ? `<span class="whatsapp-kit-ent__facts">${facts}</span>` : ""}
			<span class="whatsapp-kit-ent__foot">${value_html(vm, { density: "card" })}${action_buttons(vm.actions)}</span>`,
			{ tag: "div" }
		);
	},

	hero(vm) {
		const facts = (vm.facts || []).map((f) => fact(f)).filter(Boolean).join("");
		return `<div class="whatsapp-kit-ent whatsapp-kit-ent--hero whatsapp-kit-ent--${vm.kind}" data-name="${ui.escape(vm.name || "")}">
			<div class="whatsapp-kit-ent__hero-media">${media(vm, "xl")}</div>
			<div class="whatsapp-kit-ent__hero-body">
				<div class="whatsapp-kit-ent__hero-head">
					<h3 class="whatsapp-kit-ent__title" dir="auto">${ui.escape(vm.title || vm.name || "")}</h3>
					${badge(vm, { size: "md" })}
				</div>
				${(vm.lines || []).filter(Boolean).map((s) => `<div class="whatsapp-kit-ent__sub"${s.ltr ? ' dir="ltr"' : ' dir="auto"'}>${s.html || ui.escape(s.text || "")}</div>`).join("")}
				${vm.description ? `<p class="whatsapp-kit-ent__desc" dir="auto">${ui.escape(vm.description)}</p>` : ""}
				${value_html(vm, { density: "hero" })}
				${facts ? `<div class="whatsapp-kit-fact-grid">${facts}</div>` : ""}
				${action_buttons(vm.actions, { size: "md" })}
			</div>
		</div>`;
	},
};

/** People and organisations — a picture is the fastest way to tell two of them apart (image 02). */
const person = {
	row(vm) {
		const trailing = `${badge(vm)}${action_buttons(vm.actions)}${vm.href || vm.clickable ? chevron() : ""}`;
		return shell(vm, "row", `${media(vm, "md")}${titles(vm, { density: "row", lines: 2 })}<span class="whatsapp-kit-ent__trail">${trailing}</span>`);
	},
};

/** Items and products — the picture carries more weight, price and stock are prominent (image 03). */
const item = {
	compact(vm) {
		return shell(vm, "compact", `${media(vm, "sm")}${titles(vm, { density: "compact", lines: 1 })}<span class="whatsapp-kit-ent__trail">${value_html(vm, { density: "compact" })}${badge(vm)}</span>`);
	},
	card(vm) {
		const facts = (vm.facts || []).map((f) => chip(f)).filter(Boolean).join("");
		return shell(
			vm,
			"card",
			`<span class="whatsapp-kit-ent__cover">${thumb({ src: vm.image, alt: vm.title, size: "cover", icon: vm.icon })}${vm.flag ? `<span class="whatsapp-kit-ent__flag">${whatsapp.ui.StatusBadge.html({ label: vm.flag.label, colour: vm.flag.colour, icon: false })}</span>` : ""}</span>
			<span class="whatsapp-kit-ent__body">
				<span class="whatsapp-kit-ent__title" dir="auto">${ui.escape(vm.title || vm.name || "")}</span>
				${(vm.lines || []).slice(0, 1).map((s) => `<span class="whatsapp-kit-ent__sub" dir="ltr">${s.html || ui.escape(s.text || "")}</span>`).join("")}
				${value_html(vm, { density: "card" })}
				${facts ? `<span class="whatsapp-kit-ent__facts">${facts}</span>` : ""}
				${badge(vm)}
			</span>`,
			{ tag: "div" }
		);
	},
};

/** Linked documents — never just the number: type, party, date and the amount or progress (image 04). */
const document_kind = {
	compact(vm) {
		return shell(
			vm,
			"compact",
			`${media(vm, "sm")}<span class="whatsapp-kit-ent__text"><span class="whatsapp-kit-ent__title" dir="ltr">${ui.escape(vm.title || vm.name || "")}</span><span class="whatsapp-kit-ent__sub" dir="auto">${ui.escape((vm.lines[0] || {}).text || "")}</span></span><span class="whatsapp-kit-ent__trail">${value_html(vm, { density: "compact" })}${badge(vm)}</span>`
		);
	},
	card(vm) {
		const facts = (vm.facts || []).map((f) => chip(f)).filter(Boolean).join("");
		return shell(
			vm,
			"card",
			`<span class="whatsapp-kit-ent__head">${media(vm, "md")}<span class="whatsapp-kit-ent__text"><span class="whatsapp-kit-ent__sub" dir="auto">${ui.escape(vm.doctype_label || "")}</span><span class="whatsapp-kit-ent__title" dir="ltr">${ui.escape(vm.title || vm.name || "")}</span></span>${action_buttons(vm.actions)}</span>
			${badge(vm)}
			${vm.emphasis === "progress" && vm.progress != null ? progress(vm.progress) : value_html(vm, { density: "card" })}
			${(vm.lines || []).slice(1, 2).map((s) => `<span class="whatsapp-kit-ent__sub" dir="auto">${s.html || ui.escape(s.text || "")}</span>`).join("")}
			${facts ? `<span class="whatsapp-kit-ent__facts">${facts}</span>` : ""}`,
			{ tag: "div" }
		);
	},
};

/** Files and images — type, name, size and the actions, without ever showing a path (image 05). */
const file = {
	inline(vm) {
		return shell(vm, "inline", `${media(vm, "xs")}<span class="whatsapp-kit-ent__title" dir="auto">${ui.escape(vm.title)}</span>`);
	},
	compact(vm) {
		return shell(vm, "compact", `${media(vm, "sm")}<span class="whatsapp-kit-ent__text"><span class="whatsapp-kit-ent__title" dir="auto">${ui.escape(vm.title)}</span><span class="whatsapp-kit-ent__sub" dir="ltr">${ui.escape(vm.meta_text || "")}</span></span>`);
	},
	row(vm) {
		return shell(vm, "row", `${media(vm, "md")}<span class="whatsapp-kit-ent__text"><span class="whatsapp-kit-ent__title" dir="auto">${ui.escape(vm.title)}</span><span class="whatsapp-kit-ent__sub" dir="ltr">${ui.escape(vm.meta_text || "")}</span></span><span class="whatsapp-kit-ent__trail">${action_buttons(vm.actions)}</span>`);
	},
	card(vm) {
		return shell(
			vm,
			"card",
			`<span class="whatsapp-kit-ent__cover">${vm.is_image ? thumb({ src: vm.image, alt: vm.title, size: "cover" }) : `<span class="whatsapp-kit-filetype whatsapp-kit-filetype--lg whatsapp-kit-tone--${ui.tone(vm.tone)}"><span class="whatsapp-kit-filetype__ext">${ui.escape(vm.ext || "")}</span></span>`}</span>
			<span class="whatsapp-kit-ent__body">
				<span class="whatsapp-kit-ent__title" dir="auto">${ui.escape(vm.title)}</span>
				<span class="whatsapp-kit-ent__sub" dir="ltr">${ui.escape(vm.meta_text || "")}</span>
				${action_buttons(vm.actions, { size: "sm" })}
			</span>`,
			{ tag: "div" }
		);
	},
};

export const ENTITY_RENDERERS = {
	generic: {},
	person,
	item,
	document: document_kind,
	file,
};

/**
 * Doctype → kind. The host app adds its own with `whatsapp.ui.Render.map({...})`; anything unmapped
 * is decided from the DocType's own meta (a `first_name` makes a person, an `item_code` an item).
 */
export const KIND_BY_DOCTYPE = {
	Contact: "person",
	User: "person",
	Employee: "person",
	Customer: "person",
	Supplier: "person",
	Lead: "person",
	"Sales Person": "person",
	Item: "item",
	Product: "item",
	File: "file",
};

/** Meta hints used when a DocType is not mapped explicitly. */
export const KIND_HINTS = [
	{ kind: "person", fields: ["first_name", "employee_name", "user_image", "designation", "customer_name", "supplier_name"] },
	{ kind: "item", fields: ["item_code", "stock_uom", "item_group"] },
	{ kind: "file", fields: ["file_url", "file_name", "file_size"] },
];

export default ENTITY_RENDERERS;

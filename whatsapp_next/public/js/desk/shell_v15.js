// Frappe 15 only: the product's navigation. Frappe 16 draws it from the Workspace Sidebar; Frappe 15
// has no such thing, so a Page had no way to any other screen and a list wore Desk's «Filter By»
// column instead. This draws the same menu from the same file (`workspace_sidebar/whatsapp.json`), so
// an item added on `main` appears here too.

import SIDEBAR from "../../../workspace_sidebar/whatsapp.json";

(function () {
	// Lucide, the set Frappe 16 draws these items with; Frappe 15 does not ship it
	const ICONS = {
		"home": `<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" /> <path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />`,
		"smartphone": `<rect width="14" height="20" x="5" y="2" rx="2" ry="2" /> <path d="M12 18h.01" />`,
		"messages-square": `<path d="M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" /> <path d="M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1" />`,
		"send": `<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" /> <path d="m21.854 2.147-10.94 10.939" />`,
		"inbox": `<polyline points="22 12 16 12 14 15 10 15 8 12 2 12" /> <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />`,
		"list-ordered": `<path d="M11 5h10" /> <path d="M11 12h10" /> <path d="M11 19h10" /> <path d="M4 4h1v5" /> <path d="M4 9h2" /> <path d="M6.5 20H3.4c0-1 2.6-1.925 2.6-3.5a1.5 1.5 0 0 0-2.6-1.02" />`,
		"users": `<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /> <path d="M16 3.128a4 4 0 0 1 0 7.744" /> <path d="M22 21v-2a4 4 0 0 0-3-3.87" /> <circle cx="9" cy="7" r="4" />`,
		"contact-round": `<path d="M16 2v2" /> <path d="M17.915 21a6 6 0 10-12 0" /> <path d="M8 2v2" /> <circle cx="12" cy="11" r="4" /> <rect x="3" y="3" width="18" height="18" rx="2" />`,
		"phone-call": `<path d="M13 2a9 9 0 0 1 9 9" /> <path d="M13 6a5 5 0 0 1 5 5" /> <path d="M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384" />`,
		"layout-template": `<rect width="18" height="7" x="3" y="3" rx="1" /> <rect width="9" height="7" x="3" y="14" rx="1" /> <rect width="5" height="7" x="16" y="14" rx="1" />`,
		"message-square-text": `<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" /> <path d="M7 11h10" /> <path d="M7 15h6" /> <path d="M7 7h8" />`,
		"bell": `<path d="M10.268 21a2 2 0 0 0 3.464 0" /> <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />`,
		"alarm-clock": `<circle cx="12" cy="13" r="8" /> <path d="M12 9v4l2 2" /> <path d="M5 3 2 6" /> <path d="m22 6-3-3" /> <path d="M6.38 18.7 4 21" /> <path d="M17.64 18.67 20 21" />`,
		"megaphone": `<path d="M11 6a13 13 0 0 0 8.4-2.8A1 1 0 0 1 21 4v12a1 1 0 0 1-1.6.8A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" /> <path d="M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14" /> <path d="M8 6v8" />`,
		"circle-dashed": `<path d="M10.1 2.182a10 10 0 0 1 3.8 0" /> <path d="M13.9 21.818a10 10 0 0 1-3.8 0" /> <path d="M17.609 3.721a10 10 0 0 1 2.69 2.7" /> <path d="M2.182 13.9a10 10 0 0 1 0-3.8" /> <path d="M20.279 17.609a10 10 0 0 1-2.7 2.69" /> <path d="M21.818 10.1a10 10 0 0 1 0 3.8" /> <path d="M3.721 6.391a10 10 0 0 1 2.7-2.69" /> <path d="M6.391 20.279a10 10 0 0 1-2.69-2.7" />`,
		"workflow": `<rect width="8" height="8" x="3" y="3" rx="2" /> <path d="M7 11v4a2 2 0 0 0 2 2h4" /> <rect width="8" height="8" x="13" y="13" rx="2" />`,
		"terminal": `<path d="M12 19h8" /> <path d="m4 17 6-6-6-6" />`,
		"square-function": `<rect width="18" height="18" x="3" y="3" rx="2" ry="2" /> <path d="M9 17c2 0 2.8-1 2.8-2.8V10c0-2 1-3.3 3.2-3" /> <path d="M9 11.2h5.7" />`,
		"cog": `<path d="M11 10.27 7 3.34" /> <path d="m11 13.73-4 6.93" /> <path d="M12 22v-2" /> <path d="M12 2v2" /> <path d="M14 12h8" /> <path d="m17 20.66-1-1.73" /> <path d="m17 3.34-1 1.73" /> <path d="M2 12h2" /> <path d="m20.66 17-1.73-1" /> <path d="m20.66 7-1.73 1" /> <path d="m3.34 17 1.73-1" /> <path d="m3.34 7 1.73 1" /> <circle cx="12" cy="12" r="2" /> <circle cx="12" cy="12" r="8" />`,
		"flask-conical": `<path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2" /> <path d="M6.453 15h11.094" /> <path d="M8.5 2h7" />`,
		"settings": `<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" /> <circle cx="12" cy="12" r="3" />`,
		"rocket": `<path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" /> <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09" /> <path d="M9 12a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.4 22.4 0 0 1-4 2z" /> <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 .05 5 .05" />`,
		"message-circle": `<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" />`,
		"chevron-down": `<path d="m6 9 6 6 6-6" />`,
		"menu": `<path d="M4 5h16" /> <path d="M4 12h16" /> <path d="M4 19h16" />`
	};
	const MODULE = "WhatsApp Next";
	const OPEN_SECTIONS = "wa_nav15_closed";

	const icon = (name) =>
		`<svg class="wa-nav15__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;

	function allowed(item) {
		if (item.link_type === "Page") return !!(frappe.boot.page_info || {})[item.link_to];
		return frappe.model.can_read(item.link_to);
	}

	function href(item) {
		return item.link_type === "Page" ? `/app/${item.link_to}` : `/app/${frappe.router.slug(item.link_to)}`;
	}

	/** The menu as Frappe 16 groups it: loose items, then sections holding what this user may open. */
	function sections() {
		const out = [{ items: [] }];
		(SIDEBAR.items || []).forEach((item) => {
			if (item.type === "Section Break") out.push({ label: item.label, icon: item.icon, items: [] });
			else if (item.type === "Link" && allowed(item)) out[out.length - 1].items.push(item);
		});
		return out.filter((section) => section.items.length);
	}

	function closed() {
		try {
			return JSON.parse(localStorage.getItem(OPEN_SECTIONS)) || [];
		} catch (e) {
			return [];
		}
	}

	function remember(list) {
		try {
			localStorage.setItem(OPEN_SECTIONS, JSON.stringify(list));
		} catch (e) {
			// a private window: the section simply opens again next time
		}
	}

	function draw() {
		const shut = closed();
		const row = (item) => `<a class="wa-nav15__item" href="${href(item)}" data-link="${frappe.utils.escape_html(item.link_to)}">
			${icon(item.icon)}<span>${frappe.utils.escape_html(__(item.label))}</span>
		</a>`;
		const body = sections()
			.map((section) => {
				if (!section.label) return section.items.map(row).join("");
				const open = !shut.includes(section.label);
				return `<div class="wa-nav15__section${open ? "" : " is-shut"}" data-section="${frappe.utils.escape_html(section.label)}">
					<button type="button" class="wa-nav15__head" aria-expanded="${open}">
						<span>${frappe.utils.escape_html(__(section.label))}</span>${icon("chevron-down")}
					</button>
					<div class="wa-nav15__items">${section.items.map(row).join("")}</div>
				</div>`;
			})
			.join("");
		const $nav = $(`<aside class="wa-nav15" aria-label="${frappe.utils.escape_html(__("WhatsApp"))}">
			<a class="wa-nav15__brand" href="/app/whatsapp">
				<img src="/assets/whatsapp_next/images/whatsapp-next-icon.svg" alt="">
				<span>${frappe.utils.escape_html(__("WhatsApp"))}</span>
			</a>
			<nav class="wa-nav15__body">${body}</nav>
		</aside>`).appendTo(document.body);
		$('<div class="wa-nav15__scrim" aria-hidden="true"></div>').appendTo(document.body).on("click", () => toggle(false));
		$(`<button type="button" class="wa-nav15__toggle" aria-label="${frappe.utils.escape_html(__("Menu"))}">${icon("menu")}</button>`)
			.insertAfter(".navbar .navbar-home")
			.on("click", () => toggle(!$("body").hasClass("wa-nav15-open")));
		$nav.on("click", ".wa-nav15__head", (e) => {
			const $section = $(e.currentTarget).closest(".wa-nav15__section");
			const shutNow = $section.toggleClass("is-shut").hasClass("is-shut");
			$(e.currentTarget).attr("aria-expanded", String(!shutNow));
			const name = $section.attr("data-section");
			remember(shutNow ? [...new Set([...closed(), name])] : closed().filter((x) => x !== name));
		});
		$nav.on("click", "a", (e) => {
			if (e.ctrlKey || e.metaKey || e.shiftKey) return;
			e.preventDefault();
			toggle(false);
			frappe.set_route(e.currentTarget.getAttribute("href").replace(/^\/app\//, ""));
		});
		return $nav;
	}

	function toggle(open) {
		$("body").toggleClass("wa-nav15-open", open);
	}

	/** The route's DocType or Page when it is one of this product's, else nothing. */
	function current() {
		const route = frappe.get_route() || [];
		if (route[0] === "Workspaces") return route[route.length - 1] === "WhatsApp" ? "WhatsApp" : null;
		if (["List", "Form"].includes(route[0])) {
			const meta = route[1] && frappe.get_meta(route[1]);
			return route[1] && ((meta && meta.module === MODULE) || String(route[1]).startsWith("WhatsApp ")) ? route[1] : null;
		}
		return String(route[0] || "").startsWith("wa-") ? route[0] : null;
	}

	let $nav = null;

	function update() {
		const here = current();
		$("body").toggleClass("wa-shell15", !!here);
		if (!here) return toggle(false);
		$nav = $nav || draw();
		$nav.find(".wa-nav15__item").each((_, el) => {
			const on = el.getAttribute("data-link") === here;
			el.classList.toggle("is-on", on);
			if (on) el.setAttribute("aria-current", "page");
			else el.removeAttribute("aria-current");
		});
		const $on = $nav.find(".wa-nav15__item.is-on").closest(".wa-nav15__section");
		if ($on.hasClass("is-shut")) $on.removeClass("is-shut").find(".wa-nav15__head").attr("aria-expanded", "true");
	}

	$(document).on("page-change", update);
	frappe.router && frappe.router.on("change", update);
	$(document).on("app_ready", update);
	$(update);
})();

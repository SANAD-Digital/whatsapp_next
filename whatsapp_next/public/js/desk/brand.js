// The WhatsappNext identity in Desk (`brand/BRAND.md`): the mark, the wordmark, and the app icon's
// reading direction. The same mark the platform draws (`WnMark.vue`): a message bubble whose tail
// is a "next" arrow, three typing dots growing toward it (9 : 11 : 13.6), the last one Apricot.
// The arrow always points the way the reader reads — left in Arabic, right in English — for big and
// small marks alike (owner's decision, 2026-10-04).

(function () {
	const BUBBLE =
		"M30 22H62C66 22 69.5 23.8 71.8 26.8L86 45C88.4 48 88.4 52 86 55L71.8 73.2C69.5 76.2 66 78 62 78H30C20 78 12 70 12 60V40C12 30 20 22 30 22Z";

	// petrol (on light) · paper (on Petrol or Ink) · ghost (a watermark on Petrol, one tone). The
	// colours are the brand tokens of `_tokens.scss` (the same in both themes), read through CSS.
	const TONES = {
		petrol: { bubble: "--wa-brand", dot: "--wa-on-brand", last: "--wa-accent" },
		paper: { bubble: "--wa-on-brand", dot: "--wa-brand", last: "--wa-accent" },
		ghost: { bubble: "--wa-brand-deep", dot: "--wa-brand", last: "--wa-brand-deep" },
	};
	const fill = (token) => `style="fill: var(${token})"`;

	// The arrow points right to left in every language (owner, 2026-10-27): the bubble is drawn
	// pointing right and mirrored in place, as the brand's files are.
	const MIRROR = ' transform="translate(100 0) scale(-1 1)"';

	function mark(size = 24, tone = "petrol") {
		const c = TONES[tone] || TONES.petrol;
		return `<svg class="wn-mark" viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true" focusable="false"><g${MIRROR}><path d="${BUBBLE}" ${fill(c.bubble)}/><circle cx="27" cy="50" r="4.5" ${fill(c.dot)}/><circle cx="42.5" cy="50" r="5.5" ${fill(c.dot)}/><circle cx="59.5" cy="50" r="6.8" ${fill(c.last)}/></g></svg>`;
	}

	// «Whatsapp» light and «Next» bold; in Arabic «واتساب» light and «نكست» bold.
	function wordmark() {
		const ar = (frappe.boot?.lang || "").startsWith("ar");
		const [w1, w2] = ar ? ["واتساب", "نكست"] : ["Whatsapp", "Next"];
		const sep = ar ? " " : "";
		return `<span class="wn-wordmark" lang="${ar ? "ar" : "en"}"><span class="wn-w1">${w1}</span>${sep}<span class="wn-w2">${w2}</span></span>`;
	}

	// The app icon is a file (`desktop_icon/whatsapp.json`, `app_logo_url`); its arrow points right
	// to left in every language, so Desk draws the same file in Arabic and in English.
	const ICON = "/assets/whatsapp_next/images/whatsapp-next-icon.svg";

	// The module's own workspace ("WhatsApp Next") has no Desktop Icon of its own, so Desk draws a
	// grey letter in its sidebar header; it wears the app icon like every other screen of the product.
	const NAMES = ["WhatsApp Next", "WhatsappNext"];
	function brand_headers() {
		const names = new Set(NAMES.flatMap((n) => [n, __(n)]));
		document.querySelectorAll(".body-sidebar .sidebar-header").forEach((head) => {
			const title = head.querySelector(".header-title")?.childNodes[0]?.textContent.trim();
			const logo = head.querySelector(".header-logo");
			if (!logo || !names.has(title) || logo.querySelector(`img[src*="whatsapp-next-icon"]`)) return;
			logo.innerHTML = `<img src="${ICON}" alt="">`;
		});
	}


	let pending = null;
	const schedule = () => {
		window.clearTimeout(pending);
		pending = window.setTimeout(brand_headers, 50);
	};
	$(document).on("page-change", schedule);
	$(() => {
		schedule();
		new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
	});

	frappe.provide("whatsapp_next.brand");
	Object.assign(whatsapp_next.brand, { mark, wordmark });
})();

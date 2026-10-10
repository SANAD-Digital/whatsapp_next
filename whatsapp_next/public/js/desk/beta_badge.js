// The whole app is in beta. A small quiet tag beside its name in the Desk sidebar header says so on
// every screen, without a banner that takes room. It sits on the title line: the subtitle is cut
// with an ellipsis before its end. Desk rebuilds the sidebar when the workspace
// changes, so the tag is put back whenever the header is drawn — and only on this app's header,
// recognised by the subtitle Desk writes there (the app title from `hooks.py`).

(function () {
	const APP_TITLE = "WhatsappNext";

	function mark() {
		document.querySelectorAll(".body-sidebar .sidebar-header .header-subtitle").forEach((sub) => {
			// the subtitle is long enough to be cut with an ellipsis; the title line has room
			const el = sub.parentElement && sub.parentElement.querySelector(".header-title");
			if (!el || el.querySelector(".wa-beta")) return;
			const title = sub.textContent.trim();
			// the module's name ("WhatsApp Next") reaches the header too, depending on the route
			const ours = [APP_TITLE, "WhatsApp Next"].flatMap((n) => [n, __(n)]);
			if (!sub.querySelector(".wn-wordmark") && !ours.includes(title)) return;
			// the product's name is drawn as its wordmark (`desk/brand.js`)
			if (!sub.querySelector(".wn-wordmark")) sub.innerHTML = whatsapp_next.brand.wordmark();
			const tag = document.createElement("span");
			tag.className = "wa-beta";
			// the word alone (owner, 2026-10-08): the β glyph read as a stray letter beside it
			tag.textContent = __("Beta");
			tag.title = __("This app is in beta: screens and features may still change.");
			el.appendChild(tag);
		});
	}

	let pending = null;
	const schedule = () => {
		window.clearTimeout(pending);
		pending = window.setTimeout(mark, 50);
	};

	$(document).on("page-change", schedule);
	$(() => {
		schedule();
		const root = document.querySelector(".body-sidebar-container") || document.body;
		new MutationObserver(schedule).observe(root, { childList: true, subtree: true });
	});
})();

// The whole app is in beta. A small quiet tag beside its name in the Desk sidebar header says so on
// every screen, without a banner that takes room. It sits on the title line: the subtitle is cut
// with an ellipsis before its end. Desk rebuilds the sidebar when the workspace
// changes, so the tag is put back whenever the header is drawn — and only on this app's header,
// recognised by the subtitle Desk writes there (the app title from `hooks.py`).

(function () {
	const APP_TITLE = "WhatsApp Next";

	// The product's own beta mark: a β whose upper bowl is drawn whole — what is built and holds —
	// and whose lower bowl breaks into segments as it goes — what is still being drawn — with a
	// spark off its shoulder for "new". One stroke in `currentColor`, so it takes the tag's ink in
	// light and dark. This is the small cut (two breaks, a heavier stroke) that stays legible at
	// 11 px; the detailed cut for large sizes is `public/images/beta-mark.svg`.
	const BETA_MARK = `<svg class="wa-beta__mark" viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
		<path d="M5 14.6V6.1C5 4.2 6.3 2.9 8.1 2.9c1.8 0 2.9 1.1 2.9 2.6 0 1.4-1.1 2.4-2.7 2.4H7.2"/>
		<path d="M8.3 7.9c2 0 3.7 1.3 3.7 3.05S10.6 14 8.7 14c-1.5 0-2.8-.6-3.7-1.6" stroke-linecap="butt" stroke-dasharray="0 0 4.6 2.1 3.4 2.1 3"/>
		<circle cx="13.2" cy="3.1" r="1.05" fill="currentColor" stroke="none"/>
	</svg>`;

	function mark() {
		document.querySelectorAll(".body-sidebar .sidebar-header .header-subtitle").forEach((sub) => {
			// the subtitle is long enough to be cut with an ellipsis; the title line has room
			const el = sub.parentElement && sub.parentElement.querySelector(".header-title");
			if (!el || el.querySelector(".wa-beta") || sub.textContent.trim() !== APP_TITLE) return;
			const tag = document.createElement("span");
			tag.className = "wa-beta";
			tag.innerHTML = `${BETA_MARK}<span>${frappe.utils.escape_html(__("Beta"))}</span>`;
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

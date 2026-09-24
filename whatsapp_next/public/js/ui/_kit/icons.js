// sanad.kit.icons — the design prototype's own icon set, ported verbatim.
//
// Frappe ships Espresso, which is a fine icon set and the wrong one: the prototypes were drawn with
// these, at this weight, on this 20×20 grid, and a screen that mixes the two reads as two screens.
// Every glyph below is copied from `docs/shared/ui-kit.js` and `docs/component/*.dc.html` exactly
// as it was drawn — `currentColor` throughout, so a glyph takes the colour of whatever it sits in,
// and `width`/`height` are overridden by the `.wa-ico` class rather than by editing the markup.
//
// `ui.ico(name, size)` returns the markup; an unknown name returns an empty string rather than a
// broken glyph, so a typo never paints a box.

const ICONS = {
	alert: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10 6v5"/><circle cx="10" cy="14" r="1" fill="currentColor" stroke="none"/></svg>',
	attach: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 7l-5.2 5.2a2.3 2.3 0 103.3 3.3L16 10.6a4 4 0 10-5.7-5.7L5 10.3"/></svg>',
	calendar: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="14" height="12" rx="1.5"/><path d="M3 9h14M7 3v4M13 3v4" stroke-linecap="round"/></svg>',
	card: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none"><rect x="2.5" y="5" width="15" height="10" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M2.5 9h15" stroke="currentColor" stroke-width="1.6"/></svg>',
	cards: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3.5" width="6" height="6" rx="1.5"/><rect x="11" y="3.5" width="6" height="6" rx="1.5"/><rect x="3" y="10.5" width="6" height="6" rx="1.5"/><rect x="11" y="10.5" width="6" height="6" rx="1.5"/></svg>',
	caret: '<svg viewBox="0 0 20 20" fill="none"><path d="M5 8l5 5 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
	caretUp: '<svg viewBox="0 0 20 20" fill="none"><path d="M5 12l5-5 5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
	chart: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none"><path d="M4 16V9M8.6 16V4.5M13.2 16v-4.5M17 16h-14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
	chat: '<svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3.5 4.5h13v8.5h-8L5 16v-3H3.5z" stroke-linejoin="round"/></svg>',
	check: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.6"/><path d="M6.8 10.2l2.2 2.2 4.2-4.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
	chevronEnd: '<svg viewBox="0 0 20 20" fill="none"><path d="M7 4l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
	chevronStart: '<svg viewBox="0 0 20 20" fill="none"><path d="M12 5l-5 5 5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
	clear: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l8 8M14 6l-8 8"/></svg>',
	clock: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.6"/><path d="M10 6.2V10l2.6 1.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
	code: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none"><path d="M7 6l-3.5 4L7 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 6l3.5 4L13 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
	copy: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="7" y="7" width="9" height="9" rx="1.5"/><path d="M4 13V5.5A1.5 1.5 0 015.5 4H13" stroke-linecap="round"/></svg>',
	device: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none"><rect x="6" y="2.5" width="8" height="15" rx="2.2" stroke="currentColor" stroke-width="1.6"/><path d="M8.8 15h2.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
	doc: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="2.5" width="12" height="15" rx="2"/><path d="M7 7h6M7 10.5h6M7 14h3" stroke-linecap="round"/></svg>',
	error: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.6"/><path d="M10 6.2v4.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="10" cy="13.4" r=".9" fill="currentColor"/></svg>',
	eye: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z"/><circle cx="10" cy="10" r="2.5"/></svg>',
	fail: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.6"/><path d="M7.6 7.6l4.8 4.8M12.4 7.6l-4.8 4.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
	gear: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="2.6"/><path d="M10 3v2M10 15v2M3 10h2M15 10h2M5.4 5.4l1.4 1.4M13.2 13.2l1.4 1.4M14.6 5.4l-1.4 1.4M6.8 13.2l-1.4 1.4" stroke-linecap="round"/></svg>',
	hook: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M7 5.5a2.5 2.5 0 115 0v6a2.5 2.5 0 105 0"/></svg>',
	info: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.6"/><path d="M10 9.4v4.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="10" cy="6.6" r=".9" fill="currentColor"/></svg>',
	link: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8.5 11.5l3-3"/><path d="M7.5 13.5l-1 1a2.5 2.5 0 01-3.5-3.5l2.5-2.5a2.5 2.5 0 013.5 0"/><path d="M12.5 6.5l1-1a2.5 2.5 0 013.5 3.5l-2.5 2.5a2.5 2.5 0 01-3.5 0"/></svg>',
	note: '<svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 3.5h7l3 3v10H5z" stroke-linejoin="round"/><path d="M7.5 10h5M7.5 13h5" stroke-linecap="round"/></svg>',
	pause: '<svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M7.5 5v10M12.5 5v10"/></svg>',
	pin: '<svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M10 17.5s-5.5-4.6-5.5-9a5.5 5.5 0 0111 0c0 4.4-5.5 9-5.5 9z"/><circle cx="10" cy="8.5" r="1.8"/></svg>',
	plus: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10 4v12M4 10h12"/></svg>',
	queue: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none"><path d="M6 3.5h8M6 16.5h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M7 3.5c0 4 6 5 6 6.5s-6 2.5-6 6.5" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
	read: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none"><path d="M2.5 10.6l3 3 6-6.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 13.6l1 1 7.5-8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
	scan: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 7V4.5A1.5 1.5 0 014.5 3H7M13 3h2.5A1.5 1.5 0 0117 4.5V7M17 13v2.5a1.5 1.5 0 01-1.5 1.5H13M7 17H4.5A1.5 1.5 0 013 15.5V13M5 10h10"/></svg>',
	search: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none"><circle cx="9" cy="9" r="5.5" stroke="currentColor" stroke-width="1.6"/><path d="M13 13l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
	send: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3 10l14-6-4 14-3-6z"/><path d="M10 12l7-8"/></svg>',
	shield: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M10 3l6 2v5c0 3.4-2.4 6-6 7-3.6-1-6-3.6-6-7V5l6-2z"/></svg>',
	sigma: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none"><path d="M14 4.5H6l4.4 5.4L6 15.5h8" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>',
	table: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="14" height="12" rx="2"/><path d="M3 8.5h14M8.5 8.5V16"/></svg>',
	tick: '<svg viewBox="0 0 20 20" fill="none"><path d="M5 10.5l3.5 3.5L15 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
	trash: '<svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 6.5h12M8 6.5V4.5h4v2M6 6.5l.7 9h6.6l.7-9"/></svg>',
	unlink: '<svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 12l-1 1a2.6 2.6 0 01-3.7-3.7l1.4-1.4"/><path d="M12 8l1-1a2.6 2.6 0 013.7 3.7l-1.4 1.4"/><path d="M4 4l12 12" opacity=".5"/></svg>',
	user: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="7" r="3"/><path d="M4.5 16.5c.8-2.7 2.9-4 5.5-4s4.7 1.3 5.5 4" stroke-linecap="round"/></svg>',
	users: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7.5" cy="7" r="2.6"/><circle cx="13.5" cy="8.5" r="2"/><path d="M3 16c.7-2.4 2.5-3.6 4.5-3.6S11.3 13.6 12 16" stroke-linecap="round"/></svg>',
	warn: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M10 3.5l7 12H3l7-12z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M10 8v3.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="10" cy="13.6" r=".9" fill="currentColor"/></svg>',
	whatsapp: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3.5 16.5l1-3.4A7 7 0 1110 17a7 7 0 01-3.2-.8z" stroke-linejoin="round"/><path d="M7.5 7.5c0 3 2 5 5 5l.8-1.2-1.6-.8-.7.6c-1-.4-1.8-1.2-2.2-2.2l.6-.7-.8-1.6z" fill="currentColor" stroke="none"/></svg>',
	wifiOff: '<svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 8.5a9 9 0 0112 0M6.5 11.5a5.5 5.5 0 017 0"/><circle cx="10" cy="15" r="1" fill="currentColor" stroke="none"/><path d="M3 3l14 14"/></svg>',
	x: '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l8 8M14 6l-8 8"/></svg>',
};

/**
 * @param {string} name — a key of the set above
 * @param {"xs"|"sm"|"md"|"lg"} [size="sm"] — 14 · 16 · 20 · 26 px, set by the class not the markup
 * @param {string} [cls] — extra classes on the wrapper
 */
export function ico(name, size = "sm", cls = "") {
	const glyph = ICONS[name];
	if (!glyph) return "";
	return `<span class="wa-ico wa-ico--${size}${cls ? ` ${cls}` : ""}" aria-hidden="true">${glyph}</span>`;
}

export const ICON_NAMES = Object.keys(ICONS);
export default ICONS;

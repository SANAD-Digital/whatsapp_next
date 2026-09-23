// Regression checks for the kit's list table (sanad.ui.DataList + FilterBar).
//
// These assert the things that broke more than once while the list was being built: the stacking
// order around sticky cells, the grouping tree, group selection, the toolbar's shape at several
// widths, its overflow into "More" on a narrow desktop, the phone's filter drawer, and the
// date filter's popup placement, per-field rail and grid pickers. Run it after touching `public/js/ui/DataList` or `public/js/ui/FilterBar`.
//
// Needs Playwright + Chromium outside the repo (see scripts/browser_smoke.mjs), and is run from
// that folder so `playwright` resolves:
//   SMOKE_PASS=… node /path/to/apps/whatsapp_next/scripts/list_checks.mjs
// Exits non-zero on the first failed check.

import { chromium } from "playwright";

const HOST = process.env.SMOKE_HOST || "https://whatsapp.dev.sanad.digital";
const USER = process.env.SMOKE_USER || "kit-shot@example.com";
const PASS = process.env.SMOKE_PASS || "";
const ROUTE = process.env.SMOKE_ROUTE || "whatsapp-log";
const hostname = new URL(HOST).hostname;

let failures = 0;
const check = (name, ok, detail) => {
	if (!ok) failures += 1;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch({
	args: [`--host-resolver-rules=MAP ${hostname} 127.0.0.1`, "--ignore-certificate-errors"],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, ignoreHTTPSErrors: true });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
	if (m.type() === "error" && !/socket\.io|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text().slice(0, 200)}`);
});

await page.goto(`${HOST}/login`, { waitUntil: "networkidle" });
await page.fill("#login_email", USER);
await page.fill("#login_password", PASS);
await Promise.all([page.waitForNavigation({ waitUntil: "networkidle" }), page.click(".btn-login")]);
await page.evaluate(async () => {
	await frappe.xcall("frappe.client.set_value", { doctype: "User", name: frappe.session.user, fieldname: "language", value: "en" });
});
await page.goto(`${HOST}/app/${ROUTE}`, { waitUntil: "networkidle" });
await page.waitForTimeout(3000);
// Frappe remembers a user's list filters, so a previous run's leftovers would decide how much room
// the toolbar has and what this run measures. Every run starts from none.
await page.evaluate(async () => {
	await cur_list.filter_area.clear(false);
	cur_list.refresh();
});
await page.waitForTimeout(1800);

// ---- the toolbar is one line at every desktop width: what does not fit goes behind "More" ----
const wrapped = (sel) =>
	page.evaluate((s) => {
		const box = document.querySelector(s);
		if (!box) return false;
		const rects = [...box.children].filter((k) => k.offsetParent).map((k) => k.getBoundingClientRect());
		if (rects.length < 2) return false;
		const first = rects[0];
		return rects.some((r) => r.top >= first.bottom - 1 || r.bottom <= first.top + 1);
	}, sel);

for (const width of [1700, 1400, 1200, 1000, 900]) {
	await page.setViewportSize({ width, height: 950 });
	await page.waitForTimeout(700);
	const state = await page.evaluate(() => {
		const main = document.querySelector(".sanad-filterbar__main");
		const dd = [...main.querySelectorAll(":scope > .sanad-filterbar__dd")].filter((e) => !e.classList.contains("sanad-filterbar__dd--more"));
		const more = document.querySelector(".sanad-filterbar__dd--more");
		const count = document.querySelector(".sanad-filterbar__more-count");
		return {
			total: dd.length,
			shown: dd.filter((e) => e.offsetParent).length,
			more_on: !!(more && !more.hasAttribute("hidden")),
			count: count ? parseInt(count.textContent || "0", 10) || 0 : 0,
			phone: !!document.querySelector(".sanad-filterbar__mobile-toggle").offsetParent,
		};
	});
	const one_line = !(await wrapped(".sanad-filterbar__main")) && !(await wrapped(".sanad-filterbar__actions"));
	check(`${width}px: the toolbar stays on one line`, one_line);
	check(
		`${width}px: every filter is shown or counted in "More"`,
		!state.phone && state.shown + state.count === state.total && (state.count > 0) === state.more_on,
		`${state.shown} shown, ${state.count} behind More of ${state.total}`
	);
}

// the search box shows its icon: Desk's `.form-control` is positioned, so the input used to paint
// over it and the icon was never visible at any width
const search_icon = await page.evaluate(() => {
	const icon = document.querySelector(".sanad-filterbar__search-icon");
	const input = document.querySelector(".sanad-filterbar__search");
	if (!icon || !input) return null;
	const box = icon.getBoundingClientRect();
	const field = input.getBoundingClientRect();
	const use = icon.querySelector("use");
	const href = use ? (use.getAttribute("href") || "").slice(1) : "";
	return {
		z: getComputedStyle(icon).zIndex,
		painted: box.width > 0 && box.height > 0 && box.left >= field.left && box.right <= field.right,
		symbol: !!(href && document.getElementById(href)),
	};
});
check("the search box shows its icon", !!search_icon && search_icon.painted && search_icon.symbol && search_icon.z !== "auto", JSON.stringify(search_icon));

// the hidden ones are reachable, and they are the same fields the toolbar would have shown
await page.setViewportSize({ width: 900, height: 950 });
await page.waitForTimeout(700);
const hidden_now = await page.$eval(".sanad-filterbar__more-count", (e) => parseInt(e.textContent || "0", 10) || 0).catch(() => 0);
if (hidden_now) {
	await page.click(".sanad-filterbar__more");
	await page.waitForTimeout(500);
	const rows = await page.$$eval(".sanad-filterbar__more-list .sanad-filter-sheet__row", (n) => n.length);
	check('"More" lists every filter it hides', rows === hidden_now, `${rows} row(s) for ${hidden_now} hidden`);
	await page.click(".sanad-filterbar__more-list .sanad-filter-sheet__trigger >> nth=0");
	await page.waitForTimeout(800);
	const opts = await page.$$eval(".sanad-filterbar__more-list .sanad-filterbar__opt", (n) => n.length);
	check("a filter opens its options inside More", opts > 0, `${opts} option(s)`);
	await page.keyboard.press("Escape");
	await page.waitForTimeout(300);
} else {
	check('"More" lists every filter it hides', false, "nothing overflowed at 900px");
}
await page.setViewportSize({ width: 1500, height: 950 });
await page.waitForTimeout(600);

// ---- grouping ----
// grouping is remembered per user in List View Settings, so the run starts from none and adds its
// own; without the reset a second run piled levels on the first one's and measured a different table
await page.click(".sanad-filterbar__action--group");
await page.waitForTimeout(400);
if ((await page.$$(".sanad-filterbar__levels-clear")).length) {
	await page.click(".sanad-filterbar__levels-clear");
	await page.waitForTimeout(1200);
}
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
for (const i of [1, 0, 0]) {
	await page.click(".sanad-filterbar__action--group");
	await page.waitForTimeout(400);
	// a fresh locator each time: the popover re-renders itself, and a handle taken before that
	// clicks a node that is no longer in the document, silently doing nothing
	const add = await page.$$eval(".sanad-filterbar__level--add", (n) => n.length);
	if (add > i) await page.click(`.sanad-filterbar__level--add >> nth=${i}`);
	await page.waitForTimeout(1200);
	await page.keyboard.press("Escape");
	await page.waitForTimeout(300);
}
const groups = await page.$$eval(".sanad-datalist__group", (n) => n.length);
const boxes = await page.$$eval(".sanad-datalist__group-checkbox", (n) => n.length);
check("grouping renders group rows", groups > 0, `${groups} rows`);
check("every group row has a checkbox", groups === boxes, `${boxes} of ${groups}`);
check("fold-all controls appear", (await page.$$eval(".sanad-datalist__group-tool", (n) => n.length)) === 2);

// only the outermost level is sticky, so a child never piles on its parent
const sticky = await page.$$eval("tr.sanad-datalist__group td", (n) => n.filter((e) => getComputedStyle(e).position === "sticky").length);
check("only top-level group rows stick", sticky > 0 && sticky < groups, `${sticky} of ${groups}`);

// selecting a group selects its records
const before = await page.$$eval(".list-row-checkbox:checked", (n) => n.length);
await page.click(".sanad-datalist__group-checkbox >> nth=0");
await page.waitForTimeout(900);
const after = await page.$$eval(".list-row-checkbox:checked", (n) => n.length);
check("a group checkbox selects its rows", after > before, `${before} → ${after}`);
await page.click(".sanad-datalist__group-checkbox >> nth=0");
await page.waitForTimeout(700);
check("and clears them again", (await page.$$eval(".list-row-checkbox:checked", (n) => n.length)) === before);

// ---- stacking: nothing paints over a sticky group row ----
await page.$eval(".sanad-datalist__wrap", (e) => {
	e.scrollTop = 340;
});
await page.waitForTimeout(600);
for (const [tag, left] of [["scrolled down", 0], ["and sideways", 380]]) {
	if (left) {
		await page.$eval(".sanad-datalist__wrap", (e, x) => {
			e.scrollLeft = x;
		}, left);
		await page.waitForTimeout(600);
	}
	const hits = await page.evaluate(() => {
		const row = Array.from(document.querySelectorAll("tr.sanad-datalist__group")).find((r) => getComputedStyle(r.querySelector("td")).position === "sticky");
		if (!row) return null;
		const box = row.querySelector("td").getBoundingClientRect();
		const wrap = document.querySelector(".sanad-datalist__wrap").getBoundingClientRect();
		const y = Math.round(box.top + box.height / 2);
		return [wrap.left + 22, wrap.left + 60, wrap.left + 200, wrap.left + 600, wrap.right - 120, wrap.right - 40].map((x) => {
			const el = document.elementFromPoint(x, y);
			return el && el.closest("tr.sanad-datalist__group") ? "group" : `${Math.round(x)}:${el ? el.tagName : "none"}`;
		});
	});
	check(`${tag}: the sticky group row is on top`, !!hits && hits.every((h) => h === "group"), hits ? hits.filter((h) => h !== "group").join(", ") : "no sticky row");
}

// the header still wins over everything
const header_top = await page.evaluate(() => {
	const th = document.querySelector("thead th:nth-child(3)");
	const box = th.getBoundingClientRect();
	const el = document.elementFromPoint(Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2));
	return !!(el && el.closest("thead"));
});
check("the header row stays above the body", header_top);

// ---- the date filter: its popups stay under the trigger, and one row per date field ----
await page.setViewportSize({ width: 1500, height: 950 });
await page.evaluate(async () => {
	await cur_list.filter_area.clear(false);
	cur_list.refresh();
});
await page.waitForTimeout(1500);

const anchored = async (opener, popup, tag) => {
	await page.click(opener);
	await page.waitForTimeout(400);
	const box = await page
		.$eval(popup, (el) => {
			const p = el.getBoundingClientRect();
			const t = el.closest(".sanad-datefilter").querySelector(".sanad-datefilter__trigger").getBoundingClientRect();
			return { start: Math.round(p.left - t.left), wide: p.width >= t.width - 1, inside: p.left >= 0 && p.right <= window.innerWidth };
		})
		.catch(() => null);
	check(`${tag} hangs off the trigger and stays on screen`, !!box && Math.abs(box.start) <= 1 && box.wide && box.inside, box ? JSON.stringify(box) : "no popup");
	await page.keyboard.press("Escape");
	await page.waitForTimeout(250);
};
await anchored(".sanad-datefilter:not(.sanad-datefilter--hidden) .sanad-datefilter__op", ".sanad-datefilter__menu", "the operator menu");
await anchored(".sanad-datefilter:not(.sanad-datefilter--hidden) .sanad-datefilter__fieldpick", ".sanad-datefilter__menu--fields", "the field picker");

const live = ".sanad-datefilter:not(.sanad-datefilter--hidden)";
const visible = () => page.$$eval(live, (n) => n.length);
const caption = () => page.$eval(`${live} .sanad-datefilter__fieldpick-label`, (e) => e.textContent.trim());

await page.click(`${live} .sanad-datefilter__fieldpick`);
await page.waitForTimeout(400);
const offered = await page.$$eval(".sanad-datefilter__menu--fields .sanad-datefilter__menu-item", (n) => n.length);
check("the field picker lists the DocType's date fields", offered >= 3, `${offered} offered`);
// an untouched field moves to the one just ticked rather than leaving an empty field behind
await page.click(".sanad-datefilter__menu--fields .sanad-datefilter__menu-item >> nth=2");
await page.waitForTimeout(600);
check("ticking a field on an empty set moves it", (await visible()) === 1 && (await page.$$eval(".sanad-datefilter", (n) => n.length)) === 1);

// apply a range, then tick another field: it is added, and the toolbar still shows one trigger
await page.click(".sanad-datefilter__preset >> nth=2");
await page.waitForTimeout(250);
await page.click(".sanad-datefilter__apply");
await page.waitForTimeout(1400);
await page.click(`${live} .sanad-datefilter__fieldpick`);
await page.waitForTimeout(400);
await page.click(".sanad-datefilter__menu--fields .sanad-datefilter__menu-item >> nth=3");
await page.waitForTimeout(900);
check("a second field keeps one trigger", (await visible()) === 1, `${await visible()} visible`);
check("the field segment turns into a count tag", /2/.test(await caption()) && (await page.$$eval(".sanad-datefilter__fieldpick-label--tag", (n) => n.length)) === 1, await caption());
const rail = await page.$$eval(".sanad-datefilter__rail-item", (n) => n.length);
check("the panel lists both fields on its rail", rail === 2, `${rail} item(s)`);

await page.click(".sanad-datefilter__preset >> nth=0");
await page.waitForTimeout(250);
await page.click(".sanad-datefilter__apply");
await page.waitForTimeout(1600);
const ranges = await page.evaluate(() => cur_list.filter_area.get().filter((f) => f[2] === "Between").length);
check("one Apply commits every field", ranges === 2, `${ranges} range filter(s)`);

// the fiscal panel's year and month open a grid instead of stepping
await page.click(`${live} .sanad-datefilter__op`);
await page.waitForTimeout(400);
await page.click(".sanad-datefilter__menu-item >> nth=7");
await page.waitForTimeout(700);
await page.click(".sanad-datefilter__stepper-value >> nth=0");
await page.waitForTimeout(450);
const years = await page.$$eval(".sanad-datefilter__picker-cell", (n) => n.map((x) => x.textContent.trim()));
check("the fiscal year opens a year grid", years.length === 12 && /^\d{4}$/.test(years[0]), years.slice(0, 2).join(", "));
await page.click(".sanad-datefilter__picker-cell >> nth=8");
await page.waitForTimeout(450);
await page.click(".sanad-datefilter__stepper-value >> nth=1");
await page.waitForTimeout(450);
check("the fiscal start month opens a month grid", (await page.$$eval(".sanad-datefilter__picker-cell", (n) => n.length)) === 12);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// the "…" menu names every action it holds
// how narrow the cluster has to get before it overflows depends on what the date filter is
// showing, so step down until it does rather than guessing one width
let has_amore = false;
for (const w of [900, 860, 820, 790, 768]) {
	await page.setViewportSize({ width: w, height: 950 });
	await page.waitForTimeout(700);
	has_amore = await page.$eval(".sanad-filterbar__dd--amore", (e) => !e.hasAttribute("hidden")).catch(() => false);
	if (has_amore) break;
}
if (has_amore) {
	await page.click(".sanad-filterbar__dd--amore .sanad-filterbar__action");
	await page.waitForTimeout(600);
	const named = await page.$$eval(".sanad-filterbar__amore-item", (n) =>
		n.map((e) => {
			const label = e.querySelector(".sanad-filterbar__amore-label");
			return label ? label.textContent.trim() : "";
		})
	);
	check('every action in the "…" menu is named', named.length > 0 && named.every((t) => t.length > 1), named.join(" · ") || "no labels");
	await page.keyboard.press("Escape");
	await page.waitForTimeout(300);
} else {
	// a container squeezed to nothing is the shape of this going wrong, so say how wide it got
	const why = await page.evaluate(() => {
		const main = document.querySelector(".sanad-filterbar__main");
		const end = document.querySelector(".sanad-filterbar__end");
		return { main: main ? Math.round(main.getBoundingClientRect().width) : null, end: end ? Math.round(end.getBoundingClientRect().width) : null };
	});
	check('every action in the "…" menu is named', false, `no overflow down to 768px — ${JSON.stringify(why)}`);
}

// ---- the column picker holds its place while you tick ----
await page.setViewportSize({ width: 1500, height: 950 });
await page.waitForTimeout(700);
await page.click(".sanad-filterbar__dd--columns .sanad-filterbar__action");
await page.waitForTimeout(700);
await page.$eval(".sanad-filterbar__columns-list", (e) => {
	e.scrollTop = 180;
});
await page.waitForTimeout(300);
const col_before = await page.evaluate(() => {
	const list = document.querySelector(".sanad-filterbar__columns-list");
	const rows = [...list.querySelectorAll(".sanad-filterbar__column")];
	const box = list.getBoundingClientRect();
	const mid = rows.find((r) => {
		const b = r.getBoundingClientRect();
		return b.top > box.top + 40 && b.bottom < box.bottom;
	});
	return { top: Math.round(list.scrollTop), field: mid ? mid.getAttribute("data-field") : null, index: rows.indexOf(mid) };
});
if (col_before.field) {
	await page.click(`.sanad-filterbar__column[data-field="${col_before.field}"] input`);
	await page.waitForTimeout(800);
	const col_after = await page.evaluate((f) => {
		const list = document.querySelector(".sanad-filterbar__columns-list");
		const rows = [...list.querySelectorAll(".sanad-filterbar__column")];
		return {
			top: Math.round(list.scrollTop),
			index: rows.findIndex((r) => r.getAttribute("data-field") === f),
			focused: !!(document.activeElement && document.activeElement.closest(`[data-field="${f}"]`)),
		};
	}, col_before.field);
	check("ticking a column keeps the list where it was", col_after.top === col_before.top, `${col_before.top} → ${col_after.top}`);
	check("and keeps the row under the pointer", col_after.index === col_before.index, `row ${col_before.index} → ${col_after.index}`);
	check("and leaves focus on the row", col_after.focused);
	await page.click(`.sanad-filterbar__column[data-field="${col_before.field}"] input`);
	await page.waitForTimeout(800);
} else {
	check("ticking a column keeps the list where it was", false, "no scrollable column list");
}
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// ---- the phone: filters behind one button, each list in a drawer off the bottom edge ----
await page.setViewportSize({ width: 393, height: 760 });
await page.waitForTimeout(900);
// Desk keeps its sidebar expanded over the page at this width until it is told otherwise; in a real
// phone session the user closes it, and a script has to do the same before it can reach the toolbar
await page.evaluate(() => {
	document.querySelectorAll(".body-sidebar-container.expanded").forEach((e) => e.classList.remove("expanded"));
});
await page.waitForTimeout(400);
check("the phone collapses the filters behind one button", await page.$eval(".sanad-filterbar__mobile-toggle", (e) => !!e.offsetParent).catch(() => false));
await page.click(".sanad-filterbar__mobile-toggle");
await page.waitForTimeout(800);
const sheet_rows = await page.$$eval(".sanad-filter-sheet__row", (n) => n.length);
check("the sheet has one field per filter", sheet_rows > 0, `${sheet_rows} field(s)`);
await page.click(".sanad-filter-sheet__trigger >> nth=0");
await page.waitForTimeout(800);
const drawer = await page
	.$eval(".sanad-optsheet__panel", (e) => {
		const r = e.getBoundingClientRect();
		return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) };
	})
	.catch(() => null);
check(
	"tapping a filter raises a drawer off the bottom edge",
	!!drawer && Math.abs(drawer.bottom - 760) < 2 && drawer.h >= 760 * 0.4 && drawer.h <= 760 * 0.9,
	drawer ? JSON.stringify(drawer) : "no drawer"
);
const row_h = await page.$eval(".sanad-optsheet__list .sanad-filterbar__opt", (e) => Math.round(e.getBoundingClientRect().height)).catch(() => 0);
check("its rows are a thumb's size", row_h >= 44, `${row_h}px`);
const scrolls = await page.$eval(".sanad-optsheet__list", (e) => getComputedStyle(e).overflowY === "auto").catch(() => false);
check("the list scrolls inside the drawer", scrolls);
await page.click(".sanad-optsheet__list .sanad-filterbar__opt >> nth=0");
await page.waitForTimeout(1000);
const picked = await page.$eval(".sanad-filter-sheet__row:first-child .sanad-filter-sheet__chosen", (e) => e.textContent.trim()).catch(() => "");
check("choosing in the drawer sets the filter", !!picked && picked !== "All", picked);
await page.click(".sanad-optsheet__done");
await page.waitForTimeout(600);
check("Done dismisses the drawer", (await page.$$(".sanad-optsheet")).length === 0);

// the Filters sheet is still up over the toolbar; Done only dismissed the drawer
await page.keyboard.press("Escape");
await page.waitForTimeout(600);

// the date filter is one icon beside the search box, and keeps its operator and field in the panel
const phone_row = await page.evaluate(() => {
	const s = document.querySelector(".sanad-filterbar__search");
	const d = document.querySelector(".sanad-filterbar__datefilter");
	const f = document.querySelector(".sanad-filterbar__mobile-toggle");
	if (!s || !d || !f) return null;
	const sr = s.getBoundingClientRect();
	const dr = d.getBoundingClientRect();
	const fr = f.getBoundingClientRect();
	return { same_row: Math.abs(sr.top - dr.top) < 6 && Math.abs(sr.top - fr.top) < 6, date_w: Math.round(dr.width), search_h: Math.round(sr.height) };
});
check("the date filter is an icon beside the search box", !!phone_row && phone_row.same_row && phone_row.date_w <= 56, JSON.stringify(phone_row));
// the set keeps the fields it is not showing in the DOM, so target the one on screen; and the
// trigger toggles, so a panel left open by an earlier step would be closed by this click
const live_date = ".sanad-datefilter:not(.sanad-datefilter--hidden) .sanad-datefilter__value";
await page.click(live_date);
await page.waitForTimeout(800);
if (!(await page.$$(".sanad-datefilter__panel")).length) {
	await page.click(live_date);
	await page.waitForTimeout(800);
}
const head = await page.$$eval(".sanad-datefilter__chead-row", (n) => n.length);
check("its operator and field move into the panel", head === 2, `${head} row(s)`);
await page.click(".sanad-datefilter__chead-trigger >> nth=0");
await page.waitForTimeout(500);
const ops = await page.$$eval(".sanad-datefilter__chead-list .sanad-datefilter__menu-item", (n) => n.length);
check("the operator list opens in place", ops === 8, `${ops} operator(s)`);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

check("no console errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);

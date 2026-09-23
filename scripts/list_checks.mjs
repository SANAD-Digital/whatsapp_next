// Regression checks for the kit's list table (sanad.ui.DataList + FilterBar).
//
// These assert the things that broke more than once while the list was being built: the stacking
// order around sticky cells, the grouping tree, group selection, the toolbar's shape at several
// widths, and the date filter's popup placement and one-row-per-field set. Run it after touching `public/js/ui/DataList` or `public/js/ui/FilterBar`.
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

// ---- the toolbar keeps its shape and never hides its filters on a desktop ----
for (const width of [1700, 1400, 1200, 1000, 900]) {
	await page.setViewportSize({ width, height: 950 });
	await page.waitForTimeout(600);
	const shown = await page.$$eval(".sanad-filterbar__dd:not(.sanad-filterbar__dd--group):not(.sanad-filterbar__dd--columns)", (n) => n.filter((e) => e.offsetParent).length);
	const collapsed = await page.$eval(".sanad-filterbar__mobile-toggle", (e) => !!e.offsetParent).catch(() => false);
	const same_line = await page.evaluate(() => {
		const m = document.querySelector(".sanad-filterbar__main");
		const e = document.querySelector(".sanad-filterbar__end");
		return !m || !e ? true : Math.abs(m.getBoundingClientRect().top - e.getBoundingClientRect().top) < 6;
	});
	check(`${width}px: filters visible`, shown > 0 && !collapsed, `${shown} shown, collapsed=${collapsed}`);
	check(`${width}px: the action cluster holds the first line`, same_line);
}
await page.setViewportSize({ width: 1500, height: 950 });
await page.waitForTimeout(600);

// ---- grouping ----
for (const i of [1, 0, 0]) {
	await page.click(".sanad-filterbar__action--group");
	await page.waitForTimeout(400);
	const add = await page.$$(".sanad-filterbar__level--add");
	if (add[i]) await add[i].click();
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
await anchored(".sanad-datefilter__op", ".sanad-datefilter__menu", "the operator menu");
await anchored(".sanad-datefilter__fieldpick", ".sanad-datefilter__menu--fields", "the field picker");

await page.click(".sanad-datefilter__fieldpick");
await page.waitForTimeout(400);
const offered = await page.$$eval(".sanad-datefilter__menu--fields .sanad-datefilter__menu-item", (n) => n.length);
check("the field picker lists the DocType's date fields", offered >= 3, `${offered} offered`);
// an untouched single row moves to the field just ticked rather than growing a second one
await page.click(".sanad-datefilter__menu--fields .sanad-datefilter__menu-item >> nth=0");
await page.waitForTimeout(500);
check("ticking a field on an empty set moves its one row", (await page.$$eval(".sanad-datefilter", (n) => n.length)) === 1);

// apply a range, then tick another field: that one gets a row of its own
await page.click(".sanad-datefilter__value");
await page.waitForTimeout(500);
await page.click(".sanad-datefilter__preset >> nth=2");
await page.waitForTimeout(250);
await page.click(".sanad-datefilter__apply");
await page.waitForTimeout(1400);
await page.click(".sanad-datefilter__fieldpick");
await page.waitForTimeout(400);
const items = await page.$$(".sanad-datefilter__menu--fields .sanad-datefilter__menu-item");
await items[items.length - 1].click();
await page.waitForTimeout(900);
check("ticking another field adds a second row", (await page.$$eval(".sanad-datefilter", (n) => n.length)) === 2);
const applied = await page.evaluate(() => cur_list.filter_area.get().filter((f) => f[2] === "Between").length);
check("only the row that was applied filters the list", applied === 1, `${applied} range filter(s)`);

check("no console errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);

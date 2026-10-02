// UI half of scripts/live_e2e.py: drives the real screens as the E2E manager with Playwright.
// Called by the engine (which copies this file next to node_modules/playwright):
//   node live_e2e_ui.mjs <mode> '<json payload>' [en|ar]
// Modes:
//   quicksend {phone, body}          open the QuickSend dialog, type the body, press Send
//   start     {campaign, messages}   the campaign's Start confirm (the review step's own call)
//   schedule  {campaign, minutes}    the campaign's Schedule dialog; types a time in the USER's zone
//   shots     {outbound, campaign, number, extra[[name, route]]}  screenshots of Outbound / Queue / campaign / Home / Numbers (+ extra)
// Prints one JSON line last: {sent|started|scheduled|pages, errors[]}.
// Env: E2E_HOST, E2E_USER, E2E_PASS, E2E_OUT (screenshot folder), E2E_ALLOWED (digits of the allowed numbers, comma separated).

import { chromium } from "playwright";
import fs from "node:fs";

const HOST = process.env.E2E_HOST || "https://whatsapp.dev.sanad.digital";
const USER = process.env.E2E_USER;
const PASS = process.env.E2E_PASS;
const OUT = process.env.E2E_OUT || "shots";
const mode = process.argv[2];
const payload = JSON.parse(process.argv[3] || "{}");
const lang = process.argv[4] || "en";
const hostname = new URL(HOST).hostname;
// the engine's own recipient rule: one number by default, the business test passes its two
const ALLOWED = (process.env.E2E_ALLOWED || "967770788938").split(",");

for (const k of ["phone", "number"]) {
	if (payload[k] && !ALLOWED.includes(String(payload[k]).replace(/\D/g, ""))) {
		console.log(JSON.stringify({ errors: [`refused ${k} ${payload[k]}`] }));
		process.exit(2);
	}
}

const browser = await chromium.launch({
	args: [`--host-resolver-rules=MAP ${hostname} 127.0.0.1`, "--ignore-certificate-errors"],
});
const context = await browser.newContext({
	viewport: { width: 1366, height: 900 },
	ignoreHTTPSErrors: true,
	locale: lang === "ar" ? "ar-SA" : "en-US",
});
const page = await context.newPage();
let errors = [];
page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));
page.on("console", (m) => {
	if (m.type() === "error" && !/socket\.io|Failed to load resource|websocket/i.test(m.text())) errors.push(`[console] ${m.text().slice(0, 300)}`);
});
page.on("response", async (r) => {
	if (r.status() >= 400 && r.url().includes("/api/")) {
		let b = "";
		try {
			b = (await r.text()).slice(0, 300);
		} catch (e) {}
		errors.push(`[http ${r.status()}] ${r.url().replace(HOST, "")} ${b}`);
	}
});

async function login() {
	await page.goto(`${HOST}/login`, { waitUntil: "networkidle" });
	await page.fill("#login_email", USER);
	await page.fill("#login_password", PASS);
	await Promise.all([page.waitForNavigation({ waitUntil: "networkidle" }), page.click(".btn-login")]);
	await page.evaluate(async (l) => {
		if (frappe.boot.user.language !== l) {
			await frappe.xcall("frappe.client.set_value", { doctype: "User", name: frappe.session.user, fieldname: "language", value: l });
		}
	}, lang);
}

async function go(route) {
	await page.goto(`${HOST}/app/${route}`, { waitUntil: "networkidle" });
	await page.waitForTimeout(1500);
}

const primary = ".modal.show .btn-modal-primary";
const result = { errors: [] };

try {
	await login();
	if (mode === "quicksend") {
		await go("whatsapp-log");
		await page.evaluate((p) => {
			window.__e2e_sent = null;
			new sanad.ui.QuickSend({ phone: p.phone, on_sent: (r) => (window.__e2e_sent = r) });
		}, payload);
		await page.waitForSelector(".modal.show [data-fieldname=body] textarea", { timeout: 15000 });
		await page.waitForTimeout(1500); // context loads, device select fills
		result.device = await page.evaluate(() => cur_dialog && cur_dialog.get_value("device"));
		await page.fill(".modal.show [data-fieldname=body] textarea", payload.body);
		await page.screenshot({ path: `${OUT}/${lang}-quicksend-dialog.png` });
		await page.click(primary);
		await page.waitForFunction(() => window.__e2e_sent, null, { timeout: 30000 });
		result.sent = await page.evaluate(() => window.__e2e_sent);
	} else if (mode === "start") {
		await go(`whatsapp-campaign/${encodeURIComponent(payload.campaign)}`);
		await page.screenshot({ path: `${OUT}/${lang}-campaign-before-start.png` });
		await page.evaluate((p) => {
			window.__e2e_done = null;
			whatsapp_next.campaigns.start(cur_frm.doc, { messages: p.messages || 1, after: (r) => (window.__e2e_done = r || true) });
		}, payload);
		await page.waitForSelector(primary, { timeout: 15000 });
		await page.screenshot({ path: `${OUT}/${lang}-campaign-start-confirm.png` });
		await page.click(primary);
		await page.waitForFunction(() => window.__e2e_done, null, { timeout: 30000 });
		result.started = await page.evaluate(() => window.__e2e_done);
	} else if (mode === "schedule") {
		await go(`whatsapp-campaign/${encodeURIComponent(payload.campaign)}`);
		await page.evaluate(() => {
			window.__e2e_done = null;
			whatsapp_next.campaigns.schedule(cur_frm.doc, { after: (r) => (window.__e2e_done = r || true) });
		});
		await page.waitForSelector(".modal.show [data-fieldname=scheduled_at] input", { timeout: 15000 });
		// what a person in the user's zone would type: their wall clock + N minutes, in their date format
		const typed = await page.evaluate((m) => {
			const tz = frappe.boot.time_zone ? frappe.boot.time_zone.user : null;
			const local = (tz ? moment().tz(tz) : moment()).add(m, "minutes").seconds(0);
			const fmt = frappe.datetime.get_user_date_fmt().toUpperCase().replace("YYYY", "YYYY");
			return { user_tz: tz, system_tz: frappe.boot.time_zone && frappe.boot.time_zone.system, text: local.format(`${fmt} HH:mm:ss`) };
		}, payload.minutes || 3);
		result.typed = typed;
		const input = ".modal.show [data-fieldname=scheduled_at] input";
		// the user's wall-clock text goes into the field and the control parses it on `change`, as when
		// a time is picked. (Typed key by key and left with Tab, Frappe's date picker put its own
		// selected date back in headless Chromium — the dialog then held midnight, and the guard
		// below refused to schedule.)
		await page.evaluate(([sel, t]) => $(sel).val(t).trigger("change"), [input, typed.text]);
		await page.waitForTimeout(800);
		result.value = await page.evaluate(() => {
			const d = window.cur_dialog || (frappe.ui.open_dialogs || []).slice(-1)[0];
			return d ? d.get_value("scheduled_at") : null;
		});
		result.shown = await page.inputValue(input).catch(() => null);
		// what the dialog holds must be the typed wall-clock time, in system time — else nothing is scheduled
		const want = await page.evaluate((t) => {
			const fmt = frappe.datetime.get_user_date_fmt().toUpperCase();
			return frappe.datetime.convert_to_system_tz(moment(t, `${fmt} HH:mm:ss`).format("YYYY-MM-DD HH:mm:ss"));
		}, typed.text);
		result.want = want;
		await page.screenshot({ path: `${OUT}/${lang}-campaign-schedule-dialog.png` });
		if (!result.value || String(result.value).slice(0, 19) !== String(want).slice(0, 19)) {
			throw new Error(`the dialog holds ${result.value} for "${typed.text}" (expected ${want}); not scheduling`);
		}
		await page.click(primary);
		await page.waitForFunction(() => window.__e2e_done, null, { timeout: 30000 });
		result.scheduled = await page.evaluate(() => window.__e2e_done);
	} else if (mode === "shots") {
		result.pages = [];
		const shoot = async (name, route, act) => {
			const before = errors.length;
			const facts = {};
			try {
				await go(route);
				if (act) await act(facts);
			} catch (e) {
				errors.push(`[${name}] ${e.message.slice(0, 200)}`);
			}
			await page.screenshot({ path: `${OUT}/${lang}-${name}.png` });
			result.pages.push({ name, route, errors: errors.slice(before), facts });
		};
		const view = async () => {
			await page.click(".sanad-datalist__view >> nth=0", { timeout: 6000 });
			await page.waitForTimeout(1500);
		};
		await shoot("home", "wa-home", async (f) => {
			f.text = (await page.locator(".layout-main-section").innerText()).slice(0, 600).replace(/\s+/g, " ");
		});
		await shoot("outbound-list", "whatsapp-log");
		if (payload.outbound) await shoot("outbound-drawer", `whatsapp-log?name=${payload.outbound}`, view);
		await shoot("queue", "whatsapp-queue-item");
		if (payload.campaign) await shoot("campaign-monitor", `whatsapp-campaign/${encodeURIComponent(payload.campaign)}`);
		await shoot("campaigns", "whatsapp-campaign");
		await shoot("numbers-drawer", `whatsapp-number?name=${encodeURIComponent(payload.number)}`, async (f) => {
			await view();
			f.drawer = (await page.locator(".sanad-drawer, .sanad-kit .sanad-drawer__body").first().innerText().catch(() => "")).slice(0, 500).replace(/\s+/g, " ");
		});
		// any other screen the caller names: [[shot name, route], …]
		for (const [name, route] of payload.extra || []) await shoot(name, route);
	}
} catch (e) {
	result.errors.push(`[${mode}] ${e.message.slice(0, 300)}`);
	await page.screenshot({ path: `${OUT}/${lang}-${mode}-error.png` }).catch(() => {});
}
result.errors = result.errors.concat(mode === "shots" ? [] : errors);
await browser.close();
console.log(JSON.stringify(result));

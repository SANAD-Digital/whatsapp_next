// Browser smoke for the Desk screens (phase 5+): logs in as a test user, visits each route,
// optionally clicks a control, records JS/page/HTTP errors and takes a screenshot per route.
//
// Requires Playwright + Chromium outside the repo (never a dependency of the app):
//   mkdir -p ~/pw && cd ~/pw && npm init -y && npm i playwright && npx playwright install chromium
//   (Chromium needs the system libraries: `npx playwright install-deps chromium` or apt.)
// Run from that folder so `playwright` resolves:
//   SMOKE_HOST=https://whatsapp.dev.sanad.digital SMOKE_USER=kit-shot@example.com \
//   SMOKE_PASS=… node /path/to/apps/whatsapp_next/scripts/browser_smoke.mjs routes.json [en|ar] [width]
// `routes.json`: [{name, route, pre?: [selector…], click?: selector}] — routes are `/app/<route>`.
// The site name is mapped to 127.0.0.1 inside Chromium (`--host-resolver-rules`), so it works on
// the server without DNS; the local nginx certificate is ignored.

import { chromium } from "playwright";
import fs from "node:fs";

const HOST = process.env.SMOKE_HOST || "https://whatsapp.dev.sanad.digital";
const USER = process.env.SMOKE_USER || "kit-shot@example.com";
const PASS = process.env.SMOKE_PASS || "";
const hostname = new URL(HOST).hostname;
const routes = JSON.parse(fs.readFileSync(process.argv[2] || "routes.json", "utf8"));
const lang = process.argv[3] || "en";
const width = parseInt(process.argv[4] || "1280", 10);
const out_dir = process.env.SMOKE_OUT || "shots";

const browser = await chromium.launch({
	args: [`--host-resolver-rules=MAP ${hostname} 127.0.0.1`, "--ignore-certificate-errors"],
});
const context = await browser.newContext({
	viewport: { width, height: 900 },
	ignoreHTTPSErrors: true,
	locale: lang === "ar" ? "ar-SA" : "en-US",
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) =>
	errors.push(`[pageerror] ${e.message}\n      ${String(e.stack || "").split("\n").slice(1, 4).join("\n      ")}`)
);
page.on("console", (m) => {
	if (m.type() === "error" && !/socket\.io|Failed to load resource/.test(m.text())) {
		errors.push(`[console] ${m.text().slice(0, 400)}`);
	}
});
page.on("response", async (r) => {
	if (r.status() >= 400 && r.url().includes("/api/")) {
		let body = "";
		try {
			body = (await r.text()).slice(0, 700);
		} catch (e) {
			body = "<no body>";
		}
		let msg = body;
		try {
			const j = JSON.parse(body);
			msg = `${j.exception || j.exc_type || ""} ${j._server_messages || ""}`;
		} catch (e) {
			// plain body
		}
		errors.push(`[http ${r.status()}] ${r.request().method()} ${r.url().replace(HOST, "")}\n      -> ${msg.slice(0, 500)}`);
	}
});

await page.goto(`${HOST}/login`, { waitUntil: "networkidle" });
await page.fill("#login_email", USER);
await page.fill("#login_password", PASS);
await Promise.all([page.waitForNavigation({ waitUntil: "networkidle" }), page.click(".btn-login")]);
await page.evaluate(async (l) => {
	await frappe.xcall("frappe.client.set_value", { doctype: "User", name: frappe.session.user, fieldname: "language", value: l });
}, lang);

fs.mkdirSync(out_dir, { recursive: true });
let failed = 0;
for (const r of routes) {
	const before = errors.length;
	await page.goto(`${HOST}/app/${r.route}`, { waitUntil: "networkidle" });
	await page.waitForTimeout(1200);
	// surface errors the kit shows only as toasts
	await page.evaluate(() => {
		if (window.sanad && sanad.ui && sanad.ui.Toast) {
			const orig = sanad.ui.Toast.error;
			sanad.ui.Toast.error = (e, o) => {
				console.error("[toast-error] " + ((e && e.stack) || e));
				return orig(e, o);
			};
		}
	});
	for (const sel of r.pre || []) {
		try {
			await page.click(sel, { timeout: 4000 });
			await page.waitForTimeout(600);
		} catch (e) {
			errors.push(`[pre ${sel}] ${e.message.slice(0, 120)}`);
		}
	}
	if (r.click) {
		try {
			await page.click(r.click, { timeout: 4000 });
			await page.waitForTimeout(1200);
		} catch (e) {
			errors.push(`[click ${r.name}] ${e.message.slice(0, 200)}`);
		}
	}
	await page.screenshot({ path: `${out_dir}/${lang}-${width}-${r.name}.png` });
	const mine = errors.slice(before);
	if (mine.length) failed += 1;
	console.log(`${mine.length ? "ERR " : "ok  "} ${r.name}${mine.length ? "\n    " + mine.join("\n    ") : ""}`);
}
await browser.close();
process.exit(failed ? 1 : 0);

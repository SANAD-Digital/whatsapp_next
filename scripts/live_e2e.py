# Live end-to-end test engine: behaves like a real WhatsApp Manager using the system and sends
# REAL WhatsApp messages through the real device, then verifies what the system recorded.
#
#   cd ~/frappe-bench
#   env/bin/python apps/whatsapp_next/scripts/live_e2e.py --out /path/to/out            # everything
#   env/bin/python apps/whatsapp_next/scripts/live_e2e.py --out … --only quick_text template
#   env/bin/python apps/whatsapp_next/scripts/live_e2e.py --out … --dry-run             # no writes
#   env/bin/python apps/whatsapp_next/scripts/live_e2e.py --out … --only verify_inbound # after the owner's phone test
#   env/bin/python apps/whatsapp_next/scripts/live_e2e.py --out … --only cleanup
#
# How it acts:
#   * Every user action goes over HTTP to the running server (`--base`, default 127.0.0.1:8000
#     with the site's Host header) as `e2e-manager@example.com`, a cookie session with the CSRF
#     token, exactly like the Desk does. The user holds WhatsApp Manager / Agent / Contact User —
#     never System Manager — and its time zone is Asia/Aden while the site runs Asia/Kolkata, so
#     every scheduled time crosses a zone boundary.
#   * A few flows are driven through the real UI with Playwright (`live_e2e_ui.mjs`): the
#     QuickSend dialog, the campaign Start confirm and the campaign Schedule dialog, and the
#     screenshots (en + ar) with the console errors of every screen.
#   * The database is read in-process only to verify (and, once, as Administrator, to create the
#     test user and an E2E Report Builder report). Reads roll back first, so each sees fresh data.
#
# Safety rails (hard limits, all enforced in code):
#   * ONE recipient: every payload is scanned before it leaves (`guard`); any phone-like value
#     that is not +967770788938, any group JID, any User/Role recipient is refused. After every
#     scenario the DB is scanned for rows this run created to any other key; an open one is
#     cancelled at once and the run aborts.
#   * ONE device: WA-DEV-014, never touched.
#   * At most 40 real outbound messages across ALL runs (counted from the DB since the first run,
#     `state.json`), at least 8 s apart: each scenario waits for its message to be Sent before
#     the next one is triggered, and campaign messages are staggered over separate ticks.
#   * Records created are named E2E…; `cleanup` disables or deletes them. Message logs, queue
#     items and finished campaigns stay as history.
#
# Output: `<out>/run-<timestamp>.json` and `.md`, screenshots in `<out>/shots/`.

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import time
import traceback
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any

import requests

BENCH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
HERE = os.path.dirname(os.path.abspath(__file__))

RECIPIENT = "+967770788938"
RECIPIENT_DIGITS = "967770788938"
RECIPIENT_NAME = "Albashq Alshwmy"  # the Contact linked to the number
DEVICE = "WA-DEV-014"
MAX_REAL = 40
GAP_SECONDS = 8
USER = "e2e-manager@example.com"
USER_ROLES = ("WhatsApp Manager", "WhatsApp Agent", "WhatsApp Contact User")
USER_TZ = "Asia/Aden"
REPORT = "E2E ToDo List"
SEND_TIMEOUT = 780  # queued → Sent: an app tick + a platform tick, each up to 240 s on a default bench
DELIVER_TIMEOUT = 180  # Sent → Delivered
REAL = ("Sending", "Sent", "Delivered", "Read")
OPEN = ("Unsent", "Queued", "Sending", "Held")

# keys whose values are recipients, wherever they sit in a payload
PHONE_KEYS = {"phone", "phone_e164", "numbers", "jid", "to", "sender_phone", "recipient"}


class GuardError(Exception):
	"""A payload would reach someone other than the one allowed recipient."""


class BudgetError(Exception):
	"""The 40-message cap would be exceeded."""


class DryRun(Exception):
	"""Raised at the first write in --dry-run: the scenario stops there."""


class ApiError(Exception):
	def __init__(self, status: int, exc_type: str | None, message: str):
		super().__init__(f"{status} {exc_type}: {message}")
		self.status, self.exc_type, self.message = status, exc_type, message


# --------------------------------------------------------------------------- guard


def _digits(value: str) -> str:
	return "".join(ch for ch in str(value) if ch.isdigit())


def guard(obj: Any, where: str = "payload") -> None:
	"""Refuse any recipient but RECIPIENT, anywhere in `obj`."""
	if isinstance(obj, dict):
		rtype = obj.get("recipient_type")
		if rtype and rtype not in ("Phone", "Fixed Number", "Individual"):
			raise GuardError(f"{where}: recipient_type {rtype!r} could reach other people")
		for k, v in obj.items():
			if k in PHONE_KEYS and v not in (None, "", []):
				values = v if isinstance(v, list) else [v]
				for one in values:
					s = str(one)
					if "@" in s and not s.startswith(RECIPIENT_DIGITS + "@s.whatsapp.net"):
						raise GuardError(f"{where}.{k}: JID {s!r} is not the allowed recipient")
					if _digits(s) != RECIPIENT_DIGITS:
						raise GuardError(f"{where}.{k}: {s!r} is not {RECIPIENT}")
			if k in ("contacts",) and v:
				raise GuardError(f"{where}.{k}: contacts could resolve to other numbers")
			guard(v, f"{where}.{k}")
	elif isinstance(obj, list):
		for i, v in enumerate(obj):
			guard(v, f"{where}[{i}]")


# --------------------------------------------------------------------------- in-process DB


def frappe_connect(site: str):
	import frappe

	os.chdir(os.path.join(BENCH, "sites"))
	frappe.init(site=site, sites_path=".")
	frappe.connect()
	frappe.set_user("Administrator")
	return frappe


# --------------------------------------------------------------------------- HTTP client


class Client:
	"""A logged-in Desk user over HTTP: cookie session + CSRF token, JSON bodies."""

	def __init__(self, base: str, host: str, user: str, pwd: str, dry: bool, log):
		self.base, self.host, self.user, self.dry, self.log = base.rstrip("/"), host, user, dry, log
		self.s = requests.Session()
		self.s.headers.update({"Host": host, "Accept": "application/json"})
		r = self.s.post(f"{self.base}/api/method/login", data={"usr": user, "pwd": pwd}, timeout=60)
		if r.status_code != 200:
			raise RuntimeError(f"login failed {r.status_code} {r.text[:200]}")
		html = self.s.get(f"{self.base}/app", timeout=60).text
		m = re.search(r'csrf_token\s*[=:]\s*"([^"]+)"', html)
		self.csrf = m.group(1) if m else None
		if self.csrf:
			self.s.headers["X-Frappe-CSRF-Token"] = self.csrf

	@staticmethod
	def _path(method: str) -> str:
		return method if method.startswith(("frappe.", "whatsapp_next.")) else f"whatsapp_next.api.v1.{method}"

	def _unwrap(self, r: requests.Response) -> Any:
		try:
			body = r.json()
		except ValueError:
			body = {}
		if r.status_code != 200:
			msg = ""
			try:
				msgs = json.loads(body.get("_server_messages") or "[]")
				msg = "; ".join(json.loads(m).get("message", "") for m in msgs)
			except Exception:
				msg = r.text[:300]
			raise ApiError(r.status_code, body.get("exc_type"), msg or body.get("exception") or r.text[:300])
		return body.get("message", body.get("data"))

	def read(self, method: str, **data) -> Any:
		"""A GET, retried on a dropped connection (a web-worker reload). Writes are never retried:
		a POST whose answer was lost may have been executed, and a resend would be a second message."""
		for attempt in range(4):
			try:
				r = self.s.get(f"{self.base}/api/method/{self._path(method)}", params=data, timeout=60)
				return self._unwrap(r)
			except (requests.ConnectionError, requests.Timeout):
				if attempt == 3:
					raise
				time.sleep(3 * (attempt + 1))

	def write(self, method: str, **data) -> Any:
		guard(data, method)
		if self.dry:
			raise DryRun(f"would POST {method} {json.dumps(data, ensure_ascii=False, default=str)[:400]}")
		self.log(f"  → POST {method}")
		r = self.s.post(f"{self.base}/api/method/{self._path(method)}", json=data, timeout=120)
		return self._unwrap(r)

	def insert(self, doctype: str, doc: dict) -> dict:
		guard(doc, doctype)
		if self.dry:
			raise DryRun(f"would insert {doctype} {json.dumps(doc, ensure_ascii=False, default=str)[:400]}")
		self.log(f"  → insert {doctype}")
		r = self.s.post(f"{self.base}/api/resource/{doctype}", json=doc, timeout=120)
		return self._unwrap(r)

	def update(self, doctype: str, name: str, values: dict) -> dict:
		guard(values, doctype)
		if self.dry:
			raise DryRun(f"would update {doctype} {name}")
		r = self.s.put(f"{self.base}/api/resource/{doctype}/{requests.utils.quote(name, safe='')}", json=values, timeout=120)
		return self._unwrap(r)

	def delete(self, doctype: str, name: str) -> Any:
		if self.dry:
			raise DryRun(f"would delete {doctype} {name}")
		r = self.s.delete(f"{self.base}/api/resource/{doctype}/{requests.utils.quote(name, safe='')}", timeout=120)
		return self._unwrap(r)

	def upload(self, path: str, is_private: int = 1) -> dict:
		if self.dry:
			raise DryRun(f"would upload {path}")
		with open(path, "rb") as fh:
			r = self.s.post(
				f"{self.base}/api/method/upload_file",
				files={"file": (os.path.basename(path), fh)},
				data={"is_private": is_private, "folder": "Home"},
				timeout=120,
			)
		return self._unwrap(r)


# --------------------------------------------------------------------------- results


@dataclass
class Check:
	name: str
	ok: bool
	detail: str = ""


@dataclass
class Scenario:
	name: str
	status: str = "pending"  # pass | fail | partial | skipped | dry-run | error
	messages: list[dict] = field(default_factory=list)
	checks: list[Check] = field(default_factory=list)
	notes: list[str] = field(default_factory=list)
	started: str = ""
	seconds: float = 0.0

	def check(self, name: str, ok: bool, detail: str = "") -> bool:
		self.checks.append(Check(name, bool(ok), str(detail)[:600]))
		print(f"    [{'PASS' if ok else 'FAIL'}] {name} {str(detail)[:200]}")
		return bool(ok)


# --------------------------------------------------------------------------- engine


class Engine:
	def __init__(self, args):
		self.args = args
		self.out = os.path.abspath(args.out)
		os.makedirs(os.path.join(self.out, "shots"), exist_ok=True)
		self.state_path = os.path.join(self.out, "state.json")
		self.state = self._load_state()
		self.frappe = frappe_connect(args.site)
		self.run_id = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
		self.run_start = self.site_now()
		self.results: list[Scenario] = []
		self.client: Client | None = None

	# ---- state
	def _load_state(self) -> dict:
		if os.path.exists(self.state_path):
			with open(self.state_path) as fh:
				return json.load(fh)
		return {"created": {}, "messages": [], "first_run_at": None, "last_real_send": None}

	def save_state(self) -> None:
		with open(self.state_path, "w") as fh:
			json.dump(self.state, fh, ensure_ascii=False, indent=1, default=str)

	def remember(self, kind: str, name: str) -> None:
		lst = self.state["created"].setdefault(kind, [])
		if name not in lst:
			lst.append(name)
		self.save_state()

	def log(self, msg: str) -> None:
		print(msg, flush=True)

	# ---- db helpers
	def fresh(self):
		self.frappe.db.rollback()
		return self.frappe

	def site_now(self) -> dt.datetime:
		from frappe.utils import now_datetime

		return now_datetime()

	def db_log(self, name: str) -> dict:
		f = self.fresh()
		return f.db.get_value(
			"WhatsApp Log",
			name,
			[
				"name", "status", "phone_e164", "jid", "display_name", "message_type", "body", "caption",
				"creation", "scheduled_at", "queued_at", "sent_at", "delivered_at", "read_at", "failed_at",
				"cancelled_at", "error_code", "error_message", "queue_item", "provider_message_id", "attempts",
				"source_type", "campaign", "notification", "notification_alert", "device", "owner", "is_test",
			],
			as_dict=True,
		) or {}

	# ---- budget / pacing
	def used_budget(self) -> tuple[int, int]:
		"""(real, open) outbound rows to RECIPIENT since the first run of this engine."""
		since = self.state.get("first_run_at") or str(self.run_start)
		f = self.fresh()
		rows = f.get_all(
			"WhatsApp Log",
			filters={"phone_e164": RECIPIENT, "creation": (">=", since)},
			fields=["status", "provider_message_id"],
		)
		real = sum(1 for r in rows if r.status in REAL or (r.status == "Failed" and r.provider_message_id))
		pending = sum(1 for r in rows if r.status in OPEN and r.status != "Sending")
		return real, pending

	def reserve(self, n: int) -> None:
		real, pending = self.used_budget()
		if real + pending + n > MAX_REAL:
			raise BudgetError(f"cap: {real} sent + {pending} pending + {n} new > {MAX_REAL}")
		if not self.state.get("first_run_at") and not self.args.dry_run:
			self.state["first_run_at"] = str(self.run_start)
			self.save_state()

	def pace(self) -> None:
		"""Wait until nothing of ours is still on its way and the last real send is ≥ GAP ago."""
		deadline = time.time() + SEND_TIMEOUT
		while time.time() < deadline:
			f = self.fresh()
			busy = f.get_all(
				"WhatsApp Log",
				# this run's rows only: one stuck on the platform from an earlier run must not block
				filters={"phone_e164": RECIPIENT, "creation": (">=", self.run_start), "status": ("in", ["Queued", "Sending", "Unsent"])},
				fields=["name", "scheduled_at"],
			)
			busy = [b for b in busy if not b.scheduled_at or b.scheduled_at <= self.site_now() + dt.timedelta(seconds=90)]
			if not busy:
				break
			time.sleep(5)
		else:
			raise BudgetError(f"pacing: {[b.name for b in busy]} still on their way after {SEND_TIMEOUT} s; not sending more")
		last = f.db.sql(
			"select max(sent_at) from `tabWhatsApp Log` where phone_e164=%s and sent_at is not null", RECIPIENT
		)[0][0]
		if last:
			gap = (self.site_now() - last).total_seconds()
			if gap < GAP_SECONDS:
				time.sleep(GAP_SECONDS - gap)

	# ---- foreign recipient scan
	def scan_foreign(self, sc: Scenario) -> None:
		f = self.fresh()
		mine = self.state["created"]
		cond = {"creation": (">=", self.run_start)}
		rows = f.get_all(
			"WhatsApp Log",
			filters=cond,
			fields=["name", "phone_e164", "jid", "status", "owner", "campaign", "notification", "notification_alert"],
		)
		bad = [
			r
			for r in rows
			if (r.phone_e164 or r.jid) != RECIPIENT
			and (
				r.owner == USER
				or r.campaign in mine.get("campaigns", [])
				or r.notification in mine.get("notifications", [])
				or r.notification_alert in mine.get("alerts", [])
			)
		]
		for r in bad:
			if r.status in OPEN and self.client:
				try:
					self.client.write("messages.cancel", name=r.name, reason="E2E guard: foreign recipient")
				except Exception as exc:
					sc.notes.append(f"guard cancel of {r.name} failed: {exc}")
		if bad:
			sc.check("no message to any other recipient", False, str([(r.name, r.phone_e164, r.status) for r in bad]))
			raise GuardError(f"rows to other recipients: {[r.name for r in bad]}")

	# ---- waiting and verifying one message
	def wait_status(self, name: str, want: tuple[str, ...], timeout: int) -> dict:
		deadline = time.time() + timeout
		row = self.db_log(name)
		while time.time() < deadline:
			row = self.db_log(name)
			if row.get("status") in want or row.get("status") in ("Failed", "Cancelled"):
				return row
			time.sleep(4)
		return row

	def verify_message(self, sc: Scenario, name: str, label: str, *, queue: bool = True, expect: str = "Delivered") -> dict:
		"""Wait for Sent then Delivered/Read; check timestamps, queue item, recipient."""
		t0 = time.time()
		row = self.wait_status(name, ("Sent", "Delivered", "Read"), SEND_TIMEOUT)
		t_sent = round(time.time() - t0, 1)
		if row.get("status") in ("Sent",) and expect in ("Delivered", "Read"):
			row = self.wait_status(name, ("Delivered", "Read"), DELIVER_TIMEOUT)
		t_final = round(time.time() - t0, 1)
		info = {
			"label": label,
			"name": name,
			"status": row.get("status"),
			"message_type": row.get("message_type"),
			"phone_e164": row.get("phone_e164"),
			"display_name": row.get("display_name"),
			"provider_message_id": row.get("provider_message_id"),
			"creation": str(row.get("creation")),
			"queued_at": str(row.get("queued_at")),
			"sent_at": str(row.get("sent_at")),
			"delivered_at": str(row.get("delivered_at")),
			"read_at": str(row.get("read_at")),
			"error": row.get("error_code") and f"{row.get('error_code')}: {row.get('error_message')}",
			"seconds_to_sent": t_sent,
			"seconds_total": t_final,
		}
		sc.messages.append(info)
		st = row.get("status")
		sc.check(f"{label}: recipient is {RECIPIENT}", row.get("phone_e164") == RECIPIENT, row.get("phone_e164"))
		sc.check(f"{label}: reached Sent", st in ("Sent", "Delivered", "Read"), f"{st} {info['error'] or ''}")
		if expect in ("Delivered", "Read"):
			sc.check(f"{label}: reached Delivered/Read", st in ("Delivered", "Read"), st)
		c = row.get("creation")
		for f_ in ("sent_at", "delivered_at", "read_at"):
			v = row.get(f_)
			if v and c:
				sc.check(f"{label}: {f_} not before creation", v >= c - dt.timedelta(seconds=1), f"{f_}={v} creation={c}")
				sc.check(f"{label}: {f_} not in the future", v <= self.site_now() + dt.timedelta(seconds=60), f"{f_}={v}")
		if row.get("sent_at") and row.get("delivered_at"):
			sc.check(f"{label}: delivered_at ≥ sent_at", row["delivered_at"] >= row["sent_at"] - dt.timedelta(seconds=2), "")
		if queue:
			qi = row.get("queue_item")
			q = self.fresh().db.get_value("WhatsApp Queue Item", qi, ["status", "attempts", "completed_at", "dead_letter_reason"], as_dict=True) if qi else None
			ok = bool(q) and q.status == "Completed"
			sc.check(f"{label}: queue item Completed", ok, f"{qi} {q and q.status} {q and q.dead_letter_reason or ''}")
			if q and q.completed_at and c:
				sc.check(f"{label}: queue completed_at not before creation", q.completed_at >= c - dt.timedelta(seconds=1), str(q.completed_at))
		if st in ("Sent", "Delivered", "Read"):
			self.state["last_real_send"] = str(row.get("sent_at"))
		if name not in self.state["messages"]:
			self.state["messages"].append(name)
		self.save_state()
		return row

	# ---- UI driver
	def ui(self, mode: str, payload: dict, lang: str = "en") -> dict:
		guard(payload, f"ui:{mode}")
		if self.args.dry_run and mode != "shots":
			raise DryRun(f"would drive UI {mode} {payload}")
		pw = self.args.pw_dir
		if not pw or not os.path.isdir(os.path.join(pw, "node_modules", "playwright")):
			raise RuntimeError("--pw-dir must hold node_modules/playwright")
		script = os.path.join(pw, "live_e2e_ui.mjs")
		shutil.copyfile(os.path.join(HERE, "live_e2e_ui.mjs"), script)
		env = dict(
			os.environ,
			E2E_HOST=f"https://{self.args.site}",
			E2E_USER=USER,
			E2E_PASS=self.state["password"],
			E2E_OUT=os.path.join(self.out, "shots"),
		)
		p = subprocess.run(
			["node", script, mode, json.dumps(payload, ensure_ascii=False), lang],
			cwd=pw, env=env, capture_output=True, text=True, timeout=600,
		)
		out = p.stdout.strip().splitlines()
		last = next((line for line in reversed(out) if line.startswith("{")), "{}")
		try:
			res = json.loads(last)
		except ValueError:
			res = {}
		res.setdefault("exit", p.returncode)
		if p.returncode and not res.get("errors"):
			res["errors"] = [p.stderr[-800:]]
		return res

	# ---- setup
	def setup(self) -> None:
		f = self.frappe
		pwd = self.state.get("password") or ("E2e-" + uuid.uuid4().hex[:16] + "!9")
		if not self.args.dry_run:
			if f.db.exists("User", USER):
				user = f.get_doc("User", USER)
			else:
				user = f.get_doc({"doctype": "User", "email": USER, "first_name": "E2E", "last_name": "Manager", "send_welcome_email": 0})
				user.insert(ignore_permissions=True)
			user.enabled = 1
			user.user_type = "System User"
			have = {r.role for r in user.roles}
			for role in USER_ROLES:
				if role not in have:
					user.append("roles", {"role": role})
			user.set("roles", [r for r in user.roles if r.role in USER_ROLES])
			user.time_zone = USER_TZ
			user.language = "en"
			user.new_password = pwd
			user.flags.ignore_password_policy = True
			user.save(ignore_permissions=True)
			self._ensure_report()
			f.db.commit()
			self.state["password"] = pwd
			self.save_state()
		elif not f.db.exists("User", USER):
			raise RuntimeError("dry-run needs the E2E user from a previous real run")
		self.client = Client(self.args.base, self.args.site, USER, self.state["password"], self.args.dry_run, self.log)

	def _ensure_report(self) -> None:
		"""A Report Builder report on ToDo (the alert scenario), readable by WhatsApp Manager."""
		f = self.frappe
		spec = {
			"columns": [["name", "ToDo"], ["description", "ToDo"], ["status", "ToDo"], ["date", "ToDo"]],
			"filters": [["ToDo", "description", "like", "E2E%"], ["ToDo", "status", "=", "Open"]],
			"order_by": "creation desc",
		}
		if f.db.exists("Report", REPORT):
			return
		doc = f.get_doc(
			{
				"doctype": "Report",
				"report_name": REPORT,
				"ref_doctype": "ToDo",
				"report_type": "Report Builder",
				"is_standard": "No",
				"module": "Desk",
				"json": json.dumps(spec),
				"roles": [{"role": "WhatsApp Manager"}],
			}
		)
		doc.insert(ignore_permissions=True)
		self.remember("reports", REPORT)

	# ---- files
	def media(self) -> dict[str, str]:
		d = os.path.join(self.out, "media")
		os.makedirs(d, exist_ok=True)
		png = os.path.join(d, "e2e-image.png")
		pdf = os.path.join(d, "e2e-document.pdf")
		if not os.path.exists(png):
			from PIL import Image, ImageDraw

			img = Image.new("RGB", (640, 360), (18, 140, 126))
			draw = ImageDraw.Draw(img)
			draw.rectangle([20, 20, 620, 340], outline=(255, 255, 255), width=6)
			draw.text((60, 160), f"whatsapp_next E2E {dt.date.today()}", fill=(255, 255, 255))
			img.save(png)
		if not os.path.exists(pdf):
			from PIL import Image, ImageDraw

			page = Image.new("RGB", (595, 842), (255, 255, 255))
			ImageDraw.Draw(page).text((60, 80), "whatsapp_next live E2E - test document", fill=(0, 0, 0))
			page.save(pdf, "PDF")
		return {"png": png, "pdf": pdf}

	# ---- running
	def run(self, names: list[str]) -> None:
		self.setup()
		for name in names:
			fn = getattr(self, f"sc_{name}", None)
			if not fn:
				print(f"unknown scenario {name}")
				continue
			sc = Scenario(name=name, started=str(self.site_now()))
			self.results.append(sc)
			print(f"== {name}", flush=True)
			t0 = time.time()
			try:
				fn(sc)
				if sc.status == "pending":
					sc.status = "pass" if all(c.ok for c in sc.checks) else "fail"
			except DryRun as exc:
				sc.status = "dry-run"
				sc.notes.append(str(exc))
				print(f"    [DRY] {exc}")
			except (GuardError, BudgetError) as exc:
				sc.status = "error"
				sc.notes.append(f"{type(exc).__name__}: {exc}")
				print(f"    [STOP] {exc}")
				sc.seconds = round(time.time() - t0, 1)
				self.write_report()
				break
			except Exception as exc:
				sc.status = "error"
				sc.notes.append(f"{type(exc).__name__}: {exc}")
				sc.notes.append(traceback.format_exc()[-1500:])
				print(f"    [ERROR] {exc}")
			sc.seconds = round(time.time() - t0, 1)
			stop = False
			if not self.args.dry_run and name not in ("verify_inbound",):
				try:
					self.scan_foreign(sc)
				except GuardError as exc:
					sc.status = "error"
					print(f"    [STOP] {exc}")
					stop = True
			self.write_report()
			if stop:
				break
		self.write_report()

	# ====================================================================== scenarios

	def _quick(self, sc: Scenario, label: str, **payload) -> dict:
		self.reserve(1)
		self.pace()
		payload.setdefault("device", DEVICE)
		payload.setdefault("phone", RECIPIENT)
		r = self.client.write("quick_send.send", **payload)
		sc.notes.append(f"{label}: {r}")
		self.verify_message(sc, r["outbound"], label)
		return r

	def sc_preflight(self, sc: Scenario) -> None:
		"""Read-only: device, scheduler, queue state, budget, context as the user sees it."""
		f = self.fresh()
		dev = f.db.get_value("WhatsApp Device", DEVICE, ["status", "disabled", "is_default", "phone_e164"], as_dict=True)
		sc.check("device WA-DEV-014 Connected", dev and dev.status == "Connected" and not dev.disabled, dev)
		from frappe.utils.scheduler import is_scheduler_disabled

		sc.check("site scheduler enabled", not is_scheduler_disabled(verbose=False))
		sc.check("queue not paused globally", not f.db.get_single_value("WhatsApp Settings", "queue_paused"))
		ctx = self.client.read("quick_send.get_context", phone=RECIPIENT)
		rec = ctx.get("recipient") or {}
		sc.check("recipient resolves, not blacklisted", rec.get("phone_e164") == RECIPIENT and not rec.get("blacklisted"), rec)
		sc.check("default device offered", ctx.get("default_device") == DEVICE, ctx.get("default_device"))
		real, pending = self.used_budget()
		sc.notes.append(f"budget: {real} real + {pending} pending of {MAX_REAL}; site tz {f.db.get_single_value('System Settings', 'time_zone')}, user tz {USER_TZ}")
		self.state["baseline_number"] = self.number_row()
		self.save_state()

	def sc_smoke(self, sc: Scenario) -> None:
		"""One plain Arabic + English text over the HTTP API (the first sign of life)."""
		self._quick(sc, "smoke", body=f"E2E {self.run_id} · مرحباً، هذه رسالة اختبار — hello, this is a live test message")

	def sc_verify_existing(self, sc: Scenario) -> None:
		"""Re-verify messages of an interrupted run (`--names <WhatsApp Log> …`)."""
		for n in self.args.names or []:
			row = self.db_log(n)
			if row.get("phone_e164") != RECIPIENT:
				raise GuardError(f"{n} is not a message to {RECIPIENT}")
			self.verify_message(sc, n, f"existing-{n}")

	def sc_quick_text_ui(self, sc: Scenario) -> None:
		"""Plain text through the real QuickSend dialog in the browser."""
		self.reserve(1)
		self.pace()
		body = f"E2E {self.run_id} · quick send (UI dialog) · plain text"
		res = self.ui("quicksend", {"phone": RECIPIENT, "body": body})
		sc.notes.append(f"ui: {res}")
		sc.check("dialog sent without JS errors", res.get("sent") and not res.get("errors"), res.get("errors"))
		if not res.get("sent"):
			return
		out = res["sent"]["outbound"]
		row = self.db_log(out)
		sc.check("body stored as typed", row.get("body") == body, row.get("body"))
		sc.check("source Quick Send by the E2E user", row.get("source_type") == "Quick Send" and row.get("owner") == USER, (row.get("source_type"), row.get("owner")))
		self.verify_message(sc, out, "ui-text")

	def sc_quick_formatted(self, sc: Scenario) -> None:
		body = (
			f"E2E {self.run_id} · تنسيق واتساب\n"
			"*عريض bold* _مائل italic_ ~مشطوب strike~ ```mono code```\n"
			"مرحباً 👋🎉 — نص عربي مع رموز تعبيرية ✅"
		)
		r = self._quick(sc, "formatted", body=body)
		sc.check("formatted body stored byte for byte", self.db_log(r["outbound"]).get("body") == body)

	def sc_quick_image(self, sc: Scenario) -> None:
		m = self.media()
		fdoc = self.client.upload(m["png"])
		self.remember("files", fdoc["name"])
		cap = f"E2E {self.run_id} · صورة مع تعليق 📷"
		r = self._quick(sc, "image", message_type="Image", attachment=fdoc["file_url"], caption=cap)
		row = self.db_log(r["outbound"])
		sc.check("image caption stored", (row.get("caption") or row.get("body")) == cap, (row.get("caption"), row.get("body")))

	def sc_quick_pdf(self, sc: Scenario) -> None:
		m = self.media()
		fdoc = self.client.upload(m["pdf"])
		self.remember("files", fdoc["name"])
		r = self._quick(sc, "pdf", message_type="Document", attachment=fdoc["file_url"], caption=f"E2E {self.run_id} · مستند PDF")
		row = self.fresh().db.get_value("WhatsApp Log", r["outbound"], ["file_name", "mime_type"], as_dict=True)
		sc.check("document keeps a file name and PDF mime", row and row.mime_type == "application/pdf" and row.file_name, row)

	def _todo(self, desc: str) -> str:
		d = self.client.insert("ToDo", {"description": desc, "allocated_to": USER})
		self.remember("todos", d["name"])
		return d["name"]

	def sc_template(self, sc: Scenario) -> None:
		tname = "E2E Template"
		body = (
			"مرحباً {{ recipient.display_name }} 👋\n"
			"E2E قالب: المهمة *{{ doc.description }}* ({{ doc.name }})\n"
			"_الحالة_: {{ doc.status }} — {{ today }}"
		)
		f = self.fresh()
		if not f.db.exists("WhatsApp Template", tname):
			self.client.insert(
				"WhatsApp Template",
				{"template_name": tname, "message_type": "Text", "category": "E2E", "reference_doctype": "ToDo", "body": body},
			)
			self.remember("templates", tname)
		todo = self._todo(f"E2E template reference {self.run_id}")
		vars_ = self.client.read("templates.list_variables", reference_doctype="ToDo")
		sc.check("variables list offers doc.description", any(v.get("name") == "doc.description" for v in vars_), len(vars_))
		p = self.client.write("templates.preview", template=tname, reference_doctype="ToDo", reference_name=todo)
		sc.check("template preview renders without errors", not p.get("errors") and f"E2E template reference {self.run_id}" in p.get("body", ""), p)
		p2 = self.client.read("quick_send.preview", template=tname, reference_doctype="ToDo", reference_name=todo)
		sc.check("composer preview renders the same body", p2.get("body") and not p2.get("errors"), p2)
		r = self._quick(sc, "template", template=tname, reference_doctype="ToDo", reference_name=todo)
		row = self.db_log(r["outbound"])
		sc.check("sent body has the recipient's name", RECIPIENT_NAME in (row.get("body") or ""), row.get("body"))
		sc.check("sent body has the ToDo's text", f"E2E template reference {self.run_id}" in (row.get("body") or ""), "")
		sc.check("no Jinja left in the sent body", "{{" not in (row.get("body") or ""), "")

	def sc_simulator(self, sc: Scenario) -> None:
		"""The simulator's real test send (bypasses the queue, like the screen's 'Send test')."""
		self.reserve(1)
		self.pace()
		r = self.client.write("simulator.send_test", device=DEVICE, phone=RECIPIENT, kind="text", body=f"E2E {self.run_id} · simulator test send")
		row = self.verify_message(sc, r["outbound"], "simulator", queue=False)
		sc.check("row is a test from the Simulator", row.get("is_test") == 1 and row.get("source_type") == "Simulator", (row.get("is_test"), row.get("source_type")))

	def sc_bulk(self, sc: Scenario) -> None:
		gname = "E2E Bulk Group"
		f = self.fresh()
		if not f.db.exists("WhatsApp Contact Group", gname):
			ed = self.client.read("groups.get_editor")
			sc.notes.append(f"editor keys: {list((ed or {}).keys())[:10]}")
			row = {"phone": RECIPIENT, "phone_e164": RECIPIENT, "display_name": RECIPIENT_NAME, "source_type": "Manual"}
			res = self.client.write("groups.save_editor", payload={"group_name": gname, "kind": "Other", "description": "E2E live test — one member", "add": [row]})
			self.remember("groups", res["name"])
			gname = res["name"]
		members = self.fresh().get_all("WhatsApp Contact Group Member", filters={"parent": gname}, pluck="phone_e164")
		if not sc.check("group holds only the allowed number", members == [RECIPIENT], members):
			return
		est = self.client.read("bulk_send.estimate", groups=json.dumps([gname]))
		sc.check("estimate is exactly one recipient", est.get("total") == 1, est)
		self.reserve(1)
		self.pace()
		r = self.client.write("bulk_send.send", payload={"groups": [gname], "kind": "text", "device": DEVICE, "body": f"E2E {self.run_id} · bulk send to one-member group"})
		sc.notes.append(f"bulk: {r}")
		sc.check("bulk created a campaign with 1 recipient", r.get("recipients") == 1, r)
		camp = r["campaign"]
		self.remember("bulk_campaigns", camp)
		out = self.wait_campaign_outbound(camp, 1)
		if out:
			self.verify_message(sc, out[0], "bulk")
		self.check_campaign_end(sc, camp, expect_total=1)

	def wait_campaign_outbound(self, camp: str, n: int, timeout: int = 420) -> list[str]:
		deadline = time.time() + timeout
		names: list[str] = []
		while time.time() < deadline:
			names = self.fresh().get_all("WhatsApp Log", filters={"campaign": camp}, pluck="name", order_by="campaign_message_idx asc")
			if len(names) >= n:
				return names
			time.sleep(3)
		return names

	def check_campaign_end(self, sc: Scenario, camp: str, expect_total: int, timeout: int = 420) -> dict:
		deadline = time.time() + timeout
		prog = {}
		while time.time() < deadline:
			prog = self.client.read("campaigns.get_progress", name=camp)
			if prog.get("status") in ("Completed", "Partially Failed", "Cancelled"):
				break
			time.sleep(5)
		c = prog.get("counters") or {}
		sc.check(f"{camp}: ended Completed", prog.get("status") == "Completed", prog.get("status"))
		sc.check(f"{camp}: counters total={expect_total}, open=0, failed=0", c.get("total") == expect_total and c.get("open") == 0 and not c.get("failed"), c)
		f = self.fresh()
		doc = f.db.get_value("WhatsApp Campaign", camp, ["sent_count", "delivered_count", "read_count", "failed_count", "queued_count", "started_at", "ended_at", "first_message_at", "last_message_at", "creation"], as_dict=True)
		db_sent = f.db.count("WhatsApp Log", {"campaign": camp, "status": ("in", ["Sent", "Delivered", "Read"])})
		sc.check(f"{camp}: stored sent_count matches its rows", doc and doc.sent_count + (doc.delivered_count or 0) * 0 >= 0 and (doc.sent_count == db_sent or (doc.sent_count or 0) + (doc.delivered_count or 0) + (doc.read_count or 0) == db_sent), f"doc={dict(doc or {})} rows sent+={db_sent}")
		if doc and doc.started_at and doc.ended_at:
			sc.check(f"{camp}: ended_at ≥ started_at ≥ creation", doc.ended_at >= doc.started_at >= doc.creation - dt.timedelta(seconds=1), f"{doc.creation} {doc.started_at} {doc.ended_at}")
		recips = f.get_all("WhatsApp Campaign Recipient", filters={"parent": camp}, fields=["status", "phone_e164"])
		sc.check(f"{camp}: recipient row final", all(r.status in ("Sent", "Delivered", "Read") for r in recips) and len(recips) == 1, recips)
		sc.notes.append(f"{camp} progress: {json.dumps({k: prog.get(k) for k in ('status', 'counters', 'rates', 'started_at', 'ended_at', 'first_message_at', 'last_message_at')}, default=str)}")
		return prog

	def _campaign(self, name: str, messages: list[dict]) -> str:
		f = self.fresh()
		existing = f.get_all("WhatsApp Campaign", filters={"campaign_name": name, "status": "Draft"}, pluck="name")
		if existing:
			return existing[0]
		doc = self.client.insert(
			"WhatsApp Campaign",
			{"campaign_name": name, "device": DEVICE, "messages_per_minute": 6, "description": "E2E live test — one recipient", "messages": messages},
		)
		self.remember("campaigns", doc["name"])
		row = {"phone": RECIPIENT, "phone_e164": RECIPIENT, "display_name": RECIPIENT_NAME, "source_type": "Manual", "valid": True}
		prev = self.client.write("picker.preview", target_doctype="WhatsApp Campaign", target_name=doc["name"], rows=[row])
		if len(prev.get("available") or []) != 1:
			raise RuntimeError(f"picker preview did not offer the number: {prev}")
		self.client.write("picker.commit_add", target_doctype="WhatsApp Campaign", target_name=doc["name"], rows=[row], source_type="Manual")
		recips = self.fresh().get_all("WhatsApp Campaign Recipient", filters={"parent": doc["name"]}, pluck="phone_e164")
		if recips != [RECIPIENT]:
			raise GuardError(f"campaign {doc['name']} recipients {recips}")
		return doc["name"]

	def sc_campaign(self, sc: Scenario) -> None:
		"""Text + poll to one recipient; readiness → Start (UI confirm) → pause → resume → end."""
		camp = self._campaign(
			f"E2E Campaign A {self.run_id}",
			[
				{"message_type": "Text", "body": "E2E حملة: مرحباً {{ recipient.display_name }} — رسالة 1 من 2 🚀", "delay_seconds": 150},
				{"message_type": "Poll", "poll_question": "E2E حملة: رسالة 2 من 2 — هل وصلتك الرسالة الأولى؟", "poll_options": json.dumps(["نعم ✅", "لا ❌"]), "delay_seconds": 300},
			],
		)
		rd = self.client.read("campaigns.get_readiness", name=camp)
		sc.check("readiness ok (all five checks)", rd.get("ok"), rd.get("checks"))
		if not rd.get("ok"):
			return
		self.reserve(2)
		self.pace()
		res = self.ui("start", {"campaign": camp, "messages": 2})
		sc.notes.append(f"ui start: {res}")
		sc.check("started from the UI confirm without JS errors", res.get("started") and not res.get("errors"), res.get("errors"))
		if not res.get("started"):
			self.client.write("campaigns.start", name=camp)
			sc.notes.append("fell back to campaigns.start over HTTP")
		outs = self.wait_campaign_outbound(camp, 2, timeout=120)
		sc.check("materialized 2 outbound rows", len(outs) == 2, outs)
		time.sleep(3)
		st = self.client.read("campaigns.get_progress", name=camp).get("status")
		sc.check("campaign Running after materialize", st == "Running", st)
		n = self.client.write("campaigns.pause", name=camp, reason="E2E pause check")
		items = self.fresh().get_all("WhatsApp Queue Item", filters={"campaign": camp}, fields=["status", "scheduled_at"])
		sc.check("pause → both queue items Paused", n == 2 or all(i.status == "Paused" for i in items), (n, items))
		sc.check("campaign Paused", self.fresh().db.get_value("WhatsApp Campaign", camp, "status") == "Paused")
		dash = self.client.read("home.get_dashboard")
		sc.check("Home lists the paused campaign", any(c.get("name") == camp and c.get("status") == "Paused" for c in dash.get("campaigns_sending") or []), [c.get("name") for c in dash.get("campaigns_sending") or []])
		time.sleep(10)
		self.client.write("campaigns.resume", name=camp)
		items = self.fresh().get_all("WhatsApp Queue Item", filters={"campaign": camp}, fields=["status", "scheduled_at"])
		sc.check("resume → queue items Queued again", all(i.status == "Queued" for i in items), items)
		logs = self.fresh().get_all("WhatsApp Log", filters={"campaign": camp}, fields=["name", "scheduled_at", "campaign_message_idx"], order_by="campaign_message_idx asc")
		if len(logs) == 2:
			gap = (logs[1].scheduled_at - logs[0].scheduled_at).total_seconds()
			sc.check("second message staggered ≥ 240 s after the first (a separate tick)", gap >= 240, gap)
		for o, lbl in zip(outs, ("campaign-text", "campaign-poll")):
			self.verify_message(sc, o, lbl)
		rows = self.fresh().get_all("WhatsApp Log", filters={"campaign": camp}, fields=["sent_at"], order_by="sent_at asc")
		if len(rows) == 2 and rows[0].sent_at and rows[1].sent_at:
			sc.check("campaign messages ≥ 8 s apart", (rows[1].sent_at - rows[0].sent_at).total_seconds() >= GAP_SECONDS, rows)
		self.check_campaign_end(sc, camp, expect_total=2)
		body = self.db_log(outs[0]).get("body") or ""
		sc.check("campaign text rendered the recipient's name", RECIPIENT_NAME in body, body)

	def sc_campaign_scheduled(self, sc: Scenario) -> None:
		"""Scheduled from the UI by a user in Asia/Aden while the site runs Asia/Kolkata."""
		camp = self._campaign(
			f"E2E Campaign B {self.run_id}",
			[{"message_type": "Text", "body": "E2E حملة مجدولة: هذه الرسالة أُرسلت في موعدها ⏰", "delay_seconds": 0}],
		)
		self.reserve(1)
		self.pace()
		minutes = 3
		res = self.ui("schedule", {"campaign": camp, "minutes": minutes})
		sc.notes.append(f"ui schedule: {res}")
		sc.check("scheduled from the UI dialog without JS errors", res.get("scheduled") and not res.get("errors"), res.get("errors"))
		f = self.fresh()
		doc = f.db.get_value("WhatsApp Campaign", camp, ["status", "scheduled_at"], as_dict=True)
		expected = self.site_now() + dt.timedelta(minutes=minutes)
		sc.check("status Scheduled", doc.status == "Scheduled", doc.status)
		if not doc.scheduled_at:
			return
		drift = abs((doc.scheduled_at - expected).total_seconds())
		sc.check("scheduled_at stored in site time (user typed Aden time)", drift <= 120, f"stored {doc.scheduled_at}, expected ≈{expected}, user typed {res.get('typed')}")
		sched = doc.scheduled_at
		# wait for promote_scheduled
		deadline = time.time() + (sched - self.site_now()).total_seconds() + 400
		started = None
		while time.time() < deadline:
			started = self.fresh().db.get_value("WhatsApp Campaign", camp, "started_at")
			if started:
				break
			time.sleep(5)
		sc.check("started by the scheduler", bool(started), started)
		if started:
			lag = (started - sched).total_seconds()
			sc.check("not started before its time", lag >= -1, f"scheduled {sched} started {started}")
			sc.check("started within 90 s of its time (the job is `* * * * *`)", lag <= 90, f"scheduled {sched} started {started} lag {lag:.0f}s — the bench scheduler ticks every 240 s unless scheduler_tick_interval is set")
		outs = self.wait_campaign_outbound(camp, 1)
		if outs:
			row = self.verify_message(sc, outs[0], "scheduled")
			if row.get("sent_at"):
				sc.check("sent not before its scheduled time", row["sent_at"] >= sched - dt.timedelta(seconds=1), f"sent {row['sent_at']} scheduled {sched}")
		self.check_campaign_end(sc, camp, expect_total=1)

	def sc_queue_ops(self, sc: Scenario) -> None:
		"""Two scheduled quick sends: pause → resume one (it goes out), cancel the other."""
		self.reserve(1)
		self.pace()
		at = (self.site_now() + dt.timedelta(minutes=3)).strftime("%Y-%m-%d %H:%M:%S")
		keep = self.client.write("quick_send.send", device=DEVICE, phone=RECIPIENT, body=f"E2E {self.run_id} · queue: paused then resumed", scheduled_at=at)
		drop = self.client.write("quick_send.send", device=DEVICE, phone=RECIPIENT, body=f"E2E {self.run_id} · queue: CANCELLED — must never arrive", scheduled_at=at)
		sc.notes.append(f"keep {keep} drop {drop} at {at}")
		n = self.client.write("queue.pause_items", names=[keep["queue_item"]], reason="E2E pause")
		q = self.fresh().db.get_value("WhatsApp Queue Item", keep["queue_item"], ["status", "paused_by", "pause_reason"], as_dict=True)
		sc.check("pause_items → Paused by the user", n.get("count") == 1 and q.status == "Paused" and q.paused_by == USER, q)
		summ = self.client.read("queue.get_summary")
		sc.check("queue summary counts the paused item", (summ.get("paused") or 0) >= 1, summ)
		n = self.client.write("queue.resume_items", names=[keep["queue_item"]])
		q = self.fresh().db.get_value("WhatsApp Queue Item", keep["queue_item"], ["status", "paused_by"], as_dict=True)
		sc.check("resume_items → Queued, pause cleared", n.get("count") == 1 and q.status == "Queued" and not q.paused_by, q)
		c = self.client.write("messages.cancel", name=drop["outbound"], reason="E2E cancel check")
		d = self.db_log(drop["outbound"])
		qd = self.fresh().db.get_value("WhatsApp Queue Item", drop["queue_item"], ["status", "deleted_by"], as_dict=True)
		sc.check("cancel → outbound Cancelled, queue item Deleted", c.get("status") == "Cancelled" and d.get("status") == "Cancelled" and qd.status == "Deleted", (c, d.get("status"), qd))
		sc.check("cancelled_at not before creation", d.get("cancelled_at") and d["cancelled_at"] >= d["creation"] - dt.timedelta(seconds=1), (d.get("cancelled_at"), d.get("creation")))
		row = self.verify_message(sc, keep["outbound"], "queue-resumed")
		if row.get("sent_at"):
			sc.check("resumed message waited for its scheduled time", row["sent_at"] >= row["scheduled_at"] - dt.timedelta(seconds=1), f"sent {row['sent_at']} scheduled {row['scheduled_at']}")
		time.sleep(5)
		sc.check("cancelled message never sent", self.db_log(drop["outbound"]).get("status") == "Cancelled" and not self.db_log(drop["outbound"]).get("provider_message_id"))

	def sc_notification(self, sc: Scenario) -> None:
		nname = "E2E ToDo New"
		payload = {
			"notification_name": nname,
			"enabled": 1,
			"document_type": "ToDo",
			"event": "New",
			"condition_type": "Python",
			"condition": "doc.description and doc.description.startswith('E2E notify')",
			"device": DEVICE,
			"message_type": "Text",
			"message": "E2E إشعار: مهمة جديدة «{{ doc.description }}» — إلى {{ recipient.display_name }} 🔔",
			"recipients": [{"recipient_type": "Fixed Number", "phone": RECIPIENT}],
		}
		f = self.fresh()
		if f.db.exists("WhatsApp Notification", nname):
			payload["name"] = nname
		self.client.read("notifications.get_editor")
		res = self.client.write("notifications.save_editor", payload=payload)
		self.remember("notifications", res["name"])
		self.reserve(1)
		self.pace()
		desc = f"E2E notify {self.run_id}"
		todo = self._todo(desc)
		deadline = time.time() + 60
		rows = []
		while time.time() < deadline:
			rows = self.fresh().get_all("WhatsApp Log", filters={"notification": nname, "reference_name": todo}, pluck="name")
			if rows:
				break
			time.sleep(3)
		time.sleep(20)  # a second (double) send would appear by now
		rows = self.fresh().get_all("WhatsApp Log", filters={"notification": nname, "reference_name": todo}, pluck="name")
		sc.check("exactly ONE message for one new ToDo", len(rows) == 1, rows)
		if not rows:
			return
		row = self.verify_message(sc, rows[0], "notification")
		sc.check("recipient name rendered in the body", RECIPIENT_NAME in (row.get("body") or ""), row.get("body"))
		sc.check("ToDo text rendered in the body", desc in (row.get("body") or ""), "")
		nd = self.fresh().db.get_value("WhatsApp Notification", nname, ["send_count", "last_sent_at", "last_error"], as_dict=True)
		sc.check("notification counters updated, no error", (nd.send_count or 0) >= 1 and nd.last_sent_at and not nd.last_error, nd)
		self.client.write("notifications.save_editor", payload={**payload, "name": nname, "enabled": 0})
		sc.check("notification disabled after the test", not self.fresh().db.get_value("WhatsApp Notification", nname, "enabled"))

	def sc_alert(self, sc: Scenario) -> None:
		aname = "E2E Alert"
		payload = {
			"alert_name": aname,
			"enabled": 1,
			"periodicity": "Daily",
			"notification_time": "04:10",
			"content_type": "Report",
			"report": REPORT,
			"attachment_format": "None",
			"device": DEVICE,
			"message": "E2E تنبيه: {{ row_count }} مهام E2E مفتوحة 📋\n{% for r in rows[:3] %}• {{ r.description }}\n{% endfor %}",
			"recipients": [{"recipient_type": "Phone", "phone": RECIPIENT}],
		}
		f = self.fresh()
		if f.db.exists("WhatsApp Notification Alert", aname):
			payload["name"] = aname
		pv = self.client.write("alerts.preview_draft", payload=payload)
		sc.check("draft preview: no problem, one recipient", not pv.get("problem") and not pv.get("error") and pv.get("recipients_count") == 1, {k: pv.get(k) for k in ("problem", "error", "row_count", "recipients_count", "message")})
		res = self.client.write("alerts.save_editor", payload=payload)
		self.remember("alerts", res["name"])
		sc.notes.append(f"saved: {res}")
		p = self.client.write("alerts.preview", name=aname)
		sc.check("saved alert preview has rows", not p.get("error") and (p.get("row_count") or 0) >= 1, p)
		self.reserve(1)
		self.pace()
		before = set(self.fresh().get_all("WhatsApp Log", filters={"notification_alert": aname}, pluck="name"))
		self.client.write("alerts.run_now", name=aname)
		deadline = time.time() + 120
		new = []
		while time.time() < deadline:
			new = [n for n in self.fresh().get_all("WhatsApp Log", filters={"notification_alert": aname}, pluck="name") if n not in before]
			if new:
				break
			time.sleep(3)
		time.sleep(15)
		new = [n for n in self.fresh().get_all("WhatsApp Log", filters={"notification_alert": aname}, pluck="name") if n not in before]
		sc.check("run_now → exactly one message", len(new) == 1, new)
		if new:
			row = self.verify_message(sc, new[0], "alert")
			sc.check("alert body rendered the report rows", "E2E" in (row.get("body") or "") and "{{" not in (row.get("body") or ""), row.get("body"))
		ad = self.fresh().db.get_value("WhatsApp Notification Alert", aname, ["send_count", "last_sent_at", "last_error", "next_run_at"], as_dict=True)
		sc.check("alert counters updated, no error", (ad.send_count or 0) >= 1 and not ad.last_error, ad)
		self.client.write("alerts.set_enabled", name=aname, enabled=0)
		sc.check("alert disabled after the test", not self.fresh().db.get_value("WhatsApp Notification Alert", aname, "enabled"))

	def sc_resend(self, sc: Scenario) -> None:
		"""Resend our own failed messages, if any."""
		failed = [n for n in self.state["messages"] if self.db_log(n).get("status") == "Failed"]
		if not failed:
			sc.status = "skipped"
			sc.notes.append("none of our messages failed")
			return
		for n in failed[:2]:
			self.reserve(1)
			self.pace()
			r = self.client.write("messages.resend", name=n)
			self.verify_message(sc, r["outbound"], f"resend-of-{n}")

	# ---- consistency
	def number_row(self) -> dict:
		f = self.fresh()
		row = f.db.get_value("WhatsApp Number", RECIPIENT, ["outbound_count", "inbound_count", "last_seen", "last_direction", "last_device", "display_name", "first_seen"], as_dict=True)
		return {k: str(v) if isinstance(v, dt.datetime) else v for k, v in (row or {}).items()}

	def sc_consistency(self, sc: Scenario) -> None:
		f = self.fresh()
		time.sleep(5)
		num = self.number_row()
		n_out = f.db.count("WhatsApp Log", {"phone_e164": RECIPIENT})
		n_in = f.db.count("WhatsApp Inbound Message", {"phone_e164": RECIPIENT, "is_group": 0})  # group messages count to the group
		sc.check("Number.outbound_count equals its WhatsApp Log rows", num.get("outbound_count") == n_out, f"row {num.get('outbound_count')} vs logs {n_out}")
		sc.check("Number.inbound_count equals its inbound rows", num.get("inbound_count") == n_in, f"row {num.get('inbound_count')} vs {n_in}")
		last_out = f.db.sql("select max(creation) from `tabWhatsApp Log` where phone_e164=%s", RECIPIENT)[0][0]
		last_in = f.db.sql("select max(received_at) from `tabWhatsApp Inbound Message` where phone_e164=%s and is_group=0", RECIPIENT)[0][0]
		want = max([x for x in (last_out, last_in) if x])
		sc.check("Number.last_seen is the latest message", num.get("last_seen") and abs((dt.datetime.fromisoformat(num["last_seen"]) - want).total_seconds()) < 2, f"{num.get('last_seen')} vs {want}")
		sc.check("Number.last_seen not in the future", num.get("last_seen") and dt.datetime.fromisoformat(num["last_seen"]) <= self.site_now() + dt.timedelta(seconds=60), num.get("last_seen"))
		base = self.state.get("baseline_number") or {}
		sc.notes.append(f"number before {base} after {num}")
		api = self.client.read("numbers.get_number", phone_e164=RECIPIENT)
		sc.check("numbers.get_number agrees with the row", api.get("outbound_count") == num.get("outbound_count") and api.get("inbound_count") == num.get("inbound_count"), {k: api.get(k) for k in ("outbound_count", "inbound_count", "last_seen", "display_name")})
		dash = self.client.read("home.get_dashboard")
		today = dash.get("today") or {}
		from frappe.utils import getdate

		midnight = dt.datetime.combine(getdate(), dt.time())
		db_sent = f.db.count("WhatsApp Log", {"sent_at": (">=", midnight)})
		db_del = f.db.count("WhatsApp Log", {"delivered_at": (">=", midnight)})
		db_fail = f.db.count("WhatsApp Log", {"failed_at": (">=", midnight)})
		sc.check("Home today.sent equals rows sent since site midnight", today.get("sent") == db_sent, f"{today} vs sent={db_sent}")
		sc.check("Home today.delivered equals rows delivered since midnight", today.get("delivered") == db_del, f"vs {db_del}")
		sc.check("Home today.failed equals rows failed since midnight", today.get("failed") == db_fail, f"vs {db_fail}")
		q = dash.get("queue") or {}
		db_q = {s: f.db.count("WhatsApp Queue Item", {"status": s}) for s in ("Queued", "Paused", "Dead Letter")}
		sc.check("Home queue counts equal the queue table", q.get("queued") == db_q["Queued"] and q.get("paused") == db_q["Paused"] and q.get("dead_letter") == db_q["Dead Letter"], f"{q} vs {db_q}")
		real, pending = self.used_budget()
		sc.notes.append(f"real messages sent to {RECIPIENT} since first run: {real} (+{pending} pending) of {MAX_REAL}")

	def sc_screens(self, sc: Scenario) -> None:
		msgs = self.state["messages"]
		camps = [c for c in self.state["created"].get("campaigns", [])]
		payload = {
			"outbound": msgs[-1] if msgs else None,
			"campaign": camps[0] if camps else None,
			"number": RECIPIENT,
		}
		for lang in ("en", "ar"):
			res = self.ui("shots", payload, lang)
			for page in res.get("pages", []):
				sc.check(f"[{lang}] {page['name']}: no JS/HTTP errors", not page.get("errors"), page.get("errors"))
				for k, v in (page.get("facts") or {}).items():
					sc.notes.append(f"[{lang}] {page['name']} {k}: {v}")
			if res.get("errors"):
				sc.check(f"[{lang}] shots run", False, res.get("errors"))
		sc.notes.append(f"screenshots in {os.path.join(self.out, 'shots')}")

	def sc_verify_inbound(self, sc: Scenario) -> None:
		"""After the owner's phone test: the latest inbound rows, routing, replies and reply time."""
		since = self.args.since or str(self.site_now() - dt.timedelta(hours=3))
		f = self.fresh()
		rows = f.get_all(
			"WhatsApp Inbound Message",
			filters={"received_at": (">=", since), "is_simulated": 0, "device": DEVICE},
			fields=["name", "phone_e164", "message_type", "body", "caption", "received_at", "creation", "command_status", "command", "command_text", "command_error", "block_reason", "reply_outbound", "replied_at", "quoted_provider_message_id", "attachment", "display_name"],
			order_by="received_at asc",
		)
		sc.notes.append(f"{len(rows)} inbound rows since {since}")
		if not rows:
			sc.status = "skipped"
			sc.notes.append("no inbound yet — ask the owner to send the list first")
			return
		for r in rows:
			rep = self.db_log(r.reply_outbound) if r.reply_outbound else {}
			latency = (rep.get("sent_at") - r.received_at).total_seconds() if rep.get("sent_at") and r.received_at else None
			info = {
				"inbound": r.name, "from": r.phone_e164, "type": r.message_type, "text": (r.body or r.caption or "")[:80],
				"received_at": str(r.received_at), "command_status": r.command_status, "command": r.command,
				"block_reason": r.block_reason, "error": r.command_error, "reply": r.reply_outbound,
				"reply_status": rep.get("status"), "reply_body": (rep.get("body") or rep.get("caption") or "")[:160],
				"reply_type": rep.get("message_type"), "reply_seconds": latency, "quoted": r.quoted_provider_message_id,
				"attachment": r.attachment,
			}
			sc.messages.append(info)
			sc.check(f"{r.name}: received_at not in the future and ≈ creation", r.received_at <= self.site_now() + dt.timedelta(seconds=60) and abs((r.creation - r.received_at).total_seconds()) < 600, f"{r.received_at} / {r.creation}")
			if r.command_status in ("Matched", "Executed"):
				sc.check(f"{r.name} «{info['text']}» → {r.command}: reply sent", rep.get("status") in ("Sent", "Delivered", "Read"), info)
				if latency is not None:
					sc.check(f"{r.name}: reply within 180 s", 0 <= latency <= 180, f"{latency:.0f}s")
			elif r.command_status == "Failed":
				sc.check(f"{r.name} «{info['text']}» → {r.command}: command failed", False, r.command_error)
			else:
				sc.notes.append(f"{r.name} «{info['text']}»: {r.command_status} {r.block_reason or ''} reply={rep.get('status')}")

	def sc_cleanup(self, sc: Scenario) -> None:
		c = self.state["created"]
		for n in c.get("notifications", []):
			try:
				self.client.write("notifications.delete_notification", name=n)
				sc.check(f"notification {n} deleted", not self.fresh().db.exists("WhatsApp Notification", n))
			except ApiError as exc:
				sc.notes.append(f"notification {n}: {exc}; disabling")
				try:
					self.client.update("WhatsApp Notification", n, {"enabled": 0})
				except Exception:
					pass
		for n in c.get("alerts", []):
			try:
				self.client.write("alerts.delete_alert", name=n)
				sc.check(f"alert {n} deleted", not self.fresh().db.exists("WhatsApp Notification Alert", n))
			except ApiError as exc:
				sc.notes.append(f"alert {n}: {exc}; disabling")
				try:
					self.client.write("alerts.set_enabled", name=n, enabled=0)
				except Exception:
					pass
		for n in c.get("templates", []):
			try:
				self.client.update("WhatsApp Template", n, {"disabled": 1})
				sc.check(f"template {n} disabled", self.fresh().db.get_value("WhatsApp Template", n, "disabled") == 1)
			except ApiError as exc:
				sc.notes.append(f"template {n}: {exc}")
		for n in c.get("groups", []):
			try:
				self.client.update("WhatsApp Contact Group", n, {"disabled": 1})
				sc.check(f"group {n} disabled", self.fresh().db.get_value("WhatsApp Contact Group", n, "disabled") == 1)
			except ApiError as exc:
				sc.notes.append(f"group {n}: {exc}")
		for n in c.get("todos", []):
			try:
				self.client.update("ToDo", n, {"status": "Closed"})
			except ApiError as exc:
				sc.notes.append(f"todo {n}: {exc}")
		for n in c.get("campaigns", []) + c.get("bulk_campaigns", []):
			st = self.fresh().db.get_value("WhatsApp Campaign", n, "status")
			if st in ("Draft", "Scheduled"):
				try:
					self.client.write("campaigns.cancel", name=n, reason="E2E cleanup")
				except ApiError as exc:
					sc.notes.append(f"campaign {n}: {exc}")
			sc.notes.append(f"campaign {n} kept as history ({self.fresh().db.get_value('WhatsApp Campaign', n, 'status')})")
		f = self.frappe
		for n in c.get("reports", []):
			if f.db.exists("Report", n):
				f.delete_doc("Report", n, ignore_permissions=True, force=True)
		if f.db.exists("User", USER):
			f.db.set_value("User", USER, "enabled", 0)
		f.db.commit()
		sc.notes.append("E2E report deleted, E2E user disabled; logs, queue items and finished campaigns stay as history")

	# ---- report
	def write_report(self) -> None:
		base = os.path.join(self.out, f"run-{self.run_id}")
		data = {
			"run_id": self.run_id,
			"site": self.args.site,
			"dry_run": self.args.dry_run,
			"started": str(self.run_start),
			"budget": dict(zip(("real", "pending"), self.used_budget())),
			"scenarios": [{**asdict(s), "checks": [asdict(c) for c in s.checks]} for s in self.results],
		}
		with open(base + ".json", "w") as fh:
			json.dump(data, fh, ensure_ascii=False, indent=1, default=str)
		lines = [f"# live E2E run {self.run_id}", "", f"site `{self.args.site}` · dry-run: {self.args.dry_run} · budget {data['budget']}", ""]
		lines += ["| scenario | status | checks | seconds |", "|---|---|---|---|"]
		for s in self.results:
			ok = sum(1 for c in s.checks if c.ok)
			lines.append(f"| {s.name} | {s.status} | {ok}/{len(s.checks)} | {s.seconds} |")
		for s in self.results:
			lines += ["", f"## {s.name} — {s.status}", ""]
			for m in s.messages:
				lines.append(f"- message `{m.get('name') or m.get('inbound')}` {json.dumps(m, ensure_ascii=False, default=str)}")
			for c in s.checks:
				lines.append(f"- [{'x' if c.ok else ' '}] {c.name} {('— ' + c.detail) if c.detail and not c.ok else ''}")
			for n in s.notes:
				lines.append(f"  - note: {n[:700]}")
		with open(base + ".md", "w") as fh:
			fh.write("\n".join(lines) + "\n")


ALL = [
	"preflight",
	"quick_text_ui",
	"quick_formatted",
	"quick_image",
	"quick_pdf",
	"template",
	"simulator",
	"bulk",
	"campaign",
	"campaign_scheduled",
	"queue_ops",
	"notification",
	"alert",
	"resend",
	"consistency",
	"screens",
]


def main() -> int:
	ap = argparse.ArgumentParser(description=__doc__)
	ap.add_argument("--site", default="whatsapp.dev.sanad.digital")
	ap.add_argument("--base", default="http://127.0.0.1:8000")
	ap.add_argument("--out", required=True, help="results, state.json and shots/ go here")
	ap.add_argument("--pw-dir", default=os.environ.get("E2E_PW_DIR"), help="folder with node_modules/playwright")
	ap.add_argument("--only", nargs="*", default=None, help=f"scenarios: {' '.join(ALL + ['verify_inbound', 'cleanup'])}")
	ap.add_argument("--dry-run", action="store_true", help="reads only; stops each scenario at its first write")
	ap.add_argument("--names", nargs="*", default=None, help="verify_existing: WhatsApp Log names")
	ap.add_argument("--since", default=None, help="verify_inbound: site-time start (default: 3 h ago)")
	args = ap.parse_args()
	names = args.only or ALL
	if "preflight" not in names and names != ["cleanup"]:
		names = ["preflight"] + names
	eng = Engine(args)
	try:
		eng.run(names)
	finally:
		eng.frappe.destroy()
	bad = [s for s in eng.results if s.status in ("fail", "error")]
	print("\n" + "\n".join(f"{s.name:<20} {s.status}" for s in eng.results))
	print(f"results: {os.path.join(eng.out, 'run-' + eng.run_id)}.json/.md")
	return 1 if bad else 0


if __name__ == "__main__":
	sys.exit(main())

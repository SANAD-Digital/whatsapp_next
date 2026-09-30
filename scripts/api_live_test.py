# Live HTTP test of the whole whitelisted API against the running server (not in-process): real
# routing, real authentication (API keys and a cookie session), real serialization and HTTP codes.
#
#   cd ~/frappe-bench
#   env/bin/python apps/whatsapp_next/scripts/api_live_test.py --site whatsapp.dev.sanad.digital
#
# What it checks, for every function decorated with `api_endpoint`:
#   1. roles    — Guest, a website user, a desk user with no WhatsApp role and every WhatsApp role
#                 below the requirement get 403; a role that meets it gets past the gate. The
#                 probe carries an unknown argument, which `coerce_arguments` refuses before the
#                 function body runs, so a probe never executes anything.
#   2. methods  — a GET on a POST-only endpoint is refused.
#   3. inputs   — malformed typed values (int, bool, list, dict, date) are a 417, never a 500;
#                 hostile strings (SQL, oversize, markup) on read-only endpoints are never a 500.
#   4. errors   — no response carries a server traceback to a non-System-Manager caller.
#   5. record-level endpoints (`roles=None`) refuse users without WhatsApp or Contact rights.
#   6. REST     — `/api/resource/<WhatsApp DocType>` refuses users with no WhatsApp role; password
#                 fields never come back.
#   7. webhook  — unsigned, forged, stale, malformed and replayed deliveries.
#   8. CSRF     — a cookie session cannot POST without the CSRF token.
#
# It creates users `wa-live-*@example.com` (removed at the end unless --keep-users) and never
# calls a write endpoint with arguments that would reach its body.

from __future__ import annotations

import argparse
import hashlib
import hmac
import importlib
import inspect
import json
import os
import pkgutil
import sys
import time
import typing
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime

import requests

BENCH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
PROBE = {"zz_live_probe": "1"}
USER_DOMAIN = "example.com"
PREFIX = "wa-live-"
PASSWORD = "Wa-Live-" + uuid.uuid4().hex[:16] + "!9"

# who is who: role sets per test identity
IDENTITIES: dict[str, tuple[str, ...]] = {
	"website": (),
	"desk_other": ("Projects User",),
	"contact_user": ("WhatsApp Contact User",),
	"viewer": ("WhatsApp Viewer",),
	"agent": ("WhatsApp Agent",),
	"manager": ("WhatsApp Manager",),
	"sysmgr": ("System Manager",),
}
ALLOWED_STATUSES = {200, 401, 403, 404, 409, 417, 429, 503}
HOSTILE_STRINGS = [
	"' OR '1'='1' -- ",
	'"); DROP TABLE `tabContact`; --',
	"name desc; select sleep(5)",
	"`name` ASC, (SELECT 1)",
	"<script>alert(1)</script>{{ frappe.get_all('User') }}",
	"../../../../etc/passwd",
	"%",
	"\u202e\u0000\ufeff",
	"x" * 20000,
]
TYPE_JUNK = {
	int: ["abc", "1.5", "[]", "99999999999999999999999"],
	bool: ["maybe", "2", "[]"],
	list: ["{not json", '{"a": 1}', "5"],
	dict: ["{not json", "[1,2]", '"str"'],
	date: ["not-a-date", "2026-13-45"],
	datetime: ["not-a-datetime", "2026-02-30 25:61"],
}


@dataclass
class Result:
	section: str
	name: str
	ok: bool
	detail: str = ""


@dataclass
class Endpoint:
	path: str
	roles: tuple[str, ...]
	methods: tuple[str, ...]
	allow_guest: bool
	params: dict[str, object]
	required: tuple[str, ...]
	fn: object = None


@dataclass
class Ctx:
	base: str
	host: str
	site: str
	keys: dict[str, tuple[str, str]] = field(default_factory=dict)
	results: list[Result] = field(default_factory=list)
	verbose: bool = False

	def add(self, section: str, name: str, ok: bool, detail: str = "") -> None:
		self.results.append(Result(section, name, ok, detail))
		if self.verbose or not ok:
			print(f"  [{'PASS' if ok else 'FAIL'}] {section}: {name} {detail}")

	def call(
		self,
		path: str,
		who: str | None,
		method: str = "POST",
		data: dict | None = None,
		headers: dict | None = None,
		raw: bytes | None = None,
		session: requests.Session | None = None,
	) -> requests.Response:
		h = {"Host": self.host, "Accept": "application/json"}
		if who:
			key, secret = self.keys[who]
			h["Authorization"] = f"token {key}:{secret}"
		h.update(headers or {})
		url = f"{self.base}/api/method/{path}"
		s = session or requests
		if raw is not None:
			return s.request(method, url, data=raw, headers=h, timeout=60)
		if method == "GET":
			return s.request(method, url, params=data or {}, headers=h, timeout=60)
		return s.request(method, url, data=data or {}, headers=h, timeout=60)


# --------------------------------------------------------------------------- setup (in-process)


def frappe_connect(site: str):
	import frappe

	os.chdir(os.path.join(BENCH, "sites"))
	frappe.init(site=site, sites_path=".")
	frappe.connect()
	frappe.set_user("Administrator")
	return frappe


def make_users(frappe) -> dict[str, tuple[str, str]]:
	keys = {}
	for ident, roles in IDENTITIES.items():
		email = f"{PREFIX}{ident.replace('_', '-')}@{USER_DOMAIN}"
		if frappe.db.exists("User", email):
			user = frappe.get_doc("User", email)
		else:
			user = frappe.get_doc(
				{
					"doctype": "User",
					"email": email,
					"first_name": f"Live {ident}",
					"send_welcome_email": 0,
					"user_type": "System User" if roles else "Website User",
				}
			)
			user.insert(ignore_permissions=True)
		user.set("roles", [])
		for role in roles:
			user.append("roles", {"role": role})
		user.user_type = "System User" if roles else "Website User"
		user.api_key = user.api_key or frappe.generate_hash(length=15)
		secret = frappe.generate_hash(length=15)
		user.api_secret = secret
		user.new_password = PASSWORD
		user.flags.ignore_password_policy = True
		user.save(ignore_permissions=True)
		keys[ident] = (user.api_key, secret)
	frappe.db.commit()
	return keys


def drop_users(frappe) -> None:
	for ident in IDENTITIES:
		email = f"{PREFIX}{ident.replace('_', '-')}@{USER_DOMAIN}"
		if frappe.db.exists("User", email):
			frappe.delete_doc("User", email, ignore_permissions=True, force=True)
	frappe.db.commit()


def discover(frappe) -> list[Endpoint]:
	from whatsapp_next.api import v1
	from whatsapp_next.webhooks import v1 as wh

	for pkg in (v1, wh):
		for info in pkgutil.iter_modules(pkg.__path__, prefix=f"{pkg.__name__}."):
			importlib.import_module(info.name)
	out = []
	for fn in frappe.whitelisted:
		if not getattr(fn, "__wa_api_endpoint__", False):
			continue
		path = f"{fn.__module__}.{fn.__name__}"
		sig = inspect.signature(fn)
		hints = typing.get_type_hints(fn)
		params = {
			n: hints.get(n)
			for n, p in sig.parameters.items()
			if p.kind not in (p.VAR_KEYWORD, p.VAR_POSITIONAL)
		}
		required = tuple(
			n
			for n, p in sig.parameters.items()
			if p.default is p.empty and p.kind not in (p.VAR_KEYWORD, p.VAR_POSITIONAL)
		)
		out.append(
			Endpoint(
				path=path,
				roles=tuple(fn.__wa_roles__),
				methods=tuple(frappe.allowed_http_methods_for_whitelisted_func.get(fn, ["POST"])),
				allow_guest=fn in frappe.guest_methods,
				params=params,
				required=required,
				fn=fn,
			)
		)
	return sorted(out, key=lambda e: e.path)


# --------------------------------------------------------------------------- helpers


def body(r: requests.Response) -> dict:
	try:
		return r.json()
	except ValueError:
		return {}


def leaks_traceback(r: requests.Response) -> bool:
	b = body(r)
	blob = json.dumps({k: b.get(k) for k in ("exc", "exception", "_server_messages", "message")}, default=str)
	return "Traceback (most recent call last)" in blob or 'File \\"/' in blob


def base_type(hint):
	origin = typing.get_origin(hint)
	if origin in (typing.Union, getattr(__import__("types"), "UnionType", None)):
		args = [a for a in typing.get_args(hint) if a is not type(None)]
		if len(args) == 1:
			return base_type(args[0])
		for a in args:
			if typing.get_origin(a) in (list, dict) or a in (list, dict):
				return typing.get_origin(a) or a
		return None
	return origin or hint


# --------------------------------------------------------------------------- 1–2. gates


def role_allows(ep: Endpoint, ident: str) -> bool:
	return bool(set(IDENTITIES[ident]) & set(ep.roles))


def check_gates(ctx: Ctx, eps: list[Endpoint]) -> None:
	for ep in eps:
		if ep.allow_guest:
			continue
		method = "POST" if "POST" in ep.methods else ep.methods[0]
		r = ctx.call(ep.path, None, method, PROBE)
		ctx.add("roles", f"{ep.path} guest", r.status_code == 403, f"got {r.status_code}")
		if not ep.roles:
			continue  # record-level: covered in check_record_level
		for ident in IDENTITIES:
			if role_allows(ep, ident):
				# Past the gate. Frappe drops arguments the signature does not name before the
				# wrapper runs, so an unknown argument does NOT stop the body: the positive probe
				# leaves a required argument out (refused as 417 before the body), or, for a
				# read endpoint, simply calls it. A write endpoint with no required argument is
				# not probed positively — calling it would execute it.
				if ep.required:
					r = ctx.call(ep.path, ident, method, {})
					ok = r.status_code == 417 and ep.required[0] in r.text
				elif "GET" in ep.methods:
					r = ctx.call(ep.path, ident, "GET", {})
					ok = r.status_code not in (401, 403) and r.status_code < 500
				else:
					continue
				ctx.add("roles", f"{ep.path} {ident} allowed", ok, f"got {r.status_code}")
			else:
				r = ctx.call(ep.path, ident, method, PROBE)
				ctx.add("roles", f"{ep.path} {ident} denied", r.status_code == 403, f"got {r.status_code}")
		if "GET" not in ep.methods:
			r = ctx.call(ep.path, "sysmgr", "GET", PROBE)
			ctx.add("methods", f"{ep.path} GET refused", r.status_code in (403, 405), f"got {r.status_code}")
		# missing required argument names the argument, as a 417
		if ep.required:
			r = ctx.call(ep.path, "sysmgr", method, {})
			ctx.add(
				"inputs",
				f"{ep.path} missing args",
				r.status_code == 417 and ep.required[0] in r.text,
				f"got {r.status_code}",
			)


# --------------------------------------------------------------------------- 3–4. inputs


def check_inputs(ctx: Ctx, eps: list[Endpoint]) -> None:
	for ep in eps:
		if ep.allow_guest:
			continue
		method = "POST" if "POST" in ep.methods else ep.methods[0]
		# Typed junk. Coercion runs over every given argument before the missing-argument check,
		# so on a write endpoint one other required argument is left out: junk that coercion
		# wrongly accepts is still refused before the body. A write endpoint with no other
		# required argument is not fuzzed.
		writes = "GET" not in ep.methods
		for pname, hint in ep.params.items():
			t = base_type(hint)
			holdout = next((p for p in ep.required if p != pname), None)
			if writes and not holdout:
				continue
			for junk in TYPE_JUNK.get(t, []):
				data = {}
				for p in ep.required:
					if p == pname or (writes and p == holdout):
						continue
					st = base_type(ep.params[p])
					data[p] = {int: "1", bool: "0", list: "[]", dict: "{}", date: "2026-01-01", datetime: "2026-01-01 00:00:00"}.get(st, "x")
				data[pname] = junk
				r = ctx.call(ep.path, "sysmgr", method, data)
				ok = r.status_code in (417, 403) and r.status_code != 500
				ctx.add("inputs", f"{ep.path} {pname}={junk[:20]!r}", ok, f"got {r.status_code}")
		# hostile strings: only on endpoints that accept GET (read-only by contract)
		if "GET" not in ep.methods:
			continue
		str_params = [p for p, h in ep.params.items() if base_type(h) is str]
		for pname in str_params:
			for s in HOSTILE_STRINGS:
				data = {}
				for p in ep.required:
					st = base_type(ep.params[p])
					data[p] = {int: "1", bool: "0", list: "[]", dict: "{}", date: "2026-01-01", datetime: "2026-01-01 00:00:00"}.get(st, "x")
				data[pname] = s
				t0 = time.monotonic()
				r = ctx.call(ep.path, "sysmgr", "POST" if "POST" in ep.methods else "GET", data)
				took = time.monotonic() - t0
				ok = r.status_code in ALLOWED_STATUSES and took < 4.5
				ctx.add("inputs", f"{ep.path} {pname}<-{s[:24]!r}", ok, f"got {r.status_code} in {took:.1f}s")
				if r.status_code != 500 and "sleep" in s:
					ctx.add("inputs", f"{ep.path} {pname} time-based SQLi", took < 4.5, f"{took:.1f}s")


def check_error_hygiene(ctx: Ctx, eps: list[Endpoint]) -> None:
	"""An error seen by a non-System-Manager must not carry a Python traceback."""
	for ep in eps:
		if ep.allow_guest or not ep.required:
			continue
		for ident in ("agent", "manager", "contact_user"):
			if ep.roles and not role_allows(ep, ident):
				continue
			method = "POST" if "POST" in ep.methods else ep.methods[0]
			if "GET" not in ep.methods:
				data = {}  # missing required argument: refused before the body
			else:
				data = {p: "does-not-exist-" + uuid.uuid4().hex[:6] for p in ep.required}
			r = ctx.call(ep.path, ident, method, data)
			ctx.add("errors", f"{ep.path} as {ident} no 5xx", r.status_code < 500, f"got {r.status_code}")
			ctx.add("errors", f"{ep.path} as {ident} no traceback", not leaks_traceback(r), f"status {r.status_code}")
			break


# --------------------------------------------------------------------------- 5. record level

RECORD_LEVEL_SAMPLES: dict[str, dict] = {
	"contacts.list_contacts": {},
	"contacts.get_stats": {},
	"contacts.get_contact": {"name": "{contact}"},
	"contacts.create_contact": {"payload": json.dumps({"first_name": "Live Probe"})},
	"contacts.update_contact": {"name": "{contact}", "payload": json.dumps({"designation": "pwned"})},
	"contacts.search_party": {"party_type": "Customer"},
	"contacts.search_company": {},
	"contacts.get_activity": {"name": "{contact}"},
	"contacts.get_contact_numbers": {"contact": "{contact}"},
	"contacts.link_many": {"names": json.dumps(["{contact}"]), "link_doctype": "Customer", "link_name": "x"},
	"numbers.link_number": {"phone_e164": "+966500000001", "contact": "{contact}"},
	"numbers.convert_number": {"phone_e164": "+966500000001"},
	"numbers.convert_many": {"phone_e164s": json.dumps(["+966500000001"])},
	"numbers.get_conversation_log": {"phone_e164": "{number}"},
	"messages.get_conversation": {"phone_e164": "{number}"},
	"picker.preview": {"target_doctype": "WhatsApp Contact Group", "target_name": "{group}"},
	"picker.commit_add": {
		"target_doctype": "WhatsApp Contact Group",
		"target_name": "{group}",
		"source_type": "manual",
		"rows": json.dumps([{"phone": "+966500000001"}]),
	},
	"picker.commit_remove": {
		"target_doctype": "WhatsApp Contact Group",
		"target_name": "{group}",
		"keys": json.dumps(["+966500000001"]),
	},
}


def check_record_level(ctx: Ctx, eps: list[Endpoint], frappe) -> None:
	# a fixture contact owned by Administrator: a denied write that slips through lands here
	target = frappe.get_doc(
		{"doctype": "Contact", "first_name": "Live Probe Target", "designation": "untouched"}
	).insert(ignore_permissions=True)
	frappe.db.commit()
	contact = target.name
	number = frappe.db.get_value("WhatsApp Number", {}, "phone_e164") or "+966500000000"
	group = frappe.db.get_value("WhatsApp Contact Group", {}, "name") or "none"
	fill = {"{contact}": contact, "{number}": number, "{group}": group}
	before = "untouched"
	members_before = frappe.db.count("WhatsApp Contact Group Member", {"phone_e164": "+966500000001"}) if frappe.db.has_column("WhatsApp Contact Group Member", "phone_e164") else None
	for ep in eps:
		if ep.roles or ep.allow_guest:
			continue
		short = ep.path.replace("whatsapp_next.api.v1.", "")
		sample = RECORD_LEVEL_SAMPLES.get(short)
		if sample is None:
			ctx.add("record", f"{short} has a sample", False, "add it to RECORD_LEVEL_SAMPLES")
			continue
		data = {}
		for k, v in sample.items():
			for token, real in fill.items():
				v = v.replace(token, real)
			data[k] = v
		# only params the function takes
		data = {k: v for k, v in data.items() if k in ep.params}
		method = "POST" if "POST" in ep.methods else ep.methods[0]
		for ident in ("website", "desk_other"):
			r = ctx.call(ep.path, ident, method, data)
			ctx.add("record", f"{short} {ident} denied", r.status_code == 403, f"got {r.status_code} {r.text[:120]}")
	frappe.db.rollback()
	after = frappe.db.get_value("Contact", contact, "designation")
	ctx.add("record", "contact untouched by denied users", after == before, f"{before!r} -> {after!r}")
	links = frappe.get_all("Dynamic Link", filters={"parenttype": "Contact", "parent": contact}, pluck="link_name")
	ctx.add("record", "no party link added by denied users", not links, f"links={links}")
	created = frappe.get_all("Contact", filters={"first_name": "Live Probe"}, pluck="name")
	ctx.add("record", "no contact created by denied users", not created, f"created={created}")
	if members_before is not None:
		members_after = frappe.db.count("WhatsApp Contact Group Member", {"phone_e164": "+966500000001"})
		ctx.add("record", "no group member added by denied users", members_after == members_before)
	for name in [contact, *created]:
		frappe.delete_doc("Contact", name, ignore_permissions=True, force=True)
	frappe.db.commit()


# --------------------------------------------------------------------------- 6. REST


def check_rest(ctx: Ctx, frappe) -> None:
	doctypes = frappe.get_all("DocType", filters={"module": "WhatsApp Next", "istable": 0}, pluck="name")
	for dt in doctypes:
		url = f"{ctx.base}/api/resource/{dt}"
		for ident in ("website", "desk_other"):
			key, secret = ctx.keys[ident]
			r = requests.get(url, headers={"Host": ctx.host, "Authorization": f"token {key}:{secret}"}, timeout=30)
			rows = body(r).get("data") or []
			ok = r.status_code == 403 or (r.status_code == 200 and not rows)
			ctx.add("rest", f"{dt} list as {ident}", ok, f"got {r.status_code} rows={len(rows)}")
		# password fields never serialized, even to a System Manager
		pw_fields = [
			d.fieldname for d in frappe.get_meta(dt).fields if d.fieldtype == "Password"
		]
		if pw_fields:
			key, secret = ctx.keys["sysmgr"]
			target = dt if frappe.get_meta(dt).issingle else frappe.db.get_value(dt, {}, "name")
			if not target:
				continue
			path = f"{dt}/{dt}" if frappe.get_meta(dt).issingle else f"{dt}/{target}"
			r = requests.get(
				f"{ctx.base}/api/resource/{path}",
				headers={"Host": ctx.host, "Authorization": f"token {key}:{secret}"},
				timeout=30,
			)
			doc = body(r).get("data") or {}
			leaked = [f for f in pw_fields if doc.get(f) and set(str(doc.get(f))) != {"*"}]
			ctx.add("rest", f"{dt} password fields masked", not leaked, f"leaked={leaked}")


# --------------------------------------------------------------------------- 7. webhook

RECEIVER = "whatsapp_next.webhooks.v1.receiver.receive"


def check_webhook(ctx: Ctx, frappe) -> None:
	from whatsapp_next.providers.snd_platform import SndPlatformProvider as P

	settings = frappe.get_doc("WhatsApp Settings")
	secret = settings.get_password("webhook_secret", raise_exception=False)
	created: list[str] = []

	def send(headers: dict, raw: bytes, method: str = "POST") -> requests.Response:
		h = {"Content-Type": "application/json", **headers}
		return ctx.call(RECEIVER, None, method, headers=h, raw=raw)

	def signed(event_id: str, payload: dict, ts: str | None = None, sec: str | None = None) -> tuple[dict, bytes]:
		raw = json.dumps(payload).encode()
		ts = ts or str(int(time.time()))
		created.append(event_id)
		return (
			{
				"X-SND-Event": payload.get("event", "live.test"),
				"X-SND-Event-ID": event_id,
				"X-SND-Timestamp": ts,
				"X-SND-Signature": P.sign(sec or secret or "x", ts, raw),
			},
			raw,
		)

	eid = lambda: f"live-{uuid.uuid4().hex}"  # noqa: E731
	payload = {"event": "live.test", "device": f"no-such-device-{uuid.uuid4().hex[:6]}"}

	r = send({}, b"{}")
	ctx.add("webhook", "no headers -> 401", r.status_code == 401, f"got {r.status_code}")
	r = ctx.call(RECEIVER, None, "GET")
	ctx.add("webhook", "GET refused", r.status_code in (403, 405), f"got {r.status_code}")
	h, raw = signed(eid(), payload, sec="wrong-secret")
	r = send(h, raw)
	ctx.add("webhook", "forged signature -> 401", r.status_code == 401, f"got {r.status_code}")
	if not secret:
		ctx.add("webhook", "secret configured (rest skipped)", False, "no webhook_secret on site")
		return
	h, raw = signed(eid(), payload, ts=str(int(time.time()) - 3600))
	r = send(h, raw)
	ctx.add("webhook", "stale timestamp -> 401", r.status_code == 401, f"got {r.status_code}")
	for bad_ts in ("inf", "1e30", "-1e30", "nan", "abc", "99999999999999"):
		h, raw = signed(eid(), payload, ts=bad_ts)
		r = send(h, raw)
		ctx.add("webhook", f"timestamp {bad_ts!r} -> 4xx", 400 <= r.status_code < 500, f"got {r.status_code}")
	h, raw = signed(eid(), payload)
	h["X-SND-Signature"] = h["X-SND-Signature"].upper()
	r = send(h, raw)
	ctx.add("webhook", "uppercase signature accepted", r.status_code == 200, f"got {r.status_code}")
	# body not utf-8, body not json, body not an object
	ts = str(int(time.time()))
	for label, raw in (("non-utf8", b"\xff\xfe\x00bad"), ("not json", b"{nope"), ("array", b"[1,2]")):
		e = eid()
		created.append(e)
		h = {
			"X-SND-Event": "live.test",
			"X-SND-Event-ID": e,
			"X-SND-Timestamp": ts,
			"X-SND-Signature": P.sign(secret, ts, raw.decode("utf-8", "replace")) if label != "non-utf8" else "0" * 64,
		}
		r = send(h, raw)
		ctx.add("webhook", f"{label} body -> 4xx", 400 <= r.status_code < 500, f"got {r.status_code}")
	# oversize event id
	e = "x" * 5000
	created.append(e)
	h, raw = signed(e, payload)
	r = send(h, raw)
	ctx.add("webhook", "oversize event id -> not 5xx", r.status_code < 500, f"got {r.status_code}")
	# valid, then replay
	e = eid()
	h, raw = signed(e, payload)
	r1 = send(h, raw)
	r2 = send(h, raw)
	ctx.add("webhook", "valid delivery accepted", r1.status_code == 200, f"got {r1.status_code} {r1.text[:100]}")
	ctx.add(
		"webhook",
		"replay is a duplicate",
		r2.status_code == 200 and (body(r2).get("message") or {}).get("duplicate") is True,
		r2.text[:120],
	)
	# unsigned delivery must not poison a later genuine one with the same id
	e = eid()
	h, raw = signed(e, {**payload}, sec="attacker")
	send(h, raw)
	h, raw = signed(e, payload)
	r = send(h, raw)
	ctx.add(
		"webhook",
		"forged id does not block the genuine event",
		r.status_code == 200 and not (body(r).get("message") or {}).get("duplicate"),
		r.text[:120],
	)
	# nothing leaks
	for r in (r1, r2):
		ctx.add("webhook", "response has no traceback", not leaks_traceback(r))
	frappe.db.rollback()
	for e in created:
		for n in frappe.get_all("WhatsApp Webhook Event", filters={"event_id": e[:140]}, pluck="name"):
			frappe.delete_doc("WhatsApp Webhook Event", n, ignore_permissions=True, force=True)
	frappe.db.commit()


# --------------------------------------------------------------------------- 8. CSRF


def check_csrf(ctx: Ctx) -> None:
	s = requests.Session()
	r = s.post(
		f"{ctx.base}/api/method/login",
		data={"usr": f"{PREFIX}manager@{USER_DOMAIN}", "pwd": PASSWORD},
		headers={"Host": ctx.host},
		timeout=30,
	)
	if r.status_code != 200:
		ctx.add("csrf", "cookie login", False, f"login {r.status_code} {r.text[:120]}")
		return
	# Frappe issues the session's CSRF token when the desk boots; a session that never opened the
	# desk has none and is not checked. Open the desk first, like a victim's browser would.
	s.get(f"{ctx.base}/app", headers={"Host": ctx.host}, timeout=60)
	# A POST-only endpoint with its required argument left out: if CSRF lets it through, the
	# argument check refuses it (417) before the body runs.
	path = "whatsapp_next.api.v1.queue.set_rate"
	r = s.post(f"{ctx.base}/api/method/{path}", data={}, headers={"Host": ctx.host}, timeout=30)
	ctx.add("csrf", "cookie POST without token refused", r.status_code in (400, 403), f"got {r.status_code}")
	r = s.get(
		f"{ctx.base}/api/method/whatsapp_next.api.v1.home.get_dashboard",
		headers={"Host": ctx.host},
		timeout=30,
	)
	ctx.add("csrf", "cookie GET on read endpoint works", r.status_code == 200, f"got {r.status_code}")
	s.post(f"{ctx.base}/api/method/logout", headers={"Host": ctx.host}, timeout=30)


# --------------------------------------------------------------------------- main


def main() -> int:
	ap = argparse.ArgumentParser()
	ap.add_argument("--site", default="whatsapp.dev.sanad.digital")
	ap.add_argument("--base", default="http://127.0.0.1:8000")
	ap.add_argument("--only", nargs="*", default=None, help="sections: gates inputs errors record rest webhook csrf")
	ap.add_argument("--keep-users", action="store_true")
	ap.add_argument("--report", default=None, help="write the JSON result list here")
	ap.add_argument("-v", "--verbose", action="store_true")
	args = ap.parse_args()

	frappe = frappe_connect(args.site)
	ctx = Ctx(base=args.base.rstrip("/"), host=args.site, site=args.site, verbose=args.verbose)
	ctx.keys = make_users(frappe)
	eps = discover(frappe)
	print(f"{len(eps)} endpoints discovered")
	sections = {
		"gates": lambda: check_gates(ctx, eps),
		"inputs": lambda: check_inputs(ctx, eps),
		"errors": lambda: check_error_hygiene(ctx, eps),
		"record": lambda: check_record_level(ctx, eps, frappe),
		"rest": lambda: check_rest(ctx, frappe),
		"webhook": lambda: check_webhook(ctx, frappe),
		"csrf": lambda: check_csrf(ctx),
	}
	try:
		for name, run in sections.items():
			if args.only and name not in args.only:
				continue
			print(f"== {name}")
			run()
	finally:
		if not args.keep_users:
			frappe.db.rollback()
			drop_users(frappe)
		frappe.destroy()

	failed = [r for r in ctx.results if not r.ok]
	by_section: dict[str, list[int]] = {}
	for r in ctx.results:
		by_section.setdefault(r.section, [0, 0])[0 if r.ok else 1] += 1
	print("\nsection   pass  fail")
	for s, (p, f) in by_section.items():
		print(f"{s:<9} {p:>5} {f:>5}")
	print(f"total     {len(ctx.results) - len(failed):>5} {len(failed):>5}")
	if args.report:
		with open(args.report, "w") as fh:
			json.dump([r.__dict__ for r in ctx.results], fh, ensure_ascii=False, indent=1)
	return 1 if failed else 0


if __name__ == "__main__":
	sys.exit(main())

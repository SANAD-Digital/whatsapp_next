# Module role: the Test Lab backend (page `wa-test-lab`). A manager picks a device and his own
# target numbers, then runs every part of the product for real against them: the health of the
# setup, a quick message, a template over a real document, a notification, an alert, the
# commands and a mini campaign. This module is not a second sending engine — each check calls the
# service the product itself uses (`quick_send`, `notifications_editor`, `alerts_editor`,
# `simulator` / `command_router`, `bulk_send` / `campaign_runner`, `dispatch`) — and only adds
# what a test needs around them: a run with a hard message cap and a minimum pacing enforced
# here, recipients limited to the run's own numbers, `is_test` on every row it creates, an audit
# entry, and a status read that follows the run's messages to their delivery receipts.
#
# A run is not a DocType. While it is being run it lives in the site cache (`RUN_TTL`); what makes
# it history is what it leaves behind anyway: its messages in the WhatsApp Log (marked `is_test`)
# and one audit row for its start and for each of its checks. The cache does not survive a
# `clear-cache` or a migrate, so a run that is no longer there is read back from those audit rows
# — as an archive: its numbers masked, as the audit log keeps them, and nothing can be added to it.

from __future__ import annotations

import time
from typing import Any

import frappe
from frappe import _
from frappe.utils import (
	add_to_date,
	cint,
	date_diff,
	get_datetime,
	now_datetime,
	nowdate,
	time_diff_in_seconds,
)

from whatsapp_next.exceptions import (
	WABlacklistedError,
	WAInvalidPhoneError,
	WANotFoundError,
	WAPermissionError,
	WAValidationError,
)
from whatsapp_next.services import attachments, audit, dispatch, quick_send, simulator
from whatsapp_next.services.devices import default_device
from whatsapp_next.services.dispatch import OutboundSpec
from whatsapp_next.services.phone import classify, mask

KINDS: tuple[str, ...] = (
	"quick_text",
	"quick_image",
	"quick_document",
	"template",
	"notification",
	"alert",
	"command",
	"campaign",
)
QUICK_KINDS = {"quick_text": "text", "quick_image": "image", "quick_document": "document"}

CAP_DEFAULT, CAP_MAX = 20, 50
PACING_DEFAULT, PACING_MIN, PACING_MAX = 8, 3, 60
MAX_TARGETS = 5
SCHEDULE_MIN, SCHEDULE_MAX, SCHEDULE_DEFAULT = 1, 15, 2

RUN_KEY = "wa:testlab:run:{0}"
RUN_TTL = 24 * 3600
HISTORY_MAX = 20
# the audit rows a run is read back from (`summary` of a `Test Send` row)
AUDIT_START = "Test Lab run started"
AUDIT_CHECK = "Test Lab check"

SAMPLE_OWNER = ("WhatsApp Settings", "WhatsApp Settings")
SAMPLES = {"image": "wa-test-lab-sample.png", "document": "wa-test-lab-sample.pdf"}

LOG_FIELDS = [
	"name",
	"status",
	"phone_e164",
	"display_name",
	"device",
	"message_type",
	"source_type",
	"creation",
	"queued_at",
	"scheduled_at",
	"sent_at",
	"delivered_at",
	"read_at",
	"failed_at",
	"error_code",
	"error_message",
	"queue_item",
	"campaign",
	"trigger_inbound",
	"is_test",
]
LOG_DONE = ("Delivered", "Read")
LOG_BROKEN = ("Failed", "Cancelled", "Held")
STALE_QUEUE_MINUTES = 5
# Frappe's scheduler looks for due jobs every four minutes by default (`scheduler_tick_interval`),
# so an every-minute job is healthy when it ran within a few ticks
STALE_SCHEDULER_MINUTES = 15
STALE_WEBHOOK_HOURS = 24


# ---- the page's opening read --------------------------------------------------------------


def context() -> dict[str, Any]:
	"""What the page opens with: `{devices[], default_device, me{phone}, limits{}, templates[],
	notifications[], alerts[], commands[], commands_enabled, samples{}, history[]}` — the "default
	data" of a test, all of it the site's own. Lists are read with the caller's permissions."""
	base = simulator.get_context()
	return {
		"devices": base["devices"],
		"default_device": base["default_device"],
		"me": {"phone": _own_phone(frappe.session.user)},
		"limits": {
			"cap": CAP_DEFAULT,
			"cap_max": CAP_MAX,
			"pacing": PACING_DEFAULT,
			"pacing_min": PACING_MIN,
			"pacing_max": PACING_MAX,
			"max_targets": MAX_TARGETS,
			"schedule_minutes": SCHEDULE_DEFAULT,
			"schedule_min": SCHEDULE_MIN,
			"schedule_max": SCHEDULE_MAX,
		},
		"templates": frappe.get_list(
			"WhatsApp Template",
			filters={"disabled": 0},
			fields=["name", "template_name", "message_type", "category", "reference_doctype", "print_format"],
			order_by="template_name asc",
			limit=200,
		),
		"notifications": frappe.get_list(
			"WhatsApp Notification",
			fields=["name", "enabled", "document_type", "event", "template", "attach_print"],
			order_by="enabled desc, notification_name asc",
			limit=200,
		),
		"alerts": frappe.get_list(
			"WhatsApp Notification Alert",
			fields=["name", "enabled", "content_type", "report", "attachment_format", "periodicity", "next_run_at"],
			order_by="enabled desc, alert_name asc",
			limit=200,
		),
		"commands": base["commands"],
		"commands_enabled": base["commands_enabled"],
		"samples": {kind: {"file_name": name} for kind, name in SAMPLES.items()},
		"history": runs(),
	}


def _own_phone(user: str) -> str | None:
	"""The caller's own mobile — the default target of a test."""
	from whatsapp_next.services.alerts import _user_phone

	return _user_phone(user)


def identify(phones: list[str]) -> list[dict[str, Any]]:
	"""Who each typed number is, for the setup strip: `[{input, valid, phone_e164, name, contact,
	party_type, party, link_status, blacklisted}]`. A command answers a number with its own
	party's records, so the tester sees which party a target stands for before running."""
	out: list[dict[str, Any]] = []
	for raw in list(phones or [])[: MAX_TARGETS * 2]:
		kind, key = classify(str(raw or ""))
		if kind != "Individual":
			out.append({"input": raw, "valid": False, "phone_e164": None})
			continue
		who = simulator.identity(key)
		account = (who.get("accounts") or [None])[0]
		out.append(
			{
				"input": raw,
				"valid": True,
				"phone_e164": key,
				"name": who.get("name"),
				"contact": who.get("contact"),
				"party_type": who.get("party_type"),
				"party": account["title"] if account else None,
				"link_status": who.get("link_status"),
				"blacklisted": bool(dispatch._blacklisted(key)),
			}
		)
	return out


def documents(doctype: str, txt: str | None = None, limit: int = 10) -> dict[str, Any]:
	"""The newest records of `doctype` the caller may read — the "real document" a template or a
	notification is tried on: `{rows[{name, title}], no_access}`."""
	if not doctype or not frappe.db.exists("DocType", doctype) or frappe.get_meta(doctype).istable:
		frappe.throw(_("Unknown document type: {0}").format(doctype), WAValidationError)
	if not frappe.has_permission(doctype, "read"):
		return {"rows": [], "no_access": True}
	meta = frappe.get_meta(doctype)
	title_field = meta.get_title_field() if meta.get_title_field() != "name" else None
	fields = ["name"] + ([f"{title_field} as title"] if title_field else [])
	or_filters = None
	if txt and txt.strip():
		like = f"%{txt.strip()}%"
		or_filters = {"name": ("like", like)}
		if title_field:
			or_filters[title_field] = ("like", like)
	rows = frappe.get_list(
		doctype,
		fields=fields,
		or_filters=or_filters,
		order_by="modified desc",
		limit=max(1, min(cint(limit) or 10, 20)),
	)
	return {"rows": [{"name": r.name, "title": r.get("title") or None} for r in rows], "no_access": False}


def _latest(doctype: str) -> str | None:
	rows = documents(doctype, limit=1)["rows"]
	return rows[0]["name"] if rows else None


# ---- health: is the setup able to send and to hear back -----------------------------------


def _check(key: str, title: str, status: str, detail: str, fix: str | None = None, route: Any = None, route_label: str | None = None) -> dict[str, Any]:
	return {"key": key, "title": title, "status": status, "detail": detail, "fix": fix, "route": route, "route_label": route_label}


def health(device: str | None = None, live: bool = False) -> dict[str, Any]:
	"""The read-only checks a test starts with → `{ok, checks[{key, title, status (ok | warn |
	fail), detail, fix, route, route_label}], checked_at}`. `live` asks the provider now
	(`onboarding.test_connection`, audited); otherwise the last known state is reported and
	nothing leaves the site. Every failing check says what is wrong and what to do about it."""
	if live:
		from whatsapp_next.services import onboarding

		onboarding.test_connection(user=frappe.session.user)
	settings = frappe.get_doc("WhatsApp Settings")
	checks = [
		_credentials_check(settings),
		_subscription_check(settings),
		_webhook_check(settings),
		_webhook_traffic_check(settings),
		_device_check(device),
		_scheduler_check(),
		_workers_check(),
		_queue_check(settings),
		_commands_check(settings),
	]
	return {
		"ok": not any(c["status"] == "fail" for c in checks),
		"checks": checks,
		"checked_at": str(now_datetime()),
		"live": bool(live),
	}


def _credentials_check(settings) -> dict[str, Any]:
	title = _("Platform credentials")
	route, label = "wa-settings", _("Open settings")
	from whatsapp_next.services import secrets

	has_keys = any(secrets.read(f) for f in ("customer_api_key", "api_key"))
	if not has_keys:
		return _check("credentials", title, "fail", _("No API key is saved on this site."), _("Sign in to the platform from the setup wizard, or paste the API key and secret in Settings."), route, label)
	if settings.connection_status == "OK":
		latency = cint(settings.last_connection_latency_ms)
		return _check("credentials", title, "ok", _("The platform accepted the keys ({0} ms).").format(latency) if latency else _("The platform accepted the keys."))
	if settings.connection_status == "Failed":
		return _check(
			"credentials",
			title,
			"fail",
			_("The last connection test failed: {0}").format(settings.last_connection_error or _("no reason given")),
			_("Check the API key and secret in Settings and that the platform address is reachable, then run the checks again."),
			route,
			label,
		)
	return _check("credentials", title, "warn", _("The connection was never tested."), _("Press «Run the checks» to test it now."))


def _subscription_check(settings) -> dict[str, Any]:
	title = _("Subscription and balance")
	route, label = "wa-settings", _("Open subscription")
	status = (settings.subscription_status or "").strip()
	remaining, limit = settings.messages_remaining, cint(settings.message_limit)
	plan = settings.plan_name or settings.plan_code or _("No plan")
	facts = [plan]
	if limit:
		facts.append(_("{0} of {1} messages left").format(cint(remaining), limit))
	days = date_diff(settings.subscription_end, nowdate()) if settings.subscription_end else None
	if settings.subscription_end:
		facts.append(_("ends {0}").format(frappe.format(settings.subscription_end, {"fieldtype": "Date"})))
	detail = " · ".join(facts)
	if not status and not settings.subscription_synced_at:
		return _check("subscription", title, "warn", _("The subscription was never read from the platform."), _("Press «Run the checks» to read it now."), route, label)
	if status.lower() in ("expired", "inactive", "cancelled", "suspended") or (days is not None and days < 0):
		return _check("subscription", title, "fail", detail, _("The subscription is not active, so the platform refuses every message. Renew it from the subscription screen."), route, label)
	if limit and cint(remaining) <= 0:
		return _check("subscription", title, "fail", detail, _("The plan's messages are used up, so nothing more is sent this period. Upgrade the plan or wait for the renewal."), route, label)
	if (limit and cint(remaining) < CAP_DEFAULT) or (days is not None and days <= 3):
		return _check("subscription", title, "warn", detail, _("Little is left on the plan: a full test run may use it up."), route, label)
	return _check("subscription", title, "ok", detail)


def _webhook_check(settings) -> dict[str, Any]:
	title = _("Webhook endpoint")
	route, label = "wa-settings", _("Open webhook settings")
	if not settings.webhook_endpoint:
		return _check("webhook", title, "fail", _("No webhook is registered on the platform for this site."), _("Without it the site never hears about deliveries, read receipts or incoming messages. Open Settings › Webhook and press «Set up»."), route, label)
	if settings.webhook_status != "Active":
		return _check(
			"webhook",
			title,
			"fail",
			_("The webhook is registered but its state is «{0}».").format(_(settings.webhook_status or "Unknown")),
			_("The platform is not calling this site. Switch the webhook back on in Settings › Webhook."),
			route,
			label,
		)
	return _check("webhook", title, "ok", _("Registered and active."))


def _webhook_traffic_check(settings) -> dict[str, Any]:
	title = _("Last event received")
	at = settings.webhook_last_event_at
	if not at:
		return _check("webhook_traffic", title, "warn", _("No event has ever arrived from the platform."), _("Send one test message below: its delivery receipt is the proof that the way back works."))
	hours = time_diff_in_seconds(now_datetime(), get_datetime(at)) / 3600
	when = frappe.utils.pretty_date(at)
	if hours > STALE_WEBHOOK_HOURS:
		return _check("webhook_traffic", title, "warn", _("The last event arrived {0}.").format(when), _("Nothing was heard for more than a day. Send one test message below and watch for its delivery receipt."))
	return _check("webhook_traffic", title, "ok", _("The last event arrived {0}.").format(when))


def _events_arrive() -> bool:
	"""The platform's events reached this site within the last day. The device's own
	`webhook_registered` flag is mirrored from whatever state the platform last sent and reads 0
	after a bare connection event, so it is only believed when nothing is arriving either."""
	at = frappe.db.get_single_value("WhatsApp Settings", "webhook_last_event_at")
	return bool(at) and time_diff_in_seconds(now_datetime(), get_datetime(at)) < STALE_WEBHOOK_HOURS * 3600


def _device_check(device: str | None) -> dict[str, Any]:
	title = _("Sending device")
	route, label = "wa-devices", _("Open devices")
	device = device or default_device()
	row = frappe.db.get_value("WhatsApp Device", device, ["name", "device_name", "status", "disabled", "webhook_registered", "phone_e164"], as_dict=True) if device else None
	if not row:
		return _check("device", title, "fail", _("No device is set up on this site."), _("Pair a phone from the Devices screen."), route, label)
	name = row.device_name or row.name
	if cint(row.disabled):
		return _check("device", title, "fail", _("{0} is switched off.").format(name), _("Switch the device on from the Devices screen."), route, label)
	if row.status != "Connected":
		return _check(
			"device",
			title,
			"fail",
			_("{0} is not connected ({1}).").format(name, _(row.status)),
			_("Messages wait in the queue until the phone is linked again. Open Devices and scan the QR code from the phone."),
			route,
			label,
		)
	if not cint(row.webhook_registered) and not _events_arrive():
		return _check(
			"device",
			title,
			"warn",
			_("{0} is connected, but its events are not registered.").format(name),
			_("Delivery receipts of this device may not arrive. Open Settings › Webhook and press «Set up»."),
			"wa-settings",
			_("Open webhook settings"),
		)
	return _check("device", title, "ok", _("{0} is connected.").format(name))


def _scheduler_check() -> dict[str, Any]:
	"""The scheduler is what sends alerts on time, promotes scheduled campaigns, retries the queue
	and reconciles statuses. A disabled scheduler stops all of it without a single error."""
	from frappe.utils.scheduler import is_scheduler_inactive

	title = _("Scheduler")
	fix_cmd = f"bench --site {frappe.local.site} enable-scheduler"
	if is_scheduler_inactive():
		return _check(
			"scheduler",
			title,
			"fail",
			_("The scheduler is disabled on this site."),
			_("Scheduled alerts, scheduled campaigns, delayed notifications and queue retries all stop silently while it is off. Ask the system administrator to run: {0}").format(fix_cmd),
		)
	last = frappe.db.get_value("Scheduled Job Type", {"method": "whatsapp_next.services.dispatch.dispatch_tick"}, ["last_execution", "stopped"], as_dict=True)
	if last and cint(last.stopped):
		return _check("scheduler", title, "fail", _("The sending job of this app is stopped."), _("Open «Scheduled Job Type», find dispatch_tick and clear «Stopped»."), ["List", "Scheduled Job Type", {"method": ("like", "%whatsapp_next%")}], _("Open scheduled jobs"))
	if not last or not last.last_execution:
		return _check("scheduler", title, "warn", _("The scheduler is enabled, but this app's every-minute job has not run yet."), _("If this stays so for more than a few minutes the scheduler process is not running: ask the system administrator to check `bench doctor`."))
	minutes = time_diff_in_seconds(now_datetime(), get_datetime(last.last_execution)) / 60
	if minutes > STALE_SCHEDULER_MINUTES:
		return _check(
			"scheduler",
			title,
			"fail",
			_("The scheduler is enabled, but its every-minute job last ran {0}.").format(frappe.utils.pretty_date(last.last_execution)),
			_("The scheduler process is not running, so alerts and scheduled campaigns are late. Ask the system administrator to restart the bench and check `bench doctor`."),
		)
	return _check("scheduler", title, "ok", _("Enabled — the every-minute job last ran {0}.").format(frappe.utils.pretty_date(last.last_execution)))


def _workers_check() -> dict[str, Any]:
	title = _("Background workers")
	fix = _("Messages are sent by background workers. Ask the system administrator to restart the bench (`bench restart`) and check `bench doctor`.")
	try:
		from frappe.utils.background_jobs import get_queue, get_workers

		workers = get_workers()
		served = {name.rsplit(":", 1)[-1] for w in workers for name in w.queue_names()}
		waiting = {q: get_queue(q).count for q in ("short", "long")}
	except Exception:
		return _check("workers", title, "fail", _("The job queue (Redis) cannot be reached."), fix)
	if not workers:
		return _check("workers", title, "fail", _("No background worker is running."), fix)
	missing = [q for q in ("short", "long", "default") if q not in served]
	if missing:
		return _check("workers", title, "fail", _("No worker serves the queue: {0}.").format(", ".join(missing)), fix)
	backlog = sum(waiting.values())
	if backlog > 50:
		return _check("workers", title, "warn", _("{0} workers are running, {1} jobs are waiting.").format(len(workers), backlog), _("The workers are busy: messages may leave late."))
	return _check("workers", title, "ok", _("{0} workers are running.").format(len(workers)))


def _queue_check(settings) -> dict[str, Any]:
	title = _("Sending queue")
	route, label = ["List", "WhatsApp Queue Item"], _("Open the queue")
	if cint(settings.queue_paused):
		who = frappe.utils.get_fullname(settings.queue_paused_by) if settings.queue_paused_by else None
		return _check(
			"queue",
			title,
			"fail",
			_("Sending is paused by {0}.").format(who) if who else _("Sending is paused."),
			_("Every message waits until the queue is resumed. Open the queue and press «Resume»."),
			route,
			label,
		)
	stale = frappe.db.count(
		"WhatsApp Queue Item",
		{"status": "Queued", "scheduled_at": ("<", add_to_date(now_datetime(), minutes=-STALE_QUEUE_MINUTES))},
	)
	dead = frappe.db.count("WhatsApp Queue Item", {"status": "Dead Letter"})
	if stale:
		return _check("queue", title, "warn", _("{0} messages have been waiting for more than {1} minutes.").format(stale, STALE_QUEUE_MINUTES), _("They wait for a connected device, a free slot in the rate, or a paused campaign. Open the queue to see which."), route, label)
	if dead:
		return _check("queue", title, "warn", _("The queue is running. {0} messages gave up after their retries.").format(dead), _("Open the queue, read the reason and retry them."), route, label)
	return _check("queue", title, "ok", _("Running at {0} messages a minute.").format(cint(settings.messages_per_minute) or "—"))


def _commands_check(settings) -> dict[str, Any]:
	title = _("Commands")
	route, label = "wa-settings", _("Open settings")
	active = frappe.db.count("WhatsApp Command", {"status": "Active"})
	if not cint(settings.enable_commands):
		return _check("commands", title, "warn", _("Commands are switched off."), _("Incoming messages are stored but never answered. Switch commands on in Settings."), route, label)
	if not settings.command_service_user:
		return _check("commands", title, "warn", _("No service user is set for commands."), _("Commands read the system as that user. Pick one in Settings › Commands."), route, label)
	if not active:
		return _check("commands", title, "warn", _("Commands are on, but no command is active."), _("Activate a command from the Commands list."), ["List", "WhatsApp Command"], _("Open commands"))
	return _check("commands", title, "ok", _("On — {0} active commands.").format(active))


# ---- the run: cap, pacing and recipients are enforced here --------------------------------


def _save(run: dict[str, Any]) -> None:
	frappe.cache.set_value(RUN_KEY.format(run["id"]), run, expires_in_sec=RUN_TTL)


def _load(run: str, *, own: bool = False) -> dict[str, Any]:
	"""The run: the live copy from the cache, else its archive from the audit log. `own` is the
	gate of `run_check`: only a live run, and only the user who started it."""
	data = frappe.cache.get_value(RUN_KEY.format(run or "")) or (None if own else _archived(run))
	if not data:
		frappe.throw(_("This test run is no longer available. Start a new run."), WANotFoundError)
	if own and data["user"] != frappe.session.user:
		frappe.throw(_("Only the user who started a test run can add to it."), WAPermissionError)
	return data


def _audit_rows(run: str | None = None, summary: str | None = None, limit: int | None = None) -> list[dict[str, Any]]:
	filters: dict[str, Any] = {"action": "Test Send", "summary": summary or ("in", [AUDIT_START, AUDIT_CHECK])}
	if run:
		# the run's id inside the JSON the audit row keeps
		filters["details"] = ("like", f'%"run": "{run}"%')
	return frappe.get_all(
		"WhatsApp Audit Log",
		filters=filters,
		fields=["name", "user", "timestamp", "summary", "details"],
		order_by="timestamp desc, creation desc" if limit else "timestamp asc, creation asc",
		limit=limit,
	)


def _archived(run: str | None) -> dict[str, Any] | None:
	"""A run rebuilt from its audit rows (numbers masked there), or None when it never was."""
	if not run or not str(run).isalnum():
		return None
	data: dict[str, Any] | None = None
	steps: list[dict[str, Any]] = []
	for row in _audit_rows(run):
		details = frappe.parse_json(row.details or "{}")
		if details.get("run") != run:
			continue
		if row.summary == AUDIT_START:
			data = {
				"id": run,
				"user": row.user,
				"device": details.get("device"),
				"targets": details["targets"] if isinstance(details.get("targets"), list) else [],
				"cap": cint(details.get("cap")),
				"pacing": cint(details.get("pacing")),
				"started_at": str(row.timestamp),
				"last_send": 0.0,
				"used": 0,
				"archived": True,
			}
		elif details.get("step"):
			steps.append({"result": {}, "outbounds": [], "real": [], "campaign": None, "error": None, **details["step"]})
	if data is None:
		return None
	data["steps"] = sorted(steps, key=lambda s: cint(s.get("idx")))
	data["used"] = sum(cint(s.get("count")) for s in data["steps"] if not s.get("dry"))
	return data


def _audit_step(data: dict[str, Any], step: dict[str, Any], user: str) -> None:
	"""One audit row per check: the record of who tested what, and the run's durable copy. It
	keeps what the check made (the Log rows, the campaign) and its verdict — never a reply's text
	or a rendered message, which stay in the Log under its own permissions."""
	result = step.get("result") or {}
	kept = {k: result[k] for k in ("status", "command", "block_reason", "function_ms", "reference_name", "real_recipients", "scheduled_at", "schedule_minutes", "recipients") if result.get(k) not in (None, "")}
	if result.get("readiness"):
		kept["readiness"] = result["readiness"]
	reference = None
	if step.get("campaign"):
		reference = ("WhatsApp Campaign", step["campaign"])
	elif step.get("outbounds") or step.get("real"):
		reference = ("WhatsApp Log", (step.get("outbounds") or step.get("real"))[0])
	audit.log(
		"Test Send",
		reference=reference,
		summary=AUDIT_CHECK,
		user=user,
		count=cint(step.get("count")) or None,
		details={
			"run": data["id"],
			"step": {
				"idx": step["idx"],
				"kind": step["kind"],
				"label": step.get("label"),
				"to": step.get("target"),
				"at": step["at"],
				"dry": step["dry"],
				"ok": step["ok"],
				"error": step.get("error"),
				"outbounds": step.get("outbounds") or [],
				"real": step.get("real") or [],
				"campaign": step.get("campaign"),
				"count": cint(step.get("count")),
				"result": kept,
			},
		},
	)


def _clamp(value: Any, default: int, low: int, high: int) -> int:
	return max(low, min(cint(value) or default, high))


def normalize_targets(targets: list[str]) -> list[str]:
	"""The run's recipients as distinct E.164 numbers. Individual numbers only (a group is not a
	test target), none of them blacklisted, at most `MAX_TARGETS`."""
	out: list[str] = []
	for raw in targets or []:
		kind, key = classify(str(raw or ""))
		if kind != "Individual":
			frappe.throw(_("Invalid WhatsApp number: {0}").format(raw), WAInvalidPhoneError)
		if dispatch._blacklisted(key):
			frappe.throw(_("{0} is on the blacklist and cannot be a test target.").format(key), WABlacklistedError)
		if key not in out:
			out.append(key)
	if not out:
		frappe.throw(_("Add at least one target number."), WAValidationError)
	if len(out) > MAX_TARGETS:
		frappe.throw(_("A test run takes at most {0} target numbers.").format(MAX_TARGETS), WAValidationError)
	return out


def start_run(device: str, targets: list[str], cap: int | None = None, pacing: int | None = None, user: str | None = None) -> dict[str, Any]:
	"""Open a run: `{id, device, targets[], cap, pacing, started_at}`. Every later `run_check`
	names it, and may only write to these numbers, at most `cap` messages, `pacing` seconds apart.
	Audited `Test Send`."""
	row = frappe.db.get_value("WhatsApp Device", device, ["name", "disabled"], as_dict=True) if device else None
	if not row:
		frappe.throw(_("Pick a sending device"), WAValidationError)
	if cint(row.disabled):
		frappe.throw(_("This device is switched off."), WAValidationError)
	run = {
		"id": frappe.generate_hash(length=10),
		"user": user or frappe.session.user,
		"device": row.name,
		"targets": normalize_targets(targets),
		"cap": _clamp(cap, CAP_DEFAULT, 1, CAP_MAX),
		"pacing": _clamp(pacing, PACING_DEFAULT, PACING_MIN, PACING_MAX),
		"started_at": str(now_datetime()),
		"last_send": 0.0,
		"used": 0,
		"steps": [],
	}
	_save(run)
	audit.log(
		"Test Send",
		reference=("WhatsApp Device", row.name),
		summary=AUDIT_START,
		user=run["user"],
		# the numbers are masked by the audit log itself
		details={"run": run["id"], "device": run["device"], "targets": list(run["targets"]), "cap": run["cap"], "pacing": run["pacing"]},
	)
	return _public(run)


def _public(run: dict[str, Any]) -> dict[str, Any]:
	return {**{k: run[k] for k in ("id", "user", "device", "targets", "cap", "pacing", "started_at", "used")}, "archived": bool(run.get("archived"))}


def run_check(run: str, kind: str, target: str | None = None, params: dict | None = None, user: str | None = None) -> dict[str, Any]:
	"""Run one check of the run → the recorded step `{idx, kind, target, label, at, dry, ok, error,
	outbounds[], campaign, count, result{}}`, or `{wait: seconds}` when the run's pacing says the
	next message may not leave yet (nothing is done; ask again after that long).

	Guards raise: an unknown run, a run of another user, a target outside the run, the cap. A
	check that the product itself refuses (a blacklisted number, an empty template, a report that
	cannot run) is not raised: it is recorded as a failed step with its reason, which is what a
	test is for."""
	data = _load(run, own=True)
	if kind not in KINDS:
		frappe.throw(_("Unknown check: {0}").format(kind), WAValidationError)
	params = dict(params or {})
	if kind != "campaign":
		kind_of, key = classify(str(target or ""))
		if kind_of != "Individual" or key not in data["targets"]:
			frappe.throw(_("A test may only write to the run's own target numbers."), WAPermissionError)
		target = key
	else:
		target = None
	sends = kind != "command" or bool(params.get("send_reply"))
	need = len(data["targets"]) if kind == "campaign" else 1
	if sends:
		left = data["cap"] - data["used"]
		if left < need:
			frappe.throw(_("The run's cap of {0} messages is reached. Start a new run to send more.").format(data["cap"]), WAValidationError)
		wait = data["pacing"] - (time.time() - data["last_send"])
		if wait > 0:
			return {"wait": round(wait, 1)}
	step: dict[str, Any] = {
		"idx": len(data["steps"]) + 1,
		"kind": kind,
		"target": target,
		"label": params.get("label") or None,
		"at": str(now_datetime()),
		"dry": not sends,
		"ok": True,
		"error": None,
		"outbounds": [],
		"campaign": None,
		"count": 0,
		"result": {},
	}
	queued = len(frappe.local.message_log or [])
	frappe.db.savepoint("wa_testlab_step")
	try:
		step.update(_HANDLERS[kind](data, target, params, user or frappe.session.user))
	except Exception as exc:
		frappe.db.rollback(save_point="wa_testlab_step")
		step.update(ok=False, error=_reason(exc))
		if not isinstance(exc, frappe.ValidationError | frappe.PermissionError):
			frappe.log_error(title="WhatsApp Test Lab: check failed", message=f"kind={kind} {type(exc).__name__}\n{frappe.get_traceback()}")
	finally:
		# a refusal is the step's own result: it must not also pop up as a Desk message
		if frappe.local.message_log:
			del frappe.local.message_log[queued:]
	count = cint(step.get("count")) or len(step["outbounds"])
	step["count"] = count
	if step["outbounds"]:
		_mark_test(step["outbounds"])
	if sends and count:
		data["used"] += count
		# a step of several messages (a campaign) holds the next check back until its own pacing is spent
		data["last_send"] = time.time() + max(0, count - 1) * data["pacing"]
	data["steps"].append(step)
	_save(data)
	_audit_step(data, step, user or frappe.session.user)
	return step


def _reason(exc: Exception) -> str:
	text = frappe.utils.strip_html(str(exc) or "").strip()
	return (text or type(exc).__name__)[:400]


def _mark_test(names: list[str]) -> None:
	"""`is_test` on rows a product service created without it (a notification's or an alert's
	test, a campaign's messages), so a test is told apart from real traffic everywhere."""
	if names:
		frappe.db.set_value("WhatsApp Log", {"name": ("in", names), "is_test": 0}, "is_test", 1, update_modified=False)


# ---- the checks: each one is the product's own path ---------------------------------------


def sample_file(kind: str) -> str:
	"""The app's own sample image / document as a private File (created once, then reused)."""
	import os

	file_name = SAMPLES[kind]
	url = frappe.db.get_value(
		"File",
		{"file_name": file_name, "attached_to_doctype": SAMPLE_OWNER[0], "attached_to_name": SAMPLE_OWNER[1]},
		"file_url",
	)
	if url:
		return url
	# joined by hand: `get_app_path` scrubs every part it is given, and would rename the file
	path = os.path.join(frappe.get_app_path("whatsapp_next"), "whatsapp_next", "page", "wa_test_lab", "samples", file_name)
	if not os.path.exists(path):
		frappe.throw(_("The sample file {0} is missing from the app.").format(file_name), WAValidationError)
	with open(path, "rb") as fh:
		return attachments.save_private_file(fh.read(), file_name, SAMPLE_OWNER)


def _quick(data: dict, target: str, params: dict, user: str, *, kind: str) -> dict[str, Any]:
	"""A quick send (`quick_send.compose`, priority 1): text, or the sample / a picked file."""
	body = (params.get("body") or "").strip() or _("Test Lab · test message")
	attachment = None
	if kind != "text":
		attachment = params.get("attachment") or sample_file(kind)
	parts = attachments.message_parts(kind, body=body, attachment=attachment)
	spec = OutboundSpec(device=data["device"], phone=target, source_type="Quick Send", is_test=True, skip_policy=True, **parts)
	outbound, _item = quick_send.compose(spec, user=user)
	return {"outbounds": [outbound], "result": {"message": body, "file_name": parts.get("file_name")}}


def _template_row(name: str | None):
	if not name:
		frappe.throw(_("Pick a template"), WAValidationError)
	frappe.has_permission("WhatsApp Template", "read", name, throw=True)
	row = frappe.db.get_value(
		"WhatsApp Template",
		name,
		["name", "message_type", "reference_doctype", "print_format", "letter_head", "attachment", "file_name_template", "language", "disabled"],
		as_dict=True,
	)
	if not row:
		frappe.throw(_("WhatsApp Template {0} not found").format(name), WANotFoundError)
	return row


def _reference(doctype: str | None, name: str | None) -> str | None:
	"""The record a check renders: the one asked for, else the newest the caller may read."""
	if not doctype:
		return None
	name = name or _latest(doctype)
	if not name:
		return None
	if not frappe.db.exists(doctype, name):
		frappe.throw(_("{0} {1} not found").format(_(doctype), name), WANotFoundError)
	frappe.has_permission(doctype, "read", name, throw=True)
	return name


def _template_attachment(tpl, reference: str | None) -> dict[str, Any]:
	"""What a template carries besides its text: a print of the record, or its own file."""
	if tpl.message_type == "Text":
		return {"message_type": "Text"}
	if tpl.print_format and tpl.reference_doctype and reference:
		frappe.has_permission(tpl.reference_doctype, "print", reference, throw=True)
		from whatsapp_next.services import templates

		pdf = attachments.render_print_pdf(
			tpl.reference_doctype,
			reference,
			print_format=tpl.print_format,
			letter_head=tpl.letter_head or None,
			language=tpl.language or None,
			file_name=templates.render_text(tpl.file_name_template, {"doc": frappe._dict(name=reference)}, fallback=reference),
		)
		url = attachments.save_private_file(pdf.content, pdf.file_name, (tpl.reference_doctype, reference))
		return {"message_type": "Document", "attachment": url, "file_name": pdf.file_name, "mime_type": pdf.mime_type}
	if tpl.attachment:
		return {"message_type": tpl.message_type, "attachment": tpl.attachment}
	frappe.throw(_("This template sends a file but has neither a print format with a record nor an attachment."), WAValidationError)


def _template(data: dict, target: str, params: dict, user: str) -> dict[str, Any]:
	"""A template over a real record, sent like a quick send from that record's form."""
	tpl = _template_row(params.get("template"))
	reference = _reference(tpl.reference_doctype, params.get("reference_name"))
	attach = _template_attachment(tpl, reference)
	caption = None
	if attach["message_type"] != "Text":
		# a file's text is its caption: rendered the way the send renders a body
		caption = quick_send.preview(template=tpl.name, reference_doctype=tpl.reference_doctype if reference else None, reference_name=reference, phone=target)["body"] or None
	spec = OutboundSpec(
		device=data["device"],
		phone=target,
		template=tpl.name,
		caption=caption,
		reference_doctype=tpl.reference_doctype if reference else None,
		reference_name=reference,
		language=tpl.language or None,
		source_type="Quick Send",
		is_test=True,
		skip_policy=True,
		**attach,
	)
	outbound, _item = quick_send.compose(spec, user=user)
	return {"outbounds": [outbound], "result": {"reference_name": reference, "file_name": attach.get("file_name")}}


def _notification(data: dict, target: str, params: dict, user: str) -> dict[str, Any]:
	"""A notification over a real record: to the run's target (`notifications_editor.send_test`),
	or — only when explicitly confirmed — to the record's real recipients (`send_for_document`)."""
	from whatsapp_next.services import notifications, notifications_editor

	name = params.get("notification")
	if not name:
		frappe.throw(_("Pick a notification"), WAValidationError)
	frappe.has_permission("WhatsApp Notification", "read", name, throw=True)
	document_type = frappe.db.get_value("WhatsApp Notification", name, "document_type")
	reference = _reference(document_type, params.get("reference_name"))
	if not reference:
		frappe.throw(_("There is no {0} to try the notification on yet").format(_(document_type)), WAValidationError)
	if not params.get("real_recipients"):
		r = notifications_editor.send_test({"name": name}, target, reference)
		return {"outbounds": [r["outbound"]], "result": {"reference_name": reference}}
	if not params.get("confirm_real"):
		frappe.throw(_("Sending to the real recipients must be confirmed."), WAValidationError)
	expected = len(notifications.preview_for_document(name, reference)["recipients"])
	if expected > data["cap"] - data["used"]:
		frappe.throw(_("This notification reaches {0} recipients, more than the run has left.").format(expected), WAValidationError)
	r = notifications.send_for_document(name, document_type, reference, doc_event="Manual")
	if not r.get("sent"):
		frappe.throw(
			_("Nothing was sent: {0}").format(r.get("error") or _("the notification is disabled, or its condition does not hold for this record")),
			WAValidationError,
		)
	# real customer traffic: counted against the cap, but not marked as a test
	return {"real": r.get("outbounds") or [], "count": r["sent"], "result": {"reference_name": reference, "real_recipients": True}}


def _alert(data: dict, target: str, params: dict, user: str) -> dict[str, Any]:
	"""A scheduled alert, run now and sent to the run's target only (`alerts_editor.send_test`)."""
	from whatsapp_next.services import alerts_editor

	name = params.get("alert")
	if not name:
		frappe.throw(_("Pick an alert"), WAValidationError)
	frappe.has_permission("WhatsApp Notification Alert", "read", name, throw=True)
	r = alerts_editor.send_test({"name": name}, target)
	if not r.get("outbound"):
		frappe.throw(_("The alert had nothing to send."), WAValidationError)
	return {"outbounds": [r["outbound"]]}


def _command(data: dict, target: str, params: dict, user: str) -> dict[str, Any]:
	"""A command as the target number would get it. A dry run by default (`command_router` over an
	in-memory message: nothing stored, nothing sent); with `send_reply` the replies are produced
	the way the Simulator's "message on behalf" produces them and then really sent to the target."""
	text = (params.get("text") or "").strip()
	if not text:
		frappe.throw(_("Message text is required"), WAValidationError)
	if not params.get("send_reply"):
		res = simulator.dry_run_command(text, target, data["device"])
		return {"ok": res["status"] == "Executed", "error": res.get("error"), "result": _command_result(res)}
	sim = simulator.simulate_inbound(data["device"], target, text, run_commands=True, persist=True, user=user)
	res = {
		"status": sim.status,
		"command": sim.command,
		"block_reason": sim.block_reason,
		"args": sim.args,
		"replies": sim.replies,
		"error": sim.error,
		"function_ms": sim.elapsed_ms,
	}
	if len(sim.outbound) > data["cap"] - data["used"]:
		frappe.throw(_("This command answers with {0} messages, more than the run has left.").format(len(sim.outbound)), WAValidationError)
	outbounds: list[str] = []
	now = now_datetime()
	for i, name in enumerate(sim.outbound):
		row = frappe.db.get_value("WhatsApp Log", name, ["message_type", "body", "caption", "attachment", "file_name", "mime_type", "command"], as_dict=True)
		spec = OutboundSpec(
			device=data["device"],
			phone=target,
			source_type="Simulator",
			is_test=True,
			skip_policy=True,
			# the replies leave one pacing apart, like every other message of the run
			scheduled_at=add_to_date(now, seconds=i * data["pacing"]) if i else None,
			**row,
		)
		outbound, _item = dispatch.create_and_enqueue(spec, user=user, priority=1)
		outbounds.append(outbound)
	return {
		"outbounds": outbounds,
		"ok": sim.status == "Executed" and bool(outbounds),
		"error": sim.error or (None if outbounds else _("The command produced no reply to send.")),
		"result": _command_result(res),
	}


def _command_result(res: dict[str, Any]) -> dict[str, Any]:
	return {
		"status": res.get("status"),
		"command": res.get("command"),
		"block_reason": res.get("block_reason"),
		"args": res.get("args") or {},
		"function_ms": cint(res.get("function_ms")),
		"replies": [
			{"message_type": r.get("message_type"), "body": r.get("body"), "file_name": r.get("file_name"), "output_key": r.get("output_key")}
			for r in res.get("replies") or []
		],
	}


def _campaign(data: dict, target: None, params: dict, user: str) -> dict[str, Any]:
	"""A mini campaign to the run's targets through the bulk-send path (`bulk_send.send` →
	`campaign_runner.start` / `.schedule`), with the readiness the campaign screen would show."""
	from whatsapp_next.services import bulk_send, campaign_runner
	from whatsapp_next.whatsapp_next.doctype.whatsapp_campaign.whatsapp_campaign import settings_rate_limit

	rate = max(1, 60 // data["pacing"])
	limit = settings_rate_limit()
	payload: dict[str, Any] = {"numbers": list(data["targets"]), "device": data["device"], "rate": min(rate, limit) if limit else rate}
	body = (params.get("body") or "").strip()
	if params.get("template"):
		payload["template"] = _template_row(params["template"]).name
	elif params.get("with_image"):
		payload.update(kind="image", attachment=params.get("attachment") or sample_file("image"), body=body or _("Test Lab · test campaign"))
	else:
		payload["body"] = body or _("Test Lab · test campaign")
	minutes = None
	if params.get("scheduled"):
		minutes = _clamp(params.get("schedule_minutes"), SCHEDULE_DEFAULT, SCHEDULE_MIN, SCHEDULE_MAX)
		payload["scheduled_at"] = str(add_to_date(now_datetime(), minutes=minutes))
	r = bulk_send.send(payload, user=user)
	frappe.db.set_value(
		"WhatsApp Campaign",
		r["campaign"],
		{
			"campaign_name": _("Test Lab · {0}").format(frappe.utils.format_datetime(now_datetime(), "dd-MM-yyyy HH:mm")),
			"description": _("A test campaign created by the Test Lab."),
		},
		update_modified=False,
	)
	readiness = campaign_runner.readiness(r["campaign"])
	return {
		"campaign": r["campaign"],
		"count": cint(r["recipients"]),
		"result": {
			"status": r["status"],
			"recipients": cint(r["recipients"]),
			"excluded": cint(r["excluded"]),
			"invalid": cint(r["invalid"]),
			"scheduled_at": payload.get("scheduled_at"),
			"schedule_minutes": minutes,
			"readiness": {"ok": readiness["ok"], "checks": [{"key": c["key"], "ok": c["ok"]} for c in readiness["checks"]]},
		},
	}


_HANDLERS = {
	"quick_text": lambda d, t, p, u: _quick(d, t, p, u, kind="text"),
	"quick_image": lambda d, t, p, u: _quick(d, t, p, u, kind="image"),
	"quick_document": lambda d, t, p, u: _quick(d, t, p, u, kind="document"),
	"template": _template,
	"notification": _notification,
	"alert": _alert,
	"command": _command,
	"campaign": _campaign,
}


# ---- previews: what a check would send, without sending -----------------------------------


def preview(kind: str, params: dict | None = None, target: str | None = None) -> dict[str, Any]:
	"""What a check would send, nothing sent → per kind:
	`template` `{message, errors[], reference_name, attachment}` · `notification`
	(`notifications_editor.preview`: condition, message, masked recipients) · `alert`
	(`alerts_editor.preview`: rows, message, attachment, recipients count) · `campaign`
	`{total, excluded, invalid}` for `params.numbers`."""
	params = dict(params or {})
	if kind == "template":
		tpl = _template_row(params.get("template"))
		reference = _reference(tpl.reference_doctype, params.get("reference_name"))
		r = quick_send.preview(template=tpl.name, reference_doctype=tpl.reference_doctype if reference else None, reference_name=reference, phone=target or None)
		carries = None
		if tpl.message_type != "Text":
			carries = {"message_type": tpl.message_type, "print_format": tpl.print_format, "file": bool(tpl.attachment)}
		return {"message": r["body"], "errors": r["errors"], "reference_doctype": tpl.reference_doctype, "reference_name": reference, "attachment": carries}
	if kind == "notification":
		from whatsapp_next.services import notifications_editor

		if not params.get("notification"):
			frappe.throw(_("Pick a notification"), WAValidationError)
		frappe.has_permission("WhatsApp Notification", "read", params["notification"], throw=True)
		return notifications_editor.preview({"name": params["notification"]}, params.get("reference_name") or None)
	if kind == "alert":
		from whatsapp_next.services import alerts_editor

		if not params.get("alert"):
			frappe.throw(_("Pick an alert"), WAValidationError)
		frappe.has_permission("WhatsApp Notification Alert", "read", params["alert"], throw=True)
		r = alerts_editor.preview({"name": params["alert"]})
		# who the alert really reaches stays a count here: the test goes to the run's target only
		r["recipients"] = [{"phone_e164": mask(x.get("phone_e164")), "source": x.get("source")} for x in (r.get("recipients") or [])[:20]]
		return r
	if kind == "campaign":
		from whatsapp_next.services import bulk_send

		return bulk_send.estimate(numbers=list(params.get("numbers") or []))
	frappe.throw(_("Unknown check: {0}").format(kind), WAValidationError)


# ---- following a run to its receipts ------------------------------------------------------


def _seconds(start, end) -> float | None:
	if not start or not end:
		return None
	return max(0.0, round(time_diff_in_seconds(get_datetime(end), get_datetime(start)), 1))


def _step_state(step: dict[str, Any], logs: list[dict[str, Any]], campaign: dict[str, Any] | None) -> str:
	"""One word for a step: failed · blocked · passed (a dry run that worked) · scheduled ·
	running · sent · delivered · read."""
	if step.get("error") and not logs:
		return "failed"
	if step["dry"]:
		if (step.get("result") or {}).get("status") == "Blocked":
			return "blocked"
		return "passed" if step["ok"] else "failed"
	if not step["ok"] and not logs:
		return "failed"
	if campaign and campaign["status"] == "Scheduled":
		return "scheduled"
	if campaign and campaign["status"] == "Cancelled":
		return "failed"
	if not logs:
		return "running"
	statuses = [r["status"] for r in logs]
	if any(s in LOG_BROKEN for s in statuses):
		return "failed"
	if all(s == "Read" for s in statuses):
		return "read"
	if all(s in LOG_DONE for s in statuses):
		return "delivered"
	if all(s in ("Sent", *LOG_DONE) for s in statuses):
		return "sent"
	return "running"


def status(run: str) -> dict[str, Any]:
	"""Where the run stands now → `{run{}, steps[{…step, state, messages[{name, status, phone_e164,
	…times, error_code, error_message, send_seconds, deliver_seconds, queue_item}], campaign{}}],
	summary{}, receipts{}, inbound[], webhook_last_event_at, finished}`. Read by any manager; the
	messages a test campaign has produced since the last read are marked `is_test` here."""
	data = _load(run)
	campaigns = [s["campaign"] for s in data["steps"] if s.get("campaign")]
	if campaigns:
		_mark_test(frappe.get_all("WhatsApp Log", filters={"campaign": ("in", campaigns), "is_test": 0}, pluck="name"))
	names = [n for s in data["steps"] for n in (s.get("outbounds") or []) + (s.get("real") or [])]
	logs: dict[str, dict[str, Any]] = {}
	by_campaign: dict[str, list[dict[str, Any]]] = {}
	filters: list[dict[str, Any]] = []
	if names:
		filters.append({"name": ("in", names)})
	if campaigns:
		filters.append({"campaign": ("in", campaigns)})
	for f in filters:
		for row in frappe.get_all("WhatsApp Log", filters=f, fields=LOG_FIELDS, order_by="creation asc"):
			row["send_seconds"] = _seconds(row.creation, row.sent_at)
			# from the press too: the platform stamps a receipt to the second, so "sent → delivered"
			# would read as zero; and never less than the time it took to leave
			arrived = _seconds(row.creation, row.delivered_at or row.read_at)
			row["deliver_seconds"] = max(arrived, row["send_seconds"] or 0.0) if arrived is not None else None
			logs[row.name] = row
			if row.campaign and row.campaign in campaigns:
				by_campaign.setdefault(row.campaign, []).append(row)
	campaign_rows = {
		c.name: c
		for c in (
			frappe.get_all(
				"WhatsApp Campaign",
				filters={"name": ("in", campaigns)},
				fields=["name", "campaign_name", "status", "scheduled_at", "total_recipients", "sent_count", "delivered_count", "read_count", "failed_count", "started_at", "ended_at"],
			)
			if campaigns
			else []
		)
	}
	steps = []
	for s in data["steps"]:
		campaign = campaign_rows.get(s.get("campaign")) if s.get("campaign") else None
		messages = by_campaign.get(s["campaign"], []) if s.get("campaign") else [logs[n] for n in (s.get("outbounds") or []) + (s.get("real") or []) if n in logs]
		steps.append({**s, "state": _step_state(s, messages, campaign), "messages": messages, "campaign_row": campaign})
	# an archived run knows its numbers only masked: there is nothing to match incoming messages on
	inbound = [] if data.get("archived") else _inbound(data)
	all_logs = list(logs.values())
	return {
		"run": _public(data),
		"steps": steps,
		"summary": _summary(steps, all_logs),
		"receipts": _receipts(all_logs),
		"inbound": inbound,
		"webhook_last_event_at": frappe.db.get_single_value("WhatsApp Settings", "webhook_last_event_at"),
		"finished": bool(steps) and all(s["state"] in ("failed", "blocked", "passed", "delivered", "read") for s in steps),
	}


def _summary(steps: list[dict[str, Any]], logs: list[dict[str, Any]]) -> dict[str, Any]:
	def avg(key: str) -> float | None:
		values = [r[key] for r in logs if r.get(key) is not None]
		return round(sum(values) / len(values), 1) if values else None

	return {
		"checks": len(steps),
		"passed": sum(1 for s in steps if s["state"] in ("passed", "delivered", "read")),
		"failed": sum(1 for s in steps if s["state"] == "failed"),
		"blocked": sum(1 for s in steps if s["state"] == "blocked"),
		"pending": sum(1 for s in steps if s["state"] in ("running", "sent", "scheduled")),
		"messages": len(logs),
		"avg_send_seconds": avg("send_seconds"),
		"avg_deliver_seconds": avg("deliver_seconds"),
	}


def _receipts(logs: list[dict[str, Any]]) -> dict[str, Any]:
	"""The webhook round trip, read off the run's own messages: a delivery or a read receipt is
	an event the platform pushed back to this site."""
	sent = [r for r in logs if r["status"] in ("Sent", *LOG_DONE)]
	return {
		"messages": len(logs),
		"sent": len(sent),
		"delivered": sum(1 for r in logs if r["status"] in LOG_DONE),
		"read": sum(1 for r in logs if r["status"] == "Read"),
		"failed": sum(1 for r in logs if r["status"] in LOG_BROKEN),
	}


def _inbound(data: dict[str, Any]) -> list[dict[str, Any]]:
	"""Real messages the run's targets wrote to the site since the run began, each with the
	command it matched and the state of the reply — the live half of the commands check."""
	rows = frappe.get_all(
		"WhatsApp Inbound Message",
		filters={"phone_e164": ("in", data["targets"]), "creation": (">=", data["started_at"]), "is_simulated": 0, "is_group": 0},
		fields=["name", "phone_e164", "display_name", "body", "message_type", "received_at", "creation", "command_status", "command", "block_reason", "command_error"],
		order_by="creation desc",
		limit=20,
	)
	replies: dict[str, list[dict[str, Any]]] = {}
	if rows:
		for r in frappe.get_all(
			"WhatsApp Log",
			filters={"trigger_inbound": ("in", [x.name for x in rows]), "is_simulated": 0},
			fields=["name", "status", "trigger_inbound", "message_type", "sent_at", "delivered_at", "error_code"],
			order_by="creation asc",
		):
			replies.setdefault(r.trigger_inbound, []).append(r)
	for row in rows:
		row["body"] = (row.body or "")[:140]
		row["replies"] = replies.get(row.name, [])
		row["answered"] = bool(row["replies"]) and all(r.status in ("Sent", *LOG_DONE) for r in row["replies"])
		row["delivered"] = bool(row["replies"]) and all(r.status in LOG_DONE for r in row["replies"])
	return rows


def runs() -> list[dict[str, Any]]:
	"""The newest runs, newest first, from the audit log (so they outlive the cache): `[{id, user,
	user_name, device, started_at, targets, checks, messages, delivered, failed}]`."""
	out: list[dict[str, Any]] = []
	for row in _audit_rows(summary=AUDIT_START, limit=HISTORY_MAX):
		run_id = frappe.parse_json(row.details or "{}").get("run")
		data = (frappe.cache.get_value(RUN_KEY.format(run_id)) or _archived(run_id)) if run_id else None
		if not data or not data["steps"]:
			continue  # opened only to listen for a message: nothing to look back at
		names = [n for s in data["steps"] for n in (s.get("outbounds") or []) + (s.get("real") or [])]
		campaigns = [s["campaign"] for s in data["steps"] if s.get("campaign")]
		statuses: list[str] = []
		if names:
			statuses += frappe.get_all("WhatsApp Log", filters={"name": ("in", names)}, pluck="status")
		if campaigns:
			statuses += frappe.get_all("WhatsApp Log", filters={"campaign": ("in", campaigns)}, pluck="status")
		out.append(
			{
				"id": data["id"],
				"user": data["user"],
				"user_name": frappe.utils.get_fullname(data["user"]),
				"device": data["device"],
				"started_at": data["started_at"],
				"targets": len(data["targets"]),
				"checks": len(data["steps"]),
				"messages": len(statuses),
				"delivered": sum(1 for s in statuses if s in LOG_DONE),
				"failed": sum(1 for s in statuses if s in LOG_BROKEN) + sum(1 for s in data["steps"] if s.get("error") and not s.get("outbounds")),
			}
		)
	return out

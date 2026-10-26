# Module role: WhatsApp status posts (stories) — posted from a device now or at `scheduled_at`,
# repeated daily or weekly, deleted, and their views read while they are up (24 hours). Plan feature
# `allow_status`. The minute tick (`post_due`) posts what is due; `refresh_views` reads views of the
# posts still up every half hour, and once more right after they expire.

from __future__ import annotations

import base64
import json
from typing import Any

import frappe
from frappe import _
from frappe.utils import add_days, add_to_date, cint, get_datetime, now_datetime

from whatsapp_next.exceptions import WANotSupportedError, WAStateConflictError, WAValidationError
from whatsapp_next.services import audit, devices

POST = "WhatsApp Status Post"
STATUS = "allow_status"
LIFETIME_HOURS = 24
MAX_MEDIA_BYTES = 16 * 1024 * 1024
FONTS = {"Standard": 0, "Script": 2, "Bold": 6, "Rounded": 7, "Display": 8, "Typewriter": 10}


def require_plan() -> None:
	"""Refuse when the subscription's plan does not include status posts."""
	from whatsapp_next.services import plan_features

	if not plan_features.included(STATUS):
		frappe.throw(_("Your plan does not include status posts"), WANotSupportedError)


def _payload(doc) -> dict[str, Any]:
	if doc.kind == "Text":
		return {"kind": "text", "text": doc.text, "background_color": doc.background_color or "",
			"font": FONTS.get(doc.font or "Standard", 0)}
	file_name = frappe.db.get_value("File", {"file_url": doc.media}, "name")
	if not file_name:
		frappe.throw(_("The image or video was not found"), WAValidationError)
	content = frappe.get_doc("File", file_name).get_content()
	content = content.encode() if isinstance(content, str) else content
	if len(content) > MAX_MEDIA_BYTES:
		frappe.throw(_("The image or video is larger than 16 MB"), WAValidationError)
	return {"kind": doc.kind.lower(), "media_base64": base64.b64encode(content).decode(), "caption": doc.caption or ""}


def post_now(name: str, *, user: str | None = None) -> str:
	"""Post the status now → its WhatsApp id. A failure is kept on the post (`state` Failed)."""
	from whatsapp_next.providers import registry

	require_plan()
	doc = frappe.get_doc(POST, name)
	if doc.state not in ("Draft", "Scheduled", "Failed", "Posting"):
		frappe.throw(_("This status was already posted"), WAStateConflictError)
	platform_device = devices.platform_device(doc.device, connected=True)
	doc.db_set("state", "Posting")
	try:
		status_id = registry.get_provider().post_status(platform_device, _payload(doc))
	except Exception as exc:
		doc.db_set({"state": "Failed", "error": str(exc)[:500]})
		raise
	at = now_datetime()
	doc.db_set({"state": "Posted", "status_id": status_id, "posted_at": at, "error": None,
		"expires_at": add_to_date(at, hours=LIFETIME_HOURS), "view_count": 0})
	audit.log("Status Posted", reference=(POST, name), details={"kind": doc.kind, "device": doc.device}, user=user)
	_schedule_repeat(doc, at)
	return status_id


def _schedule_repeat(doc, at) -> None:
	"""A repeating post queues its next copy, `repeat` after this one's time."""
	if not doc.repeat:
		return
	base = get_datetime(doc.scheduled_at) if doc.scheduled_at else at
	nxt = add_days(base, 1 if doc.repeat == "Daily" else 7)
	while nxt <= now_datetime():
		nxt = add_days(nxt, 1 if doc.repeat == "Daily" else 7)
	copy = frappe.copy_doc(doc)
	copy.update({"state": "Scheduled", "scheduled_at": nxt, "status_id": None, "posted_at": None, "expires_at": None,
		"view_count": 0, "viewers": None, "views_synced_at": None, "error": None, "repeated_from": doc.name})
	copy.insert(ignore_permissions=True)


def schedule(name: str, at=None) -> None:
	"""Post at `at` (default: the post's `scheduled_at`) from the minute tick."""
	require_plan()
	doc = frappe.get_doc(POST, name)
	when = get_datetime(at or doc.scheduled_at) if (at or doc.scheduled_at) else None
	if not when or when <= now_datetime():
		frappe.throw(_("Choose a time in the future"), WAValidationError)
	if doc.state not in ("Draft", "Scheduled", "Failed"):
		frappe.throw(_("This status was already posted"), WAStateConflictError)
	doc.db_set({"state": "Scheduled", "scheduled_at": when, "error": None})


def unschedule(name: str) -> None:
	"""Take a `Scheduled` post back to `Draft`; any other state is left as it is."""
	doc = frappe.get_doc(POST, name)
	if doc.state == "Scheduled":
		doc.db_set("state", "Draft")


def delete_post(name: str, *, user: str | None = None) -> None:
	"""Take a posted status down from WhatsApp; the post stays here as Deleted, with its views."""
	from whatsapp_next.providers import registry

	doc = frappe.get_doc(POST, name)
	if doc.state != "Posted" or not doc.status_id:
		frappe.throw(_("Only a posted status can be deleted from WhatsApp"), WAStateConflictError)
	refresh_views([name])
	registry.get_provider().delete_status(devices.platform_device(doc.device, connected=True), doc.status_id)
	doc.db_set({"state": "Deleted", "expires_at": now_datetime()})
	audit.log("Status Deleted", reference=(POST, name), details={"device": doc.device}, user=user)


def post_due() -> None:
	"""Minute tick: post every scheduled status whose time has come (a failure stays on its post)."""
	for name in frappe.get_all(POST, filters={"state": "Scheduled", "scheduled_at": ("<=", now_datetime())},
			pluck="name", order_by="scheduled_at asc", limit=20):
		try:
			post_now(name)
		except Exception:
			frappe.log_error(title="WhatsApp status post failed", message=f"post={name}")
		frappe.db.commit()


def refresh_views(names: list[str] | None = None) -> int:
	"""Read the views of posts still up (and those expired in the last hour, for the final count);
	returns how many posts were updated."""
	from whatsapp_next.providers import registry

	if names is None:
		names = frappe.get_all(POST, filters={"state": ("in", ["Posted", "Deleted"]), "status_id": ("is", "set"),
			"expires_at": (">=", add_to_date(now_datetime(), hours=-1))}, pluck="name")
	rows = frappe.get_all(POST, filters={"name": ("in", names or [""])}, fields=["name", "device", "status_id"])
	by_device: dict[str, list] = {}
	for r in rows:
		if r.status_id:
			by_device.setdefault(r.device, []).append(r)
	updated = 0
	provider = registry.get_provider()
	for device, posts in by_device.items():
		platform_device = frappe.db.get_value("WhatsApp Device", device, "platform_device")
		try:
			views = provider.get_status_views(platform_device, [p.status_id for p in posts])
		except Exception:
			frappe.log_error(title="WhatsApp status views not read", message=f"device={device}")
			continue
		for p in posts:
			v = views.get(p.status_id) or {}
			frappe.db.set_value(POST, p.name, {"view_count": cint(v.get("count")),
				"viewers": json.dumps(v.get("viewers") or [], ensure_ascii=False), "views_synced_at": now_datetime()},
				update_modified=False)
			updated += 1
	return updated

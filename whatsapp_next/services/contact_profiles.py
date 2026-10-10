# Module role: what WhatsApp shows about a number — its photo, "about" text and, for a business,
# its verified name, category, email, address and hours — kept on the number's WhatsApp Number row
# (the photo as a private File). A linked Contact without a photo takes the number's (added, never
# replaced). Refreshed for numbers the site talks to (`refresh_due`, daily, `STALE_DAYS`), and on
# demand from the screens (`refresh_for`). The registration answer feeds the number check too.

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

import frappe
import requests
from frappe import _
from frappe.utils import add_days, now_datetime

from whatsapp_next.exceptions import WAValidationError
from whatsapp_next.providers.schemas import ContactProfile
from whatsapp_next.services import number_check
from whatsapp_next.services.phone import classify

NUMBER = "WhatsApp Number"
BATCH = 20  # one platform call; each number costs a photo lookup at the gateway
STALE_DAYS = 7
ACTIVE_DAYS = 90
DUE_PER_RUN = 200
MAX_PER_REQUEST = 200
MAX_PHOTO_BYTES = 5 * 1024 * 1024
PHOTO_HOST_SUFFIX = ".whatsapp.net"  # WhatsApp serves profile photos from its own CDN


def refresh(numbers: list[str], *, device: str | None = None, force: bool = False) -> dict[str, int]:
	"""Read and store the profiles of the given individual numbers → `{asked, updated, photos}`.
	Without `force`, numbers refreshed in the last `STALE_DAYS` are left as they are."""
	from whatsapp_next.providers import registry

	keys = []
	for n in numbers or []:
		kind, key = classify(n)
		if kind == "Individual" and key not in keys:
			keys.append(key)
	if not force and keys:
		fresh = set(frappe.get_all(NUMBER, filters={"name": ("in", keys),
			"profile_synced_at": (">=", add_days(now_datetime(), -STALE_DAYS))}, pluck="name"))
		keys = [k for k in keys if k not in fresh]
	stats = {"asked": len(keys), "updated": 0, "photos": 0}
	if not keys:
		return stats
	device, platform_device = number_check._device(device)
	provider = registry.get_provider()
	# the stored texts (opening hours) are read by people: the site's language, not the job's
	from frappe.translate import print_language

	with print_language(frappe.db.get_single_value("System Settings", "language") or "en"):
		return _refresh(keys, stats, device, platform_device, provider)


def _refresh(keys, stats, device, platform_device, provider) -> dict[str, int]:
	known = dict(frappe.get_all(NUMBER, filters={"name": ("in", keys), "picture_id": ("is", "set")},
		fields=["name", "picture_id"], as_list=True))
	now = now_datetime()
	for start in range(0, len(keys), BATCH):
		chunk = keys[start : start + BATCH]
		for profile in provider.get_contact_profiles(platform_device, chunk, {k: known.get(k) for k in chunk if known.get(k)}):
			number_check._remember(profile.phone_e164, profile.on_whatsapp, profile.jid, profile.verified_name, now, device)
			if frappe.db.exists(NUMBER, profile.phone_e164):
				stats["photos"] += _store(profile, now)
				stats["updated"] += 1
		if not getattr(frappe.local, "request", None):
			frappe.db.commit()  # a long daily run keeps what it has read
	return stats


def _store(profile: ContactProfile, at) -> int:
	"""Write one profile onto its WhatsApp Number row; returns 1 when a new photo was saved."""
	key = profile.phone_e164
	business = profile.business or {}
	values: dict[str, Any] = {
		"about": profile.about,
		"is_business": 1 if profile.is_business else 0,
		"verified_name": profile.verified_name,
		"business_categories": ", ".join(business.get("categories") or []) or None,
		"business_email": business.get("email") or None,
		"business_address": business.get("address") or None,
		"business_hours": _hours(business),
		"profile_synced_at": at,
	}
	saved = 0
	state = profile.picture_state
	if state == "set" and profile.picture_url:
		url = _save_photo(key, profile.picture_url)
		if url:
			values.update({"profile_picture": url, "picture_id": profile.picture_id, "picture_state": "Shown"})
			saved = 1
	elif state == "none":
		_drop_photo(key)
		values.update({"profile_picture": None, "picture_id": None, "picture_state": "No Photo"})
	elif state == "hidden":
		values["picture_state"] = "Hidden"
	frappe.db.set_value(NUMBER, key, values, update_modified=False)
	if saved:
		_give_contact_the_photo(key, values["profile_picture"])
	return saved


DAYS = {"sun": "Sunday", "mon": "Monday", "tue": "Tuesday", "wed": "Wednesday", "thu": "Thursday",
	"fri": "Friday", "sat": "Saturday"}
MODES = {"open_24h": "Open 24 hours", "appointment_only": "By appointment only", "closed": "Closed"}


def _minutes(value) -> str:
	"""WhatsApp sends opening times as minutes after midnight."""
	try:
		m = int(value)
	except (TypeError, ValueError):
		return str(value or "")
	return f"{m // 60:02d}:{m % 60:02d}"


def _hours(business: dict) -> str | None:
	"""Opening hours as lines a person reads: `Sunday: 09:00–17:00`, `Friday: Closed`."""
	lines = []
	for h in business.get("hours") or []:
		if not isinstance(h, dict):
			continue
		day = _(DAYS.get(h.get("day"), h.get("day") or ""))
		mode = h.get("mode")
		if mode == "specific_hours":
			lines.append(f"{day}: {_minutes(h.get('open'))}–{_minutes(h.get('close'))}")
		else:
			lines.append(f"{day}: {_(MODES.get(mode, mode or ''))}")
	if lines and business.get("hours_timezone"):
		lines.append(business["hours_timezone"])
	return "\n".join(lines) or None


def _save_photo(key: str, url: str) -> str | None:
	"""Download the photo from WhatsApp's CDN (https, its own hosts only, ≤ 5 MB) as a private File on
	the number; the previous photo is removed. A failed download keeps the old one."""
	parsed = urlparse(url)
	if parsed.scheme != "https" or not (parsed.hostname or "").endswith(PHOTO_HOST_SUFFIX):
		return None
	try:
		with requests.get(url, timeout=20, stream=True, allow_redirects=False) as r:
			if r.status_code != 200 or not (r.headers.get("Content-Type") or "").startswith("image/"):
				return None
			chunks, total = [], 0
			for chunk in r.iter_content(64 * 1024):
				total += len(chunk)
				if total > MAX_PHOTO_BYTES:
					return None
				chunks.append(chunk)
	except requests.RequestException:
		return None
	_drop_photo(key)
	file_doc = frappe.get_doc({
		"doctype": "File",
		"file_name": f"wa-{key.lstrip('+')}.jpg",
		"attached_to_doctype": NUMBER,
		"attached_to_name": key,
		"attached_to_field": "profile_picture",
		"is_private": 1,
		"content": b"".join(chunks),
	})
	file_doc.flags.ignore_permissions = True
	file_doc.insert(ignore_permissions=True)
	return file_doc.file_url


def _drop_photo(key: str) -> None:
	for name in frappe.get_all("File", filters={"attached_to_doctype": NUMBER, "attached_to_name": key,
			"attached_to_field": "profile_picture"}, pluck="name"):
		frappe.delete_doc("File", name, ignore_permissions=True, force=True)


def _give_contact_the_photo(key: str, url: str) -> None:
	"""A linked Contact with no photo takes the number's — never replacing one it has."""
	from whatsapp_next.services import audit

	contact = frappe.db.get_value(NUMBER, key, "contact")
	if not contact or frappe.db.get_value("Contact", contact, "image"):
		return
	frappe.db.set_value("Contact", contact, "image", url, update_modified=False)
	audit.log("Elevated Contact Write", reference=("Contact", contact), fields_written=["image"],
		reason=_("WhatsApp profile photo of {0}").format(key))


def refresh_due() -> dict[str, int]:
	"""Daily: profiles of individual numbers active in the last `ACTIVE_DAYS` that were never read
	or are older than `STALE_DAYS` (at most `DUE_PER_RUN`)."""
	stale = add_days(now_datetime(), -STALE_DAYS)
	rows = frappe.get_all(
		NUMBER,
		filters={"number_type": "Individual", "last_seen": (">=", add_days(now_datetime(), -ACTIVE_DAYS))},
		or_filters=[["profile_synced_at", "is", "not set"], ["profile_synced_at", "<", stale]],
		order_by="last_seen desc",
		limit=DUE_PER_RUN,
		pluck="name",
	)
	if not rows:
		return {"asked": 0, "updated": 0, "photos": 0}
	try:
		return refresh(rows)
	except Exception:
		frappe.log_error(title="WhatsApp contact profiles: daily refresh failed")
		return {"asked": len(rows), "updated": 0, "photos": 0}


def refresh_for(source_doctype: str, names: list[str]) -> dict[str, int]:
	"""The screens' "Refresh WhatsApp profile": the numbers behind the selected records, read now."""
	from whatsapp_next.services import wa_groups

	members = wa_groups.members_from(source_doctype, names)
	if len(members) > MAX_PER_REQUEST:
		frappe.throw(_("Refresh at most {0} numbers at a time").format(MAX_PER_REQUEST), WAValidationError)
	return refresh([m["phone_e164"] for m in members], force=True)

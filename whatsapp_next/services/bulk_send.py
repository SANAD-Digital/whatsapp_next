# Module role: the "Send a bulk message" window (the prototype's Send Message Dialog / Bulk Send,
# D-136). One message to many recipients picked from contact groups, contacts and typed numbers.
# It is not a second sending engine: the selection becomes a campaign — rate, schedule, queue,
# progress, pause and cancel are the campaign runner's — and this module only resolves the
# selection (members of blacklist groups left out unless that group itself was picked, the site's
# global blacklist always), estimates it for the window and hands it over.

from __future__ import annotations

from typing import Any

import frappe
from frappe import _
from frappe.utils import cint, format_datetime, get_datetime, now_datetime

from whatsapp_next.exceptions import WAValidationError
from whatsapp_next.services import audit, campaign_runner, picker
from whatsapp_next.services.permissions import contact_phones
from whatsapp_next.whatsapp_next.doctype.whatsapp_campaign.whatsapp_campaign import settings_rate_limit

BLACKLIST_KIND = "Blacklist"
MAX_RECIPIENTS = 20000


def context() -> dict[str, Any]:
	"""What the window opens with: `{groups[], templates[], devices[], default_device, rate, max_rate,
	messages_remaining}`."""
	settings = frappe.get_cached_doc("WhatsApp Settings")
	groups = frappe.get_all(
		"WhatsApp Contact Group",
		filters={"disabled": 0},
		fields=["name", "group_name", "kind", "description", "source", "member_count"],
		order_by="group_name asc",
	)
	templates = frappe.get_all(
		"WhatsApp Template",
		filters={"disabled": 0, "message_type": "Text"},
		fields=["name", "template_name", "category", "body"],
		order_by="template_name asc",
	)
	devices = frappe.get_all(
		"WhatsApp Device",
		filters={"disabled": 0},
		fields=["name", "device_name", "status"],
		order_by="is_default desc, device_name asc",
	)
	return {
		"groups": groups,
		"templates": templates,
		"devices": devices,
		"default_device": settings.default_device,
		# the campaign may not go faster than the site's queue rate, so that is the default and the cap
		"rate": min(20, settings_rate_limit()) if settings_rate_limit() else 20,
		"max_rate": settings_rate_limit() or None,
		"messages_remaining": settings.get("messages_remaining"),
	}


def _blocked_keys(picked_groups: set[str]) -> set[str]:
	"""Numbers never messaged by a bulk send: the global blacklist, and every blacklist group the
	sender did not pick on purpose."""
	settings = frappe.get_cached_doc("WhatsApp Settings")
	blocked_groups = (
		set(frappe.get_all("WhatsApp Contact Group", filters={"kind": BLACKLIST_KIND}, pluck="name"))
		- picked_groups
	)
	if settings.global_blacklist_group:
		blocked_groups.add(settings.global_blacklist_group)
	if not blocked_groups:
		return set()
	return {
		m.phone_e164 or m.phone
		for m in frappe.get_all(
			"WhatsApp Contact Group Member",
			filters={"parenttype": "WhatsApp Contact Group", "parent": ("in", list(blocked_groups))},
			fields=["phone", "phone_e164"],
		)
	}


def resolve(
	groups: list | None = None, contacts: list | None = None, numbers: list | None = None
) -> dict[str, Any]:
	"""The recipients the selection stands for, deduplicated by number and in pick order:
	`{rows[{phone_e164, display_name, contact, source_type, source_ref}], excluded, invalid}`."""
	groups = [str(g) for g in (groups or []) if g]
	contacts = [str(c) for c in (contacts or []) if c]
	numbers = [str(n) for n in (numbers or []) if str(n).strip()]
	blocked = _blocked_keys(set(groups))
	seen: set[str] = set()
	rows: list[dict[str, Any]] = []
	excluded = invalid = 0

	def take(row: dict[str, Any], source_ref: str | None) -> None:
		nonlocal excluded, invalid
		if not row["valid"] or row.get("recipient_type") == "Group":
			invalid += 1
			return
		key = row["phone_e164"]
		if key in seen:
			return
		if key in blocked:
			excluded += 1
			return
		seen.add(key)
		rows.append(dict(row, source_ref=source_ref))

	for group in groups:
		for m in frappe.get_all(
			"WhatsApp Contact Group Member",
			filters={"parenttype": "WhatsApp Contact Group", "parent": group},
			fields=["phone", "phone_e164", "display_name", "contact"],
			order_by="idx asc",
		):
			take(
				picker.make_row(
					m.phone_e164 or m.phone, m.display_name, contact=m.contact, source_type="Contact Group"
				),
				group,
			)
	if contacts:
		names = {
			r.name: r.full_name
			for r in frappe.get_all(
				"Contact", filters={"name": ("in", contacts)}, fields=["name", "full_name"]
			)
		}
		for contact in contacts:
			phones = contact_phones(contact)
			if not phones:
				invalid += 1
				continue
			take(picker.make_row(phones[0], names.get(contact), contact=contact, source_type="Contact"), None)
	for number in numbers:
		take(picker.make_row(number, None, source_type="Manual"), None)
	if len(rows) > MAX_RECIPIENTS:
		frappe.throw(
			_("A bulk message reaches at most {0} recipients").format(MAX_RECIPIENTS), WAValidationError
		)
	return {"rows": rows, "excluded": excluded, "invalid": invalid}


def estimate(
	groups: list | None = None, contacts: list | None = None, numbers: list | None = None
) -> dict[str, Any]:
	"""`{total, excluded, invalid}` for the window's figures, without the rows."""
	r = resolve(groups, contacts, numbers)
	return {"total": len(r["rows"]), "excluded": r["excluded"], "invalid": r["invalid"]}


def send(payload: dict, user: str | None = None) -> dict[str, Any]:
	"""Create the campaign for `{groups[], contacts[], numbers[], body, template, device, rate,
	scheduled_at}` and start it now (or schedule it). Returns `{campaign, status, recipients,
	excluded, invalid}`. E: `WAValidationError` (no recipient, empty message, bad schedule)."""
	if not isinstance(payload, dict):
		frappe.throw(_("payload must be an object"), WAValidationError)
	unknown = sorted(
		set(payload) - {"groups", "contacts", "numbers", "body", "template", "device", "rate", "scheduled_at"}
	)
	if unknown:
		frappe.throw(_("Unknown payload keys: {0}").format(", ".join(unknown)), WAValidationError)
	body = (payload.get("body") or "").strip()
	template = payload.get("template") or None
	if not body and not template:
		frappe.throw(_("Write the message text or pick a template"), WAValidationError)
	device = payload.get("device") or frappe.get_cached_doc("WhatsApp Settings").default_device
	if not device:
		frappe.throw(_("Pick a sending device"), WAValidationError)
	scheduled_at = payload.get("scheduled_at") or None
	if scheduled_at and get_datetime(scheduled_at) <= now_datetime():
		frappe.throw(_("The scheduled time must be in the future"), WAValidationError)
	r = resolve(payload.get("groups"), payload.get("contacts"), payload.get("numbers"))
	if not r["rows"]:
		frappe.throw(_("No recipient: pick a group or contacts, or add numbers"), WAValidationError)
	doc = frappe.get_doc(
		{
			"doctype": "WhatsApp Campaign",
			"campaign_name": _("Bulk message · {0}").format(
				format_datetime(now_datetime(), "dd-MM-yyyy HH:mm")
			),
			"description": _("Sent from the «Send a bulk message» window."),
			"device": device,
			"messages_per_minute": cint(payload.get("rate")) or None,
			"messages": [{"message_type": "Text", "body": body or None, "template": template}],
		}
	)
	doc.insert()
	by_source: dict[tuple[str, str | None], list[dict[str, Any]]] = {}
	for row in r["rows"]:
		by_source.setdefault((row["source_type"], row.get("source_ref")), []).append(row)
	for (source_type, source_ref), rows in by_source.items():
		picker.commit_add(
			"WhatsApp Campaign", doc.name, rows, source_type=source_type, source_ref=source_ref, user=user
		)
	audit.log(
		"Bulk Send",
		reference=("WhatsApp Campaign", doc.name),
		count=len(r["rows"]),
		user=user,
		details={"excluded": r["excluded"], "invalid": r["invalid"], "scheduled": bool(scheduled_at)},
	)
	if scheduled_at:
		status = campaign_runner.schedule(doc.name, get_datetime(scheduled_at), user=user)
	else:
		status = campaign_runner.start(doc.name, user=user)
	return {
		"campaign": doc.name,
		"status": status,
		"recipients": len(r["rows"]),
		"excluded": r["excluded"],
		"invalid": r["invalid"],
	}

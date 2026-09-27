# Module role: device lifecycle (backend-plan §3 `devices.py`). The **status writer** for
# `WhatsApp Device`: create through the provider, pairing (QR / 8-digit code) served from a
# 60-second cache and never persisted (D-014), connection webhooks → status machine, disconnect /
# delete / default / disable, hourly drift sync. Publishes `wa:device:status` and writes the
# `Device *` audit rows. No status field of a device is written anywhere else.

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

import frappe
from frappe import _
from frappe.utils import cint, get_datetime, now_datetime

from whatsapp_next.exceptions import (
	WADeviceOfflineError,
	WAInvalidPhoneError,
	WANotFoundError,
	WANotSupportedError,
	WAStateConflictError,
	WAValidationError,
)
from whatsapp_next.providers import exceptions as pex
from whatsapp_next.providers import registry
from whatsapp_next.providers.schemas import DeviceState, PairingPayload, WebhookEvent
from whatsapp_next.services import audit
from whatsapp_next.services.guards import status_writer
from whatsapp_next.services.phone import normalize

STATUSES = ("Pending QR", "Connected", "Disconnected", "Logged Out")
PAIRING_MODES = ("QR", "Code")
PAIR_CACHE_TTL = 60
PAIR_CACHE_KEY = "wa:pair:{platform_device}"

# Allowed transitions (fields.md §3 status machine); same-status events are no-ops.
_TRANSITIONS: dict[str, frozenset[str]] = {
	"Pending QR": frozenset({"Connected", "Logged Out", "Disconnected"}),
	"Connected": frozenset({"Disconnected", "Logged Out"}),
	"Disconnected": frozenset({"Connected", "Logged Out", "Pending QR"}),
	"Logged Out": frozenset({"Pending QR", "Connected"}),
}
_STATUS_TIMESTAMP = {
	"Connected": "connected_at",
	"Disconnected": "disconnected_at",
	"Logged Out": "logged_out_at",
}
_AUDIT_BY_STATUS = {
	"Connected": "Device Connected",
	"Disconnected": "Device Disconnected",
	"Logged Out": "Device Disconnected",
}

EVENT_STATUS = {
	"connection.connected": "Connected",
	"connection.disconnected": "Disconnected",
	"connection.logged_out": "Logged Out",
}


@dataclass(frozen=True)
class StateChange:
	device: str
	previous: str
	status: str
	changed: bool


# ---- helpers ------------------------------------------------------------------------------


def _doc(device: str):
	if not frappe.db.exists("WhatsApp Device", device):
		frappe.throw(_("WhatsApp Device {0} not found").format(device), WANotFoundError)
	return frappe.get_doc("WhatsApp Device", device)


def _platform_device(device: str) -> str:
	pd = frappe.db.get_value("WhatsApp Device", device, "platform_device")
	if not pd:
		frappe.throw(_("Device {0} is not registered on the platform").format(device), WADeviceOfflineError)
	return pd


def by_platform_device(platform_device: str | None) -> str | None:
	"""Local device name for a provider id; never creates (legacy F6 / R-G)."""
	if not platform_device:
		return None
	return frappe.db.get_value("WhatsApp Device", {"platform_device": platform_device}, "name")


def _job_user() -> str:
	return frappe.session.user if frappe.session.user not in ("Guest", None) else "Administrator"


# ---- status writer ------------------------------------------------------------------------


def apply_state(
	device: str,
	status: str,
	*,
	source: str,
	reason: str | None = None,
	at=None,
	state: DeviceState | None = None,
) -> StateChange:
	"""Move a device to `status` (validated against the machine), stamp timestamps, mirror
	provider fields from `state` when given, publish `wa:device:status`, audit connect /
	disconnect. Same-status events only refresh `last_status_event_at` / `last_seen`."""
	if status not in STATUSES:
		frappe.throw(_("Unknown device status {0}").format(status), WAValidationError)
	row = frappe.db.get_value("WhatsApp Device", device, ["status", "name"], as_dict=True)
	if not row:
		frappe.throw(_("WhatsApp Device {0} not found").format(device), WANotFoundError)
	at = get_datetime(at) if at else now_datetime()
	previous = row.status or "Pending QR"
	values: dict[str, Any] = {"last_status_event_at": at}
	if state:
		if state.wa_device_id:
			values["wa_device_id"] = state.wa_device_id
		if state.phone_e164 and not frappe.db.get_value("WhatsApp Device", device, "phone_e164"):
			values["phone"] = state.phone_e164
			values["phone_e164"] = normalize(state.phone_e164)
		if state.last_seen:
			values["last_seen"] = state.last_seen
		values["webhook_registered"] = 1 if state.webhook_registered else 0
	changed = status != previous
	if changed and status not in _TRANSITIONS.get(previous, frozenset()):
		frappe.log_error(
			title="WhatsApp device: unexpected transition",
			message=f"device={device} {previous} -> {status} source={source}",
		)
	if changed:
		values["status"] = status
		if status in _STATUS_TIMESTAMP:
			values[_STATUS_TIMESTAMP[status]] = at
		values["last_error"] = reason[:500] if reason and status != "Connected" else None
		if status == "Connected":
			values["last_seen"] = at
			clear_pairing(device)
	with status_writer():
		frappe.db.set_value("WhatsApp Device", device, values, update_modified=True)
	if changed:
		action = _AUDIT_BY_STATUS.get(status)
		if action:
			audit.log(
				action,
				reference=("WhatsApp Device", device),
				reason=reason,
				details={"previous": previous, "status": status, "source": source},
				user=_job_user(),
			)
		payload = {"device": device, "status": status, "previous": previous, "at": str(at), "source": source}
		frappe.publish_realtime("wa:device:status", payload, after_commit=True)
		frappe.publish_realtime(
			"wa:device:status", payload, doctype="WhatsApp Device", docname=device, after_commit=True
		)
	return StateChange(device=device, previous=previous, status=status, changed=changed)


def apply_connection_event(event: WebhookEvent) -> StateChange | None:
	"""`connection.*` webhook → `apply_state`. Unknown device → `None` (row is never created)."""
	status = EVENT_STATUS.get(event.event_name)
	if not status:
		return None
	device = by_platform_device(
		event.platform_device or (event.device.platform_device if event.device else None)
	)
	if not device:
		frappe.log_error(
			title="WhatsApp webhook: connection event for unknown device",
			message=f"event={event.event_name} id={event.event_id}",
		)
		return None
	return apply_state(
		device, status, source="webhook", reason=event.reason, at=event.timestamp, state=event.device
	)


# ---- lifecycle ----------------------------------------------------------------------------


def create(
	device_name: str, phone: str | None = None, pairing_mode: str = "QR", user: str | None = None
) -> str:
	"""Create the device on the provider, then the local row (`Pending QR`); audited."""
	name = (device_name or "").strip()
	if not name:
		frappe.throw(_("Device name is required"), WAValidationError)
	if pairing_mode not in PAIRING_MODES:
		frappe.throw(_("Pairing mode must be QR or Code"), WAValidationError)
	e164 = normalize(phone) if phone else None
	if phone and not e164:
		frappe.throw(_("Invalid phone number: {0}").format(phone), WAInvalidPhoneError)
	if pairing_mode == "Code" and not e164:
		frappe.throw(_("A phone number is required for pair-code pairing"), WAInvalidPhoneError)
	state = registry.get_provider().create_device(name, e164, pairing_mode)
	with status_writer():
		doc = frappe.get_doc(
			{
				"doctype": "WhatsApp Device",
				"device_name": name,
				"phone": e164 or state.phone_e164,
				"platform_device": state.platform_device,
				"wa_device_id": state.wa_device_id,
				"status": state.status if state.status in STATUSES else "Pending QR",
				"is_default": 0 if frappe.db.count("WhatsApp Device") else 1,
			}
		)
		doc.flags.ignore_permissions = True
		doc.insert(ignore_permissions=True)
	audit.log(
		"Device Created",
		reference=("WhatsApp Device", doc.name),
		user=user,
		details={"pairing_mode": pairing_mode},
	)
	return doc.name


def start_pairing(device: str, mode: str = "QR") -> PairingPayload:
	"""Fetch a QR or 8-digit code from the provider and cache it for 60 s under
	`wa:pair:{platform_device}` (never persisted, D-014). Re-calls within the TTL return the
	cached payload; `Connected` devices are refused."""
	if mode not in PAIRING_MODES:
		frappe.throw(_("Pairing mode must be QR or Code"), WAValidationError)
	row = frappe.db.get_value(
		"WhatsApp Device", device, ["status", "platform_device", "phone_e164", "disabled"], as_dict=True
	)
	if not row:
		frappe.throw(_("WhatsApp Device {0} not found").format(device), WANotFoundError)
	if cint(row.disabled):
		frappe.throw(_("Device {0} is disabled").format(device), WAStateConflictError)
	if row.status == "Connected":
		frappe.throw(_("Device {0} is already connected").format(device), WAStateConflictError)
	if not row.platform_device:
		frappe.throw(_("Device {0} is not registered on the platform").format(device), WADeviceOfflineError)
	key = PAIR_CACHE_KEY.format(platform_device=row.platform_device)
	cached = frappe.cache.get_value(key)
	# The cache TTL is the expiry; provider timestamps are not compared (clock/timezone drift).
	if cached and cached.get("mode") == mode:
		return PairingPayload(
			**{
				k: (get_datetime(v) if k in ("generated_at", "expires_at") and v else v)
				for k, v in cached.items()
			}
		)
	provider = registry.get_provider()
	try:
		payload = (
			provider.get_qr(row.platform_device)
			if mode == "QR"
			else provider.get_pair_code(row.platform_device)
		)
	except pex.ValidationError as exc:
		frappe.throw(_("Pairing failed: {0}").format(exc.message), WAInvalidPhoneError)
	except pex.NotSupportedError as exc:
		raise WANotSupportedError(_("{0} pairing is not supported by this provider").format(mode)) from exc
	if row.status == "Logged Out":
		apply_state(device, "Pending QR", source="pairing")
	data = {k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in asdict(payload).items()}
	frappe.cache.set_value(key, data, expires_in_sec=PAIR_CACHE_TTL)
	frappe.publish_realtime(
		"wa:pairing:status",
		{"device": device, "mode": mode, "expires_at": data.get("expires_at")},
		user=frappe.session.user,
		after_commit=True,
	)
	return payload


def clear_pairing(device: str) -> None:
	"""Drop the cached pairing payload (on connect / disconnect / delete)."""
	pd = frappe.db.get_value("WhatsApp Device", device, "platform_device")
	if pd:
		frappe.cache.delete_value(PAIR_CACHE_KEY.format(platform_device=pd))


def poll(device: str) -> StateChange:
	"""Ask the provider for the live state and apply it (pairing page polling, `{status, changed}`)."""
	pd = _platform_device(device)
	state = registry.get_provider().verify_device(pd)
	return apply_state(
		device,
		state.status if state.status in STATUSES else "Pending QR",
		source="poll",
		reason=state.last_status_reason,
		state=state,
	)


def disconnect(device: str, user: str | None = None) -> StateChange:
	"""Provider logout (`disconnect_device`) → `Logged Out`; audited through `apply_state`."""
	pd = _platform_device(device)
	state = registry.get_provider().disconnect_device(pd)
	clear_pairing(device)
	return apply_state(
		device,
		state.status if state.status in STATUSES else "Logged Out",
		source=f"user:{user or frappe.session.user}",
		reason="disconnected by user",
	)


def delete(device: str, delete_remote: bool = True, user: str | None = None) -> None:
	"""Delete the device on the provider (optional) and locally. The default device cannot be
	deleted while other devices exist; message history keeps its (now dangling) Link."""
	doc = _doc(device)
	if doc.is_default and frappe.db.count("WhatsApp Device", {"name": ("!=", device)}):
		frappe.throw(
			_("Set another device as default before deleting {0}").format(device), WAStateConflictError
		)
	if doc.platform_device:
		try:
			registry.get_provider().delete_device(doc.platform_device, bool(delete_remote))
		except pex.NotFoundError:
			pass  # already gone on the platform
	clear_pairing(device)
	_release_device_links(device)
	audit.log(
		"Device Deleted",
		reference=("WhatsApp Device", device),
		user=user,
		details={"delete_remote": bool(delete_remote), "status": doc.status},
	)
	doc.flags.ignore_permissions = True
	doc.delete(ignore_permissions=True)
	frappe.publish_realtime(
		"wa:device:status",
		{
			"device": device,
			"status": "Deleted",
			"previous": doc.status,
			"at": str(now_datetime()),
			"source": "user",
		},
		after_commit=True,
	)


# Configuration rows that point at a device lose it on delete (spec 09 row 3: "templates lose
# their device, campaigns stop"); message history and Numbers keep dangling links via
# `ignore_links_on_delete`.
DEVICE_LINK_FIELDS: tuple[tuple[str, str], ...] = (
	("WhatsApp Campaign", "device"),
	("WhatsApp Notification", "device"),
	("WhatsApp Notification Alert", "device"),
	("WhatsApp Command", "reply_device"),
)
SETTINGS_DEVICE_FIELDS = ("default_device", "reply_device")


def _release_device_links(device: str) -> None:
	for doctype, fieldname in DEVICE_LINK_FIELDS:
		for name in frappe.get_all(doctype, filters={fieldname: device}, pluck="name"):
			frappe.db.set_value(doctype, name, fieldname, None, update_modified=False)
	settings = frappe.get_cached_doc("WhatsApp Settings")
	for fieldname in SETTINGS_DEVICE_FIELDS:
		if settings.get(fieldname) == device:
			frappe.db.set_single_value("WhatsApp Settings", fieldname, None)
	frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")


def set_default(device: str, user: str | None = None) -> None:
	"""Flag `device` as the default (the controller clears the others)."""
	doc = _doc(device)
	if cint(doc.disabled):
		frappe.throw(_("A disabled device cannot be the default"), WAStateConflictError)
	if not doc.is_default:
		doc.is_default = 1
		doc.flags.ignore_permissions = True
		doc.save(ignore_permissions=True)
	frappe.db.set_single_value("WhatsApp Settings", "default_device", device)
	frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")


def set_disabled(device: str, flag: bool, user: str | None = None) -> None:
	"""Disable / enable a device for dispatch (rows stay `Queued` while disabled)."""
	doc = _doc(device)
	flag = bool(cint(flag))
	if (
		flag
		and doc.is_default
		and frappe.db.count("WhatsApp Device", {"name": ("!=", device), "disabled": 0})
	):
		frappe.throw(
			_("Set another device as default before disabling {0}").format(device), WAStateConflictError
		)
	if bool(doc.disabled) == flag:
		return
	doc.disabled = 1 if flag else 0
	doc.flags.ignore_permissions = True
	doc.save(ignore_permissions=True)
	if flag:
		clear_pairing(device)


def update(
	device: str, device_name: str | None = None, phone: str | None = None, user: str | None = None
) -> dict[str, Any]:
	"""Rename / re-phone through the provider when it supports it (platform A-05)."""
	doc = _doc(device)
	e164 = normalize(phone) if phone else None
	if phone and not e164:
		frappe.throw(_("Invalid phone number: {0}").format(phone), WAInvalidPhoneError)
	if doc.platform_device:
		try:
			registry.get_provider().update_device(doc.platform_device, device_name, e164)
		except pex.NotSupportedError as exc:
			raise WANotSupportedError(_("Renaming devices is not supported by this provider yet")) from exc
	if device_name:
		doc.device_name = device_name.strip()
	if e164:
		doc.phone = e164
	doc.flags.ignore_permissions = True
	doc.save(ignore_permissions=True)
	return {"name": doc.name, "device_name": doc.device_name, "phone_e164": doc.phone_e164}


def sync_from_provider() -> dict[str, int]:
	"""Hourly: `list_devices` → mirror `last_seen`, `webhook_registered`, `wa_device_id` and
	apply status drift for known devices. Unknown provider devices are counted, never created."""
	states = registry.get_provider().list_devices()
	counts = {"seen": 0, "changed": 0, "unknown": 0}
	for state in states:
		device = by_platform_device(state.platform_device)
		if not device:
			counts["unknown"] += 1
			continue
		counts["seen"] += 1
		change = apply_state(
			device,
			state.status if state.status in STATUSES else "Pending QR",
			source="sync",
			reason=state.last_status_reason,
			state=state,
		)
		if change.changed:
			counts["changed"] += 1
	return counts


def adopt_from_provider(user: str | None = None) -> dict[str, int]:
	"""Right after this site is linked to a platform account (sign-in / sign-up): create the local
	row of every provider device this site does not know yet, so an account that already has its
	first device brings it along. The hourly `sync_from_provider` still never creates (R-G); this
	runs only on the explicit link, where every device of the account belongs to this site."""
	counts = {"adopted": 0, "known": 0}
	for state in registry.get_provider().list_devices():
		if not state.platform_device or by_platform_device(state.platform_device):
			counts["known"] += 1
			continue
		with status_writer():
			doc = frappe.get_doc(
				{
					"doctype": "WhatsApp Device",
					"device_name": state.device_name or state.platform_device,
					"phone": state.phone_e164,
					"platform_device": state.platform_device,
					"wa_device_id": state.wa_device_id,
					"status": state.status if state.status in STATUSES else "Pending QR",
					"last_seen": state.last_seen,
					"webhook_registered": 1 if state.webhook_registered else 0,
					"is_default": 0 if frappe.db.count("WhatsApp Device") else 1,
				}
			)
			doc.flags.ignore_permissions = True
			doc.insert(ignore_permissions=True)
		audit.log(
			"Device Created",
			reference=("WhatsApp Device", doc.name),
			user=user,
			details={"source": "adopt", "status": doc.status},
		)
		counts["adopted"] += 1
	return counts
